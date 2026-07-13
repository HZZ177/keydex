from __future__ import annotations

import asyncio
import base64
import mimetypes
import subprocess
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any, BinaryIO, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from backend.app.annotations.service import document_revision_bytes
from backend.app.api.dependencies import get_repositories
from backend.app.api.document_read import (
    DEFAULT_PREVIEW_DOCUMENT_MAX_BYTES,
    DocumentReadErrorCode,
    DocumentReadRequest,
    DocumentReadSnapshotError,
    DocumentReadSource,
    create_document_read_response,
    read_stable_utf8_document_snapshot,
)
from backend.app.api.document_read import (
    DocumentReadSnapshot as WorkspaceDocumentSnapshot,
)
from backend.app.core.logger import logger
from backend.app.core.ripgrep import (
    BUNDLED_RIPGREP_BINARY_NAME,
    open_ripgrep_process,
    resolve_ripgrep_binary,
)
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
MAX_PREVIEW_DOCUMENT_BYTES = DEFAULT_PREVIEW_DOCUMENT_MAX_BYTES
MAX_MEDIA_BYTES = 2 * 1024 * 1024
DEFAULT_SEARCH_LIMIT = 100
MAX_SEARCH_SECONDS = 2.0
DEFAULT_SUBTREE_MAX_DEPTH = 6
MAX_SUBTREE_DEPTH = 10
DEFAULT_SUBTREE_MAX_DIRS = 300
MAX_SUBTREE_DIRS = 1000
DEFAULT_SUBTREE_MAX_ENTRIES = 1500
MAX_SUBTREE_ENTRIES = 5000
DEFAULT_SUBTREE_TIMEOUT_MS = 700
MAX_SUBTREE_TIMEOUT_MS = 2500
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


class WorkspaceSubtreeResponse(BaseModel):
    root: str
    path: str
    entries_by_path: dict[str, list[WorkspaceEntry]]
    expanded_paths: list[str]
    truncated: bool
    truncated_reason: Literal["max_depth", "max_dirs", "max_entries", "timeout"] | None = None
    visited_dirs: int
    entry_count: int


class WorkspaceFileResponse(BaseModel):
    path: str
    content: str
    encoding: str
    revision: str


class WorkspaceMediaResponse(BaseModel):
    path: str
    media_type: str
    size: int
    data_url: str


class WorkspaceSearchResult(BaseModel):
    path: str
    name: str
    type: str
    size: int | None = None


@router.get("/api/workspaces/{workspace_id}/tree", response_model=WorkspaceTreeResponse)
async def list_workspace_tree(
    workspace_id: str,
    path: str = "",
    repositories: StorageRepositories = RepositoriesDep,
) -> WorkspaceTreeResponse:
    scope = _workspace_scope(repositories, workspace_id)
    return _list_tree(scope, path)


@router.get("/api/workspaces/{workspace_id}/tree/subtree", response_model=WorkspaceSubtreeResponse)
async def list_workspace_subtree(
    workspace_id: str,
    path: str = "",
    max_depth: int = Query(DEFAULT_SUBTREE_MAX_DEPTH, ge=1, le=MAX_SUBTREE_DEPTH),
    max_dirs: int = Query(DEFAULT_SUBTREE_MAX_DIRS, ge=1, le=MAX_SUBTREE_DIRS),
    max_entries: int = Query(DEFAULT_SUBTREE_MAX_ENTRIES, ge=1, le=MAX_SUBTREE_ENTRIES),
    timeout_ms: int = Query(DEFAULT_SUBTREE_TIMEOUT_MS, ge=100, le=MAX_SUBTREE_TIMEOUT_MS),
    include_files: bool = True,
    repositories: StorageRepositories = RepositoriesDep,
) -> WorkspaceSubtreeResponse:
    scope = _workspace_scope(repositories, workspace_id)
    return await asyncio.to_thread(
        _list_subtree,
        scope,
        path,
        max_depth=max_depth,
        max_dirs=max_dirs,
        max_entries=max_entries,
        timeout_ms=timeout_ms,
        include_files=include_files,
    )


