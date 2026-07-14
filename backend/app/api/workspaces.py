from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from backend.app.api.dependencies import get_repositories
from backend.app.services.workspace_service import WorkspaceService, WorkspaceServiceError
from backend.app.storage import StorageRepositories

router = APIRouter(prefix="/api/workspaces", tags=["workspaces"])
RepositoriesDep = Depends(get_repositories)


class CreateWorkspaceRequest(BaseModel):
    root_path: str = Field(min_length=1)
    name: str | None = None


class UpdateWorkspaceRequest(BaseModel):
    name: str | None = None
    touch: bool | None = None


class WorkspaceResponse(BaseModel):
    workspace: dict[str, Any]


class WorkspaceListResponse(BaseModel):
    list: list[dict[str, Any]]
    total: int


@router.get("", response_model=WorkspaceListResponse)
def list_workspaces(
    repositories: StorageRepositories = RepositoriesDep,
) -> WorkspaceListResponse:
    return WorkspaceListResponse(**_service(repositories).list_workspaces())


@router.post("", response_model=WorkspaceResponse)
def create_workspace(
    payload: CreateWorkspaceRequest,
    repositories: StorageRepositories = RepositoriesDep,
) -> WorkspaceResponse:
    try:
        workspace = _service(repositories).create_workspace(
            root_path=payload.root_path,
            name=payload.name,
        )
    except WorkspaceServiceError as exc:
        raise _workspace_error(exc) from exc
    return WorkspaceResponse(workspace=workspace)


@router.get("/{workspace_id}", response_model=WorkspaceResponse)
def get_workspace(
    workspace_id: str,
    repositories: StorageRepositories = RepositoriesDep,
) -> WorkspaceResponse:
    try:
        workspace = _service(repositories).get_workspace(workspace_id)
    except WorkspaceServiceError as exc:
        raise _workspace_error(exc) from exc
    return WorkspaceResponse(workspace=workspace)


@router.patch("/{workspace_id}", response_model=WorkspaceResponse)
def update_workspace(
    workspace_id: str,
    payload: UpdateWorkspaceRequest,
    repositories: StorageRepositories = RepositoriesDep,
) -> WorkspaceResponse:
    service = _service(repositories)
    try:
        if "name" in payload.model_fields_set:
            workspace = service.rename_workspace(workspace_id, payload.name or "")
        else:
            workspace = service.get_workspace(workspace_id)
        if payload.touch:
            workspace = service.touch_workspace(workspace_id)
    except WorkspaceServiceError as exc:
        raise _workspace_error(exc) from exc
    return WorkspaceResponse(workspace=workspace)


def _service(repositories: StorageRepositories) -> WorkspaceService:
    return WorkspaceService(repositories.workspaces)


def _workspace_error(exc: WorkspaceServiceError) -> HTTPException:
    status_code = {
        "workspace_path_empty": status.HTTP_400_BAD_REQUEST,
        "workspace_not_directory": status.HTTP_400_BAD_REQUEST,
        "workspace_name_empty": status.HTTP_400_BAD_REQUEST,
        "workspace_path_invalid": status.HTTP_400_BAD_REQUEST,
        "workspace_path_not_found": status.HTTP_404_NOT_FOUND,
        "workspace_not_found": status.HTTP_404_NOT_FOUND,
        "workspace_archived": status.HTTP_409_CONFLICT,
    }.get(exc.code, status.HTTP_400_BAD_REQUEST)
    return HTTPException(
        status_code=status_code,
        detail={
            "code": exc.code,
            "message": exc.message,
            "details": exc.details,
        },
    )
