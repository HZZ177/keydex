from __future__ import annotations

import json
from typing import Any

from backend.app.a2ui.event_payloads import build_a2ui_stream_payload
from backend.app.a2ui.registry import A2UIRegistry, build_builtin_a2ui_registry
from backend.app.a2ui.runtime import resolve_a2ui_stream_id
from backend.app.agent.tool_call_progress import ToolCallChunkState, ToolProgressCollector
from backend.app.core.request_context import register_a2ui_stream_context
from backend.app.events.event_types import DomainEventType

A2UI_STREAM_EVENT_TYPE_KEY = "_a2ui_event_type"


class A2UIStreamBridge:
    def __init__(
        self,
        registry: A2UIRegistry | None = None,
        *,
        trace_id: str | None = None,
    ) -> None:
        self.registry = registry or build_builtin_a2ui_registry()
        self.collector = A2UIStreamCollector(self.registry, trace_id=trace_id)

    @property
    def collectors(self) -> list[ToolProgressCollector]:
        return [self.collector]

    def finish_for_tool_call(self, tool_call_id: str) -> dict[str, Any] | None:
        return self.collector.finish_for_tool_call(tool_call_id)

    def finish_for_run_id(self, run_id: str) -> dict[str, Any] | None:
        return self.collector.finish_for_run_id(run_id)


class A2UIStreamCollector:
    def __init__(self, registry: A2UIRegistry, *, trace_id: str | None = None) -> None:
        self.registry = registry
        self.trace_id = str(trace_id or "").strip()
        self.tool_names = frozenset(registry.render_keys)
        self._seen_keys: set[str] = set()
        self._chunk_indexes: dict[str, int] = {}
        self._states_by_tool_call_id: dict[str, ToolCallChunkState] = {}
        self._states_by_run_id: dict[str, ToolCallChunkState] = {}
        self._finished_keys: set[str] = set()

    def collect(self, state: ToolCallChunkState) -> dict[str, Any] | None:
        if not self.registry.is_a2ui_tool(state.name):
            return None
        key = _stream_key(state)
        if state.bound_run_id:
            self._states_by_run_id[state.bound_run_id] = state
        if state.key:
            self._states_by_tool_call_id[state.key] = state
        if state.tool_call_id:
            self._states_by_tool_call_id[state.tool_call_id] = state
        chunk_index = self._chunk_indexes.get(key, 0)
        self._chunk_indexes[key] = chunk_index + 1
        is_start = key not in self._seen_keys
        self._seen_keys.add(key)
        return _with_event_type(
            build_a2ui_stream_payload(
                status="start" if is_start else "chunk",
                render_key=state.name,
                stream_id=resolve_a2ui_stream_id(
                    render_key=state.name,
                    tool_call_id=key,
                    trace_id=self.trace_id,
                ),
                tool_call_id=_payload_tool_call_id(state),
                chunk_index=chunk_index,
                args_delta=state.last_args_delta,
                args_text_length=len(state.args_text),
                args_text=state.args_text,
                parsed_payload=dict(state.args) if state.args else None,
                json_parse_status=_json_parse_status(state),
            ),
            DomainEventType.A2UI_STREAM_STARTED if is_start else DomainEventType.A2UI_STREAM_CHUNK,
        )

    def finish_for_tool_call(self, tool_call_id: str) -> dict[str, Any] | None:
        state = self._states_by_tool_call_id.get(tool_call_id)
        if state is None:
            return None
        payload = self._finish_state(state)
        if payload is not None:
            self._register_stream_context(state)
        return payload

    def finish_for_run_id(self, run_id: str) -> dict[str, Any] | None:
        state = self._states_by_run_id.get(run_id)
        if state is None:
            return None
        payload = self._finish_state(state)
        if payload is not None:
            self._register_stream_context(state)
        return payload

    def _finish_state(self, state: ToolCallChunkState) -> dict[str, Any] | None:
        if not self.registry.is_a2ui_tool(state.name):
            return None
        key = _stream_key(state)
        if key in self._finished_keys:
            return None
        self._finished_keys.add(key)
        chunk_index = self._chunk_indexes.get(key, 0)
        self._chunk_indexes[key] = chunk_index + 1
        return _with_event_type(
            build_a2ui_stream_payload(
                status="finish",
                render_key=state.name,
                stream_id=resolve_a2ui_stream_id(
                    render_key=state.name,
                    tool_call_id=key,
                    trace_id=self.trace_id,
                ),
                tool_call_id=_payload_tool_call_id(state),
                chunk_index=chunk_index,
                args_delta="",
                args_text_length=len(state.args_text),
                args_text=state.args_text,
                parsed_payload=dict(state.args) if state.args else None,
                json_parse_status=_json_parse_status(state),
                finish_reason="tool_call_started",
            ),
            DomainEventType.A2UI_STREAM_FINISHED,
        )

    def _register_stream_context(self, state: ToolCallChunkState) -> None:
        if not self.registry.is_a2ui_tool(state.name):
            return
        tool_call_id = _payload_tool_call_id(state)
        if not tool_call_id:
            return
        register_a2ui_stream_context(
            state.name,
            {
                "stream_id": resolve_a2ui_stream_id(
                    render_key=state.name,
                    tool_call_id=_stream_key(state),
                    trace_id=self.trace_id,
                ),
                "tool_call_id": tool_call_id,
                "render_key": state.name,
                "run_id": state.bound_run_id,
            },
        )


def is_a2ui_stream_payload(payload: dict[str, Any]) -> bool:
    return str(payload.get(A2UI_STREAM_EVENT_TYPE_KEY) or "").startswith("a2ui.stream.")


def a2ui_stream_event_type(payload: dict[str, Any]) -> str:
    return str(payload.get(A2UI_STREAM_EVENT_TYPE_KEY) or "")


def strip_a2ui_stream_marker(payload: dict[str, Any]) -> dict[str, Any]:
    cleaned = dict(payload)
    cleaned.pop(A2UI_STREAM_EVENT_TYPE_KEY, None)
    return cleaned


def _stream_key(state: ToolCallChunkState) -> str:
    return state.key or state.tool_call_id


def _payload_tool_call_id(state: ToolCallChunkState) -> str:
    return state.tool_call_id or state.key


def _with_event_type(payload: dict[str, Any], event_type: DomainEventType) -> dict[str, Any]:
    return {**payload, A2UI_STREAM_EVENT_TYPE_KEY: event_type.value}


def _json_parse_status(state: ToolCallChunkState) -> str:
    if not state.args_text:
        return "complete" if state.args else "empty"
    try:
        parsed = json.loads(state.args_text)
    except json.JSONDecodeError:
        return "partial"
    return "complete" if isinstance(parsed, dict) else "invalid"
