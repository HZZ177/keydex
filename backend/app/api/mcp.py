from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel, Field

from backend.app.api.dependencies import get_repositories
from backend.app.command_approval import (
    ApprovalService,
    CommandApprovalDecision,
    CommandApprovalError,
    approval_to_payload,
    load_command_settings,
)
from backend.app.core.config import AppSettings, get_settings
from backend.app.core.ids import new_id
from backend.app.mcp.audit import McpAuditWriter, redact_sensitive_data, redact_sensitive_text
from backend.app.mcp.errors import McpClientAuthError, McpRuntimeError
from backend.app.mcp.import_export import (
    McpImportExportError,
    apply_mcp_import,
    export_mcp_config,
    preview_mcp_import,
)
from backend.app.mcp.oauth import (
    InMemoryMcpOAuthSecretStore,
    McpOAuthService,
    config_from_server_oauth,
)
from backend.app.mcp.service import (
    McpServiceError,
    apply_mcp_tool_bulk_policy,
    clear_mcp_session_tool_override,
    create_mcp_server,
    delete_mcp_server,
    get_mcp_runtime_status,
    get_mcp_server,
    list_mcp_servers,
    list_mcp_tools,
    refresh_all_mcp_servers,
    refresh_mcp_server,
    set_mcp_server_enabled,
    set_mcp_session_tool_override,
    test_mcp_server_connection,
    test_mcp_server_connection_config,
    update_mcp_server,
    update_mcp_tool_policy,
)
from backend.app.mcp.types import (
    McpErrorCode,
    McpServerCreateRequest,
    McpServerUpdateRequest,
)
from backend.app.storage import StorageRepositories

router = APIRouter(prefix="/api/mcp", tags=["mcp"])
RepositoriesDep = Depends(get_repositories)
SettingsDep = Depends(get_settings)


class McpOAuthStartRequest(BaseModel):
    redirect_uri: str | None = Field(default=None, min_length=1)


class McpOAuthCallbackRequest(BaseModel):
    state: str = Field(min_length=1)
    code: str = Field(min_length=1)


class McpOAuthStartResponse(BaseModel):
    server_id: str
    auth_url: str
    state: str


class McpOAuthStatusResponse(BaseModel):
    server_id: str
    status: str
    token_configured: bool
    account_label: str | None = None
    scopes: list[Any] = []
    expires_at: str | None = None


class ResolveMcpApprovalRequest(CommandApprovalDecision):
    user_id: str | None = None


class ToggleMcpServerRequest(BaseModel):
    enabled: bool


class TestMcpServerConnectionRequest(BaseModel):
    server: McpServerCreateRequest
    base_server_id: str | None = None


class UpdateMcpToolPolicyRequest(BaseModel):
    enabled: bool | None = None
    hidden: bool | None = None
    approval_mode: str | None = Field(
        default=None,
        pattern="^(inherit|auto|prompt|approve|deny)$",
    )
    parameter_constraints: dict[str, Any] | None = None
    schema_change_action: str | None = Field(
        default=None,
        pattern="^(keep_enabled|require_review|disable)$",
    )


class BulkMcpToolPolicyRequest(BaseModel):
    action: str = Field(
        pattern="^(enable_selected|disable_selected|keep_selected_only|prompt_all)$"
    )
    tool_ids: list[str] = Field(default_factory=list)
    raw_tool_names: list[str] = Field(default_factory=list)


class SetMcpSessionToolOverrideRequest(BaseModel):
    enabled: bool
    server_id: str | None = None
    reason: str | None = None


class McpImportRequest(BaseModel):
    source_type: str = Field(pattern="^keydex$")
    config: dict[str, Any]
    confirm: bool = False
    conflict_strategy: str = Field(default="skip", pattern="^(skip|rename|error)$")


class McpExportRequest(BaseModel):
    include_trust_rules: bool = False
    server_ids: list[str] | None = None


class McpTrustRuleRequest(BaseModel):
    rule_kind: str = Field(pattern="^(tool|tool_with_params|deny_tool)$")
    scope: str = Field(pattern="^(session|global)$")
    approval_mode: str = Field(pattern="^(approve|deny)$")
    server_id: str | None = None
    raw_tool_name: str | None = None
    session_id: str | None = None
    condition: dict[str, Any] | None = None
    expires_at: str | None = None


