from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from backend.app.core.ids import new_id
from backend.app.mcp.audit import McpAuditWriter
from backend.app.mcp.errors import McpRuntimeError
from backend.app.mcp.exposure import (
    McpDeferredExposurePlanner,
    McpToolExposureResolver,
    McpVisibleTool,
)
from backend.app.mcp.types import McpErrorCode
from backend.app.storage import (
    McpRuntimeSnapshotRecord,
    McpServerRecord,
    McpServerStatusRecord,
    McpToolRecord,
    StorageRepositories,
)


@dataclass(frozen=True)
class McpRuntimeSnapshotContext:
    session_id: str
    turn_id: str | None = None
    workspace_session: bool = True
    active_model_names: set[str] = field(default_factory=set)


class McpRuntimeSnapshotBuilder:
    def __init__(
        self,
        repositories: StorageRepositories,
        *,
        deferred_threshold: int,
    ) -> None:
        self.repositories = repositories
        self.deferred_threshold = deferred_threshold

    def build_snapshot(
        self,
        context: McpRuntimeSnapshotContext,
    ) -> McpRuntimeSnapshotRecord:
        servers, _total = self.repositories.mcp_servers.list(enabled=True, limit=500)
        statuses = _status_by_server(self.repositories, servers)
        self._raise_for_required_server_failures(servers, statuses)
        if not context.workspace_session:
            return self._save_snapshot(
                context,
                servers=servers,
                statuses=statuses,
                visible_tools=[],
                policy_summary={"workspace_session": False, "mode": "disabled"},
            )

        tools = []
        policies = []
        for server in servers:
            tools.extend(self.repositories.mcp_tools.list_by_server(server.id))
            policies.extend(self.repositories.mcp_tool_policies.list_by_server(server.id))
        exposure = McpToolExposureResolver().resolve(
            servers=servers,
            statuses=statuses,
            tools=tools,
            policies=policies,
            session_overrides=self.repositories.mcp_session_tool_overrides.list_by_session(
                context.session_id
            ),
        )
        plan = McpDeferredExposurePlanner(
            direct_threshold=self.deferred_threshold
        ).plan(exposure, active_model_names=context.active_model_names)
        visible_tools = [
            _contract(tool, exposure="direct") for tool in plan.direct_tools
        ] + [_contract(tool, exposure="deferred") for tool in plan.deferred_tools]
        return self._save_snapshot(
            context,
            servers=servers,
            statuses=statuses,
            visible_tools=visible_tools,
            policy_summary={
                "workspace_session": True,
                "mode": plan.mode,
                "direct_tools": len(plan.direct_tools),
                "deferred_tools": len(plan.deferred_tools),
                "hidden_tools": len(exposure.hidden_tools),
                "include_search_tool": plan.include_search_tool,
                "include_list_tool": plan.include_list_tool,
            },
        )

    def _save_snapshot(
        self,
        context: McpRuntimeSnapshotContext,
        *,
        servers: list[McpServerRecord],
        statuses: dict[str, McpServerStatusRecord | None],
        visible_tools: list[dict[str, Any]],
        policy_summary: dict[str, Any],
    ) -> McpRuntimeSnapshotRecord:
        return self.repositories.mcp_runtime_snapshots.save(
            snapshot_id=new_id(),
            session_id=context.session_id,
            turn_id=context.turn_id,
            tool_inventory_revision=_tool_inventory_revision(statuses),
            visible_tools=visible_tools,
            server_status=_server_status_payload(servers, statuses),
            policy_summary=policy_summary,
        )

    def _raise_for_required_server_failures(
        self,
        servers: list[McpServerRecord],
        statuses: dict[str, McpServerStatusRecord | None],
    ) -> None:
        for server in servers:
            if not server.required:
                continue
            status = statuses.get(server.id)
            status_value = status.status if status is not None else "unknown"
            if status_value == "online":
                continue
            code = (
                McpErrorCode.AUTH_REQUIRED
                if status_value == "auth_required"
                else McpErrorCode.SERVER_OFFLINE
            )
            raise McpRuntimeError(
                code,
                detail={"server_id": server.id, "server_status": status_value},
            )


def _status_by_server(
    repositories: StorageRepositories,
    servers: list[McpServerRecord],
) -> dict[str, McpServerStatusRecord | None]:
    return {server.id: repositories.mcp_server_status.get(server.id) for server in servers}


