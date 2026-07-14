from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from backend.app.agent.tool_call_progress import (
    build_text_diff,
    count_text_lines,
    normalize_file_change,
)
from backend.app.core.logger import logger
from backend.app.tools.base import FunctionTool, ToolExecutionContext, ToolExecutionError
from backend.app.tools.file_access import (
    FileAccessOperation,
    relative_tool_path,
    resolve_file_access_path,
)
from backend.app.tools.file_history import tracked_file_mutation
from backend.app.tools.file_snapshots import record_file_snapshot
from backend.app.tools.registry import ToolRegistry

MAX_READ_BYTES = 512 * 1024
DEFAULT_MAX_LINES = 400
MAX_MAX_LINES = 5000
MAX_NUMBERED_LINE_CHARS = 2000
DEFAULT_LIST_LIMIT = 200
MAX_LIST_LIMIT = 1000
MAX_LIST_DEPTH = 5

IGNORED_DIRS = {
    ".git",
    ".venv",
    "node_modules",
    "__pycache__",
    ".mypy_cache",
    ".pytest_cache",
    ".npm-cache",
}

READ_FILE_DESCRIPTION = (
    "读取文件访问权限允许范围内的 UTF-8 文本文件，支持从 1 开始的行号窗口。"
    "当目标文件已知或已定位时使用。返回原始 content、带行号的 numbered_content、"
    "总行数、截断信息和用于继续分页的 next_start_line。"
)

CREATE_FILE_DESCRIPTION = (
    "在文件访问权限允许范围内创建新的 UTF-8 文本文件，并返回文件变更 diff。"
    "目标文件已存在时会失败；修改已有文件请使用 edit_file，"
    "删除或移动已有文件请使用 delete_file/move_file。"
)

LIST_DIR_DESCRIPTION = (
    "以有界目录树形式列出文件访问权限允许范围内的目录。适合了解陌生目录、项目布局或目录下有哪些资源。"
    "支持 depth、offset、limit，返回结构化 entries 和便于模型阅读的 tree 文本。"
)


@dataclass(frozen=True)
class DirectoryEntry:
    name: str
    path: str
    type: str
    depth: int
    size: int | None

    def to_result(self, *, include_depth: bool = True) -> dict[str, Any]:
        result: dict[str, Any] = {
            "name": self.name,
            "path": self.path,
            "type": self.type,
            "size": self.size,
        }
        if include_depth:
            result["depth"] = self.depth
        return result


@dataclass(frozen=True)
class DirectoryEntryCollection:
    entries: list[DirectoryEntry]
    truncated: bool


def create_filesystem_tools() -> list[FunctionTool]:
    return [
        FunctionTool(
            name="read_file",
            description=READ_FILE_DESCRIPTION,
            parameters={
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "工作区相对路径；完全访问时也可使用绝对文件路径。",
                    },
                    "start_line": {
                        "type": "integer",
                        "minimum": 1,
                        "default": 1,
                        "description": "要返回的起始行号，从 1 开始。",
                    },
                    "max_lines": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": MAX_MAX_LINES,
                        "default": DEFAULT_MAX_LINES,
                        "description": "最多返回的行数。",
                    },
                    "mode": {
                        "type": "string",
                        "enum": ["window", "indentation"],
                        "default": "window",
                        "description": (
                            "window 返回指定行范围；"
                            "indentation 会围绕 anchor_line 扩展同缩进代码块。"
                        ),
                    },
                    "anchor_line": {
                        "type": "integer",
                        "minimum": 1,
                        "description": "mode=indentation 使用的锚点行，默认使用 start_line。",
                    },
                },
                "required": ["path"],
            },
            handler=read_file_tool,
        ),
        FunctionTool(
            name="create_file",
            description=CREATE_FILE_DESCRIPTION,
            parameters={
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "工作区相对路径；完全访问时也可使用绝对文件路径。",
                    },
                    "content": {"type": "string", "description": "要写入的 UTF-8 文本内容。"},
                },
                "required": ["path", "content"],
            },
            handler=write_file_tool,
        ),
        FunctionTool(
            name="list_dir",
            description=LIST_DIR_DESCRIPTION,
            parameters={
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": (
                            "工作区目录路径，默认工作区根目录；"
                            "完全访问时也可使用绝对目录路径。"
                        ),
                    },
                    "depth": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": MAX_LIST_DEPTH,
                        "default": 2,
                        "description": "最多包含的目录深度。直接子项的 depth 为 1。",
                    },
                    "limit": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": MAX_LIST_LIMIT,
                        "default": DEFAULT_LIST_LIMIT,
                        "description": "应用 offset 后最多返回的条目数。",
                    },
                    "offset": {
                        "type": "integer",
                        "minimum": 0,
                        "default": 0,
                        "description": "分页时跳过的扁平条目数量。",
                    },
                    "include_hidden": {
                        "type": "boolean",
                        "default": False,
                        "description": "是否包含隐藏文件和目录。高开销忽略目录仍会跳过。",
                    },
                },
            },
            handler=list_dir_tool,
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
    path = _resolve(args.get("path"), context, operation="read")
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

    mode = _read_mode(args.get("mode"))
    start_line = _positive_int(args.get("start_line"), default=1)
    max_lines = min(
        _positive_int(args.get("max_lines"), default=DEFAULT_MAX_LINES),
        MAX_MAX_LINES,
    )
    lines = content.splitlines(keepends=True)

    if mode == "indentation" and lines:
        anchor_line = _positive_int(args.get("anchor_line"), default=start_line)
        start_line, max_lines = _indentation_window(
            lines,
            anchor_line=anchor_line,
            max_lines=max_lines,
        )

    selected, returned_lines, next_start_line = _select_lines(
        lines,
        start_line=start_line,
        max_lines=max_lines,
    )
    numbered_content = _numbered_content(
        lines,
        start_line=start_line,
        max_lines=max_lines,
    )

    relative = _relative(path, context)
    full_read = mode == "window" and start_line == 1 and next_start_line is None
    record_file_snapshot(
        path,
        context=context,
        content=content,
        full_read=full_read,
    )
    logger.info(
        "[FilesystemTool] 读取文件 | "
        f"path={relative} | size={size} | mode={mode} | start_line={start_line} | "
        f"max_lines={max_lines} | returned_lines={returned_lines} | "
        f"truncated={next_start_line is not None} | full_read_snapshot={full_read}"
    )
    return {
        "path": relative,
        "content": selected,
        "numbered_content": numbered_content,
        "encoding": "utf-8",
        "size": size,
        "start_line": start_line,
        "max_lines": max_lines,
        "total_lines": len(lines),
        "returned_lines": returned_lines,
        "truncated": next_start_line is not None,
        "next_start_line": next_start_line,
        "mode": mode,
    }