@router.get("/servers", response_model=dict[str, Any])
def list_servers(
    enabled: bool | None = None,
    transport: str | None = None,
    limit: int = 100,
    offset: int = 0,
    repositories: StorageRepositories = RepositoriesDep,
) -> dict[str, Any]:
    try:
        return list_mcp_servers(
            repositories,
            enabled=enabled,
            transport=transport,
            limit=limit,
            offset=offset,
        )
    except ValueError as exc:
        error = McpServiceError(str(exc), code="invalid_server_filter")
        raise _mcp_service_http_error(error) from exc


@router.post("/servers", response_model=dict[str, Any])
async def create_server(
    payload: McpServerCreateRequest,
    request: Request,
    repositories: StorageRepositories = RepositoriesDep,
) -> dict[str, Any]:
    try:
        created = create_mcp_server(repositories, payload)
    except ValueError as exc:
        raise _mcp_service_http_error(McpServiceError(str(exc), code="invalid_server")) from exc
    await _mcp_manager(request).sync_auto_refresh_tasks()
    return created


@router.post("/servers/refresh", response_model=dict[str, Any])
async def refresh_servers(request: Request) -> dict[str, Any]:
    return await refresh_all_mcp_servers(_mcp_manager(request))


@router.get("/servers/{server_id}", response_model=dict[str, Any])
def get_server(
    server_id: str,
    repositories: StorageRepositories = RepositoriesDep,
) -> dict[str, Any]:
    try:
        return get_mcp_server(repositories, server_id)
    except McpServiceError as exc:
        raise _mcp_service_http_error(exc) from exc


@router.patch("/servers/{server_id}", response_model=dict[str, Any])
async def update_server(
    server_id: str,
    payload: McpServerUpdateRequest,
    request: Request,
    repositories: StorageRepositories = RepositoriesDep,
) -> dict[str, Any]:
    try:
        updated = update_mcp_server(repositories, server_id, payload)
    except (McpServiceError, ValueError) as exc:
        error = exc if isinstance(exc, McpServiceError) else McpServiceError(str(exc))
        raise _mcp_service_http_error(error) from exc
    manager = _mcp_manager(request)
    await manager.drop_client(server_id)
    await manager.sync_auto_refresh_tasks()
    return updated


@router.delete("/servers/{server_id}", response_model=dict[str, Any])
async def delete_server(
    server_id: str,
    request: Request,
    repositories: StorageRepositories = RepositoriesDep,
) -> dict[str, Any]:
    manager = _mcp_manager(request)
    await manager.drop_client(server_id)
    try:
        deleted = delete_mcp_server(repositories, server_id)
    except McpServiceError as exc:
        raise _mcp_service_http_error(exc) from exc
    await manager.sync_auto_refresh_tasks()
    return deleted


@router.post("/servers/{server_id}/toggle", response_model=dict[str, Any])
async def toggle_server(
    server_id: str,
    payload: ToggleMcpServerRequest,
    request: Request,
    repositories: StorageRepositories = RepositoriesDep,
) -> dict[str, Any]:
    try:
        toggled = set_mcp_server_enabled(repositories, server_id, payload.enabled)
    except McpServiceError as exc:
        raise _mcp_service_http_error(exc) from exc
    manager = _mcp_manager(request)
    await manager.drop_client(server_id)
    await manager.sync_auto_refresh_tasks()
    return toggled


@router.post("/servers/{server_id}/test", response_model=dict[str, Any])
async def test_server(server_id: str, request: Request) -> dict[str, Any]:
    try:
        return await test_mcp_server_connection(_mcp_manager(request), server_id)
    except McpServiceError as exc:
        raise _mcp_service_http_error(exc) from exc


@router.post("/servers/test", response_model=dict[str, Any])
async def test_server_config(
    payload: TestMcpServerConnectionRequest,
    request: Request,
) -> dict[str, Any]:
    try:
        return await test_mcp_server_connection_config(
            _mcp_manager(request),
            payload.server,
            base_server_id=payload.base_server_id,
        )
    except McpServiceError as exc:
        raise _mcp_service_http_error(exc) from exc


@router.post("/servers/{server_id}/refresh", response_model=dict[str, Any])
async def refresh_server(server_id: str, request: Request) -> dict[str, Any]:
    return await refresh_mcp_server(_mcp_manager(request), server_id)


