from __future__ import annotations

import pytest

from backend.app.agent.checkpoint_runtime import CheckpointRuntime
from backend.app.services.checkpoint_service import CheckpointService, CheckpointServiceError
from backend.app.storage import StorageRepositories, init_database


def _repositories(tmp_path) -> StorageRepositories:
    return StorageRepositories(init_database(tmp_path / "app.db"))


def _checkpoint(checkpoint_id: str) -> dict:
    return {
        "v": 1,
        "id": checkpoint_id,
        "ts": f"2026-06-28T00:00:00+00:00:{checkpoint_id}",
        "channel_values": {"messages": [checkpoint_id]},
        "channel_versions": {},
        "versions_seen": {},
    }


async def _runtime(repositories: StorageRepositories) -> CheckpointRuntime:
    runtime = CheckpointRuntime(repositories.db.path)
    assert await runtime.start() is True
    return runtime


async def _prepare_branchable_session(tmp_path):
    repositories = _repositories(tmp_path)
    repositories.sessions.create(
        session_id="ses_source",
        user_id="local-user",
        scene_id="desktop-agent",
        title="源会话",
    )
    runtime = await _runtime(repositories)
    saver = runtime.require_store()
    await saver.aput(
        {"configurable": {"thread_id": "ses_source", "checkpoint_ns": ""}},
        _checkpoint("ckpt_1"),
        {"step": 1},
        {},
    )
    repositories.trace_records.create(
        trace_id="trace_1",
        session_id="ses_source",
        active_session_id="ses_source",
        scene_id="desktop-agent",
        user_id="local-user",
        turn_index=1,
        root_node_id="root",
    )
    repositories.trace_records.finish(
        "trace_1",
        status="completed",
        output_checkpoint_id="ckpt_1",
        output_checkpoint_ns="",
    )
    event = repositories.message_events.append(
        event_id="evt_1",
        session_id="ses_source",
        trace_record_id="trace_1",
        turn_index=1,
        action="user_message",
        data={"content": "问题"},
    )
    repositories.message_events.append(
        event_id="evt_stream_1",
        session_id="ses_source",
        trace_record_id="trace_1",
        turn_index=1,
        action="stream_batch",
        data={"content": "回答"},
    )
    repositories.message_events.append(
        event_id="evt_subagent_stream_1",
        session_id="ses_source",
        trace_record_id="trace_1",
        turn_index=1,
        action="stream_batch",
        data={"content": "子代理回答", "is_subagent": True},
    )
    return repositories, runtime, event


@pytest.mark.asyncio
async def test_checkpoint_service_lists_and_resolves_checkpoint_sources(tmp_path) -> None:
    repositories, runtime, event = await _prepare_branchable_session(tmp_path)
    service = CheckpointService(repositories, checkpointer=runtime.require_store())

    latest = await service.latest_for_session("ses_source")
    listed = await service.list_for_session("ses_source")
    by_trace = await service.resolve_source(session_id="ses_source", trace_id="trace_1")
    by_event = await service.resolve_source(
        session_id="ses_source", message_event_id=event.id
    )
    by_turn = await service.resolve_source(session_id="ses_source", turn_index=1)
    by_checkpoint = await service.resolve_source(
        session_id="ses_source", checkpoint_id="ckpt_1"
    )
    by_latest_completed = await service.resolve_source(session_id="ses_source")
    by_latest_checkpoint = await service.resolve_latest_checkpoint(
        session_id="ses_source"
    )

    assert latest["exists"] is True
    assert latest["checkpoint"]["checkpoint_id"] == "ckpt_1"
    assert latest["checkpoint"]["metadata"] == {"step": 1}
    assert [item["checkpoint_id"] for item in listed] == ["ckpt_1"]
    assert by_trace.checkpoint_id == "ckpt_1"
    assert by_trace.source_type == "trace"
    assert by_event.message_event_id == "evt_1"
    assert by_event.source_type == "message_event"
    assert by_turn.turn_index == 1
    assert by_checkpoint.source_type == "checkpoint"
    assert by_latest_completed.checkpoint_id == "ckpt_1"
    assert by_latest_completed.message_event_id == "evt_stream_1"
    assert by_latest_completed.source_type == "latest_completed"
    assert by_latest_checkpoint.checkpoint_id == "ckpt_1"
    assert by_latest_checkpoint.message_event_id is None
    assert by_latest_checkpoint.source_type == "latest_checkpoint"
    await runtime.close()


