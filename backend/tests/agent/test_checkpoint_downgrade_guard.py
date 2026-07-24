from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest
from langgraph.checkpoint.base import Checkpoint

from backend.app.agent.checkpoint import LegacySQLiteCheckpointSaver
from backend.app.agent.checkpoint_migration import CheckpointMigrationCoordinator
from backend.app.agent.checkpoint_runtime import CheckpointRuntime
from backend.app.storage import init_database
from backend.app.storage.db import (
    CHECKPOINT_DOWNGRADE_GUARD_MESSAGE,
    LEGACY_CHECKPOINT_SCHEMA_SQL,
)


def _official_checkpoint(checkpoint_id: str) -> Checkpoint:
    return Checkpoint(
        v=2,
        id=checkpoint_id,
        ts="2026-07-24T00:00:00+00:00",
        channel_values={"messages": ["guard-safe"]},
        channel_versions={"messages": checkpoint_id},
        versions_seen={},
        pending_sends=[],
        updated_channels=["messages"],
    )


def _legacy_checkpoint(checkpoint_id: str) -> dict:
    return {
        "v": 1,
        "id": checkpoint_id,
        "ts": "2026-07-24T00:00:00+00:00",
        "channel_values": {"messages": ["legacy"]},
        "channel_versions": {},
        "versions_seen": {},
    }


def test_old_binary_schema_ddl_succeeds_but_checkpoint_writes_are_blocked(
    tmp_path: Path,
) -> None:
    database = init_database(tmp_path / "app.db")

    with database.connect() as connection:
        connection.executescript(LEGACY_CHECKPOINT_SCHEMA_SQL)
        objects = {
            str(row["name"]): str(row["type"])
            for row in connection.execute(
                """
                select name, type from sqlite_master
                where name in (
                  'checkpoint_backend_guard',
                  'checkpoints_v2',
                  'checkpoint_writes_v2'
                )
                """
            )
        }
        trigger_count = connection.execute(
            """
            select count(*) from sqlite_master
            where type = 'trigger' and name like 'trg_%_downgrade_%'
            """
        ).fetchone()[0]

        assert objects == {
            "checkpoint_backend_guard": "table",
            "checkpoint_writes_v2": "table",
            "checkpoints_v2": "table",
        }
        assert trigger_count == 6
        with pytest.raises(sqlite3.IntegrityError, match=CHECKPOINT_DOWNGRADE_GUARD_MESSAGE):
            connection.execute(
                """
                insert into checkpoints_v2 (
                  thread_id, checkpoint_ns, checkpoint_id, created_at,
                  type, checkpoint_blob
                ) values ('old-thread', '', 'old-checkpoint', '2026-07-24', 'json', x'00')
                """
            )
        with pytest.raises(sqlite3.IntegrityError, match=CHECKPOINT_DOWNGRADE_GUARD_MESSAGE):
            connection.execute(
                """
                insert into checkpoint_writes_v2 (
                  thread_id, checkpoint_ns, checkpoint_id, task_id, task_path,
                  idx, channel, type, value_blob, created_at
                ) values (
                  'old-thread', '', 'old-checkpoint', 'task', '',
                  0, 'messages', 'json', x'00', '2026-07-24'
                )
                """
            )


def test_guard_is_repaired_and_rejects_update_and_delete_of_tampered_rows(
    tmp_path: Path,
) -> None:
    database = init_database(tmp_path / "app.db")
    with database.connect() as connection:
        connection.execute("drop trigger trg_checkpoints_v2_downgrade_insert")
        connection.execute(
            """
            insert into checkpoints_v2 (
              thread_id, checkpoint_ns, checkpoint_id, created_at,
              type, checkpoint_blob
            ) values ('tampered', '', 'checkpoint', '2026-07-24', 'json', x'00')
            """
        )
        connection.commit()

    init_database(database.path)
    with database.connect() as connection:
        with pytest.raises(sqlite3.IntegrityError, match=CHECKPOINT_DOWNGRADE_GUARD_MESSAGE):
            connection.execute(
                """
                update checkpoints_v2 set created_at = 'changed'
                where thread_id = 'tampered'
                """
            )
        with pytest.raises(sqlite3.IntegrityError, match=CHECKPOINT_DOWNGRADE_GUARD_MESSAGE):
            connection.execute(
                "delete from checkpoints_v2 where thread_id = 'tampered'"
            )


@pytest.mark.asyncio
async def test_official_runtime_ignores_guard_shells_and_persists_state(
    tmp_path: Path,
) -> None:
    database = init_database(tmp_path / "app.db")
    runtime = CheckpointRuntime(database.path)

    assert await runtime.start() is True
    store = runtime.require_store()
    saved = await store.aput(
        {"configurable": {"thread_id": "official-thread", "checkpoint_ns": ""}},
        _official_checkpoint("checkpoint-01"),
        {"source": "input", "step": 0, "parents": {}},
        {"messages": "checkpoint-01"},
    )
    restored = await store.aget_tuple(saved)

    assert restored is not None
    assert restored.checkpoint["channel_values"]["messages"] == ["guard-safe"]
    await runtime.close()


def test_legacy_fixture_saver_removes_guard_and_remains_migratable(
    tmp_path: Path,
) -> None:
    database = init_database(tmp_path / "app.db")
    saver = LegacySQLiteCheckpointSaver(database)
    saver.put(
        {"configurable": {"thread_id": "legacy-thread", "checkpoint_ns": ""}},
        _legacy_checkpoint("checkpoint-01"),
        {"source": "input"},
        {},
    )

    with database.connect() as connection:
        guard_exists = connection.execute(
            """
            select 1 from sqlite_master
            where type = 'table' and name = 'checkpoint_backend_guard'
            """
        ).fetchone()
        legacy_count = connection.execute(
            "select count(*) from checkpoints_v2"
        ).fetchone()[0]

    assert guard_exists is None
    assert legacy_count == 1
    assert CheckpointMigrationCoordinator(database).inspect() is not None
