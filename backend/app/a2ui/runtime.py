from __future__ import annotations

import json
from collections.abc import Callable
from typing import Any, Protocol

from langchain_core.runnables import RunnableConfig
from langgraph.errors import GraphInterrupt
from langgraph.types import interrupt as langgraph_interrupt

from backend.app.a2ui.event_payloads import (
    build_a2ui_created_payload,
    build_waiting_input_payload,
)
from backend.app.a2ui.registry import A2UIRegistry, A2UIToolDefinition, build_builtin_a2ui_registry
from backend.app.a2ui.schemas import A2UIObject, a2ui_object_from_record, validate_payload
from backend.app.core.request_context import (
    consume_a2ui_resume_payload,
    consume_a2ui_stream_context,
)
from backend.app.core.ids import new_id
from backend.app.events.event_types import DomainEventType
from backend.app.storage import StorageRepositories
from backend.app.tools import ToolExecutionContext


class A2UIDispatcher(Protocol):
    async def emit_event(
        self,
        *,
        event_type: str,
        source: str,
        payload: dict[str, Any],
        trace_id: str | None = None,
        user_id: str | None = None,
        original_session_id: str | None = None,
        active_session_id: str | None = None,
        run_id: str | None = None,
        turn_index: int | None = None,
        tags: dict[str, Any] | None = None,
    ) -> Any: ...


InterruptFn = Callable[[dict[str, Any]], Any]


class A2UIRuntime:
    def __init__(
        self,
        *,
        repositories: StorageRepositories,
        dispatcher: A2UIDispatcher | None,
        registry: A2UIRegistry | None = None,
        interrupt_fn: InterruptFn = langgraph_interrupt,
    ) -> None:
        self.repositories = repositories
        self.dispatcher = dispatcher
        self.registry = registry or build_builtin_a2ui_registry()
        self.interrupt_fn = interrupt_fn

    async def handle_tool_call(
        self,
        definition: A2UIToolDefinition,
        args: dict[str, Any],
        context: ToolExecutionContext,
        config: RunnableConfig | None,
    ) -> str:
        tool_call_id = _tool_call_id_from_config(config) or str(context.metadata.get("tool_call_id") or "")
        run_id = _run_id_from_config(config) or str(context.metadata.get("run_id") or "").strip()
        stream_context = consume_a2ui_stream_context(
            definition.render_key,
            tool_call_id=tool_call_id,
            run_id=run_id,
        )
        if not tool_call_id and stream_context:
            tool_call_id = str(stream_context.get("tool_call_id") or "").strip()
        payload = validate_payload(args, definition.input_schema)
        if definition.mode == "interactive":
            resume_payload = consume_a2ui_resume_payload(
                definition.render_key,
                tool_call_id=tool_call_id,
            )
            if resume_payload is not None:
                return _json_result(resume_payload)
        if not tool_call_id:
            tool_call_id = new_id()
        stream_id = str((stream_context or {}).get("stream_id") or "").strip()
        stream_group_id = str((stream_context or {}).get("stream_group_id") or "").strip()
        if not stream_id:
            stream_id = resolve_a2ui_stream_id(
                render_key=definition.render_key,
                tool_call_id=tool_call_id,
                trace_id=context.trace_id,
            )
        if definition.mode == "render":
            return await self._handle_render(
                definition=definition,
                payload=payload,
                context=context,
                stream_id=stream_id,
                tool_call_id=tool_call_id,
                stream_group_id=stream_group_id,
            )
        return await self._handle_interactive(
            definition=definition,
            payload=payload,
            context=context,
            config=config,
            stream_id=stream_id,
            tool_call_id=tool_call_id,
            stream_group_id=stream_group_id,
        )

    async def _handle_render(
        self,
        *,
        definition: A2UIToolDefinition,
        payload: dict[str, Any],
        context: ToolExecutionContext,
        stream_id: str,
        tool_call_id: str,
        stream_group_id: str,
    ) -> str:
        a2ui = A2UIObject(
            render_key=definition.render_key,
            mode=definition.mode,
            stream_id=stream_id,
            tool_call_id=tool_call_id,
            trace_id=context.trace_id,
            turn_index=context.turn_index,
            payload=payload,
            input_schema=definition.input_schema,
            submit_schema=definition.submit_schema,
        )
        created_payload = build_a2ui_created_payload(a2ui)
        if stream_group_id:
            created_payload["stream_group_id"] = stream_group_id
        await self._emit(
            DomainEventType.A2UI_CREATED,
            payload=created_payload,
            context=context,
        )
        return _json_result(
            {
                "status": "rendered",
                "render_key": definition.render_key,
                "stream_id": stream_id,
                "tool_call_id": tool_call_id,
            }
        )

    async def _handle_interactive(
        self,
        *,
        definition: A2UIToolDefinition,
        payload: dict[str, Any],
        context: ToolExecutionContext,
        config: RunnableConfig | None,
        stream_id: str,
        tool_call_id: str,
        stream_group_id: str,
    ) -> str:
        checkpoint = _checkpoint_from_context(context, config)
        resume_group_id = build_resume_group_id(
            session_id=context.session_id,
            trace_id=context.trace_id,
            turn_index=context.turn_index,
            checkpoint_ns=checkpoint.get("checkpoint_ns") or "",
            checkpoint_id=checkpoint.get("checkpoint_id"),
        )
        record = self.repositories.a2ui_interactions.create(
            session_id=context.session_id,
            trace_id=context.trace_id,
            active_session_id=str(context.metadata.get("active_session_id") or context.session_id),
            turn_index=context.turn_index,
            tool_call_id=tool_call_id,
            stream_id=stream_id,
            render_key=definition.render_key,
            mode=definition.mode,
            payload=payload,
            input_schema=definition.input_schema,
            submit_schema_snapshot=definition.submit_schema,
            langgraph_thread_id=checkpoint.get("thread_id"),
            checkpoint_ns=str(checkpoint.get("checkpoint_ns") or ""),
            checkpoint_id=checkpoint.get("checkpoint_id"),
            interrupt_id=checkpoint.get("interrupt_id") or tool_call_id,
            resume_group_id=resume_group_id,
        )
        self.repositories.sessions.update(record.session_id, status="waiting_input")
        a2ui = a2ui_object_from_record(record)
        created_payload = build_a2ui_created_payload(a2ui)
        if stream_group_id:
            created_payload["stream_group_id"] = stream_group_id
        waiting_payload = build_waiting_input_payload(a2ui=a2ui, checkpoint=checkpoint)
        if stream_group_id:
            waiting_payload["stream_group_id"] = stream_group_id
        await self._emit(DomainEventType.A2UI_CREATED, payload=created_payload, context=context)
        await self._emit(DomainEventType.TURN_WAITING_INPUT, payload=waiting_payload, context=context)
        try:
            resume_value = self.interrupt_fn(waiting_payload)
        except GraphInterrupt as exc:
            if interrupt_id := _interrupt_id_from_graph_interrupt(exc):
                self.repositories.a2ui_interactions.update_interrupt_id(record.id, interrupt_id)
            raise
        return _json_result(
            {
                "status": "resumed",
                "interaction_id": record.id,
                "render_key": definition.render_key,
                "stream_id": stream_id,
                "tool_call_id": tool_call_id,
                "resume": resume_value,
            }
        )

    async def _emit(
        self,
        event_type: DomainEventType,
        *,
        payload: dict[str, Any],
        context: ToolExecutionContext,
    ) -> None:
        if self.dispatcher is None:
            return
        await self.dispatcher.emit_event(
            event_type=event_type.value,
            source="a2ui_runtime",
            payload=payload,
            trace_id=context.trace_id,
            user_id=context.user_id,
            original_session_id=context.session_id,
            active_session_id=str(context.metadata.get("active_session_id") or context.session_id),
            turn_index=context.turn_index,
        )


