from __future__ import annotations

import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, ConfigDict, Field, field_validator

from backend.app.api.dependencies import get_repositories
from backend.app.command_approval import approval_to_payload, load_command_settings
from backend.app.core.config import AppSettings, get_settings
from backend.app.core.ids import new_id
from backend.app.core.logger import logger
from backend.app.services.agent_runtime import AgentRuntimeInitializationError
from backend.app.services.file_change_hub import FileChange, FileChangeHub
from backend.app.services.file_history_service import (
    FileClassification,
    FileHistoryError,
    FileHistoryErrorCode,
    FileHistoryService,
    FileOperationStatus,
    FileRestoreDecision,
    FileRestoreMode,
)
from backend.app.services.file_resources import FileResourceIdentity
from backend.app.services.manual_context_compression_service import (
    ManualContextCompressionResult,
    ManualContextCompressionService,
)
from backend.app.services.session_fork_service import (
    SessionForkService,
    SessionForkServiceError,
)
from backend.app.services.session_reverse_service import (
    SessionReverseExecution,
    SessionReverseService,
)
from backend.app.services.session_service import (
    GetHistoryRequest,
    ListSessionsRequest,
    SessionArchivedError,
    SessionNotFoundError,
    SessionService,
    SessionValidationError,
)
from backend.app.services.workspace_service import (
    WorkspaceService,
    WorkspaceServiceError,
)
from backend.app.storage import StorageRepositories

router = APIRouter(prefix="/api/sessions", tags=["sessions"])
RepositoriesDep = Depends(get_repositories)
SettingsDep = Depends(get_settings)


class CreateSessionRequest(BaseModel):
    user_id: str | None = None
    scene_id: str | None = None
    title: str | None = None
    session_tag: str = "chat"
    session_id: str | None = None
    session_type: str = "chat"
    workspace_id: str | None = None
    cwd: str | None = None
    workspace_roots: list[str] | None = None
    current_model_provider_id: str | None = None
    current_model: str | None = None


class UpdateSessionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str | None = None
    pinned: bool | None = None
    current_model_provider_id: str | None = None
    current_model: str | None = None


class SessionBranchRequest(BaseModel):
    user_id: str | None = None
    title: str | None = None
    session_tag: str | None = None
    checkpoint_id: str | None = None
    checkpoint_ns: str | None = None
    trace_id: str | None = None
    message_event_id: str | None = None
    turn_index: int | None = None


class SessionReversePreviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    message_event_id: str = Field(min_length=1)


class SessionReverseRequest(BaseModel):
    """Execute contract plus a temporary conversation-only compatibility shape."""

    model_config = ConfigDict(extra="forbid")

    message_event_id: str | None = None
    operation_id: str | None = None
    mode: FileRestoreMode = FileRestoreMode.CONVERSATION
    decision: FileRestoreDecision = FileRestoreDecision.FULL
    preview_token: str | None = None
    request_id: str = Field(default_factory=new_id, min_length=1)
    user_id: str | None = None
    title: str | None = None
    checkpoint_id: str | None = None
    checkpoint_ns: str | None = None
    trace_id: str | None = None
    turn_index: int | None = None
    confirm_external_paths: bool = False


class SessionReverseFileResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    path: str
    current_state: str
    target_state: str
    classification: FileClassification
    reason_code: str | None = None
    current_hash: str | None = None
    target_hash: str | None = None
    writer_session_id: str | None = None
    binary: bool = False
    truncated: bool = False
    insertions: int = 0
    deletions: int = 0
    diff: str | None = None
    raw_patch: str | None = None
    status: str = "unknown"
    content_kind: str = "text"
    binary_reason: str | None = None
    truncation_state: str = "complete"
    truncation_reason: str | None = None
    can_load_more: bool = False
    patch_direction: str = "current_to_target"
    patch_precision: str = "exact"
    patch_complete: bool = True
    resource_id: str
    scope_kind: str
    scope_identity: str
    scope_label: str
    display_path: str
    absolute_path: str
    requires_full_access: bool = False

    @field_validator("path")
    @classmethod
    def reject_private_path(cls, value: str) -> str:
        normalized = value.replace("\\", "/")
        if not normalized or normalized.startswith("/") or ":/" in normalized:
            raise ValueError("reverse file path must be workspace-relative")
        if ".." in normalized.split("/"):
            raise ValueError("reverse file path must not traverse parents")
        return normalized


class SessionReversePreviewResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    operation_id: str
    source: dict[str, Any]
    conversation_available: bool
    code_available: bool
    default_mode: FileRestoreMode
    snapshot_id: str | None = None
    preview_token: str
    files: list[SessionReverseFileResponse] = Field(default_factory=list)
    insertions: int = 0
    deletions: int = 0
    warnings: list[str] = Field(default_factory=list)
    requires_external_confirmation: bool = False
    external_paths: list[str] = Field(default_factory=list)


class SessionReverseResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    operation_id: str
    status: FileOperationStatus
    mode: FileRestoreMode
    decision: FileRestoreDecision
    conversation_rewound: bool
    restored_files: list[str] = Field(default_factory=list)
    skipped_files: list[str] = Field(default_factory=list)
    forced_files: list[str] = Field(default_factory=list)
    failed_files: list[str] = Field(default_factory=list)
    restored_input: str | None = None
    source: dict[str, Any] = Field(default_factory=dict)
    error_code: str | None = None


class SessionReverseStatusResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    operation_id: str
    status: FileOperationStatus
    result: SessionReverseResponse | None = None
    error_code: str | None = None
    blocked_paths: list[str] = Field(default_factory=list)


@router.post(
    "/{session_id}/reverse/preview",
    response_model=SessionReversePreviewResponse,
)
def preview_session_reverse(
    session_id: str,
    payload: SessionReversePreviewRequest,
    request: Request,
    repositories: StorageRepositories = RepositoriesDep,
    settings: AppSettings = SettingsDep,
) -> SessionReversePreviewResponse:
    session = repositories.sessions.get(session_id)
    if session is None:
        raise _bad_request("session_not_found", "session 不存在", status.HTTP_404_NOT_FOUND)
    if session.session_type != "workspace":
        raise _bad_request("session_not_workspace", "纯聊天会话没有文件回溯能力")
    try:
        workspace = WorkspaceService(repositories.workspaces).runtime_context_for_session(session)
        history = _file_history_service(request, repositories, settings)
        history.assert_preview_available(session_id)
        source = _fork_service(repositories).resolve_reverse_source(
            session_id=session_id,
            message_event_id=payload.message_event_id,
        )
        preview = history.create_preview(
            session_id=session_id,
            active_session_id=session.active_session_id or session.id,
            message_event_id=payload.message_event_id,
            workspace_root=workspace.cwd,
            source=source.to_dict(),
            file_access_mode=load_command_settings(repositories).file_access_mode,
        )
        return SessionReversePreviewResponse(**preview.to_dict())
    except FileHistoryError as exc:
        raise _file_history_error(exc) from exc
    except SessionForkServiceError as exc:
        raise _branch_error(exc) from exc
    except WorkspaceServiceError as exc:
        raise _workspace_error(exc) from exc


class SessionContextCompressionRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SessionResponse(BaseModel):
    session: dict[str, Any]


class SessionContextCompressionResponse(BaseModel):
    success: bool
    session_id: str
    active_session_id: str | None = None
    notice_id: str | None = None
    reason: str | None = None
    context_compression_epoch: int | None = None
    compression_message_count: int = 0
    total_message_count: int = 0


class SessionBranchResponse(BaseModel):
    session: dict[str, Any]
    source: dict[str, Any]


class SessionListResponse(BaseModel):
    list: list[dict[str, Any]]
    total: int
    page: int
    page_size: int


class SessionGroupedResponse(BaseModel):
    groups: list[dict[str, Any]]
    total: int


class SessionHistoryResponse(BaseModel):
    list: list[dict[str, Any]]
    total: int
    page: int
    page_size: int
    session: dict[str, Any]
    event_total: int
    pending_inputs: list[dict[str, Any]] = Field(default_factory=list)
    pending_approvals: list[dict[str, Any]] = Field(default_factory=list)
    turn_indexes: list[int] = Field(default_factory=list)
    next_cursor: str | None = None
    prev_cursor: str | None = None
    has_more_older: bool = False


