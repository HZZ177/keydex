from __future__ import annotations

from typing import Any

from backend.app.core.ids import new_id
from backend.app.mcp.audit import McpAuditWriter, redact_sensitive_data
from backend.app.mcp.types import McpServerCreateRequest
from backend.app.storage import McpServerRecord, StorageRepositories

SUPPORTED_IMPORT_SOURCES = {"keydex", "codex", "claude"}
CONFLICT_STRATEGIES = {"skip", "rename", "error"}
SERVER_FIELDS = set(McpServerCreateRequest.model_fields)
CODEX_SERVER_FIELDS = {
    "command",
    "args",
    "env",
    "cwd",
    "url",
    "sse_url",
    "message_url",
    "headers",
    "env_headers",
    "bearer_token_env_var",
    "transport",
    "enabled",
    "required",
    "description",
    "startup_timeout_sec",
    "tool_timeout_sec",
    "read_timeout_sec",
    "sse_read_timeout_sec",
    "shutdown_timeout_sec",
    "default_tool_approval_mode",
}
CLAUDE_SERVER_FIELDS = {"command", "args", "env", "cwd", "disabled", "description"}


class McpImportExportError(ValueError):
    def __init__(self, message: str, *, code: str = "mcp_import_export_error") -> None:
        super().__init__(message)
        self.code = code


def preview_mcp_import(
    repositories: StorageRepositories,
    *,
    source_type: str,
    config: dict[str, Any],
    conflict_strategy: str = "skip",
) -> dict[str, Any]:
    source = _validate_source(source_type)
    strategy = _validate_conflict_strategy(conflict_strategy)
    drafts = _drafts_from_source(source, config)
    existing_names = _existing_server_names(repositories)
    server_previews = []
    conflicts: list[str] = []
    missing_secrets: list[str] = []
    unknown_fields: list[str] = []
    for draft in drafts:
        name = str(draft["name"])
        conflict = name in existing_names
        if conflict:
            conflicts.append(name)
        server_missing = list(draft.pop("_missing_secrets", []))
        server_unknown = list(draft.pop("_unknown_fields", []))
        missing_secrets.extend(f"{name}.{item}" for item in server_missing)
        unknown_fields.extend(f"{name}.{item}" for item in server_unknown)
        server_previews.append(
            {
                "name": name,
                "transport": draft["transport"],
                "enabled": draft.get("enabled", True),
                "conflict": conflict,
                "action": _preview_action(conflict=conflict, strategy=strategy),
                "missing_secrets": server_missing,
                "unknown_fields": server_unknown,
            }
        )
    return {
        "source_type": source,
        "conflict_strategy": strategy,
        "server_count": len(drafts),
        "servers": server_previews,
        "conflicts": conflicts,
        "missing_secrets": missing_secrets,
        "unknown_fields": unknown_fields,
        "valid": not unknown_fields,
    }


def apply_mcp_import(
    repositories: StorageRepositories,
    *,
    source_type: str,
    config: dict[str, Any],
    conflict_strategy: str = "skip",
) -> dict[str, Any]:
    source = _validate_source(source_type)
    strategy = _validate_conflict_strategy(conflict_strategy)
    preview = preview_mcp_import(
        repositories,
        source_type=source,
        config=config,
        conflict_strategy=strategy,
    )
    if preview["unknown_fields"]:
        raise McpImportExportError("导入配置包含无法识别字段", code="unknown_fields")
    if preview["conflicts"] and strategy == "error":
        raise McpImportExportError("导入配置存在同名 server 冲突", code="name_conflict")
    existing_names = _existing_server_names(repositories)
    created: list[dict[str, Any]] = []
    skipped: list[str] = []
    for draft in _drafts_from_source(source, config):
        draft.pop("_missing_secrets", None)
        draft.pop("_unknown_fields", None)
        original_name = str(draft["name"])
        if original_name in existing_names and strategy == "skip":
            skipped.append(original_name)
            continue
        if original_name in existing_names and strategy == "rename":
            draft["name"] = _unique_import_name(original_name, existing_names)
        request = McpServerCreateRequest(**draft)
        server = repositories.mcp_servers.create(
            server_id=new_id(),
            **request.model_dump(mode="json"),
        )
        existing_names.add(server.name)
        created.append({"id": server.id, "name": server.name, "transport": server.transport})
    McpAuditWriter.from_repositories(repositories).append_event(
        event_type="import.applied",
        status="completed",
        summary="MCP config import applied",
        detail={
            "source_type": source,
            "conflict_strategy": strategy,
            "created_count": len(created),
            "skipped_count": len(skipped),
            "created": created,
            "skipped": skipped,
        },
    )
    return {
        **preview,
        "applied": True,
        "created_count": len(created),
        "skipped_count": len(skipped),
        "created": created,
        "skipped": skipped,
    }


