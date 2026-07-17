from __future__ import annotations

import pytest

from backend.app.agent.checkpoint import SQLiteCheckpointSaver
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


def _prepare_branchable_session(tmp_path):
    repositories = _repositories(tmp_path)
    repositories.sessions.create(
        session_id="ses_source",
        user_id="local-user",
        scene_id="desktop-agent",
        title="源会话",
    )
    saver = SQLiteCheckpointSaver(repositories.db)
    saver.put(
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
    return repositories, saver, event


def test_checkpoint_service_lists_and_resolves_checkpoint_sources(tmp_path) -> None:
    repositories, saver, event = _prepare_branchable_session(tmp_path)
    service = CheckpointService(repositories, checkpointer=saver)

    latest = service.latest_for_session("ses_source")
    listed = service.list_for_session("ses_source")
    by_trace = service.resolve_source(session_id="ses_source", trace_id="trace_1")
    by_event = service.resolve_source(session_id="ses_source", message_event_id=event.id)
    by_turn = service.resolve_source(session_id="ses_source", turn_index=1)
    by_checkpoint = service.resolve_source(session_id="ses_source", checkpoint_id="ckpt_1")
    by_latest_completed = service.resolve_source(session_id="ses_source")
    by_latest_checkpoint = service.resolve_latest_checkpoint(session_id="ses_source")

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


def test_checkpoint_service_returns_missing_latest_without_error(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    repositories.sessions.create(
        session_id="ses_empty",
        user_id="local-user",
        scene_id="desktop-agent",
    )
    service = CheckpointService(repositories)

    latest = service.latest_for_session("ses_empty")

    assert latest == {
        "exists": False,
        "session_id": "ses_empty",
        "active_session_id": "ses_empty",
        "checkpoint": None,
    }

    with pytest.raises(CheckpointServiceError) as exc_info:
        service.resolve_source(session_id="ses_empty")

    assert exc_info.value.code == "latest_fork_source_missing"


def test_checkpoint_service_rejects_failed_trace_source(tmp_path) -> None:
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
    service = CheckpointService(repositories)

    with pytest.raises(CheckpointServiceError) as exc_info:
        service.resolve_source(session_id="ses_source", trace_id="trace_failed")

    assert exc_info.value.code == "trace_not_completed"
