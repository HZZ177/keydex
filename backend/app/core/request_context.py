from __future__ import annotations

from contextvars import ContextVar, Token
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, TypeVar

if TYPE_CHECKING:
    from backend.app.agent.tool_call_preset import ToolCallPreset
    from backend.app.events import EventDispatcher
    from backend.app.keydex.capabilities.base import CapabilityKey
    from backend.app.keydex.models import KeydexEffectiveSnapshot
    from backend.app.keydex.runtime import (
        KeydexEffectiveRuntimeSnapshot,
        KeydexWorkspaceRuntimeSnapshot,
    )
    from backend.app.keydex.skills import EffectiveSkillCatalog, SkillCatalog

CapabilityPayloadT = TypeVar("CapabilityPayloadT")

trace_id_var: ContextVar[str] = ContextVar("trace_id", default="")
session_id_var: ContextVar[str] = ContextVar("session_id", default="")
active_session_id_var: ContextVar[str] = ContextVar("active_session_id", default="")
user_id_var: ContextVar[str] = ContextVar("user_id", default="")
turn_index_var: ContextVar[int | None] = ContextVar("turn_index", default=None)
user_message_var: ContextVar[str | None] = ContextVar("user_message", default=None)
tool_call_preset_var: ContextVar[Any | None] = ContextVar("tool_call_preset", default=None)
skill_catalog_var: ContextVar[Any | None] = ContextVar("skill_catalog", default=None)
keydex_snapshot_var: ContextVar[Any | None] = ContextVar("keydex_snapshot", default=None)
event_dispatcher_var: ContextVar[Any | None] = ContextVar("event_dispatcher", default=None)
a2ui_stream_context_var: ContextVar[dict[str, list[dict[str, Any]]] | None] = ContextVar(
    "a2ui_stream_context",
    default=None,
)
a2ui_resume_context_var: ContextVar[Any | None] = ContextVar(
    "a2ui_resume_context",
    default=None,
)


@dataclass(frozen=True)
class RequestContextToken:
    trace_id: Token[str] | None = None
    session_id: Token[str] | None = None
    active_session_id: Token[str] | None = None
    user_id: Token[str] | None = None
    turn_index: Token[int | None] | None = None
    user_message: Token[str | None] | None = None
    tool_call_preset: Token[Any | None] | None = None
    skill_catalog: Token[Any | None] | None = None
    keydex_snapshot: Token[Any | None] | None = None
    event_dispatcher: Token[Any | None] | None = None
    a2ui_stream_context: Token[dict[str, list[dict[str, Any]]] | None] | None = None
    a2ui_resume_context: Token[Any | None] | None = None


@dataclass
class _ToolCallPresetSlot:
    preset: Any
    consumed: bool = False


def set_request_context(
    *,
    trace_id: str | None = None,
    session_id: str | None = None,
    active_session_id: str | None = None,
    user_id: str | None = None,
    turn_index: int | None = None,
    user_message: str | None = None,
    tool_call_preset: ToolCallPreset | None = None,
    skill_catalog: EffectiveSkillCatalog | SkillCatalog | None = None,
    keydex_snapshot: (
        KeydexEffectiveSnapshot
        | KeydexEffectiveRuntimeSnapshot
        | KeydexWorkspaceRuntimeSnapshot
        | None
    ) = None,
    event_dispatcher: EventDispatcher | None = None,
) -> RequestContextToken:
    should_reset_a2ui_context = trace_id is not None or session_id is not None
    return RequestContextToken(
        trace_id=trace_id_var.set(trace_id) if trace_id is not None else None,
        session_id=session_id_var.set(session_id) if session_id is not None else None,
        active_session_id=active_session_id_var.set(active_session_id)
        if active_session_id is not None
        else None,
        user_id=user_id_var.set(user_id) if user_id is not None else None,
        turn_index=turn_index_var.set(turn_index) if turn_index is not None else None,
        user_message=user_message_var.set(user_message)
        if user_message is not None
        else None,
        tool_call_preset=tool_call_preset_var.set(_ToolCallPresetSlot(tool_call_preset))
        if tool_call_preset is not None
        else None,
        skill_catalog=skill_catalog_var.set(skill_catalog) if skill_catalog is not None else None,
        keydex_snapshot=keydex_snapshot_var.set(keydex_snapshot)
        if keydex_snapshot is not None
        else None,
        event_dispatcher=event_dispatcher_var.set(event_dispatcher)
        if event_dispatcher is not None
        else None,
        a2ui_stream_context=a2ui_stream_context_var.set({})
        if should_reset_a2ui_context
        else None,
        a2ui_resume_context=a2ui_resume_context_var.set(None)
        if should_reset_a2ui_context
        else None,
    )