class ToolDetailResponse(BaseModel):
    detail: dict[str, Any]


@router.post("", response_model=SessionResponse)
def create_session(
    payload: CreateSessionRequest,
    repositories: StorageRepositories = RepositoriesDep,
    settings: AppSettings = SettingsDep,
) -> SessionResponse:
    service = _service(repositories)
    try:
        session = service.create_session(
            session_id=payload.session_id,
            user_id=payload.user_id or settings.default_user_id,
            scene_id=payload.scene_id or settings.default_scene_id,
            title=payload.title,
            session_tag=payload.session_tag,
            session_type=payload.session_type,
            workspace_id=payload.workspace_id,
            cwd=payload.cwd,
            workspace_roots=payload.workspace_roots,
            current_model_provider_id=payload.current_model_provider_id,
            current_model=payload.current_model,
        )
    except WorkspaceServiceError as exc:
        raise _workspace_error(exc) from exc
    except SessionValidationError as exc:
        raise _bad_request("invalid_session_create", str(exc)) from exc
    return SessionResponse(session=session)


@router.get("", response_model=SessionListResponse)
def list_sessions(
    user_id: str | None = None,
    scene_id: str | None = None,
    status_filter: str | None = Query(default=None, alias="status"),
    session_tag: str | None = "chat",
    workspace_id: str | None = None,
    session_type: str | None = None,
    title: str | None = None,
    current_session_id: str | None = None,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
    repositories: StorageRepositories = RepositoriesDep,
) -> SessionListResponse:
    result = _service(repositories).list_sessions(
        ListSessionsRequest(
            user_id=user_id,
            scene_id=scene_id,
            status=status_filter,
            session_tag=session_tag,
            workspace_id=workspace_id,
            session_type=session_type,
            title=title,
            current_session_id=current_session_id,
            page=page,
            page_size=page_size,
        )
    )
    logger.debug(
        "[SessionsAPI] 查询会话列表 | "
        f"user_id={user_id or ''} | scene_id={scene_id or ''} | "
        f"page={page} | page_size={page_size} | total={result.get('total', 0)}"
    )
    return SessionListResponse(**result)


@router.get("/grouped", response_model=SessionGroupedResponse)
def group_sessions(
    user_id: str | None = None,
    scene_id: str | None = None,
    status_filter: str | None = Query(default=None, alias="status"),
    session_tag: str | None = "chat",
    workspace_id: str | None = None,
    session_type: str | None = None,
    title: str | None = None,
    current_session_id: str | None = None,
    repositories: StorageRepositories = RepositoriesDep,
) -> SessionGroupedResponse:
    result = _service(repositories).group_sessions(
        ListSessionsRequest(
            user_id=user_id,
            scene_id=scene_id,
            status=status_filter,
            session_tag=session_tag,
            workspace_id=workspace_id,
            session_type=session_type,
            title=title,
            current_session_id=current_session_id,
        )
    )
    return SessionGroupedResponse(**result)


@router.get("/{session_id}", response_model=SessionResponse)
def get_session(
    session_id: str,
    current_session_id: str | None = None,
    repositories: StorageRepositories = RepositoriesDep,
) -> SessionResponse:
    try:
        session = _service(repositories).get_session_detail(
            session_id,
            current_session_id=current_session_id,
        )
    except (SessionNotFoundError, SessionArchivedError) as exc:
        raise _session_access_error(exc) from exc
    return SessionResponse(session=session)


@router.patch("/{session_id}", response_model=SessionResponse)
def update_session(
    session_id: str,
    payload: UpdateSessionRequest,
    current_session_id: str | None = None,
    repositories: StorageRepositories = RepositoriesDep,
) -> SessionResponse:
    service = _service(repositories)
    try:
        if "title" in payload.model_fields_set:
            session = service.rename_session(session_id, payload.title or "")
        elif "pinned" in payload.model_fields_set:
            session = service.set_session_pinned(
                session_id,
                pinned=bool(payload.pinned),
                current_session_id=current_session_id,
            )
        elif {"current_model_provider_id", "current_model"} & payload.model_fields_set:
            session = service.update_session_model(
                session_id,
                provider_id=payload.current_model_provider_id or "",
                model=payload.current_model or "",
                current_session_id=current_session_id,
            )
        else:
            session = service.get_session_detail(
                session_id,
                current_session_id=current_session_id,
            )
    except (SessionNotFoundError, SessionArchivedError) as exc:
        raise _session_access_error(exc) from exc
    except SessionValidationError as exc:
        raise _bad_request("invalid_session_patch", str(exc)) from exc
    return SessionResponse(session=session)