def export_mcp_config(
    repositories: StorageRepositories,
    *,
    include_trust_rules: bool = False,
) -> dict[str, Any]:
    servers, _total = repositories.mcp_servers.list(limit=500)
    exported = {
        "format": "keydex.mcp.v1",
        "servers": [_export_server(server) for server in servers],
        "tool_policies": [
            _export_tool_policy(policy)
            for server in servers
            for policy in repositories.mcp_tool_policies.list_by_server(server.id)
        ],
    }
    if include_trust_rules:
        exported["trust_rules"] = [
            _export_trust_rule(rule)
            for rule in repositories.mcp_trust_rules.list(limit=500)
        ]
    return exported


def _drafts_from_source(source_type: str, config: dict[str, Any]) -> list[dict[str, Any]]:
    if source_type == "keydex":
        return _keydex_drafts(config)
    if source_type == "codex":
        servers = config.get("mcp_servers") or config.get("mcpServers") or {}
        return _named_server_drafts(servers, source_type)
    if source_type == "claude":
        return _named_server_drafts(config.get("mcpServers") or {}, source_type)
    raise McpImportExportError(f"不支持的 MCP import source: {source_type}", code="invalid_source")


def _keydex_drafts(config: dict[str, Any]) -> list[dict[str, Any]]:
    servers = config.get("servers")
    if not isinstance(servers, list):
        raise McpImportExportError("Keydex import config servers 必须是数组", code="invalid_config")
    drafts: list[dict[str, Any]] = []
    for index, item in enumerate(servers):
        if not isinstance(item, dict):
            raise McpImportExportError(f"servers[{index}] 必须是对象", code="invalid_config")
        unknown = sorted(set(item) - SERVER_FIELDS)
        draft = {key: value for key, value in item.items() if key in SERVER_FIELDS}
        draft.setdefault("enabled", True)
        draft["_unknown_fields"] = unknown
        draft["_missing_secrets"] = _strip_draft_secrets(draft)
        drafts.append(_normalize_draft(draft, default_name=f"Imported {index + 1}"))
    return drafts


def _named_server_drafts(servers: Any, source_type: str) -> list[dict[str, Any]]:
    if not isinstance(servers, dict):
        raise McpImportExportError("MCP import config servers 必须是对象", code="invalid_config")
    fields = CODEX_SERVER_FIELDS if source_type == "codex" else CLAUDE_SERVER_FIELDS
    drafts: list[dict[str, Any]] = []
    for name, item in servers.items():
        if not isinstance(item, dict):
            raise McpImportExportError(f"MCP server {name} 必须是对象", code="invalid_config")
        unknown = sorted(set(item) - fields)
        draft = {key: value for key, value in item.items() if key in fields}
        draft["name"] = str(name)
        if source_type == "claude":
            draft["transport"] = "stdio"
            draft["enabled"] = not bool(draft.pop("disabled", False))
        draft["_unknown_fields"] = unknown
        draft["_missing_secrets"] = _strip_draft_secrets(draft)
        drafts.append(_normalize_draft(draft, default_name=str(name)))
    return drafts


def _normalize_draft(draft: dict[str, Any], *, default_name: str) -> dict[str, Any]:
    draft["name"] = str(draft.get("name") or default_name).strip()
    if not draft["name"]:
        raise McpImportExportError("MCP server name 不能为空", code="invalid_config")
    transport = str(draft.get("transport") or "").strip()
    if not transport:
        transport = "stdio" if draft.get("command") else "streamable_http"
    if transport == "http":
        transport = "streamable_http"
    draft["transport"] = transport
    if transport == "sse" and not draft.get("sse_url") and draft.get("url"):
        draft["sse_url"] = draft.pop("url")
    if transport == "streamable_http" and not draft.get("url") and draft.get("sse_url"):
        draft["url"] = draft["sse_url"]
    draft.setdefault("enabled", True)
    return draft


