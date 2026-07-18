from __future__ import annotations

import math
import re
from collections.abc import Mapping
from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from backend.app.core.logger import REDACTED

ERROR_SCHEMA_VERSION = 1
MAX_ERROR_DETAIL_DEPTH = 8
MAX_ERROR_DETAIL_ITEMS = 64
MAX_ERROR_DETAIL_STRING_LENGTH = 4_000

_SENSITIVE_KEY_PATTERN = re.compile(
    r"(?i)(?:^|[_-])(api[_-]?key|authorization|auth[_-]?token|access[_-]?token|"
    r"refresh[_-]?token|cookie|credential|password|secret|token)(?:$|[_-])"
)
_SENSITIVE_ASSIGNMENT_PATTERN = re.compile(
    r"(?i)\b(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|"
    r"cookie|credential|password|secret|token)(\s*[:=]\s*)"
    r"(?:bearer\s+)?[^\s,;\]}]+"
)
_BEARER_PATTERN = re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._~+/=-]+")
_COMMON_SECRET_PATTERN = re.compile(
    r"(?i)\b(?:sk|xox[baprs]|gh[pousr]|pat)[-_][A-Za-z0-9_-]{8,}\b"
)


class ErrorEnvelope(BaseModel):
    """Canonical public error payload used at generic runtime boundaries."""

    model_config = ConfigDict(extra="ignore")

    schema_version: Literal[1] = ERROR_SCHEMA_VERSION
    code: str = Field(min_length=1)
    message: str = Field(min_length=1)
    details: dict[str, Any] = Field(default_factory=dict)
    retryable: bool = False
    status: int | None = Field(default=None, ge=100, le=599)

    @field_validator("code", "message")
    @classmethod
    def _strip_required_text(cls, value: str) -> str:
        normalized = value.strip()
        if not normalized:
            raise ValueError("must not be blank")
        return normalized

    @field_validator("details", mode="before")
    @classmethod
    def _sanitize_details(cls, value: Any) -> dict[str, Any]:
        return sanitize_public_details(value)

    def to_public_dict(self) -> dict[str, Any]:
        return self.model_dump(mode="json", exclude_none=True)


def error_envelope(
    code: str,
    message: str,
    *,
    details: dict[str, Any] | None = None,
    retryable: bool = False,
    status: int | None = None,
    sensitive_values: tuple[str, ...] = (),
) -> ErrorEnvelope:
    return ErrorEnvelope(
        code=code,
        message=message,
        details=sanitize_public_details(details, sensitive_values=sensitive_values),
        retryable=retryable,
        status=status,
    )


def normalize_error_envelope(
    value: Any,
    *,
    fallback_code: str = "runtime_error",
    fallback_message: str = "运行时错误",
    status: int | None = None,
) -> ErrorEnvelope:
    """Normalize canonical and supported legacy public error shapes."""

    if isinstance(value, ErrorEnvelope):
        if status is None or value.status is not None:
            return value.model_copy(deep=True)
        return value.model_copy(update={"status": status}, deep=True)

    root = _as_error_mapping(value)
    candidate = root
    detail = root.get("detail")
    nested_error = root.get("error")
    if isinstance(detail, Mapping):
        candidate = detail
    elif isinstance(nested_error, Mapping):
        candidate = nested_error

    code = _first_public_text(candidate.get("code"), root.get("code"), fallback_code)
    message = _first_public_text(
        candidate.get("message"),
        candidate.get("error") if isinstance(candidate.get("error"), str) else None,
        root.get("message"),
        nested_error if isinstance(nested_error, str) else None,
        value if isinstance(value, str) else None,
        fallback_message,
    )
    details_value = candidate.get("details")
    if not isinstance(details_value, Mapping):
        details_value = root.get("details")
    details = sanitize_public_details(details_value)
    retryable_value = candidate.get("retryable")
    if not isinstance(retryable_value, bool):
        retryable_value = root.get("retryable")
    retryable = retryable_value if isinstance(retryable_value, bool) else False
    status_value = candidate.get("status")
    if not _is_http_status(status_value):
        status_value = root.get("status")
    resolved_status = int(status_value) if _is_http_status(status_value) else status
    return error_envelope(
        code,
        message,
        details=details,
        retryable=retryable,
        status=resolved_status,
    )


def sanitize_public_details(
    value: Any,
    *,
    sensitive_values: tuple[str, ...] = (),
) -> dict[str, Any]:
    """Return a bounded, JSON-safe and redacted public details mapping."""

    if value is None:
        return {}
    source = value if isinstance(value, Mapping) else {"value": value}
    normalized = _sanitize_public_value(
        source,
        depth=0,
        active_ids=set(),
        sensitive_values=tuple(secret for secret in sensitive_values if secret),
    )
    return normalized if isinstance(normalized, dict) else {"value": normalized}


