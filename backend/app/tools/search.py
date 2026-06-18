from __future__ import annotations

import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

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


def create_search_tools() -> list[FunctionTool]:
    return [
        FunctionTool(
            name="search_text",
            description="在当前工作区内搜索文本内容，返回 path、line、snippet。",
            parameters={
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "要搜索的文本或正则"},
                    "path": {"type": "string", "description": "搜索目录，默认工作区根目录"},
                    "regex": {"type": "boolean", "default": False},
                    "case_sensitive": {"type": "boolean", "default": False},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 100, "default": 50},
                },
                "required": ["query"],
            },
            handler=search_text_tool,
        ),
        FunctionTool(
            name="search_files",
            description="在当前工作区内按文件名或路径搜索文件和目录。",
            parameters={
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "文件名或路径关键字"},
                    "path": {"type": "string", "description": "搜索目录，默认工作区根目录"},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 100, "default": 50},
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
    root = _resolve(args.get("path") or ".", context)
    if not root.exists():
        raise ToolExecutionError("搜索路径不存在", code="search_path_not_found")
    if not root.is_dir():
        raise ToolExecutionError("搜索路径不是目录", code="search_path_not_directory")

    limit = min(_positive_int(args.get("limit"), default=50), 100)
    regex = bool(args.get("regex", False))
    case_sensitive = bool(args.get("case_sensitive", False))

    rg_path = shutil.which("rg")
    if rg_path:
        return _search_text_with_rg(
            rg_path,
            root,
            context,
            query=query,
            regex=regex,
            case_sensitive=case_sensitive,
            limit=limit,
        )
    return _search_text_with_python(
        root,
        context,
        query=query,
        regex=regex,
        case_sensitive=case_sensitive,
        limit=limit,
    )


async def search_files_tool(
    args: dict[str, Any],
    context: ToolExecutionContext,
) -> dict[str, Any]:
    query = _require_non_empty_text(args.get("query"), "query").lower()
    root = _resolve(args.get("path") or ".", context)
    if not root.exists():
        raise ToolExecutionError("搜索路径不存在", code="search_path_not_found")
    if not root.is_dir():
        raise ToolExecutionError("搜索路径不是目录", code="search_path_not_directory")

    limit = min(_positive_int(args.get("limit"), default=50), 100)
    results: list[dict[str, Any]] = []
    for current_text, dir_names, file_names in os.walk(root):
        dir_names[:] = [name for name in dir_names if name not in IGNORED_DIRS]
        current = Path(current_text)
        candidates = [
            *(current / name for name in dir_names),
            *(current / name for name in file_names),
        ]
        for candidate in sorted(
            candidates,
            key=lambda item: (0 if item.is_dir() else 1, item.name.lower()),
        ):
            rel = _relative(candidate, context)
            if query not in candidate.name.lower() and query not in rel.lower():
                continue
            results.append(
                {
                    "name": candidate.name,
                    "path": rel,
                    "type": "directory" if candidate.is_dir() else "file",
                }
            )
            if len(results) >= limit:
                return {"query": query, "results": results, "engine": "python"}
    return {"query": query, "results": results, "engine": "python"}


def _search_text_with_rg(
    rg_path: str,
    root: Path,
    context: ToolExecutionContext,
    *,
    query: str,
    regex: bool,
    case_sensitive: bool,
    limit: int,
) -> dict[str, Any]:
    command = [
        rg_path,
        "--line-number",
        "--with-filename",
        "--color",
        "never",
        "--max-count",
        str(limit),
        "--glob",
        "!{.git,.venv,node_modules,__pycache__,.mypy_cache,.pytest_cache,.npm-cache}/**",
    ]
    if not regex:
        command.append("--fixed-strings")
    if not case_sensitive:
        command.append("--ignore-case")
    command.append(query)
    completed = subprocess.run(
        command,
        cwd=root,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=10,
        check=False,
    )
    if completed.returncode == 2:
        raise ToolExecutionError(
            completed.stderr.strip() or "搜索表达式无效",
            code="invalid_search_pattern",
        )
    if completed.returncode not in (0, 1):
        raise ToolExecutionError(completed.stderr.strip() or "搜索失败", code="search_failed")

    results = []
    for line in completed.stdout.splitlines():
        parts = line.split(":", 2)
        if len(parts) != 3:
            continue
        path_text, line_no, snippet = parts
        results.append(
            {
                "path": _relative(root / path_text, context),
                "line": int(line_no),
                "snippet": snippet,
            }
        )
        if len(results) >= limit:
            break
    return {"query": query, "results": results, "engine": "rg"}


def _search_text_with_python(
    root: Path,
    context: ToolExecutionContext,
    *,
    query: str,
    regex: bool,
    case_sensitive: bool,
    limit: int,
) -> dict[str, Any]:
    matcher = _compile_matcher(query, regex=regex, case_sensitive=case_sensitive)
    results: list[dict[str, Any]] = []
    for current_text, dir_names, file_names in os.walk(root):
        dir_names[:] = [name for name in dir_names if name not in IGNORED_DIRS]
        current = Path(current_text)
        for file_name in sorted(file_names):
            candidate = current / file_name
            if _is_probably_binary(candidate):
                continue
            try:
                lines = candidate.read_text(encoding="utf-8").splitlines()
            except (UnicodeDecodeError, OSError):
                continue
            for index, line in enumerate(lines, start=1):
                if not matcher(line):
                    continue
                results.append(
                    {
                        "path": _relative(candidate, context),
                        "line": index,
                        "snippet": line.strip(),
                    }
                )
                if len(results) >= limit:
                    return {"query": query, "results": results, "engine": "python"}
    return {"query": query, "results": results, "engine": "python"}


def _compile_matcher(query: str, *, regex: bool, case_sensitive: bool):
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


def _is_probably_binary(path: Path) -> bool:
    try:
        chunk = path.read_bytes()[:1024]
    except OSError:
        return True
    return b"\x00" in chunk
