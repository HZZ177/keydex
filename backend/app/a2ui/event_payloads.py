from __future__ import annotations

from typing import Any, Literal

from backend.app.a2ui.schemas import A2UIObject, A2UIResumeSummary

StreamStatus = Literal["start", "chunk", "finish"]


def build_a2ui_stream_payload(
    *,
    status: StreamStatus,
    render_key: str,
    stream_id: str,
    tool_call_id: str | None,
    stream_group_id: str | None = None,
    chunk_index: int,
    args_delta: str = "",
    args_text_length: int = 0,
    args_text: str | None = None,
    parsed_payload: dict[str, Any] | None = None,
    json_parse_status: str | None = None,
    finish_reason: str | None = None,
) -> dict[str, Any]:
    stream = {
        "status": status,
        "chunk_index": chunk_index,
        "args_delta": args_delta,
        "args_text_length": args_text_length,
    }
    if args_text is not None:
        stream["args_text"] = args_text
    if parsed_payload is not None:
        stream["parsed_payload"] = parsed_payload
    if json_parse_status is not None:
        stream["json_parse_status"] = json_parse_status
    if finish_reason is not None:
        stream["finish_reason"] = finish_reason
    return {
        "render_key": render_key,
        "stream_id": stream_id,
        **({"stream_group_id": stream_group_id} if stream_group_id else {}),
        "tool_call_id": tool_call_id,
        "stream": stream,
    }


def build_a2ui_created_payload(a2ui: A2UIObject) -> dict[str, Any]:
    payload = {
        "render_key": a2ui.render_key,
        "mode": a2ui.mode,
        "stream_id": a2ui.stream_id,
        "tool_call_id": a2ui.tool_call_id,
        "trace_id": a2ui.trace_id,
        "turn_index": a2ui.turn_index,
        "a2ui": a2ui.model_dump(mode="json"),
    }
    if a2ui.interaction is not None:
        payload["interaction_id"] = a2ui.interaction.interaction_id
        payload["interaction"] = a2ui.interaction.model_dump(mode="json")
    return payload


def build_waiting_input_payload(
    *,
    a2ui: A2UIObject,
    reason: str = "a2ui",
    checkpoint: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if a2ui.interaction is None:
        raise ValueError("waiting_input requires interactive A2UI interaction")
    return {
        "reason": reason,
        "interaction_id": a2ui.interaction.interaction_id,
        "render_key": a2ui.render_key,
        "stream_id": a2ui.stream_id,
        "tool_call_id": a2ui.tool_call_id,
        "a2ui": a2ui.model_dump(mode="json"),
        "checkpoint": checkpoint or {},
    }


def build_submit_ack_payload(
    *,
    interaction_id: str,
    request_id: str,
    status: str,
    submit_result: dict[str, Any],
    resume: A2UIResumeSummary,
) -> dict[str, Any]:
    return {
        "interaction_id": interaction_id,
        "request_id": request_id,
        "status": status,
        "submit_result": submit_result,
        "resume": resume.model_dump(mode="json"),
    }


def build_cancel_ack_payload(
    *,
    interaction_id: str,
    request_id: str,
    status: str,
    cancel_reason: str | None,
    resume: A2UIResumeSummary,
) -> dict[str, Any]:
    return {
        "interaction_id": interaction_id,
        "request_id": request_id,
        "status": status,
        "cancel_reason": cancel_reason,
        "resume": resume.model_dump(mode="json"),
    }
