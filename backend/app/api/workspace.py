from __future__ import annotations

import asyncio
import base64
import mimetypes
import os
import time
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel

from backend.app.api.dependencies import get_repositories
from backend.app.core.logger import logger
from backend.app.keydex.schemas import WorkspaceSkillsResponse, workspace_skills_response
from backend.app.security.workspace import WorkspacePathError, resolve_workspace_path
from backend.app.services.workspace_service import (
    WorkspaceRuntimeContext,
    WorkspaceService,
    WorkspaceServiceError,
)
from backend.app.storage import StorageRepositories

router = APIRouter(tags=["workspace"])
RepositoriesDep = Depends(get_repositories)

MAX_READ_BYTES = 512 * 1024
MAX_MEDIA_BYTES = 2 * 1024 * 1024
DEFAULT_SEARCH_LIMIT = 50
MAX_SEARCH_VISITED_PATHS = 50_000
MAX_SEARCH_SECONDS = 2.5
IGNORED_DIRS = {
    ".git",
    ".hg",
    ".svn",
    ".venv",
    "venv",
    "env",
    "node_modules",
    "__pycache__",
    ".cache",
    ".parcel-cache",
    ".ruff_cache",
    ".mypy_cache",
    ".pytest_cache",
    ".npm-cache",
    ".pnpm-store",
    ".yarn",
    ".turbo",
    ".next",
    ".nuxt",
    ".vite",
    "coverage",
    "dist",
    "build",
    "out",
    "target",
    ".gradle",
    ".idea",
}
IGNORED_FILE_NAMES = {
    ".npmrc",
    ".pypirc",
    ".netrc",
    "id_rsa",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
}
IGNORED_FILE_SUFFIXES = {
    ".pyc",
    ".pyo",
    ".class",
    ".o",
    ".obj",
    ".dll",
    ".so",
    ".dylib",
    ".map",
}


class WorkspaceEntry(BaseModel):
    name: str
    path: str
    type: str
    size: int | None = None
    modified_at: str | None = None


class WorkspaceTreeResponse(BaseModel):
    root: str
    entries: list[WorkspaceEntry]


class WorkspaceFileResponse(BaseModel):
    path: str
    content: str
    encoding: str


class WorkspaceMediaResponse(BaseModel):
    path: str
    media_type: str
    size: int
    data_url: str


class WorkspaceSearchResult(BaseModel):
    path: str
    name: str
    type: str


class WorkspaceFileAnnotationAnchorV2(BaseModel):
    version: Literal[2]
    kind: Literal["source-range"]
    sourceStart: int
    sourceEnd: int
    selectedText: str
    sourceText: str
    contentHash: str
    lineStart: int
    lineEnd: int
    columnStart: int
    columnEnd: int
    createdInView: Literal["preview", "source"]


class WorkspaceFileAnnotationPayload(BaseModel):
    path: str
    anchor_type: str = "file"
    comment: str
    selected_text: str | None = None
    line_start: int | None = None
    line_end: int | None = None
    column_start: int | None = None
    column_end: int | None = None
    content_hash: str | None = None
    anchor_json: WorkspaceFileAnnotationAnchorV2 | None = None


class WorkspaceFileAnnotationUpdatePayload(BaseModel):
    anchor_type: str | None = None
    comment: str | None = None
    selected_text: str | None = None
    line_start: int | None = None
    line_end: int | None = None
    column_start: int | None = None
    column_end: int | None = None
    content_hash: str | None = None
    anchor_json: WorkspaceFileAnnotationAnchorV2 | None = None


class WorkspaceFileAnnotationResponse(BaseModel):
    id: str
    scope_type: str
    scope_id: str
    workspace_id: str | None = None
    path: str
    anchor_type: str
    comment: str
    selected_text: str | None = None
    line_start: int | None = None
    line_end: int | None = None
    column_start: int | None = None
    column_end: int | None = None
    content_hash: str | None = None
    anchor_json: WorkspaceFileAnnotationAnchorV2 | None = None
    created_at: str
    updated_at: str