@router.get("/api/workspaces/{workspace_id}/read", response_model=WorkspaceFileResponse)
async def read_workspace_file(
    workspace_id: str,
    path: str = Query(..., min_length=1),
    repositories: StorageRepositories = RepositoriesDep,
) -> WorkspaceFileResponse:
    scope = _workspace_scope(repositories, workspace_id)
    return _read_file(scope, path)


@router.post("/api/workspaces/{workspace_id}/read/document")
async def read_workspace_document(
    workspace_id: str,
    payload: DocumentReadRequest,
    repositories: StorageRepositories = RepositoriesDep,
) -> StreamingResponse:
    scope = _workspace_scope(repositories, workspace_id)
    return await _document_read_response(scope, payload)


@router.get("/api/workspaces/{workspace_id}/media", response_model=WorkspaceMediaResponse)
async def read_workspace_media(
    workspace_id: str,
    path: str = Query(..., min_length=1),
    repositories: StorageRepositories = RepositoriesDep,
) -> WorkspaceMediaResponse:
    scope = _workspace_scope(repositories, workspace_id)
    return _read_media(scope, path)


@router.get(
    "/api/workspaces/{workspace_id}/search",
    response_model=list[WorkspaceSearchResult],
    response_model_exclude_none=True,
)
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


@router.get("/api/sessions/{session_id}/workspace/tree", response_model=WorkspaceTreeResponse)
async def list_session_workspace_tree(
    session_id: str,
    path: str = "",
    repositories: StorageRepositories = RepositoriesDep,
) -> WorkspaceTreeResponse:
    scope = _session_workspace_scope(repositories, session_id)
    return _list_tree(scope, path)


@router.get(
    "/api/sessions/{session_id}/workspace/tree/subtree",
    response_model=WorkspaceSubtreeResponse,
)
async def list_session_workspace_subtree(
    session_id: str,
    path: str = "",
    max_depth: int = Query(DEFAULT_SUBTREE_MAX_DEPTH, ge=1, le=MAX_SUBTREE_DEPTH),
    max_dirs: int = Query(DEFAULT_SUBTREE_MAX_DIRS, ge=1, le=MAX_SUBTREE_DIRS),
    max_entries: int = Query(DEFAULT_SUBTREE_MAX_ENTRIES, ge=1, le=MAX_SUBTREE_ENTRIES),
    timeout_ms: int = Query(DEFAULT_SUBTREE_TIMEOUT_MS, ge=100, le=MAX_SUBTREE_TIMEOUT_MS),
    include_files: bool = True,
    repositories: StorageRepositories = RepositoriesDep,
) -> WorkspaceSubtreeResponse:
    scope = _session_workspace_scope(repositories, session_id)
    return await asyncio.to_thread(
        _list_subtree,
        scope,
        path,
        max_depth=max_depth,
        max_dirs=max_dirs,
        max_entries=max_entries,
        timeout_ms=timeout_ms,
        include_files=include_files,
    )


@router.get("/api/sessions/{session_id}/workspace/read", response_model=WorkspaceFileResponse)
async def read_session_workspace_file(
    session_id: str,
    path: str = Query(..., min_length=1),
    repositories: StorageRepositories = RepositoriesDep,
) -> WorkspaceFileResponse:
    scope = _session_workspace_scope(repositories, session_id)
    return _read_file(scope, path)


@router.post("/api/sessions/{session_id}/workspace/read/document")
async def read_session_workspace_document(
    session_id: str,
    payload: DocumentReadRequest,
    repositories: StorageRepositories = RepositoriesDep,
) -> StreamingResponse:
    scope = _session_workspace_scope(repositories, session_id)
    return await _document_read_response(scope, payload)


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
    response_model_exclude_none=True,
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
        _entry_for_path(scope, child) for child in sorted(target.iterdir(), key=_entry_sort_key)
    ]
    logger.debug(
        "[WorkspaceAPI] 列出目录 | "
        f"workspace_id={scope.workspace_id} | path={path or '.'} | entries={len(entries)}"
    )
    return WorkspaceTreeResponse(root=str(scope.cwd), entries=entries)


