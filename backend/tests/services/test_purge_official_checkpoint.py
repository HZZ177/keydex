from __future__ import annotations

import pytest
from langchain_core.messages import AIMessage, HumanMessage

from backend.app.agent.checkpoint_runtime import CheckpointRuntime
from backend.app.agent.state import (
    CHECKPOINT_STATE_UPDATE_NODE,
    build_checkpoint_state_graph,
)
from backend.app.services.purge_service import (
    CheckpointGcDryRunPlanner,
    PurgeDatabaseExecutor,
    PurgePlanner,
)
from backend.app.storage import StorageRepositories, init_database


def _archive(repositories: StorageRepositories, session_id: str) -> None:
    with repositories.db.transaction() as conn:
        conn.execute(
            """
            update sessions
               set archived_at = '2026-07-24T00:00:00Z',
                   archive_origin = 'manual'
             where id = ?
            """,
            (session_id,),
        )


@pytest.fixture
async def checkpoint_env(tmp_path):
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    runtime = CheckpointRuntime(repositories.db.path)
    assert await runtime.start() is True
    saver = runtime.require_store()
    graph = build_checkpoint_state_graph(saver)
    yield repositories, graph
    await runtime.close()


@pytest.mark.asyncio
async def test_official_checkpoint_purge_inventory_and_gc_dry_run_are_safe(
    checkpoint_env,
    tmp_path,
) -> None:
    repositories, graph = checkpoint_env
    source = repositories.sessions.create(
        session_id="purge-source",
        user_id="local-user",
        scene_id="desktop-agent",
    )
    neighbor = repositories.sessions.create(
        session_id="purge-neighbor",
        user_id="local-user",
        scene_id="desktop-agent",
    )
    source_root = await graph.aupdate_state(
        {"configurable": {"thread_id": source.id, "checkpoint_ns": ""}},
        {"messages": [HumanMessage(content="source root", id="source-root")]},
        as_node=CHECKPOINT_STATE_UPDATE_NODE,
    )
    source_head = await graph.aupdate_state(
        source_root,
        {"messages": [AIMessage(content="source head", id="source-head")]},
        as_node=CHECKPOINT_STATE_UPDATE_NODE,
    )
    await graph.aupdate_state(
        {"configurable": {"thread_id": neighbor.id, "checkpoint_ns": ""}},
        {"messages": [HumanMessage(content="neighbor survives", id="neighbor-root")]},
        as_node=CHECKPOINT_STATE_UPDATE_NODE,
    )
    root_id = str(source_root["configurable"]["checkpoint_id"])
    head_id = str(source_head["configurable"]["checkpoint_id"])

    repositories.trace_records.create(
        trace_id="purge-trace",
        session_id=source.id,
        active_session_id=source.id,
        scene_id=source.scene_id,
        user_id=source.user_id,
        turn_index=1,
        root_node_id="root",
        input_checkpoint_id=root_id,
        input_checkpoint_ns="",
    )
    repositories.trace_records.finish(
        "purge-trace",
        status="completed",
        output_checkpoint_id=head_id,
        output_checkpoint_ns="",
    )
    repositories.session_forks.create(
        fork_id="purge-fork",
        source_session_id=source.id,
        target_session_id=neighbor.id,
        source_message_event_id="source-event",
        target_message_event_id="target-event",
        source_turn_index=1,
        target_turn_index=1,
        source_active_session_id=source.id,
        source_checkpoint_id=root_id,
        source_checkpoint_ns="",
    )
    with repositories.db.transaction() as conn:
        conn.execute(
            """
            update sessions
               set checkpoint_lineage_epoch = 1,
                   checkpoint_root_id = ?,
                   checkpoint_migration_id = 'migration-purge'
             where id = ?
            """,
            (root_id, source.id),
        )
        conn.execute(
            """
            insert into checkpoint_migration_state (
              migration_id, source_schema, target_schema, status,
              source_db_fingerprint, updated_at
            ) values (
              'migration-purge', 'keydex_checkpoint_v2',
              'langgraph_sqlite_official_v1', 'failed',
              'fingerprint', '2026-07-24T00:00:00Z'
            )
            """
        )
        for thread_id in (source.id, neighbor.id):
            conn.execute(
                """
                insert into checkpoint_migration_namespaces (
                  migration_id, thread_id, checkpoint_ns, status, updated_at
                ) values ('migration-purge', ?, '', 'failed', '2026-07-24T00:00:00Z')
                """,
                (thread_id,),
            )

    first_dry_run = CheckpointGcDryRunPlanner(repositories).plan_threads((source.id,))
    second_dry_run = CheckpointGcDryRunPlanner(repositories).plan_threads((source.id,))
    assert first_dry_run == second_dry_run
    assert first_dry_run.execution_enabled is False
    assert first_dry_run.candidates == ()
    reasons_by_id = {
        item.checkpoint_id: set(item.reasons) for item in first_dry_run.protected
    }
    assert {"migration_root", "trace_anchor", "fork_anchor", "ancestor"}.issubset(
        reasons_by_id[root_id]
    )
    assert {"head", "trace_anchor"}.issubset(reasons_by_id[head_id])
    assert any("pending_or_delta_write" in reasons for reasons in reasons_by_id.values())

    with repositories.db.transaction() as conn:
        conn.execute(
            """
            create trigger require_writes_deleted_before_checkpoint
            before delete on checkpoints
            when exists (
              select 1 from writes
               where thread_id = old.thread_id
                 and checkpoint_ns = old.checkpoint_ns
                 and checkpoint_id = old.checkpoint_id
            )
            begin
              select raise(abort, 'writes must be deleted first');
            end
            """
        )
    _archive(repositories, source.id)
    plan = PurgePlanner(repositories, data_dir=tmp_path / "data").plan_session(source.id)
    assert plan.database_counts["checkpoints"] == 2
    assert plan.database_counts["writes"] > 0
    assert plan.database_counts["checkpoint_migration_namespaces"] == 1

    deleted = PurgeDatabaseExecutor(repositories).execute(plan)

    assert deleted["checkpoints"] == 2
    assert deleted["writes"] == plan.database_counts["writes"]
    assert deleted["checkpoint_migration_namespaces"] == 1
    source_state = await graph.aget_state(
        {"configurable": {"thread_id": source.id, "checkpoint_ns": ""}}
    )
    neighbor_state = await graph.aget_state(
        {"configurable": {"thread_id": neighbor.id, "checkpoint_ns": ""}}
    )
    assert source_state.values == {}
    assert "checkpoint_id" not in source_state.config["configurable"]
    assert [message.content for message in neighbor_state.values["messages"]] == [
        "neighbor survives"
    ]
    with repositories.db.connect() as conn:
        remaining_detail = conn.execute(
            """
            select thread_id from checkpoint_migration_namespaces
             where migration_id = 'migration-purge'
            """
        ).fetchall()
    assert [str(row["thread_id"]) for row in remaining_detail] == [neighbor.id]
