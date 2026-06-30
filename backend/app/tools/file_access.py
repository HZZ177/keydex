from __future__ import annotations

from pathlib import Path
from typing import Any, Literal

from backend.app.command_approval import FileAccessMode, load_command_settings
from backend.app.security.workspace import (
    WorkspacePathError,
    is_relative_to,
    resolve_workspace_path,
)
from backend.app.storage import StorageRepositories
from backend.app.tools.base import ToolExecutionContext, ToolExecutionError

FileAccessOperation = Literal["read", "write"]

VALID_FILE_ACCESS_MODES: set[str] = {
    "no_file_access",
    "workspace_read_only",
    "workspace_trusted",
    "full_access",
}


def resolve_file_access_path(
    raw_path: Any,
    context: ToolExecutionContext,
    *,
    operation: FileAccessOperation,
) -> Path:
    if not isinstance(raw_path, str) or not raw_path.strip():
        raise ToolExecutionError("path 必须是非空字符串", code="invalid_tool_args")
    mode = file_access_mode(context)
    _ensure_operation_allowed(mode, operation)
    if mode == "full_access":
        return _resolve_any_path(raw_path, context)
    try:
        return resolve_workspace_path(
            raw_path,
            cwd=context.workspace_root,
            workspace_roots=workspace_roots(context),
        )
    except WorkspacePathError as exc:
        raise ToolExecutionError(
            str(exc),
            code="workspace_path_forbidden",
            details={"path": raw_path},
        ) from exc


def relative_tool_path(path: Path, context: ToolExecutionContext) -> str:
    resolved = path.resolve()
    for root in workspace_roots(context):
        if is_relative_to(resolved, root):
            rel = resolved.relative_to(root).as_posix()
            return rel or "."
    return resolved.as_posix()


def file_access_mode(context: ToolExecutionContext) -> FileAccessMode:
    raw_mode = context.metadata.get("file_access_mode")
    if isinstance(raw_mode, str) and raw_mode in VALID_FILE_ACCESS_MODES:
        return raw_mode  # type: ignore[return-value]
    repositories = _repositories(context)
    if repositories is None:
        return "workspace_trusted"
    return load_command_settings(repositories).file_access_mode


def workspace_roots(context: ToolExecutionContext) -> list[Path]:
    raw_roots = context.metadata.get("workspace_roots")
    candidates: list[Any]
    if isinstance(raw_roots, list):
        candidates = [context.workspace_root, *raw_roots]
    else:
        candidates = [context.workspace_root]
    roots: list[Path] = []
    for candidate in candidates:
        try:
            root = Path(candidate).expanduser().resolve()
        except (TypeError, OSError):
            continue
        if root not in roots:
            roots.append(root)
    return roots or [context.workspace_root]


def _ensure_operation_allowed(mode: FileAccessMode, operation: FileAccessOperation) -> None:
    if mode == "no_file_access":
        raise ToolExecutionError(
            "文件访问权限已关闭",
            code="file_access_disabled",
            details={"file_access_mode": mode},
        )
    if operation == "write" and mode == "workspace_read_only":
        raise ToolExecutionError(
            "当前文件访问权限为工作区内只读，不能修改文件",
            code="file_write_forbidden",
            details={"file_access_mode": mode},
        )


def _resolve_any_path(raw_path: str, context: ToolExecutionContext) -> Path:
    path = Path(raw_path).expanduser()
    if not path.is_absolute():
        path = context.workspace_root / path
    try:
        return path.resolve()
    except OSError as exc:
        raise ToolExecutionError(
            str(exc) or "路径解析失败",
            code="path_resolve_failed",
            details={"path": raw_path},
        ) from exc


def _repositories(context: ToolExecutionContext) -> StorageRepositories | None:
    value = context.metadata.get("repositories")
    return value if isinstance(value, StorageRepositories) else None
