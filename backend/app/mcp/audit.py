from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Protocol

from backend.app.core.ids import new_id
from backend.app.core.logger import get_logger
from backend.app.storage.repositories import McpAuditLogRecord, StorageRepositories

REDACTED_VALUE = "***REDACTED***"
_SENSITIVE_KEY_PARTS = (
    "token",
    "apikey",
    "password",
    "secret",
    "authorization",
    "accesstoken",
    "refreshtoken",
    "idtoken",
    "clientsecret",
    "bearertoken",
)
_SAFE_TOKEN_METRIC_KEYS = {
    "totaltokens",
    "prompttokens",
    "completiontokens",
    "inputtokens",
    "outputtokens",
    "cachedtokens",
    "reasoningtokens",
    "maxtokens",
    "maxoutputtokens",
    "maxcompletiontokens",
}
_BEARER_PATTERN = re.compile(r"\b(Bearer)\s+([A-Za-z0-9._~+/=-]+)", re.IGNORECASE)
_SECRET_PAIR_PATTERN = re.compile(
    r"\b(api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|password|"
    r"secret|authorization)\b\s*[:=]\s*(?:Bearer\s+)?([^,;\s]+)",
    re.IGNORECASE,
)
_MAX_AUDIT_STRING_LENGTH = 16_384

logger = get_logger(__name__)


class McpAuditWriteError(RuntimeError):
    """Raised only when callers explicitly require audit write failure propagation."""


class McpAuditRepository(Protocol):
    def append(
        self,
        *,
        audit_id: str,
        event_type: str,
        server_id: str | None = None,
        raw_tool_name: str | None = None,
        session_id: str | None = None,
        turn_id: str | None = None,
        call_id: str | None = None,
        approval_id: str | None = None,
        actor: str | None = None,
        status: str | None = None,
        duration_ms: int | None = None,
        summary: str | None = None,
        detail: dict[str, Any] | None = None,
    ) -> McpAuditLogRecord: ...

    def list(
        self,
        *,
        server_id: str | None = None,
        session_id: str | None = None,
        event_type: str | None = None,
        status: str | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> tuple[list[McpAuditLogRecord], int]: ...


@dataclass(frozen=True)
class McpAuditListResult:
    records: list[McpAuditLogRecord]
    total: int


class McpAuditWriter:
    def __init__(self, audit_repository: McpAuditRepository) -> None:
        self.audit_repository = audit_repository

    @classmethod
    def from_repositories(cls, repositories: StorageRepositories) -> McpAuditWriter:
        return cls(repositories.mcp_audit_log)

    def append_event(
        self,
        *,
        event_type: str,
        server_id: str | None = None,
        raw_tool_name: str | None = None,
        session_id: str | None = None,
        turn_id: str | None = None,
        call_id: str | None = None,
        approval_id: str | None = None,
        actor: str | None = None,
        status: str | None = None,
        duration_ms: int | None = None,
        summary: str | None = None,
        detail: dict[str, Any] | None = None,
        audit_id: str | None = None,
        raise_on_failure: bool = False,
    ) -> McpAuditLogRecord | None:
        clean_event_type = event_type.strip()
        if not clean_event_type:
            raise ValueError("MCP audit event_type must not be empty")

        safe_summary = redact_sensitive_text(summary) if summary is not None else None
        safe_detail = redact_sensitive_data(detail) if detail is not None else None
        try:
            return self.audit_repository.append(
                audit_id=audit_id or new_id(),
                event_type=clean_event_type,
                server_id=server_id,
                raw_tool_name=raw_tool_name,
                session_id=session_id,
                turn_id=turn_id,
                call_id=call_id,
                approval_id=approval_id,
                actor=actor,
                status=status,
                duration_ms=duration_ms,
                summary=safe_summary,
                detail=safe_detail,
            )
        except Exception as exc:
            logger.warning(
                (
                    "[MCP Audit] 写入失败 | event_type={} | server_id={} | "
                    "session_id={} | error_type={}"
                ),
                clean_event_type,
                server_id or "",
                session_id or "",
                type(exc).__name__,
            )
            if raise_on_failure:
                raise McpAuditWriteError("Failed to write MCP audit log.") from None
            return None

    def list_events(
        self,
        *,
        server_id: str | None = None,
        session_id: str | None = None,
        event_type: str | None = None,
        status: str | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> McpAuditListResult:
        records, total = self.audit_repository.list(
            server_id=server_id,
            session_id=session_id,
            event_type=event_type,
            status=status,
            limit=limit,
            offset=offset,
        )
        return McpAuditListResult(records=records, total=total)


def redact_sensitive_data(value: dict[str, Any]) -> dict[str, Any]:
    redacted = _redact_value(value)
    if not isinstance(redacted, dict):
        return {"value": redacted}
    return redacted


def redact_sensitive_text(value: str) -> str:
    redacted = _BEARER_PATTERN.sub(r"\1 " + REDACTED_VALUE, value)
    redacted = _SECRET_PAIR_PATTERN.sub(
        lambda match: f"{match.group(1)}={REDACTED_VALUE}",
        redacted,
    )
    if len(redacted) > _MAX_AUDIT_STRING_LENGTH:
        return f"{redacted[:_MAX_AUDIT_STRING_LENGTH]}...<truncated>"
    return redacted


def _redact_value(value: Any, *, key: str | None = None) -> Any:
    if key is not None and _is_sensitive_key(key):
        return REDACTED_VALUE
    if isinstance(value, Mapping):
        return {
            str(item_key): _redact_value(nested, key=str(item_key))
            for item_key, nested in value.items()
        }
    if isinstance(value, list):
        return [_redact_value(item) for item in value]
    if isinstance(value, tuple):
        return [_redact_value(item) for item in value]
    if isinstance(value, set):
        return [_redact_value(item) for item in sorted(value, key=repr)]
    if isinstance(value, str):
        return redact_sensitive_text(value)
    if value is None or isinstance(value, bool | int | float):
        return value
    return repr(value)


def _is_sensitive_key(key: str) -> bool:
    normalized = re.sub(r"[^a-z0-9]", "", key.lower())
    if normalized in _SAFE_TOKEN_METRIC_KEYS:
        return False
    return any(part in normalized for part in _SENSITIVE_KEY_PARTS)
