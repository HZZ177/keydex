from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from pydantic import BaseModel, Field

from backend.app.api.dependencies import get_repositories
from backend.app.core.config import AppSettings, get_settings
from backend.app.services import (
    GetHistoryRequest,
    ListSessionsRequest,
    SessionNotFoundError,
    SessionService,
    SessionValidationError,
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


class UpdateSessionRequest(BaseModel):
    title: str | None = None
    archived: bool | None = None


class SessionResponse(BaseModel):
    session: dict[str, Any]


class SessionListResponse(BaseModel):
    list: list[dict[str, Any]]
    total: int
    page: int
    page_size: int


class SessionHistoryResponse(BaseModel):
    list: list[dict[str, Any]]
    total: int
    page: int
    page_size: int
    session: dict[str, Any]
    event_total: int
    turn_indexes: list[int] = Field(default_factory=list)


@router.post("", response_model=SessionResponse)
def create_session(
    payload: CreateSessionRequest,
    repositories: StorageRepositories = RepositoriesDep,
    settings: AppSettings = SettingsDep,
) -> SessionResponse:
    service = _service(repositories)
    session = service.create_session(
        session_id=payload.session_id,
        user_id=payload.user_id or settings.default_user_id,
        scene_id=payload.scene_id or settings.default_scene_id,
        title=payload.title,
        session_tag=payload.session_tag,
    )
    return SessionResponse(session=session)


@router.get("", response_model=SessionListResponse)
def list_sessions(
    user_id: str | None = None,
    scene_id: str | None = None,
    status_filter: str | None = Query(default=None, alias="status"),
    session_tag: str | None = None,
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
            title=title,
            current_session_id=current_session_id,
            page=page,
            page_size=page_size,
        )
    )
    return SessionListResponse(**result)


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


@router.get("/{session_id}/messages", response_model=SessionHistoryResponse)
def get_session_messages(
    session_id: str,
    turn_index: int | None = None,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=100),
    order: str = "asc",
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
        ),
    )


@router.get("/{session_id}/history", response_model=SessionHistoryResponse)
def get_session_history(
    session_id: str,
    turn_index: int | None = None,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=100),
    order: str = "asc",
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
        ),
    )


def _history_response(
    repositories: StorageRepositories,
    request: GetHistoryRequest,
) -> SessionHistoryResponse:
    try:
        result = _service(repositories).get_history(request)
    except SessionNotFoundError as exc:
        raise _not_found(exc) from exc
    return SessionHistoryResponse(**result)


def _service(repositories: StorageRepositories) -> SessionService:
    return SessionService(repositories.sessions, repositories.message_events)


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