@router.get("/servers/{server_id}/tools", response_model=dict[str, Any])
def list_tools(
    server_id: str,
    status: str | None = None,
    enabled: bool | None = None,
    search: str | None = None,
    limit: int = 500,
    repositories: StorageRepositories = RepositoriesDep,
) -> dict[str, Any]:
    try:
        return list_mcp_tools(
            repositories,
            server_id,
            status=status,
            enabled=enabled,
            search=search,
            limit=limit,
        )
    except (McpServiceError, ValueError) as exc:
        error = exc if isinstance(exc, McpServiceError) else McpServiceError(str(exc))
        raise _mcp_service_http_error(error) from exc


@router.post("/servers/{server_id}/tools/bulk-policy", response_model=dict[str, Any])
def bulk_tool_policy(
    server_id: str,
    payload: BulkMcpToolPolicyRequest,
    repositories: StorageRepositories = RepositoriesDep,
) -> dict[str, Any]:
    try:
        return apply_mcp_tool_bulk_policy(
            repositories,
            server_id,
            action=payload.action,
            tool_ids=payload.tool_ids,
            raw_tool_names=payload.raw_tool_names,
        )
    except (McpServiceError, ValueError) as exc:
        error = exc if isinstance(exc, McpServiceError) else McpServiceError(str(exc))
        raise _mcp_service_http_error(error) from exc


@router.patch("/servers/{server_id}/tools/{tool_id}/policy", response_model=dict[str, Any])
def patch_tool_policy(
    server_id: str,
    tool_id: str,
    payload: UpdateMcpToolPolicyRequest,
    repositories: StorageRepositories = RepositoriesDep,
) -> dict[str, Any]:
    try:
        return update_mcp_tool_policy(
            repositories,
            server_id,
            tool_id,
            payload.model_dump(mode="json", exclude_unset=True),
        )
    except (McpServiceError, ValueError) as exc:
        error = exc if isinstance(exc, McpServiceError) else McpServiceError(str(exc))
        raise _mcp_service_http_error(error) from exc


@router.get("/runtime/status", response_model=dict[str, Any])
def runtime_status(session_id: str, request: Request) -> dict[str, Any]:
    return get_mcp_runtime_status(_mcp_manager(request), session_id=session_id)


@router.put(
    "/runtime/sessions/{session_id}/tools/{tool_id}/override",
    response_model=dict[str, Any],
)
def put_session_tool_override(
    session_id: str,
    tool_id: str,
    payload: SetMcpSessionToolOverrideRequest,
    request: Request,
) -> dict[str, Any]:
    try:
        return set_mcp_session_tool_override(
            _mcp_manager(request),
            session_id=session_id,
            server_id=payload.server_id,
            tool_id=tool_id,
            enabled=payload.enabled,
            reason=payload.reason,
        )
    except McpServiceError as exc:
        raise _mcp_service_http_error(exc) from exc


@router.delete(
    "/runtime/sessions/{session_id}/tools/{tool_id}/override",
    response_model=dict[str, Any],
)
def delete_session_tool_override(
    session_id: str,
    tool_id: str,
    request: Request,
    server_id: str | None = None,
) -> dict[str, Any]:
    try:
        return clear_mcp_session_tool_override(
            _mcp_manager(request),
            session_id=session_id,
            server_id=server_id,
            tool_id=tool_id,
        )
    except McpServiceError as exc:
        raise _mcp_service_http_error(exc) from exc


@router.post("/runtime/calls/{call_id}/cancel", response_model=dict[str, Any])
async def cancel_runtime_call(call_id: str, request: Request) -> dict[str, Any]:
    return await _mcp_manager(request).cancel_call(call_id)


@router.post("/import", response_model=dict[str, Any])
def import_config(
    payload: McpImportRequest,
    repositories: StorageRepositories = RepositoriesDep,
) -> dict[str, Any]:
    try:
        if payload.confirm:
            return apply_mcp_import(
                repositories,
                source_type=payload.source_type,
                config=payload.config,
                conflict_strategy=payload.conflict_strategy,
            )
        return preview_mcp_import(
            repositories,
            source_type=payload.source_type,
            config=payload.config,
            conflict_strategy=payload.conflict_strategy,
        )
    except McpImportExportError as exc:
        raise _mcp_import_export_http_error(exc) from exc


