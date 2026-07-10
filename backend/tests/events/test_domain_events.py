from __future__ import annotations

import pytest

from backend.app.events import (
    CORE_EVENT_TYPES,
    ChatAction,
    ChatInboundAction,
    CompletedEventItemAction,
    DomainEvent,
    DomainEventType,
    ReplayAction,
    ensure_known_event_type,
)


def test_domain_event_serializes_and_round_trips() -> None:
    event = DomainEvent(
        event_type=DomainEventType.LLM_STREAM.value,
        source="event_handler",
        payload={"content": "hello"},
        trace_id="trace_1",
        user_id="local-user",
        original_session_id="ses_1",
        active_session_id="ses_1",
        run_id="run_1",
        turn_index=1,
        timestamp_ms=123,
        tags={"agent": "main"},
    )

    restored = DomainEvent.from_dict(event.to_dict())

    assert restored == event


def test_domain_event_requires_core_fields() -> None:
    with pytest.raises(ValueError, match="event_type"):
        DomainEvent(event_type="", source="chat_service", payload={})

    with pytest.raises(ValueError, match="source"):
        DomainEvent(event_type=DomainEventType.TURN_STARTED.value, source="", payload={})


def test_event_enums_cover_core_contract_and_include_a2ui() -> None:
    required_domain_events = {
        DomainEventType.MESSAGE_USER_CREATED,
        DomainEventType.LLM_STREAM,
        DomainEventType.LLM_TOOL_STARTED,
        DomainEventType.LLM_TOOL_PROGRESS,
        DomainEventType.LLM_TOOL_FINISHED,
        DomainEventType.LLM_TOOL_FAILED,
        DomainEventType.TURN_STARTED,
        DomainEventType.TURN_WAITING_INPUT,
        DomainEventType.TURN_COMPLETED,
        DomainEventType.TURN_CANCELLED,
        DomainEventType.TURN_FAILED,
        DomainEventType.REASONING_STREAM,
        DomainEventType.REASONING_FINISHED,
        DomainEventType.A2UI_STREAM_STARTED,
        DomainEventType.A2UI_STREAM_CHUNK,
        DomainEventType.A2UI_STREAM_FINISHED,
        DomainEventType.A2UI_CREATED,
        DomainEventType.A2UI_SUBMITTED,
        DomainEventType.A2UI_CANCELLED,
        DomainEventType.A2UI_RESUME_DEFERRED,
        DomainEventType.A2UI_RESUME_STARTED,
        DomainEventType.A2UI_RESUME_SUCCEEDED,
        DomainEventType.A2UI_RESUME_FAILED,
        DomainEventType.PENDING_INPUT_SUBMITTED,
        DomainEventType.PENDING_INPUT_UPDATED,
        DomainEventType.PENDING_INPUT_CANCELLED,
        DomainEventType.PENDING_INPUT_DELIVERED,
        DomainEventType.PENDING_INPUT_CONVERTED,
        DomainEventType.PENDING_INPUT_PAUSED,
        DomainEventType.PENDING_INPUT_RESUMED,
        DomainEventType.PENDING_INPUT_FAILED,
    }

    assert required_domain_events.issubset(CORE_EVENT_TYPES)
    assert ensure_known_event_type("a2ui.created") is DomainEventType.A2UI_CREATED
    assert (
        ensure_known_event_type("pending_input.submitted")
        is DomainEventType.PENDING_INPUT_SUBMITTED
    )


def test_external_action_enums_match_source_contract() -> None:
    assert ChatAction.STREAM.value == "stream"
    assert ChatAction.TOOL_START.value == "tool_start"
    assert ChatAction.TOOL_PROGRESS.value == "tool_progress"
    assert ChatAction.TOOL_END.value == "tool_end"
    assert ChatAction.TASK_UPDATED.value == "task_updated"
    assert ChatAction.TASK_RUN_FINISHED.value == "task_run_finished"
    assert ChatAction.REASONING.value == "reasoning"
    assert ChatAction.MIDDLEWARE_PROGRESS.value == "middleware_progress"
    assert ChatAction.A2UI_STREAM_START.value == "a2ui_stream_start"
    assert ChatAction.A2UI_CREATED.value == "a2ui_created"
    assert ChatAction.WAITING_INPUT.value == "waiting_input"
    assert ChatAction.A2UI_SUBMIT_ACK.value == "a2ui_submit_ack"
    assert ChatAction.PENDING_INPUT_SUBMITTED.value == "pending_input_submitted"
    assert ChatAction.PENDING_INPUTS_REORDERED.value == "pending_inputs_reordered"
    assert ChatAction.PENDING_INPUT_DELIVERED.value == "pending_input_delivered"
    assert ChatAction.PENDING_INPUT_PAUSED.value == "pending_input_paused"
    assert ChatAction.PENDING_INPUT_RESUMED.value == "pending_input_resumed"
    assert ReplayAction.STREAM_BATCH.value == "stream_batch"
    assert ReplayAction.MEMORY_RECALLED.value == "memory_recalled"
    assert ReplayAction.TASK_DELETED.value == "task_deleted"
    assert ReplayAction.MIDDLEWARE_PROGRESS.value == "middleware_progress"
    assert ReplayAction.A2UI_CREATED.value == "a2ui_created"
    assert ReplayAction.WAITING_INPUT.value == "waiting_input"
    assert ReplayAction.PENDING_INPUT_UPDATED.value == "pending_input_updated"
    assert ReplayAction.PENDING_INPUTS_REORDERED.value == "pending_inputs_reordered"
    assert ReplayAction.PENDING_INPUT_FAILED.value == "pending_input_failed"
    assert ReplayAction.PENDING_INPUT_PAUSED.value == "pending_input_paused"
    assert ReplayAction.PENDING_INPUT_RESUMED.value == "pending_input_resumed"
    assert CompletedEventItemAction.REASONING_MESSAGE.value == "reasoning_message"
    assert ChatInboundAction.CREATE_SESSION.value == "create_session"
    assert ChatInboundAction.SCHEDULED_CHAT.value == "scheduled_chat"
    assert ChatInboundAction.A2UI_SUBMIT.value == "a2ui_submit"
    assert ChatInboundAction.A2UI_CANCEL.value == "a2ui_cancel"
    assert ChatInboundAction.PENDING_INPUT_UPDATE.value == "pending_input_update"
    assert ChatInboundAction.PENDING_INPUT_REORDER.value == "pending_input_reorder"
    assert ChatInboundAction.PENDING_INPUT_CANCEL.value == "pending_input_cancel"
    assert ChatInboundAction.PENDING_INPUT_RESUME.value == "pending_input_resume"


def test_unknown_event_type_is_rejected_explicitly() -> None:
    assert ensure_known_event_type("turn.completed") is DomainEventType.TURN_COMPLETED

    with pytest.raises(ValueError, match="未知 DomainEventType"):
        ensure_known_event_type("not.real")
