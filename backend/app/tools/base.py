from __future__ import annotations

import asyncio
import inspect
import re
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any, Protocol

from backend.app.core.errors import ErrorEnvelope, error_envelope
from backend.app.core.logger import logger, redact_sensitive
from backend.app.model import ToolSpec

if TYPE_CHECKING:
    from backend.app.agent.tool_results.models import ToolResultProjector
    from backend.app.services.file_history_service import FileHistoryService

_TOOL_NAME_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_MAX_ARG_PREVIEW_CHARS = 160


class ToolDefinitionError(ValueError):
    pass


class ToolExecutionError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        code: str = "tool_execution_failed",
        details: dict[str, Any] | None = None,
        retryable: bool = False,
        status: int | None = None,
    ) -> None:
        self.envelope: ErrorEnvelope = error_envelope(
            code,
            message,
            details=details,
            retryable=retryable,
            status=status,
        )
        super().__init__(self.envelope.message)
        self.code = self.envelope.code
        self.details = self.envelope.details
        self.retryable = self.envelope.retryable
        self.status = self.envelope.status

    def to_error_dict(self) -> dict[str, Any]:
        return self.envelope.to_public_dict()


@dataclass(frozen=True)
class FileHistoryExecutionScope:
    """File-history owner for a tool loop that may run in another Session."""

    session_id: str
    active_session_id: str | None
    trace_id: str | None
    turn_index: int
    input_snapshot_id: str


@dataclass(frozen=True)
class ToolExecutionContext:
    session_id: str
    user_id: str
    workspace_root: Path
    turn_index: int
    trace_id: str | None = None
    active_session_id: str | None = None
    assistant_message_id: str | None = None
    input_file_snapshot_id: str | None = None
    file_history_service: FileHistoryService | None = None
    file_history_tracking: bool = False
    file_history_scope: FileHistoryExecutionScope | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        object.__setattr__(self, "workspace_root", Path(self.workspace_root).resolve())

    @property
    def tool_call_id(self) -> str | None:
        value = str(self.metadata.get("tool_call_id") or "").strip()
        return value or None

    def require_file_history(self) -> tuple[FileHistoryService, str]:
        """Return turn-scoped history dependencies or a stable explicit error."""

        service, scope = self.require_file_history_scope()
        return service, scope.input_snapshot_id

    def require_file_history_scope(
        self,
    ) -> tuple[FileHistoryService, FileHistoryExecutionScope]:
        """Return the explicit history owner independently of the executing Session."""

        if not self.file_history_tracking:
            raise ToolExecutionError(
                "当前工具执行上下文明确未启用文件历史",
                code="file_history_untracked",
            )
        if self.file_history_service is None or not self.input_file_snapshot_id:
            raise ToolExecutionError(
                "受控文件工具缺少当前轮文件历史上下文",
                code="file_history_context_missing",
                details={"session_id": self.session_id, "turn_index": self.turn_index},
            )
        scope = self.file_history_scope or FileHistoryExecutionScope(
            session_id=self.session_id,
            active_session_id=self.active_session_id,
            trace_id=self.trace_id,
            turn_index=self.turn_index,
            input_snapshot_id=self.input_file_snapshot_id,
        )
        if not scope.session_id.strip() or not scope.input_snapshot_id.strip():
            raise ToolExecutionError(
                "文件历史归属上下文不完整",
                code="file_history_context_missing",
                details={"session_id": self.session_id, "turn_index": self.turn_index},
            )
        return self.file_history_service, scope


@dataclass(frozen=True)
class ToolExecutionResult:
    ok: bool
    result: Any = None
    error: dict[str, Any] | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def success(
        cls,
        result: Any,
        *,
        metadata: dict[str, Any] | None = None,
    ) -> ToolExecutionResult:
        return cls(ok=True, result=result, metadata=metadata or {})

    @classmethod
    def failed(
        cls,
        error: ToolExecutionError,
        *,
        metadata: dict[str, Any] | None = None,
    ) -> ToolExecutionResult:
        return cls(ok=False, error=error.to_error_dict(), metadata=metadata or {})