@router.post("/export", response_model=dict[str, Any])
def export_config(
    payload: McpExportRequest,
    repositories: StorageRepositories = RepositoriesDep,
) -> dict[str, Any]:
    try:
        return export_mcp_config(
            repositories,
            include_trust_rules=payload.include_trust_rules,
            server_ids=payload.server_ids,
        )
    except McpImportExportError as exc:
        raise _mcp_import_export_http_error(exc) from exc


@router.get("/audit", response_model=dict[str, Any])
def list_audit(
    server_id: str | None = None,
    session_id: str | None = None,
    event_type: str | None = None,
    status: str | None = None,
    limit: int = 100,
    offset: int = 0,
    repositories: StorageRepositories = RepositoriesDep,
) -> dict[str, Any]:
    records, total = repositories.mcp_audit_log.list(
        server_id=server_id,
        session_id=session_id,
        event_type=event_type,
        status=status,
        limit=limit,
        offset=offset,
    )
    return {
        "list": [_audit_payload(record) for record in records],
        "total": total,
        "limit": max(1, min(limit, 500)),
        "offset": max(0, offset),
    }


@router.get("/trust-rules", response_model=dict[str, Any])
def list_trust_rules(
    server_id: str | None = None,
    scope: str | None = None,
    session_id: str | None = None,
    limit: int = 200,
    repositories: StorageRepositories = RepositoriesDep,
) -> dict[str, Any]:
    try:
        rules = repositories.mcp_trust_rules.list(
            server_id=server_id,
            scope=scope,
            session_id=session_id,
            limit=limit,
        )
    except ValueError as exc:
        raise _mcp_service_http_error(
            McpServiceError(str(exc), code="invalid_trust_rule_filter")
        ) from exc
    return {"list": [_trust_rule_payload(rule) for rule in rules]}


@router.post("/trust-rules", response_model=dict[str, Any])
def create_trust_rule(
    payload: McpTrustRuleRequest,
    repositories: StorageRepositories = RepositoriesDep,
) -> dict[str, Any]:
    _validate_trust_rule_payload(payload)
    try:
        rule = repositories.mcp_trust_rules.create(
            rule_id=new_id(),
            rule_kind=payload.rule_kind,
            scope=payload.scope,
            approval_mode=payload.approval_mode,
            server_id=payload.server_id,
            raw_tool_name=payload.raw_tool_name,
            session_id=payload.session_id,
            condition=payload.condition,
            expires_at=payload.expires_at,
        )
    except ValueError as exc:
        raise _mcp_service_http_error(McpServiceError(str(exc), code="invalid_trust_rule")) from exc
    McpAuditWriter.from_repositories(repositories).append_event(
        event_type="trust.created",
        server_id=rule.server_id,
        raw_tool_name=rule.raw_tool_name,
        session_id=rule.session_id,
        status="ok",
        summary=f"创建 MCP trust rule: {rule.rule_kind}",
        detail=_trust_rule_payload(rule),
    )
    return _trust_rule_payload(rule)


@router.delete("/trust-rules/{rule_id}", response_model=dict[str, Any])
def delete_trust_rule(
    rule_id: str,
    repositories: StorageRepositories = RepositoriesDep,
) -> dict[str, Any]:
    rule = repositories.mcp_trust_rules.get(rule_id)
    deleted = repositories.mcp_trust_rules.delete(rule_id)
    if not deleted:
        raise _mcp_service_http_error(
            McpServiceError("MCP trust rule 不存在", code="trust_rule_not_found")
        )
    if rule is not None:
        McpAuditWriter.from_repositories(repositories).append_event(
            event_type="trust.deleted",
            server_id=rule.server_id,
            raw_tool_name=rule.raw_tool_name,
            session_id=rule.session_id,
            status="ok",
            summary=f"删除 MCP trust rule: {rule.rule_kind}",
            detail=_trust_rule_payload(rule),
        )
    return {"deleted": True, "rule_id": rule_id}


