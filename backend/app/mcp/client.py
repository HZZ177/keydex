from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

from backend.app.mcp.errors import McpRuntimeError
from backend.app.mcp.types import McpErrorCode, McpServerStatus


@dataclass(frozen=True)
class McpClientCapabilities:
    tools: bool = True
    resources_reserved: bool = True
    sampling: bool = False
    elicitation: bool = False
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class McpClientInitializeResult:
    protocol_version: str | None
    server_info: dict[str, Any]
    capabilities: McpClientCapabilities


@dataclass(frozen=True)
class McpClientToolSpec:
    name: str
    description: str | None
    input_schema: dict[str, Any]
    annotations: dict[str, Any] = field(default_factory=dict)
    raw: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class McpClientToolResult:
    call_id: str
    status: str
    content: list[Any]
    structured_content: dict[str, Any] | None = None
    is_error: bool = False
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class McpStateTransition:
    previous: McpServerStatus
    current: McpServerStatus
    reason: str | None = None


class McpInvalidStateTransition(ValueError):
    pass


class McpCancellationToken:
    def __init__(self) -> None:
        self._cancelled = False

    def cancel(self) -> None:
        self._cancelled = True

    def is_cancelled(self) -> bool:
        return self._cancelled

    def raise_if_cancelled(self) -> None:
        if self._cancelled:
            raise McpRuntimeError(McpErrorCode.CANCELLED)


class McpConnectionStateMachine:
    _ALLOWED_TRANSITIONS: dict[McpServerStatus, set[McpServerStatus]] = {
        McpServerStatus.UNKNOWN: {
            McpServerStatus.DISABLED,
            McpServerStatus.REFRESHING,
            McpServerStatus.ONLINE,
            McpServerStatus.OFFLINE,
            McpServerStatus.AUTH_REQUIRED,
            McpServerStatus.ERROR,
        },
        McpServerStatus.DISABLED: {McpServerStatus.UNKNOWN, McpServerStatus.REFRESHING},
        McpServerStatus.REFRESHING: {
            McpServerStatus.ONLINE,
            McpServerStatus.OFFLINE,
            McpServerStatus.AUTH_REQUIRED,
            McpServerStatus.ERROR,
            McpServerStatus.DISABLED,
        },
        McpServerStatus.ONLINE: {
            McpServerStatus.REFRESHING,
            McpServerStatus.OFFLINE,
            McpServerStatus.AUTH_REQUIRED,
            McpServerStatus.ERROR,
            McpServerStatus.DISABLED,
        },
        McpServerStatus.OFFLINE: {
            McpServerStatus.REFRESHING,
            McpServerStatus.ONLINE,
            McpServerStatus.AUTH_REQUIRED,
            McpServerStatus.ERROR,
            McpServerStatus.DISABLED,
        },
        McpServerStatus.AUTH_REQUIRED: {
            McpServerStatus.REFRESHING,
            McpServerStatus.ONLINE,
            McpServerStatus.ERROR,
            McpServerStatus.DISABLED,
        },
        McpServerStatus.ERROR: {
            McpServerStatus.UNKNOWN,
            McpServerStatus.REFRESHING,
            McpServerStatus.ONLINE,
            McpServerStatus.OFFLINE,
            McpServerStatus.AUTH_REQUIRED,
            McpServerStatus.DISABLED,
        },
    }

    def __init__(self, initial: McpServerStatus = McpServerStatus.UNKNOWN) -> None:
        self._status = initial
        self._history: list[McpStateTransition] = [
            McpStateTransition(previous=initial, current=initial, reason="initial")
        ]

    @property
    def status(self) -> McpServerStatus:
        return self._status

    @property
    def history(self) -> list[McpStateTransition]:
        return list(self._history)

    def transition_to(
        self,
        status: McpServerStatus,
        *,
        reason: str | None = None,
    ) -> McpStateTransition:
        if status != self._status and status not in self._ALLOWED_TRANSITIONS[self._status]:
            raise McpInvalidStateTransition(
                f"Invalid MCP state transition: {self._status}->{status}"
            )
        transition = McpStateTransition(previous=self._status, current=status, reason=reason)
        self._status = status
        self._history.append(transition)
        return transition


@runtime_checkable
class McpClient(Protocol):
    @property
    def server_id(self) -> str: ...

    @property
    def status(self) -> McpServerStatus: ...

    async def initialize(
        self,
        *,
        timeout_sec: float | None = None,
        cancellation: McpCancellationToken | None = None,
    ) -> McpClientInitializeResult: ...

    async def list_tools(
        self,
        *,
        timeout_sec: float | None = None,
        cancellation: McpCancellationToken | None = None,
    ) -> list[McpClientToolSpec]: ...

    async def call_tool(
        self,
        raw_tool_name: str,
        arguments: dict[str, Any] | None = None,
        *,
        call_id: str | None = None,
        timeout_sec: float | None = None,
        cancellation: McpCancellationToken | None = None,
    ) -> McpClientToolResult: ...

    async def cancel_call(self, call_id: str) -> bool: ...

    async def shutdown(self, *, timeout_sec: float | None = None) -> None: ...


class McpClientBase:
    def __init__(
        self,
        *,
        server_id: str,
        initial_status: McpServerStatus = McpServerStatus.UNKNOWN,
    ) -> None:
        self._server_id = server_id
        self._state = McpConnectionStateMachine(initial_status)

    @property
    def server_id(self) -> str:
        return self._server_id

    @property
    def status(self) -> McpServerStatus:
        return self._state.status

    @property
    def state_history(self) -> list[McpStateTransition]:
        return self._state.history

    def transition_status(
        self,
        status: McpServerStatus,
        *,
        reason: str | None = None,
    ) -> McpStateTransition:
        return self._state.transition_to(status, reason=reason)

    async def list_resources(self, *_args: Any, **_kwargs: Any) -> list[Any]:
        raise McpRuntimeError(McpErrorCode.RESOURCE_RESERVED)

    async def list_resource_templates(self, *_args: Any, **_kwargs: Any) -> list[Any]:
        raise McpRuntimeError(McpErrorCode.RESOURCE_RESERVED)

    async def read_resource(self, *_args: Any, **_kwargs: Any) -> Any:
        raise McpRuntimeError(McpErrorCode.RESOURCE_RESERVED)


def status_from_mcp_error_code(code: McpErrorCode) -> McpServerStatus:
    if code == McpErrorCode.AUTH_REQUIRED:
        return McpServerStatus.AUTH_REQUIRED
    if code in {McpErrorCode.MCP_DISABLED, McpErrorCode.SERVER_DISABLED}:
        return McpServerStatus.DISABLED
    if code in {McpErrorCode.SERVER_OFFLINE, McpErrorCode.TIMEOUT}:
        return McpServerStatus.OFFLINE
    return McpServerStatus.ERROR
