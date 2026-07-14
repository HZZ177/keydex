from __future__ import annotations

from enum import StrEnum
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, ConfigDict, Field

from backend.app.api.dependencies import get_repositories
from backend.app.core.config import AppSettings, get_settings
from backend.app.services.archive_lifecycle_service import (
    ArchiveLifecycleError,
    ArchiveLifecycleService,
)
from backend.app.services.purge_service import PurgeService
from backend.app.storage import StorageRepositories

router = APIRouter(tags=["archive-lifecycle"])
RepositoriesDep = Depends(get_repositories)
SettingsDep = Depends(get_settings)

REQUEST_ID_PATTERN = r"^[A-Za-z0-9][A-Za-z0-9._:-]*$"


class RestoreWorkspaceMode(StrEnum):
    PROJECT_ONLY = "project_only"
    WITH_PROJECT_SESSIONS = "with_project_sessions"


class ArchiveOrigin(StrEnum):
    MANUAL = "manual"
    PROJECT = "project"


class LifecycleErrorBody(BaseModel):
    code: str
    message: str
    details: dict[str, Any]
    retryable: bool


class LifecycleHttpErrorResponse(BaseModel):
    detail: LifecycleErrorBody


class LifecycleEventResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: str
    operation_id: str
    request_id: str
    occurred_at: str
    revision: int
    changed: bool
    session_id: str | None = None
    workspace_id: str | None = None
    archived_at: str | None = None
    archive_origin: ArchiveOrigin | None = None
    mode: RestoreWorkspaceMode | None = None
    newly_archived: int | None = None
    restored_project_sessions: int | None = None
    counts: dict[str, int] | None = None
    cleanup_state: str | None = None


class LifecycleRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    request_id: str = Field(min_length=1, max_length=128, pattern=REQUEST_ID_PATTERN)


class ArchiveSessionRequest(LifecycleRequest):
    stop_if_active: bool = False


class RestoreSessionRequest(LifecycleRequest):
    pass


class ArchiveWorkspaceRequest(LifecycleRequest):
    stop_active_sessions: bool = False


class RestoreWorkspaceRequest(LifecycleRequest):
    mode: RestoreWorkspaceMode


class PurgeSessionRequest(LifecycleRequest):
    confirmed: bool


class PurgeWorkspaceRequest(LifecycleRequest):
    confirmation_name: str = Field(min_length=1, max_length=500)


class SessionArchiveResponse(BaseModel):
    operation_id: str
    request_id: str
    session_id: str
    workspace_id: str | None = None
    changed: bool
    archived_at: str | None = None
    archive_origin: ArchiveOrigin | None = None
    event: LifecycleEventResponse | None = None
    replayed: bool = False


class SessionRestoreResponse(BaseModel):
    operation_id: str
    request_id: str
    session_id: str
    workspace_id: str | None = None
    workspace: dict[str, str] | None = None
    changed: bool
    event: LifecycleEventResponse | None = None
    replayed: bool = False


class WorkspaceArchiveResponse(BaseModel):
    operation_id: str
    request_id: str
    workspace_id: str
    changed: bool
    archived_at: str | None = None
    newly_archived: int
    manual_preserved: int
    project_preserved: int
    event: LifecycleEventResponse | None = None
    replayed: bool = False


class WorkspaceRestoreResponse(BaseModel):
    operation_id: str
    request_id: str
    workspace_id: str
    mode: RestoreWorkspaceMode
    changed: bool
    restored_project_sessions: int
    remaining_manual: int
    remaining_project: int
    remaining_total: int
    event: LifecycleEventResponse | None = None
    replayed: bool = False


class ArchiveCatalogResponse(BaseModel):
    items: list[dict[str, Any]]
    next_cursor: str | None = None
    has_more: bool
    total: int | None = None
    total_kind: str


class PurgeResponse(BaseModel):
    operation_id: str
    state: str
    entity_type: str
    counts: dict[str, int]
    replayed: bool
    event: LifecycleEventResponse | None = None


LIFECYCLE_ERROR_RESPONSES = {
    status.HTTP_404_NOT_FOUND: {
        "model": LifecycleHttpErrorResponse,
        "description": "Lifecycle entity not found",
    },
    status.HTTP_409_CONFLICT: {
        "model": LifecycleHttpErrorResponse,
        "description": "Lifecycle state conflict or blocker",
    },
    status.HTTP_422_UNPROCESSABLE_CONTENT: {
        "model": LifecycleHttpErrorResponse,
        "description": "Lifecycle request validation or confirmation error",
    },
}


