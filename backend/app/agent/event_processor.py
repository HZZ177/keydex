from __future__ import annotations

import json
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

from langchain_core.messages import AIMessageChunk, ToolMessage

from backend.app.agent.factory import (
    get_llm_gateway_trace_id,
    pop_llm_gateway_trace_id,
)
from backend.app.core.ids import new_id
from backend.app.core.logger import logger
from backend.app.events import DomainEventType, EventDispatcher
from backend.app.storage import LLMRequestLogRecord
from backend.app.storage.repositories import LLMRequestLogsRepository


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
    model: str = "",
    llm_request_logs: LLMRequestLogsRepository | None = None,
) -> AgentEventResult:
    result = AgentEventResult()
    tool_start_times: dict[str, float] = {}
    llm_start_times: dict[str, float] = {}
    llm_request_ids: dict[str, str] = {}
    reasoning_parts_by_run_id: dict[str, list[str]] = {}
    stream_chunk_count = 0
    reasoning_chunk_count = 0
    tool_call_count = 0

    try:
        async for event in event_stream:
            if cancellation.is_cancelled():
                logger.info(
                    f"[AgentEvents] 检测到取消信号，关闭事件流 | session_id={session_id} | "
                    f"turn_index={turn_index} | trace_id={trace_id}"
                )
                await _close_event_stream(event_stream)
                break

            event_type = str(event.get("event") or "")
            data = event.get("data") or {}
            metadata = event.get("metadata") if isinstance(event.get("metadata"), dict) else {}
            run_id = str(event.get("run_id") or "")
            name = str(event.get("name") or "")

            if event_type == "on_chat_model_start":
                request_log = _start_llm_request_log(
                    llm_request_logs=llm_request_logs,
                    run_id=run_id,
                    gateway_trace_id=get_llm_gateway_trace_id(run_id),
                    gateway_thread_id=trace_id,
                    name=name,
                    data=data,
                    metadata=metadata,
                    session_id=session_id,
                    trace_id=trace_id,
                    user_id=user_id,
                    active_session_id=active_session_id,
                    turn_index=turn_index,
                    model=model,
                )
                if request_log is not None:
                    llm_request_ids[run_id] = request_log.id
                    llm_start_times[run_id] = time.perf_counter()
                continue

            if event_type == "on_chat_model_stream":
                chunk = data.get("chunk")
                if _message_text(chunk):
                    stream_chunk_count += 1
                if _reasoning_text(chunk):
                    reasoning_chunk_count += 1
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
                _finish_llm_request_log(
                    llm_request_logs=llm_request_logs,
                    llm_request_ids=llm_request_ids,
                    llm_start_times=llm_start_times,
                    run_id=run_id,
                    data=data,
                    usage=result.latest_llm_token_usage,
                )
                if result.latest_llm_token_usage:
                    logger.info(
                        f"[AgentEvents] LLM 调用完成 | session_id={session_id} | "
                        f"turn_index={turn_index} | trace_id={trace_id} | run_id={run_id} | "
                        f"input_tokens={result.latest_llm_token_usage.get('input_tokens', 0)} | "
                        f"output_tokens={result.latest_llm_token_usage.get('output_tokens', 0)}"
                    )
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

            if event_type == "on_chat_model_error":
                _fail_llm_request_log(
                    llm_request_logs=llm_request_logs,
                    llm_request_ids=llm_request_ids,
                    llm_start_times=llm_start_times,
                    run_id=run_id,
                    data=data,
                    event=event,
                )
                continue

            if event_type == "on_tool_start":
                tool_start_times[run_id] = time.perf_counter()
                tool_call_count += 1
                logger.info(
                    f"[AgentEvents] 工具开始 | session_id={session_id} | "
                    f"turn_index={turn_index} | trace_id={trace_id} | "
                    f"tool={name} | run_id={run_id}"
                )
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
                if is_error:
                    logger.warning(
                        f"[AgentEvents] 工具返回错误 | session_id={session_id} | "
                        f"turn_index={turn_index} | trace_id={trace_id} | tool={name} | "
                        f"run_id={run_id} | duration_ms={duration_ms}"
                    )
                else:
                    logger.info(
                        f"[AgentEvents] 工具完成 | session_id={session_id} | "
                        f"turn_index={turn_index} | trace_id={trace_id} | tool={name} | "
                        f"run_id={run_id} | duration_ms={duration_ms}"
                    )
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
                logger.warning(
                    f"[AgentEvents] 工具异常 | session_id={session_id} | "
                    f"turn_index={turn_index} | trace_id={trace_id} | tool={name} | "
                    f"run_id={run_id} | duration_ms={duration_ms} | error={error_text}"
                )
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
        logger.info(
            f"[AgentEvents] 事件流汇总 | session_id={session_id} | turn_index={turn_index} | "
            f"trace_id={trace_id} | stream_chunks={stream_chunk_count} | "
            f"reasoning_chunks={reasoning_chunk_count} | tool_calls={tool_call_count} | "
            f"llm_calls={result.chain_token_usage.get('llm_call_count', 0)}"
        )

    return result


