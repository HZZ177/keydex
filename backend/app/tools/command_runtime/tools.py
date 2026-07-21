from __future__ import annotations

import asyncio
import time
from pathlib import Path
from typing import Any

from langchain_core.runnables import RunnableConfig

from backend.app.agent.tool_results.specialized import command_result_projector
from backend.app.command_approval import (
    ApprovalService,
    find_trusted_command_rule,
    load_command_settings,
)
from backend.app.core.ids import new_id
from backend.app.events import DomainEventType, EventDispatcher
from backend.app.security.workspace import WorkspacePathError, resolve_workspace_path
from backend.app.storage import StorageRepositories
from backend.app.tools.base import FunctionTool, ToolExecutionContext, ToolExecutionError
from backend.app.tools.command_runtime.descriptions import command_tool_description
from backend.app.tools.command_runtime.discovery import validate_shell_executable
from backend.app.tools.command_runtime.models import (
    SHELL_BY_TOOL,
    CommandRequest,
    CommandRunResult,
    CommandRuntime,
    CommandSettings,
    CommandTimeoutSource,
    CommandToolArgs,
)
from backend.app.tools.command_runtime.output_store import CommandOutputStore
from backend.app.tools.command_runtime.process_manager import command_process_manager
from backend.app.tools.command_runtime.runner import CommandRunner
from backend.app.tools.registry import ToolRegistry

DEFAULT_APPROVAL: dict[str, Any] = {"required": False}


def create_command_tools(settings: CommandSettings) -> list[FunctionTool]:
    runtime = CommandRuntime.from_settings(settings)
    if runtime is None:
        return []
    return [
        FunctionTool(
            name=runtime.tool_name,
            description=command_tool_description(runtime),
            parameters=command_tool_schema(),
            handler=run_configured_command_tool,
            result_projector=command_result_projector,
        )
    ]


def register_command_tools(registry: ToolRegistry, settings: CommandSettings) -> ToolRegistry:
    for tool in create_command_tools(settings):
        registry.register(tool)
    return registry


def command_tool_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            "command": {
                "type": "string",
                "description": "要执行的命令，必须匹配当前工具对应 shell 的语法。",
            },
            "description": {
                "type": "string",
                "description": "一句话说明为什么运行该命令，便于用户审批。",
            },
            "cwd": {
                "type": "string",
                "description": (
                    "执行目录，默认工作区根目录；完全访问时可使用当前用户有权限访问的任意本地目录。"
                ),
                "default": ".",
            },
            "timeout_seconds": {
                "type": "number",
                "minimum": 0.1,
                "maximum": 3600,
                "description": "前台阻塞等待的超时时间，由工具按配置上限收敛。",
            },
        },
        "required": ["command"],
    }


