from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

from langchain_core.messages import AIMessageChunk, ToolMessage
from langgraph.errors import GraphInterrupt
from langgraph.types import Command

from backend.app.a2ui.stream_bridge import (
    A2UIStreamBridge,
    a2ui_stream_event_type,
    is_a2ui_stream_payload,
    strip_a2ui_stream_marker,
)
from backend.app.agent.internal_llm_events import is_internal_context_compression_event
from backend.app.agent.tool_call_progress import (
    ToolCallChunkPipeline,
    default_collectors,
    finalize_file_change,
)
from backend.app.core.logger import logger
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
    reasoning_started_at_by_run_id: dict[str, int] = {}
    first_token_received_at_ms: int | None = None
    a2ui_stream_bridge = A2UIStreamBridge(trace_id=trace_id)
    tool_chunk_pipeline = ToolCallChunkPipeline(
        collectors=[*default_collectors(), *a2ui_stream_bridge.collectors]
    )
    stream_chunk_count = 0
    reasoning_chunk_count = 0
    tool_progress_count = 0
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
            run_id = str(event.get("run_id") or "")
            name = str(event.get("name") or "")

            if is_internal_context_compression_event(event):
                continue

            if event_type == "on_chat_model_start":
                continue

            if event_type == "on_chat_model_stream":
                chunk = data.get("chunk")
                if first_token_received_at_ms is None and _has_llm_output_token(chunk):
                    first_token_received_at_ms = int(time.time() * 1000)
                    await dispatcher.emit_event(
                        event_type=DomainEventType.LLM_FIRST_TOKEN_RECEIVED.value,
                        source="langchain_event_handler",
                        payload={
                            "session_id": session_id,
                            "trace_id": trace_id,
                            "first_token_at_ms": first_token_received_at_ms,
                        },
                        trace_id=trace_id,
                        user_id=user_id,
                        original_session_id=session_id,
                        active_session_id=active_session_id,
                        run_id=run_id,
                        turn_index=turn_index,
                    )
                if _message_text(chunk):
                    stream_chunk_count += 1
                if _reasoning_text(chunk):
                    reasoning_chunk_count += 1
                tool_progress_count += await _handle_chat_model_stream(
                    data=data,
                    run_id=run_id,
                    tool_chunk_pipeline=tool_chunk_pipeline,
                    dispatcher=dispatcher,
                    session_id=session_id,
                    trace_id=trace_id,
                    user_id=user_id,
                    active_session_id=active_session_id,
                    turn_index=turn_index,
                    result=result,
                    reasoning_parts_by_run_id=reasoning_parts_by_run_id,
                    reasoning_started_at_by_run_id=reasoning_started_at_by_run_id,
                )
                continue

            if event_type == "on_chat_model_end":
                output = data.get("output")
                invalid_tool_calls = _message_invalid_tool_calls(output)
                if invalid_tool_calls:
                    await _discard_a2ui_streams(
                        bridge=a2ui_stream_bridge,
                        dispatcher=dispatcher,
                        finish_reason="invalid_tool_call",
                        session_id=session_id,
                        trace_id=trace_id,
                        user_id=user_id,
                        active_session_id=active_session_id,
                        run_id=run_id,
                        turn_index=turn_index,
                    )
                else:
                    await _finish_a2ui_streams_for_model_end(
                        bridge=a2ui_stream_bridge,
                        dispatcher=dispatcher,
                        session_id=session_id,
                        trace_id=trace_id,
                        user_id=user_id,
                        active_session_id=active_session_id,
                        run_id=run_id,
                        turn_index=turn_index,
                    )
                _collect_usage(data.get("output"), result)
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
                    reasoning_started_at_by_run_id=reasoning_started_at_by_run_id,
                    session_id=session_id,
                    trace_id=trace_id,
                    user_id=user_id,
                    active_session_id=active_session_id,
                    turn_index=turn_index,
                )
                continue

            if event_type == "on_chat_model_error":
                continue

            if event_type == "on_tool_start":
                tool_start_times[run_id] = time.perf_counter()
                tool_call_count += 1
                mcp_metadata = _mcp_metadata_from_event(event=event, data=data)
                tool_call_id = tool_chunk_pipeline.bind_tool_run(
                    run_id=run_id,
                    tool_name=name,
                    params=_make_json_serializable(data.get("input")),
                )
                await _finish_a2ui_stream_for_tool_start(
                    bridge=a2ui_stream_bridge,
                    dispatcher=dispatcher,
                    tool_call_id=tool_call_id,
                    run_id=run_id,
                    session_id=session_id,
                    trace_id=trace_id,
                    user_id=user_id,
                    active_session_id=active_session_id,
                    turn_index=turn_index,
                )
                logger.info(
                    f"[AgentEvents] 工具开始 | session_id={session_id} | "
                    f"turn_index={turn_index} | trace_id={trace_id} | "
                    f"tool={name} | run_id={run_id}"
                )
                if a2ui_stream_bridge.registry.is_a2ui_tool(name):
                    continue
                await dispatcher.emit_event(
                    event_type=DomainEventType.LLM_TOOL_STARTED.value,
                    source="langchain_event_handler",
                    payload={
                        "tool": name,
                        "run_id": run_id,
                        **({"tool_call_id": tool_call_id} if tool_call_id else {}),
                        "params": _make_json_serializable(data.get("input")),
                        "session_id": session_id,
                        "trace_id": trace_id,
                        "start_time": int(time.time() * 1000),
                        "status": "running",
                        **_mcp_event_fields(mcp_metadata),
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
                resolved_tool_name = name or _tool_name_from_output(output)
                if a2ui_stream_bridge.registry.is_a2ui_tool(resolved_tool_name):
                    if _tool_output_is_error(output):
                        tool_call_id = (
                            tool_chunk_pipeline.tool_call_id_for_run(run_id)
                            or _tool_call_id_from_output(output)
                        )
                        error_text = _stringify_tool_output(output)
                        logger.warning(
                            f"[AgentEvents] A2UI 工具返回错误 | session_id={session_id} | "
                            f"turn_index={turn_index} | trace_id={trace_id} | tool={resolved_tool_name} | "
                            f"run_id={run_id} | duration_ms={duration_ms} | error={error_text}"
                        )
                        await _fail_a2ui_stream_for_tool_error(
                            bridge=a2ui_stream_bridge,
                            dispatcher=dispatcher,
                            tool_call_id=tool_call_id,
                            run_id=run_id,
                            error=error_text,
                            session_id=session_id,
                            trace_id=trace_id,
                            user_id=user_id,
                            active_session_id=active_session_id,
                            turn_index=turn_index,
                        )
                    continue
                output = data.get("output")
                is_error = _tool_output_is_error(output)
                result_text = _stringify_tool_output(output)
                structured_output = _structured_tool_output(output)
                mcp_metadata = _mcp_metadata_from_event(
                    event=event,
                    data=data,
                    output=output,
                    structured_output=structured_output,
                )
                ui_payload = structured_output if isinstance(structured_output, dict) else None
                files = _tool_files_from_structured_output(structured_output)
                tool_call_id = tool_chunk_pipeline.tool_call_id_for_run(
                    run_id
                ) or _tool_call_id_from_output(output)
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
                        **({"tool_call_id": tool_call_id} if tool_call_id else {}),
                        "result": result_text,
                        "duration_ms": duration_ms,
                        "session_id": session_id,
                        "trace_id": trace_id,
                        "end_time": int(time.time() * 1000),
                        "status": "failed" if is_error else "completed",
                        "error": result_text if is_error else None,
                        "error_type": "ToolMessageError" if is_error else None,
                        "output_data": {
                            "result": structured_output
                            if structured_output is not None
                            else result_text
                        },
                        "ui_payload": ui_payload,
                        "files": files,
                        **_mcp_event_fields(mcp_metadata),
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
                if a2ui_stream_bridge.registry.is_a2ui_tool(name):
                    logger.warning(
                        f"[AgentEvents] A2UI 工具异常 | session_id={session_id} | "
                        f"turn_index={turn_index} | trace_id={trace_id} | tool={name} | "
                        f"run_id={run_id} | duration_ms={duration_ms} | error={error_text}"
                    )
                    tool_call_id = tool_chunk_pipeline.tool_call_id_for_run(run_id)
                    await _fail_a2ui_stream_for_tool_error(
                        bridge=a2ui_stream_bridge,
                        dispatcher=dispatcher,
                        tool_call_id=tool_call_id,
                        run_id=run_id,
                        error=error_text,
                        session_id=session_id,
                        trace_id=trace_id,
                        user_id=user_id,
                        active_session_id=active_session_id,
                        turn_index=turn_index,
                    )
                    continue
                mcp_metadata = _mcp_metadata_from_event(event=event, data=data)
                tool_call_id = tool_chunk_pipeline.tool_call_id_for_run(run_id)
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
                        **({"tool_call_id": tool_call_id} if tool_call_id else {}),
                        "result": "",
                        "duration_ms": duration_ms,
                        "session_id": session_id,
                        "trace_id": trace_id,
                        "end_time": int(time.time() * 1000),
                        "status": "failed",
                        "error": error_text,
                        "error_type": "ToolError",
                        "output_data": {"result": ""},
                        **_mcp_event_fields(mcp_metadata),
                    },
                    trace_id=trace_id,
                    user_id=user_id,
                    original_session_id=session_id,
                    active_session_id=active_session_id,
                    run_id=run_id,
                    turn_index=turn_index,
                )
    except asyncio.CancelledError:
        if not cancellation.is_cancelled():
            raise
        logger.info(
            f"[AgentEvents] 事件流被用户取消中断，保留已收集输出 | session_id={session_id} | "
            f"turn_index={turn_index} | trace_id={trace_id} | "
            f"partial_content_len={len(result.final_content)}"
        )
        await _discard_a2ui_streams(
            bridge=a2ui_stream_bridge,
            dispatcher=dispatcher,
            finish_reason="turn_cancelled",
            session_id=session_id,
            trace_id=trace_id,
            user_id=user_id,
            active_session_id=active_session_id,
            run_id="",
            turn_index=turn_index,
        )
        await _close_event_stream(event_stream)
    except GraphInterrupt as exc:
        if not _is_a2ui_graph_interrupt(exc):
            raise
        await _discard_a2ui_streams(
            bridge=a2ui_stream_bridge,
            dispatcher=dispatcher,
            finish_reason="a2ui_waiting_input",
            session_id=session_id,
            trace_id=trace_id,
            user_id=user_id,
            active_session_id=active_session_id,
            run_id="",
            turn_index=turn_index,
        )
        logger.info(
            f"[AgentEvents] A2UI 等待用户输入，中止本轮事件处理 | session_id={session_id} | "
            f"turn_index={turn_index} | trace_id={trace_id}"
        )
    finally:
        await dispatcher.flush()
        logger.info(
            f"[AgentEvents] 事件流汇总 | session_id={session_id} | turn_index={turn_index} | "
            f"trace_id={trace_id} | stream_chunks={stream_chunk_count} | "
            f"reasoning_chunks={reasoning_chunk_count} | tool_progress={tool_progress_count} | "
            f"tool_calls={tool_call_count} | "
            f"llm_calls={result.chain_token_usage.get('llm_call_count', 0)}"
        )

    return result