@router.post(
    "/api/sessions/{session_id}/archive",
    response_model=SessionArchiveResponse,
    responses=LIFECYCLE_ERROR_RESPONSES,
)
def archive_session(
    session_id: str,
    payload: ArchiveSessionRequest,
    request: Request,
    repositories: StorageRepositories = RepositoriesDep,
) -> SessionArchiveResponse:
    try:
        result = ArchiveLifecycleService(repositories).archive_session(
            session_id,
            request_id=payload.request_id,
            stop_if_active=payload.stop_if_active,
        )
    except ArchiveLifecycleError as exc:
        raise _lifecycle_error(exc) from exc
    _publish_lifecycle_event(request, result)
    return SessionArchiveResponse(**result)


@router.post(
    "/api/sessions/{session_id}/restore",
    response_model=SessionRestoreResponse,
    responses=LIFECYCLE_ERROR_RESPONSES,
)
def restore_session(
    session_id: str,
    payload: RestoreSessionRequest,
    request: Request,
    repositories: StorageRepositories = RepositoriesDep,
) -> SessionRestoreResponse:
    try:
        result = ArchiveLifecycleService(repositories).restore_session(
            session_id,
            request_id=payload.request_id,
        )
    except ArchiveLifecycleError as exc:
        if exc.code == "workspace_archived":
            archived = repositories.sessions.get_archived(session_id)
            exc.details.update(
                {
                    "session_id": session_id,
                    "archive_origin": archived.archive_origin if archived is not None else None,
                }
            )
        raise _lifecycle_error(exc) from exc
    _publish_lifecycle_event(request, result)
    return SessionRestoreResponse(**result)


@router.post(
    "/api/workspaces/{workspace_id}/archive",
    response_model=WorkspaceArchiveResponse,
    responses=LIFECYCLE_ERROR_RESPONSES,
)
def archive_workspace(
    workspace_id: str,
    payload: ArchiveWorkspaceRequest,
    request: Request,
    repositories: StorageRepositories = RepositoriesDep,
) -> WorkspaceArchiveResponse:
    try:
        result = ArchiveLifecycleService(repositories).archive_workspace(
            workspace_id,
            request_id=payload.request_id,
            stop_active_sessions=payload.stop_active_sessions,
        )
    except ArchiveLifecycleError as exc:
        raise _lifecycle_error(exc) from exc
    _publish_lifecycle_event(request, result)
    return WorkspaceArchiveResponse(**result)


@router.post(
    "/api/workspaces/{workspace_id}/restore",
    response_model=WorkspaceRestoreResponse,
    responses=LIFECYCLE_ERROR_RESPONSES,
)
def restore_workspace(
    workspace_id: str,
    payload: RestoreWorkspaceRequest,
    request: Request,
    repositories: StorageRepositories = RepositoriesDep,
) -> WorkspaceRestoreResponse:
    try:
        result = ArchiveLifecycleService(repositories).restore_workspace(
            workspace_id,
            request_id=payload.request_id,
            mode=payload.mode.value,
        )
    except ArchiveLifecycleError as exc:
        raise _lifecycle_error(exc) from exc
    _publish_lifecycle_event(request, result)
    return WorkspaceRestoreResponse(**result)


@router.get("/api/archive/workspaces", response_model=ArchiveCatalogResponse)
def list_archived_workspaces(
    query: str | None = Query(default=None, max_length=200),
    cursor: str | None = Query(default=None, max_length=1000),
    limit: int = Query(default=50, ge=1, le=200),
    repositories: StorageRepositories = RepositoriesDep,
) -> ArchiveCatalogResponse:
    try:
        result = ArchiveLifecycleService(repositories).list_archived_workspaces(
            query=query,
            cursor=cursor,
            limit=limit,
        )
    except ValueError as exc:
        raise _invalid_cursor(exc) from exc
    return ArchiveCatalogResponse(items=result.pop("list"), **result)


@router.get("/api/archive/sessions", response_model=ArchiveCatalogResponse)
def list_archived_sessions(
    query: str | None = Query(default=None, max_length=200),
    workspace_id: list[str] | None = Query(default=None, max_length=200),
    cursor: str | None = Query(default=None, max_length=1000),
    limit: int = Query(default=50, ge=1, le=200),
    repositories: StorageRepositories = RepositoriesDep,
) -> ArchiveCatalogResponse:
    try:
        result = ArchiveLifecycleService(repositories).list_archived_sessions(
            query=query,
            workspace_ids=workspace_id,
            cursor=cursor,
            limit=limit,
            include_archived_workspace=True,
        )
    except ValueError as exc:
        raise _invalid_cursor(exc) from exc
    return ArchiveCatalogResponse(items=result.pop("list"), **result)