def _list_subtree(
    scope: WorkspaceRuntimeContext,
    path: str,
    *,
    max_depth: int,
    max_dirs: int,
    max_entries: int,
    timeout_ms: int,
    include_files: bool,
) -> WorkspaceSubtreeResponse:
    target = _resolve(scope, path or ".")
    if not target.exists():
        raise _workspace_error(status.HTTP_404_NOT_FOUND, "workspace_path_not_found", "目录不存在")
    if not target.is_dir():
        raise _workspace_error(
            status.HTTP_400_BAD_REQUEST,
            "workspace_not_directory",
            "路径不是目录",
        )

    root_path = _tree_map_key(scope, target)
    queue: deque[tuple[Path, int]] = deque([(target, 0)])
    seen_dirs = {_resolved_path_key(target)}
    entries_by_path: dict[str, list[WorkspaceEntry]] = {}
    expanded_paths: list[str] = []
    truncated_reason: Literal["max_depth", "max_dirs", "max_entries", "timeout"] | None = None
    visited_dirs = 0
    entry_count = 0
    deadline = time.monotonic() + timeout_ms / 1000

    while queue:
        if time.monotonic() >= deadline:
            truncated_reason = truncated_reason or "timeout"
            break
        if visited_dirs >= max_dirs:
            truncated_reason = truncated_reason or "max_dirs"
            break

        directory, depth = queue.popleft()
        directory_key = _tree_map_key(scope, directory)
        visited_dirs += 1

        try:
            children = sorted(directory.iterdir(), key=_entry_sort_key)
        except OSError as exc:
            logger.warning(
                "[WorkspaceAPI] 子树目录读取失败 | "
                f"workspace_id={scope.workspace_id} | path={directory_key or '.'} | error={exc}"
            )
            entries_by_path[directory_key] = []
            expanded_paths.append(directory_key)
            continue

        if not include_files:
            children = [child for child in children if _is_directory_entry(child)]

        remaining_entries = max_entries - entry_count
        if remaining_entries <= 0:
            truncated_reason = truncated_reason or "max_entries"
            break
        if len(children) > remaining_entries:
            children = children[:remaining_entries]
            truncated_reason = truncated_reason or "max_entries"

        entries_by_path[directory_key] = [_entry_for_path(scope, child) for child in children]
        expanded_paths.append(directory_key)
        entry_count += len(children)

        if truncated_reason == "max_entries":
            break
        if depth >= max_depth:
            if any(_can_descend_for_subtree(child) for child in children):
                truncated_reason = truncated_reason or "max_depth"
            continue

        for child in children:
            if not _can_descend_for_subtree(child):
                continue
            child_key = _resolved_path_key(child)
            if child_key in seen_dirs:
                continue
            seen_dirs.add(child_key)
            queue.append((child, depth + 1))

    logger.debug(
        "[WorkspaceAPI] 列出目录子树 | "
        f"workspace_id={scope.workspace_id} | path={root_path or '.'} | "
        f"visited_dirs={visited_dirs} | entries={entry_count} | truncated={bool(truncated_reason)}"
    )
    return WorkspaceSubtreeResponse(
        root=str(scope.cwd),
        path=root_path,
        entries_by_path=entries_by_path,
        expanded_paths=expanded_paths,
        truncated=truncated_reason is not None,
        truncated_reason=truncated_reason,
        visited_dirs=visited_dirs,
        entry_count=entry_count,
    )


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
    raw_content = target.read_bytes()
    try:
        content = raw_content.decode("utf-8")
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
    return WorkspaceFileResponse(
        path=relative,
        content=content,
        encoding="utf-8",
        revision=document_revision_bytes(raw_content),
    )


async def _document_read_response(
    scope: WorkspaceRuntimeContext,
    payload: DocumentReadRequest,
) -> StreamingResponse:
    if payload.source is not DocumentReadSource.WORKSPACE:
        raise _workspace_error(
            status.HTTP_400_BAD_REQUEST,
            "invalid_request",
            "Workspace document endpoint requires source=workspace",
            {"retryable": False},
        )

    effective_max_bytes = min(payload.max_bytes, MAX_PREVIEW_DOCUMENT_BYTES)
    snapshot = await asyncio.to_thread(
        _read_document_snapshot,
        scope,
        payload.path,
        effective_max_bytes,
    )
    if payload.expected_revision and payload.expected_revision != snapshot.revision:
        raise _workspace_error(
            status.HTTP_409_CONFLICT,
            "revision_conflict",
            "Document revision no longer matches the requested revision",
            {
                "retryable": True,
                "expected_revision": payload.expected_revision,
                "actual_revision": snapshot.revision,
            },
        )

    return create_document_read_response(payload, snapshot)


