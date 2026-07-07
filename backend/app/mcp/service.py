from __future__ import annotations

import time
from contextlib import suppress
from dataclasses import asdict
from typing import Any

from backend.app.core.ids import new_id
from backend.app.core.time import to_iso_z, utc_now
from backend.app.mcp.audit import McpAuditWriter
from backend.app.mcp.client import status_from_mcp_error_code
from backend.app.mcp.errors import McpRuntimeError, to_mcp_runtime_error
from backend.app.mcp.exposure import McpToolExposureResolver
from backend.app.mcp.manager import McpManager
from backend.app.mcp.types import McpServerCreateRequest, McpServerUpdateRequest
from backend.app.storage import (
    McpRuntimeSnapshotRecord,
    McpServerRecord,
    McpServerStatusRecord,
    McpSessionToolOverrideRecord,
    McpToolPolicyRecord,
    McpToolRecord,
    StorageRepositories,
)


class McpServiceError(RuntimeError):
    def __init__(self, message: str, *, code: str = "mcp_service_error") -> None:
        super().__init__(message)
        self.code = code


def list_mcp_servers(
    repositories: StorageRepositories,
    *,
    enabled: bool | None = None,
    transport: str | None = None,
    limit: int = 100,
    offset: int = 0,
) -> dict[str, Any]:
    servers, total = repositories.mcp_servers.list(
        enabled=enabled,
        transport=transport,
        limit=limit,
        offset=offset,
    )
    return {
        "list": [server_payload(repositories, server, detail=False) for server in servers],
        "total": total,
        "limit": max(1, min(limit, 500)),
        "offset": max(0, offset),
    }


def create_mcp_server(
    repositories: StorageRepositories,
    payload: McpServerCreateRequest,
) -> dict[str, Any]:
    server = repositories.mcp_servers.create(
        server_id=new_id(),
        **payload.model_dump(mode="json"),
    )
    return server_payload(repositories, server)


def get_mcp_server(
    repositories: StorageRepositories,
    server_id: str,
) -> dict[str, Any]:
    return server_payload(repositories, require_mcp_server(repositories, server_id))


def update_mcp_server(
    repositories: StorageRepositories,
    server_id: str,
    payload: McpServerUpdateRequest,
) -> dict[str, Any]:
    changes = payload.model_dump(mode="json", exclude_unset=True)
    if "name" in changes and isinstance(changes["name"], str):
        changes["name"] = changes["name"].strip()
    server = repositories.mcp_servers.update(server_id, **changes)
    if server is None:
        raise McpServiceError("MCP server 不存在", code="server_not_found")
    return server_payload(repositories, server)


def set_mcp_server_enabled(
    repositories: StorageRepositories,
    server_id: str,
    enabled: bool,
) -> dict[str, Any]:
    server = repositories.mcp_servers.set_enabled(server_id, enabled)
    if server is None:
        raise McpServiceError("MCP server 不存在", code="server_not_found")
    status = "unknown" if enabled else "disabled"
    repositories.mcp_server_status.upsert(server_id, status=status)
    return server_payload(repositories, server)


def delete_mcp_server(repositories: StorageRepositories, server_id: str) -> dict[str, Any]:
    deleted = repositories.mcp_servers.delete(server_id)
    if not deleted:
        raise McpServiceError("MCP server 不存在", code="server_not_found")
    return {"deleted": True, "server_id": server_id}


def list_mcp_tools(
    repositories: StorageRepositories,
    server_id: str,
    *,
    status: str | None = None,
    enabled: bool | None = None,
    search: str | None = None,
    limit: int = 500,
) -> dict[str, Any]:
    server = require_mcp_server(repositories, server_id)
    tools = repositories.mcp_tools.list_by_server(
        server_id,
        status=status,
        enabled=enabled,
        limit=1000,
    )
    policies = {
        policy.raw_tool_name: policy
        for policy in repositories.mcp_tool_policies.list_by_server(server_id)
    }
    filtered: list[dict[str, Any]] = []
    for tool in tools:
        payload = tool_payload(server, tool, policies.get(tool.raw_name))
        if search and not _matches_search(
            search,
            tool.raw_name,
            tool.model_name,
            tool.display_name,
            tool.description,
        ):
            continue
        filtered.append(payload)
    resolved_limit = max(1, min(limit, 1000))
    return {"list": filtered[:resolved_limit], "total": len(filtered), "limit": resolved_limit}


