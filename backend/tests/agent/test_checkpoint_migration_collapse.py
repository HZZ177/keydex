from __future__ import annotations

from pathlib import Path

import aiosqlite
import pytest
from langchain_core.messages import AIMessage, HumanMessage
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

from backend.app.agent.checkpoint_migration import (
    MIGRATION_ID,
    CheckpointMigrationCoordinator,
    MigrationStatus,
)
from backend.app.agent.checkpoint_migration_collapse import NamespaceCollapseMigrator
from backend.app.agent.checkpoint_migration_copy import CompactTargetBuilder
from backend.app.agent.checkpoint_serializer import KeydexCompressedSerializer
from backend.app.agent.state import (
    CHECKPOINT_STATE_UPDATE_NODE,
    build_checkpoint_state_graph,
)
from backend.tests.agent.test_checkpoint_migration_state import (
    _seed_legacy,
    _seed_session,
)


def _seed_visible_session(database) -> None:
    with database.transaction() as connection:
        _seed_session(connection, "session-1", active_session_id="thread-a")
        connection.executemany(
            """
            insert into message_events (
              id, session_id, seq, turn_index, action, created_at, updated_at
            ) values (?, 'session-1', ?, ?, 'message', '2026-01-01', '2026-01-01')
            """,
            [("event-1", 1, 0), ("event-2", 2, 3)],
        )


@pytest.mark.asyncio
async def test_collapse_keeps_one_root_per_namespace_and_only_head_writes(
    tmp_path: Path,
) -> None:
    database, saver = _seed_legacy(tmp_path / "app.db")
    _seed_visible_session(database)
    latest = saver.get_tuple(
        {"configurable": {"thread_id": "thread-a", "checkpoint_ns": ""}}
    )
    assert latest is not None
    saver.put_writes(
        latest.config,
        [("messages", {"pending": "head"})],
        "task-head",
    )
    coordinator = CheckpointMigrationCoordinator(database)
    coordinator.start()
    target = await CompactTargetBuilder(database).build()

    result = NamespaceCollapseMigrator(database).collapse()

    assert len(result.namespaces) == 3
    assert result.discarded_checkpoints == 1
    assert result.discarded_writes == 0
    with database.__class__(target.target_path).connect() as connection:
        roots = connection.execute(
            """
            select thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id
            from checkpoints order by thread_id, checkpoint_ns
            """
        ).fetchall()
        writes = connection.execute(
            "select task_id, channel from writes order by task_id, idx"
        ).fetchall()
        session = connection.execute(
            """
            select checkpoint_lineage_epoch,
                   checkpoint_history_floor_turn_index,
                   checkpoint_root_id,
                   checkpoint_migration_id
            from sessions where id = 'session-1'
            """
        ).fetchone()
        details = connection.execute(
            """
            select status, source_head_digest, target_root_digest, hydrate_digest
            from checkpoint_migration_namespaces order by thread_id, checkpoint_ns
            """
        ).fetchall()
    assert len(roots) == 3
    assert all(row["parent_checkpoint_id"] is None for row in roots)
    assert [(row["task_id"], row["channel"]) for row in writes] == [
        ("task-head", "messages")
    ]
    assert tuple(session) == (1, 4, "checkpoint-02", MIGRATION_ID)
    assert all(row["status"] == "completed" for row in details)
    assert all(
        row["source_head_digest"]
        == row["target_root_digest"]
        == row["hydrate_digest"]
        for row in details
    )
    assert coordinator.inspect().status is MigrationStatus.VERIFYING_TARGET

    async with aiosqlite.connect(target.target_path) as connection:
        official = AsyncSqliteSaver(
            connection,
            serde=KeydexCompressedSerializer(),
        )
        restored = await official.aget_tuple(
            {
                "configurable": {
                    "thread_id": "thread-a",
                    "checkpoint_ns": "",
                }
            }
        )
    assert restored is not None
    assert restored.config["configurable"]["checkpoint_id"] == "checkpoint-02"
    assert restored.checkpoint["channel_values"]["messages"] == ["checkpoint-02"]
    assert restored.pending_writes == [
        ("task-head", "messages", {"pending": "head"})
    ]


@pytest.mark.asyncio
async def test_collapse_retry_is_idempotent_and_does_not_increment_lineage_twice(
    tmp_path: Path,
) -> None:
    database, _saver = _seed_legacy(tmp_path / "app.db")
    _seed_visible_session(database)
    coordinator = CheckpointMigrationCoordinator(database)
    coordinator.start()
    target = await CompactTargetBuilder(database).build()
    migrator = NamespaceCollapseMigrator(database)

    first = migrator.collapse()
    second = migrator.collapse()

    assert second == first
    with database.__class__(target.target_path).connect() as connection:
        epoch = connection.execute(
            """
            select checkpoint_lineage_epoch
            from sessions where id = 'session-1'
            """
        ).fetchone()[0]
        root_count = connection.execute("select count(*) from checkpoints").fetchone()[0]
    assert epoch == 1
    assert root_count == 3


@pytest.mark.asyncio
async def test_visible_history_without_checkpoint_root_keeps_history_and_can_continue(
    tmp_path: Path,
) -> None:
    database, _saver = _seed_legacy(tmp_path / "app.db")
    with database.transaction() as connection:
        _seed_session(connection, "orphan-session", active_session_id="missing-thread")
        connection.execute(
            """
            insert into message_events (
              id, session_id, seq, turn_index, action, created_at, updated_at
            ) values (
              'event-orphan', 'orphan-session', 1, 0, 'message',
              '2026-01-01', '2026-01-01'
            )
            """
        )
    coordinator = CheckpointMigrationCoordinator(database)
    coordinator.start()
    target = await CompactTargetBuilder(database).build()

    result = NamespaceCollapseMigrator(database).collapse()

    assert len(result.namespaces) == 3
    assert coordinator.inspect().status is MigrationStatus.VERIFYING_TARGET
    with database.__class__(target.target_path).connect() as connection:
        orphan = connection.execute(
            """
            select checkpoint_lineage_epoch,
                   checkpoint_history_floor_turn_index,
                   checkpoint_root_id,
                   checkpoint_migration_id
            from sessions where id = 'orphan-session'
            """
        ).fetchone()
        visible_events = connection.execute(
            """
            select count(*) from message_events
            where session_id = 'orphan-session' and is_deleted = 0
            """
        ).fetchone()[0]
        missing_thread_roots = connection.execute(
            """
            select count(*) from checkpoints
            where thread_id = 'missing-thread' and checkpoint_ns = ''
            """
        ).fetchone()[0]
    assert tuple(orphan) == (1, 1, None, MIGRATION_ID)
    assert visible_events == 1
    assert missing_thread_roots == 0

    async with aiosqlite.connect(target.target_path) as connection:
        official = AsyncSqliteSaver(
            connection,
            serde=KeydexCompressedSerializer(),
        )
        graph = build_checkpoint_state_graph(official)
        config = {
            "configurable": {
                "thread_id": "missing-thread",
                "checkpoint_ns": "",
            }
        }
        before = await graph.aget_state(config)
        updated = await graph.aupdate_state(
            config,
            {
                "messages": [
                    HumanMessage(content="new request", id="new-user"),
                    AIMessage(content="new answer", id="new-answer"),
                ]
            },
            as_node=CHECKPOINT_STATE_UPDATE_NODE,
        )
        after = await graph.aget_state(updated)

    assert before.values == {}
    assert [message.content for message in after.values["messages"]] == [
        "new request",
        "new answer",
    ]
