from __future__ import annotations

from collections.abc import Collection, Mapping
from enum import StrEnum
from typing import Any


class ToolCapability(StrEnum):
    """Turn-scoped tool groups understood by the agent assembly seam."""

    WORKSPACE = "workspace"
    SKILL = "skill"
    WEB = "web"


ToolCapabilitySet = frozenset[ToolCapability]

LEGACY_ENABLED_CAPABILITIES: ToolCapabilitySet = frozenset(
    {ToolCapability.WORKSPACE, ToolCapability.SKILL}
)


def normalize_tool_capabilities(
    values: Collection[ToolCapability | str],
) -> ToolCapabilitySet:
    try:
        return frozenset(ToolCapability(str(value)) for value in values)
    except ValueError as exc:
        raise ValueError(f"未知工具能力: {exc.args[0]}") from exc


def resolve_tool_capabilities(
    *,
    explicit: Collection[ToolCapability | str] | None,
    metadata: Mapping[str, Any],
    enable_tools: bool,
    legacy_workspace_override: bool | None = None,
    legacy_skill_override: bool | None = None,
) -> ToolCapabilitySet:
    """Resolve one immutable capability snapshot for the current turn.

    ``enable_tools`` and the two legacy overrides only preserve existing callers.
    New call sites should pass ``explicit`` or ``metadata['tool_capabilities']``.
    """

    if explicit is not None:
        return normalize_tool_capabilities(explicit)

    metadata_value = metadata.get("tool_capabilities")
    if isinstance(metadata_value, (list, tuple, set, frozenset)):
        return normalize_tool_capabilities(metadata_value)

    resolved = set(LEGACY_ENABLED_CAPABILITIES if enable_tools else ())
    workspace_override = (
        legacy_workspace_override
        if legacy_workspace_override is not None
        else _optional_bool(metadata.get("enable_workspace_tools"))
    )
    skill_override = (
        legacy_skill_override
        if legacy_skill_override is not None
        else _optional_bool(metadata.get("enable_skill_tools"))
    )
    _apply_override(resolved, ToolCapability.WORKSPACE, workspace_override)
    _apply_override(resolved, ToolCapability.SKILL, skill_override)
    return frozenset(resolved)


def capability_for_runtime_tool(tool_name: str) -> ToolCapability:
    if tool_name in {"web_search", "web_fetch"}:
        return ToolCapability.WEB
    return ToolCapability.WORKSPACE


def _optional_bool(value: Any) -> bool | None:
    return value if isinstance(value, bool) else None


def _apply_override(
    capabilities: set[ToolCapability],
    capability: ToolCapability,
    enabled: bool | None,
) -> None:
    if enabled is True:
        capabilities.add(capability)
    elif enabled is False:
        capabilities.discard(capability)