def update_mcp_tool_policy(
    repositories: StorageRepositories,
    server_id: str,
    tool_id: str,
    changes: dict[str, Any],
) -> dict[str, Any]:
    server = require_mcp_server(repositories, server_id)
    tool = require_mcp_tool(repositories, server_id, tool_id)
    values = _tool_policy_values(
        repositories.mcp_tool_policies.get(server_id, tool.raw_name)
    )
    values.update({key: value for key, value in changes.items() if value is not None})
    policy = repositories.mcp_tool_policies.upsert(
        server_id=server_id,
        raw_tool_name=tool.raw_name,
        **values,
    )
    McpAuditWriter.from_repositories(repositories).append_event(
        event_type="tool.policy_updated",
        server_id=server_id,
        raw_tool_name=tool.raw_name,
        actor="user",
        status="ok",
        summary=f"MCP tool policy updated: {tool.raw_name}",
        detail={
            "tool_id": tool.id,
            "changes": changes,
            "policy": _tool_policy_values(policy),
        },
    )
    return tool_payload(server, tool, policy)


def apply_mcp_tool_bulk_policy(
    repositories: StorageRepositories,
    server_id: str,
    *,
    action: str,
    tool_ids: list[str] | None = None,
    raw_tool_names: list[str] | None = None,
) -> dict[str, Any]:
    server = require_mcp_server(repositories, server_id)
    tools = repositories.mcp_tools.list_by_server(server_id, limit=1000)
    selected_raw_names = _resolve_tool_identifiers(
        tools,
        tool_ids=tool_ids or [],
        raw_tool_names=raw_tool_names or [],
    )
    if (
        action in {"enable_selected", "disable_selected", "keep_selected_only"}
        and not selected_raw_names
    ):
        raise McpServiceError("批量工具策略需要至少选择一个 tool", code="tool_selection_required")
    updates: list[dict[str, Any]] = []
    for tool in tools:
        values = _tool_policy_values(
            repositories.mcp_tool_policies.get(server_id, tool.raw_name)
        )
        should_update = False
        if action == "enable_selected" and tool.raw_name in selected_raw_names:
            values["enabled"] = True
            should_update = True
        elif action == "disable_selected" and tool.raw_name in selected_raw_names:
            values["enabled"] = False
            should_update = True
        elif action == "keep_selected_only":
            values["enabled"] = tool.raw_name in selected_raw_names
            should_update = True
        elif action == "prompt_all":
            values["approval_mode"] = "prompt"
            should_update = True
        elif action not in _BULK_TOOL_POLICY_ACTIONS:
            raise McpServiceError(f"不支持的批量工具策略动作: {action}", code="invalid_bulk_action")
        if should_update:
            updates.append({"raw_tool_name": tool.raw_name, **values})
    repositories.mcp_tool_policies.bulk_update(server_id, updates)
    refreshed = list_mcp_tools(repositories, server_id, limit=1000)["list"]
    return {
        "server_id": server.id,
        "action": action,
        "updated_count": len(updates),
        "tools": refreshed,
    }