def reset_request_context(token: RequestContextToken) -> None:
    if token.a2ui_resume_context is not None:
        a2ui_resume_context_var.reset(token.a2ui_resume_context)
    if token.a2ui_stream_context is not None:
        a2ui_stream_context_var.reset(token.a2ui_stream_context)
    if token.event_dispatcher is not None:
        event_dispatcher_var.reset(token.event_dispatcher)
    if token.keydex_snapshot is not None:
        keydex_snapshot_var.reset(token.keydex_snapshot)
    if token.skill_catalog is not None:
        skill_catalog_var.reset(token.skill_catalog)
    if token.tool_call_preset is not None:
        tool_call_preset_var.reset(token.tool_call_preset)
    if token.user_id is not None:
        user_id_var.reset(token.user_id)
    if token.user_message is not None:
        user_message_var.reset(token.user_message)
    if token.turn_index is not None:
        turn_index_var.reset(token.turn_index)
    if token.active_session_id is not None:
        active_session_id_var.reset(token.active_session_id)
    if token.session_id is not None:
        session_id_var.reset(token.session_id)
    if token.trace_id is not None:
        trace_id_var.reset(token.trace_id)


def get_trace_id() -> str:
    return trace_id_var.get()


def get_session_id() -> str:
    return session_id_var.get()


def get_active_session_id() -> str:
    return active_session_id_var.get() or session_id_var.get()


def get_user_id() -> str:
    return user_id_var.get()


def get_turn_index() -> int | None:
    return turn_index_var.get()


def get_user_message() -> str | None:
    return user_message_var.get()


def set_tool_call_preset(preset: ToolCallPreset) -> Token[Any | None]:
    return tool_call_preset_var.set(_ToolCallPresetSlot(preset))


def get_tool_call_preset() -> ToolCallPreset | None:
    value = tool_call_preset_var.get()
    if isinstance(value, _ToolCallPresetSlot):
        return None if value.consumed else value.preset
    return value


def consume_tool_call_preset() -> ToolCallPreset | None:
    value = tool_call_preset_var.get()
    if isinstance(value, _ToolCallPresetSlot):
        if value.consumed:
            return None
        value.consumed = True
        tool_call_preset_var.set(None)
        return value.preset
    if value is not None:
        tool_call_preset_var.set(None)
    return value


def get_skill_catalog() -> EffectiveSkillCatalog | SkillCatalog | None:
    from backend.app.keydex.capabilities.skills.consumer import effective_skill_catalog

    snapshot_catalog = effective_skill_catalog(keydex_snapshot_var.get())
    if snapshot_catalog is not None:
        return snapshot_catalog
    return skill_catalog_var.get()


def get_keydex_snapshot() -> (
    KeydexEffectiveSnapshot | KeydexEffectiveRuntimeSnapshot | KeydexWorkspaceRuntimeSnapshot | None
):
    return keydex_snapshot_var.get()


def get_keydex_capability(key: CapabilityKey[CapabilityPayloadT]) -> CapabilityPayloadT | None:
    snapshot = keydex_snapshot_var.get()
    getter = getattr(snapshot, "get", None)
    if not callable(getter):
        return None
    return getter(key)