@router.post("/approvals/{approval_id}/decision", response_model=dict[str, Any])
async def resolve_mcp_approval(
    approval_id: str,
    payload: ResolveMcpApprovalRequest,
    request: Request,
    repositories: StorageRepositories = RepositoriesDep,
    settings: AppSettings = SettingsDep,
) -> dict[str, Any]:
    record = repositories.command_approvals.get(approval_id)
    if record is None:
        raise _mcp_approval_not_found()
    if record.kind not in {"mcp_tool_call", "mcp_sampling"}:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "invalid_mcp_approval",
                "message": "该审批不是 MCP 工具调用或 Sampling 审批",
                "details": {"approval_id": approval_id, "kind": record.kind},
            },
        )
    try:
        resolved = await ApprovalService(repositories=repositories).resolve(
            approval_id,
            CommandApprovalDecision(
                decision=payload.decision,
                trust_scope=payload.trust_scope,
                rule_match_type=payload.rule_match_type,
                reject_message=payload.reject_message,
            ),
            settings=load_command_settings(repositories),
            user_id=payload.user_id or settings.default_user_id,
        )
    except CommandApprovalError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={"code": "invalid_mcp_approval_decision", "message": str(exc), "details": {}},
        ) from exc
    approval = approval_to_payload(resolved)
    stream_manager = getattr(request.app.state, "chat_stream_manager", None)
    if stream_manager is not None:
        await stream_manager.broadcast(
            session_id=resolved.session_id,
            action="approval_resolved",
            data={
                "id": resolved.id,
                "approval_id": resolved.id,
                "session_id": resolved.session_id,
                "approval": approval,
            },
        )
    return approval


@router.post(
    "/servers/{server_id}/oauth/start",
    response_model=McpOAuthStartResponse,
)
def start_oauth_authorization(
    server_id: str,
    payload: McpOAuthStartRequest,
    request: Request,
    repositories: StorageRepositories = RepositoriesDep,
) -> McpOAuthStartResponse:
    config = _server_oauth_config(
        repositories,
        server_id=server_id,
        redirect_uri=payload.redirect_uri,
    )
    started = _oauth_service(request).start_authorization(server_id=server_id, config=config)
    return McpOAuthStartResponse(
        server_id=started.server_id,
        auth_url=started.auth_url,
        state=started.state,
    )


@router.post(
    "/servers/{server_id}/oauth/callback",
    response_model=McpOAuthStatusResponse,
)
async def complete_oauth_authorization(
    server_id: str,
    payload: McpOAuthCallbackRequest,
    request: Request,
) -> McpOAuthStatusResponse:
    try:
        oauth_status = await _oauth_service(request).handle_callback(
            server_id=server_id,
            state=payload.state,
            code=payload.code,
        )
    except McpRuntimeError as exc:
        raise _mcp_runtime_http_error(exc) from exc
    return McpOAuthStatusResponse(**oauth_status.to_dict())


@router.get(
    "/servers/{server_id}/oauth/status",
    response_model=McpOAuthStatusResponse,
)
def get_oauth_status(
    server_id: str,
    request: Request,
    repositories: StorageRepositories = RepositoriesDep,
) -> McpOAuthStatusResponse:
    _require_server(repositories, server_id)
    oauth_status = _oauth_service(request).get_status(server_id)
    return McpOAuthStatusResponse(**oauth_status.to_dict())


@router.delete(
    "/servers/{server_id}/oauth",
    response_model=McpOAuthStatusResponse,
)
def clear_oauth_authorization(
    server_id: str,
    request: Request,
    repositories: StorageRepositories = RepositoriesDep,
) -> McpOAuthStatusResponse:
    _require_server(repositories, server_id)
    oauth_status = _oauth_service(request).clear_authorization(server_id)
    return McpOAuthStatusResponse(**oauth_status.to_dict())


def _oauth_service(request: Request) -> McpOAuthService:
    service = getattr(request.app.state, "mcp_oauth_service", None)
    if isinstance(service, McpOAuthService):
        return service
    secret_store = InMemoryMcpOAuthSecretStore()
    service = McpOAuthService(request.app.state.repositories, secret_store=secret_store)
    request.app.state.mcp_oauth_secret_store = secret_store
    request.app.state.mcp_oauth_service = service
    return service


def _mcp_manager(request: Request):
    return request.app.state.mcp_manager


def _server_oauth_config(
    repositories: StorageRepositories,
    *,
    server_id: str,
    redirect_uri: str | None = None,
):
    server = _require_server(repositories, server_id)
    oauth_config = dict(server.oauth_config or {})
    if redirect_uri is not None:
        oauth_config["redirect_uri"] = redirect_uri
    scopes = [str(scope) for scope in server.oauth_scopes or []]
    try:
        return config_from_server_oauth(
            oauth_config,
            resource=server.oauth_resource,
            scopes=scopes,
        )
    except McpClientAuthError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "mcp_oauth_config_invalid",
                "message": str(exc),
                "details": {"server_id": server_id},
            },
        ) from exc


