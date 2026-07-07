from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from pydantic import BaseModel, ConfigDict, Field

from backend.app.api.dependencies import get_repositories
from backend.app.services.agent_runtime import AgentRuntimeInitializationError
from backend.app.core.config import AppSettings, get_settings
from backend.app.core.logger import logger
from backend.app.services.manual_context_compression_service import (
    ManualContextCompressionResult,
    ManualContextCompressionService,
)
from backend.app.services.session_fork_service import (
    SessionForkService,
    SessionForkServiceError,
)
from backend.app.services.session_service import (
    GetHistoryRequest,
    ListSessionsRequest,
    SessionNotFoundError,
    SessionService,
    SessionValidationError,
)
from backend.app.services.workspace_service import (
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
    title: str | None = None
    archived: bool | None = None
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
    except SessionNotFoundError as exc:
        raise _not_found(exc) from exc
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
        if payload.archived is True:
            session = service.delete_session(session_id)
        elif "title" in payload.model_fields_set:
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
    except SessionNotFoundError as exc:
        raise _not_found(exc) from exc
    except SessionValidationError as exc:
        raise _bad_request("invalid_session_patch", str(exc)) from exc
    return SessionResponse(session=session)


@router.delete("/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_session(
    session_id: str,
    repositories: StorageRepositories = RepositoriesDep,
) -> Response:
    try:
        _service(repositories).delete_session(session_id)
    except SessionNotFoundError as exc:
        raise _not_found(exc) from exc
    return Response(status_code=status.HTTP_204_NO_CONTENT)


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


@router.post("/{session_id}/reverse", response_model=SessionBranchResponse)
def reverse_session(
    session_id: str,
    payload: SessionBranchRequest,
    repositories: StorageRepositories = RepositoriesDep,
    settings: AppSettings = SettingsDep,
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
    except SessionNotFoundError as exc:
        raise _not_found(exc) from exc
    except SessionValidationError as exc:
        raise _bad_request("invalid_tool_detail", str(exc)) from exc
    return ToolDetailResponse(detail=detail)


def _history_response(
    repositories: StorageRepositories,
    request: GetHistoryRequest,
) -> SessionHistoryResponse:
    try:
        result = _service(repositories).get_history(request)
    except SessionNotFoundError as exc:
        raise _not_found(exc) from exc
    logger.debug(
        "[SessionsAPI] 查询会话历史 | "
        f"session_id={request.session_id} | turn_index={request.turn_index} | "
        f"page={request.page} | page_size={request.page_size} | "
        f"events={result.get('event_total', 0)} | messages={result.get('total', 0)}"
    )
    return SessionHistoryResponse(**result)


def _service(repositories: StorageRepositories) -> SessionService:
    return SessionService(
        repositories.sessions,
        repositories.message_events,
        repositories.workspaces,
        repositories.session_forks,
    )


def _fork_service(repositories: StorageRepositories) -> SessionForkService:
    return SessionForkService(repositories)


def _not_found(exc: SessionNotFoundError) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_404_NOT_FOUND,
        detail={"code": "session_not_found", "message": str(exc), "details": {}},
    )


def _bad_request(code: str, message: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail={"code": code, "message": message, "details": {}},
    )


def _workspace_error(exc: WorkspaceServiceError) -> HTTPException:
    status_code = {
        "workspace_not_found": status.HTTP_404_NOT_FOUND,
        "workspace_deleted": status.HTTP_410_GONE,
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
