from __future__ import annotations

import pytest

from backend.app.storage import (
    A2UI_RESUME_STATUS_NOT_STARTED,
    A2UI_RESUME_STATUS_STARTED,
    A2UI_RESUME_STATUS_SUCCEEDED,
    A2UI_STATUS_CANCELLED,
    A2UI_STATUS_SUBMITTED,
    A2UI_STATUS_WAITING_USER_INPUT,
    StorageRepositories,
    init_database,
)


def test_a2ui_interactions_repository_create_get_and_waiting_query(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    record = _create_interaction(repositories, interaction_id="a2ui-1")

    loaded = repositories.a2ui_interactions.get("a2ui-1")
    waiting = repositories.a2ui_interactions.get_waiting_by_session("session-1")

    assert loaded == record
    assert record.can_submit is True
    assert record.status == A2UI_STATUS_WAITING_USER_INPUT
    assert record.resume_status == A2UI_RESUME_STATUS_NOT_STARTED
    assert record.payload == {"title": "Confirm"}
    assert [item.id for item in waiting] == ["a2ui-1"]


def test_a2ui_interactions_repository_submit_is_idempotent_by_request_id(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_interaction(repositories, interaction_id="a2ui-1")

    submitted = repositories.a2ui_interactions.submit(
        "a2ui-1",
        request_id="submit-1",
        submit_result={"confirmed": True},
        resume_payload={"confirmed": True},
    )
    replayed = repositories.a2ui_interactions.submit(
        "a2ui-1",
        request_id="submit-1",
        submit_result={"confirmed": True},
    )

    assert submitted.status == A2UI_STATUS_SUBMITTED
    assert submitted.submit_request_id == "submit-1"
    assert submitted.submit_result == {"confirmed": True}
    assert submitted.resume_payload == {"confirmed": True}
    assert replayed == submitted
    assert repositories.a2ui_interactions.get_waiting_by_session("session-1") == []


def test_a2ui_interactions_repository_cancel_and_closed_conflict(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_interaction(repositories, interaction_id="a2ui-1")

    cancelled = repositories.a2ui_interactions.cancel(
        "a2ui-1",
        request_id="cancel-1",
        cancel_reason="user_cancelled",
        resume_payload={"cancelled": True},
    )

    assert cancelled.status == A2UI_STATUS_CANCELLED
    assert cancelled.cancel_request_id == "cancel-1"
    assert cancelled.cancel_reason == "user_cancelled"
    assert cancelled.resume_payload == {"cancelled": True}
    with pytest.raises(ValueError, match="已关闭"):
        repositories.a2ui_interactions.submit(
            "a2ui-1",
            request_id="submit-after-cancel",
            submit_result={"confirmed": True},
        )


def test_a2ui_interactions_repository_resume_status_updates(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_interaction(repositories, interaction_id="a2ui-1")

    started = repositories.a2ui_interactions.mark_resume_started(
        ["a2ui-1"],
        resume_payload={"confirmed": True},
    )[0]
    finished = repositories.a2ui_interactions.mark_resume_finished(
        ["a2ui-1"],
        resume_payload={"confirmed": True},
    )[0]

    assert started.resume_status == A2UI_RESUME_STATUS_STARTED
    assert started.resume_started_at is not None
    assert started.resume_payload == {"confirmed": True}
    assert finished.resume_status == A2UI_RESUME_STATUS_SUCCEEDED
    assert finished.resume_finished_at is not None


def test_a2ui_interactions_repository_updates_interrupt_id(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_interaction(repositories, interaction_id="a2ui-1")

    updated = repositories.a2ui_interactions.update_interrupt_id(
        "a2ui-1",
        "langgraph-interrupt-1",
    )

    assert updated.interrupt_id == "langgraph-interrupt-1"
    assert repositories.a2ui_interactions.get("a2ui-1").interrupt_id == (
        "langgraph-interrupt-1"
    )


def test_a2ui_interactions_repository_resume_group_peers_ignore_completed_sequential(
    tmp_path,
) -> None:
    repositories = _repositories(tmp_path)
    first = _create_interaction(
        repositories,
        interaction_id="a2ui-1",
        tool_call_id="tool-call-1",
        resume_group_id="group-1",
    )
    second = _create_interaction(
        repositories,
        interaction_id="a2ui-2",
        tool_call_id="tool-call-2",
        resume_group_id="group-1",
    )
    repositories.a2ui_interactions.submit(
        first.id,
        request_id="submit-1",
        submit_result={"confirmed": True},
    )
    repositories.a2ui_interactions.mark_resume_finished([first.id])

    peers = repositories.a2ui_interactions.list_resume_group_peers(
        resume_group_id="group-1",
        include_interaction_id=second.id,
    )

    assert [item.id for item in peers] == [second.id]


def _repositories(tmp_path) -> StorageRepositories:
    return StorageRepositories(init_database(tmp_path / "app.db"))


def _create_interaction(
    repositories: StorageRepositories,
    *,
    interaction_id: str,
    tool_call_id: str = "tool-call-1",
    resume_group_id: str = "group-1",
):
    return repositories.a2ui_interactions.create(
        interaction_id=interaction_id,
        session_id="session-1",
        trace_id="trace-1",
        active_session_id="session-1",
        turn_index=1,
        tool_call_id=tool_call_id,
        stream_id=f"stream-{interaction_id}",
        render_key="confirm",
        mode="interactive",
        payload={"title": "Confirm"},
        input_schema={"type": "object"},
        submit_schema_snapshot={"type": "object"},
        langgraph_thread_id="thread-1",
        checkpoint_ns="",
        checkpoint_id="checkpoint-1",
        interrupt_id=f"interrupt-{interaction_id}",
        resume_group_id=resume_group_id,
    )