async def _handle_chat_model_stream(
    *,
    data: dict[str, Any],
    run_id: str,
    tool_chunk_pipeline: ToolCallChunkPipeline,
    dispatcher: EventDispatcher,
    session_id: str,
    trace_id: str,
    user_id: str,
    active_session_id: str,
    turn_index: int,
    result: AgentEventResult,
    reasoning_parts_by_run_id: dict[str, list[str]],
    reasoning_started_at_by_run_id: dict[str, int],
) -> int:
    chunk = data.get("chunk")
    text = _message_text(chunk)
    reasoning_text = _reasoning_text(chunk)
    tool_progress_payloads = tool_chunk_pipeline.process_chunk(chunk, model_run_id=run_id)
    emitted_tool_progress = 0

    for payload in tool_progress_payloads:
        if is_a2ui_stream_payload(payload):
            await _emit_a2ui_stream_payload(
                dispatcher=dispatcher,
                payload=payload,
                session_id=session_id,
                trace_id=trace_id,
                user_id=user_id,
                active_session_id=active_session_id,
                run_id=run_id,
                turn_index=turn_index,
            )
            emitted_tool_progress += 1
            continue
        payload = {
            **payload,
            "session_id": session_id,
            "trace_id": trace_id,
        }
        await dispatcher.emit_event(
            event_type=DomainEventType.LLM_TOOL_PROGRESS.value,
            source="langchain_event_handler",
            payload=payload,
            trace_id=trace_id,
            user_id=user_id,
            original_session_id=session_id,
            active_session_id=active_session_id,
            run_id=str(payload.get("run_id") or run_id),
            turn_index=turn_index,
        )
        emitted_tool_progress += 1

    if reasoning_text:
        reasoning_started_at_by_run_id.setdefault(run_id, int(time.time() * 1000))
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

    return emitted_tool_progress