@pytest.mark.asyncio
async def test_checkpoint_service_returns_missing_latest_without_error(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    repositories.sessions.create(
        session_id="ses_empty",
        user_id="local-user",
        scene_id="desktop-agent",
    )
    runtime = await _runtime(repositories)
    service = CheckpointService(repositories, checkpointer=runtime.require_store())

    latest = await service.latest_for_session("ses_empty")

    assert latest == {
        "exists": False,
        "session_id": "ses_empty",
        "active_session_id": "ses_empty",
        "checkpoint": None,
    }

    with pytest.raises(CheckpointServiceError) as exc_info:
        await service.resolve_source(session_id="ses_empty")

    assert exc_info.value.code == "latest_fork_source_missing"
    await runtime.close()


@pytest.mark.asyncio
async def test_checkpoint_service_rejects_failed_trace_source(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    repositories.sessions.create(
        session_id="ses_source",
        user_id="local-user",
        scene_id="desktop-agent",
    )
    repositories.trace_records.create(
        trace_id="trace_failed",
        session_id="ses_source",
        active_session_id="ses_source",
        scene_id="desktop-agent",
        user_id="local-user",
        turn_index=1,
        root_node_id="root",
    )
    repositories.trace_records.finish("trace_failed", status="failed")
    runtime = await _runtime(repositories)
    service = CheckpointService(repositories, checkpointer=runtime.require_store())

    with pytest.raises(CheckpointServiceError) as exc_info:
        await service.resolve_source(session_id="ses_source", trace_id="trace_failed")

    assert exc_info.value.code == "trace_not_completed"
    await runtime.close()


@pytest.mark.asyncio
async def test_lineage_boundary_exposes_root_and_classifies_compacted_history(
    tmp_path,
) -> None:
    repositories = _repositories(tmp_path)
    repositories.sessions.create(
        session_id="ses_source",
        user_id="local-user",
        scene_id="desktop-agent",
    )
    runtime = await _runtime(repositories)
    await runtime.require_store().aput(
        {"configurable": {"thread_id": "ses_source", "checkpoint_ns": ""}},
        _checkpoint("migration-root"),
        {"source": "migration"},
        {},
    )
    repositories.trace_records.create(
        trace_id="trace_old",
        session_id="ses_source",
        active_session_id="ses_source",
        scene_id="desktop-agent",
        user_id="local-user",
        turn_index=1,
        root_node_id="root",
    )
    repositories.trace_records.finish(
        "trace_old",
        status="completed",
        output_checkpoint_id="removed-old-checkpoint",
        output_checkpoint_ns="",
    )
    repositories.message_events.append(
        event_id="evt_old",
        session_id="ses_source",
        trace_record_id="trace_old",
        turn_index=1,
        action="ai_message",
        data={"content": "历史回答"},
    )
    with repositories.db.transaction() as connection:
        connection.execute(
            """
            update sessions
            set checkpoint_lineage_epoch = 1,
                checkpoint_history_floor_turn_index = 3,
                checkpoint_root_id = 'migration-root',
                checkpoint_migration_id = 'checkpoint-v2-collapse-to-official-v1'
            where id = 'ses_source'
            """
        )

    service = CheckpointService(repositories, checkpointer=runtime.require_store())
    latest = await service.resolve_latest_checkpoint(session_id="ses_source")
    current = await service.resolve_source(session_id="ses_source")

    assert latest.checkpoint_id == "migration-root"
    assert current.checkpoint_id == "migration-root"
    assert current.source_type == "migration_root"
    assert current.history_floor_turn_index == 3
    for kwargs in (
        {"turn_index": 1},
        {"trace_id": "trace_old"},
        {"checkpoint_id": "removed-old-checkpoint"},
    ):
        with pytest.raises(CheckpointServiceError) as exc_info:
            await service.resolve_source(session_id="ses_source", **kwargs)
        assert exc_info.value.code == "checkpoint_history_compacted"

    with pytest.raises(CheckpointServiceError) as missing:
        await service.resolve_checkpoint(
            session_id="ses_source",
            checkpoint_id="never-existed",
        )
    assert missing.value.code == "checkpoint_not_found"
    await runtime.close()
