from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest

from backend.app.agent.checkpoint_migration import (
    MIGRATION_ID,
    SOURCE_SCHEMA,
    TARGET_SCHEMA,
)
from backend.app.agent.checkpoint_runtime import (
    CheckpointRuntime,
    CheckpointRuntimeState,
    CheckpointRuntimeUnavailable,
)
from backend.app.api.checkpoint_migration import (
    CheckpointMigrationController,
    PublicMigrationState,
)
from backend.app.storage import init_database


def _seed_completed_migration(database, *, acknowledged: bool) -> None:
    with database.connect() as connection:
        connection.execute(
            """
            insert into checkpoint_migration_state (
              migration_id, source_schema, target_schema, status,
              source_db_fingerprint, progress_basis_points,
              completed_at, ui_acknowledged_at, updated_at
            ) values (?, ?, ?, 'completed', 'fixture', 10000, ?, ?, ?)
            """,
            (
                MIGRATION_ID,
                SOURCE_SCHEMA,
                TARGET_SCHEMA,
                "2026-01-01",
                "2026-01-01" if acknowledged else None,
                "2026-01-01",
            ),
        )
        connection.commit()


@pytest.mark.asyncio
async def test_runtime_starts_empty_database_with_required_pragmas(tmp_path: Path) -> None:
    runtime = CheckpointRuntime(tmp_path / "app.db")

    assert await runtime.start() is True
    assert runtime.status_payload() == {
        "state": "ready",
        "ready": True,
        "error": None,
    }
    assert runtime.ready_event.is_set()
    assert runtime.require_store() is runtime.require_store()
    assert runtime.connection is not None

    pragmas = {}
    for name in ("foreign_keys", "busy_timeout", "journal_mode", "synchronous"):
        cursor = await runtime.connection.execute(f"PRAGMA {name}")
        pragmas[name] = (await cursor.fetchone())[0]

    assert pragmas == {
        "foreign_keys": 1,
        "busy_timeout": 30_000,
        "journal_mode": "wal",
        "synchronous": 1,
    }

    await runtime.close()


@pytest.mark.asyncio
async def test_runtime_gate_classifies_running_failed_and_closing_states(
    tmp_path: Path,
) -> None:
    runtime = CheckpointRuntime(tmp_path / "app.db")
    for state in (
        CheckpointRuntimeState.INSPECTING,
        CheckpointRuntimeState.COPYING,
        CheckpointRuntimeState.COLLAPSING,
        CheckpointRuntimeState.VERIFYING,
        CheckpointRuntimeState.SWAPPING,
        CheckpointRuntimeState.SMOKE_CHECKING,
        CheckpointRuntimeState.FAILED,
        CheckpointRuntimeState.CLOSING,
    ):
        runtime.transition(state, error="private failure detail")
        with pytest.raises(CheckpointRuntimeUnavailable) as raised:
            runtime.require_ready()
        detail = raised.value.detail()
        assert detail["code"] == "checkpoint_runtime_unavailable"
        assert detail["details"]["checkpoint_state"] == state.value
        assert "private failure detail" not in str(detail)


@pytest.mark.asyncio
async def test_runtime_graceful_shutdown_and_repeated_lifespan(tmp_path: Path) -> None:
    runtime = CheckpointRuntime(tmp_path / "app.db")

    assert await runtime.start() is True
    first_connection = runtime.connection
    await runtime.close()
    assert runtime.state is CheckpointRuntimeState.CLOSING
    assert runtime.connection is None
    assert not runtime.ready_event.is_set()

    assert await runtime.start() is True
    assert runtime.connection is not first_connection
    await runtime.close()


@pytest.mark.asyncio
async def test_runtime_rearms_existing_official_store_from_persisted_completion(
    tmp_path: Path,
) -> None:
    database = init_database(tmp_path / "app.db")
    _seed_completed_migration(database, acknowledged=True)
    runtime = CheckpointRuntime(database.path)

    assert await runtime.start() is True
    existing_connection = runtime.connection
    runtime.transition(CheckpointRuntimeState.MIGRATION_REQUIRED)

    assert await runtime.start() is True
    assert runtime.state is CheckpointRuntimeState.READY
    assert runtime.connection is existing_connection
    assert runtime.require_store() is not None

    await runtime.close()


@pytest.mark.asyncio
async def test_acknowledgement_waits_for_migration_task_before_starting_runtime(
    tmp_path: Path,
) -> None:
    database = init_database(tmp_path / "app.db")
    _seed_completed_migration(database, acknowledged=False)
    runtime = CheckpointRuntime(database.path)
    controller = CheckpointMigrationController(runtime, database)
    release = asyncio.Event()

    async def finish_migration_task() -> None:
        await release.wait()

    controller._task = asyncio.create_task(finish_migration_task())
    acknowledgement = asyncio.create_task(
        controller.acknowledge(SimpleNamespace())
    )
    await asyncio.sleep(0)

    assert acknowledgement.done() is False

    release.set()
    response = await acknowledgement

    assert response.state is PublicMigrationState.READY
    assert runtime.state is CheckpointRuntimeState.READY
    assert runtime.require_store() is not None

    await runtime.close()