async def write_file_tool(
    args: dict[str, Any],
    context: ToolExecutionContext,
) -> dict[str, Any]:
    path = _resolve(args.get("path"), context, operation="write")
    content = args.get("content")
    if not isinstance(content, str):
        raise ToolExecutionError("content 必须是字符串", code="invalid_tool_args")
    if path.exists() and path.is_dir():
        raise ToolExecutionError("路径是目录，不能写入文件", code="path_is_directory")

    existed = path.exists()
    if existed:
        raise ToolExecutionError(
            "文件已存在，create_file 只用于创建新文件；修改已有文件请使用 edit_file",
            code="file_exists",
            details={"path": _relative(path, context)},
        )

    with tracked_file_mutation(
        context, tool_name="create_file", changes=((path, "create"),)
    ):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8", newline="")

    relative = _relative(path, context)
    size = path.stat().st_size
    new_content = path.read_text(encoding="utf-8")
    change = _write_file_change(
        path=relative,
        new_content=new_content,
    )
    record_file_snapshot(
        path,
        context=context,
        content=new_content,
        full_read=True,
    )
    logger.info(
        "[FilesystemTool] 写入文件 | "
        f"path={relative} | size={size} | change_type=create | content_chars={len(content)}"
    )
    return {
        "path": relative,
        "size": size,
        "created": True,
        "change_type": "create",
        **change,
        "files": [change],
    }


async def list_dir_tool(
    args: dict[str, Any],
    context: ToolExecutionContext,
) -> dict[str, Any]:
    path = _resolve(args.get("path") or ".", context, operation="read")
    if not path.exists():
        raise ToolExecutionError("目录不存在", code="directory_not_found")
    if not path.is_dir():
        raise ToolExecutionError("路径不是目录", code="path_not_directory")

    depth = min(_positive_int(args.get("depth"), default=2), MAX_LIST_DEPTH)
    limit = min(_positive_int(args.get("limit"), default=DEFAULT_LIST_LIMIT), MAX_LIST_LIMIT)
    offset = _non_negative_int(args.get("offset"), default=0)
    include_hidden = bool(args.get("include_hidden", False))

    collected = _collect_directory_entries(
        path,
        context=context,
        max_depth=depth,
        include_hidden=include_hidden,
        max_entries=offset + limit + 1,
    )
    all_entries = collected.entries
    selected = all_entries[offset : offset + limit]
    has_more = collected.truncated or offset + len(selected) < len(all_entries)
    next_offset = offset + len(selected) if selected and has_more else None
    result_entries = [entry.to_result() for entry in selected]
    relative = _relative(path, context)
    result = {
        "path": relative or ".",
        "entries": result_entries,
        "tree": _tree_text(relative or ".", selected),
        "depth": depth,
        "offset": offset,
        "limit": limit,
        "total_entries": len(all_entries),
        "total_entries_exact": not collected.truncated,
        "truncated": next_offset is not None,
        "next_offset": next_offset,
    }
    logger.info(
        "[FilesystemTool] 列出目录树 | "
        f"path={relative or '.'} | depth={depth} | entries={len(result_entries)} | "
        f"collected_entries={len(all_entries)} | total_entries_exact={not collected.truncated} | "
        f"truncated={result['truncated']}"
    )
    return result


def _resolve(
    raw_path: Any,
    context: ToolExecutionContext,
    *,
    operation: FileAccessOperation,
) -> Path:
    return resolve_file_access_path(raw_path, context, operation=operation)