def _sanitize_public_value(
    value: Any,
    *,
    depth: int,
    active_ids: set[int],
    sensitive_values: tuple[str, ...],
) -> Any:
    if value is None or isinstance(value, (bool, int)):
        return value
    if isinstance(value, float):
        return value if math.isfinite(value) else str(value)
    if isinstance(value, str):
        return _sanitize_public_text(value, sensitive_values=sensitive_values)
    if isinstance(value, bytes):
        return f"<bytes:{len(value)}>"
    if isinstance(value, Enum):
        return _sanitize_public_value(
            value.value,
            depth=depth,
            active_ids=active_ids,
            sensitive_values=sensitive_values,
        )
    if depth >= MAX_ERROR_DETAIL_DEPTH:
        return "[MAX_DEPTH]"

    if isinstance(value, Mapping):
        return _sanitize_public_mapping(
            value,
            depth=depth,
            active_ids=active_ids,
            sensitive_values=sensitive_values,
        )
    if isinstance(value, (list, tuple, set, frozenset)):
        return _sanitize_public_sequence(
            value,
            depth=depth,
            active_ids=active_ids,
            sensitive_values=sensitive_values,
        )
    if isinstance(value, BaseModel):
        return _sanitize_public_value(
            value.model_dump(mode="python"),
            depth=depth,
            active_ids=active_ids,
            sensitive_values=sensitive_values,
        )

    try:
        rendered = str(value)
    except Exception:
        rendered = f"<{type(value).__name__}>"
    return _sanitize_public_text(rendered, sensitive_values=sensitive_values)


def _sanitize_public_mapping(
    value: Mapping[Any, Any],
    *,
    depth: int,
    active_ids: set[int],
    sensitive_values: tuple[str, ...],
) -> dict[str, Any]:
    identity = id(value)
    if identity in active_ids:
        return {"_circular": True}
    active_ids.add(identity)
    try:
        result: dict[str, Any] = {}
        items = list(value.items())
        for key, nested in items[:MAX_ERROR_DETAIL_ITEMS]:
            normalized_key = str(key)
            result[normalized_key] = (
                REDACTED
                if _is_sensitive_detail_key(normalized_key)
                else _sanitize_public_value(
                    nested,
                    depth=depth + 1,
                    active_ids=active_ids,
                    sensitive_values=sensitive_values,
                )
            )
        if len(items) > MAX_ERROR_DETAIL_ITEMS:
            result["_truncated_items"] = len(items) - MAX_ERROR_DETAIL_ITEMS
        return result
    finally:
        active_ids.remove(identity)


def _sanitize_public_sequence(
    value: list[Any] | tuple[Any, ...] | set[Any] | frozenset[Any],
    *,
    depth: int,
    active_ids: set[int],
    sensitive_values: tuple[str, ...],
) -> list[Any]:
    identity = id(value)
    if identity in active_ids:
        return ["[CIRCULAR]"]
    active_ids.add(identity)
    try:
        items = list(value)
        result = [
            _sanitize_public_value(
                item,
                depth=depth + 1,
                active_ids=active_ids,
                sensitive_values=sensitive_values,
            )
            for item in items[:MAX_ERROR_DETAIL_ITEMS]
        ]
        if len(items) > MAX_ERROR_DETAIL_ITEMS:
            result.append({"_truncated_items": len(items) - MAX_ERROR_DETAIL_ITEMS})
        return result
    finally:
        active_ids.remove(identity)


def _sanitize_public_text(value: str, *, sensitive_values: tuple[str, ...]) -> str:
    safe = _SENSITIVE_ASSIGNMENT_PATTERN.sub(
        lambda match: f"{match.group(1)}{match.group(2)}{REDACTED}",
        value,
    )
    safe = _BEARER_PATTERN.sub(f"Bearer {REDACTED}", safe)
    safe = _COMMON_SECRET_PATTERN.sub(REDACTED, safe)
    for secret in sensitive_values:
        safe = safe.replace(secret, REDACTED)
    if len(safe) > MAX_ERROR_DETAIL_STRING_LENGTH:
        omitted = len(safe) - MAX_ERROR_DETAIL_STRING_LENGTH
        return f"{safe[:MAX_ERROR_DETAIL_STRING_LENGTH]}…[TRUNCATED:{omitted}]"
    return safe


def _is_sensitive_detail_key(key: str) -> bool:
    normalized = key.strip().lower().replace("-", "_")
    return bool(_SENSITIVE_KEY_PATTERN.search(normalized))


def _as_error_mapping(value: Any) -> Mapping[str, Any]:
    if isinstance(value, Mapping):
        return value
    if isinstance(value, BaseException):
        return {
            "code": getattr(value, "code", None),
            "message": str(value),
            "details": getattr(value, "details", None),
            "retryable": getattr(value, "retryable", None),
            "status": getattr(value, "status", None),
        }
    return {}


def _first_public_text(*values: Any) -> str:
    for value in values:
        if isinstance(value, str) and value.strip():
            return value.strip()
    return "runtime_error"


def _is_http_status(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and 100 <= value <= 599


__all__ = [
    "ERROR_SCHEMA_VERSION",
    "MAX_ERROR_DETAIL_DEPTH",
    "MAX_ERROR_DETAIL_ITEMS",
    "MAX_ERROR_DETAIL_STRING_LENGTH",
    "ErrorEnvelope",
    "error_envelope",
    "normalize_error_envelope",
    "sanitize_public_details",
]
