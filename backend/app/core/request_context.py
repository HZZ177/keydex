from __future__ import annotations

from contextvars import ContextVar, Token
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from backend.app.agent.tool_call_preset import ToolCallPreset
    from backend.app.keydex.runtime import KeydexWorkspaceRuntimeSnapshot
    from backend.app.keydex.skills import SkillCatalog

trace_id_var: ContextVar[str] = ContextVar("trace_id", default="")
session_id_var: ContextVar[str] = ContextVar("session_id", default="")
active_session_id_var: ContextVar[str] = ContextVar("active_session_id", default="")
user_id_var: ContextVar[str] = ContextVar("user_id", default="")
tool_call_preset_var: ContextVar[Any | None] = ContextVar("tool_call_preset", default=None)
skill_catalog_var: ContextVar[Any | None] = ContextVar("skill_catalog", default=None)
keydex_snapshot_var: ContextVar[Any | None] = ContextVar("keydex_snapshot", default=None)


@dataclass(frozen=True)
class RequestContextToken:
    trace_id: Token[str] | None = None
    session_id: Token[str] | None = None
    active_session_id: Token[str] | None = None
    user_id: Token[str] | None = None
    tool_call_preset: Token[Any | None] | None = None
    skill_catalog: Token[Any | None] | None = None
    keydex_snapshot: Token[Any | None] | None = None


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
    tool_call_preset: ToolCallPreset | None = None,
    skill_catalog: SkillCatalog | None = None,
    keydex_snapshot: KeydexWorkspaceRuntimeSnapshot | None = None,
) -> RequestContextToken:
    return RequestContextToken(
        trace_id=trace_id_var.set(trace_id) if trace_id is not None else None,
        session_id=session_id_var.set(session_id) if session_id is not None else None,
        active_session_id=active_session_id_var.set(active_session_id)
        if active_session_id is not None
        else None,
        user_id=user_id_var.set(user_id) if user_id is not None else None,
        tool_call_preset=tool_call_preset_var.set(_ToolCallPresetSlot(tool_call_preset))
        if tool_call_preset is not None
        else None,
        skill_catalog=skill_catalog_var.set(skill_catalog) if skill_catalog is not None else None,
        keydex_snapshot=keydex_snapshot_var.set(keydex_snapshot)
        if keydex_snapshot is not None
        else None,
    )


def reset_request_context(token: RequestContextToken) -> None:
    if token.keydex_snapshot is not None:
        keydex_snapshot_var.reset(token.keydex_snapshot)
    if token.skill_catalog is not None:
        skill_catalog_var.reset(token.skill_catalog)
    if token.tool_call_preset is not None:
        tool_call_preset_var.reset(token.tool_call_preset)
    if token.user_id is not None:
        user_id_var.reset(token.user_id)
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


def get_skill_catalog() -> SkillCatalog | None:
    return skill_catalog_var.get()


def get_keydex_snapshot() -> KeydexWorkspaceRuntimeSnapshot | None:
    return keydex_snapshot_var.get()