def _require_server(repositories: StorageRepositories, server_id: str):
    server = repositories.mcp_servers.get(server_id)
    if server is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "code": McpErrorCode.SERVER_NOT_FOUND.value,
                "message": "MCP server was not found.",
                "details": {"server_id": server_id},
            },
        )
    return server


def _mcp_approval_not_found() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail={"code": "mcp_approval_not_found", "message": "MCP 审批请求不存在", "details": {}},
    )


def _validate_trust_rule_payload(payload: McpTrustRuleRequest) -> None:
    if payload.scope == "global" and not payload.server_id:
        raise _mcp_service_http_error(
            McpServiceError("全局 MCP trust rule 必须绑定 server", code="invalid_trust_rule")
        )
    if payload.scope == "session" and not payload.session_id:
        raise _mcp_service_http_error(
            McpServiceError("会话 MCP trust rule 必须绑定 session", code="invalid_trust_rule")
        )
    if payload.rule_kind in {"tool", "tool_with_params", "deny_tool"} and not payload.raw_tool_name:
        raise _mcp_service_http_error(
            McpServiceError(
                "Tool 类 MCP trust rule 必须绑定 raw_tool_name",
                code="invalid_trust_rule",
            )
        )


def _trust_rule_payload(rule: Any) -> dict[str, Any]:
    return {
        "id": rule.id,
        "rule_kind": rule.rule_kind,
        "scope": rule.scope,
        "approval_mode": rule.approval_mode,
        "hit_count": rule.hit_count,
        "created_at": rule.created_at,
        "updated_at": rule.updated_at,
        "server_id": rule.server_id,
        "raw_tool_name": rule.raw_tool_name,
        "session_id": rule.session_id,
        "condition": rule.condition,
        "created_from_approval_id": rule.created_from_approval_id,
        "expires_at": rule.expires_at,
        "last_hit_at": rule.last_hit_at,
    }


def _audit_payload(record: Any) -> dict[str, Any]:
    detail = (
        redact_sensitive_data(record.detail)
        if isinstance(record.detail, dict)
        else record.detail
    )
    summary = (
        redact_sensitive_text(record.summary)
        if record.summary is not None
        else None
    )
    return {
        "id": record.id,
        "event_type": record.event_type,
        "server_id": record.server_id,
        "raw_tool_name": record.raw_tool_name,
        "session_id": record.session_id,
        "turn_id": record.turn_id,
        "call_id": record.call_id,
        "approval_id": record.approval_id,
        "actor": record.actor,
        "status": record.status,
        "duration_ms": record.duration_ms,
        "summary": summary,
        "detail": detail,
        "created_at": record.created_at,
    }


def _mcp_service_http_error(exc: McpServiceError) -> HTTPException:
    not_found_codes = {
        "server_not_found",
        "tool_not_found",
        "trust_rule_not_found",
    }
    status_code = (
        status.HTTP_404_NOT_FOUND
        if exc.code in not_found_codes
        else status.HTTP_400_BAD_REQUEST
    )
    return HTTPException(
        status_code=status_code,
        detail={"code": exc.code, "message": str(exc), "details": {}},
    )


def _mcp_import_export_http_error(exc: McpImportExportError) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail={"code": exc.code, "message": str(exc), "details": {}},
    )


def _mcp_runtime_http_error(exc: McpRuntimeError) -> HTTPException:
    status_code = {
        McpErrorCode.AUTH_REQUIRED: status.HTTP_401_UNAUTHORIZED,
        McpErrorCode.SERVER_NOT_FOUND: status.HTTP_404_NOT_FOUND,
        McpErrorCode.TOOL_NOT_FOUND: status.HTTP_404_NOT_FOUND,
        McpErrorCode.VALIDATION_ERROR: status.HTTP_400_BAD_REQUEST,
    }.get(exc.code, status.HTTP_400_BAD_REQUEST)
    payload = exc.to_payload().model_dump(mode="json")
    return HTTPException(status_code=status_code, detail=payload)