def _read_document_snapshot(
    scope: WorkspaceRuntimeContext,
    path: str,
    max_bytes: int,
) -> WorkspaceDocumentSnapshot:
    target = _resolve(scope, path)
    try:
        return read_stable_utf8_document_snapshot(
            target,
            public_path=_relative_path(scope, target),
            max_bytes=max_bytes,
            open_file=_open_document_file,
            read_open_file=_read_open_document,
        )
    except DocumentReadSnapshotError as exc:
        status_code = {
            DocumentReadErrorCode.NOT_FOUND: status.HTTP_404_NOT_FOUND,
            DocumentReadErrorCode.TOO_LARGE: status.HTTP_413_CONTENT_TOO_LARGE,
            DocumentReadErrorCode.UNSUPPORTED_ENCODING: status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            DocumentReadErrorCode.CHANGED_DURING_READ: status.HTTP_409_CONFLICT,
            DocumentReadErrorCode.INVALID_REQUEST: status.HTTP_400_BAD_REQUEST,
            DocumentReadErrorCode.IO_ERROR: (
                status.HTTP_500_INTERNAL_SERVER_ERROR
                if exc.retryable
                else status.HTTP_403_FORBIDDEN
            ),
        }.get(exc.code, status.HTTP_500_INTERNAL_SERVER_ERROR)
        details = {"retryable": exc.retryable, **exc.details}
        if exc.code is DocumentReadErrorCode.TOO_LARGE:
            details["server_max_bytes"] = MAX_PREVIEW_DOCUMENT_BYTES
        raise _workspace_error(status_code, exc.code.value, exc.message, details) from exc


def _open_document_file(target: Path) -> BinaryIO:
    return target.open("rb")


def _read_open_document(handle: BinaryIO, limit: int) -> bytes:
    return handle.read(limit)


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

    file_paths, truncated, visited = _workspace_rg_file_paths(base)
    results = _workspace_search_results_from_paths(base, file_paths, q, limit)
    if truncated:
        logger.info(
            "[WorkspaceAPI] 搜索达到预算提前返回 | "
            f"workspace_id={scope.workspace_id} | query={q} | results={len(results)} | "
            f"visited={visited} | limit={limit}"
        )
    else:
        logger.debug(
            "[WorkspaceAPI] 搜索工作区 | "
            f"workspace_id={scope.workspace_id} | query={q} | "
            f"results={len(results)} | limit={limit}"
        )
    return results


def _workspace_rg_file_paths(base: Path) -> tuple[list[str], bool, int]:
    rg = resolve_ripgrep_binary()
    if rg is None:
        raise _workspace_error(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "workspace_search_engine_unavailable",
            "未找到项目内置 ripgrep (rg)，无法搜索工作区",
            {"engine": "ripgrep", "required_binary": BUNDLED_RIPGREP_BINARY_NAME},
        )
    try:
        process = open_ripgrep_process([rg, *_workspace_rg_file_args()], cwd=base)
    except OSError as exc:
        raise _workspace_error(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "workspace_search_engine_unavailable",
            f"启动 ripgrep 失败：{exc}",
            {"engine": "ripgrep"},
        ) from exc

    paths: list[str] = []
    truncated = False
    timed_out = False
    assert process.stdout is not None
    assert process.stderr is not None

    def kill_after_timeout() -> None:
        nonlocal timed_out
        timed_out = True
        _kill_process(process)

    timer = threading.Timer(MAX_SEARCH_SECONDS, kill_after_timeout)
    timer.start()
    try:
        for line in process.stdout:
            rel = _normalize_rg_file_path(line)
            if rel:
                paths.append(rel)
        process.wait()
    finally:
        timer.cancel()

    stderr = process.stderr.read()
    if timed_out:
        truncated = True
    if process.returncode not in (0, 1, None) and not truncated:
        message = stderr.strip() or "ripgrep 工作区搜索失败"
        raise _workspace_error(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            "workspace_search_failed",
            message,
            {"engine": "ripgrep"},
        )
    return paths, truncated, len(paths)


