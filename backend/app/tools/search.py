from __future__ import annotations

import asyncio
import json
import subprocess
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from backend.app.core.logger import logger
from backend.app.core.ripgrep import BUNDLED_RIPGREP_BINARY_NAME, resolve_ripgrep_binary
from backend.app.tools.base import FunctionTool, ToolExecutionContext, ToolExecutionError
from backend.app.tools.file_access import relative_tool_path, resolve_file_access_path
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


@dataclass(slots=True)
class RipgrepJsonResult:
    matches: list[dict[str, Any]]
    scanned_files: int
    truncated: bool


@dataclass(slots=True)
class RipgrepFileSearchResult:
    results: list[dict[str, Any]]
    scanned_files: int
    truncated: bool


@dataclass(slots=True)
class RipgrepPathListResult:
    paths: list[str]
    truncated: bool


DEFAULT_SEARCH_LIMIT = 50
MAX_SEARCH_LIMIT = 200
DEFAULT_GREP_FILE_LIMIT = 50
MAX_GREP_FILE_LIMIT = 200
MAX_CONTEXT_FILE_BYTES = 512 * 1024
RIPGREP_TIMEOUT_SECONDS = 30

SEARCH_TEXT_DESCRIPTION = (
    "在文件访问权限允许范围内的目录或单个文本文件中搜索具体匹配行，"
    "返回 path、line、snippet 和可选上下文。"
    "当需要确认某段文本、符号、错误信息或关键词出现在哪些行时使用；"
    "如果只需要在某个已知文件内搜索，可将 path 设为该文件路径。"
)

SEARCH_FILES_DESCRIPTION = (
    "只按文件访问权限允许范围内的文件名、目录名或路径搜索，不搜索文件内容。"
    "当用户给出文件名、目录名、路径片段或约定资源名称但完整路径不确定时使用。"
)

