from __future__ import annotations

import json
import re
import sqlite3
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from backend.app.core.ids import new_id
from backend.app.core.time import to_iso_z, utc_now
from backend.app.security import WorkspacePathError, normalize_workspace_root_for_storage
from backend.app.storage.db import Database


def _json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _json_loads(value: str | None, default: Any = None) -> Any:
    if value is None:
        return default
    return json.loads(value)


SENSITIVE_METADATA_KEYS = {
    "api_key",
    "apikey",
    "authorization",
    "proxy_authorization",
    "x-api-key",
    "x_api_key",
    "headers",
}

MODEL_DEFAULT_CHAT = "default_chat"
MODEL_DEFAULT_FAST = "fast"
MODEL_DEFAULT_SCOPES = frozenset({MODEL_DEFAULT_CHAT, MODEL_DEFAULT_FAST})

THREAD_TASK_TYPE_GOAL = "goal"
THREAD_TASK_TYPES = frozenset({THREAD_TASK_TYPE_GOAL})
THREAD_TASK_TYPE_MAX_CHARS = 64
THREAD_TASK_TYPE_PATTERN = re.compile(r"^[a-z][a-z0-9_:-]*$")
THREAD_TASK_STATUS_ACTIVE = "active"
THREAD_TASK_STATUS_PAUSED = "paused"
THREAD_TASK_STATUS_BLOCKED = "blocked"
THREAD_TASK_STATUS_COMPLETE = "complete"
THREAD_TASK_STATUS_SYSTEM_STOPPED = "system_stopped"
THREAD_TASK_STATUS_CANCELLED = "cancelled"
THREAD_TASK_OPEN_STATUSES = frozenset(
    {
        THREAD_TASK_STATUS_ACTIVE,
        THREAD_TASK_STATUS_PAUSED,
        THREAD_TASK_STATUS_BLOCKED,
    }
)
THREAD_TASK_TERMINAL_STATUSES = frozenset(
    {
        THREAD_TASK_STATUS_COMPLETE,
        THREAD_TASK_STATUS_SYSTEM_STOPPED,
        THREAD_TASK_STATUS_CANCELLED,
    }
)
THREAD_TASK_STATUSES = THREAD_TASK_OPEN_STATUSES | THREAD_TASK_TERMINAL_STATUSES
THREAD_TASK_RUN_STATUS_RUNNING = "running"
THREAD_TASK_RUN_STATUS_SUCCEEDED = "succeeded"
THREAD_TASK_RUN_STATUS_FAILED = "failed"
THREAD_TASK_RUN_STATUS_SKIPPED = "skipped"
THREAD_TASK_RUN_STATUS_CANCELLED = "cancelled"
THREAD_TASK_RUN_STATUSES = frozenset(
    {
        THREAD_TASK_RUN_STATUS_RUNNING,
        THREAD_TASK_RUN_STATUS_SUCCEEDED,
        THREAD_TASK_RUN_STATUS_FAILED,
        THREAD_TASK_RUN_STATUS_SKIPPED,
        THREAD_TASK_RUN_STATUS_CANCELLED,
    }
)
_UNSET = object()


def _clip_text(value: str | None, limit: int = 4000) -> str | None:
    if value is None:
        return None
    text = str(value)
    if len(text) <= limit:
        return text
    return f"{text[:limit]}..."


def _sanitize_metadata(value: Any) -> Any:
    if isinstance(value, dict):
        cleaned: dict[str, Any] = {}
        for key, item in value.items():
            key_text = str(key)
            if key_text.lower() in SENSITIVE_METADATA_KEYS:
                continue
            cleaned[key_text] = _sanitize_metadata(item)
        return cleaned
    if isinstance(value, list):
        return [_sanitize_metadata(item) for item in value]
    if value is None or isinstance(value, str | int | float | bool):
        return value
    return str(value)


def _json_object_loads(value: str | None, *, field_name: str) -> dict[str, Any]:
    if value is None or value == "":
        return {}
    try:
        loaded = json.loads(value)
    except json.JSONDecodeError as exc:
        raise ValueError(f"{field_name} 不是有效 JSON 对象") from exc
    if not isinstance(loaded, dict):
        raise ValueError(f"{field_name} 必须是 JSON 对象")
    return loaded


def _json_array_loads(value: str | None, *, field_name: str) -> list[Any]:
    if value is None or value == "":
        return []
    try:
        loaded = json.loads(value)
    except json.JSONDecodeError as exc:
        raise ValueError(f"{field_name} 不是有效 JSON 数组") from exc
    if not isinstance(loaded, list):
        raise ValueError(f"{field_name} 必须是 JSON 数组")
    return loaded


@dataclass(frozen=True)
class ModelProviderRecord:
    id: str
    name: str
    base_url: str
    api_key: str | None
    enabled: bool
    models: list[str]
    model_enabled: dict[str, bool]
    health: dict[str, Any]
    created_at: str
    updated_at: str


@dataclass(frozen=True)
class ModelDefaultRecord:
    scope: str
    provider_id: str
    model: str
    updated_at: str


@dataclass(frozen=True)
class WorkspaceRecord:
    id: str
    name: str
    root_path: str
    normalized_root_path: str
    type: str
    created_at: str
    updated_at: str
    last_opened_at: str | None = None
    is_deleted: bool = False


@dataclass(frozen=True)
class SessionRecord:
    id: str
    user_id: str
    scene_id: str
    status: str
    session_tag: str
    title: str | None
    active_session_id: str | None
    created_at: str
    updated_at: str
    scene_version_seq: int | None = None
    is_debug: bool = False
    debug_type: str | None = None
    is_scheduled: bool = False
    scheduled_task_id: str | None = None
    parent_session_id: str | None = None
    child_session_id: str | None = None
    source_trace_id: str | None = None
    source_active_session_id: str | None = None
    source_checkpoint_id: str | None = None
    source_checkpoint_ns: str | None = None
    workspace_id: str | None = None
    session_type: str = "chat"
    cwd: str | None = None
    workspace_roots: list[str] = field(default_factory=list)
    current_model_provider_id: str | None = None
    current_model: str | None = None
    context_window_usage: dict[str, Any] | None = None
    context_compression_epoch: int = 0
    pinned_at: str | None = None
    is_deleted: bool = False
    title_source: str = "manual"


@dataclass(frozen=True)
class SessionForkRecord:
    id: str
    source_session_id: str
    target_session_id: str
    source_message_event_id: str
    target_message_event_id: str
    source_turn_index: int
    target_turn_index: int
    relation_type: str
    created_at: str
    updated_at: str
    source_trace_id: str | None = None
    source_active_session_id: str | None = None
    source_checkpoint_id: str | None = None
    source_checkpoint_ns: str = ""
    is_deleted: bool = False


@dataclass(frozen=True)
class ThreadTaskRecord:
    id: str
    session_id: str
    type: str
    objective: str
    status: str
    metadata: dict[str, Any]
    evidence: list[Any]
    blocked_audit: dict[str, Any]
    turn_count: int
    elapsed_seconds: int
    token_usage: dict[str, Any]
    created_at: str
    updated_at: str
    title: str | None = None
    system_stop_reason: str | None = None
    current_run_id: str | None = None
    deleted_at: str | None = None

    @property
    def is_open(self) -> bool:
        return self.deleted_at is None and self.status in THREAD_TASK_OPEN_STATUSES

    @property
    def is_terminal(self) -> bool:
        return self.status in THREAD_TASK_TERMINAL_STATUSES

    @classmethod
    def from_row(cls, row: sqlite3.Row) -> ThreadTaskRecord:
        return cls(
            id=row["id"],
            session_id=row["session_id"],
            type=row["type"],
            title=row["title"],
            objective=row["objective"],
            status=row["status"],
            metadata=_json_object_loads(row["metadata_json"], field_name="metadata_json"),
            evidence=_json_array_loads(row["evidence_json"], field_name="evidence_json"),
            blocked_audit=_json_object_loads(
                row["blocked_audit_json"],
                field_name="blocked_audit_json",
            ),
            system_stop_reason=row["system_stop_reason"],
            current_run_id=row["current_run_id"],
            turn_count=int(row["turn_count"]),
            elapsed_seconds=int(row["elapsed_seconds"]),
            token_usage=_json_object_loads(
                row["token_usage_json"],
                field_name="token_usage_json",
            ),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            deleted_at=row["deleted_at"],
        )


