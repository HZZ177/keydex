from __future__ import annotations

import time
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

from langchain_core.messages import AIMessageChunk, ToolMessage

from backend.app.events import DomainEventType, EventDispatcher


@dataclass
class AgentEventResult:
    final_content: str = ""
    latest_llm_token_usage: dict[str, Any] = field(default_factory=dict)
    chain_token_usage: dict[str, Any] = field(
        default_factory=lambda: {
            "input_tokens": 0,
            "output_tokens": 0,
            "total_tokens": 0,
            "cache_read_tokens": 0,
            "llm_call_count": 0,
        }
    )


async def process_agent_events(
    event_stream: AsyncIterator[dict[str, Any]],
    *,
    dispatcher: EventDispatcher,
    cancellation: Any,
    session_id: str,
    trace_id: str,
    user_id: str,
    active_session_id: str,
    turn_index: int,
) -> AgentEventResult:
    result = AgentEventResult()
    tool_start_times: dict[str, float] = {}
    reasoning_parts_by_run_id: dict[str, list[str]] = {}

    try:
        async for event in event_stream:
            if cancellation.is_cancelled():
                await _close_event_stream(event_stream)
                break

            event_type = str(event.get("event") or "")
            data = event.get("data") or {}
            run_id = str(event.get("run_id") or "")
            name = str(event.get("name") or "")

            if event_type == "on_chat_model_stream":
                await _handle_chat_model_stream(
                    data=data,
                    run_id=run_id,
                    dispatcher=dispatcher,
                    session_id=session_id,
                    trace_id=trace_id,
                    user_id=user_id,
                    active_session_id=active_session_id,
                    turn_index=turn_index,
                    result=result,
                    reasoning_parts_by_run_id=reasoning_parts_by_run_id,
                )
                continue

            if event_type == "on_chat_model_end":
                _collect_usage(data.get("output"), result)
                output_text = _message_text(data.get("output"))
                if output_text and not result.final_content.endswith(output_text):
                    result.final_content += output_text
                    await dispatcher.emit_event(
                        event_type=DomainEventType.LLM_STREAM.value,
                        source="langchain_event_handler",
                        payload={
                            "content": output_text,
                            "session_id": session_id,
                            "trace_id": trace_id,
                            "is_subagent": False,
                        },
                        trace_id=trace_id,
                        user_id=user_id,
                        original_session_id=session_id,
                        active_session_id=active_session_id,
                        run_id=run_id,
                        turn_index=turn_index,
                    )
                elif output_text:
                    result.final_content = output_text
                await _flush_reasoning(
                    dispatcher=dispatcher,
                    run_id=run_id,
                    reasoning_parts_by_run_id=reasoning_parts_by_run_id,
                    session_id=session_id,
                    trace_id=trace_id,
                    user_id=user_id,
                    active_session_id=active_session_id,
                    turn_index=turn_index,
                )
                continue

            if event_type == "on_tool_start":
                tool_start_times[run_id] = time.perf_counter()
                await dispatcher.emit_event(
                    event_type=DomainEventType.LLM_TOOL_STARTED.value,
                    source="langchain_event_handler",
                    payload={
                        "tool": name,
                        "run_id": run_id,
                        "params": _make_json_serializable(data.get("input")),
                        "session_id": session_id,
                        "trace_id": trace_id,
                        "start_time": int(time.time() * 1000),
                        "status": "running",
                    },
                    trace_id=trace_id,
                    user_id=user_id,
                    original_session_id=session_id,
                    active_session_id=active_session_id,
                    run_id=run_id,
                    turn_index=turn_index,
                )
                continue

            if event_type == "on_tool_end":
                started_at = tool_start_times.pop(run_id, time.perf_counter())
                duration_ms = max(0, int((time.perf_counter() - started_at) * 1000))
                output = data.get("output")
                is_error = _tool_output_is_error(output)
                await dispatcher.emit_event(
                    event_type=(
                        DomainEventType.LLM_TOOL_FAILED.value
                        if is_error
                        else DomainEventType.LLM_TOOL_FINISHED.value
                    ),
                    source="langchain_event_handler",
                    payload={
                        "tool": name,
                        "run_id": run_id,
                        "result": _stringify_tool_output(output),
                        "duration_ms": duration_ms,
                        "session_id": session_id,
                        "trace_id": trace_id,
                        "end_time": int(time.time() * 1000),
                        "status": "failed" if is_error else "completed",
                        "error": _stringify_tool_output(output) if is_error else None,
                        "error_type": "ToolMessageError" if is_error else None,
                        "output_data": {"result": _stringify_tool_output(output)},
                    },
                    trace_id=trace_id,
                    user_id=user_id,
                    original_session_id=session_id,
                    active_session_id=active_session_id,
                    run_id=run_id,
                    turn_index=turn_index,
                )
                continue

            if event_type == "on_tool_error":
                started_at = tool_start_times.pop(run_id, time.perf_counter())
                duration_ms = max(0, int((time.perf_counter() - started_at) * 1000))
                error_text = str(data.get("error") or event.get("error") or "工具执行失败")
                await dispatcher.emit_event(
                    event_type=DomainEventType.LLM_TOOL_FAILED.value,
                    source="langchain_event_handler",
                    payload={
                        "tool": name,
                        "run_id": run_id,
                        "result": "",
                        "duration_ms": duration_ms,
                        "session_id": session_id,
                        "trace_id": trace_id,
                        "end_time": int(time.time() * 1000),
                        "status": "failed",
                        "error": error_text,
                        "error_type": "ToolError",
                        "output_data": {"result": ""},
                    },
                    trace_id=trace_id,
                    user_id=user_id,
                    original_session_id=session_id,
                    active_session_id=active_session_id,
                    run_id=run_id,
                    turn_index=turn_index,
                )
    finally:
        await dispatcher.flush()

    return result


