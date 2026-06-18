from __future__ import annotations

import inspect
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from backend.app.model import ToolSpec

_TOOL_NAME_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


class ToolDefinitionError(ValueError):
    pass


class ToolExecutionError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        code: str = "tool_execution_failed",
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.details = details or {}

    def to_error_dict(self) -> dict[str, Any]:
        return {"code": self.code, "message": str(self), "details": self.details}


@dataclass(frozen=True)
class ToolExecutionContext:
    session_id: str
    user_id: str
    workspace_root: Path
    turn_index: int
    trace_id: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        object.__setattr__(self, "workspace_root", Path(self.workspace_root).resolve())


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

    def to_tool_spec(self) -> ToolSpec:
        ...

    async def run(
        self,
        args: dict[str, Any],
        context: ToolExecutionContext,
    ) -> ToolExecutionResult:
        ...


ToolHandler = Callable[
    [dict[str, Any], ToolExecutionContext],
    Awaitable[Any] | Any,
]


@dataclass
class FunctionTool:
    name: str
    description: str
    parameters: dict[str, Any]
    handler: ToolHandler
    enabled: bool = True

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
        if not self.enabled:
            return ToolExecutionResult.failed(
                ToolExecutionError(
                    f"工具已禁用: {self.name}",
                    code="tool_disabled",
                    details={"tool": self.name},
                )
            )
        try:
            value = self.handler(args, context)
            if inspect.isawaitable(value):
                value = await value
            return ToolExecutionResult.success(value)
        except ToolExecutionError as exc:
            return ToolExecutionResult.failed(exc)
        except Exception as exc:
            return ToolExecutionResult.failed(
                ToolExecutionError(
                    str(exc),
                    details={"tool": self.name, "type": type(exc).__name__},
                )
            )


def validate_tool_name(name: str) -> None:
    if not _TOOL_NAME_PATTERN.fullmatch(name):
        raise ToolDefinitionError(
            f"工具名称必须匹配 {_TOOL_NAME_PATTERN.pattern}: {name!r}"
        )


def validate_tool_schema(parameters: dict[str, Any]) -> None:
    if not isinstance(parameters, dict):
        raise ToolDefinitionError("工具参数 schema 必须是 JSON object")
    schema_type = parameters.get("type")
    if schema_type is not None and schema_type != "object":
        raise ToolDefinitionError("工具参数 schema 顶层 type 必须是 object")
    properties = parameters.get("properties")
    if properties is not None and not isinstance(properties, dict):
        raise ToolDefinitionError("工具参数 schema.properties 必须是 JSON object")