@router.post("/{session_id}/fork", response_model=SessionBranchResponse)
def fork_session(
    session_id: str,
    payload: SessionBranchRequest,
    repositories: StorageRepositories = RepositoriesDep,
    settings: AppSettings = SettingsDep,
) -> SessionBranchResponse:
    try:
        result = _fork_service(repositories).fork_session(
            session_id=session_id,
            user_id=payload.user_id or settings.default_user_id,
            title=payload.title,
            session_tag=payload.session_tag,
            checkpoint_id=payload.checkpoint_id,
            checkpoint_ns=payload.checkpoint_ns,
            trace_id=payload.trace_id,
            message_event_id=payload.message_event_id,
            turn_index=payload.turn_index,
        )
    except SessionForkServiceError as exc:
        raise _branch_error(exc) from exc
    session = _service(repositories).get_session_detail(result.session.id)
    return SessionBranchResponse(session=session, source=result.source.to_dict())


@router.post(
    "/{session_id}/reverse",
    response_model=SessionReverseResponse | SessionBranchResponse,
)
async def reverse_session(
    session_id: str,
    payload: SessionReverseRequest,
    request: Request,
    repositories: StorageRepositories = RepositoriesDep,
    settings: AppSettings = SettingsDep,
) -> SessionReverseResponse | SessionBranchResponse:
    if payload.operation_id is None:
        return _legacy_reverse_session(session_id, payload, repositories, settings)
    if not payload.message_event_id or not payload.preview_token:
        raise _bad_request(
            "invalid_reverse_request",
            "文件回溯执行需要 message_event_id、operation_id 和 preview_token",
        )
    reverse_started = time.perf_counter()
    try:
        session = repositories.sessions.get(session_id)
        if session is None:
            raise _bad_request("session_not_found", "session 不存在", status.HTTP_404_NOT_FOUND)
        if session.session_type != "workspace":
            raise _bad_request("session_not_workspace", "纯聊天会话没有文件回溯能力")
        workspace = WorkspaceService(repositories.workspaces).runtime_context_for_session(session)
        history = _file_history_service(request, repositories, settings)
        result = SessionReverseService(
            repositories,
            file_history=history,
        ).execute(
            session_id=session_id,
            workspace_root=workspace.cwd,
            request=SessionReverseExecution(
                operation_id=payload.operation_id,
                preview_token=payload.preview_token,
                request_id=payload.request_id,
                message_event_id=payload.message_event_id,
                mode=payload.mode,
                decision=payload.decision,
                file_access_mode=load_command_settings(repositories).file_access_mode,
                confirm_external_paths=payload.confirm_external_paths,
            ),
        )
    except FileHistoryError as exc:
        await _publish_reverse_failure(
            request,
            repositories,
            workspace_id=session.workspace_id if "session" in locals() else None,
            operation_id=payload.operation_id,
            error=exc,
        )
        logger.warning(
            "[FileHistory] 回溯失败 | "
            f"operation_id={payload.operation_id} | mode={payload.mode} | "
            f"decision={payload.decision} | result=failed | error_code={exc.code} | "
            f"duration_ms={int((time.perf_counter() - reverse_started) * 1000)}"
        )
        raise _file_history_error(exc) from exc
    except SessionForkServiceError as exc:
        raise _branch_error(exc) from exc
    except WorkspaceServiceError as exc:
        raise _workspace_error(exc) from exc
    await _publish_reverse_result(
        request,
        repositories,
        workspace_id=session.workspace_id,
        operation_id=result.operation_id,
    )
    logger.info(
        "[FileHistory] 回溯完成 | "
        f"operation_id={result.operation_id} | mode={result.mode} | "
        f"decision={result.decision} | result={result.status} | "
        f"restored_count={len(result.restored_files)} | "
        f"skipped_count={len(result.skipped_files)} | "
        f"forced_count={len(result.forced_files)} | "
        f"failed_count={len(result.failed_files)} | "
        f"conversation_rewound={result.conversation_rewound} | "
        f"duration_ms={int((time.perf_counter() - reverse_started) * 1000)}"
    )
    return SessionReverseResponse(**result.to_dict())