class LocalTool(Protocol):
    name: str
    description: str
    parameters: dict[str, Any]
    enabled: bool

    def to_tool_spec(self) -> ToolSpec: ...

    async def run(
        self,
        args: dict[str, Any],
        context: ToolExecutionContext,
    ) -> ToolExecutionResult: ...


ToolHandler = Callable[
    [dict[str, Any], ToolExecutionContext],
    Awaitable[Any] | Any,
]


def _preview_text(value: str, *, max_chars: int = _MAX_ARG_PREVIEW_CHARS) -> str:
    normalized = value.replace("\r", "\\r").replace("\n", "\\n")
    if len(normalized) <= max_chars:
        return normalized
    return f"{normalized[:max_chars]}..."


def _summarize_tool_args(tool_name: str, args: dict[str, Any]) -> dict[str, Any]:
    safe_args = redact_sensitive(args)
    if tool_name in {"create_file", "write_file"}:
        content = args.get("content")
        return {
            "path": safe_args.get("path"),
            "content_chars": len(content) if isinstance(content, str) else 0,
        }
    if tool_name == "apply_patch" or (tool_name == "edit_file" and "patch" in args):
        patch = args.get("patch")
        return {"patch_chars": len(patch) if isinstance(patch, str) else 0}
    if tool_name == "edit_file":
        old_string = args.get("old_string")
        new_string = args.get("new_string")
        return {
            "path": safe_args.get("path"),
            "old_string_chars": len(old_string) if isinstance(old_string, str) else 0,
            "new_string_chars": len(new_string) if isinstance(new_string, str) else 0,
            "replace_all": safe_args.get("replace_all"),
        }
    if tool_name == "delete_file":
        return {"path": safe_args.get("path")}
    if tool_name == "move_file":
        return {"path": safe_args.get("path"), "new_path": safe_args.get("new_path")}
    if tool_name in {"run_git_bash", "run_cmd", "run_powershell"}:
        command = args.get("command")
        summary: dict[str, Any] = {
            "cwd": safe_args.get("cwd"),
            "timeout_seconds": safe_args.get("timeout_seconds"),
            "description": safe_args.get("description"),
        }
        if isinstance(command, str):
            summary["command_preview"] = _preview_text(command)
            summary["command_chars"] = len(command)
        return summary
    if tool_name in {"read_file", "list_dir", "search_text", "search_files", "grep_files"}:
        allowed_keys = {
            "path",
            "query",
            "regex",
            "case_sensitive",
            "context_lines",
            "include",
            "exclude",
            "limit",
            "offset",
            "depth",
            "mode",
            "anchor_line",
            "include_hidden",
            "start_line",
            "max_lines",
        }
        return {
            key: _summarize_arg_value(value)
            for key, value in safe_args.items()
            if key in allowed_keys
        }
    return {key: _summarize_arg_value(value) for key, value in safe_args.items()}


def _summarize_arg_value(value: Any) -> Any:
    if isinstance(value, str):
        if len(value) <= _MAX_ARG_PREVIEW_CHARS:
            return value
        return {"preview": _preview_text(value), "chars": len(value)}
    if isinstance(value, list):
        return {"type": "list", "items": len(value)}
    if isinstance(value, dict):
        return {"type": "dict", "keys": sorted(str(key) for key in value)}
    return value