async def _emit_a2ui_stream_payload(
    *,
    dispatcher: EventDispatcher,
    payload: dict[str, Any],
    session_id: str,
    trace_id: str,
    user_id: str,
    active_session_id: str,
    run_id: str,
    turn_index: int,
) -> None:
    event_type = a2ui_stream_event_type(payload)
    if not event_type:
        return
    clean_payload = {
        **strip_a2ui_stream_marker(payload),
        "session_id": session_id,
        "trace_id": trace_id,
    }
    await dispatcher.emit_event(
        event_type=event_type,
        source="langchain_event_handler",
        payload=clean_payload,
        trace_id=trace_id,
        user_id=user_id,
        original_session_id=session_id,
        active_session_id=active_session_id,
        run_id=run_id,
        turn_index=turn_index,
    )


async def _finish_a2ui_stream_for_tool_start(
    *,
    bridge: A2UIStreamBridge,
    dispatcher: EventDispatcher,
    tool_call_id: str,
    run_id: str,
    session_id: str,
    trace_id: str,
    user_id: str,
    active_session_id: str,
    turn_index: int,
) -> None:
    payload = None
    if tool_call_id:
        payload = bridge.finish_for_tool_call(tool_call_id, run_id=run_id)
    if payload is None and run_id:
        payload = bridge.finish_for_run_id(run_id)
    if payload is None:
        return
    await _emit_a2ui_stream_payload(
        dispatcher=dispatcher,
        payload=payload,
        session_id=session_id,
        trace_id=trace_id,
        user_id=user_id,
        active_session_id=active_session_id,
        run_id=run_id,
        turn_index=turn_index,
    )


