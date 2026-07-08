from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from backend.app.storage import (
    McpServerRecord,
    McpServerStatusRecord,
    McpSessionToolOverrideRecord,
    McpToolPolicyRecord,
    McpToolRecord,
)


@dataclass(frozen=True)
class McpVisibleTool:
    server_id: str
    raw_name: str
    model_name: str
    description: str | None
    input_schema: dict[str, Any]
    approval_mode: str
    annotations: dict[str, Any] | None = None
    server_name: str | None = None
    priority_available: bool = False

    def to_model_contract(self) -> dict[str, Any]:
        return {
            "server_id": self.server_id,
            "server_name": self.server_name,
            "raw_name": self.raw_name,
            "model_name": self.model_name,
            "description": self.description,
            "input_schema": self.input_schema,
            "priority_available": self.priority_available,
        }


@dataclass(frozen=True)
class McpHiddenTool:
    server_id: str
    raw_name: str
    model_name: str
    reason: str


@dataclass(frozen=True)
class McpExposureResult:
    visible_tools: list[McpVisibleTool]
    hidden_tools: list[McpHiddenTool]

    def model_contracts(self) -> list[dict[str, Any]]:
        return [tool.to_model_contract() for tool in self.visible_tools]


@dataclass(frozen=True)
class McpExposurePlan:
    availability: str
    direct_tools: list[McpVisibleTool]
    on_demand_tools: list[McpVisibleTool]
    has_on_demand_catalog: bool


class McpDirectInjectionPlanner:
    def __init__(
        self,
        *,
        direct_tool_budget: int,
        force_on_demand: bool = False,
    ) -> None:
        self.direct_tool_budget = max(1, direct_tool_budget)
        self.force_on_demand = force_on_demand

    def plan(
        self,
        exposure: McpExposureResult,
        *,
        active_model_names: set[str] | None = None,
        recent_model_names: Sequence[str] | None = None,
        priority_model_names: Sequence[str] | None = None,
    ) -> McpExposurePlan:
        if not self.force_on_demand and len(exposure.visible_tools) <= self.direct_tool_budget:
            return McpExposurePlan(
                availability="direct",
                direct_tools=list(exposure.visible_tools),
                on_demand_tools=[],
                has_on_demand_catalog=False,
            )
        if self.force_on_demand:
            return McpExposurePlan(
                availability="with_on_demand_catalog",
                direct_tools=[],
                on_demand_tools=list(exposure.visible_tools),
                has_on_demand_catalog=bool(exposure.visible_tools),
            )
        # Over-budget servers do not prefill the direct list. Only tools explicitly
        # activated by the discovery entry become directly callable, capped by the
        # same direct-tool budget.
        active = active_model_names or set()
        direct_tools: list[McpVisibleTool] = []
        for tool in exposure.visible_tools:
            if tool.model_name not in active:
                continue
            direct_tools.append(tool)
            if len(direct_tools) >= self.direct_tool_budget:
                break
        direct_model_names = {tool.model_name for tool in direct_tools}
        on_demand_tools = [
            tool
            for tool in exposure.visible_tools
            if tool.model_name not in direct_model_names
        ]
        return McpExposurePlan(
            availability="with_on_demand_catalog",
            direct_tools=direct_tools,
            on_demand_tools=on_demand_tools,
            has_on_demand_catalog=bool(on_demand_tools),
        )