def _workspace_rg_file_args() -> list[str]:
    args = [
        "--files",
        "--hidden",
        "--no-ignore",
        "--no-messages",
        "--color",
        "never",
    ]
    for name in sorted(IGNORED_DIRS):
        args.extend(["--iglob", f"!{name}/**", "--iglob", f"!**/{name}/**"])
    for name in sorted(IGNORED_FILE_NAMES):
        args.extend(["--iglob", f"!{name}", "--iglob", f"!**/{name}"])
    for suffix in sorted(IGNORED_FILE_SUFFIXES):
        args.extend(["--iglob", f"!**/*{suffix}"])
    return args


def _workspace_search_results_from_paths(
    base: Path,
    file_paths: list[str],
    q: str,
    limit: int,
) -> list[WorkspaceSearchResult]:
    query = q.lower()
    entries = _workspace_search_entries_from_paths(file_paths)
    results: list[WorkspaceSearchResult] = []
    for path, entry_type in _workspace_search_ordered_entries(entries):
        name = path.rsplit("/", 1)[-1]
        if query not in name.lower():
            continue
        results.append(
            WorkspaceSearchResult(
                path=path,
                name=name,
                type=entry_type,
                size=_workspace_search_result_size(base, path, entry_type),
            )
        )
        if len(results) >= limit:
            return results
    return results


def _workspace_search_result_size(base: Path, path: str, entry_type: str) -> int | None:
    if entry_type != "file":
        return None
    try:
        target = base / Path(path)
        if not target.is_file():
            return None
        return target.stat().st_size
    except OSError:
        return None


def _workspace_search_entries_from_paths(file_paths: list[str]) -> dict[str, str]:
    entries: dict[str, str] = {}
    for path in file_paths:
        parts = [part for part in path.split("/") if part and part != "."]
        if not parts or _has_ignored_search_dir(parts[:-1]) or _should_skip_search_file(parts[-1]):
            continue
        ancestors: list[str] = []
        for part in parts[:-1]:
            ancestors.append(part)
            entries.setdefault("/".join(ancestors), "directory")
        entries.setdefault("/".join(parts), "file")
    return entries


def _workspace_search_ordered_entries(entries: dict[str, str]) -> list[tuple[str, str]]:
    children_by_parent: dict[str, list[tuple[str, str]]] = {}
    for path, entry_type in entries.items():
        parent = path.rsplit("/", 1)[0] if "/" in path else ""
        children_by_parent.setdefault(parent, []).append((path, entry_type))

    ordered: list[tuple[str, str]] = []

    def visit(parent: str) -> None:
        children = sorted(children_by_parent.get(parent, []), key=_search_entry_sort_key)
        ordered.extend(children)
        for child_path, child_type in children:
            if child_type == "directory":
                visit(child_path)

    visit("")
    return ordered


def _search_entry_sort_key(item: tuple[str, str]) -> tuple[int, str]:
    path, entry_type = item
    name = path.rsplit("/", 1)[-1]
    return (0 if entry_type == "directory" else 1, name.lower())


def _normalize_rg_file_path(line: str) -> str:
    path = line.strip().replace("\\", "/")
    while path.startswith("./"):
        path = path[2:]
    if not path or path == "." or path.startswith("../") or "/../" in path:
        return ""
    return path


def _has_ignored_search_dir(parts: list[str]) -> bool:
    return any(_should_skip_search_dir(part) for part in parts)


def _kill_process(process: subprocess.Popen[str]) -> None:
    try:
        process.kill()
    except OSError:
        pass


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


def _tree_map_key(scope: WorkspaceRuntimeContext, path: Path) -> str:
    relative = _relative_path(scope, path)
    return "" if relative == "." else relative


def _resolved_path_key(path: Path) -> str:
    try:
        return str(path.resolve())
    except OSError:
        return str(path.absolute())


def _is_directory_entry(path: Path) -> bool:
    try:
        return path.is_dir()
    except OSError:
        return False


def _can_descend_for_subtree(path: Path) -> bool:
    if _should_skip_search_dir(path.name):
        return False
    try:
        return path.is_dir() and not path.is_symlink()
    except OSError:
        return False


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
