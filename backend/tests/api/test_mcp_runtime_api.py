from __future__ import annotations

import asyncio
from typing import Any

import pytest
from fastapi.testclient import TestClient

from backend.app.core.config import AppSettings
from backend.app.main import create_app
from backend.app.mcp.client import (
    McpCancellationToken,
    McpClientBase,
    McpClientCapabilities,
    McpClientInitializeResult,
    McpClientToolResult,
    McpClientToolSpec,
)
from backend.app.mcp.errors import McpRuntimeError
from backend.app.mcp.runtime import (
    McpLiveExecutionGuard,
    McpRuntimeSnapshotBuilder,
    McpRuntimeSnapshotContext,
)
from backend.app.mcp.types import McpErrorCode, McpServerStatus
from backend.app.storage import McpServerRecord, StorageRepositories


def test_runtime_status_returns_snapshot_servers_and_effective_tools(tmp_path) -> None:
    client = TestClient(create_app(AppSettings(data_dir=tmp_path / "data")))
    repositories = client.app.state.repositories
    _create_session(repositories, "sess-runtime")
    online_server = _create_http_server(client, "Online MCP")
    offline_server = _create_http_server(client, "Offline MCP")
    online_tool = _seed_tool(repositories, online_server, "read_file", read_only=True)
    offline_tool = _seed_tool(repositories, offline_server, "search_docs")
    repositories.mcp_server_status.upsert(online_server, status="online")
    repositories.mcp_server_status.upsert(offline_server, status="offline")
    snapshot = McpRuntimeSnapshotBuilder(repositories, deferred_threshold=20).build_snapshot(
        McpRuntimeSnapshotContext(session_id="sess-runtime")
    )
    repositories.command_approvals.create(
        approval_id="approval-mcp",
        session_id="sess-runtime",
        command="mcp tool approval",
        cwd="",
        title="MCP tool approval",
        tool_name=online_tool.model_name,
        kind="mcp_tool_call",
    )
    repositories.command_approvals.create(
        approval_id="approval-exec",
        session_id="sess-runtime",
        command="echo ok",
        cwd="",
        title="Command approval",
        kind="exec",
    )

    response = client.get("/api/mcp/runtime/status", params={"session_id": "sess-runtime"})

    assert response.status_code == 200
    body = response.json()
    assert body["snapshot"]["id"] == snapshot.id
    assert body["snapshot"]["visible_tools"] == [
        {
            "server_id": online_server,
            "server_name": "Online MCP",
            "raw_name": "read_file",
            "model_name": online_tool.model_name,
            "description": online_tool.description,
            "exposure": "direct",
        }
    ]
    assert body["summary"]["servers_total"] == 2
    assert body["summary"]["servers_online"] == 1
    assert body["pending_approvals"] == 1
    assert body["summary"]["pending_approvals"] == 1
    by_tool = {item["id"]: item for item in body["tools"]}
    assert by_tool[online_tool.id]["effective_state"] == "enabled"
    assert by_tool[offline_tool.id]["effective_state"] == "server_offline"
    assert by_tool[offline_tool.id]["server_status"] == "offline"


def test_session_override_disable_and_clear_does_not_mutate_global_policy(tmp_path) -> None:
    client = TestClient(create_app(AppSettings(data_dir=tmp_path / "data")))
    repositories = client.app.state.repositories
    server_id = _create_http_server(client, "Override MCP")
    tool = _seed_tool(repositories, server_id, "read_file", read_only=True)
    repositories.mcp_server_status.upsert(server_id, status="online")

    disabled = client.put(
        f"/api/mcp/runtime/sessions/sess-override/tools/{tool.id}/override",
        json={"server_id": server_id, "enabled": False, "reason": "user_disabled"},
    )
    status_after_disable = client.get(
        "/api/mcp/runtime/status",
        params={"session_id": "sess-override"},
    )

    assert disabled.status_code == 200
    assert disabled.json()["override"]["enabled"] is False
    assert disabled.json()["tool"]["effective_state"] == "disabled_for_session"
    assert disabled.json()["applies_to_current_run"] is True
    assert disabled.json()["apply_timing"]["scope"] == "current_run"
    assert repositories.mcp_tool_policies.get(server_id, tool.raw_name) is None
    with pytest.raises(McpRuntimeError) as guard_error:
        McpLiveExecutionGuard(repositories).assert_allowed(
            session_id="sess-override",
            server_id=server_id,
            raw_tool_name=tool.raw_name,
        )
    assert guard_error.value.code == McpErrorCode.TOOL_DISABLED_BY_SESSION
    assert status_after_disable.status_code == 200
    assert status_after_disable.json()["overrides"][0]["enabled"] is False
    assert status_after_disable.json()["tools"][0]["effective_state"] == "disabled_for_session"
    cleared = client.delete(
        f"/api/mcp/runtime/sessions/sess-override/tools/{tool.id}/override",
        params={"server_id": server_id},
    )
    assert cleared.status_code == 200
    assert cleared.json()["deleted"] is True
    assert cleared.json()["tool"]["effective_state"] == "enabled"
    allowed = McpLiveExecutionGuard(repositories).assert_allowed(
        session_id="sess-override",
        server_id=server_id,
        raw_tool_name=tool.raw_name,
    )
    assert allowed.model_name == tool.model_name


