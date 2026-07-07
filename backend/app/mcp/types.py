from __future__ import annotations

from enum import StrEnum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator


class McpTransport(StrEnum):
    STDIO = "stdio"
    STREAMABLE_HTTP = "streamable_http"
    SSE = "sse"


class McpServerStatus(StrEnum):
    UNKNOWN = "unknown"
    ONLINE = "online"
    OFFLINE = "offline"
    AUTH_REQUIRED = "auth_required"
    ERROR = "error"
    DISABLED = "disabled"
    REFRESHING = "refreshing"


class McpApprovalMode(StrEnum):
    INHERIT = "inherit"
    AUTO = "auto"
    PROMPT = "prompt"
    APPROVE = "approve"
    DENY = "deny"


class McpToolExposureMode(StrEnum):
    ALLOW_ALL_EXCEPT_DISABLED = "allow_all_except_disabled"
    ALLOW_SELECTED_ONLY = "allow_selected_only"


class McpToolEffectiveState(StrEnum):
    ENABLED = "enabled"
    DISABLED_PERSISTENTLY = "disabled_persistently"
    DISABLED_FOR_SESSION = "disabled_for_session"
    DISABLED_BY_SERVER = "disabled_by_server"
    SERVER_OFFLINE = "server_offline"
    APPROVAL_REQUIRED = "approval_required"
    REMOVED = "removed"
    SCHEMA_CHANGED = "schema_changed"


class McpAuthType(StrEnum):
    NONE = "none"
    HEADER_TOKEN = "header_token"
    BEARER_ENV = "bearer_env"
    OAUTH = "oauth"


class McpErrorCode(StrEnum):
    MCP_DISABLED = "mcp_disabled"
    SERVER_NOT_FOUND = "server_not_found"
    SERVER_DISABLED = "server_disabled"
    SERVER_OFFLINE = "server_offline"
    AUTH_REQUIRED = "auth_required"
    TOOL_NOT_FOUND = "tool_not_found"
    TOOL_DISABLED_BY_POLICY = "tool_disabled_by_policy"
    TOOL_DISABLED_BY_SESSION = "tool_disabled_by_session"
    APPROVAL_REQUIRED = "approval_required"
    APPROVAL_REJECTED = "approval_rejected"
    POLICY_DENIED = "policy_denied"
    TIMEOUT = "timeout"
    CANCELLED = "cancelled"
    PROTOCOL_ERROR = "protocol_error"
    VALIDATION_ERROR = "validation_error"
    RESULT_TOO_LARGE = "result_too_large"
    RESOURCE_RESERVED = "resource_reserved"
    INTERNAL_ERROR = "internal_error"


class McpBaseModel(BaseModel):
    model_config = ConfigDict(use_enum_values=True, validate_default=True, extra="forbid")


SERVER_DEFAULT_APPROVAL_MODES = {
    McpApprovalMode.AUTO.value,
    McpApprovalMode.PROMPT.value,
    McpApprovalMode.APPROVE.value,
}


def _approval_value(value: McpApprovalMode | str | None) -> str | None:
    if value is None:
        return None
    if isinstance(value, McpApprovalMode):
        return value.value
    return value