def get_mcp_runtime_status(
    manager: McpManager,
    *,
    session_id: str,
) -> dict[str, Any]:
    repositories = manager.repositories
    servers, _total = repositories.mcp_servers.list(limit=500)
    overrides = repositories.mcp_session_tool_overrides.list_by_session(session_id)
    override_by_key = {
        (override.server_id, override.raw_tool_name): override for override in overrides
    }
    snapshots = repositories.mcp_runtime_snapshots.list_by_session(session_id, limit=1)
    pending_mcp_approvals = [
        approval
        for approval in repositories.command_approvals.list_pending(session_id=session_id)
        if approval.kind == "mcp_tool_call"
    ]
    tools: list[dict[str, Any]] = []
    for server in servers:
        status = repositories.mcp_server_status.get(server.id)
        policies = {
            policy.raw_tool_name: policy
            for policy in repositories.mcp_tool_policies.list_by_server(server.id)
        }
        for tool in repositories.mcp_tools.list_by_server(server.id, limit=1000):
            tools.append(
                runtime_tool_payload(
                    server=server,
                    status=status,
                    tool=tool,
                    policy=policies.get(tool.raw_name),
                    override=override_by_key.get((server.id, tool.raw_name)),
                )
            )
    running_calls = manager.running_calls(session_id=session_id)
    return {
        "session_id": session_id,
        "manager": manager.status().to_dict(),
        "snapshot": _runtime_snapshot_payload(snapshots[0]) if snapshots else None,
        "servers": [server_payload(repositories, server, detail=False) for server in servers],
        "tools": tools,
        "overrides": [_override_payload(override) for override in overrides],
        "running_calls": running_calls,
        "pending_approvals": len(pending_mcp_approvals),
        "summary": {
            "servers_total": len(servers),
            "servers_online": sum(
                1 for server in servers if _server_status(repositories, server) == "online"
            ),
            "tools_total": len(tools),
            "tools_enabled": sum(1 for tool in tools if tool["effective_state"] == "enabled"),
            "running_calls": len(running_calls),
            "pending_approvals": len(pending_mcp_approvals),
        },
    }


def set_mcp_session_tool_override(
    manager: McpManager,
    *,
    session_id: str,
    server_id: str | None,
    tool_id: str,
    enabled: bool,
    reason: str | None = None,
) -> dict[str, Any]:
    repositories = manager.repositories
    server, tool = resolve_mcp_tool_location(repositories, server_id, tool_id)
    override = repositories.mcp_session_tool_overrides.set(
        session_id=session_id,
        server_id=server.id,
        raw_tool_name=tool.raw_name,
        enabled=enabled,
        reason=reason,
    )
    _append_runtime_override_audit(
        repositories,
        event_type="runtime.override_set",
        session_id=session_id,
        server_id=server.id,
        raw_tool_name=tool.raw_name,
        detail={"enabled": enabled, "reason": reason},
    )
    running = bool(manager.running_calls(session_id=session_id))
    return {
        "session_id": session_id,
        "override": _override_payload(override),
        "tool": runtime_tool_payload(
            server=server,
            status=repositories.mcp_server_status.get(server.id),
            tool=tool,
            policy=repositories.mcp_tool_policies.get(server.id, tool.raw_name),
            override=override,
        ),
        "apply_timing": _override_apply_timing(enabled=enabled, running=running),
        "applies_to_current_run": not enabled,
    }


def clear_mcp_session_tool_override(
    manager: McpManager,
    *,
    session_id: str,
    server_id: str | None,
    tool_id: str,
) -> dict[str, Any]:
    repositories = manager.repositories
    server, tool = resolve_mcp_tool_location(repositories, server_id, tool_id)
    deleted = repositories.mcp_session_tool_overrides.delete(
        session_id,
        server.id,
        tool.raw_name,
    )
    _append_runtime_override_audit(
        repositories,
        event_type="runtime.override_cleared",
        session_id=session_id,
        server_id=server.id,
        raw_tool_name=tool.raw_name,
        detail={"deleted": deleted},
    )
    return {
        "session_id": session_id,
        "deleted": deleted,
        "tool": runtime_tool_payload(
            server=server,
            status=repositories.mcp_server_status.get(server.id),
            tool=tool,
            policy=repositories.mcp_tool_policies.get(server.id, tool.raw_name),
            override=None,
        ),
    }


