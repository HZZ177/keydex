from __future__ import annotations

import json
import time
from typing import Any

from backend.app.core.ids import new_id
from backend.app.events import DomainEventType, EventDispatcher
from backend.app.tools.base import (
    ToolExecutionContext,
    ToolExecutionError,
    ToolExecutionResult,
)
from backend.app.tools.registry import ToolRegistry, ToolRegistryError


class ToolOrchestrator:
    def __init__(self, *, registry: ToolRegistry, dispatcher: EventDispatcher) -> None:
        self.registry = registry
        self.dispatcher = dispatcher

    async def execute(
        self,
        tool_name: str,
        args: dict[str, Any] | None,
        context: ToolExecutionContext,
        *,
        run_id: str | None = None,
        parent_run_id: str | None = None,
        subagent_name: str | None = None,
        subagent_id: str | None = None,
    ) -> ToolExecutionResult:
        resolved_args = dict(args or {})
        resolved_run_id = run_id or new_id()
        is_subagent = bool(subagent_name or subagent_id)
        started_at = time.perf_counter()
        start_time_ms = int(time.time() * 1000)

        await self._emit(
            DomainEventType.LLM_TOOL_STARTED,
            payload=self._build_start_payload(
                tool_name=tool_name,
                args=resolved_args,
                context=context,
                run_id=resolved_run_id,
                parent_run_id=parent_run_id,
                is_subagent=is_subagent,
                subagent_name=subagent_name,
                subagent_id=subagent_id,
                start_time_ms=start_time_ms,
            ),
            context=context,
            run_id=resolved_run_id,
        )

        result = await self._run_tool(tool_name, resolved_args, context)
        duration_ms = max(0, int((time.perf_counter() - started_at) * 1000))

        if result.ok:
            await self._emit(
                DomainEventType.LLM_TOOL_FINISHED,
                payload=self._build_end_payload(
                    tool_name=tool_name,
                    result=result,
                    context=context,
                    run_id=resolved_run_id,
                    parent_run_id=parent_run_id,
                    is_subagent=is_subagent,
                    subagent_name=subagent_name,
                    subagent_id=subagent_id,
                    duration_ms=duration_ms,
                ),
                context=context,
                run_id=resolved_run_id,
            )
            return result

        await self._emit(
            DomainEventType.LLM_TOOL_FAILED,
            payload=self._build_end_payload(
                tool_name=tool_name,
                result=result,
                context=context,
                run_id=resolved_run_id,
                parent_run_id=parent_run_id,
                is_subagent=is_subagent,
                subagent_name=subagent_name,
                subagent_id=subagent_id,
                duration_ms=duration_ms,
            ),
            context=context,
            run_id=resolved_run_id,
        )
        return result

    async def _run_tool(
        self,
        tool_name: str,
        args: dict[str, Any],
        context: ToolExecutionContext,
    ) -> ToolExecutionResult:
        try:
            tool = self.registry.require(tool_name)
            return await tool.run(args, context)
        except ToolRegistryError as exc:
            return ToolExecutionResult.failed(
                ToolExecutionError(
                    str(exc),
                    code="tool_not_found",
                    details={"tool": tool_name},
                )
            )
        except ToolExecutionError as exc:
            return ToolExecutionResult.failed(exc)
        except Exception as exc:
            return ToolExecutionResult.failed(
                ToolExecutionError(
                    str(exc),
                    code="tool_execution_failed",
                    details={"tool": tool_name, "type": type(exc).__name__},
                )
            )

    async def _emit(
        self,
        event_type: DomainEventType,
        *,
        payload: dict[str, Any],
        context: ToolExecutionContext,
        run_id: str,
    ) -> None:
        await self.dispatcher.emit_event(
            event_type=event_type.value,
            source="tool_orchestrator",
            payload=payload,
            trace_id=context.trace_id,
            user_id=context.user_id,
            original_session_id=context.session_id,
            active_session_id=context.session_id,
            run_id=run_id,
            turn_index=context.turn_index,
        )

    def _build_start_payload(
        self,
        *,
        tool_name: str,
        args: dict[str, Any],
        context: ToolExecutionContext,
        run_id: str,
        parent_run_id: str | None,
        is_subagent: bool,
        subagent_name: str | None,
        subagent_id: str | None,
        start_time_ms: int,
    ) -> dict[str, Any]:
        serialized_args = _make_json_serializable(args)
        trace_id = context.trace_id or ""
        return {
            "run_id": run_id,
            "parent_run_id": parent_run_id,
            "tool": tool_name,
            "params": serialized_args,
            "is_subagent": is_subagent,
            "subagent_name": subagent_name,
            "subagent_id": subagent_id,
            "session_id": context.session_id,
            "trace_id": trace_id,
            "trace_record_id": trace_id,
            "node_id": _tool_node_id(trace_id, run_id),
            "parent_node_id": "",
            "name": tool_name,
            "start_time": start_time_ms,
            "input_data": {"args": serialized_args},
            "metadata": _metadata(context),
        }

    def _build_end_payload(
        self,
        *,
        tool_name: str,
        result: ToolExecutionResult,
        context: ToolExecutionContext,
        run_id: str,
        parent_run_id: str | None,
        is_subagent: bool,
        subagent_name: str | None,
        subagent_id: str | None,
        duration_ms: int,
    ) -> dict[str, Any]:
        serialized_result = _make_json_serializable(result.result)
        result_text = _stringify_result(serialized_result)
        trace_id = context.trace_id or ""
        payload: dict[str, Any] = {
            "run_id": run_id,
            "parent_run_id": parent_run_id,
            "tool": tool_name,
            "result": result_text,
            "duration_ms": duration_ms,
            "is_subagent": is_subagent,
            "subagent_name": subagent_name,
            "subagent_id": subagent_id,
            "session_id": context.session_id,
            "trace_id": trace_id,
            "trace_record_id": trace_id,
            "node_id": _tool_node_id(trace_id, run_id),
            "end_time": int(time.time() * 1000),
            "status": "completed" if result.ok else "failed",
            "output_data": {"result": serialized_result},
            "metadata": _metadata(context),
        }
        if result.metadata:
            payload["tool_metadata"] = _make_json_serializable(result.metadata)
        if isinstance(serialized_result, dict) and isinstance(
            serialized_result.get("ui_payload"),
            dict,
        ):
            payload["ui_payload"] = serialized_result["ui_payload"]
        if result.error:
            error = _make_json_serializable(result.error)
            payload["error"] = error
        return payload


def _tool_node_id(trace_id: str, run_id: str) -> str:
    if not trace_id:
        return f"llm_tool-run-{run_id}"
    return f"{trace_id}-llm_tool-run-{run_id}"


def _metadata(context: ToolExecutionContext) -> dict[str, Any]:
    raw = context.metadata.get("tool_metadata")
    return dict(raw) if isinstance(raw, dict) else {}


def _make_json_serializable(value: Any) -> Any:
    try:
        return json.loads(json.dumps(value, ensure_ascii=False, default=str))
    except (TypeError, ValueError):
        return str(value)


def _stringify_result(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    try:
        return json.dumps(value, ensure_ascii=False)
    except (TypeError, ValueError):
        return str(value)
