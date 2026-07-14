from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, status

from backend.app.annotations.models import (
    AnnotationBodyUpdateRequest,
    AnnotationCreateRequest,
    AnnotationRecord,
    AnnotationRetargetRequest,
)
from backend.app.annotations.service import AnnotationService, AnnotationServiceError
from backend.app.api.dependencies import get_repositories
from backend.app.storage import StorageRepositories

router = APIRouter(
    prefix="/api/workspaces/{workspace_id}/annotations",
    tags=["annotations"],
)
RepositoriesDep = Depends(get_repositories)


@router.get("", response_model=list[AnnotationRecord])
async def list_annotations(
    workspace_id: str,
    path: str = Query(..., min_length=1),
    repositories: StorageRepositories = RepositoriesDep,
) -> list[AnnotationRecord]:
    return _call(_service(repositories).list, workspace_id=workspace_id, path=path)


@router.post("", response_model=AnnotationRecord, status_code=status.HTTP_201_CREATED)
async def create_annotation(
    workspace_id: str,
    payload: AnnotationCreateRequest,
    repositories: StorageRepositories = RepositoriesDep,
) -> AnnotationRecord:
    return _call(_service(repositories).create, workspace_id=workspace_id, payload=payload)


@router.patch("/{annotation_id}", response_model=AnnotationRecord)
async def update_annotation_body(
    workspace_id: str,
    annotation_id: str,
    payload: AnnotationBodyUpdateRequest,
    repositories: StorageRepositories = RepositoriesDep,
) -> AnnotationRecord:
    return _call(
        _service(repositories).update_body,
        annotation_id,
        workspace_id=workspace_id,
        body=payload.body,
    )


@router.put("/{annotation_id}/target", response_model=AnnotationRecord)
async def replace_annotation_target(
    workspace_id: str,
    annotation_id: str,
    payload: AnnotationRetargetRequest,
    repositories: StorageRepositories = RepositoriesDep,
) -> AnnotationRecord:
    return _call(
        _service(repositories).replace_target,
        annotation_id,
        workspace_id=workspace_id,
        target=payload.target,
    )


@router.delete("/{annotation_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_annotation(
    workspace_id: str,
    annotation_id: str,
    repositories: StorageRepositories = RepositoriesDep,
) -> None:
    _call(_service(repositories).delete, annotation_id, workspace_id=workspace_id)


def _service(repositories: StorageRepositories) -> AnnotationService:
    return AnnotationService(repositories.workspaces, repositories.annotations)


def _call(operation, *args, **kwargs):
    try:
        return operation(*args, **kwargs)
    except AnnotationServiceError as exc:
        raise HTTPException(
            status_code=_error_status(exc.code),
            detail={"code": exc.code, "message": exc.message, "details": exc.details},
        ) from exc


def _error_status(code: str) -> int:
    if code in {"workspace_not_found", "annotation_not_found", "annotation_path_not_found"}:
        return status.HTTP_404_NOT_FOUND
    if code == "workspace_archived":
        return status.HTTP_409_CONFLICT
    if code == "annotation_path_forbidden":
        return status.HTTP_403_FORBIDDEN
    if code == "annotation_document_changed":
        return status.HTTP_409_CONFLICT
    return status.HTTP_400_BAD_REQUEST