async def test_mcp_server_connection(
    manager: McpManager,
    server_id: str,
) -> dict[str, Any]:
    server = require_mcp_server(manager.repositories, server_id)
    client = manager.client_factory.create_client(server)
    try:
        result = await client.initialize(timeout_sec=server.startup_timeout_sec)
        manager._record_client_online(server_id, result)
        return {
            "ok": True,
            "server_id": server_id,
            "status": "online",
            "protocol_version": result.protocol_version,
            "server_info": result.server_info,
            "capabilities": asdict(result.capabilities),
        }
    except Exception as exc:
        runtime_error = to_mcp_runtime_error(exc)
        manager._record_client_error(server_id, exc)
        await manager.drop_client(server_id)
        return {
            "ok": False,
            "server_id": server_id,
            "status": status_from_mcp_error_code(runtime_error.code).value,
            "error": runtime_error.to_payload().model_dump(mode="json"),
        }
    finally:
        with suppress(Exception):
            await client.shutdown(timeout_sec=server.shutdown_timeout_sec)


async def test_mcp_server_connection_config(
    manager: McpManager,
    payload: McpServerCreateRequest,
    *,
    base_server_id: str | None = None,
) -> dict[str, Any]:
    server = _temporary_mcp_server_record(
        manager.repositories,
        payload,
        base_server_id=base_server_id,
    )
    client = manager.client_factory.create_client(server)
    started = time.perf_counter()
    try:
        init_result = await client.initialize(timeout_sec=server.startup_timeout_sec)
        tools = (
            await client.list_tools(timeout_sec=server.read_timeout_sec)
            if init_result.capabilities.tools
            else []
        )
        return {
            "ok": True,
            "server_id": server.id,
            "status": "online",
            "protocol_version": init_result.protocol_version,
            "server_info": init_result.server_info,
            "capabilities": asdict(init_result.capabilities),
            "tools_count": len(tools),
            "resources_reserved_count": 1 if init_result.capabilities.resources_reserved else 0,
            "duration_ms": _duration_ms(started),
        }
    except Exception as exc:
        runtime_error = to_mcp_runtime_error(exc)
        return {
            "ok": False,
            "server_id": server.id,
            "status": status_from_mcp_error_code(runtime_error.code).value,
            "duration_ms": _duration_ms(started),
            "error": runtime_error.to_payload().model_dump(mode="json"),
        }
    finally:
        with suppress(Exception):
            await client.shutdown(timeout_sec=server.shutdown_timeout_sec)


async def refresh_mcp_server(manager: McpManager, server_id: str) -> dict[str, Any]:
    try:
        report = await manager.refresh_capabilities(server_id)
    except McpRuntimeError as exc:
        return {
            "ok": False,
            "server_id": server_id,
            "status": status_from_mcp_error_code(exc.code).value,
            "error": exc.to_payload().model_dump(mode="json"),
        }
    return {"ok": True, **report.to_dict()}


async def refresh_all_mcp_servers(manager: McpManager) -> dict[str, Any]:
    servers, _total = manager.repositories.mcp_servers.list(enabled=True, limit=500)
    results = [await refresh_mcp_server(manager, server.id) for server in servers]
    return {
        "ok": all(result.get("ok") for result in results),
        "list": results,
        "total": len(results),
    }


def require_mcp_server(
    repositories: StorageRepositories,
    server_id: str,
) -> McpServerRecord:
    server = repositories.mcp_servers.get(server_id)
    if server is None:
        raise McpServiceError("MCP server 不存在", code="server_not_found")
    return server


def require_mcp_tool(
    repositories: StorageRepositories,
    server_id: str,
    tool_id: str,
) -> McpToolRecord:
    for tool in repositories.mcp_tools.list_by_server(server_id, limit=1000):
        if tool.id == tool_id or tool.raw_name == tool_id or tool.model_name == tool_id:
            return tool
    raise McpServiceError("MCP tool 不存在", code="tool_not_found")