async def _fail_a2ui_stream_for_tool_error(
    *,
    bridge: A2UIStreamBridge,
    dispatcher: EventDispatcher,
    tool_call_id: str,
    run_id: str,
    error: str,
    session_id: str,
    trace_id: str,
    user_id: str,
    active_session_id: str,
    turn_index: int,
) -> None:
    payload = None
    if tool_call_id:
        payload = bridge.fail_for_tool_call(tool_call_id, run_id=run_id, error=error)
    if payload is None and run_id:
        payload = bridge.fail_for_run_id(run_id, error=error)
    if payload is None:
        return
    await _emit_a2ui_stream_payload(
        dispatcher=dispatcher,
        payload=payload,
        session_id=session_id,
        trace_id=trace_id,
        user_id=user_id,
        active_session_id=active_session_id,
        run_id=run_id,
        turn_index=turn_index,
    )


async def _finish_a2ui_streams_for_model_end(
    *,
    bridge: A2UIStreamBridge,
    dispatcher: EventDispatcher,
    session_id: str,
    trace_id: str,
    user_id: str,
    active_session_id: str,
    run_id: str,
    turn_index: int,
) -> None:
    for payload in bridge.finish_for_model_end():
        await _emit_a2ui_stream_payload(
            dispatcher=dispatcher,
            payload=payload,
            session_id=session_id,
            trace_id=trace_id,
            user_id=user_id,
            active_session_id=active_session_id,
            run_id=run_id,
            turn_index=turn_index,
        )