async def run_configured_command_tool(
    args: dict[str, Any],
    context: ToolExecutionContext,
) -> dict[str, Any]:
    tool_args = _parse_args(args)
    settings = _command_settings(context)
    runtime = CommandRuntime.from_settings(settings)
    tool_name = _tool_name(context)
    timeout_seconds = _effective_timeout(tool_args.timeout_seconds, settings)
    timeout_source: CommandTimeoutSource = (
        "default" if tool_args.timeout_seconds is None else "model"
    )
    if runtime is None or tool_name not in SHELL_BY_TOOL or runtime.tool_name != tool_name:
        return _unavailable_result(
            tool_name=tool_name,
            command=tool_args.command,
            settings=settings,
            timeout_seconds=timeout_seconds,
            timeout_source=timeout_source,
        )
    validation = validate_shell_executable(runtime.shell, runtime.shell_path)
    if not validation.found:
        return _unavailable_result(
            tool_name=tool_name,
            command=tool_args.command,
            settings=settings,
            timeout_seconds=timeout_seconds,
            timeout_source=timeout_source,
            error=validation.error or "当前命令环境不可用",
        )

    cwd = _resolve_cwd(
        tool_args.cwd,
        context,
        file_access_mode=settings.file_access_mode,
    )
    cwd_label = _relative(cwd, context)
    command_id = new_id()
    run_id = _metadata_text(context, "run_id")
    tool_call_id = _metadata_text(context, "tool_call_id")
    request = CommandRequest(
        command_id=command_id,
        tool_name=runtime.tool_name,
        command=tool_args.command,
        description=tool_args.description,
        cwd=cwd,
        cwd_label=cwd_label,
        timeout_seconds=timeout_seconds,
        timeout_source=timeout_source,
        session_id=context.session_id,
        user_id=context.user_id,
        turn_index=context.turn_index,
        trace_id=context.trace_id,
        run_id=run_id,
        tool_call_id=tool_call_id,
    )
    approval = await _approval_before_spawn(
        request=request,
        runtime=runtime,
        context=context,
        settings=settings,
    )
    if approval.get("status") == "rejected" or approval.get("decision") == "rejected":
        result = _rejected_result(request=request, runtime=runtime, approval=approval)
        return result.to_payload()

    output_store = CommandOutputStore(
        output_path=_output_path(context, command_id),
        inline_output_max_chars=settings.inline_output_max_chars,
        tail_max_chars=settings.tail_max_chars,
        output_file_max_bytes=settings.output_file_max_bytes,
    )
    runner = CommandRunner()
    progress_task = asyncio.create_task(
        _emit_progress_until_done(
            request=request,
            runtime=runtime,
            output_store=output_store,
            context=context,
            settings=settings,
        )
    )
    try:
        result = await asyncio.to_thread(
            runner.run,
            request=request,
            runtime=runtime,
            output_store=output_store,
            approval=approval,
        )
    finally:
        progress_task.cancel()
        try:
            await progress_task
        except asyncio.CancelledError:
            pass
    await _emit_final_progress(result, context)
    return result.to_payload()


def attach_command_runtime_metadata(
    context: ToolExecutionContext,
    *,
    config: RunnableConfig | None = None,
) -> ToolExecutionContext:
    metadata = dict(context.metadata)
    if config:
        run_id = str(config.get("run_id") or "").strip()
        if run_id:
            metadata["run_id"] = run_id
        configurable = config.get("configurable")
        if isinstance(configurable, dict):
            for key in ("tool_call_id", "run_id"):
                value = str(configurable.get(key) or "").strip()
                if value:
                    metadata[key] = value
        meta = config.get("metadata")
        if isinstance(meta, dict):
            for key in ("tool_call_id", "run_id"):
                value = str(meta.get(key) or "").strip()
                if value:
                    metadata[key] = value
    return ToolExecutionContext(
        session_id=context.session_id,
        user_id=context.user_id,
        workspace_root=context.workspace_root,
        turn_index=context.turn_index,
        trace_id=context.trace_id,
        metadata=metadata,
    )


async def _approval_before_spawn(
    *,
    request: CommandRequest,
    runtime: CommandRuntime,
    context: ToolExecutionContext,
    settings: CommandSettings,
) -> dict[str, Any]:
    repositories = _repositories(context)
    trusted_match = (
        find_trusted_command_rule(
            repositories,
            command=request.command,
            cwd=request.cwd_label,
            shell=runtime.shell,
            shell_path=runtime.shell_path,
            tool_name=runtime.tool_name,
            workspace_root=str(context.workspace_root),
        )
        if repositories is not None
        else None
    )
    if trusted_match is not None:
        return {
            "required": False,
            "trusted": True,
            "trusted_rule_id": trusted_match.rule.id,
            "match_type": trusted_match.rule.match_type,
        }
    if not settings.require_approval_for_untrusted or repositories is None:
        return dict(DEFAULT_APPROVAL)
    request_details = {
        "command_id": request.command_id,
        "tool": runtime.tool_name,
        "shell": runtime.shell,
        "shell_label": runtime.shell_label,
        "shell_path": runtime.shell_path,
        "description": request.description,
        "timeout_seconds": request.timeout_seconds,
        "timeout_source": request.timeout_source,
        "workspace_root": str(context.workspace_root),
    }
    approval_service = ApprovalService(
        repositories=repositories,
        dispatcher=_dispatcher(context),
    )
    approval_request = await approval_service.create_request(
        session_id=context.session_id,
        user_id=context.user_id,
        command=request.command,
        cwd=request.cwd_label,
        shell=runtime.shell,
        shell_path=runtime.shell_path,
        tool_name=runtime.tool_name,
        workspace_root=str(context.workspace_root),
        trace_id=context.trace_id,
        turn_index=context.turn_index,
        run_id=request.run_id,
        details=request_details,
    )
    resolved = await approval_service.wait_for_decision(
        approval_request.id,
        user_id=context.user_id,
        wait_seconds=_approval_wait_seconds(context),
    )
    return {
        "required": True,
        "approval_id": resolved.id,
        "status": resolved.status,
        "decision": resolved.decision,
        "trust_scope": resolved.trust_scope,
        "trusted_rule_id": resolved.trusted_rule_id,
        "reject_message": resolved.reject_message,
    }