def _contract(tool: McpVisibleTool, *, exposure: str) -> dict[str, Any]:
    contract = tool.to_model_contract()
    contract["exposure"] = exposure
    contract["approval_mode"] = tool.approval_mode
    return contract


def _tool_inventory_revision(statuses: dict[str, McpServerStatusRecord | None]) -> int:
    return max(
        (status.last_refresh_revision for status in statuses.values() if status is not None),
        default=0,
    )


def _server_status_payload(
    servers: list[McpServerRecord],
    statuses: dict[str, McpServerStatusRecord | None],
) -> dict[str, Any]:
    payload: dict[str, Any] = {}
    for server in servers:
        status = statuses.get(server.id)
        payload[server.id] = {
            "status": status.status if status is not None else "unknown",
            "required": server.required,
            "enabled": server.enabled,
            "last_error_code": status.last_error_code if status is not None else None,
            }
    return payload


@dataclass(frozen=True)
class McpAllowedToolExecution:
    session_id: str
    server_id: str
    raw_tool_name: str
    model_name: str
    tool: McpToolRecord


class McpLiveExecutionGuard:
    def __init__(
        self,
        repositories: StorageRepositories,
        *,
        audit_writer: McpAuditWriter | None = None,
    ) -> None:
        self.repositories = repositories
        self.audit_writer = audit_writer or McpAuditWriter.from_repositories(repositories)

    def assert_allowed(
        self,
        *,
        session_id: str,
        server_id: str,
        raw_tool_name: str,
    ) -> McpAllowedToolExecution:
        server = self.repositories.mcp_servers.get(server_id)
        if server is None:
            self._reject(
                session_id=session_id,
                server_id=server_id,
                raw_tool_name=raw_tool_name,
                code=McpErrorCode.SERVER_NOT_FOUND,
                reason="server_missing",
            )
        tool = self.repositories.mcp_tools.get_by_raw_name(server_id, raw_tool_name)
        if tool is None:
            self._reject(
                session_id=session_id,
                server_id=server_id,
                raw_tool_name=raw_tool_name,
                code=McpErrorCode.TOOL_NOT_FOUND,
                reason="tool_missing",
            )
        status = self.repositories.mcp_server_status.get(server_id)
        policy = self.repositories.mcp_tool_policies.get(server_id, raw_tool_name)
        override = self.repositories.mcp_session_tool_overrides.get(
            session_id,
            server_id,
            raw_tool_name,
        )
        exposure = McpToolExposureResolver().resolve(
            servers=[server],
            statuses={server_id: status},
            tools=[tool],
            policies=[policy] if policy is not None else [],
            session_overrides=[override] if override is not None else [],
        )
        if exposure.visible_tools:
            visible = exposure.visible_tools[0]
            return McpAllowedToolExecution(
                session_id=session_id,
                server_id=server_id,
                raw_tool_name=raw_tool_name,
                model_name=visible.model_name,
                tool=tool,
            )
        reason = exposure.hidden_tools[0].reason if exposure.hidden_tools else "not_visible"
        self._reject(
            session_id=session_id,
            server_id=server_id,
            raw_tool_name=raw_tool_name,
            code=_guard_error_code(reason, status.status if status is not None else None),
            reason=reason,
        )

    def _reject(
        self,
        *,
        session_id: str,
        server_id: str,
        raw_tool_name: str,
        code: McpErrorCode,
        reason: str,
    ) -> None:
        detail = {
            "server_id": server_id,
            "raw_tool_name": raw_tool_name,
            "reason": reason,
            "error_code": code.value,
        }
        self.audit_writer.append_event(
            event_type="tool.guard_rejected",
            server_id=server_id,
            raw_tool_name=raw_tool_name,
            session_id=session_id,
            status="rejected",
            summary="MCP tool execution rejected by live guard",
            detail=detail,
        )
        raise McpRuntimeError(code, detail=detail)


def _guard_error_code(reason: str, status: str | None) -> McpErrorCode:
    if reason == "server_disabled":
        return McpErrorCode.SERVER_DISABLED
    if status == "auth_required":
        return McpErrorCode.AUTH_REQUIRED
    if reason == "server_not_online":
        return McpErrorCode.SERVER_OFFLINE
    if reason == "tool_disabled_for_session":
        return McpErrorCode.TOOL_DISABLED_BY_SESSION
    if reason == "tool_removed":
        return McpErrorCode.TOOL_NOT_FOUND
    return McpErrorCode.TOOL_DISABLED_BY_POLICY
