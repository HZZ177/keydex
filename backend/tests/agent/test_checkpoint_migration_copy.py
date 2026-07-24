from __future__ import annotations

from pathlib import Path

import pytest

from backend.app.agent.checkpoint_migration import (
    CheckpointMigrationCoordinator,
    CheckpointMigrationError,
    MigrationStatus,
)
from backend.app.agent.checkpoint_migration_copy import CompactTargetBuilder
from backend.tests.agent.test_checkpoint_migration_state import (
    _seed_legacy,
    _seed_session,
)


def _seed_business_rows(database) -> None:
    with database.transaction() as connection:
        _seed_session(connection, "session-1", active_session_id="thread-a")
        connection.execute(
            """
            insert into message_events (
              id, session_id, seq, turn_index, action, data_json,
              created_at, updated_at
            ) values (
              'event-1', 'session-1', 1, 0, 'message',
              '{"content":"visible history"}', '2026-01-01', '2026-01-01'
            )
            """
        )
        connection.execute(
            """
            insert into attachments (
              id, session_id, user_id, type, source, name, path,
              mime_type, size, created_at, updated_at
            ) values (
              'attachment-1', 'session-1', 'user', 'file', 'upload',
              'note.txt', 'managed/note.txt', 'text/plain', 12,
              '2026-01-01', '2026-01-01'
            )
            """
        )
        connection.execute(
            """
            insert into trace_record (
              trace_id, session_id, scene_id, user_id, turn_index,
              root_node_id, status, start_time, created_at, updated_at
            ) values (
              'trace-1', 'session-1', 'scene', 'user', 0,
              'root', 'completed', '2026-01-01', '2026-01-01', '2026-01-01'
            )
            """
        )


@pytest.mark.asyncio
async def test_business_tables_copy_to_compact_current_schema(tmp_path: Path) -> None:
    database, _saver = _seed_legacy(tmp_path / "app.db")
    _seed_business_rows(database)
    coordinator = CheckpointMigrationCoordinator(database)
    coordinator.start()

    result = await CompactTargetBuilder(database).build()

    assert result.target_path.exists()
    assert result.source_query_only is True
    assert {digest.table for digest in result.table_digests} >= {
        "sessions",
        "message_events",
        "attachments",
        "trace_record",
    }
    with database.connect() as source, database.__class__(result.target_path).connect() as target:
        source_message = source.execute(
            "select data_json from message_events where id = 'event-1'"
        ).fetchone()[0]
        target_message = target.execute(
            "select data_json from message_events where id = 'event-1'"
        ).fetchone()[0]
        target_tables = {
            row["name"]
            for row in target.execute(
                "select name from sqlite_master where type = 'table'"
            )
        }
        guarded_legacy_rows = target.execute(
            """
            select
              (select count(*) from checkpoints_v2)
              + (select count(*) from checkpoint_writes_v2)
            """
        ).fetchone()[0]
        lineage = target.execute(
            """
            select checkpoint_lineage_epoch,
                   checkpoint_history_floor_turn_index,
                   checkpoint_root_id
            from sessions where id = 'session-1'
            """
        ).fetchone()
        migration = target.execute(
            "select migration_id from checkpoint_migration_state"
        ).fetchone()
        foreign_key_errors = target.execute("pragma foreign_key_check").fetchall()
        integrity = target.execute("pragma integrity_check").fetchone()[0]

    assert source_message == target_message
    assert {
        "checkpoint_backend_guard",
        "checkpoints_v2",
        "checkpoint_writes_v2",
    } <= target_tables
    assert guarded_legacy_rows == 0
    assert {"checkpoints", "writes"} <= target_tables
    assert tuple(lineage) == (0, 0, None)
    assert migration["migration_id"] == coordinator.inspect().migration_id
    assert foreign_key_errors == []
    assert integrity == "ok"
    assert coordinator.inspect().status is MigrationStatus.COLLAPSING_CHECKPOINTS


@pytest.mark.asyncio
async def test_copy_retry_rebuilds_fixed_target_without_progress_regression(
    tmp_path: Path,
) -> None:
    database, _saver = _seed_legacy(tmp_path / "app.db")
    coordinator = CheckpointMigrationCoordinator(database)
    coordinator.start()
    builder = CompactTargetBuilder(database)

    first = await builder.build()
    first_digests = first.table_digests
    progress_after_first = coordinator.inspect().progress_basis_points
    second = await builder.build()

    assert second.target_path == first.target_path
    assert second.table_digests == first_digests
    assert coordinator.inspect().progress_basis_points >= progress_after_first


@pytest.mark.asyncio
@pytest.mark.parametrize("schema_change", ["table", "column"])
async def test_unknown_source_schema_blocks_copy_without_touching_active_database(
    tmp_path: Path,
    schema_change: str,
) -> None:
    database, _saver = _seed_legacy(tmp_path / "app.db")
    with database.transaction() as connection:
        if schema_change == "table":
            connection.execute(
                "create table unknown_business_data (id text primary key, value text)"
            )
            connection.execute(
                "insert into unknown_business_data values ('row-1', 'keep me')"
            )
        else:
            connection.execute("alter table sessions add column unknown_source_value text")
    coordinator = CheckpointMigrationCoordinator(database)
    coordinator.start()
    source_size = database.path.stat().st_size

    with pytest.raises(CheckpointMigrationError) as raised:
        await CompactTargetBuilder(database).build()

    expected_code = (
        "checkpoint_migration_unknown_business_table"
        if schema_change == "table"
        else "checkpoint_migration_unknown_business_column"
    )
    assert raised.value.code == expected_code
    assert database.path.exists()
    assert database.path.stat().st_size >= source_size
    assert coordinator.inspect().status is MigrationStatus.FAILED
