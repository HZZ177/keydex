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


def test_event_enums_cover_core_contract_and_exclude_a2ui() -> None:
    required_domain_events = {
        DomainEventType.MESSAGE_USER_CREATED,
        DomainEventType.LLM_STREAM,
        DomainEventType.LLM_TOOL_STARTED,
        DomainEventType.LLM_TOOL_PROGRESS,
        DomainEventType.LLM_TOOL_FINISHED,
        DomainEventType.LLM_TOOL_FAILED,
        DomainEventType.TURN_STARTED,
        DomainEventType.TURN_COMPLETED,
        DomainEventType.TURN_CANCELLED,
        DomainEventType.TURN_FAILED,
        DomainEventType.REASONING_STREAM,
        DomainEventType.REASONING_FINISHED,
    }

    assert required_domain_events.issubset(CORE_EVENT_TYPES)
    assert not any(event.value.startswith("a2ui.") for event in DomainEventType)


def test_external_action_enums_match_source_contract() -> None:
    assert ChatAction.STREAM.value == "stream"
    assert ChatAction.TOOL_START.value == "tool_start"
    assert ChatAction.TOOL_PROGRESS.value == "tool_progress"
    assert ChatAction.TOOL_END.value == "tool_end"
    assert ChatAction.TASK_UPDATED.value == "task_updated"
    assert ChatAction.TASK_RUN_FINISHED.value == "task_run_finished"
    assert ChatAction.REASONING.value == "reasoning"
    assert ChatAction.MIDDLEWARE_PROGRESS.value == "middleware_progress"
    assert ReplayAction.STREAM_BATCH.value == "stream_batch"
    assert ReplayAction.MEMORY_RECALLED.value == "memory_recalled"
    assert ReplayAction.TASK_DELETED.value == "task_deleted"
    assert ReplayAction.MIDDLEWARE_PROGRESS.value == "middleware_progress"
    assert CompletedEventItemAction.REASONING_MESSAGE.value == "reasoning_message"
    assert ChatInboundAction.CREATE_SESSION.value == "create_session"
    assert ChatInboundAction.SCHEDULED_CHAT.value == "scheduled_chat"


def test_unknown_event_type_is_rejected_explicitly() -> None:
    assert ensure_known_event_type("turn.completed") is DomainEventType.TURN_COMPLETED

    with pytest.raises(ValueError, match="未知 DomainEventType"):
        ensure_known_event_type("not.real")
