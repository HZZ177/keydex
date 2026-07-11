from __future__ import annotations

import json
from typing import Any

from backend.app.a2ui.event_payloads import build_a2ui_stream_payload
from backend.app.a2ui.registry import A2UIRegistry, build_builtin_a2ui_registry
from backend.app.a2ui.runtime import resolve_a2ui_stream_id
from backend.app.agent.tool_call_progress import ToolCallChunkState, ToolProgressCollector
from backend.app.core.request_context import (
    discard_a2ui_stream_context,
    register_a2ui_stream_context,
)
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

    def finish_for_model_end(self) -> list[dict[str, Any]]:
        return self.collector.finish_for_model_end()

    def discard_all(self, *, finish_reason: str) -> list[dict[str, Any]]:
        return self.collector.discard_all(finish_reason=finish_reason)

    def fail_for_tool_call(
        self,
        tool_call_id: str,
        *,
        error: str = "",
    ) -> dict[str, Any] | None:
        return self.collector.fail_for_tool_call(tool_call_id, error=error)


class A2UIStreamCollector:
    def __init__(self, registry: A2UIRegistry, *, trace_id: str | None = None) -> None:
        self.registry = registry
        self.trace_id = str(trace_id or "").strip()
        self.tool_names = frozenset(registry.render_keys)
        self._seen_keys: set[str] = set()
        self._chunk_indexes: dict[str, int] = {}
        self._states_by_tool_call_id: dict[str, ToolCallChunkState] = {}
        self._stream_states: dict[str, ToolCallChunkState] = {}
        self._source_to_stream_key: dict[str, str] = {}
        self._stream_group_ids: dict[str, str] = {}
        self._finished_keys: set[str] = set()
        self._registered_keys: set[str] = set()

    def collect(self, state: ToolCallChunkState) -> dict[str, Any] | None:
        if not self.registry.is_a2ui_tool(state.name):
            return None
        state = self._merge_stream_state(state)
        key = _stream_key(state)
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
                stream_group_id=self._stream_group_id(state),
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
        return self._finish_for_created(state, finish_reason="tool_call_started")

    def fail_for_tool_call(
        self,
        tool_call_id: str,
        *,
        error: str = "",
    ) -> dict[str, Any] | None:
        state = self._states_by_tool_call_id.get(tool_call_id)
        if state is None:
            return None
        return self._fail_state(state, error=error)

    def finish_for_model_end(self) -> list[dict[str, Any]]:
        payloads: list[dict[str, Any]] = []
        for state in list(self._stream_states.values()):
            payload = self._finish_state(
                state,
                finish_reason="tool_args_completed",
                register_context=True,
            )
            if payload is not None:
                payloads.append(payload)
        return payloads

    def discard_all(self, *, finish_reason: str) -> list[dict[str, Any]]:
        payloads: list[dict[str, Any]] = []
        for state in list(self._stream_states.values()):
            payload = self._finish_state(
                state,
                finish_reason=finish_reason,
                register_context=False,
            )
            if payload is not None:
                payloads.append(payload)
        self._clear()
        return payloads

    def _finish_for_created(
        self,
        state: ToolCallChunkState,
        *,
        finish_reason: str,
    ) -> dict[str, Any] | None:
        key = _stream_key(state)
        if key in self._finished_keys:
            self._register_stream_context(state)
            return None
        return self._finish_state(
            state,
            finish_reason=finish_reason,
            register_context=True,
        )

    def _finish_state(
        self,
        state: ToolCallChunkState,
        *,
        finish_reason: str,
        register_context: bool,
    ) -> dict[str, Any] | None:
        if not self.registry.is_a2ui_tool(state.name):
            return None
        key = _stream_key(state)
        if key in self._finished_keys:
            if register_context:
                self._register_stream_context(state)
            return None
        self._finished_keys.add(key)
        chunk_index = self._chunk_indexes.get(key, 0)
        self._chunk_indexes[key] = chunk_index + 1
        if register_context:
            self._register_stream_context(state)
        payload = _with_event_type(
            build_a2ui_stream_payload(
                status="finish",
                render_key=state.name,
                stream_id=resolve_a2ui_stream_id(
                    render_key=state.name,
                    tool_call_id=key,
                    trace_id=self.trace_id,
                ),
                tool_call_id=_payload_tool_call_id(state),
                stream_group_id=self._stream_group_id(state),
                chunk_index=chunk_index,
                args_delta="",
                args_text_length=len(state.args_text),
                args_text=state.args_text,
                parsed_payload=dict(state.args) if state.args else None,
                json_parse_status=_json_parse_status(state),
                finish_reason=finish_reason,
            ),
            DomainEventType.A2UI_STREAM_FINISHED,
        )
        return payload

    def _fail_state(self, state: ToolCallChunkState, *, error: str) -> dict[str, Any] | None:
        if not self.registry.is_a2ui_tool(state.name):
            return None
        key = _stream_key(state)
        chunk_index = self._chunk_indexes.get(key, 0)
        self._chunk_indexes[key] = chunk_index + 1
        payload = _with_event_type(
            build_a2ui_stream_payload(
                status="failed",
                render_key=state.name,
                stream_id=resolve_a2ui_stream_id(
                    render_key=state.name,
                    tool_call_id=key,
                    trace_id=self.trace_id,
                ),
                tool_call_id=_payload_tool_call_id(state),
                stream_group_id=self._stream_group_id(state),
                chunk_index=chunk_index,
                args_delta="",
                args_text_length=len(state.args_text),
                args_text=state.args_text,
                parsed_payload=dict(state.args) if state.args else None,
                json_parse_status=_json_parse_status(state),
                finish_reason="tool_error",
                error=error,
            ),
            DomainEventType.A2UI_STREAM_FINISHED,
        )
        discard_a2ui_stream_context(
            state.name,
            tool_call_id=_payload_tool_call_id(state),
            run_id=state.bound_run_id,
        )
        self._clear_state(key=key, state=state)
        return payload

    def _register_stream_context(self, state: ToolCallChunkState) -> None:
        if not self.registry.is_a2ui_tool(state.name):
            return
        key = _stream_key(state)
        if key in self._registered_keys:
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
                "stream_group_id": self._stream_group_id(state),
                "tool_call_id": tool_call_id,
                "render_key": state.name,
                "run_id": state.bound_run_id,
            },
        )
        self._registered_keys.add(key)

    def _clear(self) -> None:
        self._seen_keys.clear()
        self._chunk_indexes.clear()
        self._states_by_tool_call_id.clear()
        self._stream_states.clear()
        self._source_to_stream_key.clear()
        self._stream_group_ids.clear()
        self._finished_keys.clear()
        self._registered_keys.clear()

    def _clear_state(self, *, key: str, state: ToolCallChunkState) -> None:
        self._seen_keys.discard(key)
        self._chunk_indexes.pop(key, None)
        self._stream_states.pop(key, None)
        self._stream_group_ids.pop(key, None)
        self._finished_keys.discard(key)
        self._registered_keys.discard(key)
        for source_key, stream_key in list(self._source_to_stream_key.items()):
            if stream_key == key:
                self._source_to_stream_key.pop(source_key, None)
        for tool_call_id, indexed_state in list(self._states_by_tool_call_id.items()):
            if indexed_state is state:
                self._states_by_tool_call_id.pop(tool_call_id, None)

    def _merge_stream_state(self, incoming: ToolCallChunkState) -> ToolCallChunkState:
        stream_key = self._resolve_stream_state_key(incoming)
        state = self._stream_states.get(stream_key)
        if state is None:
            state = ToolCallChunkState(
                key=stream_key,
                tool_call_id=incoming.tool_call_id,
                index=incoming.index,
                model_run_id=incoming.model_run_id,
                name=incoming.name,
            )
            self._stream_states[stream_key] = state

        if incoming.tool_call_id:
            state.tool_call_id = incoming.tool_call_id
            self._states_by_tool_call_id[incoming.tool_call_id] = state
            self._source_to_stream_key[incoming.tool_call_id] = stream_key
        if incoming.key:
            self._states_by_tool_call_id[incoming.key] = state
            self._source_to_stream_key[incoming.key] = stream_key
        if incoming.index is not None:
            state.index = incoming.index
        if incoming.model_run_id and not state.model_run_id:
            state.model_run_id = incoming.model_run_id
        if incoming.name:
            state.name = incoming.name
        if incoming.bound_run_id:
            state.bound_run_id = incoming.bound_run_id

        delta = incoming.last_args_delta
        state.last_args_delta = delta
        if delta:
            state.args_text += delta
            state.args = _parse_complete_object(state.args_text)
        elif not state.args_text and incoming.args_text:
            state.args_text = incoming.args_text
            state.args = dict(incoming.args or _parse_complete_object(incoming.args_text))

        return state

    def _stream_group_id(self, state: ToolCallChunkState) -> str:
        key = _stream_key(state)
        existing = self._stream_group_ids.get(key)
        if existing:
            return existing
        group_id = resolve_a2ui_stream_id(
            render_key=state.name,
            tool_call_id=f"group:{_retry_slot(state)}",
            trace_id=self.trace_id,
        )
        self._stream_group_ids[key] = group_id
        return group_id

    def _resolve_stream_state_key(self, state: ToolCallChunkState) -> str:
        source_key = _stream_key(state)
        if source_key in self._source_to_stream_key:
            return self._source_to_stream_key[source_key]

        self._source_to_stream_key[source_key] = source_key
        return source_key


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


def _retry_slot(state: ToolCallChunkState) -> str:
    index = state.index if state.index is not None else _stream_key(state)
    return f"{state.name}:{index}"


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


def _parse_complete_object(value: str) -> dict[str, Any]:
    if not value:
        return {}
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}
