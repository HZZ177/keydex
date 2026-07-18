from __future__ import annotations

import re
from enum import StrEnum
from typing import Any

from pydantic import Field

from backend.app.core.errors import error_envelope
from backend.app.core.logger import REDACTED, redact_sensitive
from backend.app.web.models import WebDomainModel


class WebErrorCode(StrEnum):
    WEB_DISABLED = "web_disabled"
    PROVIDER_NOT_SELECTED = "provider_not_selected"
    PROVIDER_NOT_CONFIGURED = "provider_not_configured"
    AUTHENTICATION_FAILED = "authentication_failed"
    QUOTA_EXHAUSTED = "quota_exhausted"
    RATE_LIMITED = "rate_limited"
    REQUEST_TIMEOUT = "request_timeout"
    NETWORK_UNAVAILABLE = "network_unavailable"
    INVALID_REQUEST = "invalid_request"
    UNSUPPORTED_CAPABILITY = "unsupported_capability"
    UNSAFE_URL = "unsafe_url"
    PROVIDER_UNAVAILABLE = "provider_unavailable"
    PARTIAL_FAILURE = "partial_failure"
    RESPONSE_INVALID = "response_invalid"


_DEFAULT_MESSAGES: dict[WebErrorCode, str] = {
    WebErrorCode.WEB_DISABLED: "网络搜索未启用",
    WebErrorCode.PROVIDER_NOT_SELECTED: "尚未选择网络搜索引擎",
    WebErrorCode.PROVIDER_NOT_CONFIGURED: "当前搜索引擎尚未完成配置",
    WebErrorCode.AUTHENTICATION_FAILED: "搜索引擎密钥无效",
    WebErrorCode.QUOTA_EXHAUSTED: "搜索引擎额度不足",
    WebErrorCode.RATE_LIMITED: "搜索请求过于频繁，请稍后重试",
    WebErrorCode.REQUEST_TIMEOUT: "搜索引擎响应超时",
    WebErrorCode.NETWORK_UNAVAILABLE: "当前无法连接搜索引擎",
    WebErrorCode.INVALID_REQUEST: "网络搜索请求无效",
    WebErrorCode.UNSUPPORTED_CAPABILITY: "当前搜索引擎不支持此能力",
    WebErrorCode.UNSAFE_URL: "出于安全原因，无法读取该地址",
    WebErrorCode.PROVIDER_UNAVAILABLE: "搜索引擎暂时不可用",
    WebErrorCode.PARTIAL_FAILURE: "部分网页读取失败",
    WebErrorCode.RESPONSE_INVALID: "搜索引擎返回了无法识别的结果",
}

_RETRYABLE_CODES = frozenset(
    {
        WebErrorCode.RATE_LIMITED,
        WebErrorCode.REQUEST_TIMEOUT,
        WebErrorCode.NETWORK_UNAVAILABLE,
        WebErrorCode.PROVIDER_UNAVAILABLE,
        WebErrorCode.PARTIAL_FAILURE,
    }
)

_SENSITIVE_ASSIGNMENT_PATTERN = re.compile(
    r"(?i)(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)"
    r"(\s*[:=]\s*)(?:bearer\s+)?[^\s,;\]}]+"
)


def sanitize_web_diagnostic(
    value: Any,
    *,
    sensitive_values: tuple[str, ...] = (),
) -> Any:
    redacted = redact_sensitive(value)
    if isinstance(redacted, dict):
        return {
            str(key): sanitize_web_diagnostic(nested, sensitive_values=sensitive_values)
            for key, nested in redacted.items()
        }
    if isinstance(redacted, list):
        return [
            sanitize_web_diagnostic(item, sensitive_values=sensitive_values) for item in redacted
        ]
    if isinstance(redacted, tuple):
        return tuple(
            sanitize_web_diagnostic(item, sensitive_values=sensitive_values) for item in redacted
        )
    if not isinstance(redacted, str):
        return redacted

    safe = _SENSITIVE_ASSIGNMENT_PATTERN.sub(lambda match: f"{match.group(1)}={REDACTED}", redacted)
    for secret in sensitive_values:
        if secret:
            safe = safe.replace(secret, REDACTED)
    return safe


class WebErrorPayload(WebDomainModel):
    code: WebErrorCode
    message: str = Field(min_length=1)
    retryable: bool = False
    provider_id: str | None = None
    provider_request_id: str | None = None
    retry_after_seconds: int | None = Field(default=None, ge=0)
    status: int | None = Field(default=None, ge=100, le=599)
    diagnostic: dict[str, Any] = Field(default_factory=dict)

    def to_public_dict(self) -> dict[str, Any]:
        details: dict[str, Any] = {}
        if self.provider_id:
            details["provider_id"] = self.provider_id
        if self.provider_request_id:
            details["provider_request_id"] = self.provider_request_id
        if self.retry_after_seconds is not None:
            details["retry_after_seconds"] = self.retry_after_seconds
        return error_envelope(
            str(self.code),
            self.message,
            details=details,
            retryable=self.retryable,
            status=self.status,
        ).to_public_dict()

    def to_log_dict(self) -> dict[str, Any]:
        return {**self.to_public_dict(), "diagnostic": self.diagnostic}


def web_error(
    code: WebErrorCode,
    *,
    message: str | None = None,
    provider_id: str | None = None,
    provider_request_id: str | None = None,
    retryable: bool | None = None,
    retry_after_seconds: int | None = None,
    status: int | None = None,
    diagnostic: dict[str, Any] | None = None,
    sensitive_values: tuple[str, ...] = (),
) -> WebErrorPayload:
    return WebErrorPayload(
        code=code,
        message=message or _DEFAULT_MESSAGES[code],
        retryable=code in _RETRYABLE_CODES if retryable is None else retryable,
        provider_id=provider_id,
        provider_request_id=provider_request_id,
        retry_after_seconds=retry_after_seconds,
        status=status,
        diagnostic=sanitize_web_diagnostic(
            diagnostic or {},
            sensitive_values=sensitive_values,
        ),
    )


class WebProviderError(RuntimeError):
    def __init__(self, payload: WebErrorPayload) -> None:
        super().__init__(payload.message)
        self.payload = payload

    @property
    def code(self) -> str:
        return str(self.payload.code)

    def to_public_dict(self) -> dict[str, Any]:
        return self.payload.to_public_dict()


def web_error_from_exception(
    error: Exception,
    *,
    provider_id: str | None = None,
    sensitive_values: tuple[str, ...] = (),
) -> WebErrorPayload:
    return web_error(
        WebErrorCode.PROVIDER_UNAVAILABLE,
        provider_id=provider_id,
        diagnostic={"type": type(error).__name__, "message": str(error)},
        sensitive_values=sensitive_values,
    )
