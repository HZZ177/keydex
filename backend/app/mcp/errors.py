from __future__ import annotations

import asyncio
from typing import Any

from backend.app.mcp.types import McpErrorCode, McpErrorPayload

MCP_ERROR_MESSAGES: dict[McpErrorCode, str] = {
    McpErrorCode.MCP_DISABLED: "MCP 功能已关闭。",
    McpErrorCode.SERVER_NOT_FOUND: "找不到 MCP 服务器。",
    McpErrorCode.SERVER_DISABLED: "MCP 服务器已停用。",
    McpErrorCode.SERVER_OFFLINE: "MCP 服务器当前不可用，请检查连接配置或服务状态。",
    McpErrorCode.AUTH_REQUIRED: "MCP 服务器需要认证，请完成登录或补充凭据。",
    McpErrorCode.TOOL_NOT_FOUND: "找不到 MCP 工具。",
    McpErrorCode.TOOL_DISABLED_BY_POLICY: "MCP 工具已被全局策略停用。",
    McpErrorCode.TOOL_DISABLED_BY_SESSION: "MCP 工具已在当前会话停用。",
    McpErrorCode.APPROVAL_REQUIRED: "MCP 工具调用需要审批。",
    McpErrorCode.APPROVAL_REJECTED: "MCP 工具调用已被拒绝。",
    McpErrorCode.POLICY_DENIED: "MCP 策略拒绝了本次请求。",
    McpErrorCode.TIMEOUT: "MCP 操作超时，请稍后重试或调大超时时间。",
    McpErrorCode.CANCELLED: "MCP 操作已取消。",
    McpErrorCode.PROTOCOL_ERROR: "MCP 协议响应异常，请检查服务器实现。",
    McpErrorCode.VALIDATION_ERROR: "MCP 请求参数校验失败。",
    McpErrorCode.RESULT_TOO_LARGE: "MCP 返回结果超过限制。",
    McpErrorCode.RESOURCE_RESERVED: "MCP Resources 已预留，本期暂不开放读取。",
    McpErrorCode.INTERNAL_ERROR: "MCP 内部错误。",
}

_SENSITIVE_DETAIL_KEYS = (
    "authorization",
    "api_key",
    "apikey",
    "bearer",
    "credential",
    "password",
    "secret",
    "token",
)


class McpClientConnectionError(Exception):
    """Raised when a transport cannot connect or loses its connection."""


class McpClientAuthError(Exception):
    """Raised when a transport requires credentials or OAuth authorization."""


class McpClientProtocolError(Exception):
    """Raised when an MCP server returns an invalid protocol response."""


class McpClientValidationError(Exception):
    """Raised when host-side MCP request validation fails."""


class McpRuntimeError(Exception):
    def __init__(
        self,
        code: McpErrorCode,
        message: str | None = None,
        *,
        detail: dict[str, Any] | None = None,
        details: dict[str, Any] | None = None,
        retryable: bool | None = None,
        status: int | None = None,
    ) -> None:
        self.code = code
        self.message = message or MCP_ERROR_MESSAGES.get(code, "MCP error.")
        self.details = dict(details if details is not None else detail or {})
        self.retryable = (
            retryable
            if retryable is not None
            else code
            in {
                McpErrorCode.SERVER_OFFLINE,
                McpErrorCode.TIMEOUT,
                McpErrorCode.INTERNAL_ERROR,
            }
        )
        self.status = status
        super().__init__(self.message)

    @property
    def detail(self) -> dict[str, Any]:
        """Compatibility alias for legacy MCP internals."""

        return self.details

    def to_payload(self) -> McpErrorPayload:
        return McpErrorPayload(
            code=self.code,
            message=self.message,
            details=redact_mcp_error_detail(self.details),
            retryable=self.retryable,
            status=self.status,
        )


def map_mcp_exception_code(error: BaseException) -> McpErrorCode:
    if isinstance(error, McpRuntimeError):
        return error.code
    if isinstance(error, asyncio.CancelledError):
        return McpErrorCode.CANCELLED
    if isinstance(error, TimeoutError):
        return McpErrorCode.TIMEOUT
    if isinstance(error, McpClientAuthError):
        return McpErrorCode.AUTH_REQUIRED
    if isinstance(error, McpClientConnectionError):
        return McpErrorCode.SERVER_OFFLINE
    if isinstance(error, OSError):
        return McpErrorCode.SERVER_OFFLINE
    if isinstance(error, McpClientProtocolError):
        return McpErrorCode.PROTOCOL_ERROR
    if isinstance(error, (McpClientValidationError, ValueError)):
        return McpErrorCode.VALIDATION_ERROR
    return McpErrorCode.INTERNAL_ERROR


def to_mcp_runtime_error(error: BaseException) -> McpRuntimeError:
    if isinstance(error, McpRuntimeError):
        return error
    code = map_mcp_exception_code(error)
    return McpRuntimeError(code, details={"error_type": type(error).__name__})


def redact_mcp_error_detail(value: Any) -> Any:
    if isinstance(value, dict):
        redacted: dict[str, Any] = {}
        for key, item in value.items():
            key_text = str(key)
            if _is_sensitive_detail_key(key_text):
                redacted[key_text] = "***REDACTED***"
            else:
                redacted[key_text] = redact_mcp_error_detail(item)
        return redacted
    if isinstance(value, list):
        return [redact_mcp_error_detail(item) for item in value]
    if isinstance(value, tuple):
        return [redact_mcp_error_detail(item) for item in value]
    return value


def _is_sensitive_detail_key(key: str) -> bool:
    normalized = key.lower().replace("-", "_")
    return any(part in normalized for part in _SENSITIVE_DETAIL_KEYS)