@router.get(
    "/{session_id}/reverse/{operation_id}",
    response_model=SessionReverseStatusResponse,
)
def get_session_reverse_status(
    session_id: str,
    operation_id: str,
    request: Request,
    repositories: StorageRepositories = RepositoriesDep,
    settings: AppSettings = SettingsDep,
) -> SessionReverseStatusResponse:
    try:
        result = SessionReverseService(
            repositories,
            file_history=_file_history_service(request, repositories, settings),
        ).get_result(session_id=session_id, operation_id=operation_id)
    except FileHistoryError as exc:
        raise _file_history_error(exc) from exc
    blocked_paths: list[str] = []
    if result.status in {
        FileOperationStatus.COMPENSATION_FAILED,
        FileOperationStatus.BLOCKED,
    }:
        blocked_paths = [
            FileResourceIdentity(
                item.scope_kind,
                item.scope_identity,
                item.canonical_path,
            ).resource_id
            for item in repositories.file_history.list_operation_files(operation_id)
            if item.error_code
        ]
        if not blocked_paths:
            blocked_paths = list(result.failed_files)
    return SessionReverseStatusResponse(
        operation_id=result.operation_id,
        status=result.status,
        result=SessionReverseResponse(**result.to_dict()),
        error_code=result.error_code,
        blocked_paths=blocked_paths,
    )


def _legacy_reverse_session(
    session_id: str,
    payload: SessionReverseRequest,
    repositories: StorageRepositories,
    settings: AppSettings,
) -> SessionBranchResponse:
    try:
        result = _fork_service(repositories).reverse_session(
            session_id=session_id,
            user_id=payload.user_id or settings.default_user_id,
            title=payload.title,
            checkpoint_id=payload.checkpoint_id,
            checkpoint_ns=payload.checkpoint_ns,
            trace_id=payload.trace_id,
            message_event_id=payload.message_event_id,
            turn_index=payload.turn_index,
        )
    except SessionForkServiceError as exc:
        raise _branch_error(exc) from exc
    session = _service(repositories).get_session_detail(result.session.id)
    return SessionBranchResponse(session=session, source=result.source.to_dict())


async def _publish_reverse_result(
    request: Request,
    repositories: StorageRepositories,
    *,
    workspace_id: str | None,
    operation_id: str,
) -> None:
    hub = getattr(request.app.state, "file_change_hub", None)
    if not isinstance(hub, FileChangeHub) or not workspace_id:
        return
    changes: list[FileChange] = []
    for item in repositories.file_history.list_operation_files(operation_id):
        if item.result_state not in {"restored", "forced"}:
            continue
        if item.preview_current_state == "missing" and item.target_state == "file":
            kind = "added"
        elif item.target_state == "missing":
            kind = "deleted"
        else:
            kind = "modified"
        changes.append(FileChange(kind=kind, path=item.display_path))
    await hub.publish_operation_changes(workspace_id, operation_id, changes)


async def _publish_reverse_failure(
    request: Request,
    repositories: StorageRepositories,
    *,
    workspace_id: str | None,
    operation_id: str,
    error: FileHistoryError,
) -> None:
    if error.code not in {
        str(FileHistoryErrorCode.COMPENSATED),
        str(FileHistoryErrorCode.COMPENSATION_FAILED),
        str(FileHistoryErrorCode.CONVERSATION_FAILED),
        str(FileHistoryErrorCode.RESTORE_FAILED),
    }:
        return
    hub = getattr(request.app.state, "file_change_hub", None)
    if not isinstance(hub, FileChangeHub) or not workspace_id:
        return
    operation = repositories.file_history.get_operation(operation_id)
    if operation is None or operation.compensation_state == "not_needed":
        return
    await hub.publish_operation_changes(
        workspace_id,
        operation_id,
        phase="compensation",
        resync_required=True,
    )