def get_event_dispatcher() -> EventDispatcher | None:
    return event_dispatcher_var.get()


def register_a2ui_stream_context(render_key: str, value: dict[str, Any]) -> None:
    normalized_key = str(render_key or "").strip()
    if not normalized_key:
        return
    current = {
        key: list(items or [])
        for key, items in (a2ui_stream_context_var.get() or {}).items()
    }
    current.setdefault(normalized_key, []).append(dict(value or {}))
    a2ui_stream_context_var.set(current)


def consume_a2ui_stream_context(
    render_key: str,
    *,
    tool_call_id: str | None = None,
    run_id: str | None = None,
) -> dict[str, Any] | None:
    normalized_key = str(render_key or "").strip()
    if not normalized_key:
        return None
    current = {
        key: list(items or [])
        for key, items in (a2ui_stream_context_var.get() or {}).items()
    }
    queue = current.get(normalized_key) or []
    if not queue:
        return None

    normalized_tool_call_id = str(tool_call_id or "").strip()
    normalized_run_id = str(run_id or "").strip()
    matched_index: int | None = None
    if normalized_tool_call_id:
        for index, item in enumerate(queue):
            if str((item or {}).get("tool_call_id") or "").strip() == normalized_tool_call_id:
                matched_index = index
                break
    elif normalized_run_id:
        for index, item in enumerate(queue):
            if str((item or {}).get("run_id") or "").strip() == normalized_run_id:
                matched_index = index
                break
    else:
        matched_index = 0

    if matched_index is None:
        return None

    value = dict(queue.pop(matched_index) or {})
    if queue:
        current[normalized_key] = queue
    else:
        current.pop(normalized_key, None)
    a2ui_stream_context_var.set(current)
    return value


def discard_a2ui_stream_context(
    render_key: str,
    *,
    tool_call_id: str | None = None,
    run_id: str | None = None,
) -> int:
    normalized_key = str(render_key or "").strip()
    normalized_tool_call_id = str(tool_call_id or "").strip()
    normalized_run_id = str(run_id or "").strip()
    if not normalized_key or (not normalized_tool_call_id and not normalized_run_id):
        return 0
    current = {
        key: list(items or [])
        for key, items in (a2ui_stream_context_var.get() or {}).items()
    }
    queue = current.get(normalized_key) or []
    remaining: list[dict[str, Any]] = []
    removed = 0
    for item in queue:
        item_tool_call_id = str((item or {}).get("tool_call_id") or "").strip()
        item_run_id = str((item or {}).get("run_id") or "").strip()
        matches = (
            item_tool_call_id == normalized_tool_call_id
            if normalized_tool_call_id
            else item_run_id == normalized_run_id
        )
        if matches:
            removed += 1
        else:
            remaining.append(item)
    if remaining:
        current[normalized_key] = remaining
    else:
        current.pop(normalized_key, None)
    a2ui_stream_context_var.set(current)
    return removed


def clear_a2ui_stream_context() -> None:
    a2ui_stream_context_var.set({})


def set_a2ui_resume_context(value: Any | None) -> Token[Any | None]:
    return a2ui_resume_context_var.set(value)


def reset_a2ui_resume_context(token: Token[Any | None]) -> None:
    a2ui_resume_context_var.reset(token)


def consume_a2ui_resume_payload(
    render_key: str,
    *,
    tool_call_id: str | None = None,
) -> dict[str, Any] | None:
    normalized_key = str(render_key or "").strip()
    if not normalized_key:
        return None
    context = a2ui_resume_context_var.get()
    consume = getattr(context, "consume", None)
    if not callable(consume):
        return None
    payload = consume(render_key=normalized_key, tool_call_id=tool_call_id)
    return dict(payload) if isinstance(payload, dict) else None


def clear_a2ui_resume_context() -> None:
    a2ui_resume_context_var.set(None)
