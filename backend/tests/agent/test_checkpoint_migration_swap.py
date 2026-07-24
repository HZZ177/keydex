from __future__ import annotations

from pathlib import Path

import pytest

from backend.app.agent.checkpoint_migration import (
    CheckpointMigrationCoordinator,
    MigrationStatus,
)
from backend.app.agent.checkpoint_migration_collapse import NamespaceCollapseMigrator
from backend.app.agent.checkpoint_migration_copy import CompactTargetBuilder
from backend.app.agent.checkpoint_migration_swap import (
    AtomicCheckpointDatabaseSwap,
    InjectedSwapCrash,
)
from backend.app.agent.checkpoint_runtime import (
    CheckpointRuntime,
    CheckpointRuntimeState,
)
from backend.app.storage import init_database
from backend.tests.agent.test_checkpoint_migration_collapse import _seed_visible_session
from backend.tests.agent.test_checkpoint_migration_state import _seed_legacy


async def _prepared_database(tmp_path: Path):
    database, _saver = _seed_legacy(tmp_path / "app.db")
    _seed_visible_session(database)
    coordinator = CheckpointMigrationCoordinator(database)
    coordinator.start()
    await CompactTargetBuilder(database).build()
    NamespaceCollapseMigrator(database).collapse()
    return database, coordinator


@pytest.mark.asyncio
async def test_atomic_swap_completes_smoke_check_and_releases_old_storage(
    tmp_path: Path,
) -> None:
    database, coordinator = await _prepared_database(tmp_path)
    swap = AtomicCheckpointDatabaseSwap(database)

    await swap.swap()

    assert database.path.exists()
    assert not swap.target_path.exists()
    assert not swap.backup_path.exists()
    assert not swap.journal_path.exists()
    with database.connect() as connection:
        tables = {
            row["name"]
            for row in connection.execute(
                "select name from sqlite_master where type = 'table'"
            )
        }
        state = connection.execute(
            """
            select status, progress_basis_points, ui_acknowledged_at
            from checkpoint_migration_state
            """
        ).fetchone()
        visible_history = connection.execute(
            "select count(*) from message_events where session_id = 'session-1'"
        ).fetchone()[0]
        guarded_legacy_rows = connection.execute(
            """
            select
              (select count(*) from checkpoints_v2)
              + (select count(*) from checkpoint_writes_v2)
            """
        ).fetchone()[0]
    assert {"checkpoints", "writes"} <= tables
    assert "checkpoint_backend_guard" in tables
    assert guarded_legacy_rows == 0
    assert tuple(state) == ("completed", 10_000, None)
    assert visible_history == 2

    runtime = CheckpointRuntime(database.path)
    assert await runtime.start() is False
    assert runtime.state is CheckpointRuntimeState.MIGRATION_COMPLETED
    coordinator.repository.acknowledge()
    assert await runtime.start() is True
    assert runtime.state is CheckpointRuntimeState.READY
    restored = await runtime.require_store().aget_tuple(
        {
            "configurable": {
                "thread_id": "thread-a",
                "checkpoint_ns": "",
            }
        }
    )
    assert restored is not None
    assert restored.checkpoint["channel_values"]["messages"] == ["checkpoint-02"]
    await runtime.close()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "phase",
    ["prepared", "source_backed_up", "target_active"],
)
async def test_swap_recovery_completes_every_journaled_rename_phase(
    tmp_path: Path,
    phase: str,
) -> None:
    database, _coordinator = await _prepared_database(tmp_path)
    swap = AtomicCheckpointDatabaseSwap(database)

    with pytest.raises(InjectedSwapCrash, match=phase):
        await swap.swap(crash_after_phase=phase)

    recovered = await AtomicCheckpointDatabaseSwap(database).recover()

    assert recovered is True
    assert database.path.exists()
    assert not swap.target_path.exists()
    assert not swap.backup_path.exists()
    assert not swap.journal_path.exists()
    with database.connect() as connection:
        state = connection.execute(
            "select status, progress_basis_points from checkpoint_migration_state"
        ).fetchone()
        downgrade_guard = connection.execute(
            """
            select required_backend from checkpoint_backend_guard where id = 1
            """
        ).fetchone()[0]
        legacy_rows = connection.execute(
            """
            select
              (select count(*) from checkpoints_v2)
              + (select count(*) from checkpoint_writes_v2)
            """
        ).fetchone()[0]
    assert tuple(state) == (MigrationStatus.COMPLETED.value, 10_000)
    assert downgrade_guard == "official_async_sqlite_delta_v1"
    assert legacy_rows == 0


@pytest.mark.asyncio
async def test_startup_repairs_missing_active_path_before_schema_initialization(
    tmp_path: Path,
) -> None:
    database, _coordinator = await _prepared_database(tmp_path)
    swap = AtomicCheckpointDatabaseSwap(database)
    with pytest.raises(InjectedSwapCrash, match="source_backed_up"):
        await swap.swap(crash_after_phase="source_backed_up")
    assert not database.path.exists()

    restarted_swap = AtomicCheckpointDatabaseSwap(database)
    assert restarted_swap.prepare_active_path_for_startup() is True
    assert database.path.exists()
    init_database(database.path)
    assert await restarted_swap.recover() is True

    with database.connect() as connection:
        status = connection.execute(
            "select status from checkpoint_migration_state"
        ).fetchone()[0]
    assert status == MigrationStatus.COMPLETED.value
    assert not restarted_swap.backup_path.exists()
    assert not restarted_swap.target_path.exists()
    assert not restarted_swap.journal_path.exists()


@pytest.mark.asyncio
async def test_failed_target_smoke_check_restores_short_lived_backup(
    tmp_path: Path,
) -> None:
    database, coordinator = await _prepared_database(tmp_path)
    swap = AtomicCheckpointDatabaseSwap(database)
    with pytest.raises(InjectedSwapCrash):
        await swap.swap(crash_after_phase="target_active")
    with database.connect() as active_target:
        active_target.execute("delete from checkpoint_migration_state")
        active_target.commit()

    with pytest.raises(Exception, match="已恢复旧数据库"):
        await AtomicCheckpointDatabaseSwap(database).recover()

    assert database.path.exists()
    assert not swap.backup_path.exists()
    assert not swap.journal_path.exists()
    with database.connect() as restored_source:
        legacy_count = restored_source.execute(
            "select count(*) from checkpoints_v2"
        ).fetchone()[0]
        state = restored_source.execute(
            "select status, error_code from checkpoint_migration_state"
        ).fetchone()
    assert legacy_count == 4
    assert tuple(state) == ("failed", "checkpoint_migration_swap_failed")
    assert coordinator.inspect().status is MigrationStatus.FAILED
