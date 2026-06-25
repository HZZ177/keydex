from __future__ import annotations

import fnmatch
import os
import re
from collections.abc import Callable
from pathlib import Path
from typing import Any

from backend.app.core.logger import logger
from backend.app.security.workspace import WorkspacePathError, resolve_workspace_path
from backend.app.tools.base import FunctionTool, ToolExecutionContext, ToolExecutionError
from backend.app.tools.registry import ToolRegistry

IGNORED_DIRS = {
    ".git",
    ".venv",
    "node_modules",
    "__pycache__",
    ".mypy_cache",
    ".pytest_cache",
    ".npm-cache",
}
DEFAULT_SEARCH_LIMIT = 50
MAX_SEARCH_LIMIT = 200
DEFAULT_GREP_FILE_LIMIT = 50
MAX_GREP_FILE_LIMIT = 200
MAX_FILE_BYTES = 512 * 1024

SEARCH_TEXT_DESCRIPTION = (
    "在工作区文本文件中搜索具体匹配行，返回 path、line、snippet 和可选上下文。"
    "当需要确认某段文本、符号、错误信息或关键词出现在哪些行时使用。"
)

SEARCH_FILES_DESCRIPTION = (
    "只按工作区文件名、目录名或相对路径搜索，不搜索文件内容。"
    "当用户给出文件名、目录名、路径片段或约定资源名称但完整路径不确定时使用。"
)

GREP_FILES_DESCRIPTION = (
    "查找内容匹配正则或固定字符串的工作区文件，发现候选文件并返回匹配文件路径。"
    "当目标是查找某段内容、符号、错误信息或关键词分布在哪些文件中时使用；"
    "如果用户给出的是文件名或路径片段，应使用 search_files 或 read_file。"
)


def create_search_tools() -> list[FunctionTool]:
    return [
        FunctionTool(
            name="search_text",
            description=SEARCH_TEXT_DESCRIPTION,
            parameters={
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "要搜索的文本或正则表达式。"},
                    "path": {"type": "string", "description": "搜索目录，默认工作区根目录。"},
                    "regex": {
                        "type": "boolean",
                        "default": False,
                        "description": "是否将 query 当作正则表达式。",
                    },
                    "case_sensitive": {"type": "boolean", "default": False},
                    "limit": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": MAX_SEARCH_LIMIT,
                        "default": DEFAULT_SEARCH_LIMIT,
                        "description": "全局最多返回的匹配行数量。",
                    },
                    "include": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": (
                            "可选的文件包含 glob 模式，例如 ['*.py','backend/**/*.py']。"
                        ),
                    },
                    "exclude": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "可选的文件或目录排除 glob 模式。",
                    },
                    "context_lines": {
                        "type": "integer",
                        "minimum": 0,
                        "maximum": 5,
                        "default": 0,
                        "description": "每个匹配行前后返回的上下文行数。",
                    },
                },
                "required": ["query"],
            },
            handler=search_text_tool,
        ),
        FunctionTool(
            name="grep_files",
            description=GREP_FILES_DESCRIPTION,
            parameters={
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "要在文件内容中搜索的正则表达式或固定字符串。",
                    },
                    "path": {"type": "string", "description": "搜索目录，默认工作区根目录。"},
                    "regex": {
                        "type": "boolean",
                        "default": True,
                        "description": (
                            "是否将 query 当作正则表达式。设为 false 时执行固定字符串搜索。"
                        ),
                    },
                    "case_sensitive": {"type": "boolean", "default": False},
                    "limit": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": MAX_GREP_FILE_LIMIT,
                        "default": DEFAULT_GREP_FILE_LIMIT,
                        "description": "最多返回的匹配文件数量。",
                    },
                    "include": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "可选的文件包含 glob 模式。",
                    },
                    "exclude": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "可选的文件或目录排除 glob 模式。",
                    },
                },
                "required": ["query"],
            },
            handler=grep_files_tool,
        ),
        FunctionTool(
            name="search_files",
            description=SEARCH_FILES_DESCRIPTION,
            parameters={
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "文件名或相对路径关键字；不会搜索文件内容。",
                    },
                    "path": {"type": "string", "description": "搜索目录，默认工作区根目录。"},
                    "limit": {
                        "type": "integer",
                        "minimum": 1,
                        "maximum": MAX_SEARCH_LIMIT,
                        "default": DEFAULT_SEARCH_LIMIT,
                    },
                    "include_hidden": {"type": "boolean", "default": False},
                },
                "required": ["query"],
            },
            handler=search_files_tool,
        ),
    ]


def register_search_tools(registry: ToolRegistry) -> ToolRegistry:
    for tool in create_search_tools():
        registry.register(tool)
    return registry