@router.post("/{session_id}/context-compression", response_model=SessionContextCompressionResponse)
async def compress_session_context(
    session_id: str,
    payload: SessionContextCompressionRequest,
    request: Request,
    repositories: StorageRepositories = RepositoriesDep,
) -> SessionContextCompressionResponse:
    checkpointer = getattr(request.app.state, "checkpointer", None)
    http_transport = getattr(request.app.state, "model_http_transport", None)
    agent_runner = getattr(request.app.state, "agent_runner", None)
    if checkpointer is None or agent_runner is None:
        provider = getattr(request.app.state, "agent_runtime_provider", None)
        if provider is None:
            raise _manual_context_compression_runtime_error("agent_runtime_unavailable")
        try:
            chat_service = await provider.get_chat_service_async()
        except AgentRuntimeInitializationError as exc:
            raise _manual_context_compression_runtime_error(
                "agent_runtime_initialization_failed",
                message=str(exc),
            ) from exc
        agent_runner = getattr(chat_service, "agent_runner", None)
        checkpointer = getattr(agent_runner, "checkpointer", None)
    if agent_runner is not None and callable(getattr(agent_runner, "model_http_transport", None)):
        http_transport = agent_runner.model_http_transport()
    if checkpointer is None:
        raise _manual_context_compression_runtime_error("checkpointer_unavailable")

    stream_manager = getattr(request.app.state, "chat_stream_manager", None)

    async def broadcast(session: str, action: str, data: dict[str, Any]) -> bool:
        if stream_manager is None:
            return False
        return await stream_manager.broadcast(session_id=session, action=action, data=data)

    service = ManualContextCompressionService(
        repositories,
        checkpointer=checkpointer,
        factory=agent_runner.factory,
        http_transport=http_transport,
        broadcaster=broadcast,
    )
    result = await service.compress(session_id=session_id)
    if not result.success:
        raise _manual_context_compression_error(result)
    return SessionContextCompressionResponse(**result.to_dict())


@router.get("/{session_id}/messages", response_model=SessionHistoryResponse)
def get_session_messages(
    session_id: str,
    turn_index: int | None = None,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=5, ge=1, le=100),
    order: str = "desc",
    cursor: str | None = None,
    direction: str = "older",
    all_turns: bool = False,
    repositories: StorageRepositories = RepositoriesDep,
) -> SessionHistoryResponse:
    return _history_response(
        repositories,
        GetHistoryRequest(
            session_id=session_id,
            turn_index=turn_index,
            page=page,
            page_size=page_size,
            order=order,
            cursor=cursor,
            direction=direction,
            all_turns=all_turns,
        ),
    )


@router.get("/{session_id}/history", response_model=SessionHistoryResponse)
def get_session_history(
    session_id: str,
    turn_index: int | None = None,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=5, ge=1, le=100),
    order: str = "desc",
    cursor: str | None = None,
    direction: str = "older",
    all_turns: bool = False,
    repositories: StorageRepositories = RepositoriesDep,
) -> SessionHistoryResponse:
    return _history_response(
        repositories,
        GetHistoryRequest(
            session_id=session_id,
            turn_index=turn_index,
            page=page,
            page_size=page_size,
            order=order,
            cursor=cursor,
            direction=direction,
            all_turns=all_turns,
        ),
    )


@router.get("/{session_id}/tool-details", response_model=ToolDetailResponse)
def get_session_tool_details(
    session_id: str,
    start_event_id: str | None = None,
    end_event_id: str | None = None,
    repositories: StorageRepositories = RepositoriesDep,
) -> ToolDetailResponse:
    try:
        detail = _service(repositories).get_tool_detail(
            session_id,
            start_event_id=start_event_id,
            end_event_id=end_event_id,
        )
    except (SessionNotFoundError, SessionArchivedError) as exc:
        raise _session_access_error(exc) from exc
    except SessionValidationError as exc:
        raise _bad_request("invalid_tool_detail", str(exc)) from exc
    return ToolDetailResponse(detail=detail)


