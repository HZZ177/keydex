from __future__ import annotations

from pathlib import Path
from typing import Any

from backend.app.security.workspace import WorkspacePathError, resolve_workspace_path
from backend.app.tools.base import FunctionTool, ToolExecutionContext, ToolExecutionError
from backend.app.tools.registry import ToolRegistry

MAX_READ_BYTES = 512 * 1024
DEFAULT_MAX_LINES = 400


def create_filesystem_tools() -> list[FunctionTool]:
    return [
        FunctionTool(
            name="read_file",
            description="读取当前工作区内的 UTF-8 文本文件。",
            parameters={
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "工作区相对路径或绝对路径"},
                    "start_line": {"type": "integer", "minimum": 1, "default": 1},
                    "max_lines": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 5000,
                        "default": DEFAULT_MAX_LINES,
                    },
                },
                "required": ["path"],
            },
            handler=read_file_tool,
        ),
        FunctionTool(
            name="write_file",
            description="写入当前工作区内的 UTF-8 文本文件，可覆盖或追加。",
            parameters={
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "工作区相对路径或绝对路径"},
                    "content": {"type": "string", "description": "要写入的文本内容"},
                    "append": {"type": "boolean", "default": False},
                },
                "required": ["path", "content"],
            },
            handler=write_file_tool,
        ),
        FunctionTool(
            name="list_directory",
            description="列出当前工作区内目录的直接子项。",
            parameters={
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "目录路径，默认当前工作区"},
                },
            },
            handler=list_directory_tool,
        ),
    ]


def register_filesystem_tools(registry: ToolRegistry) -> ToolRegistry:
    for tool in create_filesystem_tools():
        registry.register(tool)
    return registry


async def read_file_tool(
    args: dict[str, Any],
    context: ToolExecutionContext,
) -> dict[str, Any]:
    path = _resolve(args.get("path"), context)
    if not path.exists():
        raise ToolExecutionError("文件不存在", code="file_not_found", details={"path": str(path)})
    if not path.is_file():
        raise ToolExecutionError("路径不是文件", code="path_not_file", details={"path": str(path)})

    size = path.stat().st_size
    if size > MAX_READ_BYTES:
        raise ToolExecutionError(
            "文件过大，拒绝一次性读取",
            code="file_too_large",
            details={"path": _relative(path, context), "size": size, "max_size": MAX_READ_BYTES},
        )

    try:
        content = path.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        raise ToolExecutionError(
            "文件不是 UTF-8 文本",
            code="file_not_text",
            details={"path": _relative(path, context)},
        ) from exc

    start_line = _positive_int(args.get("start_line"), default=1)
    max_lines = min(_positive_int(args.get("max_lines"), default=DEFAULT_MAX_LINES), 5000)
    lines = content.splitlines(keepends=True)
    if not lines:
        selected = ""
        next_start_line = None
    else:
        start_index = min(start_line - 1, len(lines))
        selected_lines = lines[start_index : start_index + max_lines]
        selected = "".join(selected_lines)
        next_line = start_index + len(selected_lines) + 1
        next_start_line = next_line if next_line <= len(lines) else None

    return {
        "path": _relative(path, context),
        "content": selected,
        "encoding": "utf-8",
        "size": size,
        "start_line": start_line,
        "max_lines": max_lines,
        "total_lines": len(lines),
        "truncated": next_start_line is not None,
        "next_start_line": next_start_line,
    }


async def write_file_tool(
    args: dict[str, Any],
    context: ToolExecutionContext,
) -> dict[str, Any]:
    path = _resolve(args.get("path"), context)
    content = args.get("content")
    if not isinstance(content, str):
        raise ToolExecutionError("content 必须是字符串", code="invalid_tool_args")
    if path.exists() and path.is_dir():
        raise ToolExecutionError("路径是目录，不能写入文件", code="path_is_directory")

    path.parent.mkdir(parents=True, exist_ok=True)
    append = bool(args.get("append", False))
    if append:
        with path.open("a", encoding="utf-8", newline="") as file:
            file.write(content)
    else:
        path.write_text(content, encoding="utf-8", newline="")

    return {
        "path": _relative(path, context),
        "size": path.stat().st_size,
        "append": append,
        "created": True,
    }


async def list_directory_tool(
    args: dict[str, Any],
    context: ToolExecutionContext,
) -> dict[str, Any]:
    path = _resolve(args.get("path") or ".", context)
    if not path.exists():
        raise ToolExecutionError("目录不存在", code="directory_not_found")
    if not path.is_dir():
        raise ToolExecutionError("路径不是目录", code="path_not_directory")

    entries = []
    for child in sorted(
        path.iterdir(),
        key=lambda item: (0 if item.is_dir() else 1, item.name.lower()),
    ):
        stat = child.stat()
        entries.append(
            {
                "name": child.name,
                "path": _relative(child, context),
                "type": "directory" if child.is_dir() else "file",
                "size": None if child.is_dir() else stat.st_size,
            }
        )
    return {"path": _relative(path, context), "entries": entries}


def _resolve(raw_path: Any, context: ToolExecutionContext) -> Path:
    if not isinstance(raw_path, str) or not raw_path.strip():
        raise ToolExecutionError("path 必须是非空字符串", code="invalid_tool_args")
    try:
        return resolve_workspace_path(
            raw_path,
            cwd=context.workspace_root,
            workspace_roots=[context.workspace_root],
        )
    except WorkspacePathError as exc:
        raise ToolExecutionError(
            str(exc),
            code="workspace_path_forbidden",
            details={"path": raw_path},
        ) from exc


def _relative(path: Path, context: ToolExecutionContext) -> str:
    return path.resolve().relative_to(context.workspace_root).as_posix()


def _positive_int(value: Any, *, default: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return max(1, parsed)