def _relative(path: Path, context: ToolExecutionContext) -> str:
    return relative_tool_path(path, context)


def _positive_int(value: Any, *, default: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return max(1, parsed)


def _non_negative_int(value: Any, *, default: int) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return max(0, parsed)


def _read_mode(value: Any) -> str:
    if value in (None, "", "window"):
        return "window"
    if value == "indentation":
        return "indentation"
    raise ToolExecutionError(
        "mode 必须是 window 或 indentation",
        code="invalid_tool_args",
        details={"mode": value},
    )


def _select_lines(
    lines: list[str],
    *,
    start_line: int,
    max_lines: int,
) -> tuple[str, int, int | None]:
    if not lines:
        return "", 0, None
    start_index = min(start_line - 1, len(lines))
    selected_lines = lines[start_index : start_index + max_lines]
    next_line = start_index + len(selected_lines) + 1
    next_start_line = next_line if next_line <= len(lines) else None
    return "".join(selected_lines), len(selected_lines), next_start_line


def _numbered_content(lines: list[str], *, start_line: int, max_lines: int) -> str:
    if not lines:
        return ""
    start_index = min(start_line - 1, len(lines))
    selected = lines[start_index : start_index + max_lines]
    width = max(len(str(start_index + len(selected))), len(str(start_line)))
    numbered: list[str] = []
    for offset, line in enumerate(selected):
        line_number = start_index + offset + 1
        value = line
        if len(value) > MAX_NUMBERED_LINE_CHARS:
            value = f"{value[:MAX_NUMBERED_LINE_CHARS]}...[本行已截断]\n"
        suffix = "" if value.endswith("\n") else "\n"
        numbered.append(f"{line_number:>{width}}: {value}{suffix}")
    return "".join(numbered)


def _indentation_window(
    lines: list[str],
    *,
    anchor_line: int,
    max_lines: int,
) -> tuple[int, int]:
    anchor_index = min(max(anchor_line - 1, 0), len(lines) - 1)
    base_indent = _line_indent(lines[anchor_index])
    start = anchor_index
    while start > 0:
        previous = lines[start - 1]
        if previous.strip() == "":
            start -= 1
            continue
        previous_indent = _line_indent(previous)
        if previous_indent < base_indent:
            break
        if previous_indent == base_indent and start - 1 != anchor_index:
            break
        start -= 1

    end = anchor_index + 1
    while end < len(lines):
        current = lines[end]
        if current.strip() == "":
            end += 1
            continue
        current_indent = _line_indent(current)
        if current_indent <= base_indent:
            break
        end += 1

    return start + 1, min(max_lines, max(1, end - start))


def _line_indent(line: str) -> int:
    expanded = line.expandtabs(4)
    return len(expanded) - len(expanded.lstrip(" "))


def _collect_directory_entries(
    root: Path,
    *,
    context: ToolExecutionContext,
    max_depth: int,
    include_hidden: bool,
    max_entries: int,
) -> DirectoryEntryCollection:
    entries: list[DirectoryEntry] = []
    truncated = False

    def visit(directory: Path, depth: int) -> None:
        nonlocal truncated
        if truncated:
            return
        if depth > max_depth:
            return
        children = _sorted_children(directory, include_hidden=include_hidden)
        for child in children:
            if len(entries) >= max_entries:
                truncated = True
                return
            try:
                stat = child.stat()
            except OSError:
                continue
            child_type = "directory" if child.is_dir() else "file"
            entries.append(
                DirectoryEntry(
                    name=child.name,
                    path=_relative(child, context),
                    type=child_type,
                    depth=depth,
                    size=None if child.is_dir() else stat.st_size,
                )
            )
            if child.is_dir() and depth < max_depth and child.name not in IGNORED_DIRS:
                visit(child, depth + 1)
            if truncated:
                return

    visit(root, 1)
    return DirectoryEntryCollection(entries=entries, truncated=truncated)


def _sorted_children(directory: Path, *, include_hidden: bool) -> list[Path]:
    try:
        children = list(directory.iterdir())
    except OSError:
        return []
    filtered = [child for child in children if _include_child(child, include_hidden=include_hidden)]
    return sorted(filtered, key=lambda item: (0 if item.is_dir() else 1, item.name.lower()))


def _include_child(path: Path, *, include_hidden: bool) -> bool:
    if path.name in IGNORED_DIRS:
        return False
    if not include_hidden and path.name.startswith("."):
        return False
    return True


def _tree_text(root_label: str, entries: list[DirectoryEntry]) -> str:
    lines = [f"{root_label}/"]
    for entry in entries:
        indent = "  " * max(entry.depth - 1, 0)
        suffix = "/" if entry.type == "directory" else ""
        lines.append(f"{indent}{entry.name}{suffix}")
    return "\n".join(lines)


def _write_file_change(
    *,
    path: str,
    new_content: str,
) -> dict[str, Any]:
    change = normalize_file_change(
        path=path,
        operation="add",
        added_lines=count_text_lines(new_content),
        deleted_lines=0,
        diff=build_text_diff(path=path, before="", after=new_content, operation="add"),
    )
    change["change_type"] = "create"
    return change
