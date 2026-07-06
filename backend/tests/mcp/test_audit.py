from __future__ import annotations

import json
from typing import Any

import pytest

from backend.app.mcp.audit import (
    REDACTED_VALUE,
    McpAuditWriteError,
    McpAuditWriter,
    redact_sensitive_data,
)
from backend.app.storage import StorageRepositories, init_database
from backend.app.storage.repositories import McpAuditLogRecord


def _repositories(tmp_path) -> StorageRepositories:
    return StorageRepositories(init_database(tmp_path / "app.db"))


def test_redact_sensitive_data_recurses_nested_json() -> None:
    payload = {
        "headers": {
            "Authorization": "Bearer raw-header-token",
            "X-Api-Key": "raw-api-key",
        },
        "tool_args": [
            {"query": "safe"},
            {
                "password": "raw-password",
                "nested": {"client_secret": "raw-client-secret"},
            },
        ],
        "message": "access_token=raw-access-token and secret:raw-secret",
        "auth_error": "Authorization=Bearer raw-inline-token",
    }

    redacted = redact_sensitive_data(payload)
    serialized = json.dumps(redacted, ensure_ascii=False)

    assert redacted["headers"]["Authorization"] == REDACTED_VALUE
    assert redacted["headers"]["X-Api-Key"] == REDACTED_VALUE
    assert redacted["tool_args"][1]["password"] == REDACTED_VALUE
    assert redacted["tool_args"][1]["nested"]["client_secret"] == REDACTED_VALUE
    assert "raw-header-token" not in serialized
    assert "raw-api-key" not in serialized
    assert "raw-password" not in serialized
    assert "raw-client-secret" not in serialized
    assert "raw-access-token" not in serialized
    assert "raw-secret" not in serialized
    assert "raw-inline-token" not in serialized


def test_redact_sensitive_data_keeps_token_usage_metrics() -> None:
    redacted = redact_sensitive_data(
        {
            "usage": {
                "total_tokens": 42,
                "prompt_tokens": 10,
                "completion_tokens": 32,
                "max_tokens": 128,
            },
            "credentials": {
                "access_token": "raw-access-token",
                "api_token": "raw-api-token",
            },
        }
    )

    assert redacted["usage"] == {
        "total_tokens": 42,
        "prompt_tokens": 10,
        "completion_tokens": 32,
        "max_tokens": 128,
    }
    assert redacted["credentials"]["access_token"] == REDACTED_VALUE
    assert redacted["credentials"]["api_token"] == REDACTED_VALUE


def test_mcp_audit_writer_appends_sanitized_record_and_lists_it(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    writer = McpAuditWriter.from_repositories(repositories)

    record = writer.append_event(
        audit_id="audit-tool-1",
        event_type="tool.called",
        server_id="srv_1",
        raw_tool_name="create_issue",
        session_id="ses_1",
        turn_id="turn_1",
        call_id="call_1",
        approval_id="approval_1",
        actor="user",
        status="success",
        duration_ms=25,
        summary="tool completed with api_key=raw-summary-key",
        detail={
            "arguments": {
                "title": "Bug",
                "api_key": "raw-argument-key",
            },
            "result": {
                "text": "ok",
                "authorization": "Bearer raw-result-token",
            },
        },
    )
    listed = writer.list_events(event_type="tool.called")
    serialized = json.dumps(record.detail, ensure_ascii=False)

    assert record is not None
    assert record.summary == f"tool completed with api_key={REDACTED_VALUE}"
    assert record.detail["arguments"]["api_key"] == REDACTED_VALUE
    assert record.detail["result"]["authorization"] == REDACTED_VALUE
    assert listed.total == 1
    assert listed.records == [record]
    assert "raw-summary-key" not in record.summary
    assert "raw-argument-key" not in serialized
    assert "raw-result-token" not in serialized


def test_mcp_audit_writer_lists_by_status(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    writer = McpAuditWriter.from_repositories(repositories)

    ok = writer.append_event(
        audit_id="audit-ok",
        event_type="server.updated",
        server_id="srv_1",
        status="ok",
    )
    failed = writer.append_event(
        audit_id="audit-error",
        event_type="tool.failed",
        server_id="srv_1",
        status="error",
    )

    listed = writer.list_events(server_id="srv_1", status="error")

    assert ok is not None
    assert failed is not None
    assert listed.total == 1
    assert listed.records == [failed]


def test_mcp_audit_writer_failure_does_not_replace_primary_error() -> None:
    writer = McpAuditWriter(FailingAuditRepository())
    primary_error = RuntimeError("primary tool failure")

    with pytest.raises(RuntimeError) as exc_info:
        try:
            raise primary_error
        except RuntimeError:
            writer.append_event(
                event_type="tool.failed",
                server_id="srv_1",
                raw_tool_name="create_issue",
                status="error",
                detail={"token": "raw-token"},
            )
            raise

    assert exc_info.value is primary_error


def test_mcp_audit_writer_failure_error_message_is_sanitized() -> None:
    repository = FailingAuditRepository()
    writer = McpAuditWriter(repository)

    with pytest.raises(McpAuditWriteError) as exc_info:
        writer.append_event(
            event_type="tool.failed",
            server_id="srv_1",
            detail={"token": "raw-token"},
            raise_on_failure=True,
        )

    assert str(exc_info.value) == "Failed to write MCP audit log."
    assert "raw-token" not in str(exc_info.value)
    assert repository.append_calls[0]["detail"] == {"token": REDACTED_VALUE}


class FailingAuditRepository:
    def __init__(self) -> None:
        self.append_calls: list[dict[str, Any]] = []

    def append(self, **kwargs: Any) -> McpAuditLogRecord:
        self.append_calls.append(kwargs)
        raise RuntimeError(f"database failed: {kwargs['detail']}")

    def list(
        self,
        *,
        server_id: str | None = None,
        session_id: str | None = None,
        event_type: str | None = None,
        status: str | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> tuple[list[McpAuditLogRecord], int]:
        return [], 0