def _strip_draft_secrets(draft: dict[str, Any]) -> list[str]:
    missing: list[str] = []
    env = draft.get("env")
    if isinstance(env, dict):
        safe_env: dict[str, Any] = {}
        for key, value in env.items():
            if _is_sensitive_key(str(key)) or _looks_like_secret(value):
                missing.append(f"env.{key}")
                continue
            safe_env[str(key)] = value
        draft["env"] = safe_env
    headers = draft.get("headers")
    if isinstance(headers, dict):
        safe_headers: dict[str, str] = {}
        env_headers = dict(draft.get("env_headers") or {})
        for key, value in headers.items():
            env_var = _env_reference(value)
            if env_var:
                env_headers[str(key)] = env_var
            else:
                missing.append(f"headers.{key}")
        draft["headers"] = safe_headers
        draft["env_headers"] = env_headers
    oauth_config = draft.get("oauth_config")
    if isinstance(oauth_config, dict) and "client_secret" in oauth_config:
        missing.append("oauth_config.client_secret")
        draft["oauth_config"] = {
            key: value for key, value in oauth_config.items() if key != "client_secret"
        }
    return missing


def _export_server(server: McpServerRecord) -> dict[str, Any]:
    return {
        "name": server.name,
        "description": server.description,
        "enabled": server.enabled,
        "required": server.required,
        "transport": server.transport,
        "command": server.command,
        "args": server.args or [],
        "cwd": server.cwd,
        "inherit_environment": server.inherit_environment,
        "env": {str(key): f"env:{key}" for key in (server.env or {})},
        "url": server.url,
        "sse_url": server.sse_url,
        "message_url": server.message_url,
        "headers": {str(key): "secret:configured" for key in (server.headers or {})},
        "env_headers": server.env_headers or {},
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


def _export_tool_policy(policy: Any) -> dict[str, Any]:
    return {
        "server_id": policy.server_id,
        "raw_tool_name": policy.raw_tool_name,
        "enabled": policy.enabled,
        "hidden": policy.hidden,
        "approval_mode": policy.approval_mode,
        "schema_change_action": policy.schema_change_action,
        "parameter_constraints": redact_sensitive_data(policy.parameter_constraints or {}),
    }


def _export_trust_rule(rule: Any) -> dict[str, Any]:
    return {
        "scope": rule.scope,
        "server_id": rule.server_id,
        "raw_tool_name": rule.raw_tool_name,
        "rule_kind": rule.rule_kind,
        "approval_mode": rule.approval_mode,
        "condition": redact_sensitive_data(rule.condition or {}),
        "created_from_approval_id": rule.created_from_approval_id,
        "expires_at": rule.expires_at,
    }


def _validate_source(source_type: str) -> str:
    source = str(source_type)
    if source not in SUPPORTED_IMPORT_SOURCES:
        raise McpImportExportError(f"不支持的 MCP import source: {source}", code="invalid_source")
    return source


def _validate_conflict_strategy(strategy: str) -> str:
    if strategy not in CONFLICT_STRATEGIES:
        raise McpImportExportError(
            f"不支持的 MCP import conflict strategy: {strategy}",
            code="invalid_conflict_strategy",
        )
    return strategy


def _existing_server_names(repositories: StorageRepositories) -> set[str]:
    servers, _total = repositories.mcp_servers.list(limit=500)
    return {server.name for server in servers}


def _preview_action(*, conflict: bool, strategy: str) -> str:
    if not conflict:
        return "create"
    if strategy == "rename":
        return "rename"
    if strategy == "error":
        return "error"
    return "skip"


def _unique_import_name(name: str, existing_names: set[str]) -> str:
    base = f"{name} (imported)"
    candidate = base
    index = 2
    while candidate in existing_names:
        candidate = f"{base} {index}"
        index += 1
    return candidate


def _is_sensitive_key(key: str) -> bool:
    lowered = key.casefold()
    sensitive_tokens = ("token", "secret", "password", "key", "authorization")
    return any(token in lowered for token in sensitive_tokens)


def _looks_like_secret(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    stripped = value.strip()
    if _env_reference(stripped):
        return False
    return len(stripped) >= 20


def _env_reference(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    stripped = value.strip()
    if stripped.startswith("env:"):
        return stripped.removeprefix("env:")
    if stripped.startswith("${") and stripped.endswith("}"):
        return stripped[2:-1]
    if stripped.startswith("$") and len(stripped) > 1:
        return stripped[1:]
    return None
