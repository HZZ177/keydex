from __future__ import annotations

import asyncio
import locale
import time
from pathlib import Path
from typing import Any

from backend.app.security.workspace import WorkspacePathError, resolve_workspace_path
from backend.app.tools.base import FunctionTool, ToolExecutionContext, ToolExecutionError
from backend.app.tools.registry import ToolRegistry

DEFAULT_TIMEOUT_SECONDS = 120.0
MAX_TIMEOUT_SECONDS = 600.0
MAX_CAPTURE_CHARS = 64 * 1024
DENIED_FRAGMENTS = (
    "rm -rf /",
    "sudo ",
    "chmod 777",
    "chown root",
    "curl ",
    "wget ",
    " | bash",
    " | sh",
    "format ",
    "del /f /s c:\\",
    "remove-item -recurse -force c:\\",
)


def create_shell_tools() -> list[FunctionTool]:
    return [
        FunctionTool(
            name="run_command",
            description="在当前工作区内执行 shell 命令，返回 stdout、stderr、exit_code 和耗时。",
            parameters={
                "type": "object",
                "properties": {
                    "command": {"type": "string", "description": "要执行的 shell 命令"},
                    "cwd": {"type": "string", "description": "工作区内执行目录，默认工作区根目录"},
                    "timeout_seconds": {
                        "type": "number",
                        "minimum": 0.1,
                        "maximum": MAX_TIMEOUT_SECONDS,
                        "default": DEFAULT_TIMEOUT_SECONDS,
                    },
                },
                "required": ["command"],
            },
            handler=run_command_tool,
        )
    ]


def register_shell_tools(registry: ToolRegistry) -> ToolRegistry:
    for tool in create_shell_tools():
        registry.register(tool)
    return registry


async def run_command_tool(
    args: dict[str, Any],
    context: ToolExecutionContext,
) -> dict[str, Any]:
    command = _require_command(args.get("command"))
    _reject_obviously_unsafe(command)
    cwd = _resolve_cwd(args.get("cwd") or ".", context)
    timeout_seconds = _timeout_seconds(args.get("timeout_seconds"))

    started_at = time.perf_counter()
    process = await asyncio.create_subprocess_shell(
        command,
        cwd=cwd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout_bytes, stderr_bytes = await asyncio.wait_for(
            process.communicate(),
            timeout=timeout_seconds,
        )
    except TimeoutError as exc:
        process.kill()
        await process.communicate()
        duration_ms = int((time.perf_counter() - started_at) * 1000)
        raise ToolExecutionError(
            "命令执行超时",
            code="command_timeout",
            details={
                "command": command,
                "cwd": _relative(cwd, context),
                "timeout_seconds": timeout_seconds,
                "duration_ms": duration_ms,
            },
        ) from exc

    duration_ms = int((time.perf_counter() - started_at) * 1000)
    result = {
        "command": command,
        "cwd": _relative(cwd, context),
        "stdout": _decode_output(stdout_bytes),
        "stderr": _decode_output(stderr_bytes),
        "exit_code": process.returncode,
        "duration_ms": duration_ms,
    }
    if process.returncode != 0:
        raise ToolExecutionError("命令执行失败", code="command_failed", details=result)
    return result


def _require_command(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ToolExecutionError("command 必须是非空字符串", code="invalid_tool_args")
    return value.strip()


def _reject_obviously_unsafe(command: str) -> None:
    lowered = command.lower()
    matched = next((fragment for fragment in DENIED_FRAGMENTS if fragment in lowered), None)
    if matched:
        raise ToolExecutionError(
            "命令包含高风险片段，已拒绝执行",
            code="command_rejected",
            details={"matched": matched},
        )


def _resolve_cwd(raw_path: Any, context: ToolExecutionContext) -> Path:
    if not isinstance(raw_path, str) or not raw_path.strip():
        raise ToolExecutionError("cwd 必须是非空字符串", code="invalid_tool_args")
    try:
        cwd = resolve_workspace_path(
            raw_path,
            cwd=context.workspace_root,
            workspace_roots=[context.workspace_root],
        )
    except WorkspacePathError as exc:
        raise ToolExecutionError(
            str(exc),
            code="workspace_path_forbidden",
            details={"cwd": raw_path},
        ) from exc
    if not cwd.exists():
        raise ToolExecutionError("cwd 不存在", code="cwd_not_found", details={"cwd": raw_path})
    if not cwd.is_dir():
        raise ToolExecutionError(
            "cwd 不是目录",
            code="cwd_not_directory",
            details={"cwd": raw_path},
        )
    return cwd


def _timeout_seconds(value: Any) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return DEFAULT_TIMEOUT_SECONDS
    return min(max(parsed, 0.1), MAX_TIMEOUT_SECONDS)


def _decode_output(value: bytes) -> str:
    encodings = ["utf-8", locale.getpreferredencoding(False), "gb18030"]
    text = ""
    for encoding in dict.fromkeys(encodings):
        try:
            text = value.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    if not text:
        text = value.decode("utf-8", errors="replace")
    if len(text) > MAX_CAPTURE_CHARS:
        return f"{text[:MAX_CAPTURE_CHARS]}\n...[输出已截断]"
    return text


def _relative(path: Path, context: ToolExecutionContext) -> str:
    rel = path.resolve().relative_to(context.workspace_root).as_posix()
    return rel or "."