async def _emit_progress_until_done(
    *,
    request: CommandRequest,
    runtime: CommandRuntime,
    output_store: CommandOutputStore,
    context: ToolExecutionContext,
    settings: CommandSettings,
) -> None:
    dispatcher = _dispatcher(context)
    if dispatcher is None:
        return
    started_at = time.perf_counter()
    interval = settings.progress_interval_ms / 1000
    active = command_process_manager.get(request.command_id)
    while active is None:
        await asyncio.sleep(min(interval, 0.01))
        active = command_process_manager.get(request.command_id)
    while True:
        snapshot = output_store.snapshot()
        cancel_reason = active.cancel_reason if active is not None else None
        terminating = active is not None and active.cancel_event.is_set()
        status = "terminating" if terminating else "running" if active is not None else "completed"
        await dispatcher.emit_event(
            event_type=DomainEventType.LLM_TOOL_PROGRESS.value,
            source="command_runtime",
            payload={
                "kind": "command_progress",
                "command_id": request.command_id,
                "tool": runtime.tool_name,
                "run_id": request.run_id,
                "tool_call_id": request.tool_call_id,
                "shell": runtime.shell,
                "shell_label": runtime.shell_label,
                "shell_path": runtime.shell_path,
                "command": request.command,
                "description": request.description,
                "cwd": request.cwd_label,
                "timeout_seconds": request.timeout_seconds,
                "timeout_source": request.timeout_source,
                "status": status,
                "cancel_reason": cancel_reason,
                "elapsed_ms": int((time.perf_counter() - started_at) * 1000),
                "output_bytes": snapshot.output_bytes,
                "combined_tail": snapshot.combined_tail,
                "stdout_tail": snapshot.stdout_tail,
                "stderr_tail": snapshot.stderr_tail,
                "output_path": snapshot.output_path,
                "can_terminate": active is not None and not terminating,
                "session_id": context.session_id,
                "trace_id": context.trace_id,
            },
            trace_id=context.trace_id,
            user_id=context.user_id,
            original_session_id=context.session_id,
            active_session_id=context.session_id,
            run_id=request.run_id,
            turn_index=context.turn_index,
        )
        await asyncio.sleep(interval)
        active = command_process_manager.get(request.command_id)


async def _emit_final_progress(result: CommandRunResult, context: ToolExecutionContext) -> None:
    dispatcher = _dispatcher(context)
    if dispatcher is None:
        return
    payload = result.to_payload()
    payload["kind"] = "command_result"
    payload["session_id"] = context.session_id
    payload["trace_id"] = context.trace_id
    await dispatcher.emit_event(
        event_type=DomainEventType.LLM_TOOL_PROGRESS.value,
        source="command_runtime",
        payload=payload,
        trace_id=context.trace_id,
        user_id=context.user_id,
        original_session_id=context.session_id,
        active_session_id=context.session_id,
        run_id=result.run_id,
        turn_index=context.turn_index,
    )


def _parse_args(args: dict[str, Any]) -> CommandToolArgs:
    try:
        return CommandToolArgs(**args)
    except Exception as exc:
        raise ToolExecutionError(str(exc), code="invalid_tool_args") from exc


