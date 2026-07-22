from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Response, status

from backend.app.api.dependencies import get_repositories
from backend.app.right_sidebar.models import (
    RightSidebarPromotionRequest,
    RightSidebarPromotionResponse,
    RightSidebarScopePutRequest,
    RightSidebarScopeRecord,
    ScopeKind,
)
from backend.app.right_sidebar.service import RightSidebarScopeService, RightSidebarServiceError
from backend.app.storage import StorageRepositories

router = APIRouter(prefix="/api/ui/right-sidebar", tags=["right-sidebar"])
RepositoriesDep = Depends(get_repositories)


@router.post("/promotions", response_model=RightSidebarPromotionResponse)
async def promote_scope(
    payload: RightSidebarPromotionRequest,
    repositories: StorageRepositories = RepositoriesDep,
) -> RightSidebarPromotionResponse:
    return _call(
        _service(repositories).promote,
        source_scope_kind=payload.source_scope_kind,
        source_scope_id=payload.source_scope_id,
        source_revision=payload.source_revision,
        target_session_id=payload.target_session_id,
    )


@router.get("/scopes/global", response_model=RightSidebarScopeRecord | None)
async def get_global_scope(
    repositories: StorageRepositories = RepositoriesDep,
) -> RightSidebarScopeRecord | None:
    return _call(_service(repositories).get, scope_kind="global", scope_id=None)


@router.put("/scopes/global", response_model=RightSidebarScopeRecord)
async def put_global_scope(
    payload: RightSidebarScopePutRequest,
    repositories: StorageRepositories = RepositoriesDep,
    if_match: Annotated[str | None, Header(alias="If-Match")] = None,
) -> RightSidebarScopeRecord:
    _require_if_match(if_match, payload.expected_revision)
    return _call(
        _service(repositories).put,
        scope_kind="global",
        scope_id=None,
        state=payload.state,
        expected_revision=payload.expected_revision,
    )


@router.delete("/scopes/global", status_code=status.HTTP_204_NO_CONTENT)
async def delete_global_scope(repositories: StorageRepositories = RepositoriesDep) -> Response:
    _call(_service(repositories).delete, scope_kind="global", scope_id=None)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/scopes/{scope_kind}/{scope_id}", response_model=RightSidebarScopeRecord | None)
async def get_scope(
    scope_kind: ScopeKind,
    scope_id: str,
    repositories: StorageRepositories = RepositoriesDep,
) -> RightSidebarScopeRecord | None:
    if scope_kind == "global":
        raise _scope_invalid_http()
    return _call(_service(repositories).get, scope_kind=scope_kind, scope_id=scope_id)


@router.put("/scopes/{scope_kind}/{scope_id}", response_model=RightSidebarScopeRecord)
async def put_scope(
    scope_kind: ScopeKind,
    scope_id: str,
    payload: RightSidebarScopePutRequest,
    repositories: StorageRepositories = RepositoriesDep,
    if_match: Annotated[str | None, Header(alias="If-Match")] = None,
) -> RightSidebarScopeRecord:
    if scope_kind == "global":
        raise _scope_invalid_http()
    _require_if_match(if_match, payload.expected_revision)
    return _call(
        _service(repositories).put,
        scope_kind=scope_kind,
        scope_id=scope_id,
        state=payload.state,
        expected_revision=payload.expected_revision,
    )


@router.delete("/scopes/{scope_kind}/{scope_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_scope(
    scope_kind: ScopeKind,
    scope_id: str,
    repositories: StorageRepositories = RepositoriesDep,
) -> Response:
    if scope_kind == "global":
        raise _scope_invalid_http()
    _call(_service(repositories).delete, scope_kind=scope_kind, scope_id=scope_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def _service(repositories: StorageRepositories) -> RightSidebarScopeService:
    return RightSidebarScopeService(repositories)


def _call(operation, *args, **kwargs):
    try:
        return operation(*args, **kwargs)
    except RightSidebarServiceError as exc:
        raise HTTPException(
            status_code=_error_status(exc.code),
            detail={"code": exc.code, "message": exc.message, "details": exc.details},
        ) from exc


def _require_if_match(value: str | None, expected_revision: int) -> None:
    if value is None:
        return
    normalized = value.strip().strip('"')
    if normalized != str(expected_revision):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "right_sidebar_if_match_mismatch",
                "message": "If-Match 与 expected_revision 不一致",
                "details": {"expected_revision": expected_revision},
            },
        )


def _error_status(code: str) -> int:
    if code in {"right_sidebar_scope_not_found", "right_sidebar_scope_parent_not_found"}:
        return status.HTTP_404_NOT_FOUND
    if code == "right_sidebar_revision_conflict":
        return status.HTTP_409_CONFLICT
    if code == "right_sidebar_promotion_source_conflict":
        return status.HTTP_409_CONFLICT
    return status.HTTP_422_UNPROCESSABLE_ENTITY


def _scope_invalid_http() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        detail={
            "code": "right_sidebar_scope_invalid",
            "message": "global 作用域使用专用路径",
            "details": {},
        },
    )