async def search_text_tool(
    args: dict[str, Any],
    context: ToolExecutionContext,
) -> dict[str, Any]:
    query = _require_non_empty_text(args.get("query"), "query")
    root = _resolve_search_root(args.get("path") or ".", context)
    limit = min(_positive_int(args.get("limit"), default=DEFAULT_SEARCH_LIMIT), MAX_SEARCH_LIMIT)
    regex = bool(args.get("regex", False))
    case_sensitive = bool(args.get("case_sensitive", False))
    context_lines = min(_non_negative_int(args.get("context_lines"), default=0), 5)
    include = _normalize_globs(args.get("include"))
    exclude = _normalize_globs(args.get("exclude"))
    matcher = _compile_matcher(query, regex=regex, case_sensitive=case_sensitive)

    results: list[dict[str, Any]] = []
    scanned_files = 0
    for candidate in _iter_text_files(root, context=context, include=include, exclude=exclude):
        scanned_files += 1
        lines = _read_text_lines(candidate)
        if lines is None:
            continue
        for index, line in enumerate(lines, start=1):
            if not matcher(line):
                continue
            result: dict[str, Any] = {
                "path": _relative(candidate, context),
                "line": index,
                "snippet": line.strip(),
            }
            if context_lines:
                result["before_context"] = _context_window(
                    lines,
                    index,
                    before=context_lines,
                    after=0,
                )
                result["after_context"] = _context_window(
                    lines,
                    index,
                    before=0,
                    after=context_lines,
                )
            results.append(result)
            if len(results) >= limit:
                return _search_text_result(
                    query=query,
                    results=results,
                    root=root,
                    context=context,
                    scanned_files=scanned_files,
                    limit=limit,
                )
    return _search_text_result(
        query=query,
        results=results,
        root=root,
        context=context,
        scanned_files=scanned_files,
        limit=limit,
    )


async def grep_files_tool(
    args: dict[str, Any],
    context: ToolExecutionContext,
) -> dict[str, Any]:
    query = _require_non_empty_text(args.get("query"), "query")
    root = _resolve_search_root(args.get("path") or ".", context)
    limit = min(
        _positive_int(args.get("limit"), default=DEFAULT_GREP_FILE_LIMIT),
        MAX_GREP_FILE_LIMIT,
    )
    regex = bool(args.get("regex", True))
    case_sensitive = bool(args.get("case_sensitive", False))
    include = _normalize_globs(args.get("include"))
    exclude = _normalize_globs(args.get("exclude"))
    matcher = _compile_matcher(query, regex=regex, case_sensitive=case_sensitive)

    matches: list[dict[str, Any]] = []
    scanned_files = 0
    for candidate in _iter_text_files(root, context=context, include=include, exclude=exclude):
        scanned_files += 1
        lines = _read_text_lines(candidate)
        if lines is None:
            continue
        matched_lines = [
            (index, line)
            for index, line in enumerate(lines, start=1)
            if matcher(line)
        ]
        if not matched_lines:
            continue
        first_line, first_text = matched_lines[0]
        matches.append(
            {
                "path": _relative(candidate, context),
                "matches": len(matched_lines),
                "first_line": first_line,
                "snippet": first_text.strip(),
                "modified_time": candidate.stat().st_mtime,
            }
        )
        if len(matches) >= limit:
            break

    matches.sort(key=lambda item: (-float(item["modified_time"]), item["path"]))
    for item in matches:
        item["modified_time"] = int(float(item["modified_time"]))
    result = {
        "query": query,
        "path": _relative(root, context),
        "results": matches,
        "paths": [item["path"] for item in matches],
        "scanned_files": scanned_files,
        "limit": limit,
        "engine": "python",
    }
    logger.info(
        "[SearchTool] grep_files 完成 | "
        f"path={result['path']} | query_chars={len(query)} | results={len(matches)} | "
        f"scanned_files={scanned_files} | limit={limit}"
    )
    return result


async def search_files_tool(
    args: dict[str, Any],
    context: ToolExecutionContext,
) -> dict[str, Any]:
    query = _require_non_empty_text(args.get("query"), "query")
    needle = query.lower()
    root = _resolve_search_root(args.get("path") or ".", context)
    limit = min(_positive_int(args.get("limit"), default=DEFAULT_SEARCH_LIMIT), MAX_SEARCH_LIMIT)
    include_hidden = bool(args.get("include_hidden", False))

    results: list[dict[str, Any]] = []
    for current_text, dir_names, file_names in os.walk(root):
        dir_names[:] = [
            name
            for name in sorted(dir_names, key=str.lower)
            if _include_path_name(name, include_hidden=include_hidden)
        ]
        current = Path(current_text)
        candidates = [
            *(current / name for name in dir_names),
            *(
                current / name
                for name in sorted(file_names, key=str.lower)
                if _include_path_name(name, include_hidden=include_hidden)
            ),
        ]
        for candidate in sorted(
            candidates,
            key=lambda item: (0 if item.is_dir() else 1, item.name.lower()),
        ):
            rel = _relative(candidate, context)
            if needle not in candidate.name.lower() and needle not in rel.lower():
                continue
            results.append(
                {
                    "name": candidate.name,
                    "path": rel,
                    "type": "directory" if candidate.is_dir() else "file",
                }
            )
            if len(results) >= limit:
                return _search_files_result(query, root, context, results, limit)
    return _search_files_result(query, root, context, results, limit)