def _temporary_mcp_server_record(
    repositories: StorageRepositories,
    payload: McpServerCreateRequest,
    *,
    base_server_id: str | None,
) -> McpServerRecord:
    if base_server_id:
        data = asdict(require_mcp_server(repositories, base_server_id))
        data.update(payload.model_dump(mode="json", exclude_unset=True))
    else:
        data = payload.model_dump(mode="json")
    now = to_iso_z(utc_now())
    data["id"] = f"temporary-{new_id()}"
    data["created_at"] = now
    data["updated_at"] = now
    return McpServerRecord(**data)


def resolve_mcp_tool_location(
    repositories: StorageRepositories,
    server_id: str | None,
    tool_id: str,
) -> tuple[McpServerRecord, McpToolRecord]:
    if server_id:
        server = require_mcp_server(repositories, server_id)
        return server, require_mcp_tool(repositories, server_id, tool_id)
    servers, _total = repositories.mcp_servers.list(limit=500)
    matches: list[tuple[McpServerRecord, McpToolRecord]] = []
    for server in servers:
        for tool in repositories.mcp_tools.list_by_server(server.id, limit=1000):
            if tool.id == tool_id or tool.raw_name == tool_id or tool.model_name == tool_id:
                matches.append((server, tool))
    if not matches:
        raise McpServiceError("MCP tool 不存在", code="tool_not_found")
    if len(matches) > 1:
        raise McpServiceError("MCP tool 标识不唯一，请传入 server_id", code="tool_ambiguous")
    return matches[0]


def tool_payload(
    server: McpServerRecord,
    tool: McpToolRecord,
    policy: McpToolPolicyRecord | None,
) -> dict[str, Any]:
    enabled = policy.enabled if policy is not None else True
    hidden = policy.hidden if policy is not None else False
    approval_mode = policy.approval_mode if policy is not None else "inherit"
    effective_approval_mode = (
        approval_mode if approval_mode != "inherit" else server.default_tool_approval_mode
    )
    return {
        "id": tool.id,
        "server_id": tool.server_id,
        "server_name": server.name,
        "raw_name": tool.raw_name,
        "model_name": tool.model_name,
        "display_name": tool.display_name,
        "description": tool.description,
        "input_schema": tool.input_schema,
        "annotations": tool.annotations or {},
        "enabled": enabled,
        "hidden": hidden,
        "status": tool.discovery_status,
        "discovery_status": tool.discovery_status,
        "effective_state": _tool_effective_state(tool, enabled, hidden),
        "approval_mode": approval_mode,
        "effective_approval_mode": effective_approval_mode,
        "schema_change_action": (
            policy.schema_change_action if policy is not None else "require_review"
        ),
        "parameter_constraints": policy.parameter_constraints if policy is not None else None,
        "last_used_at": tool.last_used_at,
        "call_count": tool.call_count,
        "failure_count": tool.failure_count,
        "first_seen_at": tool.first_seen_at,
        "last_seen_at": tool.last_seen_at,
        "removed_at": tool.removed_at,
    }


def runtime_tool_payload(
    *,
    server: McpServerRecord,
    status: McpServerStatusRecord | None,
    tool: McpToolRecord,
    policy: McpToolPolicyRecord | None,
    override: McpSessionToolOverrideRecord | None,
) -> dict[str, Any]:
    exposure = McpToolExposureResolver().resolve(
        servers=[server],
        statuses={server.id: status},
        tools=[tool],
        policies=[policy] if policy is not None else [],
        session_overrides=[override] if override is not None else [],
    )
    if exposure.visible_tools:
        hidden_reason = None
        effective_state = "enabled"
    else:
        hidden_reason = exposure.hidden_tools[0].reason if exposure.hidden_tools else "not_visible"
        effective_state = _effective_state_from_hidden_reason(hidden_reason)
    payload = tool_payload(server, tool, policy)
    payload.update(
        {
            "server_status": status.status if status is not None else "unknown",
            "effective_state": effective_state,
            "hidden_reason": hidden_reason,
            "session_override": _override_payload(override) if override else None,
        }
    )
    return payload