async def _discard_a2ui_streams(
    *,
    bridge: A2UIStreamBridge,
    dispatcher: EventDispatcher,
    finish_reason: str,
    session_id: str,
    trace_id: str,
    user_id: str,
    active_session_id: str,
    run_id: str,
    turn_index: int,
) -> None:
    for payload in bridge.discard_all(finish_reason=finish_reason):
        await _emit_a2ui_stream_payload(
            dispatcher=dispatcher,
            payload=payload,
            session_id=session_id,
            trace_id=trace_id,
            user_id=user_id,
            active_session_id=active_session_id,
            run_id=run_id,
            turn_index=turn_index,
        )


async def _flush_reasoning(
    *,
    dispatcher: EventDispatcher,
    run_id: str,
    reasoning_parts_by_run_id: dict[str, list[str]],
    reasoning_started_at_by_run_id: dict[str, int],
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
    end_time = int(time.time() * 1000)
    start_time = reasoning_started_at_by_run_id.pop(run_id, end_time)
    await dispatcher.emit_event(
        event_type=DomainEventType.REASONING_FINISHED.value,
        source="langchain_event_handler",
        payload={
            "kind": "reasoning",
            "text": text,
            "done": True,
            "session_id": session_id,
            "trace_id": trace_id,
            "start_time": start_time,
            "end_time": end_time,
            "duration_ms": max(0, end_time - start_time),
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


def _has_llm_output_token(message: Any) -> bool:
    if message is None:
        return False
    if _message_text(message) or _reasoning_text(message):
        return True
    if _message_invalid_tool_calls(message):
        return True
    tool_call_chunks = getattr(message, "tool_call_chunks", None) or getattr(
        message, "tool_calls", None
    )
    if tool_call_chunks is None and isinstance(message, dict):
        tool_call_chunks = message.get("tool_call_chunks") or message.get("tool_calls")
    if tool_call_chunks is None:
        additional_kwargs = getattr(message, "additional_kwargs", None)
        if isinstance(additional_kwargs, dict):
            tool_call_chunks = additional_kwargs.get(
                "tool_call_chunks"
            ) or additional_kwargs.get("tool_calls")
            function_call = additional_kwargs.get("function_call")
            if isinstance(function_call, dict) and function_call:
                return True
    if isinstance(tool_call_chunks, list) and tool_call_chunks:
        return True
    content = getattr(message, "content", None)
    if isinstance(content, list):
        return any(
            item is not None and item != "" for item in content if not isinstance(item, dict)
        ) or any(bool(item) for item in content if isinstance(item, dict))
    return False


def _message_invalid_tool_calls(message: Any) -> list[Any]:
    raw = getattr(message, "invalid_tool_calls", None)
    if raw is None and isinstance(message, dict):
        raw = message.get("invalid_tool_calls")
    if raw is None:
        additional_kwargs = getattr(message, "additional_kwargs", None)
        if isinstance(additional_kwargs, dict):
            raw = additional_kwargs.get("invalid_tool_calls")
    return list(raw or []) if isinstance(raw, list) else []


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
    internal_text = additional_kwargs.get("__keydex_reasoning_text__")
    if isinstance(internal_text, str) and internal_text:
        return internal_text
    for key in ("reasoning_content", "reasoning", "reasoning_text"):
        value = additional_kwargs.get(key)
        if isinstance(value, str) and value:
            return value
        if isinstance(value, dict):
            nested = _reasoning_text_from_mapping(value)
            if nested:
                return nested
    details = additional_kwargs.get("reasoning_details")
    if isinstance(details, str):
        return details
    if isinstance(details, list):
        return "".join(
            part
            for part in (
                _reasoning_text_from_mapping(item)
                for item in details
                if isinstance(item, dict)
            )
            if part
        )
    if isinstance(details, dict):
        return _reasoning_text_from_mapping(details)
    return ""


def _reasoning_text_from_mapping(value: dict[str, Any]) -> str:
    for key in ("text", "content", "reasoning_content", "reasoning_text", "summary"):
        item = value.get(key)
        if isinstance(item, str) and item:
            return item
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
    details = (
        usage.get("input_token_details")
        if isinstance(usage, dict)
        else getattr(
            usage,
            "input_token_details",
            None,
        )
    )
    if isinstance(details, dict):
        return int(details.get("cache_read", 0) or 0)
    if details is not None:
        return int(getattr(details, "cache_read", 0) or 0)
    return 0


def _tool_output_is_error(output: Any) -> bool:
    output = _public_tool_output(output)
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
    output = _public_tool_output(output)
    if isinstance(output, ToolMessage):
        content = getattr(output, "content", "")
        return content if isinstance(content, str) else str(content)
    if isinstance(output, Command):
        return ""
    if isinstance(output, str):
        return output
    return str(_make_json_serializable(output))


def _structured_tool_output(output: Any) -> Any:
    output = _public_tool_output(output)
    if isinstance(output, ToolMessage):
        return _parse_structured_tool_content(getattr(output, "content", ""))
    if isinstance(output, dict):
        return _make_json_serializable(output)
    if isinstance(output, str):
        return _parse_structured_tool_content(output)
    return None


def _tool_call_id_from_output(output: Any) -> str:
    output = _public_tool_output(output)
    if isinstance(output, ToolMessage):
        return str(getattr(output, "tool_call_id", "") or "")
    return ""


def _tool_name_from_output(output: Any) -> str:
    output = _public_tool_output(output)
    if isinstance(output, ToolMessage):
        return str(getattr(output, "name", "") or "")
    return ""


def _public_tool_output(output: Any) -> Any:
    return _tool_message_from_output(output) or output


def _tool_message_from_output(output: Any, *, depth: int = 0) -> ToolMessage | None:
    if depth > 4:
        return None
    if isinstance(output, ToolMessage):
        return output
    if isinstance(output, Command):
        return _tool_message_from_output(getattr(output, "update", None), depth=depth + 1)
    if isinstance(output, dict):
        for key in ("messages", "output", "result"):
            if key not in output:
                continue
            if message := _tool_message_from_output(output.get(key), depth=depth + 1):
                return message
        return None
    if isinstance(output, (list, tuple)):
        for item in output:
            if message := _tool_message_from_output(item, depth=depth + 1):
                return message
    return None


def _parse_structured_tool_content(content: Any) -> Any:
    if isinstance(content, dict):
        return _make_json_serializable(content)
    if not isinstance(content, str):
        return None
    try:
        parsed = json.loads(content)
    except json.JSONDecodeError:
        return None
    return _make_json_serializable(parsed)


def _tool_files_from_structured_output(output: Any) -> list[dict[str, Any]]:
    if not isinstance(output, dict):
        return []
    source = output.get("files") or output.get("changes")
    if not isinstance(source, list):
        return []
    files = []
    for item in source:
        if not isinstance(item, dict):
            continue
        files.append(finalize_file_change(item))
    return files


def _mcp_metadata_from_event(
    *,
    event: dict[str, Any],
    data: dict[str, Any],
    output: Any = None,
    structured_output: Any = None,
) -> dict[str, Any] | None:
    candidates: list[Any] = [
        event.get("metadata"),
        data.get("metadata"),
        structured_output,
    ]
    if isinstance(structured_output, dict):
        candidates.extend(
            [
                structured_output.get("metadata"),
                structured_output.get("mcp"),
            ]
        )
    public_output = _public_tool_output(output)
    if isinstance(public_output, ToolMessage):
        candidates.extend(
            [
                getattr(public_output, "metadata", None),
                getattr(public_output, "response_metadata", None),
                _parse_structured_tool_content(getattr(public_output, "content", "")),
            ]
        )
    elif isinstance(public_output, dict):
        candidates.append(public_output)

    for candidate in candidates:
        normalized = _normalize_mcp_metadata(candidate)
        if normalized is not None:
            return normalized
    return None


def _normalize_mcp_metadata(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, dict):
        return None
    source = value.get("mcp") if isinstance(value.get("mcp"), dict) else value
    if not isinstance(source, dict):
        return None
    kind = source.get("kind")
    server_id = source.get("server_id")
    raw_tool_name = source.get("raw_tool_name") or source.get("raw_name")
    model_tool_name = (
        source.get("model_tool_name")
        or source.get("model_name")
        or source.get("tool_name")
    )
    snapshot_id = source.get("snapshot_id")
    if kind != "mcp_tool" and not (server_id and raw_tool_name and model_tool_name):
        return None
    metadata = {
        "kind": "mcp_tool",
        **_mcp_optional_text("snapshot_id", snapshot_id),
        **_mcp_optional_text("server_id", server_id),
        **_mcp_optional_text("server_name", source.get("server_name")),
        **_mcp_optional_text("raw_tool_name", raw_tool_name),
        **_mcp_optional_text("model_tool_name", model_tool_name),
        **_mcp_optional_text("model_name", source.get("model_name") or model_tool_name),
        **_mcp_optional_text("approval_mode", source.get("approval_mode")),
        **_mcp_optional_text("exposure", source.get("exposure")),
        **_mcp_optional_text("call_id", source.get("call_id")),
    }
    annotations = source.get("annotations")
    if isinstance(annotations, dict):
        metadata["annotations"] = _make_json_serializable(annotations)
    return metadata


def _mcp_optional_text(
    key: str,
    value: Any,
) -> dict[str, Any]:
    if value is None:
        return {}
    normalized = str(value).strip()
    return {key: normalized} if normalized else {}


def _mcp_event_fields(metadata: dict[str, Any] | None) -> dict[str, Any]:
    if metadata is None:
        return {}
    fields: dict[str, Any] = {
        "kind": "mcp_tool",
        "metadata": {"mcp": metadata},
    }
    for key in (
        "snapshot_id",
        "server_id",
        "server_name",
        "raw_tool_name",
        "model_tool_name",
    ):
        if key in metadata:
            fields[key] = metadata[key]
    return fields


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


def _is_a2ui_graph_interrupt(value: Any) -> bool:
    if value is None:
        return False
    if isinstance(value, dict):
        return (
            str(value.get("reason") or "") == "a2ui"
            and bool(str(value.get("interaction_id") or "").strip())
        )
    interrupt_value = getattr(value, "value", None)
    if interrupt_value is not None and _is_a2ui_graph_interrupt(interrupt_value):
        return True
    if isinstance(value, (list, tuple, set)):
        return any(_is_a2ui_graph_interrupt(item) for item in value)
    if isinstance(value, BaseException):
        return any(_is_a2ui_graph_interrupt(arg) for arg in getattr(value, "args", ()) or ())
    return False


async def _close_event_stream(event_stream: AsyncIterator[dict[str, Any]]) -> None:
    close = getattr(event_stream, "aclose", None)
    if callable(close):
        await close()
