from __future__ import annotations

import asyncio
from typing import Any

import pytest

from backend.app.mcp.elicitation import McpElicitationError, McpElicitationService
from backend.app.storage import StorageRepositories, init_database


def _repositories(tmp_path) -> StorageRepositories:
    return StorageRepositories(init_database(tmp_path / "app.db"))


def _create_server(repositories: StorageRepositories) -> None:
    repositories.mcp_servers.create(
        server_id="srv_elicit",
        name="Elicit MCP",
        transport="streamable_http",
        url="https://mcp.example.test/mcp",
    )


@pytest.mark.asyncio
async def test_elicitation_request_payload_submit_and_audit(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories)
    events: list[tuple[str, str, dict[str, Any]]] = []

    async def broadcaster(session_id: str, action: str, data: dict[str, Any]) -> bool:
        events.append((session_id, action, data))
        return True

    service = McpElicitationService(repositories, broadcaster=broadcaster)
    task = asyncio.create_task(
        service.request(
            session_id="sess-elicit",
            server_id="srv_elicit",
            raw_tool_name="create_issue",
            title="Create issue",
            schema={"type": "object", "properties": {"title": {"type": "string"}}},
            timeout_sec=1,
            elicitation_id="elicitation-submit",
        )
    )
    await asyncio.sleep(0)

    assert events[0][1] == "mcp_elicitation_requested"
    assert events[0][2]["elicitation"]["server_name"] == "Elicit MCP"
    assert events[0][2]["elicitation"]["raw_tool_name"] == "create_issue"
    pending_payload = service.pending_payload("elicitation-submit")
    assert pending_payload["title"] == "Create issue"
    assert pending_payload["schema"]["properties"]["title"]["type"] == "string"
    resolved = await service.resolve(
        "elicitation-submit",
        values={"title": "Bug"},
        user_id="user-1",
    )
    result = await task

    assert resolved.status == "submitted"
    assert result.values == {"title": "Bug"}
    assert events[-1][1] == "mcp_elicitation_resolved"
    assert events[-1][2]["elicitation"]["status"] == "submitted"
    with pytest.raises(McpElicitationError):
        service.pending_payload("elicitation-submit")
    requested, requested_total = repositories.mcp_audit_log.list(
        event_type="elicitation.requested"
    )
    resolved_audits, resolved_total = repositories.mcp_audit_log.list(
        event_type="elicitation.resolved"
    )
    assert requested_total == 1
    assert requested[0].detail["elicitation_id"] == "elicitation-submit"
    assert resolved_total == 1
    assert resolved_audits[0].detail["value_keys"] == ["title"]


@pytest.mark.asyncio
async def test_elicitation_cancel_returns_cancelled_result(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories)
    service = McpElicitationService(repositories)
    task = asyncio.create_task(
        service.request(
            session_id="sess-elicit",
            server_id="srv_elicit",
            raw_tool_name="write_file",
            title="Confirm write",
            schema={"type": "object"},
            timeout_sec=1,
            elicitation_id="elicitation-cancel",
        )
    )
    await asyncio.sleep(0)

    await service.resolve("elicitation-cancel", cancelled=True)
    result = await task

    assert result.status == "cancelled"
    assert result.values is None
    with pytest.raises(McpElicitationError):
        await service.resolve("elicitation-cancel", cancelled=True)


@pytest.mark.asyncio
async def test_elicitation_resolved_broadcast_redacts_sensitive_values(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories)
    events: list[tuple[str, str, dict[str, Any]]] = []

    async def broadcaster(session_id: str, action: str, data: dict[str, Any]) -> bool:
        events.append((session_id, action, data))
        return True

    service = McpElicitationService(repositories, broadcaster=broadcaster)
    task = asyncio.create_task(
        service.request(
            session_id="sess-elicit",
            server_id="srv_elicit",
            raw_tool_name="create_issue",
            title="Create issue",
            schema={"type": "object", "properties": {"api_token": {"type": "string"}}},
            timeout_sec=1,
            elicitation_id="elicitation-secret",
        )
    )
    await asyncio.sleep(0)

    await service.resolve(
        "elicitation-secret",
        values={"api_token": "secret-token", "title": "Bug"},
        user_id="user-1",
    )
    result = await task

    resolved_event = events[-1][2]["elicitation"]
    audits, total = repositories.mcp_audit_log.list(event_type="elicitation.resolved")
    assert result.values == {"api_token": "secret-token", "title": "Bug"}
    assert resolved_event["values"]["api_token"] == "***REDACTED***"
    assert "secret-token" not in str(resolved_event)
    assert total == 1
    assert audits[0].detail["value_keys"] == ["api_token", "title"]


@pytest.mark.asyncio
async def test_elicitation_timeout_cancels_pending_and_writes_audit(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories)
    service = McpElicitationService(repositories)

    result = await service.request(
        session_id="sess-elicit",
        server_id="srv_elicit",
        raw_tool_name="write_file",
        title="Confirm write",
        schema={"type": "object"},
        timeout_sec=0.01,
        elicitation_id="elicitation-timeout",
    )

    assert result.status == "timeout"
    timeout_audits, timeout_total = repositories.mcp_audit_log.list(
        event_type="elicitation.timeout"
    )
    assert timeout_total == 1
    assert timeout_audits[0].detail["elicitation_id"] == "elicitation-timeout"
