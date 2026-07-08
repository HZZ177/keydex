from __future__ import annotations

from backend.app.a2ui.event_payloads import (
    build_a2ui_created_payload,
    build_a2ui_stream_payload,
    build_cancel_ack_payload,
    build_submit_ack_payload,
    build_waiting_input_payload,
)
from backend.app.a2ui.schemas import A2UIInteractionState, A2UIObject, A2UIResumeSummary


def test_build_a2ui_stream_payload_contains_incremental_stream_metadata() -> None:
    payload = build_a2ui_stream_payload(
        status="chunk",
        render_key="confirm",
        stream_id="stream-1",
        tool_call_id="tool-call-1",
        stream_group_id="stream-group-1",
        chunk_index=2,
        args_delta='{"title"',
        args_text_length=8,
        json_parse_status="partial",
    )

    assert payload["render_key"] == "confirm"
    assert payload["stream_id"] == "stream-1"
    assert payload["stream_group_id"] == "stream-group-1"
    assert payload["tool_call_id"] == "tool-call-1"
    assert payload["stream"]["status"] == "chunk"
    assert payload["stream"]["chunk_index"] == 2
    assert payload["stream"]["args_delta"] == '{"title"'
    assert payload["stream"]["args_text_length"] == 8
    assert payload["stream"]["json_parse_status"] == "partial"


def test_build_a2ui_created_payload_flattens_key_ids_and_embeds_object() -> None:
    a2ui = _interactive_a2ui()

    payload = build_a2ui_created_payload(a2ui)

    assert payload["render_key"] == "confirm"
    assert payload["stream_id"] == "stream-1"
    assert payload["tool_call_id"] == "tool-call-1"
    assert payload["interaction_id"] == "a2ui-1"
    assert payload["interaction"]["status"] == "waiting_user_input"
    assert payload["a2ui"]["interaction"]["can_submit"] is True


def test_build_waiting_input_payload_contains_checkpoint_and_reason() -> None:
    payload = build_waiting_input_payload(
        a2ui=_interactive_a2ui(),
        checkpoint={
            "thread_id": "thread-1",
            "checkpoint_ns": "",
            "checkpoint_id": "checkpoint-1",
            "interrupt_id": "interrupt-1",
        },
    )

    assert payload["reason"] == "a2ui"
    assert payload["interaction_id"] == "a2ui-1"
    assert payload["checkpoint"]["checkpoint_id"] == "checkpoint-1"
    assert payload["a2ui"]["render_key"] == "confirm"


def test_ack_payloads_include_resume_summary() -> None:
    resume = A2UIResumeSummary(
        status="deferred",
        resume_group_id="group-1",
        pending_count=1,
    )

    submit_ack = build_submit_ack_payload(
        interaction_id="a2ui-1",
        request_id="submit-1",
        status="submitted",
        submit_result={"confirmed": True},
        resume=resume,
    )
    cancel_ack = build_cancel_ack_payload(
        interaction_id="a2ui-2",
        request_id="cancel-1",
        status="cancelled",
        cancel_reason="user_cancelled",
        resume=resume,
    )

    assert submit_ack["resume"]["status"] == "deferred"
    assert submit_ack["resume"]["pending_count"] == 1
    assert submit_ack["submit_result"] == {"confirmed": True}
    assert cancel_ack["cancel_reason"] == "user_cancelled"
    assert cancel_ack["resume"]["resume_group_id"] == "group-1"


def _interactive_a2ui() -> A2UIObject:
    return A2UIObject(
        render_key="confirm",
        mode="interactive",
        stream_id="stream-1",
        tool_call_id="tool-call-1",
        trace_id="trace-1",
        turn_index=1,
        payload={"title": "Confirm"},
        input_schema={"type": "object"},
        submit_schema={"type": "object"},
        interaction=A2UIInteractionState(
            interaction_id="a2ui-1",
            status="waiting_user_input",
            can_submit=True,
            resume_status="not_started",
            resume_group_id="group-1",
        ),
    )
