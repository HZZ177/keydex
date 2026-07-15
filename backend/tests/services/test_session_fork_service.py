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
        current_model_provider_id="provider-source",
        current_model="qwen-coder",
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
    repositories.message_events.append(
        event_id="evt_skill_system_1",
        session_id="ses_source",
        trace_record_id="trace_1",
        turn_index=1,
        action="system_message",
        data={
            "session_id": "ses_source",
            "source": "skill_activation",
            "id": "skill:system:shared",
            "skill_name": "shared",
            "skill_source": "system",
            "locator": ".keydex/skills/shared/SKILL.md",
            "origin": "slash",
        },
    )
    service = SessionForkService(repositories, checkpointer=saver)

    result = service.fork_session(
        session_id="ses_source",
        user_id="local-user",
        message_event_id="evt_ai_1",
        title="从第一轮继续",
    )

    forked = result.session
    assert forked.session_tag == "chat"
    assert forked.current_model_provider_id == "provider-source"
    assert forked.current_model == "qwen-coder"
    assert forked.parent_session_id is None
    assert forked.source_trace_id is None
    assert forked.source_active_session_id is None
    assert forked.source_checkpoint_id is None
    assert forked.source_checkpoint_ns is None
    assert repositories.sessions.get("ses_source").child_session_id is None
    fork_record = repositories.session_forks.get_by_target(forked.id)
    assert fork_record is not None
    assert fork_record.source_session_id == "ses_source"
    assert fork_record.source_message_event_id == "evt_ai_1"
    assert fork_record.target_message_event_id != "evt_ai_1"
    assert fork_record.source_turn_index == 1
    assert fork_record.target_turn_index == 1
    assert fork_record.source_trace_id == "trace_1"
    assert fork_record.source_active_session_id == "ses_source"
    assert fork_record.source_checkpoint_id == "ckpt_1"
    assert fork_record.source_checkpoint_ns == ""

    copied_events = repositories.message_events.list_by_session(forked.id)
    assert [event.turn_index for event in copied_events] == [1, 1, 1]
    assert [event.data["session_id"] for event in copied_events] == [
        forked.id,
        forked.id,
        forked.id,
    ]
    skill_event = next(
        event for event in copied_events if event.data.get("source") == "skill_activation"
    )
    assert skill_event.data["id"] == "skill:system:shared"
    assert skill_event.data["skill_source"] == "system"
    assert skill_event.data["locator"] == ".keydex/skills/shared/SKILL.md"
    cloned_checkpoint = saver.get_tuple(
        {"configurable": {"thread_id": forked.id, "checkpoint_ns": ""}}
    )
    assert cloned_checkpoint.config["configurable"]["checkpoint_id"] == "ckpt_1"


def test_session_fork_service_allows_multiple_forks_from_same_message(tmp_path) -> None:
    repositories, saver = _prepare_source(tmp_path)
    service = SessionForkService(repositories, checkpointer=saver)

    first = service.fork_session(
        session_id="ses_source",
        user_id="local-user",
        message_event_id="evt_ai_1",
        title="分支一",
    ).session
    second = service.fork_session(
        session_id="ses_source",
        user_id="local-user",
        message_event_id="evt_ai_1",
        title="分支二",
    ).session

    fork_records = repositories.session_forks.list_by_source("ses_source")
    assert [record.target_session_id for record in fork_records] == [first.id, second.id]
    assert {record.source_message_event_id for record in fork_records} == {"evt_ai_1"}
    assert len({record.target_message_event_id for record in fork_records}) == 2
    assert repositories.sessions.get("ses_source").child_session_id is None
    assert (
        saver.get_tuple({"configurable": {"thread_id": first.id, "checkpoint_ns": ""}})
        is not None
    )
    assert (
        saver.get_tuple({"configurable": {"thread_id": second.id, "checkpoint_ns": ""}})
        is not None
    )


def test_session_fork_service_allows_target_session_tag_override(tmp_path) -> None:
    repositories, saver = _prepare_source(tmp_path)
    service = SessionForkService(repositories, checkpointer=saver)

    forked = service.fork_session(
        session_id="ses_source",
        user_id="local-user",
        message_event_id="evt_ai_1",
        title="临时分支",
        session_tag="btw",
    ).session

    assert forked.session_tag == "btw"
    assert repositories.session_forks.get_by_target(forked.id) is not None


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
    assert result.restored_input == "问题 2"
    assert repositories.message_events.count_by_session("ses_source") == 2
    trace_ids = [
        trace.trace_id for trace in repositories.trace_records.list_by_session("ses_source")
    ]
    assert trace_ids == ["trace_1"]
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


def test_session_reverse_rolls_back_checkpoint_and_rows_as_one_transaction(
    tmp_path,
    monkeypatch,
) -> None:
    repositories, saver = _prepare_source(tmp_path)
    service = SessionForkService(repositories, checkpointer=saver)

    def fail_after_checkpoint(*_args, **_kwargs):
        raise RuntimeError("injected conversation transaction failure")

    monkeypatch.setattr(service, "_rewind_turn_artifacts", fail_after_checkpoint)
    with pytest.raises(SessionForkServiceError) as error:
        service.reverse_session(
            session_id="ses_source",
            user_id="local-user",
            message_event_id="evt_user_2",
        )

    assert error.value.code == "session_reverse_failed"
    assert repositories.message_events.count_by_session("ses_source") == 4
    assert len(repositories.trace_records.list_by_session("ses_source")) == 2
    latest = saver.get_tuple(
        {"configurable": {"thread_id": "ses_source", "checkpoint_ns": ""}}
    )
    assert latest is not None
    assert latest.config["configurable"]["checkpoint_id"] == "ckpt_2"


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
    assert (
        saver.get_tuple({"configurable": {"thread_id": "ses_source", "checkpoint_ns": ""}})
        is None
    )


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
            message_event_id="evt_ai_1",
        )

    assert exc_info.value.code == "session_fork_failed"
    assert [session.id for session in repositories.sessions.list(limit=10)] == ["ses_source"]


@pytest.mark.parametrize("action", ["fork", "reverse"])
def test_session_fork_and_reverse_reject_archived_source(tmp_path, action: str) -> None:
    repositories, saver = _prepare_source(tmp_path)
    repositories.sessions.archive_manual(
        "ses_source",
        archived_at="2026-07-14T00:00:00Z",
    )
    service = SessionForkService(repositories, checkpointer=saver)

    with pytest.raises(SessionForkServiceError) as archived:
        if action == "fork":
            service.fork_session(
                session_id="ses_source",
                user_id="local-user",
                message_event_id="evt_ai_1",
            )
        else:
            service.reverse_session(
                session_id="ses_source",
                user_id="local-user",
                message_event_id="evt_user_1",
            )

    assert archived.value.code == "entity_archived"
    assert repositories.sessions.get_archived("ses_source") is not None


class FailingCloneCheckpointSaver(SQLiteCheckpointSaver):
    def clone_checkpoint_to_thread(self, **_kwargs) -> None:
        raise RuntimeError("clone failed")
