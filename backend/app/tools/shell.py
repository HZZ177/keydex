from __future__ import annotations

import asyncio
import locale
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from backend.app.command_approval import (
    ApprovalService,
    CommandSettings,
    find_trusted_command_rule,
    load_command_settings,
)
from backend.app.core.logger import logger
from backend.app.events import EventDispatcher
from backend.app.security.workspace import WorkspacePathError, resolve_workspace_path
from backend.app.storage import StorageRepositories
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


@dataclass(frozen=True)
class CommandProcessResult:
    stdout: str
    stderr: str
    exit_code: int | None
    timed_out: bool
    truncated: bool


def create_shell_tools() -> list[FunctionTool]:
    return [
        FunctionTool(
            name="run_command",
            description=(
                "在当前工作区内执行一次性 shell 命令，并返回结构化结果，包括 "
                "status、stdout、stderr、exit_code、cwd、duration_ms、timed_out、"
                "truncated 和 approval。未信任命令会先请求用户审批；"
                "用户拒绝时不会执行命令，而是返回 status=rejected。适用于有边界的诊断或测试；"
                "该工具不是交互式终端，也不提供持久会话、后台任务或沙盒隔离。"
            ),
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
    settings = _command_settings(context)
    timeout_seconds = _timeout_seconds(args.get("timeout_seconds"), settings)
    max_capture_chars = int(settings.max_output_chars)
    cwd_label = _relative(cwd, context)
    approval: dict[str, Any] = {"required": False}

    if not settings.command_enabled:
        return _command_result(
            command=command,
            cwd_label=cwd_label,
            status="disabled",
            exit_code=None,
            stdout="",
            stderr="命令工具已在配置中禁用",
            duration_ms=0,
            timed_out=False,
            truncated=False,
            approval=approval,
            settings=settings,
        )

    repositories = _repositories(context)
    trusted_match = (
        find_trusted_command_rule(
            repositories,
            command=command,
            cwd=cwd_label,
            shell=_shell_name(),
            workspace_root=str(context.workspace_root),
        )
        if repositories is not None
        else None
    )
    if trusted_match is not None:
        approval = {
            "required": False,
            "trusted": True,
            "trusted_rule_id": trusted_match.rule.id,
            "match_type": trusted_match.rule.match_type,
        }
    elif settings.require_approval_for_untrusted and repositories is not None:
        approval_service = ApprovalService(
            repositories=repositories,
            dispatcher=_dispatcher(context),
        )
        request = await approval_service.create_request(
            session_id=context.session_id,
            user_id=context.user_id,
            command=command,
            cwd=cwd_label,
            shell=_shell_name(),
            workspace_root=str(context.workspace_root),
            trace_id=context.trace_id,
            turn_index=context.turn_index,
        )
        resolved = await approval_service.wait_for_decision(
            request.id,
            user_id=context.user_id,
            wait_seconds=_approval_wait_seconds(context),
        )
        approval = {
            "required": True,
            "approval_id": resolved.id,
            "status": resolved.status,
            "decision": resolved.decision,
            "trust_scope": resolved.trust_scope,
            "trusted_rule_id": resolved.trusted_rule_id,
            "reject_message": resolved.reject_message,
        }
        if resolved.status != "approved":
            return _command_result(
                command=command,
                cwd_label=cwd_label,
                status="rejected",
                exit_code=None,
                stdout="",
                stderr=resolved.reject_message or "用户拒绝执行该命令",
                duration_ms=0,
                timed_out=False,
                truncated=False,
                approval=approval,
                settings=settings,
            )

    started_at = time.perf_counter()
    try:
        process_result = await asyncio.to_thread(
            _run_subprocess,
            command=command,
            cwd=cwd,
            timeout_seconds=timeout_seconds,
            max_capture_chars=max_capture_chars,
        )
    except Exception as exc:
        duration_ms = int((time.perf_counter() - started_at) * 1000)
        error_message = str(exc).strip() or type(exc).__name__
        execution_error = {
            "code": "command_execution_failed",
            "message": error_message,
            "type": type(exc).__name__,
        }
        logger.opt(exception=True).error(
            "[ShellTool] 命令执行器异常 | "
            f"cwd={cwd_label} | duration_ms={duration_ms} | "
            f"error_type={type(exc).__name__} | error={error_message}"
        )
        return _command_result(
            command=command,
            cwd_label=cwd_label,
            status="failed",
            exit_code=None,
            stdout="",
            stderr=f"{type(exc).__name__}: {error_message}",
            duration_ms=duration_ms,
            timed_out=False,
            truncated=False,
            approval=approval,
            settings=settings,
            execution_error=execution_error,
        )

    duration_ms = int((time.perf_counter() - started_at) * 1000)
    if process_result.timed_out:
        logger.warning(
            "[ShellTool] 命令超时 | "
            f"cwd={_relative(cwd, context)} | timeout_seconds={timeout_seconds} | "
            f"duration_ms={duration_ms}"
        )
        return _command_result(
            command=command,
            cwd_label=cwd_label,
            status="timed_out",
            exit_code=process_result.exit_code,
            stdout=process_result.stdout,
            stderr=process_result.stderr,
            duration_ms=duration_ms,
            timed_out=True,
            truncated=process_result.truncated,
            approval=approval,
            settings=settings,
            timeout_seconds=timeout_seconds,
        )
    result = _command_result(
        command=command,
        cwd_label=cwd_label,
        status="completed",
        stdout=process_result.stdout,
        stderr=process_result.stderr,
        exit_code=process_result.exit_code,
        duration_ms=duration_ms,
        timed_out=False,
        truncated=process_result.truncated,
        approval=approval,
        settings=settings,
    )
    if process_result.exit_code != 0:
        logger.warning(
            "[ShellTool] 命令返回非零退出码 | "
            f"cwd={result['cwd']} | exit_code={process_result.exit_code} | "
            f"duration_ms={duration_ms} | stdout_chars={len(result['stdout'])} | "
            f"stderr_chars={len(result['stderr'])}"
        )
    logger.info(
        "[ShellTool] 命令完成 | "
        f"cwd={result['cwd']} | exit_code={process_result.exit_code} | "
        f"duration_ms={duration_ms} | stdout_chars={len(result['stdout'])} | "
        f"stderr_chars={len(result['stderr'])}"
    )
    return result


def _command_result(
    *,
    command: str,
    cwd_label: str,
    status: str,
    exit_code: int | None,
    stdout: str,
    stderr: str,
    duration_ms: int,
    timed_out: bool,
    truncated: bool,
    approval: dict[str, Any],
    settings: CommandSettings,
    timeout_seconds: float | None = None,
    execution_error: dict[str, Any] | None = None,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "command": command,
        "cwd": cwd_label,
        "status": status,
        "stdout": stdout,
        "stderr": stderr,
        "exit_code": exit_code,
        "duration_ms": duration_ms,
        "timed_out": timed_out,
        "truncated": truncated,
        "approval": dict(approval),
        "approval_summary": _approval_summary(approval, settings),
        "command_policy": _command_policy(settings),
    }
    if timeout_seconds is not None:
        result["timeout_seconds"] = timeout_seconds
    if execution_error is not None:
        result["execution_error"] = execution_error
    result["tool_summary"] = _command_tool_summary(result)
    return result


def _command_policy(settings: CommandSettings) -> dict[str, Any]:
    if not settings.command_enabled:
        label = "关闭命令行工具"
        description = "当前配置禁止 run_command 执行任何命令。"
    elif settings.require_approval_for_untrusted:
        label = "按请求"
        description = "未命中信任规则的命令会先请求用户审批；用户批准后才会执行。"
    else:
        label = "无条件信任"
        description = "当前配置不要求未信任命令审批，命令会直接执行。"
    return {
        "label": label,
        "description": description,
        "command_enabled": settings.command_enabled,
        "require_approval_for_untrusted": settings.require_approval_for_untrusted,
    }


def _approval_summary(approval: dict[str, Any], settings: CommandSettings) -> str:
    if approval.get("required"):
        decision = str(approval.get("decision") or approval.get("status") or "").strip()
        if decision == "approved":
            scope = "，并保存为信任规则" if approval.get("trusted_rule_id") else ""
            return f"本次命令已请求用户审批，用户已批准执行{scope}。"
        if decision == "rejected":
            reject_message = str(approval.get("reject_message") or "").strip()
            suffix = f"拒绝说明：{reject_message}" if reject_message else "命令未执行。"
            return f"本次命令已请求用户审批，用户已拒绝。{suffix}"
        return "本次命令已请求用户审批，但尚未得到可执行的批准结果。"
    if approval.get("trusted"):
        match_type = str(approval.get("match_type") or "trusted").strip()
        return f"本次命令命中已信任命令规则（{match_type}），未再次发起审批。"
    if not settings.command_enabled:
        return "命令行工具已关闭，未发起审批。"
    if not settings.require_approval_for_untrusted:
        return "当前策略为无条件信任，未发起审批。"
    return "本次命令不需要审批或没有可用审批仓储，未发起审批。"


def _command_tool_summary(result: dict[str, Any]) -> str:
    status = str(result.get("status") or "")
    approval_summary = str(result.get("approval_summary") or "")
    if status == "completed":
        exit_code = result.get("exit_code")
        if exit_code == 0:
            outcome = "命令已执行完成，退出码 0。"
        else:
            outcome = f"命令已执行完成，但退出码为 {exit_code}。"
    elif status == "failed":
        execution_error = result.get("execution_error")
        if isinstance(execution_error, dict):
            error_type = str(execution_error.get("type") or "执行器异常")
            message = str(execution_error.get("message") or "").strip()
            approval = result.get("approval")
            approved_after_request = (
                isinstance(approval, dict)
                and approval.get("required")
                and str(approval.get("decision") or approval.get("status") or "") == "approved"
            )
            prefix = "审批通过后尝试执行命令失败" if approved_after_request else "尝试执行命令失败"
            outcome = f"{prefix}，失败发生在命令执行器阶段：{error_type}"
            outcome = f"{outcome}: {message}。" if message else f"{outcome}。"
        else:
            outcome = "命令执行失败。"
    elif status == "rejected":
        outcome = "命令未执行，因为用户拒绝了审批。"
    elif status == "timed_out":
        outcome = "命令已开始执行，但超过超时时间后被终止。"
    elif status == "disabled":
        outcome = "命令未执行，因为命令行工具已在配置中关闭。"
    else:
        outcome = f"命令返回状态：{status or 'unknown'}。"
    return f"{outcome}审批感知：{approval_summary}"


def _require_command(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ToolExecutionError("command 必须是非空字符串", code="invalid_tool_args")
    return value.strip()


def _run_subprocess(
    *,
    command: str,
    cwd: Path,
    timeout_seconds: float,
    max_capture_chars: int,
) -> CommandProcessResult:
    try:
        completed = subprocess.run(
            command,
            cwd=cwd,
            shell=True,
            capture_output=True,
            timeout=timeout_seconds,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        stdout, stdout_truncated = _decode_output(
            _output_bytes(exc.output),
            max_chars=max_capture_chars,
        )
        stderr, stderr_truncated = _decode_output(
            _output_bytes(exc.stderr),
            max_chars=max_capture_chars,
        )
        return CommandProcessResult(
            stdout=stdout,
            stderr=stderr,
            exit_code=None,
            timed_out=True,
            truncated=stdout_truncated or stderr_truncated,
        )
    stdout, stdout_truncated = _decode_output(completed.stdout or b"", max_chars=max_capture_chars)
    stderr, stderr_truncated = _decode_output(completed.stderr or b"", max_chars=max_capture_chars)
    return CommandProcessResult(
        stdout=stdout,
        stderr=stderr,
        exit_code=completed.returncode,
        timed_out=False,
        truncated=stdout_truncated or stderr_truncated,
    )


def _output_bytes(value: bytes | str | None) -> bytes:
    if value is None:
        return b""
    if isinstance(value, bytes):
        return value
    return value.encode(locale.getpreferredencoding(False), errors="replace")


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


def _timeout_seconds(value: Any, settings: CommandSettings) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        parsed = settings.default_timeout_seconds
    max_timeout = min(float(settings.max_timeout_seconds), MAX_TIMEOUT_SECONDS)
    return min(max(parsed, 0.1), max_timeout)


def _decode_output(value: bytes, *, max_chars: int) -> tuple[str, bool]:
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
    if len(text) > max_chars:
        return f"{text[:max_chars]}\n...[输出已截断]", True
    return text, False


def _relative(path: Path, context: ToolExecutionContext) -> str:
    rel = path.resolve().relative_to(context.workspace_root).as_posix()
    return rel or "."


def _repositories(context: ToolExecutionContext) -> StorageRepositories | None:
    value = context.metadata.get("repositories")
    return value if isinstance(value, StorageRepositories) else None


def _dispatcher(context: ToolExecutionContext) -> EventDispatcher | None:
    value = context.metadata.get("dispatcher")
    return value if isinstance(value, EventDispatcher) else None


def _command_settings(context: ToolExecutionContext) -> CommandSettings:
    repositories = _repositories(context)
    if repositories is None:
        return CommandSettings()
    return load_command_settings(repositories)


def _approval_wait_seconds(context: ToolExecutionContext) -> float:
    value = context.metadata.get("approval_wait_seconds")
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return 24 * 60 * 60
    return max(0.1, parsed)


def _shell_name() -> str:
    return "shell"
