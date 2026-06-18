from __future__ import annotations

import base64
import mimetypes
import os
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel

from backend.app.security.workspace import WorkspacePathError, resolve_workspace_path

router = APIRouter(prefix="/api/workspace", tags=["workspace"])

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


@router.get("/tree", response_model=WorkspaceTreeResponse)
async def list_tree(
    root: str = Query(..., min_length=1),
    path: str = "",
) -> WorkspaceTreeResponse:
    target = _resolve(root, path or ".")
    if not target.exists():
        raise _workspace_error(status.HTTP_404_NOT_FOUND, "workspace_path_not_found", "目录不存在")
    if not target.is_dir():
        raise _workspace_error(
            status.HTTP_400_BAD_REQUEST,
            "workspace_not_directory",
            "路径不是目录",
        )

    entries = [
        _entry_for_path(root, child)
        for child in sorted(target.iterdir(), key=_entry_sort_key)
    ]
    return WorkspaceTreeResponse(root=str(Path(root).expanduser().resolve()), entries=entries)


@router.get("/read", response_model=WorkspaceFileResponse)
async def read_file(
    root: str = Query(..., min_length=1),
    path: str = Query(..., min_length=1),
) -> WorkspaceFileResponse:
    target = _resolve(root, path)
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
    return WorkspaceFileResponse(
        path=_relative_path(root, target),
        content=content,
        encoding="utf-8",
    )


@router.get("/media", response_model=WorkspaceMediaResponse)
async def read_media(
    root: str = Query(..., min_length=1),
    path: str = Query(..., min_length=1),
) -> WorkspaceMediaResponse:
    target = _resolve(root, path)
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
    return WorkspaceMediaResponse(
        path=_relative_path(root, target),
        media_type=media_type,
        size=size,
        data_url=f"data:{media_type};base64,{encoded}",
    )


@router.get("/search", response_model=list[WorkspaceSearchResult])
async def search_workspace(
    root: str = Query(..., min_length=1),
    q: str = Query(..., min_length=1),
    limit: int = Query(DEFAULT_SEARCH_LIMIT, ge=1, le=100),
) -> list[WorkspaceSearchResult]:
    base = _resolve(root, ".")
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
            rel = _relative_path(root, candidate)
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
                return results
    return results


def _resolve(root: str, path: str) -> Path:
    try:
        return resolve_workspace_path(path, cwd=root, workspace_roots=[root])
    except WorkspacePathError as exc:
        raise _workspace_error(
            status.HTTP_403_FORBIDDEN,
            "workspace_path_forbidden",
            str(exc),
        ) from exc


def _entry_for_path(root: str, path: Path) -> WorkspaceEntry:
    stat = path.stat()
    return WorkspaceEntry(
        name=path.name,
        path=_relative_path(root, path),
        type="directory" if path.is_dir() else "file",
        size=None if path.is_dir() else stat.st_size,
        modified_at=None,
    )


def _relative_path(root: str, path: Path) -> str:
    return str(path.resolve().relative_to(Path(root).expanduser().resolve())).replace("\\", "/")


def _entry_sort_key(path: Path) -> tuple[int, str]:
    return (0 if path.is_dir() else 1, path.name.lower())


def _workspace_error(status_code: int, code: str, message: str) -> HTTPException:
    return HTTPException(
        status_code=status_code,
        detail={
            "code": code,
            "message": message,
            "details": {},
        },
    )