@router.get("/api/workspaces/{workspace_id}/tree", response_model=WorkspaceTreeResponse)
async def list_workspace_tree(
    workspace_id: str,
    path: str = "",
    repositories: StorageRepositories = RepositoriesDep,
) -> WorkspaceTreeResponse:
    scope = _workspace_scope(repositories, workspace_id)
    return _list_tree(scope, path)


@router.get("/api/workspaces/{workspace_id}/read", response_model=WorkspaceFileResponse)
async def read_workspace_file(
    workspace_id: str,
    path: str = Query(..., min_length=1),
    repositories: StorageRepositories = RepositoriesDep,
) -> WorkspaceFileResponse:
    scope = _workspace_scope(repositories, workspace_id)
    return _read_file(scope, path)


@router.get("/api/workspaces/{workspace_id}/media", response_model=WorkspaceMediaResponse)
async def read_workspace_media(
    workspace_id: str,
    path: str = Query(..., min_length=1),
    repositories: StorageRepositories = RepositoriesDep,
) -> WorkspaceMediaResponse:
    scope = _workspace_scope(repositories, workspace_id)
    return _read_media(scope, path)


@router.get("/api/workspaces/{workspace_id}/search", response_model=list[WorkspaceSearchResult])
async def search_workspace(
    workspace_id: str,
    q: str = Query("", min_length=0),
    limit: int = Query(DEFAULT_SEARCH_LIMIT, ge=1, le=100),
    repositories: StorageRepositories = RepositoriesDep,
) -> list[WorkspaceSearchResult]:
    scope = _workspace_scope(repositories, workspace_id)
    return await asyncio.to_thread(_search, scope, q, limit)


@router.get(
    "/api/workspaces/{workspace_id}/skills",
    response_model=WorkspaceSkillsResponse,
)
async def list_workspace_skills(
    workspace_id: str,
    request: Request,
    force_reload: bool = False,
    repositories: StorageRepositories = RepositoriesDep,
) -> WorkspaceSkillsResponse:
    scope = _workspace_scope(repositories, workspace_id)
    return await _workspace_skills_response(request, scope, force_reload=force_reload)


@router.get(
    "/api/workspaces/{workspace_id}/annotations",
    response_model=list[WorkspaceFileAnnotationResponse],
)
async def list_workspace_annotations(
    workspace_id: str,
    path: str = Query(..., min_length=1),
    repositories: StorageRepositories = RepositoriesDep,
) -> list[WorkspaceFileAnnotationResponse]:
    scope = _workspace_scope(repositories, workspace_id)
    return _list_annotations(
        repositories,
        scope,
        scope_type="workspace",
        scope_id=workspace_id,
        path=path,
    )