def resolve_a2ui_stream_id(
    *,
    render_key: str,
    tool_call_id: str,
    trace_id: str | None = None,
) -> str:
    normalized_trace_id = str(trace_id or "").strip()
    if normalized_trace_id:
        return f"{normalized_trace_id}:a2ui:{tool_call_id}"
    return f"a2ui:{render_key}:{tool_call_id}"


def build_resume_group_id(
    *,
    session_id: str,
    trace_id: str | None,
    turn_index: int,
    checkpoint_ns: str,
    checkpoint_id: str | None,
) -> str:
    return ":".join(
        [
            "a2ui",
            session_id,
            trace_id or "",
            str(turn_index),
            checkpoint_ns,
            checkpoint_id or "",
        ]
    )


def _tool_call_id_from_config(config: RunnableConfig | None) -> str | None:
    if not config:
        return None
    value = str(config.get("tool_call_id") or "").strip()
    if value:
        return value
    for container_key in ("configurable", "metadata"):
        container = config.get(container_key)
        if not isinstance(container, dict):
            continue
        value = str(container.get("tool_call_id") or "").strip()
        if value:
            return value
    return None


def _run_id_from_config(config: RunnableConfig | None) -> str | None:
    if not config:
        return None
    value = str(config.get("run_id") or "").strip()
    if value:
        return value
    for key in ("configurable", "metadata"):
        container = config.get(key)
        if not isinstance(container, dict):
            continue
        value = str(container.get("run_id") or "").strip()
        if value:
            return value
    return None


def _checkpoint_from_context(
    context: ToolExecutionContext,
    config: RunnableConfig | None,
) -> dict[str, str | None]:
    metadata = dict(context.metadata)
    config_configurable = config.get("configurable") if config else None
    if isinstance(config_configurable, dict):
        metadata = {**metadata, **config_configurable}
    thread_id = str(metadata.get("thread_id") or metadata.get("langgraph_thread_id") or context.session_id)
    checkpoint_ns = str(metadata.get("checkpoint_ns") or "")
    checkpoint_id = metadata.get("checkpoint_id")
    interrupt_id = metadata.get("interrupt_id")
    return {
        "thread_id": thread_id,
        "checkpoint_ns": checkpoint_ns,
        "checkpoint_id": str(checkpoint_id) if checkpoint_id else None,
        "interrupt_id": str(interrupt_id) if interrupt_id else None,
    }


def _json_result(payload: dict[str, Any]) -> str:
    return json.dumps(payload, ensure_ascii=False, default=str)


def _interrupt_id_from_graph_interrupt(value: Any) -> str | None:
    if value is None:
        return None
    interrupt_id = str(getattr(value, "id", "") or "").strip()
    if interrupt_id and _is_a2ui_interrupt_value(getattr(value, "value", None)):
        return interrupt_id
    if isinstance(value, dict):
        return None
    if isinstance(value, (list, tuple, set)):
        for item in value:
            found = _interrupt_id_from_graph_interrupt(item)
            if found:
                return found
        return None
    if isinstance(value, BaseException):
        for item in getattr(value, "args", ()) or ():
            found = _interrupt_id_from_graph_interrupt(item)
            if found:
                return found
    return None


def _is_a2ui_interrupt_value(value: Any) -> bool:
    return (
        isinstance(value, dict)
        and str(value.get("reason") or "") == "a2ui"
        and bool(str(value.get("interaction_id") or "").strip())
    )