GREP_FILES_DESCRIPTION = (
    "在文件访问权限允许范围内的目录或单个文件内查找内容匹配正则或固定字符串的文件，"
    "发现候选文件并返回匹配文件路径。"
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
                    "path": {
                        "type": "string",
                        "description": (
                            "搜索目录或单个文件，默认工作区根目录；"
                            "完全访问时也可使用绝对路径。"
                        ),
                    },
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
                    "path": {
                        "type": "string",
                        "description": (
                            "搜索目录或单个文件，默认工作区根目录；"
                            "完全访问时也可使用绝对路径。"
                        ),
                    },
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
                    "path": {
                        "type": "string",
                        "description": "搜索目录，默认工作区根目录；完全访问时也可使用绝对路径。",
                    },
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
    root = _resolve_search_path(args.get("path") or ".", context)
    limit = min(_positive_int(args.get("limit"), default=DEFAULT_SEARCH_LIMIT), MAX_SEARCH_LIMIT)
    regex = bool(args.get("regex", False))
    case_sensitive = bool(args.get("case_sensitive", False))
    context_lines = min(_non_negative_int(args.get("context_lines"), default=0), 5)
    include = _normalize_globs(args.get("include"))
    exclude = _normalize_globs(args.get("exclude"))
    rg_result = await _run_ripgrep_json_matches(
        root=root,
        context=context,
        query=query,
        regex=regex,
        case_sensitive=case_sensitive,
        include=include,
        exclude=exclude,
        limit=limit,
    )
    results = _search_text_results_from_rg_matches(rg_result.matches)
    if context_lines and results:
        _attach_context_lines(results, context=context, context_lines=context_lines)
    return _search_text_result(
        query=query,
        results=results,
        root=root,
        context=context,
        scanned_files=rg_result.scanned_files,
        limit=limit,
        truncated=rg_result.truncated,
    )


async def grep_files_tool(
    args: dict[str, Any],
    context: ToolExecutionContext,
) -> dict[str, Any]:
    query = _require_non_empty_text(args.get("query"), "query")
    root = _resolve_search_path(args.get("path") or ".", context)
    limit = min(
        _positive_int(args.get("limit"), default=DEFAULT_GREP_FILE_LIMIT),
        MAX_GREP_FILE_LIMIT,
    )
    regex = bool(args.get("regex", True))
    case_sensitive = bool(args.get("case_sensitive", False))
    include = _normalize_globs(args.get("include"))
    exclude = _normalize_globs(args.get("exclude"))

    path_arg = _relative(root, context)
    rg_paths = await _run_ripgrep_path_list(
        [
            "--files-with-matches",
            "--no-messages",
            "--color",
            "never",
            *_ripgrep_pattern_args(
                query,
                regex=regex,
                case_sensitive=case_sensitive,
                include=include,
                exclude=exclude,
            ),
            "--",
            path_arg,
        ],
        cwd=context.workspace_root,
        query=query,
        limit=limit,
    )
    paths = rg_paths.paths
    details = await _grep_file_details(
        paths,
        context=context,
        query=query,
        regex=regex,
        case_sensitive=case_sensitive,
    )

    matches: list[dict[str, Any]] = []
    for path in paths:
        resolved = _resolve(path, context)
        stat = resolved.stat()
        detail = details.get(path, {})
        matches.append(
            {
                "path": path,
                "matches": int(detail.get("matches") or 0),
                "first_line": int(detail.get("first_line") or 0),
                "snippet": str(detail.get("snippet") or ""),
                "modified_time": stat.st_mtime,
            }
        )

    for item in matches:
        item["modified_time"] = int(float(item["modified_time"]))
    result = {
        "query": query,
        "path": _relative(root, context),
        "results": matches,
        "paths": [item["path"] for item in matches],
        "scanned_files": len(paths),
        "limit": limit,
        "engine": "ripgrep",
        "truncated": rg_paths.truncated,
    }
    logger.info(
        "[SearchTool] grep_files 完成 | "
        f"path={result['path']} | query_chars={len(query)} | results={len(matches)} | "
        f"matched_files={len(paths)} | limit={limit} | truncated={rg_paths.truncated}"
    )
    return result


async def search_files_tool(
    args: dict[str, Any],
    context: ToolExecutionContext,
) -> dict[str, Any]:
    query = _require_non_empty_text(args.get("query"), "query")
    root = _resolve_search_root(args.get("path") or ".", context)
    limit = min(_positive_int(args.get("limit"), default=DEFAULT_SEARCH_LIMIT), MAX_SEARCH_LIMIT)
    include_hidden = bool(args.get("include_hidden", False))

    rg_result = await _run_ripgrep_file_search(
        root=root,
        context=context,
        query=query,
        include_hidden=include_hidden,
        limit=limit,
    )
    return _search_files_result(
        query,
        root,
        context,
        rg_result.results,
        limit,
        scanned_files=rg_result.scanned_files,
        truncated=rg_result.truncated,
    )


def _search_text_result(
    *,
    query: str,
    results: list[dict[str, Any]],
    root: Path,
    context: ToolExecutionContext,
    scanned_files: int,
    limit: int,
    truncated: bool,
) -> dict[str, Any]:
    result = {
        "query": query,
        "path": _relative(root, context),
        "results": results,
        "scanned_files": scanned_files,
        "limit": limit,
        "engine": "ripgrep",
        "truncated": truncated,
    }
    logger.info(
        "[SearchTool] 文本搜索完成 | "
        f"path={result['path']} | query_chars={len(query)} | results={len(results)} | "
        f"scanned_files={scanned_files} | limit={limit} | truncated={truncated}"
    )
    return result


def _search_files_result(
    query: str,
    root: Path,
    context: ToolExecutionContext,
    results: list[dict[str, Any]],
    limit: int,
    *,
    scanned_files: int,
    truncated: bool,
) -> dict[str, Any]:
    result = {
        "query": query,
        "path": _relative(root, context),
        "results": results,
        "limit": limit,
        "engine": "ripgrep",
        "search_scope": "path",
        "scanned_files": scanned_files,
        "truncated": truncated,
    }
    logger.info(
        "[SearchTool] 文件路径搜索完成 | "
        f"path={result['path']} | query_chars={len(query)} | results={len(results)} | "
        f"scanned_files={scanned_files} | limit={limit} | truncated={truncated}"
    )
    return result


async def _run_ripgrep_path_list(
    args: list[str],
    *,
    cwd: Path,
    query: str,
    limit: int,
    timeout_seconds: int = RIPGREP_TIMEOUT_SECONDS,
) -> RipgrepPathListResult:
    return await asyncio.to_thread(
        _run_ripgrep_path_list_blocking,
        args,
        cwd,
        query,
        limit,
        timeout_seconds,
    )


def _run_ripgrep_path_list_blocking(
    args: list[str],
    cwd: Path,
    query: str,
    limit: int,
    timeout_seconds: int,
) -> RipgrepPathListResult:
    rg = _require_ripgrep_binary()
    try:
        process = subprocess.Popen(
            [str(rg), *args],
            cwd=str(cwd),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except OSError as exc:
        raise ToolExecutionError(
            f"启动 ripgrep 失败：{exc}",
            code="search_engine_unavailable",
            details={"engine": "ripgrep"},
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

    timer = threading.Timer(timeout_seconds, kill_after_timeout)
    timer.start()
    try:
        for line in process.stdout:
            path = _normalize_rg_file_line(line)
            if not path:
                continue
            paths.append(path)
            if len(paths) >= limit:
                truncated = True
                _kill_process(process)
                break
        process.wait()
    finally:
        timer.cancel()

    stderr = process.stderr.read()
    if timed_out:
        raise ToolExecutionError(
            f"ripgrep 搜索超过 {timeout_seconds} 秒，已停止",
            code="search_timed_out",
            details={"engine": "ripgrep", "timeout_seconds": timeout_seconds},
        )
    if process.returncode not in (0, 1, None) and not truncated:
        _raise_ripgrep_error(stderr, query=query)
    return RipgrepPathListResult(paths=paths, truncated=truncated)


async def _run_ripgrep_file_search(
    *,
    root: Path,
    context: ToolExecutionContext,
    query: str,
    include_hidden: bool,
    limit: int,
) -> RipgrepFileSearchResult:
    root_label = _relative(root, context)
    return await asyncio.to_thread(
        _run_ripgrep_file_search_blocking,
        _ripgrep_file_args(root_label, include_hidden=include_hidden),
        context.workspace_root,
        root_label,
        query,
        limit,
    )


def _run_ripgrep_file_search_blocking(
    args: list[str],
    cwd: Path,
    root_label: str,
    query: str,
    limit: int,
) -> RipgrepFileSearchResult:
    rg = _require_ripgrep_binary()
    try:
        process = subprocess.Popen(
            [str(rg), *args],
            cwd=str(cwd),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except OSError as exc:
        raise ToolExecutionError(
            f"启动 ripgrep 失败：{exc}",
            code="search_engine_unavailable",
            details={"engine": "ripgrep"},
        ) from exc

    results: list[dict[str, Any]] = []
    seen_paths: set[str] = set()
    scanned_files = 0
    truncated = False
    timed_out = False
    assert process.stdout is not None
    assert process.stderr is not None

    def kill_after_timeout() -> None:
        nonlocal timed_out
        timed_out = True
        _kill_process(process)

    timer = threading.Timer(RIPGREP_TIMEOUT_SECONDS, kill_after_timeout)
    timer.start()
    try:
        for line in process.stdout:
            path = _normalize_rg_file_line(line)
            if not path:
                continue
            scanned_files += 1
            if _append_search_file_matches(
                path,
                root_label=root_label,
                needle=query.lower(),
                results=results,
                seen_paths=seen_paths,
                limit=limit,
            ):
                truncated = True
                _kill_process(process)
                break
        process.wait()
    finally:
        timer.cancel()

    stderr = process.stderr.read()
    if timed_out:
        raise ToolExecutionError(
            f"ripgrep 文件路径搜索超过 {RIPGREP_TIMEOUT_SECONDS} 秒，已停止",
            code="search_timed_out",
            details={"engine": "ripgrep", "timeout_seconds": RIPGREP_TIMEOUT_SECONDS},
        )
    if process.returncode not in (0, 1, None) and not truncated:
        _raise_ripgrep_error(stderr, query=query)
    return RipgrepFileSearchResult(
        results=results,
        scanned_files=scanned_files,
        truncated=truncated,
    )


def _ripgrep_file_args(path_arg: str, *, include_hidden: bool) -> list[str]:
    args = [
        "--files",
        "--no-messages",
        "--color",
        "never",
    ]
    if include_hidden:
        args.append("--hidden")
    for name in sorted(IGNORED_DIRS):
        args.extend(["--glob", f"!{name}/**", "--glob", f"!**/{name}/**"])
    args.extend(["--", path_arg])
    return args


def _normalize_rg_file_line(line: str) -> str:
    raw = _normalize_rg_path(line.strip())
    if not raw or raw == "." or raw.startswith("../") or "/../" in raw:
        return ""
    return raw


def _append_search_file_matches(
    path: str,
    *,
    root_label: str,
    needle: str,
    results: list[dict[str, Any]],
    seen_paths: set[str],
    limit: int,
) -> bool:
    for candidate_path, candidate_name, candidate_type in _search_file_candidate_entries(
        path,
        root_label=root_label,
    ):
        if candidate_path in seen_paths:
            continue
        if needle not in candidate_name.lower() and needle not in candidate_path.lower():
            continue
        seen_paths.add(candidate_path)
        results.append(
            {
                "name": candidate_name,
                "path": candidate_path,
                "type": candidate_type,
            }
        )
        if len(results) >= limit:
            return True
    return False


def _search_file_candidate_entries(
    path: str,
    *,
    root_label: str,
) -> list[tuple[str, str, str]]:
    prefix, relative_path = _split_path_under_root(path, root_label=root_label)
    parts = [part for part in relative_path.split("/") if part and part != "."]
    if not parts:
        return []

    candidates: list[tuple[str, str, str]] = []
    current = prefix
    for part in parts[:-1]:
        current = f"{current}/{part}" if current else part
        candidates.append((current, part, "directory"))
    candidates.append((path, parts[-1], "file"))
    return candidates


def _split_path_under_root(path: str, *, root_label: str) -> tuple[str, str]:
    prefix = root_label.rstrip("/")
    if not prefix or prefix == ".":
        return "", path
    if _path_has_prefix(path, prefix):
        return prefix, path[len(prefix) + 1 :]
    return "", path


def _path_has_prefix(path: str, prefix: str) -> bool:
    folded_path = path.casefold()
    folded_prefix = prefix.casefold()
    return folded_path.startswith(f"{folded_prefix}/")


def _kill_process(process: subprocess.Popen[str]) -> None:
    try:
        process.kill()
    except OSError:
        pass


async def _run_ripgrep(
    args: list[str],
    *,
    cwd: Path,
    timeout_seconds: int = RIPGREP_TIMEOUT_SECONDS,
) -> tuple[int, str, str]:
    return await asyncio.to_thread(
        _run_ripgrep_blocking,
        args,
        cwd,
        timeout_seconds,
    )


def _run_ripgrep_blocking(
    args: list[str],
    cwd: Path,
    timeout_seconds: int,
) -> tuple[int, str, str]:
    rg = _require_ripgrep_binary()
    try:
        completed = subprocess.run(
            [str(rg), *args],
            cwd=str(cwd),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_seconds,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise ToolExecutionError(
            f"ripgrep 搜索超过 {timeout_seconds} 秒，已停止",
            code="search_timed_out",
            details={"engine": "ripgrep", "timeout_seconds": timeout_seconds},
        ) from exc
    except OSError as exc:
        raise ToolExecutionError(
            f"启动 ripgrep 失败：{exc}",
            code="search_engine_unavailable",
            details={"engine": "ripgrep"},
        ) from exc
    return int(completed.returncode or 0), completed.stdout, completed.stderr


async def _run_ripgrep_json_matches(
    *,
    root: Path,
    context: ToolExecutionContext,
    query: str,
    regex: bool,
    case_sensitive: bool,
    include: list[str],
    exclude: list[str],
    limit: int,
) -> RipgrepJsonResult:
    args = [
        "--json",
        "--line-number",
        "--column",
        "--no-messages",
        "--color",
        "never",
        *_ripgrep_pattern_args(
            query,
            regex=regex,
            case_sensitive=case_sensitive,
            include=include,
            exclude=exclude,
        ),
        "--",
        _relative(root, context),
    ]
    return await asyncio.to_thread(
        _run_ripgrep_json_matches_blocking,
        args,
        context.workspace_root,
        limit,
        query,
    )


def _run_ripgrep_json_matches_blocking(
    args: list[str],
    cwd: Path,
    limit: int,
    query: str,
) -> RipgrepJsonResult:
    rg = _require_ripgrep_binary()
    try:
        process = subprocess.Popen(
            [str(rg), *args],
            cwd=str(cwd),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except OSError as exc:
        raise ToolExecutionError(
            f"启动 ripgrep 失败：{exc}",
            code="search_engine_unavailable",
            details={"engine": "ripgrep"},
        ) from exc

    matches: list[dict[str, Any]] = []
    scanned_files = 0
    truncated = False
    timed_out = False
    assert process.stdout is not None
    assert process.stderr is not None

    def kill_after_timeout() -> None:
        nonlocal timed_out
        timed_out = True
        process.kill()

    timer = threading.Timer(RIPGREP_TIMEOUT_SECONDS, kill_after_timeout)
    timer.start()
    try:
        for line in process.stdout:
            event = _parse_rg_json_line(line)
            if not event:
                continue
            event_type = event.get("type")
            if event_type == "match":
                matches.append(event)
                if len(matches) >= limit:
                    truncated = True
                    process.kill()
                    break
            elif event_type == "summary":
                scanned_files = _rg_summary_searches(event)
        process.wait()
    finally:
        timer.cancel()

    stderr = process.stderr.read()
    if timed_out:
        process.kill()
        raise ToolExecutionError(
            f"ripgrep 搜索超过 {RIPGREP_TIMEOUT_SECONDS} 秒，已停止",
            code="search_timed_out",
            details={"engine": "ripgrep", "timeout_seconds": RIPGREP_TIMEOUT_SECONDS},
        )

    if process.returncode not in (0, 1) and not truncated:
        _raise_ripgrep_error(stderr, query=query)
    if not scanned_files:
        scanned_files = len({_rg_match_path(match) for match in matches if _rg_match_path(match)})
    return RipgrepJsonResult(
        matches=matches,
        scanned_files=scanned_files,
        truncated=truncated,
    )


def _require_ripgrep_binary() -> Path:
    rg = _resolve_ripgrep_binary()
    if rg:
        return rg
    raise ToolExecutionError(
        "未找到项目内置 ripgrep (rg)，无法执行工作区搜索",
        code="search_engine_unavailable",
        details={"engine": "ripgrep", "required_binary": BUNDLED_RIPGREP_BINARY_NAME},
    )


def _resolve_ripgrep_binary() -> Path | None:
    return resolve_ripgrep_binary()


def _ripgrep_pattern_args(
    query: str,
    *,
    regex: bool,
    case_sensitive: bool,
    include: list[str],
    exclude: list[str],
) -> list[str]:
    args: list[str] = []
    if not case_sensitive:
        args.append("--ignore-case")
    if not regex:
        args.append("--fixed-strings")
    for pattern in include:
        args.extend(["--glob", pattern])
    for pattern in exclude:
        args.extend(["--glob", f"!{pattern}"])
    args.extend(["--regexp", query])
    return args


def _raise_ripgrep_error(stderr: str, *, query: str) -> None:
    message = stderr.strip() or "ripgrep 搜索失败"
    code = "invalid_search_pattern" if "regex parse error" in message else "search_engine_failed"
    raise ToolExecutionError(
        message,
        code=code,
        details={"engine": "ripgrep", "query": query},
    )


def _parse_rg_json_line(line: str | bytes) -> dict[str, Any] | None:
    text = line.decode("utf-8", errors="replace") if isinstance(line, bytes) else line
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _rg_summary_searches(event: dict[str, Any]) -> int:
    data = event.get("data") if isinstance(event.get("data"), dict) else {}
    stats = data.get("stats") if isinstance(data.get("stats"), dict) else {}
    searches = stats.get("searches")
    return int(searches) if isinstance(searches, int) else 0


def _search_text_results_from_rg_matches(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for event in events:
        data = event.get("data") if isinstance(event.get("data"), dict) else {}
        path = _rg_data_path(data)
        line_number = data.get("line_number")
        lines = data.get("lines") if isinstance(data.get("lines"), dict) else {}
        text = lines.get("text")
        if not path or not isinstance(line_number, int) or not isinstance(text, str):
            continue
        results.append(
            {
                "path": path,
                "line": line_number,
                "snippet": text.rstrip("\r\n").strip(),
            }
        )
    return results


def _rg_match_path(event: dict[str, Any]) -> str:
    data = event.get("data") if isinstance(event.get("data"), dict) else {}
    return _rg_data_path(data)


def _rg_data_path(data: dict[str, Any]) -> str:
    path = data.get("path") if isinstance(data.get("path"), dict) else {}
    raw = path.get("text")
    return _normalize_rg_path(raw) if isinstance(raw, str) else ""


def _normalize_rg_path(path: str) -> str:
    normalized = path.replace("\\", "/")
    while normalized.startswith("./"):
        normalized = normalized[2:]
    return normalized or "."


async def _grep_file_details(
    paths: list[str],
    *,
    context: ToolExecutionContext,
    query: str,
    regex: bool,
    case_sensitive: bool,
) -> dict[str, dict[str, Any]]:
    if not paths:
        return {}
    counts = await _grep_file_match_counts(
        paths,
        context=context,
        query=query,
        regex=regex,
        case_sensitive=case_sensitive,
    )
    first_lines = await _grep_file_first_lines(
        paths,
        context=context,
        query=query,
        regex=regex,
        case_sensitive=case_sensitive,
    )
    return {
        path: {
            "matches": counts.get(path, 0),
            **first_lines.get(path, {}),
        }
        for path in paths
    }


async def _grep_file_match_counts(
    paths: list[str],
    *,
    context: ToolExecutionContext,
    query: str,
    regex: bool,
    case_sensitive: bool,
) -> dict[str, int]:
    code, stdout, stderr = await _run_ripgrep(
        [
            "--count",
            "--with-filename",
            "--no-messages",
            "--color",
            "never",
            *_ripgrep_pattern_args(
                query,
                regex=regex,
                case_sensitive=case_sensitive,
                include=[],
                exclude=[],
            ),
            "--",
            *paths,
        ],
        cwd=context.workspace_root,
    )
    if code == 1:
        return {}
    if code != 0:
        _raise_ripgrep_error(stderr, query=query)
    counts: dict[str, int] = {}
    for line in stdout.splitlines():
        raw_path, raw_count = _split_rg_count_line(line)
        if not raw_path:
            continue
        try:
            counts[_normalize_rg_path(raw_path)] = int(raw_count)
        except ValueError:
            continue
    return counts


async def _grep_file_first_lines(
    paths: list[str],
    *,
    context: ToolExecutionContext,
    query: str,
    regex: bool,
    case_sensitive: bool,
) -> dict[str, dict[str, Any]]:
    code, stdout, stderr = await _run_ripgrep(
        [
            "--json",
            "--line-number",
            "--column",
            "--max-count",
            "1",
            "--no-messages",
            "--color",
            "never",
            *_ripgrep_pattern_args(
                query,
                regex=regex,
                case_sensitive=case_sensitive,
                include=[],
                exclude=[],
            ),
            "--",
            *paths,
        ],
        cwd=context.workspace_root,
    )
    if code == 1:
        return {}
    if code != 0:
        _raise_ripgrep_error(stderr, query=query)
    details: dict[str, dict[str, Any]] = {}
    for line in stdout.splitlines():
        event = _parse_rg_json_line(line.encode("utf-8"))
        if not event or event.get("type") != "match":
            continue
        data = event.get("data") if isinstance(event.get("data"), dict) else {}
        path = _rg_data_path(data)
        line_number = data.get("line_number")
        lines = data.get("lines") if isinstance(data.get("lines"), dict) else {}
        text = lines.get("text")
        if path and isinstance(line_number, int) and isinstance(text, str):
            details[path] = {
                "first_line": line_number,
                "snippet": text.rstrip("\r\n").strip(),
            }
    return details


def _split_rg_count_line(line: str) -> tuple[str, str]:
    if ":" not in line:
        return "", ""
    path, count = line.rsplit(":", 1)
    return path, count


def _attach_context_lines(
    results: list[dict[str, Any]],
    *,
    context: ToolExecutionContext,
    context_lines: int,
) -> None:
    cache: dict[str, list[str] | None] = {}
    for result in results:
        path = str(result.get("path") or "")
        line_number = int(result.get("line") or 0)
        if not path or line_number <= 0:
            continue
        if path not in cache:
            cache[path] = _read_context_text_lines(_resolve(path, context))
        lines = cache[path]
        if not lines:
            continue
        result["before_context"] = _context_window(
            lines,
            line_number,
            before=context_lines,
            after=0,
        )
        result["after_context"] = _context_window(
            lines,
            line_number,
            before=0,
            after=context_lines,
        )


def _resolve_search_root(raw_path: Any, context: ToolExecutionContext) -> Path:
    path = _resolve(raw_path, context)
    if not path.exists():
        raise ToolExecutionError("搜索路径不存在", code="search_path_not_found")
    if not path.is_dir():
        raise ToolExecutionError("搜索路径不是目录", code="search_path_not_directory")
    return path


def _resolve_search_path(raw_path: Any, context: ToolExecutionContext) -> Path:
    path = _resolve(raw_path, context)
    if not path.exists():
        raise ToolExecutionError("搜索路径不存在", code="search_path_not_found")
    if not path.is_dir() and not path.is_file():
        raise ToolExecutionError(
            "搜索路径不是目录或文件",
            code="search_path_not_file_or_directory",
        )
    return path


def _resolve(raw_path: Any, context: ToolExecutionContext) -> Path:
    return resolve_file_access_path(raw_path, context, operation="read")


def _relative(path: Path, context: ToolExecutionContext) -> str:
    return relative_tool_path(path, context)


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
    return [{"line": index, "text": lines[index - 1]} for index in range(start, end + 1)]


def _read_context_text_lines(path: Path) -> list[str] | None:
    try:
        if path.stat().st_size > MAX_CONTEXT_FILE_BYTES:
            return None
        return path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeDecodeError):
        return None