@dataclass(frozen=True)
class ThreadTaskRunRecord:
    id: str
    task_id: str
    session_id: str
    status: str
    summary: dict[str, Any]
    error: dict[str, Any]
    started_at: str
    created_at: str
    updated_at: str
    turn_index: int | None = None
    trace_id: str | None = None
    finished_at: str | None = None

    @property
    def is_running(self) -> bool:
        return self.status == THREAD_TASK_RUN_STATUS_RUNNING

    @classmethod
    def from_row(cls, row: sqlite3.Row) -> ThreadTaskRunRecord:
        raw_turn_index = row["turn_index"]
        return cls(
            id=row["id"],
            task_id=row["task_id"],
            session_id=row["session_id"],
            turn_index=int(raw_turn_index) if raw_turn_index is not None else None,
            trace_id=row["trace_id"],
            status=row["status"],
            summary=_json_object_loads(row["summary_json"], field_name="summary_json"),
            error=_json_object_loads(row["error_json"], field_name="error_json"),
            started_at=row["started_at"],
            finished_at=row["finished_at"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )


@dataclass(frozen=True)
class AttachmentRecord:
    id: str
    session_id: str | None
    user_id: str
    type: str
    source: str
    name: str
    path: str
    mime_type: str
    size: int
    created_at: str
    updated_at: str
    is_deleted: bool = False


@dataclass(frozen=True)
class MessageEventRecord:
    id: str
    session_id: str
    seq: int
    turn_index: int
    action: str
    data: dict[str, Any]
    created_at: str
    updated_at: str
    trace_record_id: str | None = None
    is_deleted: bool = False


@dataclass(frozen=True)
class CompressionStagingRecord:
    id: int
    original_session_id: str
    active_session_id: str
    target_session_id: str
    generation: int
    status: str
    created_at: str
    updated_at: str
    staging_strategy: str = "anchor_replacement"
    anchor_message_id: str | None = None
    source_last_message_id: str | None = None
    l1_content: str | None = None
    l2_content: str | None = None
    failure_reason: str | None = None
    applied_at: str | None = None
    is_deleted: bool = False


@dataclass(frozen=True)
class WorkspaceFileAnnotationRecord:
    id: str
    scope_type: str
    scope_id: str
    path: str
    anchor_type: str
    comment: str
    created_at: str
    updated_at: str
    workspace_id: str | None = None
    selected_text: str | None = None
    line_start: int | None = None
    line_end: int | None = None
    column_start: int | None = None
    column_end: int | None = None
    content_hash: str | None = None
    anchor_json: dict[str, Any] | None = None
    is_deleted: bool = False


@dataclass(frozen=True)
class TraceRecord:
    trace_id: str
    session_id: str
    scene_id: str
    user_id: str
    turn_index: int
    root_node_id: str
    status: str
    start_time: str
    created_at: str
    updated_at: str
    active_session_id: str | None = None
    scene_name: str | None = None
    scene_version_seq: int | None = None
    end_time: str | None = None
    duration_ms: int | None = None
    total_input_tokens: int = 0
    total_output_tokens: int = 0
    total_tokens: int = 0
    total_cache_read_tokens: int = 0
    user_message_preview: str | None = None
    input_checkpoint_id: str | None = None
    input_checkpoint_ns: str | None = None
    output_checkpoint_id: str | None = None
    output_checkpoint_ns: str | None = None
    metadata: dict[str, Any] | None = None
    is_deleted: bool = False


@dataclass(frozen=True)
class TraceEventLogRecord:
    id: int
    trace_id: str
    trace_record_id: str
    event_type: str
    source: str
    idempotency_key: str
    timestamp_ms: int
    occurred_at: str
    payload: dict[str, Any]
    created_at: str
    updated_at: str
    node_id: str | None = None
    parent_node_id: str | None = None
    root_node_id: str | None = None
    sequence_no: int | None = None
    run_id: str | None = None
    turn_index: int | None = None
    user_id: str | None = None
    original_session_id: str | None = None
    active_session_id: str | None = None
    tags: dict[str, Any] | None = None


@dataclass(frozen=True)
class LLMRequestLogRecord:
    id: str
    trace_id: str
    trace_record_id: str
    session_id: str
    model: str
    status: str
    start_time: str
    created_at: str
    updated_at: str
    active_session_id: str | None = None
    gateway_thread_id: str | None = None
    gateway_trace_id: str | None = None
    turn_index: int | None = None
    provider_id: str | None = None
    provider_name: str | None = None
    end_time: str | None = None
    duration_ms: int | None = None
    time_to_first_token: int | None = None
    input_tokens: int = 0
    cache_read_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    request_preview: str | None = None
    response_preview: str | None = None
    error_message: str | None = None
    metadata: dict[str, Any] | None = None
    is_deleted: bool = False


@dataclass(frozen=True)
class CommandApprovalRequestRecord:
    id: str
    session_id: str
    tool_name: str
    kind: str
    title: str
    description: str
    command: str
    cwd: str
    shell: str
    workspace_root: str
    details: dict[str, Any]
    status: str
    created_at: str
    updated_at: str
    trace_id: str | None = None
    turn_index: int | None = None
    run_id: str | None = None
    decision: str | None = None
    trust_scope: str | None = None
    rule_match_type: str | None = None
    reject_message: str | None = None
    trusted_rule_id: str | None = None
    resolved_at: str | None = None
    is_deleted: bool = False


@dataclass(frozen=True)
class TrustedCommandRuleRecord:
    id: str
    command_pattern: str
    normalized_command: str
    match_type: str
    tool_name: str
    shell: str
    shell_path: str
    workspace_root: str
    cwd_pattern: str
    enabled: bool
    created_at: str
    updated_at: str
    created_from_approval_id: str | None = None
    last_used_at: str | None = None
    is_deleted: bool = False


@dataclass(frozen=True)
class CommandApprovalAuditRecord:
    id: str
    approval_id: str
    session_id: str
    command: str
    cwd: str
    decision: str
    created_at: str
    trust_scope: str | None = None
    rule_match_type: str | None = None
    trusted_rule_id: str | None = None
    reject_message: str | None = None
    metadata: dict[str, Any] | None = None


@dataclass(frozen=True)
class McpServerRecord:
    id: str
    name: str
    enabled: bool
    required: bool
    transport: str
    inherit_environment: bool
    auth_type: str
    startup_timeout_sec: int
    tool_timeout_sec: int
    read_timeout_sec: int
    sse_read_timeout_sec: int
    shutdown_timeout_sec: int
    restart_policy: str
    connect_mode: str
    auto_refresh: bool
    refresh_interval_sec: int
    default_tool_exposure_mode: str
    default_tool_approval_mode: str
    supports_parallel_tool_calls: bool
    elicitation_enabled: bool
    sampling_enabled: bool
    prompt_discovery_enabled: bool
    created_at: str
    updated_at: str
    description: str | None = None
    command: str | None = None
    args: list[Any] | None = None
    cwd: str | None = None
    env: dict[str, Any] | None = None
    url: str | None = None
    sse_url: str | None = None
    message_url: str | None = None
    headers: dict[str, Any] | None = None
    env_headers: dict[str, Any] | None = None
    bearer_token_env_var: str | None = None
    secret_refs: dict[str, Any] | None = None
    oauth_config: dict[str, Any] | None = None
    oauth_resource: str | None = None
    oauth_scopes: list[Any] | None = None
    resource_reserved_policy: dict[str, Any] | None = None


@dataclass(frozen=True)
class McpServerStatusRecord:
    server_id: str
    status: str
    last_refresh_revision: int
    tools_count: int
    prompts_count: int
    resources_reserved_count: int
    updated_at: str
    capabilities: dict[str, Any] | None = None
    server_info: dict[str, Any] | None = None
    last_connected_at: str | None = None
    last_refresh_at: str | None = None
    last_error_code: str | None = None
    last_error_message: str | None = None
    last_error_detail: dict[str, Any] | None = None


@dataclass(frozen=True)
class McpToolRecord:
    id: str
    server_id: str
    raw_name: str
    model_name: str
    callable_namespace: str
    callable_name: str
    input_schema: dict[str, Any]
    schema_hash: str
    risk_level: str
    discovery_status: str
    first_seen_at: str
    last_seen_at: str
    call_count: int
    failure_count: int
    display_name: str | None = None
    description: str | None = None
    annotations: dict[str, Any] | None = None
    meta: dict[str, Any] | None = None
    removed_at: str | None = None
    last_used_at: str | None = None


@dataclass(frozen=True)
class McpPromptRecord:
    id: str
    server_id: str
    raw_name: str
    arguments_schema: dict[str, Any]
    discovery_status: str
    first_seen_at: str
    last_seen_at: str
    display_name: str | None = None
    description: str | None = None
    meta: dict[str, Any] | None = None
    removed_at: str | None = None


@dataclass(frozen=True)
class McpResourceRecord:
    id: str
    server_id: str
    uri: str
    reserved_only: bool
    name: str | None = None
    description: str | None = None
    mime_type: str | None = None
    meta: dict[str, Any] | None = None
    last_seen_at: str | None = None


@dataclass(frozen=True)
class McpResourceTemplateRecord:
    id: str
    server_id: str
    uri_template: str
    reserved_only: bool
    name: str | None = None
    description: str | None = None
    mime_type: str | None = None
    meta: dict[str, Any] | None = None
    last_seen_at: str | None = None


@dataclass(frozen=True)
class McpToolPolicyRecord:
    id: str
    server_id: str
    raw_tool_name: str
    enabled: bool
    hidden: bool
    approval_mode: str
    schema_change_action: str
    updated_at: str
    risk_override: str | None = None
    parameter_constraints: dict[str, Any] | None = None


@dataclass(frozen=True)
class McpPromptPolicyRecord:
    id: str
    server_id: str
    raw_prompt_name: str
    enabled: bool
    exposure_mode: str
    updated_at: str


@dataclass(frozen=True)
class McpSessionToolOverrideRecord:
    id: str
    session_id: str
    server_id: str
    raw_tool_name: str
    enabled: bool
    created_at: str
    reason: str | None = None
    expires_at: str | None = None


@dataclass(frozen=True)
class McpRuntimeSnapshotRecord:
    id: str
    session_id: str
    tool_inventory_revision: int
    visible_tools: list[Any]
    server_status: dict[str, Any]
    policy_summary: dict[str, Any]
    created_at: str
    turn_id: str | None = None


@dataclass(frozen=True)
class McpTrustRuleRecord:
    id: str
    rule_kind: str
    scope: str
    approval_mode: str
    hit_count: int
    created_at: str
    updated_at: str
    server_id: str | None = None
    raw_tool_name: str | None = None
    session_id: str | None = None
    condition: dict[str, Any] | None = None
    created_from_approval_id: str | None = None
    expires_at: str | None = None
    last_hit_at: str | None = None


@dataclass(frozen=True)
class McpOAuthTokenRecord:
    id: str
    server_id: str
    token_ref: str
    status: str
    created_at: str
    updated_at: str
    account_label: str | None = None
    refresh_token_ref: str | None = None
    scopes: list[Any] | None = None
    expires_at: str | None = None


@dataclass(frozen=True)
class McpAuditLogRecord:
    id: str
    event_type: str
    created_at: str
    server_id: str | None = None
    raw_tool_name: str | None = None
    prompt_name: str | None = None
    session_id: str | None = None
    turn_id: str | None = None
    call_id: str | None = None
    approval_id: str | None = None
    actor: str | None = None
    status: str | None = None
    duration_ms: int | None = None
    summary: str | None = None
    detail: dict[str, Any] | None = None


class McpServersRepository:
    VALID_TRANSPORTS = {"stdio", "streamable_http", "sse"}
    VALID_AUTH_TYPES = {"none", "header_token", "bearer_env", "oauth"}
    VALID_RESTART_POLICIES = {"never", "on_failure", "always"}
    VALID_CONNECT_MODES = {"on_startup", "on_demand"}
    VALID_TOOL_EXPOSURE_MODES = {
        "allow_all_except_disabled",
        "allow_selected_only",
        "read_only_auto",
    }
    VALID_TOOL_APPROVAL_MODES = {"auto", "prompt", "approve"}
    JSON_FIELDS = {
        "args": "args_json",
        "env": "env_json",
        "headers": "headers_json",
        "env_headers": "env_headers_json",
        "secret_refs": "secret_refs_json",
        "oauth_config": "oauth_config_json",
        "oauth_scopes": "oauth_scopes_json",
        "resource_reserved_policy": "resource_reserved_policy_json",
    }
    BOOL_FIELDS = {
        "enabled",
        "required",
        "inherit_environment",
        "auto_refresh",
        "supports_parallel_tool_calls",
        "elicitation_enabled",
        "sampling_enabled",
        "prompt_discovery_enabled",
    }
    DIRECT_FIELDS = {
        "name",
        "description",
        "transport",
        "command",
        "cwd",
        "url",
        "sse_url",
        "message_url",
        "bearer_token_env_var",
        "auth_type",
        "oauth_resource",
        "startup_timeout_sec",
        "tool_timeout_sec",
        "read_timeout_sec",
        "sse_read_timeout_sec",
        "shutdown_timeout_sec",
        "restart_policy",
        "connect_mode",
        "refresh_interval_sec",
        "default_tool_exposure_mode",
        "default_tool_approval_mode",
    }

    def __init__(self, db: Database) -> None:
        self.db = db

    def create(
        self,
        *,
        server_id: str,
        name: str,
        transport: str,
        description: str | None = None,
        enabled: bool = True,
        required: bool = False,
        command: str | None = None,
        args: list[Any] | None = None,
        cwd: str | None = None,
        inherit_environment: bool = True,
        env: dict[str, Any] | None = None,
        url: str | None = None,
        sse_url: str | None = None,
        message_url: str | None = None,
        headers: dict[str, Any] | None = None,
        env_headers: dict[str, Any] | None = None,
        bearer_token_env_var: str | None = None,
        auth_type: str = "none",
        secret_refs: dict[str, Any] | None = None,
        oauth_config: dict[str, Any] | None = None,
        oauth_resource: str | None = None,
        oauth_scopes: list[Any] | None = None,
        startup_timeout_sec: int = 30,
        tool_timeout_sec: int = 60,
        read_timeout_sec: int = 60,
        sse_read_timeout_sec: int = 300,
        shutdown_timeout_sec: int = 10,
        restart_policy: str = "on_failure",
        connect_mode: str = "on_demand",
        auto_refresh: bool = True,
        refresh_interval_sec: int = 1800,
        default_tool_exposure_mode: str = "allow_all_except_disabled",
        default_tool_approval_mode: str = "auto",
        supports_parallel_tool_calls: bool = False,
        elicitation_enabled: bool = True,
        sampling_enabled: bool = False,
        prompt_discovery_enabled: bool = True,
        resource_reserved_policy: dict[str, Any] | None = None,
    ) -> McpServerRecord:
        if not name.strip():
            raise ValueError("MCP server 名称不能为空")
        self._validate_fields(
            transport=transport,
            auth_type=auth_type,
            restart_policy=restart_policy,
            connect_mode=connect_mode,
            default_tool_exposure_mode=default_tool_exposure_mode,
            default_tool_approval_mode=default_tool_approval_mode,
        )
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            conn.execute(
                """
                insert into mcp_servers (
                  id, name, description, enabled, required, transport, command, args_json, cwd,
                  inherit_environment, env_json, url, sse_url, message_url, headers_json,
                  env_headers_json, bearer_token_env_var, auth_type, secret_refs_json,
                  oauth_config_json, oauth_resource, oauth_scopes_json, startup_timeout_sec,
                  tool_timeout_sec, read_timeout_sec, sse_read_timeout_sec, shutdown_timeout_sec,
                  restart_policy, connect_mode, auto_refresh, refresh_interval_sec,
                  default_tool_exposure_mode, default_tool_approval_mode,
                  supports_parallel_tool_calls, elicitation_enabled, sampling_enabled,
                  prompt_discovery_enabled, resource_reserved_policy_json, created_at, updated_at
                ) values (
                  ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                  ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                )
                """,
                (
                    server_id,
                    name.strip(),
                    description,
                    int(enabled),
                    int(required),
                    transport,
                    command,
                    _json_dumps(args) if args is not None else None,
                    cwd,
                    int(inherit_environment),
                    _json_dumps(env) if env is not None else None,
                    url,
                    sse_url,
                    message_url,
                    _json_dumps(headers) if headers is not None else None,
                    _json_dumps(env_headers) if env_headers is not None else None,
                    bearer_token_env_var,
                    auth_type,
                    _json_dumps(secret_refs) if secret_refs is not None else None,
                    _json_dumps(oauth_config) if oauth_config is not None else None,
                    oauth_resource,
                    _json_dumps(oauth_scopes) if oauth_scopes is not None else None,
                    startup_timeout_sec,
                    tool_timeout_sec,
                    read_timeout_sec,
                    sse_read_timeout_sec,
                    shutdown_timeout_sec,
                    restart_policy,
                    connect_mode,
                    int(auto_refresh),
                    refresh_interval_sec,
                    default_tool_exposure_mode,
                    default_tool_approval_mode,
                    int(supports_parallel_tool_calls),
                    int(elicitation_enabled),
                    int(sampling_enabled),
                    int(prompt_discovery_enabled),
                    _json_dumps(resource_reserved_policy)
                    if resource_reserved_policy is not None
                    else None,
                    now,
                    now,
                ),
            )
            conn.execute(
                """
                insert into mcp_server_status (server_id, updated_at)
                values (?, ?)
                on conflict(server_id) do nothing
                """,
                (server_id, now),
            )
        record = self.get(server_id)
        if record is None:
            raise RuntimeError(f"创建 MCP server 后无法读取: {server_id}")
        return record

    def get(self, server_id: str) -> McpServerRecord | None:
        with self.db.connect() as conn:
            row = conn.execute("select * from mcp_servers where id = ?", (server_id,)).fetchone()
        return self._from_row(row) if row else None

    def list(
        self,
        *,
        enabled: bool | None = None,
        transport: str | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> tuple[list[McpServerRecord], int]:
        filters: list[str] = []
        params: list[Any] = []
        if enabled is not None:
            filters.append("enabled = ?")
            params.append(int(enabled))
        if transport is not None:
            self._require_choice("transport", transport, self.VALID_TRANSPORTS)
            filters.append("transport = ?")
            params.append(transport)
        where = f"where {' and '.join(filters)}" if filters else ""
        resolved_limit = max(1, min(limit, 500))
        resolved_offset = max(0, offset)
        with self.db.connect() as conn:
            total = conn.execute(
                f"select count(*) as total from mcp_servers {where}",
                params,
            ).fetchone()
            rows = conn.execute(
                f"""
                select * from mcp_servers
                {where}
                order by updated_at desc, created_at desc, name asc
                limit ? offset ?
                """,
                [*params, resolved_limit, resolved_offset],
            ).fetchall()
        return [self._from_row(row) for row in rows], int(total["total"])

    def update(self, server_id: str, **changes: Any) -> McpServerRecord | None:
        if not changes:
            return self.get(server_id)
        assignments: list[str] = []
        params: list[Any] = []
        for field_name, value in changes.items():
            if field_name in self.DIRECT_FIELDS:
                self._validate_update_field(field_name, value)
                assignments.append(f"{field_name} = ?")
                params.append(
                    value.strip() if field_name == "name" and isinstance(value, str) else value
                )
            elif field_name in self.BOOL_FIELDS:
                assignments.append(f"{field_name} = ?")
                params.append(int(bool(value)))
            elif field_name in self.JSON_FIELDS:
                assignments.append(f"{self.JSON_FIELDS[field_name]} = ?")
                params.append(_json_dumps(value) if value is not None else None)
            else:
                raise ValueError(f"不支持更新的 MCP server 字段: {field_name}")
        assignments.append("updated_at = ?")
        params.append(to_iso_z(utc_now()))
        params.append(server_id)
        with self.db.transaction() as conn:
            cursor = conn.execute(
                f"""
                update mcp_servers
                set {", ".join(assignments)}
                where id = ?
                """,
                params,
            )
        if cursor.rowcount == 0:
            return None
        return self.get(server_id)

    def set_enabled(self, server_id: str, enabled: bool) -> McpServerRecord | None:
        return self.update(server_id, enabled=enabled)

    def delete(self, server_id: str) -> bool:
        with self.db.transaction() as conn:
            cursor = conn.execute("delete from mcp_servers where id = ?", (server_id,))
        return int(cursor.rowcount or 0) > 0

    @classmethod
    def _validate_fields(
        cls,
        *,
        transport: str,
        auth_type: str,
        restart_policy: str,
        connect_mode: str,
        default_tool_exposure_mode: str,
        default_tool_approval_mode: str,
    ) -> None:
        cls._require_choice("transport", transport, cls.VALID_TRANSPORTS)
        cls._require_choice("auth_type", auth_type, cls.VALID_AUTH_TYPES)
        cls._require_choice("restart_policy", restart_policy, cls.VALID_RESTART_POLICIES)
        cls._require_choice("connect_mode", connect_mode, cls.VALID_CONNECT_MODES)
        cls._require_choice(
            "default_tool_exposure_mode",
            default_tool_exposure_mode,
            cls.VALID_TOOL_EXPOSURE_MODES,
        )
        cls._require_choice(
            "default_tool_approval_mode",
            default_tool_approval_mode,
            cls.VALID_TOOL_APPROVAL_MODES,
        )

    @classmethod
    def _validate_update_field(cls, field_name: str, value: Any) -> None:
        if field_name == "transport":
            cls._require_choice(field_name, str(value), cls.VALID_TRANSPORTS)
        elif field_name == "auth_type":
            cls._require_choice(field_name, str(value), cls.VALID_AUTH_TYPES)
        elif field_name == "restart_policy":
            cls._require_choice(field_name, str(value), cls.VALID_RESTART_POLICIES)
        elif field_name == "connect_mode":
            cls._require_choice(field_name, str(value), cls.VALID_CONNECT_MODES)
        elif field_name == "default_tool_exposure_mode":
            cls._require_choice(field_name, str(value), cls.VALID_TOOL_EXPOSURE_MODES)
        elif field_name == "default_tool_approval_mode":
            cls._require_choice(field_name, str(value), cls.VALID_TOOL_APPROVAL_MODES)
        elif field_name == "name" and not str(value).strip():
            raise ValueError("MCP server 名称不能为空")

    @staticmethod
    def _require_choice(field_name: str, value: str, allowed: set[str]) -> None:
        if value not in allowed:
            expected = ", ".join(sorted(allowed))
            raise ValueError(
                f"不支持的 MCP server {field_name}: {value}; expected one of: {expected}"
            )

    @staticmethod
    def _from_row(row: sqlite3.Row) -> McpServerRecord:
        return McpServerRecord(
            id=row["id"],
            name=row["name"],
            description=row["description"],
            enabled=bool(row["enabled"]),
            required=bool(row["required"]),
            transport=row["transport"],
            command=row["command"],
            args=_json_loads(row["args_json"], None),
            cwd=row["cwd"],
            inherit_environment=bool(row["inherit_environment"]),
            env=_json_loads(row["env_json"], None),
            url=row["url"],
            sse_url=row["sse_url"],
            message_url=row["message_url"],
            headers=_json_loads(row["headers_json"], None),
            env_headers=_json_loads(row["env_headers_json"], None),
            bearer_token_env_var=row["bearer_token_env_var"],
            auth_type=row["auth_type"],
            secret_refs=_json_loads(row["secret_refs_json"], None),
            oauth_config=_json_loads(row["oauth_config_json"], None),
            oauth_resource=row["oauth_resource"],
            oauth_scopes=_json_loads(row["oauth_scopes_json"], None),
            startup_timeout_sec=int(row["startup_timeout_sec"]),
            tool_timeout_sec=int(row["tool_timeout_sec"]),
            read_timeout_sec=int(row["read_timeout_sec"]),
            sse_read_timeout_sec=int(row["sse_read_timeout_sec"]),
            shutdown_timeout_sec=int(row["shutdown_timeout_sec"]),
            restart_policy=row["restart_policy"],
            connect_mode=row["connect_mode"],
            auto_refresh=bool(row["auto_refresh"]),
            refresh_interval_sec=int(row["refresh_interval_sec"]),
            default_tool_exposure_mode=row["default_tool_exposure_mode"],
            default_tool_approval_mode=row["default_tool_approval_mode"],
            supports_parallel_tool_calls=bool(row["supports_parallel_tool_calls"]),
            elicitation_enabled=bool(row["elicitation_enabled"]),
            sampling_enabled=bool(row["sampling_enabled"]),
            prompt_discovery_enabled=bool(row["prompt_discovery_enabled"]),
            resource_reserved_policy=_json_loads(row["resource_reserved_policy_json"], None),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )


class McpServerStatusRepository:
    VALID_STATUSES = {
        "unknown",
        "online",
        "offline",
        "auth_required",
        "error",
        "disabled",
        "refreshing",
    }

    def __init__(self, db: Database) -> None:
        self.db = db

    def get(self, server_id: str) -> McpServerStatusRecord | None:
        with self.db.connect() as conn:
            row = conn.execute(
                "select * from mcp_server_status where server_id = ?",
                (server_id,),
            ).fetchone()
        return self._from_row(row) if row else None

    def upsert(
        self,
        server_id: str,
        *,
        status: str = "unknown",
        capabilities: dict[str, Any] | None = None,
        server_info: dict[str, Any] | None = None,
        last_connected_at: str | None = None,
        last_refresh_at: str | None = None,
        last_refresh_revision: int | None = None,
        last_error_code: str | None = None,
        last_error_message: str | None = None,
        last_error_detail: dict[str, Any] | None = None,
        tools_count: int = 0,
        prompts_count: int = 0,
        resources_reserved_count: int = 0,
    ) -> McpServerStatusRecord:
        self._validate_status(status)
        now = to_iso_z(utc_now())
        existing = self.get(server_id) if last_refresh_revision is None else None
        resolved_last_refresh_revision = (
            last_refresh_revision
            if last_refresh_revision is not None
            else existing.last_refresh_revision
            if existing is not None
            else 0
        )
        with self.db.transaction() as conn:
            conn.execute(
                """
                insert into mcp_server_status (
                  server_id, status, capabilities_json, server_info_json, last_connected_at,
                  last_refresh_at, last_refresh_revision, last_error_code, last_error_message,
                  last_error_detail_json, tools_count, prompts_count, resources_reserved_count,
                  updated_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                on conflict(server_id) do update set
                  status=excluded.status,
                  capabilities_json=excluded.capabilities_json,
                  server_info_json=excluded.server_info_json,
                  last_connected_at=excluded.last_connected_at,
                  last_refresh_at=excluded.last_refresh_at,
                  last_refresh_revision=excluded.last_refresh_revision,
                  last_error_code=excluded.last_error_code,
                  last_error_message=excluded.last_error_message,
                  last_error_detail_json=excluded.last_error_detail_json,
                  tools_count=excluded.tools_count,
                  prompts_count=excluded.prompts_count,
                  resources_reserved_count=excluded.resources_reserved_count,
                  updated_at=excluded.updated_at
                """,
                (
                    server_id,
                    status,
                    _json_dumps(capabilities) if capabilities is not None else None,
                    _json_dumps(server_info) if server_info is not None else None,
                    last_connected_at,
                    last_refresh_at,
                    resolved_last_refresh_revision,
                    last_error_code,
                    last_error_message,
                    _json_dumps(last_error_detail) if last_error_detail is not None else None,
                    tools_count,
                    prompts_count,
                    resources_reserved_count,
                    now,
                ),
            )
        record = self.get(server_id)
        if record is None:
            raise RuntimeError(f"写入 MCP server status 后无法读取: {server_id}")
        return record

    def update_error(
        self,
        server_id: str,
        *,
        status: str = "error",
        error_code: str | None = None,
        error_message: str | None = None,
        error_detail: dict[str, Any] | None = None,
    ) -> McpServerStatusRecord:
        self._validate_status(status)
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            conn.execute(
                """
                update mcp_server_status set
                  status = ?,
                  last_error_code = ?,
                  last_error_message = ?,
                  last_error_detail_json = ?,
                  updated_at = ?
                where server_id = ?
                """,
                (
                    status,
                    error_code,
                    error_message,
                    _json_dumps(error_detail) if error_detail is not None else None,
                    now,
                    server_id,
                ),
            )
        record = self.get(server_id)
        if record is None:
            return self.upsert(
                server_id,
                status=status,
                last_error_code=error_code,
                last_error_message=error_message,
                last_error_detail=error_detail,
            )
        return record

    def update_refresh_counts(
        self,
        server_id: str,
        *,
        status: str = "online",
        capabilities: dict[str, Any] | None = None,
        server_info: dict[str, Any] | None = None,
        tools_count: int = 0,
        prompts_count: int = 0,
        resources_reserved_count: int = 0,
    ) -> McpServerStatusRecord:
        self._validate_status(status)
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            conn.execute(
                """
                insert into mcp_server_status (
                  server_id, status, capabilities_json, server_info_json, last_connected_at,
                  last_refresh_at, last_refresh_revision, tools_count, prompts_count,
                  resources_reserved_count, updated_at
                ) values (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
                on conflict(server_id) do update set
                  status=excluded.status,
                  capabilities_json=excluded.capabilities_json,
                  server_info_json=excluded.server_info_json,
                  last_connected_at=excluded.last_connected_at,
                  last_refresh_at=excluded.last_refresh_at,
                  last_refresh_revision=mcp_server_status.last_refresh_revision + 1,
                  last_error_code=null,
                  last_error_message=null,
                  last_error_detail_json=null,
                  tools_count=excluded.tools_count,
                  prompts_count=excluded.prompts_count,
                  resources_reserved_count=excluded.resources_reserved_count,
                  updated_at=excluded.updated_at
                """,
                (
                    server_id,
                    status,
                    _json_dumps(capabilities) if capabilities is not None else None,
                    _json_dumps(server_info) if server_info is not None else None,
                    now,
                    now,
                    tools_count,
                    prompts_count,
                    resources_reserved_count,
                    now,
                ),
            )
        record = self.get(server_id)
        if record is None:
            raise RuntimeError(f"刷新 MCP server status 后无法读取: {server_id}")
        return record

    @classmethod
    def _validate_status(cls, status: str) -> None:
        if status not in cls.VALID_STATUSES:
            expected = ", ".join(sorted(cls.VALID_STATUSES))
            raise ValueError(f"不支持的 MCP server status: {status}; expected one of: {expected}")

    @staticmethod
    def _from_row(row: sqlite3.Row) -> McpServerStatusRecord:
        return McpServerStatusRecord(
            server_id=row["server_id"],
            status=row["status"],
            capabilities=_json_loads(row["capabilities_json"], None),
            server_info=_json_loads(row["server_info_json"], None),
            last_connected_at=row["last_connected_at"],
            last_refresh_at=row["last_refresh_at"],
            last_refresh_revision=int(row["last_refresh_revision"]),
            last_error_code=row["last_error_code"],
            last_error_message=row["last_error_message"],
            last_error_detail=_json_loads(row["last_error_detail_json"], None),
            tools_count=int(row["tools_count"]),
            prompts_count=int(row["prompts_count"]),
            resources_reserved_count=int(row["resources_reserved_count"]),
            updated_at=row["updated_at"],
        )


class McpToolsRepository:
    VALID_RISK_LEVELS = {"low", "medium", "high", "unknown"}
    VALID_DISCOVERY_STATUSES = {"new", "active", "removed", "schema_changed"}

    def __init__(self, db: Database) -> None:
        self.db = db

    def upsert_many(self, server_id: str, tools: list[dict[str, Any]]) -> list[McpToolRecord]:
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            for tool in tools:
                raw_name = self._required_text(tool, "raw_name")
                model_name = self._required_text(tool, "model_name")
                callable_namespace = self._required_text(tool, "callable_namespace")
                callable_name = self._required_text(tool, "callable_name")
                schema_hash = self._required_text(tool, "schema_hash")
                risk_level = str(tool.get("risk_level") or "unknown")
                self._validate_choice("risk_level", risk_level, self.VALID_RISK_LEVELS)
                input_schema = tool.get("input_schema") or {}
                if not isinstance(input_schema, dict):
                    raise ValueError("MCP tool input_schema 必须是 JSON 对象")
                conn.execute(
                    """
                    insert into mcp_tools (
                      id, server_id, raw_name, model_name, callable_namespace, callable_name,
                      display_name, description, input_schema_json, annotations_json, meta_json,
                      schema_hash, risk_level, discovery_status, first_seen_at, last_seen_at,
                      removed_at
                    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, null)
                    on conflict(server_id, raw_name) do update set
                      model_name=excluded.model_name,
                      callable_namespace=excluded.callable_namespace,
                      callable_name=excluded.callable_name,
                      display_name=excluded.display_name,
                      description=excluded.description,
                      input_schema_json=excluded.input_schema_json,
                      annotations_json=excluded.annotations_json,
                      meta_json=excluded.meta_json,
                      schema_hash=excluded.schema_hash,
                      risk_level=excluded.risk_level,
                      discovery_status=case
                        when mcp_tools.schema_hash <> excluded.schema_hash
                          then 'schema_changed'
                        else 'active'
                      end,
                      last_seen_at=excluded.last_seen_at,
                      removed_at=null
                    """,
                    (
                        str(tool.get("id") or new_id()),
                        server_id,
                        raw_name,
                        model_name,
                        callable_namespace,
                        callable_name,
                        tool.get("display_name"),
                        tool.get("description"),
                        _json_dumps(input_schema),
                        _json_dumps(tool.get("annotations"))
                        if tool.get("annotations") is not None
                        else None,
                        _json_dumps(tool.get("meta")) if tool.get("meta") is not None else None,
                        schema_hash,
                        risk_level,
                        now,
                        now,
                    ),
                )
        return self.list_by_server(server_id)

    def mark_removed_missing(self, server_id: str, seen_raw_names: list[str]) -> int:
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            if seen_raw_names:
                placeholders = ", ".join("?" for _ in seen_raw_names)
                cursor = conn.execute(
                    f"""
                    update mcp_tools set
                      discovery_status = 'removed',
                      removed_at = coalesce(removed_at, ?),
                      last_seen_at = ?
                    where server_id = ?
                      and discovery_status <> 'removed'
                      and raw_name not in ({placeholders})
                    """,
                    [now, now, server_id, *seen_raw_names],
                )
            else:
                cursor = conn.execute(
                    """
                    update mcp_tools set
                      discovery_status = 'removed',
                      removed_at = coalesce(removed_at, ?),
                      last_seen_at = ?
                    where server_id = ? and discovery_status <> 'removed'
                    """,
                    (now, now, server_id),
                )
        return int(cursor.rowcount or 0)

    def set_discovery_status(
        self,
        server_id: str,
        raw_name: str,
        status: str,
    ) -> McpToolRecord | None:
        self._validate_choice("discovery_status", status, self.VALID_DISCOVERY_STATUSES)
        now = to_iso_z(utc_now())
        removed_at = now if status == "removed" else None
        with self.db.transaction() as conn:
            conn.execute(
                """
                update mcp_tools set
                  discovery_status = ?,
                  removed_at = ?,
                  last_seen_at = ?
                where server_id = ? and raw_name = ?
                """,
                (status, removed_at, now, server_id, raw_name),
            )
        return self.get_by_raw_name(server_id, raw_name)

    def record_call_result(
        self,
        server_id: str,
        raw_name: str,
        *,
        success: bool,
    ) -> McpToolRecord | None:
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            conn.execute(
                """
                update mcp_tools set
                  call_count = call_count + 1,
                  failure_count = failure_count + ?,
                  last_used_at = ?
                where server_id = ? and raw_name = ?
                """,
                (0 if success else 1, now, server_id, raw_name),
            )
        return self.get_by_raw_name(server_id, raw_name)

    def get_by_raw_name(self, server_id: str, raw_name: str) -> McpToolRecord | None:
        with self.db.connect() as conn:
            row = conn.execute(
                "select * from mcp_tools where server_id = ? and raw_name = ?",
                (server_id, raw_name),
            ).fetchone()
        return self._from_row(row) if row else None

    def get_by_model_name(self, model_name: str) -> McpToolRecord | None:
        with self.db.connect() as conn:
            row = conn.execute(
                "select * from mcp_tools where model_name = ?",
                (model_name,),
            ).fetchone()
        return self._from_row(row) if row else None

    def list_model_names(self, *, limit: int = 10000) -> set[str]:
        resolved_limit = max(1, min(limit, 10000))
        with self.db.connect() as conn:
            rows = conn.execute(
                """
                select model_name from mcp_tools
                order by model_name asc
                limit ?
                """,
                (resolved_limit,),
            ).fetchall()
        return {str(row["model_name"]) for row in rows}

    def list_by_server(
        self,
        server_id: str,
        *,
        status: str | None = None,
        risk_level: str | None = None,
        enabled: bool | None = None,
        limit: int = 500,
    ) -> list[McpToolRecord]:
        filters = ["tools.server_id = ?"]
        params: list[Any] = [server_id]
        if status is not None:
            self._validate_choice("discovery_status", status, self.VALID_DISCOVERY_STATUSES)
            filters.append("tools.discovery_status = ?")
            params.append(status)
        if risk_level is not None:
            self._validate_choice("risk_level", risk_level, self.VALID_RISK_LEVELS)
            filters.append("tools.risk_level = ?")
            params.append(risk_level)
        if enabled is not None:
            filters.append("coalesce(policy.enabled, 1) = ?")
            params.append(int(enabled))
        params.append(max(1, min(limit, 1000)))
        with self.db.connect() as conn:
            rows = conn.execute(
                f"""
                select tools.*
                from mcp_tools tools
                left join mcp_tool_policies policy
                  on policy.server_id = tools.server_id
                 and policy.raw_tool_name = tools.raw_name
                where {" and ".join(filters)}
                order by tools.raw_name asc
                limit ?
                """,
                params,
            ).fetchall()
        return [self._from_row(row) for row in rows]

    @staticmethod
    def _required_text(tool: dict[str, Any], field_name: str) -> str:
        value = str(tool.get(field_name) or "").strip()
        if not value:
            raise ValueError(f"MCP tool {field_name} 不能为空")
        return value

    @staticmethod
    def _validate_choice(field_name: str, value: str, allowed: set[str]) -> None:
        if value not in allowed:
            expected = ", ".join(sorted(allowed))
            raise ValueError(
                f"不支持的 MCP tool {field_name}: {value}; expected one of: {expected}"
            )

    @staticmethod
    def _from_row(row: sqlite3.Row) -> McpToolRecord:
        return McpToolRecord(
            id=row["id"],
            server_id=row["server_id"],
            raw_name=row["raw_name"],
            model_name=row["model_name"],
            callable_namespace=row["callable_namespace"],
            callable_name=row["callable_name"],
            display_name=row["display_name"],
            description=row["description"],
            input_schema=_json_object_loads(
                row["input_schema_json"],
                field_name="input_schema_json",
            ),
            annotations=_json_loads(row["annotations_json"], None),
            meta=_json_loads(row["meta_json"], None),
            schema_hash=row["schema_hash"],
            risk_level=row["risk_level"],
            discovery_status=row["discovery_status"],
            first_seen_at=row["first_seen_at"],
            last_seen_at=row["last_seen_at"],
            removed_at=row["removed_at"],
            last_used_at=row["last_used_at"],
            call_count=int(row["call_count"]),
            failure_count=int(row["failure_count"]),
        )


class McpPromptsRepository:
    VALID_DISCOVERY_STATUSES = {"new", "active", "removed", "schema_changed"}

    def __init__(self, db: Database) -> None:
        self.db = db

    def upsert_many(self, server_id: str, prompts: list[dict[str, Any]]) -> list[McpPromptRecord]:
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            for prompt in prompts:
                raw_name = self._required_text(prompt, "raw_name")
                arguments_schema = prompt.get("arguments_schema") or {}
                if not isinstance(arguments_schema, dict):
                    raise ValueError("MCP prompt arguments_schema 必须是 JSON 对象")
                conn.execute(
                    """
                    insert into mcp_prompts (
                      id, server_id, raw_name, display_name, description,
                      arguments_schema_json, meta_json, discovery_status,
                      first_seen_at, last_seen_at, removed_at
                    ) values (?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, null)
                    on conflict(server_id, raw_name) do update set
                      display_name=excluded.display_name,
                      description=excluded.description,
                      arguments_schema_json=excluded.arguments_schema_json,
                      meta_json=excluded.meta_json,
                      discovery_status=case
                        when mcp_prompts.arguments_schema_json <> excluded.arguments_schema_json
                          then 'schema_changed'
                        else 'active'
                      end,
                      last_seen_at=excluded.last_seen_at,
                      removed_at=null
                    """,
                    (
                        str(prompt.get("id") or new_id()),
                        server_id,
                        raw_name,
                        prompt.get("display_name"),
                        prompt.get("description"),
                        _json_dumps(arguments_schema),
                        _json_dumps(prompt.get("meta")) if prompt.get("meta") is not None else None,
                        now,
                        now,
                    ),
                )
        return self.list_by_server(server_id)

    def mark_removed_missing(self, server_id: str, seen_raw_names: list[str]) -> int:
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            if seen_raw_names:
                placeholders = ", ".join("?" for _ in seen_raw_names)
                cursor = conn.execute(
                    f"""
                    update mcp_prompts set
                      discovery_status = 'removed',
                      removed_at = coalesce(removed_at, ?),
                      last_seen_at = ?
                    where server_id = ?
                      and discovery_status <> 'removed'
                      and raw_name not in ({placeholders})
                    """,
                    [now, now, server_id, *seen_raw_names],
                )
            else:
                cursor = conn.execute(
                    """
                    update mcp_prompts set
                      discovery_status = 'removed',
                      removed_at = coalesce(removed_at, ?),
                      last_seen_at = ?
                    where server_id = ? and discovery_status <> 'removed'
                    """,
                    (now, now, server_id),
                )
        return int(cursor.rowcount or 0)

    def get_by_raw_name(self, server_id: str, raw_name: str) -> McpPromptRecord | None:
        with self.db.connect() as conn:
            row = conn.execute(
                "select * from mcp_prompts where server_id = ? and raw_name = ?",
                (server_id, raw_name),
            ).fetchone()
        return self._from_row(row) if row else None

    def list_by_server(
        self,
        server_id: str,
        *,
        status: str | None = None,
        limit: int = 500,
    ) -> list[McpPromptRecord]:
        filters = ["server_id = ?"]
        params: list[Any] = [server_id]
        if status is not None:
            self._validate_choice("discovery_status", status, self.VALID_DISCOVERY_STATUSES)
            filters.append("discovery_status = ?")
            params.append(status)
        params.append(max(1, min(limit, 1000)))
        with self.db.connect() as conn:
            rows = conn.execute(
                f"""
                select * from mcp_prompts
                where {" and ".join(filters)}
                order by raw_name asc
                limit ?
                """,
                params,
            ).fetchall()
        return [self._from_row(row) for row in rows]

    @staticmethod
    def _required_text(prompt: dict[str, Any], field_name: str) -> str:
        value = str(prompt.get(field_name) or "").strip()
        if not value:
            raise ValueError(f"MCP prompt {field_name} 不能为空")
        return value

    @staticmethod
    def _validate_choice(field_name: str, value: str, allowed: set[str]) -> None:
        if value not in allowed:
            expected = ", ".join(sorted(allowed))
            raise ValueError(
                f"不支持的 MCP prompt {field_name}: {value}; expected one of: {expected}"
            )

    @staticmethod
    def _from_row(row: sqlite3.Row) -> McpPromptRecord:
        return McpPromptRecord(
            id=row["id"],
            server_id=row["server_id"],
            raw_name=row["raw_name"],
            display_name=row["display_name"],
            description=row["description"],
            arguments_schema=_json_object_loads(
                row["arguments_schema_json"],
                field_name="arguments_schema_json",
            ),
            meta=_json_loads(row["meta_json"], None),
            discovery_status=row["discovery_status"],
            first_seen_at=row["first_seen_at"],
            last_seen_at=row["last_seen_at"],
            removed_at=row["removed_at"],
        )


class McpResourcesRepository:
    def __init__(self, db: Database) -> None:
        self.db = db

    def upsert_resources(
        self,
        server_id: str,
        resources: list[dict[str, Any]],
    ) -> list[McpResourceRecord]:
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            for resource in resources:
                uri = self._required_text(resource, "uri")
                conn.execute(
                    """
                    insert into mcp_resources (
                      id, server_id, uri, name, description, mime_type, meta_json,
                      last_seen_at, reserved_only
                    ) values (?, ?, ?, ?, ?, ?, ?, ?, 1)
                    on conflict(server_id, uri) do update set
                      name=excluded.name,
                      description=excluded.description,
                      mime_type=excluded.mime_type,
                      meta_json=excluded.meta_json,
                      last_seen_at=excluded.last_seen_at,
                      reserved_only=1
                    """,
                    (
                        str(resource.get("id") or new_id()),
                        server_id,
                        uri,
                        resource.get("name"),
                        resource.get("description"),
                        resource.get("mime_type"),
                        _json_dumps(resource.get("meta"))
                        if resource.get("meta") is not None
                        else None,
                        now,
                    ),
                )
        return self.list_resources(server_id)

    def upsert_templates(
        self,
        server_id: str,
        templates: list[dict[str, Any]],
    ) -> list[McpResourceTemplateRecord]:
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            for template in templates:
                uri_template = self._required_text(template, "uri_template")
                conn.execute(
                    """
                    insert into mcp_resource_templates (
                      id, server_id, uri_template, name, description, mime_type, meta_json,
                      last_seen_at, reserved_only
                    ) values (?, ?, ?, ?, ?, ?, ?, ?, 1)
                    on conflict(server_id, uri_template) do update set
                      name=excluded.name,
                      description=excluded.description,
                      mime_type=excluded.mime_type,
                      meta_json=excluded.meta_json,
                      last_seen_at=excluded.last_seen_at,
                      reserved_only=1
                    """,
                    (
                        str(template.get("id") or new_id()),
                        server_id,
                        uri_template,
                        template.get("name"),
                        template.get("description"),
                        template.get("mime_type"),
                        _json_dumps(template.get("meta"))
                        if template.get("meta") is not None
                        else None,
                        now,
                    ),
                )
        return self.list_templates(server_id)

    def list_resources(self, server_id: str) -> list[McpResourceRecord]:
        with self.db.connect() as conn:
            rows = conn.execute(
                """
                select * from mcp_resources
                where server_id = ?
                order by uri asc
                """,
                (server_id,),
            ).fetchall()
        return [self._resource_from_row(row) for row in rows]

    def list_templates(self, server_id: str) -> list[McpResourceTemplateRecord]:
        with self.db.connect() as conn:
            rows = conn.execute(
                """
                select * from mcp_resource_templates
                where server_id = ?
                order by uri_template asc
                """,
                (server_id,),
            ).fetchall()
        return [self._template_from_row(row) for row in rows]

    @staticmethod
    def _required_text(item: dict[str, Any], field_name: str) -> str:
        value = str(item.get(field_name) or "").strip()
        if not value:
            raise ValueError(f"MCP resource {field_name} 不能为空")
        return value

    @staticmethod
    def _resource_from_row(row: sqlite3.Row) -> McpResourceRecord:
        return McpResourceRecord(
            id=row["id"],
            server_id=row["server_id"],
            uri=row["uri"],
            name=row["name"],
            description=row["description"],
            mime_type=row["mime_type"],
            meta=_json_loads(row["meta_json"], None),
            last_seen_at=row["last_seen_at"],
            reserved_only=bool(row["reserved_only"]),
        )

    @staticmethod
    def _template_from_row(row: sqlite3.Row) -> McpResourceTemplateRecord:
        return McpResourceTemplateRecord(
            id=row["id"],
            server_id=row["server_id"],
            uri_template=row["uri_template"],
            name=row["name"],
            description=row["description"],
            mime_type=row["mime_type"],
            meta=_json_loads(row["meta_json"], None),
            last_seen_at=row["last_seen_at"],
            reserved_only=bool(row["reserved_only"]),
        )


class McpToolPoliciesRepository:
    VALID_APPROVAL_MODES = {"inherit", "auto", "prompt", "approve", "deny"}
    VALID_RISK_LEVELS = {"low", "medium", "high", "unknown"}
    VALID_SCHEMA_CHANGE_ACTIONS = {"keep_enabled", "require_review", "disable"}

    def __init__(self, db: Database) -> None:
        self.db = db

    def get(self, server_id: str, raw_tool_name: str) -> McpToolPolicyRecord | None:
        with self.db.connect() as conn:
            row = conn.execute(
                """
                select * from mcp_tool_policies
                where server_id = ? and raw_tool_name = ?
                """,
                (server_id, raw_tool_name),
            ).fetchone()
        return self._from_row(row) if row else None

    def list_by_server(self, server_id: str) -> list[McpToolPolicyRecord]:
        with self.db.connect() as conn:
            rows = conn.execute(
                """
                select * from mcp_tool_policies
                where server_id = ?
                order by raw_tool_name asc
                """,
                (server_id,),
            ).fetchall()
        return [self._from_row(row) for row in rows]

    def upsert(
        self,
        *,
        server_id: str,
        raw_tool_name: str,
        enabled: bool = True,
        hidden: bool = False,
        approval_mode: str = "inherit",
        risk_override: str | None = None,
        parameter_constraints: dict[str, Any] | None = None,
        schema_change_action: str = "require_review",
    ) -> McpToolPolicyRecord:
        self._validate(approval_mode, risk_override, schema_change_action)
        existing = self.get(server_id, raw_tool_name)
        policy_id = existing.id if existing else new_id()
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            conn.execute(
                """
                insert into mcp_tool_policies (
                  id, server_id, raw_tool_name, enabled, hidden, approval_mode,
                  risk_override, parameter_constraints_json, schema_change_action, updated_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                on conflict(server_id, raw_tool_name) do update set
                  enabled=excluded.enabled,
                  hidden=excluded.hidden,
                  approval_mode=excluded.approval_mode,
                  risk_override=excluded.risk_override,
                  parameter_constraints_json=excluded.parameter_constraints_json,
                  schema_change_action=excluded.schema_change_action,
                  updated_at=excluded.updated_at
                """,
                (
                    policy_id,
                    server_id,
                    raw_tool_name,
                    int(enabled),
                    int(hidden),
                    approval_mode,
                    risk_override,
                    _json_dumps(parameter_constraints)
                    if parameter_constraints is not None
                    else None,
                    schema_change_action,
                    now,
                ),
            )
        record = self.get(server_id, raw_tool_name)
        if record is None:
            raise RuntimeError(f"写入 MCP tool policy 后无法读取: {server_id}/{raw_tool_name}")
        return record

    def bulk_update(
        self,
        server_id: str,
        policies: list[dict[str, Any]],
    ) -> list[McpToolPolicyRecord]:
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            for policy in policies:
                raw_tool_name = str(policy.get("raw_tool_name") or "").strip()
                if not raw_tool_name:
                    raise ValueError("MCP tool policy raw_tool_name 不能为空")
                approval_mode = str(policy.get("approval_mode") or "inherit")
                risk_override = policy.get("risk_override")
                schema_change_action = str(
                    policy.get("schema_change_action") or "require_review"
                )
                self._validate(approval_mode, risk_override, schema_change_action)
                conn.execute(
                    """
                    insert into mcp_tool_policies (
                      id, server_id, raw_tool_name, enabled, hidden, approval_mode,
                      risk_override, parameter_constraints_json, schema_change_action, updated_at
                    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    on conflict(server_id, raw_tool_name) do update set
                      enabled=excluded.enabled,
                      hidden=excluded.hidden,
                      approval_mode=excluded.approval_mode,
                      risk_override=excluded.risk_override,
                      parameter_constraints_json=excluded.parameter_constraints_json,
                      schema_change_action=excluded.schema_change_action,
                      updated_at=excluded.updated_at
                    """,
                    (
                        str(policy.get("id") or new_id()),
                        server_id,
                        raw_tool_name,
                        int(bool(policy.get("enabled", True))),
                        int(bool(policy.get("hidden", False))),
                        approval_mode,
                        risk_override,
                        _json_dumps(policy.get("parameter_constraints"))
                        if policy.get("parameter_constraints") is not None
                        else None,
                        schema_change_action,
                        now,
                    ),
                )
        return self.list_by_server(server_id)

    @classmethod
    def _validate(
        cls,
        approval_mode: str,
        risk_override: str | None,
        schema_change_action: str,
    ) -> None:
        if approval_mode not in cls.VALID_APPROVAL_MODES:
            raise ValueError(f"不支持的 MCP tool approval_mode: {approval_mode}")
        if risk_override is not None and risk_override not in cls.VALID_RISK_LEVELS:
            raise ValueError(f"不支持的 MCP tool risk_override: {risk_override}")
        if schema_change_action not in cls.VALID_SCHEMA_CHANGE_ACTIONS:
            raise ValueError(f"不支持的 MCP tool schema_change_action: {schema_change_action}")

    @staticmethod
    def _from_row(row: sqlite3.Row) -> McpToolPolicyRecord:
        return McpToolPolicyRecord(
            id=row["id"],
            server_id=row["server_id"],
            raw_tool_name=row["raw_tool_name"],
            enabled=bool(row["enabled"]),
            hidden=bool(row["hidden"]),
            approval_mode=row["approval_mode"],
            risk_override=row["risk_override"],
            parameter_constraints=_json_loads(row["parameter_constraints_json"], None),
            schema_change_action=row["schema_change_action"],
            updated_at=row["updated_at"],
        )


class McpPromptPoliciesRepository:
    VALID_EXPOSURE_MODES = {"hidden", "manual", "slash_command", "agent_selectable"}

    def __init__(self, db: Database) -> None:
        self.db = db

    def get(self, server_id: str, raw_prompt_name: str) -> McpPromptPolicyRecord | None:
        with self.db.connect() as conn:
            row = conn.execute(
                """
                select * from mcp_prompt_policies
                where server_id = ? and raw_prompt_name = ?
                """,
                (server_id, raw_prompt_name),
            ).fetchone()
        return self._from_row(row) if row else None

    def list_by_server(self, server_id: str) -> list[McpPromptPolicyRecord]:
        with self.db.connect() as conn:
            rows = conn.execute(
                """
                select * from mcp_prompt_policies
                where server_id = ?
                order by raw_prompt_name asc
                """,
                (server_id,),
            ).fetchall()
        return [self._from_row(row) for row in rows]

    def upsert(
        self,
        *,
        server_id: str,
        raw_prompt_name: str,
        enabled: bool = True,
        exposure_mode: str = "manual",
    ) -> McpPromptPolicyRecord:
        if exposure_mode not in self.VALID_EXPOSURE_MODES:
            raise ValueError(f"不支持的 MCP prompt exposure_mode: {exposure_mode}")
        now = to_iso_z(utc_now())
        existing = self.get(server_id, raw_prompt_name)
        with self.db.transaction() as conn:
            conn.execute(
                """
                insert into mcp_prompt_policies (
                  id, server_id, raw_prompt_name, enabled, exposure_mode, updated_at
                ) values (?, ?, ?, ?, ?, ?)
                on conflict(server_id, raw_prompt_name) do update set
                  enabled=excluded.enabled,
                  exposure_mode=excluded.exposure_mode,
                  updated_at=excluded.updated_at
                """,
                (
                    existing.id if existing else new_id(),
                    server_id,
                    raw_prompt_name,
                    int(enabled),
                    exposure_mode,
                    now,
                ),
            )
        record = self.get(server_id, raw_prompt_name)
        if record is None:
            raise RuntimeError(f"写入 MCP prompt policy 后无法读取: {server_id}/{raw_prompt_name}")
        return record

    @staticmethod
    def _from_row(row: sqlite3.Row) -> McpPromptPolicyRecord:
        return McpPromptPolicyRecord(
            id=row["id"],
            server_id=row["server_id"],
            raw_prompt_name=row["raw_prompt_name"],
            enabled=bool(row["enabled"]),
            exposure_mode=row["exposure_mode"],
            updated_at=row["updated_at"],
        )


class McpSessionToolOverridesRepository:
    def __init__(self, db: Database) -> None:
        self.db = db

    def set(
        self,
        *,
        session_id: str,
        server_id: str,
        raw_tool_name: str,
        enabled: bool,
        reason: str | None = None,
        expires_at: str | None = None,
    ) -> McpSessionToolOverrideRecord:
        now = to_iso_z(utc_now())
        existing = self.get(session_id, server_id, raw_tool_name)
        with self.db.transaction() as conn:
            conn.execute(
                """
                insert into mcp_session_tool_overrides (
                  id, session_id, server_id, raw_tool_name, enabled, reason,
                  created_at, expires_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?)
                on conflict(session_id, server_id, raw_tool_name) do update set
                  enabled=excluded.enabled,
                  reason=excluded.reason,
                  expires_at=excluded.expires_at
                """,
                (
                    existing.id if existing else new_id(),
                    session_id,
                    server_id,
                    raw_tool_name,
                    int(enabled),
                    reason,
                    existing.created_at if existing else now,
                    expires_at,
                ),
            )
        record = self.get(session_id, server_id, raw_tool_name)
        if record is None:
            raise RuntimeError("写入 MCP session override 后无法读取")
        return record

    def get(
        self,
        session_id: str,
        server_id: str,
        raw_tool_name: str,
    ) -> McpSessionToolOverrideRecord | None:
        with self.db.connect() as conn:
            row = conn.execute(
                """
                select * from mcp_session_tool_overrides
                where session_id = ? and server_id = ? and raw_tool_name = ?
                """,
                (session_id, server_id, raw_tool_name),
            ).fetchone()
        return self._from_row(row) if row else None

    def list_by_session(self, session_id: str) -> list[McpSessionToolOverrideRecord]:
        with self.db.connect() as conn:
            rows = conn.execute(
                """
                select * from mcp_session_tool_overrides
                where session_id = ?
                order by created_at desc, raw_tool_name asc
                """,
                (session_id,),
            ).fetchall()
        return [self._from_row(row) for row in rows]

    def delete(self, session_id: str, server_id: str, raw_tool_name: str) -> bool:
        with self.db.transaction() as conn:
            cursor = conn.execute(
                """
                delete from mcp_session_tool_overrides
                where session_id = ? and server_id = ? and raw_tool_name = ?
                """,
                (session_id, server_id, raw_tool_name),
            )
        return int(cursor.rowcount or 0) > 0

    @staticmethod
    def _from_row(row: sqlite3.Row) -> McpSessionToolOverrideRecord:
        return McpSessionToolOverrideRecord(
            id=row["id"],
            session_id=row["session_id"],
            server_id=row["server_id"],
            raw_tool_name=row["raw_tool_name"],
            enabled=bool(row["enabled"]),
            reason=row["reason"],
            created_at=row["created_at"],
            expires_at=row["expires_at"],
        )


class McpRuntimeSnapshotsRepository:
    def __init__(self, db: Database) -> None:
        self.db = db

    def save(
        self,
        *,
        snapshot_id: str,
        session_id: str,
        tool_inventory_revision: int,
        visible_tools: list[Any],
        server_status: dict[str, Any],
        policy_summary: dict[str, Any],
        turn_id: str | None = None,
    ) -> McpRuntimeSnapshotRecord:
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            conn.execute(
                """
                insert into mcp_runtime_snapshots (
                  id, session_id, turn_id, tool_inventory_revision, visible_tools_json,
                  server_status_json, policy_summary_json, created_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    snapshot_id,
                    session_id,
                    turn_id,
                    tool_inventory_revision,
                    _json_dumps(visible_tools),
                    _json_dumps(server_status),
                    _json_dumps(policy_summary),
                    now,
                ),
            )
        record = self.get(snapshot_id)
        if record is None:
            raise RuntimeError(f"保存 MCP runtime snapshot 后无法读取: {snapshot_id}")
        return record

    def get(self, snapshot_id: str) -> McpRuntimeSnapshotRecord | None:
        with self.db.connect() as conn:
            row = conn.execute(
                "select * from mcp_runtime_snapshots where id = ?",
                (snapshot_id,),
            ).fetchone()
        return self._from_row(row) if row else None

    def list_by_session(
        self,
        session_id: str,
        *,
        turn_id: str | None = None,
        limit: int = 100,
    ) -> list[McpRuntimeSnapshotRecord]:
        filters = ["session_id = ?"]
        params: list[Any] = [session_id]
        if turn_id is not None:
            filters.append("turn_id = ?")
            params.append(turn_id)
        params.append(max(1, min(limit, 500)))
        with self.db.connect() as conn:
            rows = conn.execute(
                f"""
                select * from mcp_runtime_snapshots
                where {" and ".join(filters)}
                order by created_at desc, id desc
                limit ?
                """,
                params,
            ).fetchall()
        return [self._from_row(row) for row in rows]

    @staticmethod
    def _from_row(row: sqlite3.Row) -> McpRuntimeSnapshotRecord:
        return McpRuntimeSnapshotRecord(
            id=row["id"],
            session_id=row["session_id"],
            turn_id=row["turn_id"],
            tool_inventory_revision=int(row["tool_inventory_revision"]),
            visible_tools=_json_array_loads(
                row["visible_tools_json"],
                field_name="visible_tools_json",
            ),
            server_status=_json_object_loads(
                row["server_status_json"],
                field_name="server_status_json",
            ),
            policy_summary=_json_object_loads(
                row["policy_summary_json"],
                field_name="policy_summary_json",
            ),
            created_at=row["created_at"],
        )


class McpOAuthTokensRepository:
    VALID_STATUSES = {"active", "expired", "revoked", "error"}

    def __init__(self, db: Database) -> None:
        self.db = db

    def upsert_for_server(
        self,
        *,
        server_id: str,
        token_ref: str,
        token_id: str | None = None,
        account_label: str | None = None,
        refresh_token_ref: str | None = None,
        scopes: list[Any] | None = None,
        expires_at: str | None = None,
        status: str = "active",
    ) -> McpOAuthTokenRecord:
        self._validate_status(status)
        resolved_id = token_id or new_id()
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            conn.execute(
                """
                update mcp_oauth_tokens set
                  status='revoked',
                  updated_at=?
                where server_id=? and status='active' and id != ?
                """,
                (now, server_id, resolved_id),
            )
            conn.execute(
                """
                insert into mcp_oauth_tokens (
                  id, server_id, account_label, token_ref, refresh_token_ref,
                  scopes_json, expires_at, status, created_at, updated_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                on conflict(id) do update set
                  account_label=excluded.account_label,
                  token_ref=excluded.token_ref,
                  refresh_token_ref=excluded.refresh_token_ref,
                  scopes_json=excluded.scopes_json,
                  expires_at=excluded.expires_at,
                  status=excluded.status,
                  updated_at=excluded.updated_at
                """,
                (
                    resolved_id,
                    server_id,
                    account_label,
                    token_ref,
                    refresh_token_ref,
                    _json_dumps(scopes) if scopes is not None else None,
                    expires_at,
                    status,
                    now,
                    now,
                ),
            )
        record = self.get(resolved_id)
        if record is None:
            raise RuntimeError(f"写入 MCP OAuth token 后无法读取: {resolved_id}")
        return record

    def get(self, token_id: str) -> McpOAuthTokenRecord | None:
        with self.db.connect() as conn:
            row = conn.execute(
                "select * from mcp_oauth_tokens where id = ?",
                (token_id,),
            ).fetchone()
        return self._from_row(row) if row else None

    def get_active_for_server(self, server_id: str) -> McpOAuthTokenRecord | None:
        with self.db.connect() as conn:
            row = conn.execute(
                """
                select * from mcp_oauth_tokens
                where server_id = ? and status = 'active'
                order by updated_at desc, id desc
                limit 1
                """,
                (server_id,),
            ).fetchone()
        return self._from_row(row) if row else None

    def list(
        self,
        *,
        server_id: str | None = None,
        status: str | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> tuple[list[McpOAuthTokenRecord], int]:
        if status is not None:
            self._validate_status(status)
        filters: list[str] = []
        params: list[Any] = []
        if server_id is not None:
            filters.append("server_id = ?")
            params.append(server_id)
        if status is not None:
            filters.append("status = ?")
            params.append(status)
        where = f"where {' and '.join(filters)}" if filters else ""
        resolved_limit = max(1, min(limit, 500))
        resolved_offset = max(0, offset)
        with self.db.connect() as conn:
            total = conn.execute(
                f"select count(*) as total from mcp_oauth_tokens {where}",
                params,
            ).fetchone()
            rows = conn.execute(
                f"""
                select * from mcp_oauth_tokens
                {where}
                order by updated_at desc, id desc
                limit ? offset ?
                """,
                [*params, resolved_limit, resolved_offset],
            ).fetchall()
        return [self._from_row(row) for row in rows], int(total["total"])

    def set_status(self, token_id: str, status: str) -> McpOAuthTokenRecord | None:
        self._validate_status(status)
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            cursor = conn.execute(
                "update mcp_oauth_tokens set status = ?, updated_at = ? where id = ?",
                (status, now, token_id),
            )
        if cursor.rowcount == 0:
            return None
        return self.get(token_id)

    def clear_for_server(self, server_id: str, *, status: str = "revoked") -> int:
        self._validate_status(status)
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            cursor = conn.execute(
                """
                update mcp_oauth_tokens set
                  status = ?,
                  updated_at = ?
                where server_id = ? and status != ?
                """,
                (status, now, server_id, status),
            )
        return cursor.rowcount

    @classmethod
    def _validate_status(cls, status: str) -> None:
        if status not in cls.VALID_STATUSES:
            raise ValueError(f"不支持的 MCP OAuth token status: {status}")

    @staticmethod
    def _from_row(row: sqlite3.Row) -> McpOAuthTokenRecord:
        return McpOAuthTokenRecord(
            id=row["id"],
            server_id=row["server_id"],
            account_label=row["account_label"],
            token_ref=row["token_ref"],
            refresh_token_ref=row["refresh_token_ref"],
            scopes=_json_loads(row["scopes_json"], None),
            expires_at=row["expires_at"],
            status=row["status"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )


class McpTrustRulesRepository:
    VALID_RULE_KINDS = {"server_readonly", "tool", "tool_with_params", "deny_tool"}
    VALID_SCOPES = {"session", "global"}
    VALID_APPROVAL_MODES = {"approve", "deny"}

    def __init__(self, db: Database) -> None:
        self.db = db

    def create(
        self,
        *,
        rule_id: str,
        rule_kind: str,
        scope: str,
        approval_mode: str,
        server_id: str | None = None,
        raw_tool_name: str | None = None,
        session_id: str | None = None,
        condition: dict[str, Any] | None = None,
        created_from_approval_id: str | None = None,
        expires_at: str | None = None,
    ) -> McpTrustRuleRecord:
        self._validate(rule_kind, scope, approval_mode)
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            conn.execute(
                """
                insert into mcp_trust_rules (
                  id, server_id, raw_tool_name, rule_kind, scope, session_id,
                  condition_json, approval_mode, created_from_approval_id, expires_at,
                  created_at, updated_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    rule_id,
                    server_id,
                    raw_tool_name,
                    rule_kind,
                    scope,
                    session_id,
                    _json_dumps(condition) if condition is not None else None,
                    approval_mode,
                    created_from_approval_id,
                    expires_at,
                    now,
                    now,
                ),
            )
        record = self.get(rule_id)
        if record is None:
            raise RuntimeError(f"创建 MCP trust rule 后无法读取: {rule_id}")
        return record

    def get(self, rule_id: str) -> McpTrustRuleRecord | None:
        with self.db.connect() as conn:
            row = conn.execute("select * from mcp_trust_rules where id = ?", (rule_id,)).fetchone()
        return self._from_row(row) if row else None

    def list(
        self,
        *,
        server_id: str | None = None,
        scope: str | None = None,
        session_id: str | None = None,
        limit: int = 200,
    ) -> list[McpTrustRuleRecord]:
        filters: list[str] = []
        params: list[Any] = []
        if server_id is not None:
            filters.append("server_id = ?")
            params.append(server_id)
        if scope is not None:
            if scope not in self.VALID_SCOPES:
                raise ValueError(f"不支持的 MCP trust scope: {scope}")
            filters.append("scope = ?")
            params.append(scope)
        if session_id is not None:
            filters.append("session_id = ?")
            params.append(session_id)
        where = f"where {' and '.join(filters)}" if filters else ""
        params.append(max(1, min(limit, 500)))
        with self.db.connect() as conn:
            rows = conn.execute(
                f"""
                select * from mcp_trust_rules
                {where}
                order by created_at desc, id desc
                limit ?
                """,
                params,
            ).fetchall()
        return [self._from_row(row) for row in rows]

    def touch_hit(self, rule_id: str) -> McpTrustRuleRecord | None:
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            cursor = conn.execute(
                """
                update mcp_trust_rules set
                  hit_count = hit_count + 1,
                  last_hit_at = ?,
                  updated_at = ?
                where id = ?
                """,
                (now, now, rule_id),
            )
        if cursor.rowcount == 0:
            return None
        return self.get(rule_id)

    def delete(self, rule_id: str) -> bool:
        with self.db.transaction() as conn:
            cursor = conn.execute("delete from mcp_trust_rules where id = ?", (rule_id,))
        return int(cursor.rowcount or 0) > 0

    @classmethod
    def _validate(cls, rule_kind: str, scope: str, approval_mode: str) -> None:
        if rule_kind not in cls.VALID_RULE_KINDS:
            raise ValueError(f"不支持的 MCP trust rule_kind: {rule_kind}")
        if scope not in cls.VALID_SCOPES:
            raise ValueError(f"不支持的 MCP trust scope: {scope}")
        if approval_mode not in cls.VALID_APPROVAL_MODES:
            raise ValueError(f"不支持的 MCP trust approval_mode: {approval_mode}")

    @staticmethod
    def _from_row(row: sqlite3.Row) -> McpTrustRuleRecord:
        return McpTrustRuleRecord(
            id=row["id"],
            server_id=row["server_id"],
            raw_tool_name=row["raw_tool_name"],
            rule_kind=row["rule_kind"],
            scope=row["scope"],
            session_id=row["session_id"],
            condition=_json_loads(row["condition_json"], None),
            approval_mode=row["approval_mode"],
            hit_count=int(row["hit_count"]),
            created_from_approval_id=row["created_from_approval_id"],
            expires_at=row["expires_at"],
            last_hit_at=row["last_hit_at"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )


class McpAuditLogRepository:
    def __init__(self, db: Database) -> None:
        self.db = db

    def append(
        self,
        *,
        audit_id: str,
        event_type: str,
        server_id: str | None = None,
        raw_tool_name: str | None = None,
        prompt_name: str | None = None,
        session_id: str | None = None,
        turn_id: str | None = None,
        call_id: str | None = None,
        approval_id: str | None = None,
        actor: str | None = None,
        status: str | None = None,
        duration_ms: int | None = None,
        summary: str | None = None,
        detail: dict[str, Any] | None = None,
    ) -> McpAuditLogRecord:
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            conn.execute(
                """
                insert into mcp_audit_log (
                  id, event_type, server_id, raw_tool_name, prompt_name, session_id,
                  turn_id, call_id, approval_id, actor, status, duration_ms, summary,
                  detail_json, created_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    audit_id,
                    event_type,
                    server_id,
                    raw_tool_name,
                    prompt_name,
                    session_id,
                    turn_id,
                    call_id,
                    approval_id,
                    actor,
                    status,
                    duration_ms,
                    summary,
                    _json_dumps(detail) if detail is not None else None,
                    now,
                ),
            )
        record = self.get(audit_id)
        if record is None:
            raise RuntimeError(f"写入 MCP audit 后无法读取: {audit_id}")
        return record

    def get(self, audit_id: str) -> McpAuditLogRecord | None:
        with self.db.connect() as conn:
            row = conn.execute("select * from mcp_audit_log where id = ?", (audit_id,)).fetchone()
        return self._from_row(row) if row else None

    def list(
        self,
        *,
        server_id: str | None = None,
        session_id: str | None = None,
        event_type: str | None = None,
        status: str | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> tuple[list[McpAuditLogRecord], int]:
        filters: list[str] = []
        params: list[Any] = []
        if server_id is not None:
            filters.append("server_id = ?")
            params.append(server_id)
        if session_id is not None:
            filters.append("session_id = ?")
            params.append(session_id)
        if event_type is not None:
            filters.append("event_type = ?")
            params.append(event_type)
        if status is not None:
            filters.append("status = ?")
            params.append(status)
        where = f"where {' and '.join(filters)}" if filters else ""
        resolved_limit = max(1, min(limit, 500))
        resolved_offset = max(0, offset)
        with self.db.connect() as conn:
            total = conn.execute(
                f"select count(*) as total from mcp_audit_log {where}",
                params,
            ).fetchone()
            rows = conn.execute(
                f"""
                select * from mcp_audit_log
                {where}
                order by created_at desc, id desc
                limit ? offset ?
                """,
                [*params, resolved_limit, resolved_offset],
            ).fetchall()
        return [self._from_row(row) for row in rows], int(total["total"])

    @staticmethod
    def _from_row(row: sqlite3.Row) -> McpAuditLogRecord:
        return McpAuditLogRecord(
            id=row["id"],
            event_type=row["event_type"],
            server_id=row["server_id"],
            raw_tool_name=row["raw_tool_name"],
            prompt_name=row["prompt_name"],
            session_id=row["session_id"],
            turn_id=row["turn_id"],
            call_id=row["call_id"],
            approval_id=row["approval_id"],
            actor=row["actor"],
            status=row["status"],
            duration_ms=row["duration_ms"],
            summary=row["summary"],
            detail=_json_loads(row["detail_json"], None),
            created_at=row["created_at"],
        )


class SettingsRepository:
    def __init__(self, db: Database) -> None:
        self.db = db

    def set(self, key: str, value: Any) -> None:
        with self.db.transaction() as conn:
            conn.execute(
                """
                insert into settings (key, value_json, updated_at)
                values (?, ?, ?)
                on conflict(key) do update set
                  value_json=excluded.value_json,
                  updated_at=excluded.updated_at
                """,
                (key, _json_dumps(value), to_iso_z(utc_now())),
            )

    def get(self, key: str, default: Any = None) -> Any:
        with self.db.connect() as conn:
            row = conn.execute("select value_json from settings where key = ?", (key,)).fetchone()
        return _json_loads(row["value_json"], default) if row else default


class ModelProvidersRepository:
    def __init__(self, db: Database) -> None:
        self.db = db

    def upsert(self, provider: ModelProviderRecord) -> None:
        with self.db.transaction() as conn:
            conn.execute(
                """
                insert into model_providers (
                  id, name, base_url, api_key_encrypted, enabled, models_json,
                  model_enabled_json, health_json, created_at, updated_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                on conflict(id) do update set
                  name=excluded.name,
                  base_url=excluded.base_url,
                  api_key_encrypted=excluded.api_key_encrypted,
                  enabled=excluded.enabled,
                  models_json=excluded.models_json,
                  model_enabled_json=excluded.model_enabled_json,
                  health_json=excluded.health_json,
                  updated_at=excluded.updated_at
                """,
                (
                    provider.id,
                    provider.name,
                    provider.base_url,
                    provider.api_key,
                    int(provider.enabled),
                    _json_dumps(provider.models),
                    _json_dumps(provider.model_enabled),
                    _json_dumps(provider.health),
                    provider.created_at,
                    provider.updated_at,
                ),
            )

    def get(self, provider_id: str) -> ModelProviderRecord | None:
        with self.db.connect() as conn:
            row = conn.execute(
                "select * from model_providers where id = ?",
                (provider_id,),
            ).fetchone()
        return self._from_row(row) if row else None

    def list(self) -> list[ModelProviderRecord]:
        with self.db.connect() as conn:
            rows = conn.execute(
                "select * from model_providers order by created_at, name",
            ).fetchall()
        return [self._from_row(row) for row in rows]

    def delete(self, provider_id: str) -> bool:
        with self.db.transaction() as conn:
            cursor = conn.execute("delete from model_providers where id = ?", (provider_id,))
        return cursor.rowcount > 0

    def set_model_default(self, *, scope: str, provider_id: str, model: str) -> None:
        cleaned_scope = _require_model_default_scope(scope)
        cleaned_model = model.strip()
        if not cleaned_model:
            raise ValueError("model default model must not be empty")
        with self.db.transaction() as conn:
            conn.execute(
                """
                insert into model_defaults (scope, provider_id, model, updated_at)
                values (?, ?, ?, ?)
                on conflict(scope) do update set
                  provider_id=excluded.provider_id,
                  model=excluded.model,
                  updated_at=excluded.updated_at
                """,
                (cleaned_scope, provider_id, cleaned_model, to_iso_z(utc_now())),
            )

    def get_model_default(self, scope: str) -> ModelDefaultRecord | None:
        cleaned_scope = _require_model_default_scope(scope)
        with self.db.connect() as conn:
            row = conn.execute(
                "select * from model_defaults where scope = ?",
                (cleaned_scope,),
            ).fetchone()
        return (
            ModelDefaultRecord(
                scope=row["scope"],
                provider_id=row["provider_id"],
                model=row["model"],
                updated_at=row["updated_at"],
            )
            if row
            else None
        )

    def delete_model_default(self, scope: str) -> bool:
        cleaned_scope = _require_model_default_scope(scope)
        with self.db.transaction() as conn:
            cursor = conn.execute("delete from model_defaults where scope = ?", (cleaned_scope,))
        return cursor.rowcount > 0

    @staticmethod
    def _from_row(row: sqlite3.Row) -> ModelProviderRecord:
        return ModelProviderRecord(
            id=row["id"],
            name=row["name"],
            base_url=row["base_url"],
            api_key=row["api_key_encrypted"],
            enabled=bool(row["enabled"]),
            models=_json_loads(row["models_json"], []),
            model_enabled=_json_loads(row["model_enabled_json"], {}),
            health=_json_loads(row["health_json"], {}),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )


class WorkspacesRepository:
    VALID_TYPES = {"project"}

    def __init__(self, db: Database) -> None:
        self.db = db

    def create(
        self,
        *,
        workspace_id: str,
        root_path: str | Path,
        name: str | None = None,
        workspace_type: str = "project",
        last_opened_at: str | None = None,
    ) -> WorkspaceRecord:
        self._validate_type(workspace_type)
        resolved_root = self._resolve_workspace_directory(root_path)
        normalized_root = normalize_workspace_root_for_storage(resolved_root)
        existing = self.get_by_normalized_root_path(normalized_root)
        if existing is not None:
            return existing

        now = to_iso_z(utc_now())
        resolved_name = self._resolve_name(name, resolved_root)
        with self.db.transaction() as conn:
            conn.execute(
                """
                insert into workspaces (
                  id, name, root_path, normalized_root_path, type, created_at,
                  updated_at, last_opened_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    workspace_id,
                    resolved_name,
                    str(resolved_root),
                    normalized_root,
                    workspace_type,
                    now,
                    now,
                    last_opened_at,
                ),
            )
        record = self.get(workspace_id)
        if record is None:
            raise RuntimeError(f"创建 workspace 后无法读取: {workspace_id}")
        return record

    def get(self, workspace_id: str, *, include_deleted: bool = False) -> WorkspaceRecord | None:
        query = "select * from workspaces where id = ?"
        params: list[Any] = [workspace_id]
        if not include_deleted:
            query += " and is_deleted = 0"
        with self.db.connect() as conn:
            row = conn.execute(query, params).fetchone()
        return self._from_row(row) if row else None

    def get_by_root_path(
        self,
        root_path: str | Path,
        *,
        include_deleted: bool = False,
    ) -> WorkspaceRecord | None:
        resolved_root = self._resolve_workspace_directory(root_path)
        return self.get_by_normalized_root_path(
            normalize_workspace_root_for_storage(resolved_root),
            include_deleted=include_deleted,
        )

    def get_by_normalized_root_path(
        self,
        normalized_root_path: str,
        *,
        include_deleted: bool = False,
    ) -> WorkspaceRecord | None:
        query = "select * from workspaces where normalized_root_path = ?"
        params: list[Any] = [normalized_root_path]
        if not include_deleted:
            query += " and is_deleted = 0"
        query += " order by is_deleted asc, updated_at desc, created_at desc limit 1"
        with self.db.connect() as conn:
            row = conn.execute(query, params).fetchone()
        return self._from_row(row) if row else None

    def list(
        self,
        *,
        include_deleted: bool = False,
        limit: int = 100,
    ) -> list[WorkspaceRecord]:
        filters: list[str] = []
        if not include_deleted:
            filters.append("is_deleted = 0")
        where = f"where {' and '.join(filters)}" if filters else ""
        with self.db.connect() as conn:
            rows = conn.execute(
                f"""
                select * from workspaces
                {where}
                order by
                  last_opened_at is null,
                  last_opened_at desc,
                  updated_at desc,
                  created_at desc,
                  name asc
                limit ?
                """,
                (max(1, min(limit, 500)),),
            ).fetchall()
        return [self._from_row(row) for row in rows]

    def update(
        self,
        workspace_id: str,
        *,
        name: str | None = None,
        root_path: str | Path | None = None,
        workspace_type: str | None = None,
        last_opened_at: str | None = None,
    ) -> WorkspaceRecord | None:
        assignments: list[str] = []
        params: list[Any] = []
        if name is not None:
            assignments.append("name = ?")
            params.append(self._resolve_name(name, None))
        if root_path is not None:
            resolved_root = self._resolve_workspace_directory(root_path)
            assignments.extend(["root_path = ?", "normalized_root_path = ?"])
            params.extend([str(resolved_root), normalize_workspace_root_for_storage(resolved_root)])
        if workspace_type is not None:
            self._validate_type(workspace_type)
            assignments.append("type = ?")
            params.append(workspace_type)
        if last_opened_at is not None:
            assignments.append("last_opened_at = ?")
            params.append(last_opened_at)
        if not assignments:
            return self.get(workspace_id)

        assignments.append("updated_at = ?")
        params.append(to_iso_z(utc_now()))
        params.append(workspace_id)
        with self.db.transaction() as conn:
            cursor = conn.execute(
                f"""
                update workspaces
                set {", ".join(assignments)}
                where id = ? and is_deleted = 0
                """,
                params,
            )
        if cursor.rowcount == 0:
            return None
        return self.get(workspace_id)

    def touch(self, workspace_id: str, *, opened_at: str | None = None) -> WorkspaceRecord | None:
        return self.update(workspace_id, last_opened_at=opened_at or to_iso_z(utc_now()))

    def soft_delete(self, workspace_id: str) -> WorkspaceRecord | None:
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            cursor = conn.execute(
                """
                update workspaces
                set is_deleted = 1, updated_at = ?
                where id = ? and is_deleted = 0
                """,
                (now, workspace_id),
            )
        if cursor.rowcount == 0:
            return None
        return self.get(workspace_id, include_deleted=True)

    @classmethod
    def _validate_type(cls, workspace_type: str) -> None:
        if workspace_type not in cls.VALID_TYPES:
            raise ValueError(f"不支持的 workspace 类型: {workspace_type}")

    @staticmethod
    def _resolve_workspace_directory(root_path: str | Path) -> Path:
        root_text = str(root_path).strip()
        if not root_text:
            raise WorkspacePathError("工作区路径不能为空")
        resolved = Path(root_text).expanduser().resolve()
        if not resolved.exists():
            raise WorkspacePathError(f"工作区路径不存在: {root_path}")
        if not resolved.is_dir():
            raise WorkspacePathError(f"工作区路径不是目录: {root_path}")
        return resolved

    @staticmethod
    def _resolve_name(name: str | None, root_path: Path | None) -> str:
        cleaned = str(name or "").strip()
        if cleaned:
            return cleaned
        if root_path is not None and root_path.name:
            return root_path.name
        raise ValueError("工作区名称不能为空")

    @staticmethod
    def _from_row(row: sqlite3.Row) -> WorkspaceRecord:
        return WorkspaceRecord(
            id=row["id"],
            name=row["name"],
            root_path=row["root_path"],
            normalized_root_path=row["normalized_root_path"],
            type=row["type"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            last_opened_at=row["last_opened_at"],
            is_deleted=bool(row["is_deleted"]),
        )


class SessionsRepository:
    INTERNAL_CONTEXT_COMPRESSION_SESSION_TAG = "__context_compression_active__"
    VALID_STATUSES = {"active", "closed", "failed", "running", "waiting_approval"}
    VALID_SESSION_TYPES = {"workspace", "chat"}
    VALID_TITLE_SOURCES = {"auto_candidate", "auto", "manual"}

    def __init__(self, db: Database) -> None:
        self.db = db

    def create(
        self,
        *,
        session_id: str,
        user_id: str,
        scene_id: str,
        title: str | None = None,
        status: str = "active",
        session_tag: str = "chat",
        scene_version_seq: int | None = None,
        active_session_id: str | None = None,
        is_debug: bool = False,
        workspace_id: str | None = None,
        session_type: str = "chat",
        cwd: str | None = None,
        workspace_roots: list[str] | None = None,
        current_model_provider_id: str | None = None,
        current_model: str | None = None,
        context_compression_epoch: int = 0,
        title_source: str = "auto_candidate",
        parent_session_id: str | None = None,
        child_session_id: str | None = None,
        source_trace_id: str | None = None,
        source_active_session_id: str | None = None,
        source_checkpoint_id: str | None = None,
        source_checkpoint_ns: str | None = None,
    ) -> SessionRecord:
        self._validate_status(status)
        self._validate_session_type(session_type)
        self._validate_title_source(title_source)
        now = to_iso_z(utc_now())
        resolved_active_session_id = active_session_id or session_id
        with self.db.transaction() as conn:
            conn.execute(
                """
                insert into sessions (
                  id, user_id, scene_id, scene_version_seq, status, is_debug,
                  session_tag, active_session_id, workspace_id, session_type, cwd,
                  workspace_roots_json, current_model_provider_id, current_model,
                  context_compression_epoch, title, title_source,
                  parent_session_id, child_session_id,
                  source_trace_id, source_active_session_id,
                  source_checkpoint_id, source_checkpoint_ns, created_at, updated_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    session_id,
                    user_id,
                    scene_id,
                    scene_version_seq,
                    status,
                    int(is_debug),
                    session_tag,
                    resolved_active_session_id,
                    workspace_id,
                    session_type,
                    cwd,
                    _json_dumps(workspace_roots or []),
                    current_model_provider_id,
                    current_model,
                    int(context_compression_epoch),
                    title,
                    title_source,
                    parent_session_id,
                    child_session_id,
                    source_trace_id,
                    source_active_session_id,
                    source_checkpoint_id,
                    source_checkpoint_ns,
                    now,
                    now,
                ),
            )
        record = self.get(session_id)
        if record is None:
            raise RuntimeError(f"创建 session 后无法读取: {session_id}")
        return record

    def get(self, session_id: str, *, include_deleted: bool = False) -> SessionRecord | None:
        query = "select * from sessions where id = ?"
        params: list[Any] = [session_id]
        if not include_deleted:
            query += " and is_deleted = 0"
        with self.db.connect() as conn:
            row = conn.execute(query, params).fetchone()
        return self._from_row(row) if row else None

    def list(
        self,
        *,
        user_id: str | None = None,
        scene_id: str | None = None,
        status: str | None = None,
        session_tag: str | None = None,
        workspace_id: str | None = None,
        session_type: str | None = None,
        include_deleted: bool = False,
        include_internal: bool = False,
        limit: int = 100,
    ) -> list[SessionRecord]:
        filters: list[str] = []
        params: list[Any] = []
        if user_id is not None:
            filters.append("user_id = ?")
            params.append(user_id)
        if scene_id is not None:
            filters.append("scene_id = ?")
            params.append(scene_id)
        if status is not None:
            self._validate_status(status)
            filters.append("status = ?")
            params.append(status)
        if session_tag is not None:
            filters.append("session_tag = ?")
            params.append(session_tag)
        if workspace_id is not None:
            filters.append("workspace_id = ?")
            params.append(workspace_id)
        if session_type is not None:
            self._validate_session_type(session_type)
            filters.append("session_type = ?")
            params.append(session_type)
        if not include_internal and session_tag is None:
            filters.append("(session_tag is null or session_tag != ?)")
            params.append(self.INTERNAL_CONTEXT_COMPRESSION_SESSION_TAG)
            filters.append(
                """
                not (
                  source_active_session_id is not null
                  and source_checkpoint_id is not null
                  and parent_session_id is not null
                  and active_session_id = id
                )
                """
            )
        if not include_deleted:
            filters.append("is_deleted = 0")

        where = f"where {' and '.join(filters)}" if filters else ""
        params.append(max(1, min(limit, 500)))
        with self.db.connect() as conn:
            rows = conn.execute(
                f"""
                select * from sessions
                {where}
                order by
                  pinned_at is null,
                  pinned_at desc,
                  updated_at desc,
                  created_at desc,
                  id desc
                limit ?
                """,
                params,
            ).fetchall()
        return [self._from_row(row) for row in rows]

    def update(
        self,
        session_id: str,
        *,
        title: str | None = None,
        status: str | None = None,
        active_session_id: str | None = None,
        workspace_id: str | None = None,
        session_type: str | None = None,
        cwd: str | None = None,
        workspace_roots: list[str] | None = None,
        current_model_provider_id: str | None = None,
        current_model: str | None = None,
        context_compression_epoch: int | None = None,
        title_source: str | None = None,
        parent_session_id: str | None = None,
        child_session_id: str | None = None,
        source_trace_id: str | None = None,
        source_active_session_id: str | None = None,
        source_checkpoint_id: str | None = None,
        source_checkpoint_ns: str | None = None,
    ) -> SessionRecord | None:
        assignments: list[str] = []
        params: list[Any] = []
        if title is not None:
            assignments.append("title = ?")
            params.append(title)
        if title_source is not None:
            self._validate_title_source(title_source)
            assignments.append("title_source = ?")
            params.append(title_source)
        if status is not None:
            self._validate_status(status)
            assignments.append("status = ?")
            params.append(status)
        if active_session_id is not None:
            assignments.append("active_session_id = ?")
            params.append(active_session_id)
        if workspace_id is not None:
            assignments.append("workspace_id = ?")
            params.append(workspace_id)
        if session_type is not None:
            self._validate_session_type(session_type)
            assignments.append("session_type = ?")
            params.append(session_type)
        if cwd is not None:
            assignments.append("cwd = ?")
            params.append(cwd)
        if workspace_roots is not None:
            assignments.append("workspace_roots_json = ?")
            params.append(_json_dumps(workspace_roots))
        if current_model_provider_id is not None:
            assignments.append("current_model_provider_id = ?")
            params.append(current_model_provider_id)
        if current_model is not None:
            assignments.append("current_model = ?")
            params.append(current_model)
        if context_compression_epoch is not None:
            assignments.append("context_compression_epoch = ?")
            params.append(int(context_compression_epoch))
        if parent_session_id is not None:
            assignments.append("parent_session_id = ?")
            params.append(parent_session_id)
        if child_session_id is not None:
            assignments.append("child_session_id = ?")
            params.append(child_session_id)
        if source_trace_id is not None:
            assignments.append("source_trace_id = ?")
            params.append(source_trace_id)
        if source_active_session_id is not None:
            assignments.append("source_active_session_id = ?")
            params.append(source_active_session_id)
        if source_checkpoint_id is not None:
            assignments.append("source_checkpoint_id = ?")
            params.append(source_checkpoint_id)
        if source_checkpoint_ns is not None:
            assignments.append("source_checkpoint_ns = ?")
            params.append(source_checkpoint_ns)
        if not assignments:
            return self.get(session_id)

        assignments.append("updated_at = ?")
        params.append(to_iso_z(utc_now()))
        params.append(session_id)
        with self.db.transaction() as conn:
            conn.execute(
                f"update sessions set {', '.join(assignments)} where id = ? and is_deleted = 0",
                params,
            )
        return self.get(session_id)

    def get_context_compression_epoch(self, session_id: str) -> int:
        with self.db.connect() as conn:
            row = conn.execute(
                """
                select context_compression_epoch
                from sessions
                where id = ? and is_deleted = 0
                """,
                (session_id,),
            ).fetchone()
        if row is None:
            return 0
        return int(row["context_compression_epoch"] or 0)

    def increment_context_compression_epoch(self, session_id: str) -> int:
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            cursor = conn.execute(
                """
                update sessions
                set context_compression_epoch = context_compression_epoch + 1,
                    updated_at = ?
                where id = ? and is_deleted = 0
                """,
                (now, session_id),
            )
            if cursor.rowcount == 0:
                return 0
            row = conn.execute(
                """
                select context_compression_epoch
                from sessions
                where id = ?
                """,
                (session_id,),
            ).fetchone()
        if row is None:
            return 0
        return int(row["context_compression_epoch"] or 0)

    def update_title_if_auto_allowed(
        self,
        session_id: str,
        *,
        title: str,
        only_when_default_title: bool,
    ) -> SessionRecord | None:
        cleaned = title.strip()
        if not cleaned:
            raise ValueError("title must not be empty")
        allowed_sources = (
            ("auto_candidate",) if only_when_default_title else ("auto_candidate", "auto")
        )
        placeholders = ", ".join("?" for _ in allowed_sources)
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            cursor = conn.execute(
                f"""
                update sessions
                set title = ?, title_source = 'auto', updated_at = ?
                where id = ?
                  and is_deleted = 0
                  and title_source in ({placeholders})
                """,
                [cleaned, now, session_id, *allowed_sources],
            )
        if cursor.rowcount == 0:
            return None
        return self.get(session_id)

    def touch(self, session_id: str) -> SessionRecord | None:
        assignments = ["updated_at = ?"]
        params: list[Any] = [to_iso_z(utc_now())]
        params.append(session_id)
        with self.db.transaction() as conn:
            conn.execute(
                f"update sessions set {', '.join(assignments)} where id = ? and is_deleted = 0",
                params,
            )
        return self.get(session_id)

    def update_context_window_usage(
        self,
        session_id: str,
        snapshot: dict[str, Any],
    ) -> SessionRecord | None:
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            cursor = conn.execute(
                """
                update sessions
                set context_window_usage_json = ?, updated_at = ?
                where id = ? and is_deleted = 0
                """,
                (_json_dumps(snapshot), now, session_id),
            )
        if cursor.rowcount == 0:
            return None
        return self.get(session_id)

    def set_pinned(self, session_id: str, pinned: bool) -> SessionRecord | None:
        pinned_at = to_iso_z(utc_now()) if pinned else None
        with self.db.transaction() as conn:
            cursor = conn.execute(
                """
                update sessions
                set pinned_at = ?
                where id = ? and is_deleted = 0
                """,
                (pinned_at, session_id),
            )
        if cursor.rowcount == 0:
            return None
        return self.get(session_id)

    def close(self, session_id: str) -> SessionRecord | None:
        return self.update(session_id, status="closed")

    def soft_delete(self, session_id: str) -> SessionRecord | None:
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            cursor = conn.execute(
                """
                update sessions
                set is_deleted = 1, updated_at = ?
                where id = ? and is_deleted = 0
                """,
                (now, session_id),
            )
        if cursor.rowcount == 0:
            return None
        return self.get(session_id, include_deleted=True)

    @classmethod
    def _validate_status(cls, status: str) -> None:
        if status not in cls.VALID_STATUSES:
            raise ValueError(f"不支持的 session 状态: {status}")

    @classmethod
    def _validate_session_type(cls, session_type: str) -> None:
        if session_type not in cls.VALID_SESSION_TYPES:
            raise ValueError(f"不支持的 session 类型: {session_type}")

    @classmethod
    def _validate_title_source(cls, title_source: str) -> None:
        if title_source not in cls.VALID_TITLE_SOURCES:
            raise ValueError(f"不支持的 title 来源: {title_source}")

    @staticmethod
    def _from_row(row: sqlite3.Row) -> SessionRecord:
        return SessionRecord(
            id=row["id"],
            user_id=row["user_id"],
            scene_id=row["scene_id"],
            scene_version_seq=row["scene_version_seq"],
            status=row["status"],
            is_debug=bool(row["is_debug"]),
            debug_type=row["debug_type"],
            is_scheduled=bool(row["is_scheduled"]),
            scheduled_task_id=row["scheduled_task_id"],
            session_tag=row["session_tag"],
            active_session_id=row["active_session_id"],
            parent_session_id=row["parent_session_id"],
            child_session_id=row["child_session_id"],
            source_trace_id=row["source_trace_id"],
            source_active_session_id=row["source_active_session_id"],
            source_checkpoint_id=row["source_checkpoint_id"],
            source_checkpoint_ns=row["source_checkpoint_ns"],
            workspace_id=row["workspace_id"],
            session_type=row["session_type"],
            cwd=row["cwd"],
            workspace_roots=_json_loads(row["workspace_roots_json"], []),
            current_model_provider_id=row["current_model_provider_id"],
            current_model=row["current_model"],
            context_window_usage=_json_loads(row["context_window_usage_json"], None),
            context_compression_epoch=int(row["context_compression_epoch"] or 0),
            pinned_at=row["pinned_at"],
            title=row["title"],
            title_source=row["title_source"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            is_deleted=bool(row["is_deleted"]),
        )


class SessionForksRepository:
    VALID_RELATION_TYPES = {"fork"}

    def __init__(self, db: Database) -> None:
        self.db = db

    def create(
        self,
        *,
        fork_id: str,
        source_session_id: str,
        target_session_id: str,
        source_message_event_id: str,
        target_message_event_id: str,
        source_turn_index: int,
        target_turn_index: int,
        source_trace_id: str | None = None,
        source_active_session_id: str | None = None,
        source_checkpoint_id: str | None = None,
        source_checkpoint_ns: str | None = None,
        relation_type: str = "fork",
    ) -> SessionForkRecord:
        self._validate_relation_type(relation_type)
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            conn.execute(
                """
                insert into session_forks (
                  id, source_session_id, target_session_id, source_message_event_id,
                  target_message_event_id, source_turn_index, target_turn_index,
                  source_trace_id, source_active_session_id,
                  source_checkpoint_id, source_checkpoint_ns, relation_type,
                  created_at, updated_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    fork_id,
                    source_session_id,
                    target_session_id,
                    source_message_event_id,
                    target_message_event_id,
                    int(source_turn_index),
                    int(target_turn_index),
                    source_trace_id,
                    source_active_session_id,
                    source_checkpoint_id,
                    source_checkpoint_ns or "",
                    relation_type,
                    now,
                    now,
                ),
            )
        record = self.get(fork_id)
        if record is None:
            raise RuntimeError(f"创建 session fork 后无法读取: {fork_id}")
        return record

    def get(self, fork_id: str, *, include_deleted: bool = False) -> SessionForkRecord | None:
        query = "select * from session_forks where id = ?"
        params: list[Any] = [fork_id]
        if not include_deleted:
            query += " and is_deleted = 0"
        with self.db.connect() as conn:
            row = conn.execute(query, params).fetchone()
        return self._from_row(row) if row else None

    def get_by_target(
        self,
        target_session_id: str,
        *,
        relation_type: str = "fork",
        include_deleted: bool = False,
    ) -> SessionForkRecord | None:
        self._validate_relation_type(relation_type)
        query = "select * from session_forks where target_session_id = ? and relation_type = ?"
        params: list[Any] = [target_session_id, relation_type]
        if not include_deleted:
            query += " and is_deleted = 0"
        query += " order by created_at desc, id desc limit 1"
        with self.db.connect() as conn:
            row = conn.execute(query, params).fetchone()
        return self._from_row(row) if row else None

    def list_by_source(
        self,
        source_session_id: str,
        *,
        relation_type: str = "fork",
        include_deleted: bool = False,
    ) -> list[SessionForkRecord]:
        self._validate_relation_type(relation_type)
        query = "select * from session_forks where source_session_id = ? and relation_type = ?"
        params: list[Any] = [source_session_id, relation_type]
        if not include_deleted:
            query += " and is_deleted = 0"
        query += " order by source_turn_index asc, created_at asc, id asc"
        with self.db.connect() as conn:
            rows = conn.execute(query, params).fetchall()
        return [self._from_row(row) for row in rows]

    def soft_delete_by_target(self, target_session_id: str) -> int:
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            cursor = conn.execute(
                """
                update session_forks
                set is_deleted = 1, updated_at = ?
                where target_session_id = ? and is_deleted = 0
                """,
                (now, target_session_id),
            )
        return int(cursor.rowcount)

    @classmethod
    def _validate_relation_type(cls, relation_type: str) -> None:
        if relation_type not in cls.VALID_RELATION_TYPES:
            raise ValueError(f"不支持的 session fork 关系类型: {relation_type}")

    @staticmethod
    def _from_row(row: sqlite3.Row) -> SessionForkRecord:
        return SessionForkRecord(
            id=row["id"],
            source_session_id=row["source_session_id"],
            target_session_id=row["target_session_id"],
            source_message_event_id=row["source_message_event_id"],
            target_message_event_id=row["target_message_event_id"],
            source_turn_index=int(row["source_turn_index"]),
            target_turn_index=int(row["target_turn_index"]),
            source_trace_id=row["source_trace_id"],
            source_active_session_id=row["source_active_session_id"],
            source_checkpoint_id=row["source_checkpoint_id"],
            source_checkpoint_ns=row["source_checkpoint_ns"] or "",
            relation_type=row["relation_type"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            is_deleted=bool(row["is_deleted"]),
        )


class AttachmentsRepository:
    VALID_TYPES = {"image", "document", "file"}

    def __init__(self, db: Database) -> None:
        self.db = db

    def create(
        self,
        *,
        attachment_id: str | None = None,
        session_id: str | None = None,
        user_id: str,
        type: str,
        source: str,
        name: str,
        path: str,
        mime_type: str,
        size: int,
    ) -> AttachmentRecord:
        cleaned_type = type.strip() or "file"
        if cleaned_type not in self.VALID_TYPES:
            raise ValueError(f"unsupported attachment type: {cleaned_type}")
        if not user_id.strip():
            raise ValueError("attachment user_id must not be empty")
        if not name.strip():
            raise ValueError("attachment name must not be empty")
        if not path.strip():
            raise ValueError("attachment path must not be empty")
        now = to_iso_z(utc_now())
        record_id = attachment_id or new_id()
        with self.db.transaction() as conn:
            conn.execute(
                """
                insert into attachments (
                  id, session_id, user_id, type, source, name, path, mime_type,
                  size, created_at, updated_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record_id,
                    session_id,
                    user_id,
                    cleaned_type,
                    source.strip() or "unknown",
                    name.strip(),
                    path,
                    mime_type.strip() or "application/octet-stream",
                    max(0, int(size)),
                    now,
                    now,
                ),
            )
        record = self.get(record_id)
        if record is None:
            raise RuntimeError(f"创建 attachment 后无法读取: {record_id}")
        return record

    def get(self, attachment_id: str, *, include_deleted: bool = False) -> AttachmentRecord | None:
        query = "select * from attachments where id = ?"
        params: list[Any] = [attachment_id]
        if not include_deleted:
            query += " and is_deleted = 0"
        with self.db.connect() as conn:
            row = conn.execute(query, params).fetchone()
        return self._from_row(row) if row else None

    def list_by_ids(
        self,
        attachment_ids: list[str],
        *,
        include_deleted: bool = False,
    ) -> list[AttachmentRecord]:
        ordered_ids = [item for item in dict.fromkeys(attachment_ids) if item]
        if not ordered_ids:
            return []
        placeholders = ",".join("?" for _ in ordered_ids)
        query = f"select * from attachments where id in ({placeholders})"
        params: list[Any] = list(ordered_ids)
        if not include_deleted:
            query += " and is_deleted = 0"
        with self.db.connect() as conn:
            rows = conn.execute(query, params).fetchall()
        records = {row["id"]: self._from_row(row) for row in rows}
        return [records[item] for item in ordered_ids if item in records]

    def claim_for_session(
        self,
        attachment_ids: list[str],
        *,
        session_id: str,
        user_id: str,
    ) -> None:
        ordered_ids = [item for item in dict.fromkeys(attachment_ids) if item]
        if not ordered_ids:
            return
        now = to_iso_z(utc_now())
        placeholders = ",".join("?" for _ in ordered_ids)
        with self.db.transaction() as conn:
            conn.execute(
                f"""
                update attachments
                set session_id = ?, updated_at = ?
                where id in ({placeholders})
                  and user_id = ?
                  and is_deleted = 0
                  and (session_id is null or session_id = ?)
                """,
                [session_id, now, *ordered_ids, user_id, session_id],
            )

    def soft_delete(self, attachment_id: str) -> bool:
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            cursor = conn.execute(
                """
                update attachments
                set is_deleted = 1, updated_at = ?
                where id = ? and is_deleted = 0
                """,
                (now, attachment_id),
            )
        return cursor.rowcount > 0

    @staticmethod
    def _from_row(row: sqlite3.Row) -> AttachmentRecord:
        return AttachmentRecord(
            id=row["id"],
            session_id=row["session_id"],
            user_id=row["user_id"],
            type=row["type"],
            source=row["source"],
            name=row["name"],
            path=row["path"],
            mime_type=row["mime_type"],
            size=int(row["size"] or 0),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            is_deleted=bool(row["is_deleted"]),
        )


class WorkspaceFileAnnotationsRepository:
    VALID_SCOPE_TYPES = {"session", "workspace"}
    VALID_ANCHOR_TYPES = {"file", "selection"}

    def __init__(self, db: Database) -> None:
        self.db = db

    def create(
        self,
        *,
        scope_type: str,
        scope_id: str,
        workspace_id: str | None,
        path: str,
        anchor_type: str,
        comment: str,
        selected_text: str | None = None,
        line_start: int | None = None,
        line_end: int | None = None,
        column_start: int | None = None,
        column_end: int | None = None,
        content_hash: str | None = None,
        anchor_json: dict[str, Any] | None = None,
        annotation_id: str | None = None,
    ) -> WorkspaceFileAnnotationRecord:
        values = self._validate_values(
            scope_type=scope_type,
            scope_id=scope_id,
            path=path,
            anchor_type=anchor_type,
            comment=comment,
            selected_text=selected_text,
            line_start=line_start,
            line_end=line_end,
            column_start=column_start,
            column_end=column_end,
            content_hash=content_hash,
            anchor_json=anchor_json,
        )
        resolved_id = annotation_id or new_id()
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            conn.execute(
                """
                insert into workspace_file_annotations (
                  id, scope_type, scope_id, workspace_id, path, anchor_type, comment,
                  selected_text, line_start, line_end, column_start, column_end,
                  content_hash, anchor_json, created_at, updated_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    resolved_id,
                    values["scope_type"],
                    values["scope_id"],
                    workspace_id,
                    values["path"],
                    values["anchor_type"],
                    values["comment"],
                    values["selected_text"],
                    values["line_start"],
                    values["line_end"],
                    values["column_start"],
                    values["column_end"],
                    values["content_hash"],
                    (
                        _json_dumps(values["anchor_json"])
                        if values["anchor_json"] is not None
                        else None
                    ),
                    now,
                    now,
                ),
            )
        record = self.get(
            resolved_id,
            scope_type=values["scope_type"],
            scope_id=values["scope_id"],
        )
        if record is None:
            raise RuntimeError(f"Created annotation cannot be loaded: {resolved_id}")
        return record

    def get(
        self,
        annotation_id: str,
        *,
        scope_type: str,
        scope_id: str,
        include_deleted: bool = False,
    ) -> WorkspaceFileAnnotationRecord | None:
        self._validate_scope(scope_type, scope_id)
        query = """
            select * from workspace_file_annotations
            where id = ? and scope_type = ? and scope_id = ?
        """
        params: list[Any] = [annotation_id, scope_type, scope_id]
        if not include_deleted:
            query += " and is_deleted = 0"
        with self.db.connect() as conn:
            row = conn.execute(query, params).fetchone()
        return self._from_row(row) if row else None

    def list(
        self,
        *,
        scope_type: str,
        scope_id: str,
        path: str,
    ) -> list[WorkspaceFileAnnotationRecord]:
        scope_type, scope_id = self._validate_scope(scope_type, scope_id)
        normalized_path = self._normalize_path(path)
        with self.db.connect() as conn:
            rows = conn.execute(
                """
                select * from workspace_file_annotations
                where scope_type = ?
                  and scope_id = ?
                  and path = ?
                  and is_deleted = 0
                order by updated_at desc, created_at desc, id desc
                """,
                (scope_type, scope_id, normalized_path),
            ).fetchall()
        return [self._from_row(row) for row in rows]

    def update(
        self,
        annotation_id: str,
        *,
        scope_type: str,
        scope_id: str,
        anchor_type: str,
        comment: str,
        selected_text: str | None = None,
        line_start: int | None = None,
        line_end: int | None = None,
        column_start: int | None = None,
        column_end: int | None = None,
        content_hash: str | None = None,
        anchor_json: dict[str, Any] | None = None,
    ) -> WorkspaceFileAnnotationRecord | None:
        values = self._validate_values(
            scope_type=scope_type,
            scope_id=scope_id,
            path="placeholder.txt",
            anchor_type=anchor_type,
            comment=comment,
            selected_text=selected_text,
            line_start=line_start,
            line_end=line_end,
            column_start=column_start,
            column_end=column_end,
            content_hash=content_hash,
            anchor_json=anchor_json,
        )
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            cursor = conn.execute(
                """
                update workspace_file_annotations
                set
                  anchor_type = ?,
                  comment = ?,
                  selected_text = ?,
                  line_start = ?,
                  line_end = ?,
                  column_start = ?,
                  column_end = ?,
                  content_hash = ?,
                  anchor_json = ?,
                  updated_at = ?
                where id = ?
                  and scope_type = ?
                  and scope_id = ?
                  and is_deleted = 0
                """,
                (
                    values["anchor_type"],
                    values["comment"],
                    values["selected_text"],
                    values["line_start"],
                    values["line_end"],
                    values["column_start"],
                    values["column_end"],
                    values["content_hash"],
                    (
                        _json_dumps(values["anchor_json"])
                        if values["anchor_json"] is not None
                        else None
                    ),
                    now,
                    annotation_id,
                    values["scope_type"],
                    values["scope_id"],
                ),
            )
        if cursor.rowcount == 0:
            return None
        return self.get(
            annotation_id,
            scope_type=values["scope_type"],
            scope_id=values["scope_id"],
        )

    def delete(
        self,
        annotation_id: str,
        *,
        scope_type: str,
        scope_id: str,
    ) -> bool:
        scope_type, scope_id = self._validate_scope(scope_type, scope_id)
        with self.db.transaction() as conn:
            cursor = conn.execute(
                """
                update workspace_file_annotations
                set is_deleted = 1, updated_at = ?
                where id = ?
                  and scope_type = ?
                  and scope_id = ?
                  and is_deleted = 0
                """,
                (to_iso_z(utc_now()), annotation_id, scope_type, scope_id),
            )
        return cursor.rowcount > 0

    @classmethod
    def _validate_values(
        cls,
        *,
        scope_type: str,
        scope_id: str,
        path: str,
        anchor_type: str,
        comment: str,
        selected_text: str | None,
        line_start: int | None,
        line_end: int | None,
        column_start: int | None,
        column_end: int | None,
        content_hash: str | None,
        anchor_json: dict[str, Any] | None,
    ) -> dict[str, Any]:
        normalized_scope_type, normalized_scope_id = cls._validate_scope(scope_type, scope_id)
        normalized_path = cls._normalize_path(path)
        normalized_anchor_type = str(anchor_type or "").strip()
        if normalized_anchor_type not in cls.VALID_ANCHOR_TYPES:
            raise ValueError(f"Unsupported annotation anchor_type: {anchor_type}")

        normalized_comment = str(comment or "").strip()
        if not normalized_comment:
            raise ValueError("Annotation comment cannot be empty")

        resolved_selected_text = selected_text if selected_text is None else str(selected_text)
        if normalized_anchor_type == "selection" and not (resolved_selected_text or "").strip():
            raise ValueError("Selection annotation requires selected_text")
        if normalized_anchor_type == "file":
            resolved_selected_text = None
            line_start = None
            line_end = None
            column_start = None
            column_end = None
            anchor_json = None

        normalized_anchor_json = cls._validate_anchor_json(anchor_json)
        if normalized_anchor_json is not None:
            if normalized_anchor_type != "selection":
                raise ValueError("Only selection annotations can include anchor_json")
            anchor_selected_text = normalized_anchor_json["selectedText"]
            if resolved_selected_text and resolved_selected_text != anchor_selected_text:
                raise ValueError("Annotation selected_text must match anchor_json.selectedText")
            resolved_selected_text = anchor_selected_text
            line_start = cls._same_or_default(
                line_start,
                normalized_anchor_json["lineStart"],
                "line_start",
            )
            line_end = cls._same_or_default(line_end, normalized_anchor_json["lineEnd"], "line_end")
            column_start = cls._same_or_default(
                column_start,
                normalized_anchor_json["columnStart"],
                "column_start",
            )
            column_end = cls._same_or_default(
                column_end,
                normalized_anchor_json["columnEnd"],
                "column_end",
            )
            anchor_content_hash = normalized_anchor_json["contentHash"]
            if content_hash and str(content_hash).strip() != anchor_content_hash:
                raise ValueError("Annotation content_hash must match anchor_json.contentHash")
            content_hash = anchor_content_hash

        if normalized_anchor_type == "selection" and not (resolved_selected_text or "").strip():
            raise ValueError("Selection annotation requires selected_text")

        cls._validate_range(
            line_start=line_start,
            line_end=line_end,
            column_start=column_start,
            column_end=column_end,
        )

        return {
            "scope_type": normalized_scope_type,
            "scope_id": normalized_scope_id,
            "path": normalized_path,
            "anchor_type": normalized_anchor_type,
            "comment": normalized_comment,
            "selected_text": resolved_selected_text,
            "line_start": line_start,
            "line_end": line_end,
            "column_start": column_start,
            "column_end": column_end,
            "content_hash": str(content_hash).strip() if content_hash else None,
            "anchor_json": normalized_anchor_json,
        }

    @classmethod
    def _validate_scope(cls, scope_type: str, scope_id: str) -> tuple[str, str]:
        normalized_scope_type = str(scope_type or "").strip()
        normalized_scope_id = str(scope_id or "").strip()
        if normalized_scope_type not in cls.VALID_SCOPE_TYPES:
            raise ValueError(f"Unsupported annotation scope_type: {scope_type}")
        if not normalized_scope_id:
            raise ValueError("Annotation scope_id cannot be empty")
        return normalized_scope_type, normalized_scope_id

    @staticmethod
    def _normalize_path(path: str) -> str:
        normalized = str(path or "").replace("\\", "/").strip().strip("/")
        if not normalized or normalized == ".":
            raise ValueError("Annotation path cannot be empty")
        if Path(normalized).is_absolute():
            raise ValueError("Annotation path must be workspace-relative")
        segments = [segment for segment in normalized.split("/") if segment]
        if any(segment == ".." for segment in segments):
            raise ValueError("Annotation path must stay inside the workspace")
        return "/".join(segments)

    @staticmethod
    def _validate_range(
        *,
        line_start: int | None,
        line_end: int | None,
        column_start: int | None,
        column_end: int | None,
    ) -> None:
        if (line_start is None) != (line_end is None):
            raise ValueError("Annotation line range must include start and end")
        if line_start is not None and line_end is not None:
            if line_start < 1 or line_end < 1 or line_end < line_start:
                raise ValueError("Annotation line range is invalid")
        if (column_start is None) != (column_end is None):
            raise ValueError("Annotation column range must include start and end")
        if column_start is not None and column_end is not None:
            if line_start is None or line_end is None:
                raise ValueError("Annotation column range requires a line range")
            if column_start < 1 or column_end < 1:
                raise ValueError("Annotation column range is invalid")
            if line_start == line_end and column_end < column_start:
                raise ValueError("Annotation column range is invalid")

    @classmethod
    def _validate_anchor_json(cls, value: dict[str, Any] | None) -> dict[str, Any] | None:
        if value is None:
            return None
        if not isinstance(value, dict):
            raise ValueError("Annotation anchor_json must be an object")

        required = {
            "version",
            "kind",
            "sourceStart",
            "sourceEnd",
            "selectedText",
            "sourceText",
            "contentHash",
            "lineStart",
            "lineEnd",
            "columnStart",
            "columnEnd",
            "createdInView",
        }
        missing = sorted(required - set(value))
        if missing:
            raise ValueError(f"Annotation anchor_json missing fields: {', '.join(missing)}")
        if value["version"] != 2 or value["kind"] != "source-range":
            raise ValueError("Annotation anchor_json version or kind is unsupported")
        if value["createdInView"] not in {"preview", "source"}:
            raise ValueError("Annotation anchor_json.createdInView is invalid")

        source_start = cls._positive_or_zero_int(value["sourceStart"], "sourceStart")
        source_end = cls._positive_or_zero_int(value["sourceEnd"], "sourceEnd")
        if source_end <= source_start:
            raise ValueError("Annotation anchor_json source range is invalid")

        line_start = cls._positive_int(value["lineStart"], "lineStart")
        line_end = cls._positive_int(value["lineEnd"], "lineEnd")
        column_start = cls._positive_int(value["columnStart"], "columnStart")
        column_end = cls._positive_int(value["columnEnd"], "columnEnd")
        cls._validate_range(
            line_start=line_start,
            line_end=line_end,
            column_start=column_start,
            column_end=column_end,
        )

        selected_text = str(value["selectedText"])
        source_text = str(value["sourceText"])
        content_hash = str(value["contentHash"]).strip()
        if not selected_text.strip():
            raise ValueError("Annotation anchor_json.selectedText cannot be empty")
        if not source_text:
            raise ValueError("Annotation anchor_json.sourceText cannot be empty")
        if len(source_text) != source_end - source_start:
            raise ValueError("Annotation anchor_json.sourceText length must match source range")
        if not content_hash:
            raise ValueError("Annotation anchor_json.contentHash cannot be empty")

        return {
            "version": 2,
            "kind": "source-range",
            "sourceStart": source_start,
            "sourceEnd": source_end,
            "selectedText": selected_text,
            "sourceText": source_text,
            "contentHash": content_hash,
            "lineStart": line_start,
            "lineEnd": line_end,
            "columnStart": column_start,
            "columnEnd": column_end,
            "createdInView": value["createdInView"],
        }

    @staticmethod
    def _positive_or_zero_int(value: Any, field_name: str) -> int:
        if type(value) is not int or value < 0:
            raise ValueError(f"Annotation anchor_json.{field_name} must be a non-negative integer")
        return value

    @staticmethod
    def _positive_int(value: Any, field_name: str) -> int:
        if type(value) is not int or value < 1:
            raise ValueError(f"Annotation anchor_json.{field_name} must be a positive integer")
        return value

    @staticmethod
    def _same_or_default(value: int | None, expected: int, field_name: str) -> int:
        if value is not None and value != expected:
            raise ValueError(f"Annotation {field_name} must match anchor_json")
        return expected

    @staticmethod
    def _from_row(row: sqlite3.Row) -> WorkspaceFileAnnotationRecord:
        return WorkspaceFileAnnotationRecord(
            id=row["id"],
            scope_type=row["scope_type"],
            scope_id=row["scope_id"],
            workspace_id=row["workspace_id"],
            path=row["path"],
            anchor_type=row["anchor_type"],
            comment=row["comment"],
            selected_text=row["selected_text"],
            line_start=row["line_start"],
            line_end=row["line_end"],
            column_start=row["column_start"],
            column_end=row["column_end"],
            content_hash=row["content_hash"],
            anchor_json=_json_loads(row["anchor_json"], None),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            is_deleted=bool(row["is_deleted"]),
        )


class MessageEventsRepository:
    def __init__(self, db: Database) -> None:
        self.db = db

    def append(
        self,
        *,
        event_id: str,
        session_id: str,
        turn_index: int,
        action: str,
        data: dict[str, Any] | None = None,
        trace_record_id: str | None = None,
    ) -> MessageEventRecord:
        now = to_iso_z(utc_now())
        with self.db.transaction(immediate=True) as conn:
            row = conn.execute(
                """
                select coalesce(max(seq), 0) as max_seq
                from message_events
                where session_id = ? and is_deleted = 0
                """,
                (session_id,),
            ).fetchone()
            seq = int(row["max_seq"]) + 1
            conn.execute(
                """
                insert into message_events (
                  id, session_id, trace_record_id, seq, turn_index, action,
                  data_json, created_at, updated_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    event_id,
                    session_id,
                    trace_record_id,
                    seq,
                    turn_index,
                    action,
                    _json_dumps(data or {}),
                    now,
                    now,
                ),
            )
        record = self.get(event_id)
        if record is None:
            raise RuntimeError(f"追加 message event 后无法读取: {event_id}")
        return record

    def get(self, event_id: str, *, include_deleted: bool = False) -> MessageEventRecord | None:
        query = "select * from message_events where id = ?"
        params: list[Any] = [event_id]
        if not include_deleted:
            query += " and is_deleted = 0"
        with self.db.connect() as conn:
            row = conn.execute(query, params).fetchone()
        return self._from_row(row) if row else None

    def list_by_session(
        self,
        session_id: str,
        *,
        include_deleted: bool = False,
        limit: int = 1000,
    ) -> list[MessageEventRecord]:
        query = "select * from message_events where session_id = ?"
        params: list[Any] = [session_id]
        if not include_deleted:
            query += " and is_deleted = 0"
        query += " order by seq asc limit ?"
        params.append(max(1, min(limit, 5000)))
        with self.db.connect() as conn:
            rows = conn.execute(query, params).fetchall()
        return [self._from_row(row) for row in rows]

    def count_by_session(self, session_id: str, *, include_deleted: bool = False) -> int:
        query = "select count(*) as count from message_events where session_id = ?"
        params: list[Any] = [session_id]
        if not include_deleted:
            query += " and is_deleted = 0"
        with self.db.connect() as conn:
            row = conn.execute(query, params).fetchone()
        return int(row["count"] if row else 0)

    def count_turns(self, session_id: str, *, include_deleted: bool = False) -> int:
        query = (
            "select count(distinct turn_index) as count from message_events where session_id = ?"
        )
        params: list[Any] = [session_id]
        if not include_deleted:
            query += " and is_deleted = 0"
        with self.db.connect() as conn:
            row = conn.execute(query, params).fetchone()
        return int(row["count"] if row else 0)

    def soft_delete_from_turn(self, session_id: str, turn_index: int) -> int:
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            cursor = conn.execute(
                """
                update message_events
                set is_deleted = 1, updated_at = ?
                where session_id = ?
                  and turn_index >= ?
                  and is_deleted = 0
                """,
                (now, session_id, int(turn_index)),
            )
        return int(cursor.rowcount)

    def delete_from_turn(self, session_id: str, turn_index: int) -> int:
        with self.db.transaction() as conn:
            cursor = conn.execute(
                """
                delete from message_events
                where session_id = ?
                  and turn_index >= ?
                """,
                (session_id, int(turn_index)),
            )
        return int(cursor.rowcount)

    def list_turn_indexes(
        self,
        session_id: str,
        *,
        cursor_turn_index: int | None = None,
        direction: str = "older",
        limit: int | None = 5,
        offset: int = 0,
        include_deleted: bool = False,
    ) -> list[int]:
        query = "select turn_index from message_events where session_id = ?"
        params: list[Any] = [session_id]
        if not include_deleted:
            query += " and is_deleted = 0"
        if cursor_turn_index is not None:
            if direction == "newer":
                query += " and turn_index > ?"
            else:
                query += " and turn_index < ?"
            params.append(cursor_turn_index)
        order = "asc" if direction == "newer" else "desc"
        query += f" group by turn_index order by turn_index {order}"
        if limit is not None:
            query += " limit ? offset ?"
            params.extend([max(1, min(limit, 101)), max(0, offset)])
        with self.db.connect() as conn:
            rows = conn.execute(query, params).fetchall()
        return [int(row["turn_index"]) for row in rows]

    def list_by_turn(
        self,
        session_id: str,
        turn_index: int,
        *,
        include_deleted: bool = False,
    ) -> list[MessageEventRecord]:
        query = "select * from message_events where session_id = ? and turn_index = ?"
        params: list[Any] = [session_id, turn_index]
        if not include_deleted:
            query += " and is_deleted = 0"
        query += " order by seq asc"
        with self.db.connect() as conn:
            rows = conn.execute(query, params).fetchall()
        return [self._from_row(row) for row in rows]

    def get_max_seq_and_turn(self, session_id: str) -> tuple[int, int]:
        with self.db.connect() as conn:
            row = conn.execute(
                """
                select
                  coalesce(max(seq), 0) as max_seq,
                  coalesce(max(turn_index), 0) as max_turn
                from message_events
                where session_id = ? and is_deleted = 0
                """,
                (session_id,),
            ).fetchone()
        return int(row["max_seq"]), int(row["max_turn"])

    @staticmethod
    def _from_row(row: sqlite3.Row) -> MessageEventRecord:
        return MessageEventRecord(
            id=row["id"],
            session_id=row["session_id"],
            trace_record_id=row["trace_record_id"],
            seq=int(row["seq"]),
            turn_index=int(row["turn_index"]),
            action=row["action"],
            data=_json_loads(row["data_json"], {}),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            is_deleted=bool(row["is_deleted"]),
        )


class ThreadTasksRepository:
    def __init__(self, db: Database) -> None:
        self.db = db

    def create(
        self,
        *,
        session_id: str,
        type: str,
        objective: str,
        task_id: str | None = None,
        title: str | None = None,
        status: str = THREAD_TASK_STATUS_ACTIVE,
        metadata: dict[str, Any] | None = None,
        evidence: list[Any] | None = None,
        blocked_audit: dict[str, Any] | None = None,
        system_stop_reason: str | None = None,
        current_run_id: str | None = None,
        turn_count: int = 0,
        elapsed_seconds: int = 0,
        token_usage: dict[str, Any] | None = None,
    ) -> ThreadTaskRecord:
        self._validate_type(type)
        self._validate_status(status)
        resolved_task_id = task_id or new_id()
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            conn.execute(
                """
                insert into thread_tasks (
                  id, session_id, type, title, objective, status,
                  metadata_json, evidence_json, blocked_audit_json,
                  system_stop_reason, current_run_id, turn_count,
                  elapsed_seconds, token_usage_json, created_at, updated_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    resolved_task_id,
                    session_id,
                    type,
                    title,
                    objective,
                    status,
                    _json_dumps(metadata or {}),
                    _json_dumps(evidence or []),
                    _json_dumps(blocked_audit or {}),
                    system_stop_reason,
                    current_run_id,
                    int(turn_count),
                    int(elapsed_seconds),
                    _json_dumps(token_usage or {}),
                    now,
                    now,
                ),
            )
        record = self.get(resolved_task_id)
        if record is None:
            raise RuntimeError(f"创建 thread task 后无法读取: {resolved_task_id}")
        return record

    def get(self, task_id: str, *, include_deleted: bool = False) -> ThreadTaskRecord | None:
        query = "select * from thread_tasks where id = ?"
        params: list[Any] = [task_id]
        if not include_deleted:
            query += " and deleted_at is null"
        with self.db.connect() as conn:
            row = conn.execute(query, params).fetchone()
        return ThreadTaskRecord.from_row(row) if row else None

    def list_by_session(
        self,
        session_id: str,
        *,
        include_deleted: bool = False,
        limit: int = 100,
    ) -> list[ThreadTaskRecord]:
        query = "select * from thread_tasks where session_id = ?"
        params: list[Any] = [session_id]
        if not include_deleted:
            query += " and deleted_at is null"
        query += " order by updated_at desc, created_at desc, id desc limit ?"
        params.append(max(1, min(limit, 500)))
        with self.db.connect() as conn:
            rows = conn.execute(query, params).fetchall()
        return [ThreadTaskRecord.from_row(row) for row in rows]

    def get_open_by_session(self, session_id: str) -> ThreadTaskRecord | None:
        placeholders = ", ".join("?" for _ in THREAD_TASK_OPEN_STATUSES)
        params: list[Any] = [session_id, *sorted(THREAD_TASK_OPEN_STATUSES)]
        with self.db.connect() as conn:
            row = conn.execute(
                f"""
                select * from thread_tasks
                where session_id = ?
                  and deleted_at is null
                  and status in ({placeholders})
                order by updated_at desc, created_at desc, id desc
                limit 1
                """,
                params,
            ).fetchone()
        return ThreadTaskRecord.from_row(row) if row else None

    def list_by_status(
        self,
        status: str,
        *,
        include_deleted: bool = False,
        limit: int = 500,
    ) -> list[ThreadTaskRecord]:
        self._validate_status(status)
        query = "select * from thread_tasks where status = ?"
        params: list[Any] = [status]
        if not include_deleted:
            query += " and deleted_at is null"
        query += " order by updated_at desc, created_at desc, id desc limit ?"
        params.append(max(1, min(limit, 1000)))
        with self.db.connect() as conn:
            rows = conn.execute(query, params).fetchall()
        return [ThreadTaskRecord.from_row(row) for row in rows]

    def update(
        self,
        task_id: str,
        *,
        title: str | None | object = _UNSET,
        objective: str | None = None,
        status: str | None = None,
        metadata: dict[str, Any] | None = None,
        evidence: list[Any] | None = None,
        blocked_audit: dict[str, Any] | None = None,
        system_stop_reason: str | None | object = _UNSET,
        current_run_id: str | None | object = _UNSET,
        turn_count: int | None = None,
        elapsed_seconds: int | None = None,
        token_usage: dict[str, Any] | None = None,
        deleted_at: str | None | object = _UNSET,
    ) -> ThreadTaskRecord | None:
        assignments: list[str] = []
        params: list[Any] = []
        if title is not _UNSET:
            assignments.append("title = ?")
            params.append(title)
        if objective is not None:
            assignments.append("objective = ?")
            params.append(objective)
        if status is not None:
            self._validate_status(status)
            assignments.append("status = ?")
            params.append(status)
        if metadata is not None:
            assignments.append("metadata_json = ?")
            params.append(_json_dumps(metadata))
        if evidence is not None:
            assignments.append("evidence_json = ?")
            params.append(_json_dumps(evidence))
        if blocked_audit is not None:
            assignments.append("blocked_audit_json = ?")
            params.append(_json_dumps(blocked_audit))
        if system_stop_reason is not _UNSET:
            assignments.append("system_stop_reason = ?")
            params.append(system_stop_reason)
        if current_run_id is not _UNSET:
            assignments.append("current_run_id = ?")
            params.append(current_run_id)
        if turn_count is not None:
            assignments.append("turn_count = ?")
            params.append(int(turn_count))
        if elapsed_seconds is not None:
            assignments.append("elapsed_seconds = ?")
            params.append(int(elapsed_seconds))
        if token_usage is not None:
            assignments.append("token_usage_json = ?")
            params.append(_json_dumps(token_usage))
        if deleted_at is not _UNSET:
            assignments.append("deleted_at = ?")
            params.append(deleted_at)
        if not assignments:
            return self.get(task_id)

        assignments.append("updated_at = ?")
        params.append(to_iso_z(utc_now()))
        params.append(task_id)
        with self.db.transaction() as conn:
            cursor = conn.execute(
                f"""
                update thread_tasks
                set {', '.join(assignments)}
                where id = ?
                """,
                params,
            )
        if cursor.rowcount == 0:
            return None
        return self.get(task_id, include_deleted=True)

    def soft_delete(self, task_id: str) -> ThreadTaskRecord | None:
        deleted_at = to_iso_z(utc_now())
        return self.update(task_id, deleted_at=deleted_at)

    @classmethod
    def _validate_type(cls, type: str) -> None:
        if (
            not type
            or len(type) > THREAD_TASK_TYPE_MAX_CHARS
            or THREAD_TASK_TYPE_PATTERN.fullmatch(type) is None
        ):
            raise ValueError(f"不支持的 thread task 类型: {type}")

    @classmethod
    def _validate_status(cls, status: str) -> None:
        if status not in THREAD_TASK_STATUSES:
            raise ValueError(f"不支持的 thread task 状态: {status}")


class ThreadTaskRunsRepository:
    def __init__(self, db: Database) -> None:
        self.db = db

    def create_running(
        self,
        *,
        task_id: str,
        session_id: str,
        run_id: str | None = None,
        turn_index: int | None = None,
        trace_id: str | None = None,
        summary: dict[str, Any] | None = None,
        error: dict[str, Any] | None = None,
    ) -> ThreadTaskRunRecord:
        resolved_run_id = run_id or new_id()
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            conn.execute(
                """
                insert into thread_task_runs (
                  id, task_id, session_id, turn_index, trace_id, status,
                  summary_json, error_json, started_at, created_at, updated_at
                ) values (?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)
                """,
                (
                    resolved_run_id,
                    task_id,
                    session_id,
                    turn_index,
                    trace_id,
                    _json_dumps(summary or {}),
                    _json_dumps(error or {}),
                    now,
                    now,
                    now,
                ),
            )
        record = self.get(resolved_run_id)
        if record is None:
            raise RuntimeError(f"创建 thread task run 后无法读取: {resolved_run_id}")
        return record

    def get(self, run_id: str) -> ThreadTaskRunRecord | None:
        with self.db.connect() as conn:
            row = conn.execute(
                "select * from thread_task_runs where id = ?",
                (run_id,),
            ).fetchone()
        return ThreadTaskRunRecord.from_row(row) if row else None

    def list_by_task(self, task_id: str, *, limit: int = 100) -> list[ThreadTaskRunRecord]:
        with self.db.connect() as conn:
            rows = conn.execute(
                """
                select * from thread_task_runs
                where task_id = ?
                order by started_at desc, created_at desc, id desc
                limit ?
                """,
                (task_id, max(1, min(limit, 500))),
            ).fetchall()
        return [ThreadTaskRunRecord.from_row(row) for row in rows]

    def get_running_by_task(self, task_id: str) -> ThreadTaskRunRecord | None:
        with self.db.connect() as conn:
            row = conn.execute(
                """
                select * from thread_task_runs
                where task_id = ? and status = ?
                order by started_at desc, created_at desc, id desc
                limit 1
                """,
                (task_id, THREAD_TASK_RUN_STATUS_RUNNING),
            ).fetchone()
        return ThreadTaskRunRecord.from_row(row) if row else None

    def attach_turn(
        self,
        run_id: str,
        *,
        turn_index: int,
        trace_id: str | None = None,
    ) -> ThreadTaskRunRecord | None:
        assignments = ["turn_index = ?", "updated_at = ?"]
        params: list[Any] = [int(turn_index), to_iso_z(utc_now())]
        if trace_id is not None:
            assignments.insert(1, "trace_id = ?")
            params.insert(1, trace_id)
        params.append(run_id)
        with self.db.transaction() as conn:
            cursor = conn.execute(
                f"update thread_task_runs set {', '.join(assignments)} where id = ?",
                params,
            )
        if cursor.rowcount == 0:
            return None
        return self.get(run_id)

    def finish(
        self,
        run_id: str,
        *,
        status: str,
        summary: dict[str, Any] | None = None,
        error: dict[str, Any] | None = None,
    ) -> ThreadTaskRunRecord | None:
        self._validate_finish_status(status)
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            cursor = conn.execute(
                """
                update thread_task_runs
                set status = ?,
                    summary_json = ?,
                    error_json = ?,
                    finished_at = ?,
                    updated_at = ?
                where id = ?
                """,
                (
                    status,
                    _json_dumps(summary or {}),
                    _json_dumps(error or {}),
                    now,
                    now,
                    run_id,
                ),
            )
        if cursor.rowcount == 0:
            return None
        return self.get(run_id)

    @classmethod
    def _validate_finish_status(cls, status: str) -> None:
        if status == THREAD_TASK_RUN_STATUS_RUNNING or status not in THREAD_TASK_RUN_STATUSES:
            raise ValueError(f"不支持的 thread task run 完成状态: {status}")


class CompressionStagingRepository:
    """压缩暂存记录仓储。

    后台压缩先把 L1/L2 和锚点写入 pending 记录，再切换活动会话；
    下一次模型调用前由中间件按 target_session_id 消费并标记 applied。
    """

    VALID_STATUSES = {"pending", "applied", "superseded", "failed"}
    VALID_STAGING_STRATEGIES = {"anchor_replacement", "full_replacement"}

    def __init__(self, db: Database) -> None:
        self.db = db

    def create(
        self,
        *,
        original_session_id: str,
        active_session_id: str,
        target_session_id: str,
        generation: int,
        anchor_message_id: str | None = None,
        source_last_message_id: str | None = None,
        l1_content: str | None = None,
        l2_content: str | None = None,
        staging_strategy: str = "anchor_replacement",
    ) -> CompressionStagingRecord:
        if generation < 1:
            raise ValueError("压缩暂存 generation 必须大于等于 1")
        self._validate_staging_strategy(staging_strategy)
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            cursor = conn.execute(
                """
                insert into compression_staging (
                  original_session_id, active_session_id, target_session_id,
                  generation, status, staging_strategy, anchor_message_id,
                  source_last_message_id, l1_content, l2_content,
                  created_at, updated_at
                ) values (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    original_session_id,
                    active_session_id,
                    target_session_id,
                    generation,
                    staging_strategy,
                    anchor_message_id,
                    source_last_message_id,
                    l1_content,
                    l2_content,
                    now,
                    now,
                ),
            )
            row_id = int(cursor.lastrowid)
        record = self.get(row_id)
        if record is None:
            raise RuntimeError(f"创建压缩暂存记录后无法读取: {row_id}")
        return record

    def create_with_latest_priority(
        self,
        *,
        original_session_id: str,
        active_session_id: str,
        target_session_id: str,
        generation: int,
        anchor_message_id: str | None = None,
        source_last_message_id: str | None = None,
        l1_content: str | None = None,
        l2_content: str | None = None,
        staging_strategy: str = "anchor_replacement",
    ) -> CompressionStagingRecord:
        if generation < 1:
            raise ValueError("压缩暂存 generation 必须大于等于 1")
        self._validate_staging_strategy(staging_strategy)
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            conn.execute(
                """
                update compression_staging
                set status = 'superseded',
                    failure_reason = 'superseded_by_newer_generation',
                    updated_at = ?
                where original_session_id = ?
                  and generation < ?
                  and status in ('pending', 'applied')
                  and is_deleted = 0
                """,
                (now, original_session_id, generation),
            )
        return self.create(
            original_session_id=original_session_id,
            active_session_id=active_session_id,
            target_session_id=target_session_id,
            generation=generation,
            anchor_message_id=anchor_message_id,
            source_last_message_id=source_last_message_id,
            l1_content=l1_content,
            l2_content=l2_content,
            staging_strategy=staging_strategy,
        )

    def get(
        self, staging_id: int, *, include_deleted: bool = False
    ) -> CompressionStagingRecord | None:
        query = "select * from compression_staging where id = ?"
        params: list[Any] = [staging_id]
        if not include_deleted:
            query += " and is_deleted = 0"
        with self.db.connect() as conn:
            row = conn.execute(query, params).fetchone()
        return self._from_row(row) if row else None

    def get_latest(
        self,
        *,
        original_session_id: str,
        status: str | None = None,
        target_session_id: str | None = None,
        include_deleted: bool = False,
    ) -> CompressionStagingRecord | None:
        filters = ["original_session_id = ?"]
        params: list[Any] = [original_session_id]
        if status is not None:
            self._validate_status(status)
            filters.append("status = ?")
            params.append(status)
        if target_session_id is not None:
            filters.append("target_session_id = ?")
            params.append(target_session_id)
        if not include_deleted:
            filters.append("is_deleted = 0")
        where = " and ".join(filters)
        with self.db.connect() as conn:
            row = conn.execute(
                f"""
                select * from compression_staging
                where {where}
                order by generation desc, id desc
                limit 1
                """,
                params,
            ).fetchone()
        return self._from_row(row) if row else None

    def next_generation(self, original_session_id: str) -> int:
        latest = self.get_latest(original_session_id=original_session_id, include_deleted=True)
        return (latest.generation + 1) if latest is not None else 1

    def mark_status(
        self,
        staging_id: int,
        *,
        status: str,
        failure_reason: str | None = None,
    ) -> CompressionStagingRecord | None:
        self._validate_status(status)
        now = to_iso_z(utc_now())
        applied_at = now if status == "applied" else None
        with self.db.transaction() as conn:
            conn.execute(
                """
                update compression_staging
                set status = ?,
                    failure_reason = ?,
                    applied_at = coalesce(?, applied_at),
                    updated_at = ?
                where id = ? and is_deleted = 0
                """,
                (status, failure_reason, applied_at, now, staging_id),
            )
        return self.get(staging_id)

    @classmethod
    def _validate_status(cls, status: str) -> None:
        if status not in cls.VALID_STATUSES:
            raise ValueError(f"不支持的压缩暂存状态: {status}")

    @classmethod
    def _validate_staging_strategy(cls, strategy: str) -> None:
        if strategy not in cls.VALID_STAGING_STRATEGIES:
            raise ValueError(f"不支持的压缩暂存策略: {strategy}")

    @staticmethod
    def _from_row(row: sqlite3.Row) -> CompressionStagingRecord:
        return CompressionStagingRecord(
            id=int(row["id"]),
            original_session_id=row["original_session_id"],
            active_session_id=row["active_session_id"],
            target_session_id=row["target_session_id"],
            generation=int(row["generation"]),
            status=row["status"],
            staging_strategy=row["staging_strategy"],
            anchor_message_id=row["anchor_message_id"],
            source_last_message_id=row["source_last_message_id"],
            l1_content=row["l1_content"],
            l2_content=row["l2_content"],
            failure_reason=row["failure_reason"],
            applied_at=row["applied_at"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            is_deleted=bool(row["is_deleted"]),
        )


class TraceRecordsRepository:
    VALID_STATUSES = {"running", "completed", "failed", "cancelled"}

    def __init__(self, db: Database) -> None:
        self.db = db

    def create(
        self,
        *,
        trace_id: str,
        session_id: str,
        scene_id: str,
        user_id: str,
        turn_index: int,
        root_node_id: str,
        active_session_id: str | None = None,
        scene_name: str | None = None,
        scene_version_seq: int | None = None,
        user_message_preview: str | None = None,
        input_checkpoint_id: str | None = None,
        input_checkpoint_ns: str | None = None,
        metadata: dict[str, Any] | None = None,
        status: str = "running",
    ) -> TraceRecord:
        self._validate_status(status)
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            conn.execute(
                """
                insert into trace_record (
                  trace_id, session_id, active_session_id, scene_id, scene_name,
                  scene_version_seq, user_id, turn_index, root_node_id, status,
                  start_time, user_message_preview, input_checkpoint_id,
                  input_checkpoint_ns, metadata_json, created_at, updated_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    trace_id,
                    session_id,
                    active_session_id,
                    scene_id,
                    scene_name,
                    scene_version_seq,
                    user_id,
                    turn_index,
                    root_node_id,
                    status,
                    now,
                    user_message_preview,
                    input_checkpoint_id,
                    input_checkpoint_ns,
                    _json_dumps(metadata or {}),
                    now,
                    now,
                ),
            )
        record = self.get(trace_id)
        if record is None:
            raise RuntimeError(f"创建 trace_record 后无法读取: {trace_id}")
        return record

    def get(self, trace_id: str, *, include_deleted: bool = False) -> TraceRecord | None:
        query = "select * from trace_record where trace_id = ?"
        params: list[Any] = [trace_id]
        if not include_deleted:
            query += " and is_deleted = 0"
        with self.db.connect() as conn:
            row = conn.execute(query, params).fetchone()
        return self._from_row(row) if row else None

    def list_by_session(self, session_id: str) -> list[TraceRecord]:
        with self.db.connect() as conn:
            rows = conn.execute(
                """
                select * from trace_record
                where session_id = ? and is_deleted = 0
                order by turn_index asc, created_at asc
                """,
                (session_id,),
            ).fetchall()
        return [self._from_row(row) for row in rows]

    def soft_delete_from_turn(self, session_id: str, turn_index: int) -> int:
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            cursor = conn.execute(
                """
                update trace_record
                set is_deleted = 1, updated_at = ?
                where session_id = ?
                  and turn_index >= ?
                  and is_deleted = 0
                """,
                (now, session_id, int(turn_index)),
            )
        return int(cursor.rowcount)

    def finish(
        self,
        trace_id: str,
        *,
        status: str,
        duration_ms: int | None = None,
        total_input_tokens: int = 0,
        total_output_tokens: int = 0,
        total_cache_read_tokens: int = 0,
        output_checkpoint_id: str | None = None,
        output_checkpoint_ns: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> TraceRecord | None:
        self._validate_status(status)
        now = to_iso_z(utc_now())
        total_tokens = total_input_tokens + total_output_tokens
        with self.db.transaction() as conn:
            conn.execute(
                """
                update trace_record set
                  status = ?,
                  end_time = ?,
                  duration_ms = ?,
                  total_input_tokens = ?,
                  total_output_tokens = ?,
                  total_tokens = ?,
                  total_cache_read_tokens = ?,
                  output_checkpoint_id = ?,
                  output_checkpoint_ns = ?,
                  metadata_json = coalesce(?, metadata_json),
                  updated_at = ?
                where trace_id = ? and is_deleted = 0
                """,
                (
                    status,
                    now,
                    duration_ms,
                    total_input_tokens,
                    total_output_tokens,
                    total_tokens,
                    total_cache_read_tokens,
                    output_checkpoint_id,
                    output_checkpoint_ns,
                    None if metadata is None else _json_dumps(metadata),
                    now,
                    trace_id,
                ),
            )
        return self.get(trace_id)

    @classmethod
    def _validate_status(cls, status: str) -> None:
        if status not in cls.VALID_STATUSES:
            raise ValueError(f"不支持的 trace 状态: {status}")

    @staticmethod
    def _from_row(row: sqlite3.Row) -> TraceRecord:
        return TraceRecord(
            trace_id=row["trace_id"],
            session_id=row["session_id"],
            active_session_id=row["active_session_id"],
            scene_id=row["scene_id"],
            scene_name=row["scene_name"],
            scene_version_seq=row["scene_version_seq"],
            user_id=row["user_id"],
            turn_index=int(row["turn_index"]),
            root_node_id=row["root_node_id"],
            status=row["status"],
            start_time=row["start_time"],
            end_time=row["end_time"],
            duration_ms=row["duration_ms"],
            total_input_tokens=int(row["total_input_tokens"]),
            total_output_tokens=int(row["total_output_tokens"]),
            total_tokens=int(row["total_tokens"]),
            total_cache_read_tokens=int(row["total_cache_read_tokens"]),
            user_message_preview=row["user_message_preview"],
            input_checkpoint_id=row["input_checkpoint_id"],
            input_checkpoint_ns=row["input_checkpoint_ns"],
            output_checkpoint_id=row["output_checkpoint_id"],
            output_checkpoint_ns=row["output_checkpoint_ns"],
            metadata=_json_loads(row["metadata_json"], {}),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            is_deleted=bool(row["is_deleted"]),
        )


class TraceEventLogsRepository:
    def __init__(self, db: Database) -> None:
        self.db = db

    def append(
        self,
        *,
        trace_id: str,
        trace_record_id: str,
        event_type: str,
        source: str,
        idempotency_key: str,
        timestamp_ms: int,
        payload: dict[str, Any],
        occurred_at: str | None = None,
        node_id: str | None = None,
        parent_node_id: str | None = None,
        root_node_id: str | None = None,
        sequence_no: int | None = None,
        run_id: str | None = None,
        turn_index: int | None = None,
        user_id: str | None = None,
        original_session_id: str | None = None,
        active_session_id: str | None = None,
        tags: dict[str, Any] | None = None,
    ) -> TraceEventLogRecord:
        now = to_iso_z(utc_now())
        resolved_occurred_at = occurred_at or now
        with self.db.transaction() as conn:
            cursor = conn.execute(
                """
                insert into trace_event_log (
                  trace_id, trace_record_id, event_type, source, idempotency_key,
                  node_id, parent_node_id, root_node_id, sequence_no, run_id,
                  turn_index, user_id, original_session_id, active_session_id,
                  timestamp_ms, occurred_at, tags_json, payload_json,
                  created_at, updated_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    trace_id,
                    trace_record_id,
                    event_type,
                    source,
                    idempotency_key,
                    node_id,
                    parent_node_id,
                    root_node_id,
                    sequence_no,
                    run_id,
                    turn_index,
                    user_id,
                    original_session_id,
                    active_session_id,
                    timestamp_ms,
                    resolved_occurred_at,
                    _json_dumps(tags or {}),
                    _json_dumps(payload),
                    now,
                    now,
                ),
            )
            row_id = int(cursor.lastrowid)
        record = self.get(row_id)
        if record is None:
            raise RuntimeError(f"追加 trace_event_log 后无法读取: {row_id}")
        return record

    def get(self, row_id: int) -> TraceEventLogRecord | None:
        with self.db.connect() as conn:
            row = conn.execute(
                "select * from trace_event_log where id = ?",
                (row_id,),
            ).fetchone()
        return self._from_row(row) if row else None

    def list_by_trace_record(self, trace_record_id: str) -> list[TraceEventLogRecord]:
        with self.db.connect() as conn:
            rows = conn.execute(
                """
                select * from trace_event_log
                where trace_record_id = ?
                order by sequence_no asc, id asc
                """,
                (trace_record_id,),
            ).fetchall()
        return [self._from_row(row) for row in rows]

    @staticmethod
    def _from_row(row: sqlite3.Row) -> TraceEventLogRecord:
        return TraceEventLogRecord(
            id=int(row["id"]),
            trace_id=row["trace_id"],
            trace_record_id=row["trace_record_id"],
            event_type=row["event_type"],
            source=row["source"],
            idempotency_key=row["idempotency_key"],
            node_id=row["node_id"],
            parent_node_id=row["parent_node_id"],
            root_node_id=row["root_node_id"],
            sequence_no=row["sequence_no"],
            run_id=row["run_id"],
            turn_index=row["turn_index"],
            user_id=row["user_id"],
            original_session_id=row["original_session_id"],
            active_session_id=row["active_session_id"],
            timestamp_ms=int(row["timestamp_ms"]),
            occurred_at=row["occurred_at"],
            tags=_json_loads(row["tags_json"], {}),
            payload=_json_loads(row["payload_json"], {}),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )


class LLMRequestLogsRepository:
    VALID_STATUSES = {"running", "completed", "failed", "cancelled"}

    def __init__(self, db: Database) -> None:
        self.db = db

    def start(
        self,
        *,
        request_id: str,
        trace_id: str,
        trace_record_id: str,
        session_id: str,
        model: str,
        active_session_id: str | None = None,
        gateway_thread_id: str | None = None,
        gateway_trace_id: str | None = None,
        turn_index: int | None = None,
        provider_id: str | None = None,
        provider_name: str | None = None,
        request_preview: str | None = None,
        metadata: dict[str, Any] | None = None,
        start_time: str | None = None,
    ) -> LLMRequestLogRecord:
        now = to_iso_z(utc_now())
        resolved_start_time = start_time or now
        with self.db.transaction() as conn:
            conn.execute(
                """
                insert into llm_request_logs (
                  id, trace_id, trace_record_id, session_id, active_session_id,
                  gateway_thread_id, gateway_trace_id, turn_index,
                  provider_id, provider_name, model, status,
                  start_time, request_preview, metadata_json, created_at, updated_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    request_id,
                    trace_id,
                    trace_record_id,
                    session_id,
                    active_session_id,
                    gateway_thread_id,
                    gateway_trace_id,
                    turn_index,
                    provider_id,
                    provider_name,
                    model,
                    "running",
                    resolved_start_time,
                    _clip_text(request_preview),
                    _json_dumps(_sanitize_metadata(metadata or {})),
                    now,
                    now,
                ),
            )
        record = self.get(request_id)
        if record is None:
            raise RuntimeError(f"创建 LLM 请求日志后无法读取: {request_id}")
        return record

    def finish(
        self,
        request_id: str,
        *,
        input_tokens: int = 0,
        cache_read_tokens: int = 0,
        output_tokens: int = 0,
        total_tokens: int | None = None,
        response_preview: str | None = None,
        metadata: dict[str, Any] | None = None,
        duration_ms: int | None = None,
        time_to_first_token: int | None = None,
        end_time: str | None = None,
        gateway_thread_id: str | None = None,
        gateway_trace_id: str | None = None,
    ) -> LLMRequestLogRecord | None:
        return self._complete(
            request_id,
            status="completed",
            input_tokens=input_tokens,
            cache_read_tokens=cache_read_tokens,
            output_tokens=output_tokens,
            total_tokens=total_tokens,
            response_preview=response_preview,
            metadata=metadata,
            duration_ms=duration_ms,
            time_to_first_token=time_to_first_token,
            end_time=end_time,
            gateway_thread_id=gateway_thread_id,
            gateway_trace_id=gateway_trace_id,
        )

    def fail(
        self,
        request_id: str,
        *,
        error_message: str,
        input_tokens: int = 0,
        cache_read_tokens: int = 0,
        output_tokens: int = 0,
        total_tokens: int | None = None,
        response_preview: str | None = None,
        metadata: dict[str, Any] | None = None,
        duration_ms: int | None = None,
        time_to_first_token: int | None = None,
        end_time: str | None = None,
        gateway_thread_id: str | None = None,
        gateway_trace_id: str | None = None,
    ) -> LLMRequestLogRecord | None:
        return self._complete(
            request_id,
            status="failed",
            input_tokens=input_tokens,
            cache_read_tokens=cache_read_tokens,
            output_tokens=output_tokens,
            total_tokens=total_tokens,
            response_preview=response_preview,
            error_message=error_message,
            metadata=metadata,
            duration_ms=duration_ms,
            time_to_first_token=time_to_first_token,
            end_time=end_time,
            gateway_thread_id=gateway_thread_id,
            gateway_trace_id=gateway_trace_id,
        )

    def cancel(
        self,
        request_id: str,
        *,
        error_message: str | None = None,
        input_tokens: int = 0,
        cache_read_tokens: int = 0,
        output_tokens: int = 0,
        total_tokens: int | None = None,
        response_preview: str | None = None,
        metadata: dict[str, Any] | None = None,
        duration_ms: int | None = None,
        time_to_first_token: int | None = None,
        end_time: str | None = None,
        gateway_thread_id: str | None = None,
        gateway_trace_id: str | None = None,
    ) -> LLMRequestLogRecord | None:
        return self._complete(
            request_id,
            status="cancelled",
            input_tokens=input_tokens,
            cache_read_tokens=cache_read_tokens,
            output_tokens=output_tokens,
            total_tokens=total_tokens,
            response_preview=response_preview,
            error_message=error_message,
            metadata=metadata,
            duration_ms=duration_ms,
            time_to_first_token=time_to_first_token,
            end_time=end_time,
            gateway_thread_id=gateway_thread_id,
            gateway_trace_id=gateway_trace_id,
        )

    def get(self, request_id: str, *, include_deleted: bool = False) -> LLMRequestLogRecord | None:
        query = "select * from llm_request_logs where id = ?"
        params: list[Any] = [request_id]
        if not include_deleted:
            query += " and is_deleted = 0"
        with self.db.connect() as conn:
            row = conn.execute(query, params).fetchone()
        return self._from_row(row) if row else None

    def list(
        self,
        *,
        start_time: str | None = None,
        end_time: str | None = None,
        model: str | None = None,
        status: str | None = None,
        page: int = 1,
        page_size: int = 20,
    ) -> tuple[list[LLMRequestLogRecord], int]:
        where, params = self._filters(
            start_time=start_time,
            end_time=end_time,
            model=model,
            status=status,
        )
        resolved_page = max(1, page)
        resolved_page_size = max(1, min(page_size, 200))
        offset = (resolved_page - 1) * resolved_page_size
        with self.db.connect() as conn:
            total_row = conn.execute(
                f"select count(*) as total from llm_request_logs {where}",
                params,
            ).fetchone()
            rows = conn.execute(
                f"""
                select * from llm_request_logs
                {where}
                order by start_time desc, created_at desc, id desc
                limit ? offset ?
                """,
                [*params, resolved_page_size, offset],
            ).fetchall()
        return [self._from_row(row) for row in rows], int(total_row["total"])

    def summary(
        self,
        *,
        start_time: str | None = None,
        end_time: str | None = None,
        model: str | None = None,
    ) -> dict[str, Any]:
        where, params = self._filters(start_time=start_time, end_time=end_time, model=model)
        with self.db.connect() as conn:
            row = conn.execute(
                f"""
                select
                  count(*) as request_count,
                  coalesce(sum(input_tokens), 0) as input_tokens,
                  coalesce(sum(cache_read_tokens), 0) as cache_read_tokens,
                  coalesce(sum(output_tokens), 0) as output_tokens,
                  coalesce(sum(total_tokens), 0) as total_tokens,
                  coalesce(
                    sum(case when status = 'completed' then 1 else 0 end),
                    0
                  ) as success_count,
                  coalesce(sum(case when status = 'failed' then 1 else 0 end), 0) as failed_count,
                  avg(duration_ms) as avg_duration_ms
                from llm_request_logs
                {where}
                """,
                params,
            ).fetchone()
        return {
            "request_count": int(row["request_count"] or 0),
            "input_tokens": int(row["input_tokens"] or 0),
            "cache_read_tokens": int(row["cache_read_tokens"] or 0),
            "output_tokens": int(row["output_tokens"] or 0),
            "total_tokens": int(row["total_tokens"] or 0),
            "success_count": int(row["success_count"] or 0),
            "failed_count": int(row["failed_count"] or 0),
            "avg_duration_ms": int(row["avg_duration_ms"] or 0),
        }

    def trend(
        self,
        *,
        start_time: str | None = None,
        end_time: str | None = None,
        model: str | None = None,
        bucket: str = "day",
        timezone_offset_minutes: int = 0,
    ) -> list[dict[str, Any]]:
        return self.trend_page(
            start_time=start_time,
            end_time=end_time,
            model=model,
            bucket=bucket,
            timezone_offset_minutes=timezone_offset_minutes,
        )["points"]

    def trend_page(
        self,
        *,
        start_time: str | None = None,
        end_time: str | None = None,
        model: str | None = None,
        bucket: str = "day",
        timezone_offset_minutes: int = 0,
        start_after: str | None = None,
        limit: int | None = None,
    ) -> dict[str, Any]:
        if bucket not in {"hour", "day"}:
            raise ValueError(f"不支持的用量统计粒度: {bucket}")
        _validate_timezone_offset(timezone_offset_minutes)
        if limit is not None and limit < 1:
            raise ValueError("趋势分页数量必须大于等于 1")
        if limit is not None and limit > 2000:
            raise ValueError("趋势分页数量不能超过 2000")

        cursor_start_time = (
            _usage_cursor_next_start_time(
                start_after,
                bucket=bucket,
                timezone_offset_minutes=timezone_offset_minutes,
            )
            if start_after
            else None
        )
        effective_start_time = _max_iso_time(start_time, cursor_start_time)
        where, params = self._filters(
            start_time=effective_start_time,
            end_time=end_time,
            model=model,
        )
        bucket_expression = _usage_bucket_sql_expression(bucket)
        timezone_modifier = _sqlite_timezone_modifier(timezone_offset_minutes)
        query_params: list[Any] = [timezone_modifier, *params]
        fetch_limit = limit + 1 if limit is not None else None
        limit_sql = ""
        if fetch_limit is not None:
            limit_sql = "limit ?"
            query_params.append(fetch_limit)
        with self.db.connect() as conn:
            rows = conn.execute(
                f"""
                select
                  {bucket_expression} as time,
                  count(*) as request_count,
                  coalesce(sum(input_tokens), 0) as input_tokens,
                  coalesce(sum(cache_read_tokens), 0) as cache_read_tokens,
                  coalesce(sum(output_tokens), 0) as output_tokens,
                  coalesce(sum(total_tokens), 0) as total_tokens,
                  coalesce(sum(case when status = 'failed' then 1 else 0 end), 0) as failed_count
                from llm_request_logs
                {where}
                group by time
                order by time asc
                {limit_sql}
                """,
                query_params,
            ).fetchall()
        has_more = fetch_limit is not None and len(rows) > limit
        visible_rows = rows[:limit] if has_more and limit is not None else rows
        points = [
            {
                "time": str(row["time"]),
                "request_count": int(row["request_count"] or 0),
                "input_tokens": int(row["input_tokens"] or 0),
                "cache_read_tokens": int(row["cache_read_tokens"] or 0),
                "output_tokens": int(row["output_tokens"] or 0),
                "total_tokens": int(row["total_tokens"] or 0),
                "failed_count": int(row["failed_count"] or 0),
            }
            for row in visible_rows
        ]
        return {
            "points": points,
            "next_cursor": points[-1]["time"] if has_more and points else None,
            "has_more": has_more,
        }

    def list_models(self) -> list[str]:
        with self.db.connect() as conn:
            rows = conn.execute(
                """
                select distinct model from llm_request_logs
                where is_deleted = 0
                order by model asc
                """
            ).fetchall()
        return [str(row["model"]) for row in rows]

    def _complete(
        self,
        request_id: str,
        *,
        status: str,
        input_tokens: int = 0,
        cache_read_tokens: int = 0,
        output_tokens: int = 0,
        total_tokens: int | None = None,
        response_preview: str | None = None,
        error_message: str | None = None,
        metadata: dict[str, Any] | None = None,
        duration_ms: int | None = None,
        time_to_first_token: int | None = None,
        end_time: str | None = None,
        gateway_thread_id: str | None = None,
        gateway_trace_id: str | None = None,
    ) -> LLMRequestLogRecord | None:
        self._validate_status(status)
        now = to_iso_z(utc_now())
        resolved_end_time = end_time or now
        resolved_total_tokens = (
            int(total_tokens)
            if total_tokens is not None
            else int(input_tokens or 0) + int(output_tokens or 0)
        )
        metadata_json = None if metadata is None else _json_dumps(_sanitize_metadata(metadata))
        with self.db.transaction() as conn:
            conn.execute(
                """
                update llm_request_logs set
                  status = ?,
                  end_time = ?,
                  duration_ms = coalesce(?, duration_ms),
                  time_to_first_token = coalesce(?, time_to_first_token),
                  gateway_thread_id = coalesce(?, gateway_thread_id),
                  gateway_trace_id = coalesce(?, gateway_trace_id),
                  input_tokens = ?,
                  cache_read_tokens = ?,
                  output_tokens = ?,
                  total_tokens = ?,
                  response_preview = coalesce(?, response_preview),
                  error_message = ?,
                  metadata_json = coalesce(?, metadata_json),
                  updated_at = ?
                where id = ? and is_deleted = 0
                """,
                (
                    status,
                    resolved_end_time,
                    duration_ms,
                    time_to_first_token,
                    gateway_thread_id,
                    gateway_trace_id,
                    max(0, int(input_tokens or 0)),
                    max(0, int(cache_read_tokens or 0)),
                    max(0, int(output_tokens or 0)),
                    max(0, resolved_total_tokens),
                    _clip_text(response_preview),
                    _clip_text(error_message),
                    metadata_json,
                    now,
                    request_id,
                ),
            )
        return self.get(request_id)

    @classmethod
    def _validate_status(cls, status: str) -> None:
        if status not in cls.VALID_STATUSES:
            raise ValueError(f"不支持的 LLM 请求状态: {status}")

    @staticmethod
    def _filters(
        *,
        start_time: str | None = None,
        end_time: str | None = None,
        model: str | None = None,
        status: str | None = None,
    ) -> tuple[str, list[Any]]:
        filters = ["is_deleted = 0"]
        params: list[Any] = []
        if start_time:
            filters.append("start_time >= ?")
            params.append(start_time)
        if end_time:
            filters.append("start_time <= ?")
            params.append(end_time)
        if model:
            filters.append("model = ?")
            params.append(model)
        if status:
            filters.append("status = ?")
            params.append(status)
        return f"where {' and '.join(filters)}", params

    @staticmethod
    def _from_row(row: sqlite3.Row) -> LLMRequestLogRecord:
        return LLMRequestLogRecord(
            id=row["id"],
            trace_id=row["trace_id"],
            trace_record_id=row["trace_record_id"],
            session_id=row["session_id"],
            active_session_id=row["active_session_id"],
            gateway_thread_id=row["gateway_thread_id"],
            gateway_trace_id=row["gateway_trace_id"],
            turn_index=row["turn_index"],
            provider_id=row["provider_id"],
            provider_name=row["provider_name"],
            model=row["model"],
            status=row["status"],
            start_time=row["start_time"],
            end_time=row["end_time"],
            duration_ms=row["duration_ms"],
            time_to_first_token=row["time_to_first_token"],
            input_tokens=int(row["input_tokens"]),
            cache_read_tokens=int(row["cache_read_tokens"]),
            output_tokens=int(row["output_tokens"]),
            total_tokens=int(row["total_tokens"]),
            request_preview=row["request_preview"],
            response_preview=row["response_preview"],
            error_message=row["error_message"],
            metadata=_json_loads(row["metadata_json"], {}),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            is_deleted=bool(row["is_deleted"]),
        )


class CommandApprovalRequestsRepository:
    VALID_STATUSES = {"pending", "approved", "rejected", "expired", "cancelled"}

    def __init__(self, db: Database) -> None:
        self.db = db

    def create(
        self,
        *,
        approval_id: str,
        session_id: str,
        command: str,
        cwd: str,
        title: str,
        description: str = "",
        trace_id: str | None = None,
        turn_index: int | None = None,
        run_id: str | None = None,
        tool_name: str = "command",
        kind: str = "exec",
        shell: str = "shell",
        workspace_root: str = "",
        details: dict[str, Any] | None = None,
    ) -> CommandApprovalRequestRecord:
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            conn.execute(
                """
                insert into command_approval_requests (
                  id, session_id, trace_id, turn_index, run_id, tool_name, kind,
                  title, description, command, cwd, shell, workspace_root, details_json,
                  status, created_at, updated_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
                """,
                (
                    approval_id,
                    session_id,
                    trace_id,
                    turn_index,
                    run_id,
                    tool_name,
                    kind,
                    title,
                    description,
                    command,
                    cwd,
                    shell,
                    workspace_root,
                    _json_dumps(details or {}),
                    now,
                    now,
                ),
            )
        record = self.get(approval_id)
        if record is None:
            raise RuntimeError(f"创建 command 审批后无法读取: {approval_id}")
        return record

    def get(
        self,
        approval_id: str,
        *,
        include_deleted: bool = False,
    ) -> CommandApprovalRequestRecord | None:
        query = "select * from command_approval_requests where id = ?"
        params: list[Any] = [approval_id]
        if not include_deleted:
            query += " and is_deleted = 0"
        with self.db.connect() as conn:
            row = conn.execute(query, params).fetchone()
        return self._from_row(row) if row else None

    def list_pending(
        self,
        *,
        session_id: str | None = None,
        limit: int = 100,
    ) -> list[CommandApprovalRequestRecord]:
        filters = ["status = 'pending'", "is_deleted = 0"]
        params: list[Any] = []
        if session_id:
            filters.append("session_id = ?")
            params.append(session_id)
        params.append(max(1, min(limit, 500)))
        with self.db.connect() as conn:
            rows = conn.execute(
                f"""
                select * from command_approval_requests
                where {" and ".join(filters)}
                order by created_at asc, id asc
                limit ?
                """,
                params,
            ).fetchall()
        return [self._from_row(row) for row in rows]

    def list_history(
        self,
        *,
        session_id: str | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> tuple[list[CommandApprovalRequestRecord], int]:
        filters = ["is_deleted = 0"]
        params: list[Any] = []
        if session_id:
            filters.append("session_id = ?")
            params.append(session_id)
        where = f"where {' and '.join(filters)}"
        resolved_limit = max(1, min(limit, 500))
        resolved_offset = max(0, offset)
        with self.db.connect() as conn:
            total = conn.execute(
                f"select count(*) as total from command_approval_requests {where}",
                params,
            ).fetchone()
            rows = conn.execute(
                f"""
                select * from command_approval_requests
                {where}
                order by created_at desc, id desc
                limit ? offset ?
                """,
                [*params, resolved_limit, resolved_offset],
            ).fetchall()
        return [self._from_row(row) for row in rows], int(total["total"])

    def resolve(
        self,
        approval_id: str,
        *,
        status: str,
        decision: str | None,
        trust_scope: str | None = None,
        rule_match_type: str | None = None,
        reject_message: str | None = None,
        trusted_rule_id: str | None = None,
    ) -> CommandApprovalRequestRecord | None:
        self._validate_status(status)
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            conn.execute(
                """
                update command_approval_requests set
                  status = ?,
                  decision = ?,
                  trust_scope = ?,
                  rule_match_type = ?,
                  reject_message = ?,
                  trusted_rule_id = ?,
                  resolved_at = ?,
                  updated_at = ?
                where id = ? and is_deleted = 0
                """,
                (
                    status,
                    decision,
                    trust_scope,
                    rule_match_type,
                    reject_message,
                    trusted_rule_id,
                    now,
                    now,
                    approval_id,
                ),
            )
        return self.get(approval_id)

    def cancel_pending_for_session(self, session_id: str) -> int:
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            cursor = conn.execute(
                """
                update command_approval_requests set
                  status = 'cancelled',
                  decision = 'rejected',
                  reject_message = coalesce(reject_message, '本轮对话已取消'),
                  resolved_at = ?,
                  updated_at = ?
                where session_id = ? and status = 'pending' and is_deleted = 0
                """,
                (now, now, session_id),
            )
        return int(cursor.rowcount or 0)

    @classmethod
    def _validate_status(cls, status: str) -> None:
        if status not in cls.VALID_STATUSES:
            raise ValueError(f"不支持的 command 审批状态: {status}")

    @staticmethod
    def _from_row(row: sqlite3.Row) -> CommandApprovalRequestRecord:
        return CommandApprovalRequestRecord(
            id=row["id"],
            session_id=row["session_id"],
            trace_id=row["trace_id"],
            turn_index=row["turn_index"],
            run_id=row["run_id"],
            tool_name=row["tool_name"],
            kind=row["kind"],
            title=row["title"],
            description=row["description"],
            command=row["command"],
            cwd=row["cwd"],
            shell=row["shell"],
            workspace_root=row["workspace_root"],
            details=_json_loads(row["details_json"], {}),
            status=row["status"],
            decision=row["decision"],
            trust_scope=row["trust_scope"],
            rule_match_type=row["rule_match_type"],
            reject_message=row["reject_message"],
            trusted_rule_id=row["trusted_rule_id"],
            created_at=row["created_at"],
            resolved_at=row["resolved_at"],
            updated_at=row["updated_at"],
            is_deleted=bool(row["is_deleted"]),
        )


class TrustedCommandRulesRepository:
    VALID_MATCH_TYPES = {"exact", "prefix"}

    def __init__(self, db: Database) -> None:
        self.db = db

    def create(
        self,
        *,
        rule_id: str,
        command_pattern: str,
        normalized_command: str,
        match_type: str,
        tool_name: str = "",
        shell: str = "",
        shell_path: str = "",
        workspace_root: str = "",
        cwd_pattern: str = ".",
        created_from_approval_id: str | None = None,
        enabled: bool = True,
    ) -> TrustedCommandRuleRecord:
        self._validate_match_type(match_type)
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            conn.execute(
                """
                insert into trusted_command_rules (
                  id, command_pattern, normalized_command, match_type, tool_name, shell,
                  shell_path, workspace_root, cwd_pattern, enabled, created_from_approval_id,
                  created_at, updated_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    rule_id,
                    command_pattern,
                    normalized_command,
                    match_type,
                    tool_name,
                    shell,
                    shell_path,
                    workspace_root,
                    cwd_pattern,
                    int(enabled),
                    created_from_approval_id,
                    now,
                    now,
                ),
            )
        record = self.get(rule_id)
        if record is None:
            raise RuntimeError(f"创建已信任命令后无法读取: {rule_id}")
        return record

    def get(
        self,
        rule_id: str,
        *,
        include_deleted: bool = False,
    ) -> TrustedCommandRuleRecord | None:
        query = "select * from trusted_command_rules where id = ?"
        params: list[Any] = [rule_id]
        if not include_deleted:
            query += " and is_deleted = 0"
        with self.db.connect() as conn:
            row = conn.execute(query, params).fetchone()
        return self._from_row(row) if row else None

    def list(
        self,
        *,
        include_disabled: bool = True,
        include_deleted: bool = False,
        limit: int = 200,
    ) -> list[TrustedCommandRuleRecord]:
        filters: list[str] = []
        if not include_disabled:
            filters.append("enabled = 1")
        if not include_deleted:
            filters.append("is_deleted = 0")
        where = f"where {' and '.join(filters)}" if filters else ""
        with self.db.connect() as conn:
            rows = conn.execute(
                f"""
                select * from trusted_command_rules
                {where}
                order by created_at desc, id desc
                limit ?
                """,
                (max(1, min(limit, 500)),),
            ).fetchall()
        return [self._from_row(row) for row in rows]

    def set_enabled(self, rule_id: str, enabled: bool) -> TrustedCommandRuleRecord | None:
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            conn.execute(
                """
                update trusted_command_rules set
                  enabled = ?,
                  updated_at = ?
                where id = ? and is_deleted = 0
                """,
                (int(enabled), now, rule_id),
            )
        return self.get(rule_id)

    def delete(self, rule_id: str) -> bool:
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            cursor = conn.execute(
                """
                update trusted_command_rules set
                  is_deleted = 1,
                  enabled = 0,
                  updated_at = ?
                where id = ? and is_deleted = 0
                """,
                (now, rule_id),
            )
        return int(cursor.rowcount or 0) > 0

    def touch_last_used(self, rule_id: str) -> TrustedCommandRuleRecord | None:
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            conn.execute(
                """
                update trusted_command_rules set
                  last_used_at = ?,
                  updated_at = ?
                where id = ? and is_deleted = 0
                """,
                (now, now, rule_id),
            )
        return self.get(rule_id)

    @classmethod
    def _validate_match_type(cls, match_type: str) -> None:
        if match_type not in cls.VALID_MATCH_TYPES:
            raise ValueError(f"不支持的命令匹配类型: {match_type}")

    @staticmethod
    def _from_row(row: sqlite3.Row) -> TrustedCommandRuleRecord:
        return TrustedCommandRuleRecord(
            id=row["id"],
            command_pattern=row["command_pattern"],
            normalized_command=row["normalized_command"],
            match_type=row["match_type"],
            tool_name=row["tool_name"],
            shell=row["shell"],
            shell_path=row["shell_path"],
            workspace_root=row["workspace_root"],
            cwd_pattern=row["cwd_pattern"],
            enabled=bool(row["enabled"]),
            created_from_approval_id=row["created_from_approval_id"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            last_used_at=row["last_used_at"],
            is_deleted=bool(row["is_deleted"]),
        )


class CommandApprovalAuditRepository:
    def __init__(self, db: Database) -> None:
        self.db = db

    def create(
        self,
        *,
        audit_id: str,
        approval_id: str,
        session_id: str,
        command: str,
        cwd: str,
        decision: str,
        trust_scope: str | None = None,
        rule_match_type: str | None = None,
        trusted_rule_id: str | None = None,
        reject_message: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> CommandApprovalAuditRecord:
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            conn.execute(
                """
                insert into command_approval_audit (
                  id, approval_id, session_id, command, cwd, decision, trust_scope,
                  rule_match_type, trusted_rule_id, reject_message, metadata_json, created_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    audit_id,
                    approval_id,
                    session_id,
                    command,
                    cwd,
                    decision,
                    trust_scope,
                    rule_match_type,
                    trusted_rule_id,
                    reject_message,
                    _json_dumps(_sanitize_metadata(metadata or {})),
                    now,
                ),
            )
        record = self.get(audit_id)
        if record is None:
            raise RuntimeError(f"创建 command 审批审计后无法读取: {audit_id}")
        return record

    def get(self, audit_id: str) -> CommandApprovalAuditRecord | None:
        with self.db.connect() as conn:
            row = conn.execute(
                "select * from command_approval_audit where id = ?",
                (audit_id,),
            ).fetchone()
        return self._from_row(row) if row else None

    def list(
        self,
        *,
        session_id: str | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> tuple[list[CommandApprovalAuditRecord], int]:
        filters: list[str] = []
        params: list[Any] = []
        if session_id:
            filters.append("session_id = ?")
            params.append(session_id)
        where = f"where {' and '.join(filters)}" if filters else ""
        resolved_limit = max(1, min(limit, 500))
        resolved_offset = max(0, offset)
        with self.db.connect() as conn:
            total = conn.execute(
                f"select count(*) as total from command_approval_audit {where}",
                params,
            ).fetchone()
            rows = conn.execute(
                f"""
                select * from command_approval_audit
                {where}
                order by created_at desc, id desc
                limit ? offset ?
                """,
                [*params, resolved_limit, resolved_offset],
            ).fetchall()
        return [self._from_row(row) for row in rows], int(total["total"])

    @staticmethod
    def _from_row(row: sqlite3.Row) -> CommandApprovalAuditRecord:
        return CommandApprovalAuditRecord(
            id=row["id"],
            approval_id=row["approval_id"],
            session_id=row["session_id"],
            command=row["command"],
            cwd=row["cwd"],
            decision=row["decision"],
            trust_scope=row["trust_scope"],
            rule_match_type=row["rule_match_type"],
            trusted_rule_id=row["trusted_rule_id"],
            reject_message=row["reject_message"],
            metadata=_json_loads(row["metadata_json"], {}),
            created_at=row["created_at"],
        )


def _validate_timezone_offset(value: int) -> None:
    if value < -14 * 60 or value > 14 * 60:
        raise ValueError("时区偏移必须在 -840 到 840 分钟之间")


def _usage_bucket_key(
    start_time: str,
    *,
    bucket: str,
    timezone_offset_minutes: int,
) -> str:
    value = datetime.fromisoformat(str(start_time).replace("Z", "+00:00"))
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    local_time = value.astimezone(UTC) + timedelta(minutes=timezone_offset_minutes)
    if bucket == "hour":
        return local_time.strftime("%Y-%m-%dT%H:00:00")
    return local_time.strftime("%Y-%m-%d")


def _usage_bucket_sql_expression(bucket: str) -> str:
    if bucket == "hour":
        return "strftime('%Y-%m-%dT%H:00:00', start_time, ?)"
    return "strftime('%Y-%m-%d', start_time, ?)"


def _sqlite_timezone_modifier(timezone_offset_minutes: int) -> str:
    sign = "+" if timezone_offset_minutes >= 0 else "-"
    return f"{sign}{abs(timezone_offset_minutes)} minutes"


def _usage_cursor_next_start_time(
    start_after: str,
    *,
    bucket: str,
    timezone_offset_minutes: int,
) -> str:
    if bucket == "hour":
        try:
            local_bucket = datetime.strptime(start_after, "%Y-%m-%dT%H:00:00")
        except ValueError as exc:
            raise ValueError("趋势游标格式不正确") from exc
        next_bucket = local_bucket + timedelta(hours=1)
    else:
        try:
            local_bucket = datetime.strptime(start_after, "%Y-%m-%d")
        except ValueError as exc:
            raise ValueError("趋势游标格式不正确") from exc
        next_bucket = local_bucket + timedelta(days=1)
    utc_bucket = next_bucket - timedelta(minutes=timezone_offset_minutes)
    return to_iso_z(utc_bucket.replace(tzinfo=UTC))


def _max_iso_time(left: str | None, right: str | None) -> str | None:
    if not left:
        return right
    if not right:
        return left
    return max(left, right)


class StorageRepositories:
    """Repositories retained during backend runtime replacement.

    The previous Thread/Turn/Item/Event/Approval repositories are intentionally
    removed from this shell. New session/message_event/trace repositories are
    introduced by the kt-agentloop rewrite issues.
    """

    def __init__(self, db: Database) -> None:
        self.db = db
        self.mcp_servers = McpServersRepository(db)
        self.mcp_server_status = McpServerStatusRepository(db)
        self.mcp_tools = McpToolsRepository(db)
        self.mcp_prompts = McpPromptsRepository(db)
        self.mcp_resources = McpResourcesRepository(db)
        self.mcp_tool_policies = McpToolPoliciesRepository(db)
        self.mcp_prompt_policies = McpPromptPoliciesRepository(db)
        self.mcp_session_tool_overrides = McpSessionToolOverridesRepository(db)
        self.mcp_runtime_snapshots = McpRuntimeSnapshotsRepository(db)
        self.mcp_oauth_tokens = McpOAuthTokensRepository(db)
        self.mcp_trust_rules = McpTrustRulesRepository(db)
        self.mcp_audit_log = McpAuditLogRepository(db)
        self.settings = SettingsRepository(db)
        self.model_providers = ModelProvidersRepository(db)
        self.workspaces = WorkspacesRepository(db)
        self.sessions = SessionsRepository(db)
        self.session_forks = SessionForksRepository(db)
        self.attachments = AttachmentsRepository(db)
        self.workspace_file_annotations = WorkspaceFileAnnotationsRepository(db)
        self.message_events = MessageEventsRepository(db)
        self.thread_tasks = ThreadTasksRepository(db)
        self.thread_task_runs = ThreadTaskRunsRepository(db)
        self.compression_staging = CompressionStagingRepository(db)
        self.command_approvals = CommandApprovalRequestsRepository(db)
        self.trusted_command_rules = TrustedCommandRulesRepository(db)
        self.command_approval_audit = CommandApprovalAuditRepository(db)
        self.trace_records = TraceRecordsRepository(db)
        self.trace_event_logs = TraceEventLogsRepository(db)
        self.llm_request_logs = LLMRequestLogsRepository(db)


def legacy_model_provider_from_settings(value: dict[str, Any]) -> ModelProviderRecord | None:
    base_url = str(value.get("base_url") or "").strip().rstrip("/")
    model = str(value.get("model") or "").strip()
    if not base_url and not model:
        return None
    now = to_iso_z(utc_now())
    models = [model] if model else []
    return ModelProviderRecord(
        id="legacy-openai-compatible",
        name="OpenAI-compatible",
        base_url=base_url,
        api_key=value.get("api_key") if isinstance(value.get("api_key"), str) else None,
        enabled=True,
        models=models,
        model_enabled={model: True} if model else {},
        health={},
        created_at=now,
        updated_at=now,
    )


def _clean_model_default_scope(scope: str) -> str:
    cleaned = scope.strip()
    if not cleaned:
        raise ValueError("model default scope must not be empty")
    return cleaned


def _require_model_default_scope(scope: str) -> str:
    cleaned = _clean_model_default_scope(scope)
    if cleaned not in MODEL_DEFAULT_SCOPES:
        expected = ", ".join(sorted(MODEL_DEFAULT_SCOPES))
        raise ValueError(f"unknown model default scope '{cleaned}', expected one of: {expected}")
    return cleaned