def _history_response(
    repositories: StorageRepositories,
    request: GetHistoryRequest,
) -> SessionHistoryResponse:
    try:
        result = _service(repositories).get_history(request)
    except (SessionNotFoundError, SessionArchivedError) as exc:
        raise _session_access_error(exc) from exc
    if hasattr(repositories, "pending_inputs"):
        result["pending_inputs"] = [
            record.to_dict()
            for record in repositories.pending_inputs.list_active_by_session(request.session_id)
        ]
    if hasattr(repositories, "command_approvals"):
        _reconcile_approval_history(result, repositories)
        result["pending_approvals"] = [
            approval_to_payload(record)
            for record in repositories.command_approvals.list_pending(
                session_id=request.session_id
            )
        ]
    logger.debug(
        "[SessionsAPI] 查询会话历史 | "
        f"session_id={request.session_id} | turn_index={request.turn_index} | "
        f"page={request.page} | page_size={request.page_size} | "
        f"events={result.get('event_total', 0)} | messages={result.get('total', 0)}"
    )
    return SessionHistoryResponse(**result)


def _reconcile_approval_history(
    result: dict[str, Any],
    repositories: StorageRepositories,
) -> None:
    messages = result.get("list")
    session = result.get("session")
    session_id = str(session.get("id") or "") if isinstance(session, dict) else ""
    if not isinstance(messages, list):
        return
    for message in messages:
        if not isinstance(message, dict) or message.get("role") != "approval":
            continue
        approval = message.get("approval")
        if not isinstance(approval, dict):
            continue
        approval_id = str(approval.get("id") or "").strip()
        if not approval_id:
            continue
        record = repositories.command_approvals.get(approval_id)
        if record is None or record.session_id != session_id:
            continue
        payload = approval_to_payload(record)
        message["approval"] = payload
        message["status"] = payload["status"]
        command = str(payload.get("details", {}).get("command") or "").strip()
        if payload["status"] == "approved":
            prefix = "已允许执行命令"
        elif payload["status"] in {"rejected", "cancelled", "expired"}:
            prefix = "已拒绝执行命令"
        else:
            prefix = "等待批准执行命令"
        message["content"] = f"{prefix}: {command}" if command else prefix


def _service(repositories: StorageRepositories) -> SessionService:
    return SessionService(
        repositories.sessions,
        repositories.message_events,
        repositories.workspaces,
        repositories.session_forks,
    )


def _fork_service(repositories: StorageRepositories) -> SessionForkService:
    return SessionForkService(repositories)


def _session_access_error(exc: SessionNotFoundError | SessionArchivedError) -> HTTPException:
    archived = isinstance(exc, SessionArchivedError)
    return HTTPException(
        status_code=status.HTTP_409_CONFLICT if archived else status.HTTP_404_NOT_FOUND,
        detail={
            "code": "session_archived" if archived else "session_not_found",
            "message": str(exc),
            "details": {},
        },
    )


def _bad_request(
    code: str,
    message: str,
    status_code: int = status.HTTP_400_BAD_REQUEST,
) -> HTTPException:
    return HTTPException(
        status_code=status_code,
        detail={"code": code, "message": message, "details": {}},
    )


def _file_history_service(
    request: Request,
    repositories: StorageRepositories,
    settings: AppSettings,
) -> FileHistoryService:
    service = getattr(request.app.state, "file_history_service", None)
    if isinstance(service, FileHistoryService):
        return service
    service = FileHistoryService(repositories, data_dir=settings.data_dir)
    request.app.state.file_history_service = service
    return service


def _file_history_error(exc: FileHistoryError) -> HTTPException:
    return HTTPException(
        status_code=exc.http_status,
        detail={"code": exc.code, "message": str(exc), "details": exc.details},
    )


def _workspace_error(exc: WorkspaceServiceError) -> HTTPException:
    status_code = {
        "workspace_not_found": status.HTTP_404_NOT_FOUND,
        "workspace_archived": status.HTTP_409_CONFLICT,
    }.get(exc.code, status.HTTP_400_BAD_REQUEST)
    return HTTPException(
        status_code=status_code,
        detail={"code": exc.code, "message": exc.message, "details": exc.details},
    )