@router.post(
    "/api/workspaces/{workspace_id}/annotations",
    response_model=WorkspaceFileAnnotationResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_workspace_annotation(
    workspace_id: str,
    payload: WorkspaceFileAnnotationPayload,
    repositories: StorageRepositories = RepositoriesDep,
) -> WorkspaceFileAnnotationResponse:
    scope = _workspace_scope(repositories, workspace_id)
    return _create_annotation(
        repositories,
        scope,
        scope_type="workspace",
        scope_id=workspace_id,
        payload=payload,
    )


@router.patch(
    "/api/workspaces/{workspace_id}/annotations/{annotation_id}",
    response_model=WorkspaceFileAnnotationResponse,
)
async def update_workspace_annotation(
    workspace_id: str,
    annotation_id: str,
    payload: WorkspaceFileAnnotationUpdatePayload,
    repositories: StorageRepositories = RepositoriesDep,
) -> WorkspaceFileAnnotationResponse:
    scope = _workspace_scope(repositories, workspace_id)
    return _update_annotation(
        repositories,
        scope,
        scope_type="workspace",
        scope_id=workspace_id,
        annotation_id=annotation_id,
        payload=payload,
    )


@router.delete("/api/workspaces/{workspace_id}/annotations/{annotation_id}", status_code=204)
async def delete_workspace_annotation(
    workspace_id: str,
    annotation_id: str,
    repositories: StorageRepositories = RepositoriesDep,
) -> None:
    scope = _workspace_scope(repositories, workspace_id)
    _delete_annotation(
        repositories,
        scope,
        scope_type="workspace",
        scope_id=workspace_id,
        annotation_id=annotation_id,
    )


@router.get("/api/sessions/{session_id}/workspace/tree", response_model=WorkspaceTreeResponse)
async def list_session_workspace_tree(
    session_id: str,
    path: str = "",
    repositories: StorageRepositories = RepositoriesDep,
) -> WorkspaceTreeResponse:
    scope = _session_workspace_scope(repositories, session_id)
    return _list_tree(scope, path)


@router.get("/api/sessions/{session_id}/workspace/read", response_model=WorkspaceFileResponse)
async def read_session_workspace_file(
    session_id: str,
    path: str = Query(..., min_length=1),
    repositories: StorageRepositories = RepositoriesDep,
) -> WorkspaceFileResponse:
    scope = _session_workspace_scope(repositories, session_id)
    return _read_file(scope, path)


@router.get("/api/sessions/{session_id}/workspace/media", response_model=WorkspaceMediaResponse)
async def read_session_workspace_media(
    session_id: str,
    path: str = Query(..., min_length=1),
    repositories: StorageRepositories = RepositoriesDep,
) -> WorkspaceMediaResponse:
    scope = _session_workspace_scope(repositories, session_id)
    return _read_media(scope, path)


@router.get(
    "/api/sessions/{session_id}/workspace/search",
    response_model=list[WorkspaceSearchResult],
)
async def search_session_workspace(
    session_id: str,
    q: str = Query("", min_length=0),
    limit: int = Query(DEFAULT_SEARCH_LIMIT, ge=1, le=100),
    repositories: StorageRepositories = RepositoriesDep,
) -> list[WorkspaceSearchResult]:
    scope = _session_workspace_scope(repositories, session_id)
    return await asyncio.to_thread(_search, scope, q, limit)


@router.get(
    "/api/sessions/{session_id}/workspace/skills",
    response_model=WorkspaceSkillsResponse,
)
async def list_session_workspace_skills(
    session_id: str,
    request: Request,
    force_reload: bool = False,
    repositories: StorageRepositories = RepositoriesDep,
) -> WorkspaceSkillsResponse:
    scope = _session_workspace_scope(repositories, session_id)
    return await _workspace_skills_response(request, scope, force_reload=force_reload)


async def _workspace_skills_response(
    request: Request,
    scope: WorkspaceRuntimeContext,
    *,
    force_reload: bool,
) -> WorkspaceSkillsResponse:
    runtime_cache = request.app.state.keydex_runtime_cache
    snapshot = await asyncio.to_thread(
        runtime_cache.get_snapshot,
        scope.workspace.root_path,
        force_reload=force_reload,
    )
    return workspace_skills_response(snapshot)


@router.get(
    "/api/sessions/{session_id}/workspace/annotations",
    response_model=list[WorkspaceFileAnnotationResponse],
)
async def list_session_workspace_annotations(
    session_id: str,
    path: str = Query(..., min_length=1),
    repositories: StorageRepositories = RepositoriesDep,
) -> list[WorkspaceFileAnnotationResponse]:
    scope = _session_workspace_scope(repositories, session_id)
    return _list_annotations(
        repositories,
        scope,
        scope_type="session",
        scope_id=session_id,
        path=path,
    )


@router.post(
    "/api/sessions/{session_id}/workspace/annotations",
    response_model=WorkspaceFileAnnotationResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_session_workspace_annotation(
    session_id: str,
    payload: WorkspaceFileAnnotationPayload,
    repositories: StorageRepositories = RepositoriesDep,
) -> WorkspaceFileAnnotationResponse:
    scope = _session_workspace_scope(repositories, session_id)
    return _create_annotation(
        repositories,
        scope,
        scope_type="session",
        scope_id=session_id,
        payload=payload,
    )


@router.patch(
    "/api/sessions/{session_id}/workspace/annotations/{annotation_id}",
    response_model=WorkspaceFileAnnotationResponse,
)
async def update_session_workspace_annotation(
    session_id: str,
    annotation_id: str,
    payload: WorkspaceFileAnnotationUpdatePayload,
    repositories: StorageRepositories = RepositoriesDep,
) -> WorkspaceFileAnnotationResponse:
    scope = _session_workspace_scope(repositories, session_id)
    return _update_annotation(
        repositories,
        scope,
        scope_type="session",
        scope_id=session_id,
        annotation_id=annotation_id,
        payload=payload,
    )


@router.delete("/api/sessions/{session_id}/workspace/annotations/{annotation_id}", status_code=204)
async def delete_session_workspace_annotation(
    session_id: str,
    annotation_id: str,
    repositories: StorageRepositories = RepositoriesDep,
) -> None:
    scope = _session_workspace_scope(repositories, session_id)
    _delete_annotation(
        repositories,
        scope,
        scope_type="session",
        scope_id=session_id,
        annotation_id=annotation_id,
    )


def _list_annotations(
    repositories: StorageRepositories,
    scope: WorkspaceRuntimeContext,
    *,
    scope_type: str,
    scope_id: str,
    path: str,
) -> list[WorkspaceFileAnnotationResponse]:
    relative_path = _annotation_file_path(scope, path)
    records = repositories.workspace_file_annotations.list(
        scope_type=scope_type,
        scope_id=scope_id,
        path=relative_path,
    )
    return [_annotation_response(record) for record in records]


def _create_annotation(
    repositories: StorageRepositories,
    scope: WorkspaceRuntimeContext,
    *,
    scope_type: str,
    scope_id: str,
    payload: WorkspaceFileAnnotationPayload,
) -> WorkspaceFileAnnotationResponse:
    relative_path = _annotation_file_path(scope, payload.path)
    try:
        record = repositories.workspace_file_annotations.create(
            scope_type=scope_type,
            scope_id=scope_id,
            workspace_id=scope.workspace_id,
            path=relative_path,
            anchor_type=payload.anchor_type,
            comment=payload.comment,
            selected_text=payload.selected_text,
            line_start=payload.line_start,
            line_end=payload.line_end,
            column_start=payload.column_start,
            column_end=payload.column_end,
            content_hash=payload.content_hash,
            anchor_json=_annotation_anchor_payload(payload.anchor_json),
        )
    except ValueError as exc:
        raise _workspace_error(
            status.HTTP_400_BAD_REQUEST,
            "workspace_annotation_invalid",
            str(exc),
        ) from exc
    return _annotation_response(record)


def _update_annotation(
    repositories: StorageRepositories,
    scope: WorkspaceRuntimeContext,
    *,
    scope_type: str,
    scope_id: str,
    annotation_id: str,
    payload: WorkspaceFileAnnotationUpdatePayload,
) -> WorkspaceFileAnnotationResponse:
    existing = repositories.workspace_file_annotations.get(
        annotation_id,
        scope_type=scope_type,
        scope_id=scope_id,
    )
    if existing is None:
        raise _workspace_error(
            status.HTTP_404_NOT_FOUND,
            "workspace_annotation_not_found",
            "Annotation does not exist in the current workspace scope",
        )
    _resolve(scope, existing.path)
    fields = _payload_field_set(payload)
    anchor_type = (
        payload.anchor_type
        if "anchor_type" in fields and payload.anchor_type is not None
        else existing.anchor_type
    )
    comment = (
        payload.comment
        if "comment" in fields and payload.comment is not None
        else existing.comment
    )
    try:
        updated = repositories.workspace_file_annotations.update(
            annotation_id,
            scope_type=scope_type,
            scope_id=scope_id,
            anchor_type=anchor_type,
            comment=comment,
            selected_text=(
                payload.selected_text
                if "selected_text" in fields
                else existing.selected_text
            ),
            line_start=payload.line_start if "line_start" in fields else existing.line_start,
            line_end=payload.line_end if "line_end" in fields else existing.line_end,
            column_start=(
                payload.column_start
                if "column_start" in fields
                else existing.column_start
            ),
            column_end=payload.column_end if "column_end" in fields else existing.column_end,
            content_hash=(
                payload.content_hash
                if "content_hash" in fields
                else existing.content_hash
            ),
            anchor_json=(
                _annotation_anchor_payload(payload.anchor_json)
                if "anchor_json" in fields
                else existing.anchor_json
            ),
        )
    except ValueError as exc:
        raise _workspace_error(
            status.HTTP_400_BAD_REQUEST,
            "workspace_annotation_invalid",
            str(exc),
        ) from exc
    if updated is None:
        raise _workspace_error(
            status.HTTP_404_NOT_FOUND,
            "workspace_annotation_not_found",
            "Annotation does not exist in the current workspace scope",
        )
    return _annotation_response(updated)


def _delete_annotation(
    repositories: StorageRepositories,
    scope: WorkspaceRuntimeContext,
    *,
    scope_type: str,
    scope_id: str,
    annotation_id: str,
) -> None:
    existing = repositories.workspace_file_annotations.get(
        annotation_id,
        scope_type=scope_type,
        scope_id=scope_id,
    )
    if existing is None:
        raise _workspace_error(
            status.HTTP_404_NOT_FOUND,
            "workspace_annotation_not_found",
            "Annotation does not exist in the current workspace scope",
        )
    _resolve(scope, existing.path)
    if not repositories.workspace_file_annotations.delete(
        annotation_id,
        scope_type=scope_type,
        scope_id=scope_id,
    ):
        raise _workspace_error(
            status.HTTP_404_NOT_FOUND,
            "workspace_annotation_not_found",
            "Annotation does not exist in the current workspace scope",
        )


def _annotation_file_path(scope: WorkspaceRuntimeContext, path: str) -> str:
    target = _resolve(scope, path)
    if not target.exists():
        raise _workspace_error(
            status.HTTP_404_NOT_FOUND,
            "workspace_path_not_found",
            "File does not exist",
        )
    if not target.is_file():
        raise _workspace_error(
            status.HTTP_400_BAD_REQUEST,
            "workspace_not_file",
            "Path is not a file",
        )
    return _relative_path(scope, target)


def _payload_field_set(payload: BaseModel) -> set[str]:
    model_fields_set = getattr(payload, "model_fields_set", None)
    if model_fields_set is not None:
        return set(model_fields_set)
    return set(getattr(payload, "__fields_set__", set()))


def _annotation_anchor_payload(
    anchor: WorkspaceFileAnnotationAnchorV2 | None,
) -> dict[str, Any] | None:
    if anchor is None:
        return None
    return anchor.model_dump()


def _annotation_response(record: Any) -> WorkspaceFileAnnotationResponse:
    return WorkspaceFileAnnotationResponse(
        id=record.id,
        scope_type=record.scope_type,
        scope_id=record.scope_id,
        workspace_id=record.workspace_id,
        path=record.path,
        anchor_type=record.anchor_type,
        comment=record.comment,
        selected_text=record.selected_text,
        line_start=record.line_start,
        line_end=record.line_end,
        column_start=record.column_start,
        column_end=record.column_end,
        content_hash=record.content_hash,
        anchor_json=record.anchor_json,
        created_at=record.created_at,
        updated_at=record.updated_at,
    )


def _workspace_scope(
    repositories: StorageRepositories,
    workspace_id: str,
) -> WorkspaceRuntimeContext:
    service = WorkspaceService(repositories.workspaces)
    try:
        workspace = service.require_workspace(workspace_id)
    except WorkspaceServiceError as exc:
        raise _service_error(exc) from exc
    root = Path(workspace.root_path).expanduser().resolve()
    return WorkspaceRuntimeContext(
        workspace_id=workspace.id,
        cwd=root,
        workspace_roots=[root],
        workspace=workspace,
    )


def _session_workspace_scope(
    repositories: StorageRepositories,
    session_id: str,
) -> WorkspaceRuntimeContext:
    session = repositories.sessions.get(session_id)
    if session is None:
        raise _workspace_error(
            status.HTTP_404_NOT_FOUND,
            "session_not_found",
            f"会话不存在: {session_id}",
        )
    try:
        return WorkspaceService(repositories.workspaces).runtime_context_for_session(session)
    except WorkspaceServiceError as exc:
        raise _service_error(exc) from exc


def _list_tree(scope: WorkspaceRuntimeContext, path: str) -> WorkspaceTreeResponse:
    target = _resolve(scope, path or ".")
    if not target.exists():
        raise _workspace_error(status.HTTP_404_NOT_FOUND, "workspace_path_not_found", "目录不存在")
    if not target.is_dir():
        raise _workspace_error(
            status.HTTP_400_BAD_REQUEST,
            "workspace_not_directory",
            "路径不是目录",
        )

    entries = [
        _entry_for_path(scope, child)
        for child in sorted(target.iterdir(), key=_entry_sort_key)
    ]
    logger.debug(
        "[WorkspaceAPI] 列出目录 | "
        f"workspace_id={scope.workspace_id} | path={path or '.'} | entries={len(entries)}"
    )
    return WorkspaceTreeResponse(root=str(scope.cwd), entries=entries)


def _read_file(scope: WorkspaceRuntimeContext, path: str) -> WorkspaceFileResponse:
    target = _resolve(scope, path)
    if not target.exists():
        raise _workspace_error(status.HTTP_404_NOT_FOUND, "workspace_path_not_found", "文件不存在")
    if not target.is_file():
        raise _workspace_error(status.HTTP_400_BAD_REQUEST, "workspace_not_file", "路径不是文件")
    if target.stat().st_size > MAX_READ_BYTES:
        raise _workspace_error(
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            "workspace_file_too_large",
            "文件过大，暂不预览",
        )
    try:
        content = target.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        raise _workspace_error(
            status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            "workspace_binary_file",
            "文件不是 UTF-8 文本",
        ) from exc
    relative = _relative_path(scope, target)
    logger.debug(
        "[WorkspaceAPI] 读取文件 | "
        f"workspace_id={scope.workspace_id} | path={relative} | size={target.stat().st_size}"
    )
    return WorkspaceFileResponse(path=relative, content=content, encoding="utf-8")


def _read_media(scope: WorkspaceRuntimeContext, path: str) -> WorkspaceMediaResponse:
    target = _resolve(scope, path)
    if not target.exists():
        raise _workspace_error(status.HTTP_404_NOT_FOUND, "workspace_path_not_found", "文件不存在")
    if not target.is_file():
        raise _workspace_error(status.HTTP_400_BAD_REQUEST, "workspace_not_file", "路径不是文件")

    size = target.stat().st_size
    if size > MAX_MEDIA_BYTES:
        raise _workspace_error(
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            "workspace_media_too_large",
            "图片过大，暂不预览",
        )

    media_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
    if not media_type.startswith("image/"):
        raise _workspace_error(
            status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            "workspace_unsupported_media",
            "仅支持预览图片文件",
        )

    encoded = base64.b64encode(target.read_bytes()).decode("ascii")
    relative = _relative_path(scope, target)
    logger.debug(
        "[WorkspaceAPI] 读取媒体 | "
        f"workspace_id={scope.workspace_id} | path={relative} | "
        f"media_type={media_type} | size={size}"
    )
    return WorkspaceMediaResponse(
        path=relative,
        media_type=media_type,
        size=size,
        data_url=f"data:{media_type};base64,{encoded}",
    )


def _search(scope: WorkspaceRuntimeContext, q: str, limit: int) -> list[WorkspaceSearchResult]:
    base = _resolve(scope, ".")
    if not base.exists() or not base.is_dir():
        raise _workspace_error(
            status.HTTP_404_NOT_FOUND,
            "workspace_path_not_found",
            "工作区不存在",
        )

    query = q.lower()
    results: list[WorkspaceSearchResult] = []
    visited = 0
    started_at = time.perf_counter()
    for current_text, dir_names, file_names in os.walk(base):
        current = Path(current_text)
        dir_names[:] = [name for name in dir_names if not _should_skip_search_dir(name)]
        file_names = [name for name in file_names if not _should_skip_search_file(name)]
        candidates = [
            *(current / name for name in dir_names),
            *(current / name for name in file_names),
        ]
        for candidate in sorted(candidates, key=_entry_sort_key):
            visited += 1
            if (
                visited > MAX_SEARCH_VISITED_PATHS
                or time.perf_counter() - started_at > MAX_SEARCH_SECONDS
            ):
                logger.info(
                    "[WorkspaceAPI] 搜索达到预算提前返回 | "
                    f"workspace_id={scope.workspace_id} | query={q} | results={len(results)} | "
                    f"visited={visited} | limit={limit}"
                )
                return results
            if query not in candidate.name.lower():
                continue
            rel = _relative_path(scope, candidate)
            results.append(
                WorkspaceSearchResult(
                    path=rel,
                    name=candidate.name,
                    type="directory" if candidate.is_dir() else "file",
                )
            )
            if len(results) >= limit:
                logger.debug(
                    "[WorkspaceAPI] 搜索工作区 | "
                    f"workspace_id={scope.workspace_id} | query={q} | "
                    f"results={len(results)} | limit={limit}"
                )
                return results
    logger.debug(
        "[WorkspaceAPI] 搜索工作区 | "
        f"workspace_id={scope.workspace_id} | query={q} | results={len(results)} | limit={limit}"
    )
    return results


def _should_skip_search_dir(name: str) -> bool:
    return name.lower() in IGNORED_DIRS


def _should_skip_search_file(name: str) -> bool:
    lower = name.lower()
    if lower in IGNORED_FILE_NAMES:
        return True
    return any(lower.endswith(suffix) for suffix in IGNORED_FILE_SUFFIXES)


def _resolve(scope: WorkspaceRuntimeContext, path: str) -> Path:
    try:
        return resolve_workspace_path(
            path,
            cwd=scope.cwd,
            workspace_roots=scope.workspace_roots,
        )
    except WorkspacePathError as exc:
        raise _workspace_error(
            status.HTTP_403_FORBIDDEN,
            "workspace_path_forbidden",
            str(exc),
        ) from exc


def _entry_for_path(scope: WorkspaceRuntimeContext, path: Path) -> WorkspaceEntry:
    stat = path.stat()
    return WorkspaceEntry(
        name=path.name,
        path=_relative_path(scope, path),
        type="directory" if path.is_dir() else "file",
        size=None if path.is_dir() else stat.st_size,
        modified_at=None,
    )


def _relative_path(scope: WorkspaceRuntimeContext, path: Path) -> str:
    resolved = path.resolve()
    roots = [scope.cwd, *scope.workspace_roots]
    for root in roots:
        try:
            return resolved.relative_to(root.resolve()).as_posix()
        except ValueError:
            continue
    return resolved.name


def _entry_sort_key(path: Path) -> tuple[int, str]:
    return (0 if path.is_dir() else 1, path.name.lower())


def _service_error(exc: WorkspaceServiceError) -> HTTPException:
    status_code = {
        "workspace_not_found": status.HTTP_404_NOT_FOUND,
        "workspace_deleted": status.HTTP_410_GONE,
        "session_not_workspace": status.HTTP_400_BAD_REQUEST,
        "session_workspace_missing": status.HTTP_400_BAD_REQUEST,
        "session_cwd_forbidden": status.HTTP_403_FORBIDDEN,
        "session_cwd_not_found": status.HTTP_404_NOT_FOUND,
        "session_cwd_not_directory": status.HTTP_400_BAD_REQUEST,
    }.get(exc.code, status.HTTP_400_BAD_REQUEST)
    return _workspace_error(status_code, exc.code, exc.message, exc.details)


def _workspace_error(
    status_code: int,
    code: str,
    message: str,
    details: dict[str, Any] | None = None,
) -> HTTPException:
    return HTTPException(
        status_code=status_code,
        detail={
            "code": code,
            "message": message,
            "details": details or {},
        },
    )