@router.get(
    "/api/archive/workspaces/{workspace_id}/sessions",
    response_model=ArchiveCatalogResponse,
)
def list_archived_workspace_sessions(
    workspace_id: str,
    query: str | None = Query(default=None, max_length=200),
    cursor: str | None = Query(default=None, max_length=1000),
    limit: int = Query(default=50, ge=1, le=200),
    repositories: StorageRepositories = RepositoriesDep,
) -> ArchiveCatalogResponse:
    if repositories.workspaces.get_archived(workspace_id) is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail={
                "code": "workspace_not_found",
                "message": "归档项目不存在",
                "details": {"workspace_id": workspace_id},
                "retryable": False,
            },
        )
    try:
        result = ArchiveLifecycleService(repositories).list_archived_sessions(
            query=query,
            cursor=cursor,
            limit=limit,
            workspace_id=workspace_id,
            include_archived_workspace=True,
        )
    except ValueError as exc:
        raise _invalid_cursor(exc) from exc
    return ArchiveCatalogResponse(items=result.pop("list"), **result)


@router.post(
    "/api/archive/sessions/{session_id}/purge",
    response_model=PurgeResponse,
    responses=LIFECYCLE_ERROR_RESPONSES,
)
def purge_session(
    session_id: str,
    payload: PurgeSessionRequest,
    request: Request,
    repositories: StorageRepositories = RepositoriesDep,
    settings: AppSettings = SettingsDep,
) -> PurgeResponse:
    try:
        result = PurgeService(repositories, data_dir=settings.data_dir).purge_session(
            session_id,
            request_id=payload.request_id,
            confirmed=payload.confirmed,
        )
    except ArchiveLifecycleError as exc:
        _publish_failed_purge_event(request, exc)
        raise _lifecycle_error(exc) from exc
    _publish_lifecycle_event(request, result)
    return PurgeResponse(**result)


@router.post(
    "/api/archive/workspaces/{workspace_id}/purge",
    response_model=PurgeResponse,
    responses=LIFECYCLE_ERROR_RESPONSES,
)
def purge_workspace(
    workspace_id: str,
    payload: PurgeWorkspaceRequest,
    request: Request,
    repositories: StorageRepositories = RepositoriesDep,
    settings: AppSettings = SettingsDep,
) -> PurgeResponse:
    try:
        result = PurgeService(repositories, data_dir=settings.data_dir).purge_workspace(
            workspace_id,
            request_id=payload.request_id,
            confirmation_name=payload.confirmation_name,
        )
    except ArchiveLifecycleError as exc:
        _publish_failed_purge_event(request, exc)
        raise _lifecycle_error(exc) from exc
    _publish_lifecycle_event(request, result)
    return PurgeResponse(**result)


@router.post(
    "/api/archive/workspaces/{workspace_id}/sessions/purge",
    response_model=PurgeResponse,
    responses=LIFECYCLE_ERROR_RESPONSES,
)
def purge_workspace_sessions(
    workspace_id: str,
    payload: PurgeWorkspaceRequest,
    request: Request,
    repositories: StorageRepositories = RepositoriesDep,
    settings: AppSettings = SettingsDep,
) -> PurgeResponse:
    try:
        result = PurgeService(
            repositories,
            data_dir=settings.data_dir,
        ).purge_workspace_sessions(
            workspace_id,
            request_id=payload.request_id,
            confirmation_name=payload.confirmation_name,
        )
    except ArchiveLifecycleError as exc:
        _publish_failed_purge_event(request, exc)
        raise _lifecycle_error(exc) from exc
    _publish_lifecycle_event(request, result)
    return PurgeResponse(**result)


def _lifecycle_error(exc: ArchiveLifecycleError) -> HTTPException:
    if exc.code == "not_found":
        status_code = status.HTTP_404_NOT_FOUND
    elif exc.code in {
        "purge_confirmation_required",
        "confirmation_mismatch",
        "restore_mode_invalid",
    }:
        status_code = status.HTTP_422_UNPROCESSABLE_CONTENT
    else:
        status_code = status.HTTP_409_CONFLICT
    retryable = exc.code in {"cleanup_failed", "lifecycle_locked", "archive_stop_failed"}
    return HTTPException(
        status_code=status_code,
        detail={
            "code": exc.code,
            "message": exc.message,
            "details": exc.details,
            "retryable": retryable,
        },
    )


def _invalid_cursor(exc: ValueError) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
        detail={
            "code": "archive_cursor_invalid",
            "message": str(exc),
            "details": {},
            "retryable": False,
        },
    )


def _publish_lifecycle_event(request: Request, result: dict[str, Any]) -> None:
    event = result.get("event")
    if not isinstance(event, dict):
        return
    publisher = getattr(request.app.state, "lifecycle_event_publisher", None)
    publish = getattr(publisher, "publish", None)
    if callable(publish):
        publish(event)


def _publish_failed_purge_event(request: Request, exc: ArchiveLifecycleError) -> None:
    event = exc.details.pop("_lifecycle_event", None)
    if isinstance(event, dict):
        _publish_lifecycle_event(request, {"event": event})
