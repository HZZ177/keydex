from __future__ import annotations

from typing import Any

from backend.app.services import MessageEventService
from backend.app.storage import (
    A2UI_STATUS_CANCELLED,
    A2UI_STATUS_SUBMITTED,
    StorageRepositories,
    init_database,
)


def test_a2ui_created_restores_role_a2ui_message(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_interaction(repositories, "a2ui-1")
    _append_a2ui_created(repositories, "a2ui-1")

    messages = MessageEventService(repositories.message_events).get_display_messages(
        "ses_history"
    )

    assert len(messages) == 1
    assert messages[0]["role"] == "a2ui"
    assert messages[0]["contentType"] == "a2ui"
    assert messages[0]["traceId"] == "trace-1"
    assert messages[0]["a2ui"]["render_key"] == "confirm"
    assert messages[0]["a2ui"]["interaction"]["status"] == "waiting_user_input"
    assert messages[0]["a2ui"]["interaction"]["can_submit"] is True


def test_a2ui_history_enriches_submitted_state_from_interaction_table(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_interaction(repositories, "a2ui-1")
    _append_a2ui_created(repositories, "a2ui-1")
    repositories.a2ui_interactions.submit(
        "a2ui-1",
        request_id="submit-1",
        submit_result={"confirmed": True},
        resume_payload={
            "status": A2UI_STATUS_SUBMITTED,
            "interaction_id": "a2ui-1",
            "submit_result": {"confirmed": True},
        },
    )

    messages = MessageEventService(repositories.message_events).get_display_messages(
        "ses_history"
    )

    interaction = messages[0]["a2ui"]["interaction"]
    assert interaction["status"] == A2UI_STATUS_SUBMITTED
    assert interaction["can_submit"] is False
    assert interaction["submit_request_id"] == "submit-1"
    assert interaction["submit_result"] == {"confirmed": True}


def test_a2ui_history_enriches_cancelled_state_from_interaction_table(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_interaction(repositories, "a2ui-1")
    _append_a2ui_created(repositories, "a2ui-1")
    repositories.a2ui_interactions.cancel(
        "a2ui-1",
        request_id="cancel-1",
        cancel_reason="user_cancelled",
        resume_payload={
            "status": A2UI_STATUS_CANCELLED,
            "interaction_id": "a2ui-1",
            "reason": "user_cancelled",
        },
    )

    messages = MessageEventService(repositories.message_events).get_display_messages(
        "ses_history"
    )

    interaction = messages[0]["a2ui"]["interaction"]
    assert interaction["status"] == A2UI_STATUS_CANCELLED
    assert interaction["can_submit"] is False
    assert interaction["cancel_request_id"] == "cancel-1"
    assert interaction["cancel_reason"] == "user_cancelled"


def test_a2ui_history_marks_missing_interaction_unsubmittable(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _append_a2ui_created(repositories, "missing-a2ui")

    messages = MessageEventService(repositories.message_events).get_display_messages(
        "ses_history"
    )

    interaction = messages[0]["a2ui"]["interaction"]
    assert interaction["interaction_id"] == "missing-a2ui"
    assert interaction["status"] == "missing"
    assert interaction["can_submit"] is False
    assert interaction["error"] == "interaction_not_found"


def test_waiting_input_updates_a2ui_message_without_extra_visible_message(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_interaction(repositories, "a2ui-1")
    _append_a2ui_created(repositories, "a2ui-1")
    repositories.message_events.append(
        event_id="evt_waiting",
        session_id="ses_history",
        turn_index=1,
        action="waiting_input",
        data={
            "interaction_id": "a2ui-1",
            "reason": "a2ui",
            "checkpoint": {"checkpoint_id": "checkpoint-1"},
        },
    )

    messages = MessageEventService(repositories.message_events).get_display_messages(
        "ses_history"
    )

    assert [message["role"] for message in messages] == ["a2ui"]
    assert messages[0]["a2ui"]["waiting_input"]["checkpoint"]["checkpoint_id"] == (
        "checkpoint-1"
    )


def _repositories(tmp_path) -> StorageRepositories:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    repositories.sessions.create(
        session_id="ses_history",
        user_id="local-user",
        scene_id="desktop-agent",
    )
    return repositories


def _create_interaction(repositories: StorageRepositories, interaction_id: str) -> None:
    repositories.a2ui_interactions.create(
        interaction_id=interaction_id,
        session_id="ses_history",
        trace_id="trace-1",
        active_session_id="ses_history",
        turn_index=1,
        tool_call_id="tool-1",
        stream_id="stream-1",
        render_key="confirm",
        mode="interactive",
        payload={"title": "Confirm"},
        input_schema={"type": "object"},
        submit_schema_snapshot={"type": "object"},
        langgraph_thread_id="ses_history",
        checkpoint_ns="",
        checkpoint_id="checkpoint-1",
        interrupt_id="interrupt-1",
        resume_group_id="group-1",
    )


def _append_a2ui_created(repositories: StorageRepositories, interaction_id: str) -> None:
    repositories.message_events.append(
        event_id=f"evt_{interaction_id}",
        session_id="ses_history",
        turn_index=1,
        action="a2ui_created",
        data=_a2ui_created_payload(interaction_id),
    )


def _a2ui_created_payload(interaction_id: str) -> dict[str, Any]:
    return {
        "interaction_id": interaction_id,
        "render_key": "confirm",
        "mode": "interactive",
        "stream_id": "stream-1",
        "tool_call_id": "tool-1",
        "trace_id": "trace-1",
        "turn_index": 1,
        "a2ui": {
            "render_key": "confirm",
            "mode": "interactive",
            "stream_id": "stream-1",
            "tool_call_id": "tool-1",
            "trace_id": "trace-1",
            "turn_index": 1,
            "payload": {"title": "Confirm"},
            "input_schema": {"type": "object"},
            "submit_schema": {"type": "object"},
            "interaction": {
                "interaction_id": interaction_id,
                "status": "waiting_user_input",
                "can_submit": True,
                "resume_status": "not_started",
                "resume_group_id": "group-1",
            },
        },
    }