def _branch_error(exc: SessionForkServiceError) -> HTTPException:
    status_code = {
        "session_not_found": status.HTTP_404_NOT_FOUND,
        "trace_not_found": status.HTTP_404_NOT_FOUND,
        "message_event_not_found": status.HTTP_404_NOT_FOUND,
        "turn_not_found": status.HTTP_404_NOT_FOUND,
        "checkpoint_not_found": status.HTTP_404_NOT_FOUND,
        "latest_checkpoint_missing": status.HTTP_400_BAD_REQUEST,
        "latest_fork_source_missing": status.HTTP_400_BAD_REQUEST,
        "checkpoint_source_ambiguous": status.HTTP_400_BAD_REQUEST,
        "checkpoint_id_empty": status.HTTP_400_BAD_REQUEST,
        "reverse_checkpoint_source_unsupported": status.HTTP_400_BAD_REQUEST,
        "reverse_source_must_be_user_message": status.HTTP_400_BAD_REQUEST,
        "trace_session_mismatch": status.HTTP_400_BAD_REQUEST,
        "trace_not_completed": status.HTTP_400_BAD_REQUEST,
        "trace_checkpoint_missing": status.HTTP_400_BAD_REQUEST,
        "message_event_checkpoint_missing": status.HTTP_400_BAD_REQUEST,
        "turn_checkpoint_missing": status.HTTP_400_BAD_REQUEST,
        "reverse_input_checkpoint_missing": status.HTTP_400_BAD_REQUEST,
        "reverse_before_fork_point": status.HTTP_400_BAD_REQUEST,
        "session_reverse_failed": status.HTTP_400_BAD_REQUEST,
        "fork_message_event_missing": status.HTTP_400_BAD_REQUEST,
        "fork_turn_index_missing": status.HTTP_400_BAD_REQUEST,
        "fork_target_message_missing": status.HTTP_400_BAD_REQUEST,
    }.get(exc.code, status.HTTP_400_BAD_REQUEST)
    return HTTPException(
        status_code=status_code,
        detail={
            "code": exc.code,
            "message": exc.message,
            "details": exc.details,
        },
    )


def _manual_context_compression_runtime_error(
    code: str,
    *,
    message: str | None = None,
) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        detail={
            "code": code,
            "message": message or "主动上下文压缩运行时不可用",
            "details": {},
        },
    )


def _manual_context_compression_error(result: ManualContextCompressionResult) -> HTTPException:
    reason = str(result.reason or "context_compression_failed")
    base_code = reason.split(":", 1)[0]
    status_code = {
        "session_not_found": status.HTTP_404_NOT_FOUND,
        "session_busy": status.HTTP_409_CONFLICT,
        "checkpoint_not_found": status.HTTP_409_CONFLICT,
        "checkpoint_conflict": status.HTTP_409_CONFLICT,
        "checkpoint_replacement_failed": status.HTTP_409_CONFLICT,
        "context_compression_disabled": status.HTTP_409_CONFLICT,
        "model_config_error": status.HTTP_400_BAD_REQUEST,
        "model_create_error": status.HTTP_400_BAD_REQUEST,
        "llm_error": status.HTTP_502_BAD_GATEWAY,
        "tool_call_returned": status.HTTP_502_BAD_GATEWAY,
        "empty_summary_output": status.HTTP_502_BAD_GATEWAY,
        "no_compressible_messages": status.HTTP_400_BAD_REQUEST,
    }.get(base_code, status.HTTP_400_BAD_REQUEST)
    return HTTPException(
        status_code=status_code,
        detail={
            "code": base_code,
            "message": _manual_context_compression_error_message(base_code),
            "details": result.to_dict(),
        },
    )


def _manual_context_compression_error_message(code: str) -> str:
    return {
        "session_not_found": "会话不存在",
        "session_busy": "当前会话正在运行，无法主动压缩上下文",
        "checkpoint_not_found": "当前会话没有可压缩的检查点",
        "checkpoint_conflict": "压缩期间会话上下文已变化，请稍后重试",
        "checkpoint_replacement_failed": "无法写入压缩后的上下文",
        "context_compression_disabled": "上下文压缩未启用",
        "model_config_error": "对话模型配置不可用，无法压缩上下文",
        "model_create_error": "无法创建对话模型，压缩上下文失败",
        "llm_error": "模型压缩上下文失败",
        "tool_call_returned": "模型压缩上下文时返回了工具调用",
        "empty_summary_output": "模型没有返回有效的压缩摘要",
        "no_compressible_messages": "当前会话没有可压缩的上下文",
    }.get(code, "主动上下文压缩失败")