def _search_text_result(
    *,
    query: str,
    results: list[dict[str, Any]],
    root: Path,
    context: ToolExecutionContext,
    scanned_files: int,
    limit: int,
) -> dict[str, Any]:
    result = {
        "query": query,
        "path": _relative(root, context),
        "results": results,
        "scanned_files": scanned_files,
        "limit": limit,
        "engine": "python",
    }
    logger.info(
        "[SearchTool] 文本搜索完成 | "
        f"path={result['path']} | query_chars={len(query)} | results={len(results)} | "
        f"scanned_files={scanned_files} | limit={limit}"
    )
    return result


def _search_files_result(
    query: str,
    root: Path,
    context: ToolExecutionContext,
    results: list[dict[str, Any]],
    limit: int,
) -> dict[str, Any]:
    result = {
        "query": query,
        "path": _relative(root, context),
        "results": results,
        "limit": limit,
        "engine": "python",
        "search_scope": "path",
    }
    logger.info(
        "[SearchTool] 文件路径搜索完成 | "
        f"path={result['path']} | query_chars={len(query)} | results={len(results)} | limit={limit}"
    )
    return result


def _iter_text_files(
    root: Path,
    *,
    context: ToolExecutionContext,
    include: list[str],
    exclude: list[str],
) -> list[Path]:
    files: list[Path] = []
    for current_text, dir_names, file_names in os.walk(root):
        dir_names[:] = [
            name
            for name in sorted(dir_names, key=str.lower)
            if name not in IGNORED_DIRS and not name.startswith(".")
        ]
        current = Path(current_text)
        for file_name in sorted(file_names, key=str.lower):
            candidate = current / file_name
            rel = _relative(candidate, context)
            if _excluded(rel, exclude):
                continue
            if include and not _included(rel, include):
                continue
            if _is_probably_binary(candidate):
                continue
            files.append(candidate)
    return files


def _compile_matcher(query: str, *, regex: bool, case_sensitive: bool) -> Callable[[str], bool]:
    if regex:
        flags = 0 if case_sensitive else re.IGNORECASE
        try:
            pattern = re.compile(query, flags)
        except re.error as exc:
            raise ToolExecutionError(
                str(exc),
                code="invalid_search_pattern",
                details={"query": query},
            ) from exc
        return lambda value: pattern.search(value) is not None

    needle = query if case_sensitive else query.lower()
    return lambda value: needle in (value if case_sensitive else value.lower())


def _resolve_search_root(raw_path: Any, context: ToolExecutionContext) -> Path:
    path = _resolve(raw_path, context)
    if not path.exists():
        raise ToolExecutionError("搜索路径不存在", code="search_path_not_found")
    if not path.is_dir():
        raise ToolExecutionError("搜索路径不是目录", code="search_path_not_directory")
    return path


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
    rel = path.resolve().relative_to(context.workspace_root).as_posix()
    return rel or "."


def _require_non_empty_text(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ToolExecutionError(f"{name} 必须是非空字符串", code="invalid_tool_args")
    return value.strip()


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


def _normalize_globs(value: Any) -> list[str]:
    if value is None or value == "":
        return []
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [item for item in value if isinstance(item, str) and item.strip()]
    raise ToolExecutionError("include/exclude 必须是字符串数组", code="invalid_tool_args")


def _included(path: str, patterns: list[str]) -> bool:
    return any(
        fnmatch.fnmatch(path, pattern) or fnmatch.fnmatch(Path(path).name, pattern)
        for pattern in patterns
    )


def _excluded(path: str, patterns: list[str]) -> bool:
    return any(
        fnmatch.fnmatch(path, pattern) or fnmatch.fnmatch(Path(path).name, pattern)
        for pattern in patterns
    )


def _context_window(
    lines: list[str],
    line_number: int,
    *,
    before: int,
    after: int,
) -> list[dict[str, Any]]:
    if before:
        start = max(1, line_number - before)
        end = line_number - 1
    else:
        start = line_number + 1
        end = min(len(lines), line_number + after)
    return [
        {"line": index, "text": lines[index - 1]}
        for index in range(start, end + 1)
    ]


def _read_text_lines(path: Path) -> list[str] | None:
    try:
        if path.stat().st_size > MAX_FILE_BYTES:
            return None
        return path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeDecodeError):
        return None


def _is_probably_binary(path: Path) -> bool:
    try:
        chunk = path.read_bytes()[:1024]
    except OSError:
        return True
    return b"\x00" in chunk


def _include_path_name(name: str, *, include_hidden: bool) -> bool:
    if name in IGNORED_DIRS:
        return False
    if not include_hidden and name.startswith("."):
        return False
    return True
