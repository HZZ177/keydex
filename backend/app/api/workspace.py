from __future__ import annotations

import base64
import mimetypes
import os
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel

from backend.app.api.dependencies import get_repositories
from backend.app.core.logger import logger
from backend.app.security.workspace import WorkspacePathError, resolve_workspace_path
from backend.app.services import WorkspaceRuntimeContext, WorkspaceService, WorkspaceServiceError
from backend.app.storage import StorageRepositories

router = APIRouter(tags=["workspace"])
RepositoriesDep = Depends(get_repositories)

MAX_READ_BYTES = 512 * 1024
MAX_MEDIA_BYTES = 2 * 1024 * 1024
DEFAULT_SEARCH_LIMIT = 30
IGNORED_DIRS = {
    ".git",
    ".venv",
    "node_modules",
    "__pycache__",
    ".mypy_cache",
    ".pytest_cache",
    ".npm-cache",
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
    q: str = Query(..., min_length=1),
    limit: int = Query(DEFAULT_SEARCH_LIMIT, ge=1, le=100),
    repositories: StorageRepositories = RepositoriesDep,
) -> list[WorkspaceSearchResult]:
    scope = _workspace_scope(repositories, workspace_id)
    return _search(scope, q, limit)


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
    q: str = Query(..., min_length=1),
    limit: int = Query(DEFAULT_SEARCH_LIMIT, ge=1, le=100),
    repositories: StorageRepositories = RepositoriesDep,
) -> list[WorkspaceSearchResult]:
    scope = _session_workspace_scope(repositories, session_id)
    return _search(scope, q, limit)


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
    for current_text, dir_names, file_names in os.walk(base):
        current = Path(current_text)
        dir_names[:] = [name for name in dir_names if name not in IGNORED_DIRS]
        candidates = [
            *(current / name for name in dir_names),
            *(current / name for name in file_names),
        ]
        for candidate in sorted(candidates, key=_entry_sort_key):
            rel = _relative_path(scope, candidate)
            if query not in candidate.name.lower() and query not in rel.lower():
                continue
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