@dataclass
class FunctionTool:
    name: str
    description: str
    parameters: dict[str, Any]
    handler: ToolHandler
    enabled: bool = True
    result_projector: ToolResultProjector | None = None

    def __post_init__(self) -> None:
        validate_tool_name(self.name)
        validate_tool_schema(self.parameters)
        if not callable(self.handler):
            raise ToolDefinitionError(f"工具 {self.name} 的 handler 不可调用")

    def to_tool_spec(self) -> ToolSpec:
        return ToolSpec(
            name=self.name,
            description=self.description,
            parameters=self.parameters,
        )

    async def run(
        self,
        args: dict[str, Any],
        context: ToolExecutionContext,
    ) -> ToolExecutionResult:
        started_at = time.perf_counter()
        args_summary = _summarize_tool_args(self.name, args)
        logger.info(
            f"[Tool] 开始执行 | tool={self.name} | session_id={context.session_id} | "
            f"turn_index={context.turn_index} | trace_id={context.trace_id or '-'} | "
            f"args={args_summary}"
        )
        if not self.enabled:
            logger.warning(
                f"[Tool] 工具已禁用 | tool={self.name} | session_id={context.session_id} | "
                f"turn_index={context.turn_index}"
            )
            return ToolExecutionResult.failed(
                ToolExecutionError(
                    f"工具已禁用: {self.name}",
                    code="tool_disabled",
                    details={"tool": self.name},
                )
            )
        reservation = None
        guard = context.metadata.get("exploration_guard")
        try:
            if guard is not None:
                reservation = await guard.before_tool(
                    tool_name=self.name,
                    args=dict(args),
                    call_id=context.tool_call_id or "",
                    context=context,
                )
            value = self.handler(args, context)
            if inspect.isawaitable(value):
                value = await value
            duration_ms = max(0, int((time.perf_counter() - started_at) * 1000))
            logger.info(
                f"[Tool] 执行成功 | tool={self.name} | session_id={context.session_id} | "
                f"turn_index={context.turn_index} | trace_id={context.trace_id or '-'} | "
                f"duration_ms={duration_ms} | result_type={type(value).__name__}"
            )
            governance = None
            if guard is not None:
                governance = await guard.after_tool(
                    reservation,
                    tool_name=self.name,
                    args=dict(args),
                    result=value,
                )
            return ToolExecutionResult.success(
                value,
                metadata=(
                    {"_keydex_internal_governance": governance}
                    if governance is not None
                    else None
                ),
            )
        except asyncio.CancelledError:
            if guard is not None and reservation is not None:
                await guard.cancel_tool(reservation)
            raise
        except ToolExecutionError as exc:
            if guard is not None and reservation is not None:
                await guard.after_tool(
                    reservation,
                    tool_name=self.name,
                    args=dict(args),
                    result=None,
                )
            duration_ms = max(0, int((time.perf_counter() - started_at) * 1000))
            logger.warning(
                f"[Tool] 执行失败 | tool={self.name} | session_id={context.session_id} | "
                f"turn_index={context.turn_index} | trace_id={context.trace_id or '-'} | "
                f"duration_ms={duration_ms} | code={exc.code} | error={exc}"
            )
            return ToolExecutionResult.failed(exc)
        except Exception as exc:
            if guard is not None and reservation is not None:
                await guard.after_tool(
                    reservation,
                    tool_name=self.name,
                    args=dict(args),
                    result=None,
                )
            duration_ms = max(0, int((time.perf_counter() - started_at) * 1000))
            error_message = str(exc).strip() or type(exc).__name__
            logger.opt(exception=True).error(
                f"[Tool] 执行异常 | tool={self.name} | session_id={context.session_id} | "
                f"turn_index={context.turn_index} | trace_id={context.trace_id or '-'} | "
                f"duration_ms={duration_ms} | error={error_message}"
            )
            return ToolExecutionResult.failed(
                ToolExecutionError(
                    error_message,
                    details={"tool": self.name, "type": type(exc).__name__},
                )
            )


def validate_tool_name(name: str) -> None:
    if not _TOOL_NAME_PATTERN.fullmatch(name):
        raise ToolDefinitionError(f"工具名称必须匹配 {_TOOL_NAME_PATTERN.pattern}: {name!r}")


def validate_tool_schema(parameters: dict[str, Any]) -> None:
    if not isinstance(parameters, dict):
        raise ToolDefinitionError("工具参数 schema 必须是 JSON object")
    schema_type = parameters.get("type")
    if schema_type is not None and schema_type != "object":
        raise ToolDefinitionError("工具参数 schema 顶层 type 必须是 object")
    properties = parameters.get("properties")
    if properties is not None and not isinstance(properties, dict):
        raise ToolDefinitionError("工具参数 schema.properties 必须是 JSON object")