class McpServerCreateRequest(McpBaseModel):
    name: str
    description: str | None = None
    enabled: bool = True
    required: bool = False
    transport: McpTransport
    command: str | None = None
    args: list[str] | None = None
    cwd: str | None = None
    inherit_environment: bool = True
    env: dict[str, str] | None = None
    url: str | None = None
    sse_url: str | None = None
    message_url: str | None = None
    headers: dict[str, str] | None = None
    env_headers: dict[str, str] | None = None
    bearer_token_env_var: str | None = None
    auth_type: McpAuthType = McpAuthType.NONE
    secret_refs: dict[str, str] | None = None
    oauth_config: dict[str, Any] | None = None
    oauth_resource: str | None = None
    oauth_scopes: list[str] | None = None
    startup_timeout_sec: int = Field(default=30, gt=0)
    tool_timeout_sec: int = Field(default=60, gt=0)
    read_timeout_sec: int = Field(default=60, gt=0)
    sse_read_timeout_sec: int = Field(default=300, gt=0)
    shutdown_timeout_sec: int = Field(default=10, gt=0)
    restart_policy: str = Field(default="on_failure", pattern="^(never|on_failure|always)$")
    connect_mode: str = Field(default="on_demand", pattern="^(on_startup|on_demand)$")
    auto_refresh: bool = True
    refresh_interval_sec: int = Field(default=1800, gt=0)
    default_tool_exposure_mode: McpToolExposureMode = (
        McpToolExposureMode.ALLOW_ALL_EXCEPT_DISABLED
    )
    default_tool_approval_mode: McpApprovalMode = McpApprovalMode.PROMPT
    supports_parallel_tool_calls: bool = False
    elicitation_enabled: bool = True
    sampling_enabled: bool = False
    resource_reserved_policy: dict[str, Any] | None = None

    @field_validator("name")
    @classmethod
    def name_must_not_be_empty(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("MCP server name must not be empty")
        return cleaned

    @field_validator("default_tool_approval_mode")
    @classmethod
    def default_approval_mode_must_be_server_default(
        cls, value: McpApprovalMode | str
    ) -> McpApprovalMode | str:
        approval_value = _approval_value(value)
        if approval_value not in SERVER_DEFAULT_APPROVAL_MODES:
            raise ValueError("default_tool_approval_mode must be auto, prompt, or approve")
        return value


class McpServerUpdateRequest(McpBaseModel):
    name: str | None = None
    description: str | None = None
    enabled: bool | None = None
    required: bool | None = None
    transport: McpTransport | None = None
    command: str | None = None
    args: list[str] | None = None
    cwd: str | None = None
    inherit_environment: bool | None = None
    env: dict[str, str] | None = None
    url: str | None = None
    sse_url: str | None = None
    message_url: str | None = None
    headers: dict[str, str] | None = None
    env_headers: dict[str, str] | None = None
    bearer_token_env_var: str | None = None
    auth_type: McpAuthType | None = None
    secret_refs: dict[str, str] | None = None
    oauth_config: dict[str, Any] | None = None
    oauth_resource: str | None = None
    oauth_scopes: list[str] | None = None
    startup_timeout_sec: int | None = Field(default=None, gt=0)
    tool_timeout_sec: int | None = Field(default=None, gt=0)
    read_timeout_sec: int | None = Field(default=None, gt=0)
    sse_read_timeout_sec: int | None = Field(default=None, gt=0)
    shutdown_timeout_sec: int | None = Field(default=None, gt=0)
    restart_policy: str | None = Field(default=None, pattern="^(never|on_failure|always)$")
    connect_mode: str | None = Field(default=None, pattern="^(on_startup|on_demand)$")
    auto_refresh: bool | None = None
    refresh_interval_sec: int | None = Field(default=None, gt=0)
    default_tool_exposure_mode: McpToolExposureMode | None = None
    default_tool_approval_mode: McpApprovalMode | None = None
    supports_parallel_tool_calls: bool | None = None
    elicitation_enabled: bool | None = None
    sampling_enabled: bool | None = None
    resource_reserved_policy: dict[str, Any] | None = None

    @field_validator("name")
    @classmethod
    def name_must_not_be_empty(cls, value: str | None) -> str | None:
        if value is None:
            return value
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("MCP server name must not be empty")
        return cleaned

    @field_validator("default_tool_approval_mode")
    @classmethod
    def default_approval_mode_must_be_server_default(
        cls, value: McpApprovalMode | str | None
    ) -> McpApprovalMode | str | None:
        approval_value = _approval_value(value)
        if approval_value is not None and approval_value not in SERVER_DEFAULT_APPROVAL_MODES:
            raise ValueError("default_tool_approval_mode must be auto, prompt, or approve")
        return value


class McpServerAuthSummary(McpBaseModel):
    auth_type: McpAuthType
    headers_configured: bool
    env_headers_configured: bool
    bearer_token_env_var: str | None = None
    secret_ref_keys: list[str] = Field(default_factory=list)
    oauth_configured: bool = False
    oauth_resource: str | None = None
    oauth_scopes: list[str] = Field(default_factory=list)


class McpServerSummary(McpBaseModel):
    id: str
    name: str
    description: str | None = None
    enabled: bool
    required: bool
    transport: McpTransport
    status: McpServerStatus
    tools_count: int = 0
    resources_reserved: bool = False
    last_refresh_at: str | None = None
    last_error_message: str | None = None


class McpServerDetailResponse(McpServerSummary):
    auth: McpServerAuthSummary
    startup_timeout_sec: int
    tool_timeout_sec: int
    read_timeout_sec: int
    sse_read_timeout_sec: int
    shutdown_timeout_sec: int
    auto_refresh: bool
    refresh_interval_sec: int
    default_tool_exposure_mode: McpToolExposureMode
    default_tool_approval_mode: McpApprovalMode
    elicitation_enabled: bool
    sampling_enabled: bool

    @classmethod
    def from_create_request(
        cls,
        *,
        server_id: str,
        request: McpServerCreateRequest,
        status: McpServerStatus = McpServerStatus.UNKNOWN,
    ) -> McpServerDetailResponse:
        secret_refs = request.secret_refs or {}
        return cls(
            id=server_id,
            name=request.name,
            description=request.description,
            enabled=request.enabled,
            required=request.required,
            transport=request.transport,
            status=status,
            resources_reserved=bool(request.resource_reserved_policy),
            auth=McpServerAuthSummary(
                auth_type=request.auth_type,
                headers_configured=bool(request.headers),
                env_headers_configured=bool(request.env_headers),
                bearer_token_env_var=request.bearer_token_env_var,
                secret_ref_keys=sorted(secret_refs.keys()),
                oauth_configured=bool(request.oauth_config),
                oauth_resource=request.oauth_resource,
                oauth_scopes=request.oauth_scopes or [],
            ),
            startup_timeout_sec=request.startup_timeout_sec,
            tool_timeout_sec=request.tool_timeout_sec,
            read_timeout_sec=request.read_timeout_sec,
            sse_read_timeout_sec=request.sse_read_timeout_sec,
            shutdown_timeout_sec=request.shutdown_timeout_sec,
            auto_refresh=request.auto_refresh,
            refresh_interval_sec=request.refresh_interval_sec,
            default_tool_exposure_mode=request.default_tool_exposure_mode,
            default_tool_approval_mode=request.default_tool_approval_mode,
            elicitation_enabled=request.elicitation_enabled,
            sampling_enabled=request.sampling_enabled,
        )


class McpToolSummary(McpBaseModel):
    id: str
    server_id: str
    server_name: str
    raw_name: str
    model_name: str
    display_name: str | None = None
    description: str | None = None
    enabled: bool
    hidden: bool
    effective_state: McpToolEffectiveState
    approval_mode: McpApprovalMode
    annotations: dict[str, Any] | None = None
    last_used_at: str | None = None


class McpRuntimeSnapshotSummary(McpBaseModel):
    snapshot_id: str
    session_id: str
    turn_id: str | None = None
    servers_total: int
    servers_online: int
    tools_visible: int
    tools_disabled_for_session: int
    pending_approvals: int
    created_at: str


class McpToolEventMetadata(McpBaseModel):
    kind: str = "mcp_tool"
    server_id: str
    server_name: str
    raw_tool_name: str
    model_tool_name: str
    snapshot_id: str | None = None


class McpErrorPayload(McpBaseModel):
    code: McpErrorCode
    message: str
    detail: dict[str, Any] = Field(default_factory=dict)