class McpToolExposureResolver:
    def resolve(
        self,
        *,
        servers: Sequence[McpServerRecord],
        statuses: Mapping[str, McpServerStatusRecord | str],
        tools: Sequence[McpToolRecord],
        policies: Sequence[McpToolPolicyRecord] = (),
        session_overrides: Sequence[McpSessionToolOverrideRecord] = (),
    ) -> McpExposureResult:
        server_by_id = {server.id: server for server in servers}
        policy_by_key = {
            (policy.server_id, policy.raw_tool_name): policy for policy in policies
        }
        override_by_key = {
            (override.server_id, override.raw_tool_name): override
            for override in session_overrides
        }
        visible: list[McpVisibleTool] = []
        hidden: list[McpHiddenTool] = []
        for tool in tools:
            server = server_by_id.get(tool.server_id)
            policy = policy_by_key.get((tool.server_id, tool.raw_name))
            override = override_by_key.get((tool.server_id, tool.raw_name))
            reason = self._hidden_reason(
                server=server,
                status=statuses.get(tool.server_id),
                tool=tool,
                policy=policy,
                override=override,
            )
            if reason is not None:
                hidden.append(
                    McpHiddenTool(
                        server_id=tool.server_id,
                        raw_name=tool.raw_name,
                        model_name=tool.model_name,
                        reason=reason,
                    )
                )
                continue
            visible.append(_visible_tool(server, tool, policy))
        return McpExposureResult(visible_tools=visible, hidden_tools=hidden)

    def _hidden_reason(
        self,
        *,
        server: McpServerRecord | None,
        status: McpServerStatusRecord | str | None,
        tool: McpToolRecord,
        policy: McpToolPolicyRecord | None,
        override: McpSessionToolOverrideRecord | None,
    ) -> str | None:
        if server is None:
            return "server_missing"
        if not server.enabled:
            return "server_disabled"
        if _status_value(status) != "online":
            return "server_not_online"
        if tool.discovery_status == "removed":
            return "tool_removed"
        if policy is not None and policy.hidden:
            return "tool_hidden"
        if policy is not None and not policy.enabled:
            return "tool_disabled_by_policy"
        if override is not None and not override.enabled:
            return "tool_disabled_for_session"
        if not _is_model_visible(tool.meta):
            return "tool_hidden_from_model"
        return _default_mode_hidden_reason(server, tool, policy, override)


def _visible_tool(
    server: McpServerRecord,
    tool: McpToolRecord,
    policy: McpToolPolicyRecord | None,
) -> McpVisibleTool:
    approval_mode = (
        policy.approval_mode if policy is not None else server.default_tool_approval_mode
    )
    return McpVisibleTool(
        server_id=tool.server_id,
        server_name=server.name,
        raw_name=tool.raw_name,
        model_name=tool.model_name,
        description=tool.description,
        input_schema=tool.input_schema,
        annotations=tool.annotations,
        approval_mode=approval_mode,
        priority_available=policy.priority_available if policy is not None else False,
    )


def _default_mode_hidden_reason(
    server: McpServerRecord,
    tool: McpToolRecord,
    policy: McpToolPolicyRecord | None,
    override: McpSessionToolOverrideRecord | None,
) -> str | None:
    if override is not None and override.enabled:
        return None
    if policy is not None and policy.enabled:
        return None
    if server.default_tool_exposure_mode == "allow_all_except_disabled":
        return None
    if server.default_tool_exposure_mode == "allow_selected_only":
        return "tool_not_selected"
    return "unknown_exposure_mode"


def _status_value(status: McpServerStatusRecord | str | None) -> str | None:
    if isinstance(status, McpServerStatusRecord):
        return status.status
    return status


def _is_model_visible(meta: dict[str, Any] | None) -> bool:
    visibility = _visibility_value(meta or {})
    if visibility is None:
        return True
    if isinstance(visibility, str):
        return visibility == "model"
    if isinstance(visibility, list):
        return "model" in visibility
    return False


def _visibility_value(meta: dict[str, Any]) -> Any:
    nested_meta = meta.get("_meta")
    if isinstance(nested_meta, dict):
        nested_ui = nested_meta.get("ui")
        if isinstance(nested_ui, dict) and "visibility" in nested_ui:
            return nested_ui["visibility"]
    ui = meta.get("ui")
    if isinstance(ui, dict) and "visibility" in ui:
        return ui["visibility"]
    return None