def _unavailable_result(
    *,
    tool_name: str,
    command: str,
    settings: CommandSettings,
    timeout_seconds: float,
    timeout_source: CommandTimeoutSource,
    error: str | None = None,
) -> dict[str, Any]:
    shell = settings.selected_shell
    message = (
        error
        or "当前未配置可用命令执行环境，请先在设置页选择并保存 Git Bash、CMD 或 PowerShell。"
    )
    return {
        "kind": "command_result",
        "tool": tool_name,
        "shell": shell,
        "shell_label": settings.shell_label,
        "shell_path": settings.shell_path,
        "command": command,
        "status": "shell_not_available",
        "timeout_seconds": timeout_seconds,
        "timeout_source": timeout_source,
        "exit_code": None,
        "stdout": "",
        "stderr": message,
        "combined_tail": "",
        "output_path": None,
        "output_bytes": 0,
        "output_truncated": False,
        "output_limit_exceeded": False,
        "approval": dict(DEFAULT_APPROVAL),
        "can_terminate": False,
        "tool_summary": message,
    }


def _rejected_result(
    *,
    request: CommandRequest,
    runtime: CommandRuntime,
    approval: dict[str, Any],
) -> CommandRunResult:
    return CommandRunResult(
        kind="command_result",
        command_id=request.command_id,
        tool=request.tool_name,
        shell=runtime.shell,
        shell_label=runtime.shell_label,
        shell_path=runtime.shell_path,
        command=request.command,
        description=request.description,
        cwd=request.cwd_label,
        status="rejected",
        exit_code=None,
        duration_ms=0,
        timeout_seconds=request.timeout_seconds,
        timeout_source=request.timeout_source,
        output_path=None,
        output_bytes=0,
        output_truncated=False,
        output_limit_exceeded=False,
        stdout="",
        stderr=str(approval.get("reject_message") or "用户拒绝执行该命令"),
        stdout_tail="",
        stderr_tail="",
        combined_tail="",
        approval=approval,
        run_id=request.run_id,
        tool_call_id=request.tool_call_id,
    )


def _resolve_cwd(
    raw_path: str,
    context: ToolExecutionContext,
    *,
    file_access_mode: str | None = None,
) -> Path:
    if file_access_mode == "full_access":
        candidate = Path(raw_path or ".").expanduser()
        cwd = (
            candidate
            if candidate.is_absolute()
            else Path(context.workspace_root) / candidate
        ).resolve(strict=False)
    else:
        try:
            cwd = resolve_workspace_path(
                raw_path or ".",
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


def _relative(path: Path, context: ToolExecutionContext) -> str:
    resolved = path.resolve()
    try:
        rel = resolved.relative_to(Path(context.workspace_root).resolve()).as_posix()
    except ValueError:
        return str(resolved)
    return rel or "."


def _effective_timeout(value: float | None, settings: CommandSettings) -> float:
    parsed = settings.default_timeout_seconds if value is None else float(value)
    return min(max(parsed, 0.1), settings.max_timeout_seconds)


def _output_path(context: ToolExecutionContext, command_id: str) -> Path:
    data_dir = Path(str(context.metadata.get("data_dir") or context.workspace_root))
    return data_dir / "tool-results" / "commands" / f"{command_id}.log"


def _command_settings(context: ToolExecutionContext) -> CommandSettings:
    repositories = _repositories(context)
    if repositories is None:
        return CommandSettings()
    return load_command_settings(repositories)


def _repositories(context: ToolExecutionContext) -> StorageRepositories | None:
    value = context.metadata.get("repositories")
    return value if isinstance(value, StorageRepositories) else None


def _dispatcher(context: ToolExecutionContext) -> EventDispatcher | None:
    value = context.metadata.get("dispatcher")
    return value if isinstance(value, EventDispatcher) else None


def _tool_name(context: ToolExecutionContext) -> str:
    return str(context.metadata.get("tool_name") or "").strip()


def _metadata_text(context: ToolExecutionContext, key: str) -> str | None:
    value = str(context.metadata.get(key) or "").strip()
    return value or None


def _approval_wait_seconds(context: ToolExecutionContext) -> float:
    value = context.metadata.get("approval_wait_seconds")
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return 24 * 60 * 60
    return max(0.1, parsed)