def _start_llm_request_log(
    *,
    llm_request_logs: LLMRequestLogsRepository | None,
    run_id: str,
    gateway_trace_id: str | None,
    gateway_thread_id: str,
    name: str,
    data: dict[str, Any],
    metadata: dict[str, Any],
    session_id: str,
    trace_id: str,
    user_id: str,
    active_session_id: str,
    turn_index: int,
    model: str,
) -> LLMRequestLogRecord | None:
    if llm_request_logs is None:
        return None
    request_id = run_id or new_id()
    resolved_model = (
        _metadata_text(metadata, "ls_model_name")
        or _metadata_text(metadata, "model")
        or model
    )
    if not resolved_model:
        resolved_model = "unknown"
    return llm_request_logs.start(
        request_id=request_id,
        trace_id=trace_id,
        trace_record_id=trace_id,
        session_id=session_id,
        active_session_id=active_session_id,
        gateway_thread_id=gateway_thread_id,
        gateway_trace_id=gateway_trace_id,
        turn_index=turn_index,
        provider_name=_metadata_text(metadata, "ls_provider") or name or None,
        model=resolved_model,
        request_preview=_preview_value(data.get("input")),
        metadata={
            "run_id": run_id,
            "event_name": name,
            "user_id": user_id,
            "langchain_metadata": metadata,
        },
    )


def _finish_llm_request_log(
    *,
    llm_request_logs: LLMRequestLogsRepository | None,
    llm_request_ids: dict[str, str],
    llm_start_times: dict[str, float],
    run_id: str,
    data: dict[str, Any],
    usage: dict[str, Any],
) -> None:
    gateway_trace_id = pop_llm_gateway_trace_id(run_id)
    if llm_request_logs is None:
        return
    request_id = llm_request_ids.pop(run_id, "")
    if not request_id:
        return
    started_at = llm_start_times.pop(run_id, time.perf_counter())
    duration_ms = max(0, int((time.perf_counter() - started_at) * 1000))
    output = data.get("output")
    llm_request_logs.finish(
        request_id,
        input_tokens=int(usage.get("input_tokens") or usage.get("prompt_tokens") or 0),
        cache_read_tokens=int(usage.get("cache_read_tokens") or 0),
        output_tokens=int(usage.get("output_tokens") or usage.get("completion_tokens") or 0),
        total_tokens=int(usage.get("total_tokens") or 0) or None,
        response_preview=_message_text(output) or _preview_value(output),
        duration_ms=duration_ms,
        gateway_thread_id=None,
        gateway_trace_id=gateway_trace_id,
    )


def _fail_llm_request_log(
    *,
    llm_request_logs: LLMRequestLogsRepository | None,
    llm_request_ids: dict[str, str],
    llm_start_times: dict[str, float],
    run_id: str,
    data: dict[str, Any],
    event: dict[str, Any],
) -> None:
    gateway_trace_id = pop_llm_gateway_trace_id(run_id)
    if llm_request_logs is None:
        return
    request_id = llm_request_ids.pop(run_id, "")
    if not request_id:
        return
    started_at = llm_start_times.pop(run_id, time.perf_counter())
    duration_ms = max(0, int((time.perf_counter() - started_at) * 1000))
    error_text = str(data.get("error") or event.get("error") or "模型请求失败")
    llm_request_logs.fail(
        request_id,
        error_message=error_text,
        response_preview=_preview_value(data.get("output")),
        duration_ms=duration_ms,
        gateway_thread_id=None,
        gateway_trace_id=gateway_trace_id,
    )


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


def _metadata_text(metadata: dict[str, Any], key: str) -> str:
    value = metadata.get(key)
    return value if isinstance(value, str) else ""


def _preview_value(value: Any, limit: int = 1000) -> str:
    if value is None:
        return ""
    text = str(_make_json_serializable(value))
    return text if len(text) <= limit else f"{text[:limit]}..."


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
    if isinstance(output, ToolMessage):
        if getattr(output, "status", None) == "error":
            return True
        return _serialized_tool_output_is_error(getattr(output, "content", ""))
    return _serialized_tool_output_is_error(output)


def _serialized_tool_output_is_error(output: Any) -> bool:
    if isinstance(output, dict):
        return _tool_error_payload(output)
    if not isinstance(output, str):
        return False
    try:
        parsed = json.loads(output)
    except json.JSONDecodeError:
        return False
    return isinstance(parsed, dict) and _tool_error_payload(parsed)


def _tool_error_payload(payload: dict[str, Any]) -> bool:
    code = payload.get("code")
    message = payload.get("message")
    return isinstance(code, str) and bool(code.strip()) and isinstance(message, str)


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
