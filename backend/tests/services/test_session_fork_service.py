from __future__ import annotations

import pytest

from backend.app.agent.checkpoint import SQLiteCheckpointSaver
from backend.app.services.session_fork_service import SessionForkService, SessionForkServiceError
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


def _prepare_source(tmp_path):
    repositories = _repositories(tmp_path)
    source = repositories.sessions.create(
        session_id="ses_source",
        user_id="local-user",
        scene_id="desktop-agent",
        title="源会话",
    )
    saver = SQLiteCheckpointSaver(repositories.db)
    first_config = saver.put(
        {"configurable": {"thread_id": source.id, "checkpoint_ns": ""}},
        _checkpoint("ckpt_1"),
        {"step": 1},
        {},
    )
    saver.put(first_config, _checkpoint("ckpt_2"), {"step": 2}, {})
    for turn_index, input_checkpoint_id, output_checkpoint_id in [
        (1, None, "ckpt_1"),
        (2, "ckpt_1", "ckpt_2"),
    ]:
        trace_id = f"trace_{turn_index}"
        repositories.trace_records.create(
            trace_id=trace_id,
            session_id=source.id,
            active_session_id=source.id,
            scene_id=source.scene_id,
            user_id=source.user_id,
            turn_index=turn_index,
            root_node_id=f"root_{turn_index}",
            input_checkpoint_id=input_checkpoint_id,
            input_checkpoint_ns="",
        )
        repositories.trace_records.finish(
            trace_id,
            status="completed",
            output_checkpoint_id=output_checkpoint_id,
            output_checkpoint_ns="",
        )
        repositories.message_events.append(
            event_id=f"evt_user_{turn_index}",
            session_id=source.id,
            trace_record_id=trace_id,
            turn_index=turn_index,
            action="user_message",
            data={"session_id": source.id, "content": f"问题 {turn_index}"},
        )
        repositories.message_events.append(
            event_id=f"evt_ai_{turn_index}",
            session_id=source.id,
            trace_record_id=trace_id,
            turn_index=turn_index,
            action="ai_message",
            data={"session_id": source.id, "content": f"回答 {turn_index}"},
        )
    return repositories, saver


def test_session_fork_service_clones_checkpoint_and_copies_history_until_source(tmp_path) -> None:
    repositories, saver = _prepare_source(tmp_path)
    service = SessionForkService(repositories, checkpointer=saver)

    result = service.fork_session(
        session_id="ses_source",
        user_id="local-user",
        trace_id="trace_1",
        title="从第一轮继续",
    )

    forked = result.session
    assert forked.parent_session_id == "ses_source"
    assert forked.source_trace_id == "trace_1"
    assert forked.source_active_session_id == "ses_source"
    assert forked.source_checkpoint_id == "ckpt_1"
    assert forked.source_checkpoint_ns == ""
    assert repositories.sessions.get("ses_source").child_session_id == forked.id

    copied_events = repositories.message_events.list_by_session(forked.id)
    assert [event.turn_index for event in copied_events] == [1, 1]
    assert [event.data["session_id"] for event in copied_events] == [forked.id, forked.id]
    cloned_checkpoint = saver.get_tuple(
        {"configurable": {"thread_id": forked.id, "checkpoint_ns": ""}}
    )
    assert cloned_checkpoint.config["configurable"]["checkpoint_id"] == "ckpt_1"


def test_session_reverse_rolls_back_same_session_to_user_turn_input_checkpoint(tmp_path) -> None:
    repositories, saver = _prepare_source(tmp_path)
    service = SessionForkService(repositories, checkpointer=saver)

    result = service.reverse_session(
        session_id="ses_source",
        user_id="local-user",
        message_event_id="evt_user_2",
    )

    source = repositories.sessions.get("ses_source")
    assert result.session.id == "ses_source"
    assert source.active_session_id == "ses_source"
    assert result.source.checkpoint_id == "ckpt_1"
    assert result.source.turn_index == 2
    assert repositories.message_events.count_by_session("ses_source") == 2
    assert [trace.trace_id for trace in repositories.trace_records.list_by_session("ses_source")] == [
        "trace_1"
    ]
    rolled_back_checkpoint = saver.get_tuple(
        {"configurable": {"thread_id": "ses_source", "checkpoint_ns": ""}}
    )
    assert rolled_back_checkpoint.config["configurable"]["checkpoint_id"] == "ckpt_1"

    rewritten = repositories.message_events.append(
        event_id="evt_user_2_new",
        session_id="ses_source",
        trace_record_id="trace_2_new",
        turn_index=2,
        action="user_message",
        data={"session_id": "ses_source", "content": "新的第二轮"},
    )
    assert rewritten.seq == 3