def server_payload(
    repositories: StorageRepositories,
    server: McpServerRecord,
    *,
    detail: bool = True,
) -> dict[str, Any]:
    status = repositories.mcp_server_status.get(server.id)
    resources_reserved_count = status.resources_reserved_count if status is not None else 0
    payload: dict[str, Any] = {
        "id": server.id,
        "name": server.name,
        "description": server.description,
        "enabled": server.enabled,
        "required": server.required,
        "transport": server.transport,
        "auth_type": server.auth_type,
        "status": status.status if status is not None else "unknown",
        "tools_count": status.tools_count if status is not None else 0,
        "resources_reserved_count": resources_reserved_count,
        "resources_reserved": resources_reserved_count > 0 or bool(server.resource_reserved_policy),
        "last_connected_at": status.last_connected_at if status is not None else None,
        "last_refresh_at": status.last_refresh_at if status is not None else None,
        "last_error_code": status.last_error_code if status is not None else None,
        "last_error_message": status.last_error_message if status is not None else None,
        "last_error_detail": status.last_error_detail if status is not None else None,
        "created_at": server.created_at,
        "updated_at": server.updated_at,
    }
    if not detail:
        return payload
    payload.update(
        {
            "command": server.command,
            "args": server.args or [],
            "cwd": server.cwd,
            "url": server.url,
            "sse_url": server.sse_url,
            "message_url": server.message_url,
            "inherit_environment": server.inherit_environment,
            "env_keys": sorted((server.env or {}).keys()),
            "header_keys": sorted((server.headers or {}).keys()),
            "env_header_keys": sorted((server.env_headers or {}).keys()),
            "bearer_token_env_var": server.bearer_token_env_var,
            "auth_type": server.auth_type,
            "secret_ref_keys": sorted((server.secret_refs or {}).keys()),
            "oauth_configured": bool(server.oauth_config),
            "oauth_resource": server.oauth_resource,
            "oauth_scopes": server.oauth_scopes or [],
            "startup_timeout_sec": server.startup_timeout_sec,
            "tool_timeout_sec": server.tool_timeout_sec,
            "read_timeout_sec": server.read_timeout_sec,
            "sse_read_timeout_sec": server.sse_read_timeout_sec,
            "shutdown_timeout_sec": server.shutdown_timeout_sec,
            "restart_policy": server.restart_policy,
            "connect_mode": server.connect_mode,
            "auto_refresh": server.auto_refresh,
            "refresh_interval_sec": server.refresh_interval_sec,
            "default_tool_exposure_mode": server.default_tool_exposure_mode,
            "default_tool_approval_mode": server.default_tool_approval_mode,
            "supports_parallel_tool_calls": server.supports_parallel_tool_calls,
            "elicitation_enabled": server.elicitation_enabled,
            "sampling_enabled": server.sampling_enabled,
            "resource_reserved_policy": server.resource_reserved_policy,
        }
    )
    return payload


_BULK_TOOL_POLICY_ACTIONS = {
    "enable_selected",
    "disable_selected",
    "keep_selected_only",
    "prompt_all",
}


def _tool_policy_values(policy: McpToolPolicyRecord | None) -> dict[str, Any]:
    return {
        "enabled": policy.enabled if policy is not None else True,
        "hidden": policy.hidden if policy is not None else False,
        "approval_mode": policy.approval_mode if policy is not None else "inherit",
        "parameter_constraints": (
            policy.parameter_constraints if policy is not None else None
        ),
        "schema_change_action": (
            policy.schema_change_action if policy is not None else "require_review"
        ),
    }


def _resolve_tool_identifiers(
    tools: list[McpToolRecord],
    *,
    tool_ids: list[str],
    raw_tool_names: list[str],
) -> set[str]:
    selected = {str(name) for name in raw_tool_names}
    identifiers = {str(identifier) for identifier in tool_ids}
    available_raw_names = {tool.raw_name for tool in tools}
    for tool in tools:
        if (
            tool.id in identifiers
            or tool.raw_name in identifiers
            or tool.model_name in identifiers
        ):
            selected.add(tool.raw_name)
    missing = (selected - available_raw_names) | (identifiers - {
        value
        for tool in tools
        for value in (tool.id, tool.raw_name, tool.model_name)
    })
    if missing:
        raise McpServiceError(
            f"MCP tool 不存在: {', '.join(sorted(missing))}",
            code="tool_not_found",
        )
    return selected


