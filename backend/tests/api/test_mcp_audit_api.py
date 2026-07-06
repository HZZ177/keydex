from __future__ import annotations

import json

from fastapi.testclient import TestClient

from backend.app.core.config import AppSettings
from backend.app.main import create_app


def test_audit_api_filters_paginates_sorts_and_redacts_sensitive_payloads(
    tmp_path,
) -> None:
    app = create_app(AppSettings(data_dir=tmp_path / "data"))
    client = TestClient(app)
    server_id = _create_http_server(client)
    repositories = app.state.repositories

    repositories.mcp_audit_log.append(
        audit_id="audit_a",
        event_type="tool.failed",
        server_id=server_id,
        raw_tool_name="write_ticket",
        status="error",
        summary="tool failed token=raw-offset-token",
        detail={"arguments": {"query": "safe", "api_key": "raw-offset-key"}},
    )
    repositories.mcp_audit_log.append(
        audit_id="audit_b",
        event_type="server.updated",
        server_id=server_id,
        status="ok",
        summary="server updated",
        detail={"field": "auto_refresh"},
    )
    repositories.mcp_audit_log.append(
        audit_id="audit_z",
        event_type="tool.failed",
        server_id=server_id,
        raw_tool_name="write_ticket",
        status="error",
        summary="tool failed Authorization=Bearer raw-summary-token",
        detail={
            "headers": {"Authorization": "Bearer raw-header-token"},
            "arguments": {"api_token": "raw-argument-token"},
            "error": "access_token=raw-error-token",
        },
    )

    first_page = client.get(
        "/api/mcp/audit",
        params={"server_id": server_id, "status": "error", "limit": 1},
    )
    second_page = client.get(
        "/api/mcp/audit",
        params={"server_id": server_id, "status": "error", "limit": 1, "offset": 1},
    )
    ok_events = client.get(
        "/api/mcp/audit",
        params={
            "server_id": server_id,
            "event_type": "server.updated",
            "status": "ok",
        },
    )

    assert first_page.status_code == 200
    assert first_page.json()["total"] == 2
    assert first_page.json()["limit"] == 1
    assert first_page.json()["offset"] == 0
    assert first_page.json()["list"][0]["id"] == "audit_z"
    assert first_page.json()["list"][0]["status"] == "error"
    assert first_page.json()["list"][0]["summary"] == "tool failed Authorization=***REDACTED***"
    assert first_page.json()["list"][0]["detail"]["headers"]["Authorization"] == "***REDACTED***"
    assert first_page.json()["list"][0]["detail"]["arguments"]["api_token"] == "***REDACTED***"
    assert "raw-" not in json.dumps(first_page.json(), ensure_ascii=False)

    assert second_page.status_code == 200
    assert second_page.json()["total"] == 2
    assert second_page.json()["offset"] == 1
    assert second_page.json()["list"][0]["id"] == "audit_a"
    assert "raw-offset" not in json.dumps(second_page.json(), ensure_ascii=False)

    assert ok_events.status_code == 200
    assert ok_events.json()["total"] == 1
    assert ok_events.json()["list"][0]["id"] == "audit_b"


def _create_http_server(client: TestClient) -> str:
    response = client.post(
        "/api/mcp/servers",
        json={
            "name": "Audit MCP",
            "transport": "streamable_http",
            "url": "https://mcp.example.test/mcp",
        },
    )
    assert response.status_code == 200
    return response.json()["id"]