def test_session_reverse_first_turn_clears_history_and_checkpoints(tmp_path) -> None:
    repositories, saver = _prepare_source(tmp_path)
    service = SessionForkService(repositories, checkpointer=saver)

    result = service.reverse_session(
        session_id="ses_source",
        user_id="local-user",
        message_event_id="evt_user_1",
    )

    assert result.session.id == "ses_source"
    assert result.source.checkpoint_id is None
    assert repositories.message_events.count_by_session("ses_source") == 0
    assert repositories.trace_records.list_by_session("ses_source") == []
    assert saver.get_tuple({"configurable": {"thread_id": "ses_source", "checkpoint_ns": ""}}) is None


def test_session_reverse_rejects_assistant_message_source(tmp_path) -> None:
    repositories, saver = _prepare_source(tmp_path)
    service = SessionForkService(repositories, checkpointer=saver)

    with pytest.raises(SessionForkServiceError) as exc_info:
        service.reverse_session(
            session_id="ses_source",
            user_id="local-user",
            message_event_id="evt_ai_2",
        )

    assert exc_info.value.code == "reverse_source_must_be_user_message"


def test_session_reverse_rejects_missing_input_checkpoint_when_history_exists(tmp_path) -> None:
    repositories, saver = _prepare_source(tmp_path)
    repositories.trace_records.create(
        trace_id="trace_legacy",
        session_id="ses_source",
        active_session_id="ses_source",
        scene_id="desktop-agent",
        user_id="local-user",
        turn_index=3,
        root_node_id="root_legacy",
    )
    repositories.trace_records.finish(
        "trace_legacy",
        status="completed",
        output_checkpoint_id="ckpt_2",
        output_checkpoint_ns="",
    )
    repositories.message_events.append(
        event_id="evt_user_legacy",
        session_id="ses_source",
        trace_record_id="trace_legacy",
        turn_index=3,
        action="user_message",
        data={"session_id": "ses_source", "content": "旧格式问题"},
    )
    repositories.message_events.append(
        event_id="evt_ai_legacy",
        session_id="ses_source",
        trace_record_id="trace_legacy",
        turn_index=3,
        action="ai_message",
        data={"session_id": "ses_source", "content": "旧格式回答"},
    )
    service = SessionForkService(repositories, checkpointer=saver)

    with pytest.raises(SessionForkServiceError) as exc_info:
        service.reverse_session(
            session_id="ses_source",
            user_id="local-user",
            message_event_id="evt_user_legacy",
        )

    assert exc_info.value.code == "reverse_input_checkpoint_missing"
    assert repositories.message_events.count_by_session("ses_source") == 6
    latest_checkpoint = saver.get_tuple(
        {"configurable": {"thread_id": "ses_source", "checkpoint_ns": ""}}
    )
    assert latest_checkpoint.config["configurable"]["checkpoint_id"] == "ckpt_2"


def test_session_fork_service_rolls_back_when_clone_fails(tmp_path) -> None:
    repositories, _saver = _prepare_source(tmp_path)
    service = SessionForkService(
        repositories, checkpointer=FailingCloneCheckpointSaver(repositories.db)
    )

    with pytest.raises(SessionForkServiceError) as exc_info:
        service.fork_session(
            session_id="ses_source",
            user_id="local-user",
            trace_id="trace_1",
        )

    assert exc_info.value.code == "session_fork_failed"
    assert [session.id for session in repositories.sessions.list(limit=10)] == ["ses_source"]


class FailingCloneCheckpointSaver(SQLiteCheckpointSaver):
    def clone_checkpoint_to_thread(self, **_kwargs) -> None:
        raise RuntimeError("clone failed")