def _tool_effective_state(tool: McpToolRecord, enabled: bool, hidden: bool) -> str:
    if tool.discovery_status == "removed":
        return "removed"
    if tool.discovery_status == "schema_changed":
        return "schema_changed"
    if hidden:
        return "disabled_by_server"
    if not enabled:
        return "disabled_persistently"
    return "enabled"


def _effective_state_from_hidden_reason(reason: str) -> str:
    return {
        "server_disabled": "disabled_by_server",
        "server_not_online": "server_offline",
        "tool_removed": "removed",
        "tool_hidden": "disabled_by_server",
        "tool_disabled_by_policy": "disabled_persistently",
        "tool_disabled_for_session": "disabled_for_session",
        "tool_not_selected": "disabled_persistently",
        "tool_hidden_from_model": "disabled_by_server",
    }.get(reason, "disabled_persistently")


def _runtime_snapshot_payload(snapshot: McpRuntimeSnapshotRecord) -> dict[str, Any]:
    return {
        "id": snapshot.id,
        "session_id": snapshot.session_id,
        "turn_id": snapshot.turn_id,
        "tool_inventory_revision": snapshot.tool_inventory_revision,
        "visible_tools_count": len(snapshot.visible_tools),
        "visible_tools": [
            {
                "server_id": tool.get("server_id"),
                "server_name": tool.get("server_name"),
                "raw_name": tool.get("raw_name"),
                "model_name": tool.get("model_name"),
                "description": tool.get("description"),
                "exposure": tool.get("exposure") or "direct",
            }
            for tool in snapshot.visible_tools
            if isinstance(tool, dict)
        ],
        "server_status": snapshot.server_status,
        "policy_summary": snapshot.policy_summary,
        "created_at": snapshot.created_at,
    }


def _override_payload(override: McpSessionToolOverrideRecord) -> dict[str, Any]:
    return {
        "id": override.id,
        "session_id": override.session_id,
        "server_id": override.server_id,
        "raw_tool_name": override.raw_tool_name,
        "enabled": override.enabled,
        "reason": override.reason,
        "created_at": override.created_at,
        "expires_at": override.expires_at,
    }


def _server_status(
    repositories: StorageRepositories,
    server: McpServerRecord,
) -> str:
    status = repositories.mcp_server_status.get(server.id)
    return status.status if status is not None else "unknown"


def _override_apply_timing(*, enabled: bool, running: bool) -> dict[str, Any]:
    if not enabled:
        return {
            "scope": "current_run",
            "message": "禁用立即写入会话覆盖，后续 MCP tool 执行会被 live guard 阻断。",
        }
    if running:
        return {
            "scope": "next_turn",
            "message": "当前 run 正在执行，启用后的 tool 会在下一轮 agent 执行生效。",
        }
    return {
        "scope": "next_turn",
        "message": "启用后的 tool 会在下一次发送消息时进入新的 runtime snapshot。",
    }


def _append_runtime_override_audit(
    repositories: StorageRepositories,
    *,
    event_type: str,
    session_id: str,
    server_id: str,
    raw_tool_name: str,
    detail: dict[str, Any],
) -> None:
    McpAuditWriter.from_repositories(repositories).append_event(
        event_type=event_type,
        server_id=server_id,
        raw_tool_name=raw_tool_name,
        session_id=session_id,
        status="completed",
        summary=f"MCP runtime override updated: {raw_tool_name}",
        detail=detail,
    )


def _matches_search(search: str, *values: str | None) -> bool:
    needle = search.casefold().strip()
    if not needle:
        return True
    return any(needle in value.casefold() for value in values if value)


def _duration_ms(started_at: float) -> int:
    return max(0, int((time.perf_counter() - started_at) * 1000))