def _create_session(repositories: StorageRepositories, session_id: str) -> None:
    repositories.sessions.create(
        session_id=session_id,
        user_id="local-user",
        scene_id="desktop-agent",
        title="MCP Runtime",
    )


def test_running_enable_override_reports_next_turn_and_cancel_call(tmp_path) -> None:
    app = create_app(AppSettings(data_dir=tmp_path / "data"))
    factory = CancelClientFactory()
    app.state.mcp_manager.client_factory = factory
    client = TestClient(app)
    repositories = app.state.repositories
    server_id = _create_http_server(client, "Running MCP")
    tool = _seed_tool(repositories, server_id, "read_file", read_only=True)
    repositories.mcp_server_status.upsert(server_id, status="online")
    asyncio.run(app.state.mcp_manager.get_or_create_client(server_id))
    app.state.mcp_manager._register_running_call(
        call_id="call-running",
        session_id="sess-running",
        snapshot_id="snap-running",
        server_id=server_id,
        server_name="Running MCP",
        raw_tool_name=tool.raw_name,
        model_name=tool.model_name,
        approval_mode="auto",
    )

    enabled = client.put(
        f"/api/mcp/runtime/sessions/sess-running/tools/{tool.id}/override",
        json={"server_id": server_id, "enabled": True},
    )
    status = client.get("/api/mcp/runtime/status", params={"session_id": "sess-running"})
    cancelled = client.post("/api/mcp/runtime/calls/call-running/cancel")

    assert enabled.status_code == 200
    assert enabled.json()["apply_timing"]["scope"] == "next_turn"
    assert enabled.json()["applies_to_current_run"] is False
    assert status.status_code == 200
    assert status.json()["running_calls"][0]["call_id"] == "call-running"
    assert cancelled.status_code == 200
    assert cancelled.json()["cancelled"] is True
    assert factory.client is not None
    assert factory.client.cancelled_call_ids == ["call-running"]


def _create_http_server(client: TestClient, name: str) -> str:
    response = client.post(
        "/api/mcp/servers",
        json={
            "name": name,
            "transport": "streamable_http",
            "url": "https://mcp.example.test/mcp",
        },
    )
    assert response.status_code == 200
    return response.json()["id"]


def _seed_tool(
    repositories: StorageRepositories,
    server_id: str,
    raw_name: str,
    *,
    read_only: bool = False,
) -> Any:
    return repositories.mcp_tools.upsert_many(
        server_id,
        [
            {
                "raw_name": raw_name,
                "model_name": f"mcp__{server_id}__{raw_name}",
                "callable_namespace": f"mcp__{server_id}",
                "callable_name": raw_name,
                "display_name": raw_name,
                "description": raw_name,
                "input_schema": {"type": "object"},
                "schema_hash": f"hash-{raw_name}",
                "annotations": {"readOnlyHint": True} if read_only else {},
            }
        ],
    )[0]


class CancelClientFactory:
    def __init__(self) -> None:
        self.client: CancelFakeMcpClient | None = None

    def create_client(self, server: McpServerRecord) -> CancelFakeMcpClient:
        self.client = CancelFakeMcpClient(server.id)
        return self.client


class CancelFakeMcpClient(McpClientBase):
    def __init__(self, server_id: str) -> None:
        super().__init__(server_id=server_id, initial_status=McpServerStatus.ONLINE)
        self.cancelled_call_ids: list[str] = []

    async def initialize(
        self,
        *,
        timeout_sec: float | None = None,
        cancellation: McpCancellationToken | None = None,
    ) -> McpClientInitializeResult:
        return McpClientInitializeResult(
            protocol_version="2026-03-26",
            server_info={"name": "fake"},
            capabilities=McpClientCapabilities(),
        )

    async def list_tools(
        self,
        *,
        timeout_sec: float | None = None,
        cancellation: McpCancellationToken | None = None,
    ) -> list[McpClientToolSpec]:
        return []

    async def call_tool(
        self,
        raw_tool_name: str,
        arguments: dict[str, Any] | None = None,
        *,
        call_id: str | None = None,
        timeout_sec: float | None = None,
        cancellation: McpCancellationToken | None = None,
    ) -> McpClientToolResult:
        return McpClientToolResult(
            call_id=call_id or "call",
            status="success",
            content=[],
        )

    async def cancel_call(self, call_id: str) -> bool:
        self.cancelled_call_ids.append(call_id)
        return True

    async def shutdown(self, *, timeout_sec: float | None = None) -> None:
        self.transition_status(McpServerStatus.OFFLINE, reason="shutdown")