async def _handle_chat_model_stream(
    *,
    data: dict[str, Any],
    run_id: str,
    dispatcher: EventDispatcher,
    session_id: str,
    trace_id: str,
    user_id: str,
    active_session_id: str,
    turn_index: int,
    result: AgentEventResult,
    reasoning_parts_by_run_id: dict[str, list[str]],
) -> None:
    chunk = data.get("chunk")
    text = _message_text(chunk)
    reasoning_text = _reasoning_text(chunk)

    if reasoning_text:
        reasoning_parts_by_run_id.setdefault(run_id, []).append(reasoning_text)
        await dispatcher.emit_event(
            event_type=DomainEventType.REASONING_STREAM.value,
            source="langchain_event_handler",
            payload={
                "kind": "reasoning",
                "text": reasoning_text,
                "content": reasoning_text,
                "done": False,
                "session_id": session_id,
                "trace_id": trace_id,
            },
            trace_id=trace_id,
            user_id=user_id,
            original_session_id=session_id,
            active_session_id=active_session_id,
            run_id=run_id,
            turn_index=turn_index,
        )

    if text:
        result.final_content += text
        await dispatcher.emit_event(
            event_type=DomainEventType.LLM_STREAM.value,
            source="langchain_event_handler",
            payload={
                "content": text,
                "session_id": session_id,
                "trace_id": trace_id,
                "is_subagent": False,
            },
            trace_id=trace_id,
            user_id=user_id,
            original_session_id=session_id,
            active_session_id=active_session_id,
            run_id=run_id,
            turn_index=turn_index,
        )


async def _flush_reasoning(
    *,
    dispatcher: EventDispatcher,
    run_id: str,
    reasoning_parts_by_run_id: dict[str, list[str]],
    session_id: str,
    trace_id: str,
    user_id: str,
    active_session_id: str,
    turn_index: int,
) -> None:
    parts = reasoning_parts_by_run_id.pop(run_id, [])
    if not parts:
        return
    text = "".join(parts)
    await dispatcher.emit_event(
        event_type=DomainEventType.REASONING_FINISHED.value,
        source="langchain_event_handler",
        payload={
            "kind": "reasoning",
            "text": text,
            "done": True,
            "session_id": session_id,
            "trace_id": trace_id,
            "end_time": int(time.time() * 1000),
        },
        trace_id=trace_id,
        user_id=user_id,
        original_session_id=session_id,
        active_session_id=active_session_id,
        run_id=run_id,
        turn_index=turn_index,
    )


def _message_text(message: Any) -> str:
    content = getattr(message, "content", None)
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict) and item.get("type") == "text":
                parts.append(str(item.get("text") or ""))
        return "".join(parts)
    return ""


def _reasoning_text(message: Any) -> str:
    if not isinstance(message, AIMessageChunk):
        return ""
    additional_kwargs = getattr(message, "additional_kwargs", {}) or {}
    for key in ("reasoning_content", "reasoning", "reasoning_text"):
        value = additional_kwargs.get(key)
        if isinstance(value, str) and value:
            return value
    return ""


def _collect_usage(output: Any, result: AgentEventResult) -> None:
    usage = getattr(output, "usage_metadata", None)
    if not usage:
        return
    normalized = {
        "input_tokens": _usage_get(usage, "input_tokens"),
        "output_tokens": _usage_get(usage, "output_tokens"),
        "total_tokens": _usage_get(usage, "total_tokens"),
        "cache_read_tokens": _cache_read_tokens(usage),
    }
    result.latest_llm_token_usage = normalized
    result.chain_token_usage["input_tokens"] += normalized["input_tokens"]
    result.chain_token_usage["output_tokens"] += normalized["output_tokens"]
    result.chain_token_usage["total_tokens"] += normalized["total_tokens"]
    result.chain_token_usage["cache_read_tokens"] += normalized["cache_read_tokens"]
    result.chain_token_usage["llm_call_count"] += 1


def _usage_get(usage: Any, key: str) -> int:
    if isinstance(usage, dict):
        return int(usage.get(key, 0) or 0)
    return int(getattr(usage, key, 0) or 0)


def _cache_read_tokens(usage: Any) -> int:
    details = usage.get("input_token_details") if isinstance(usage, dict) else getattr(
        usage,
        "input_token_details",
        None,
    )
    if isinstance(details, dict):
        return int(details.get("cache_read", 0) or 0)
    if details is not None:
        return int(getattr(details, "cache_read", 0) or 0)
    return 0


def _tool_output_is_error(output: Any) -> bool:
    return isinstance(output, ToolMessage) and getattr(output, "status", None) == "error"


def _stringify_tool_output(output: Any) -> str:
    if isinstance(output, ToolMessage):
        content = getattr(output, "content", "")
        return content if isinstance(content, str) else str(content)
    if isinstance(output, str):
        return output
    return str(_make_json_serializable(output))


def _make_json_serializable(obj: Any) -> Any:
    if obj is None or isinstance(obj, str | int | float | bool):
        return obj
    if isinstance(obj, dict):
        return {str(key): _make_json_serializable(value) for key, value in obj.items()}
    if isinstance(obj, list | tuple):
        return [_make_json_serializable(value) for value in obj]
    if hasattr(obj, "model_dump"):
        return _make_json_serializable(obj.model_dump())
    if hasattr(obj, "content"):
        return {"content": _make_json_serializable(getattr(obj, "content", ""))}
    return str(obj)


async def _close_event_stream(event_stream: AsyncIterator[dict[str, Any]]) -> None:
    close = getattr(event_stream, "aclose", None)
    if callable(close):
        await close()
