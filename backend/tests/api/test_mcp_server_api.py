from __future__ import annotations

from typing import Any

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
from backend.app.mcp.types import McpErrorCode, McpServerStatus
from backend.app.storage import McpServerRecord


def test_mcp_server_crud_toggle_and_delete_cascade(tmp_path) -> None:
    client = TestClient(create_app(AppSettings(data_dir=tmp_path / "data")))

    created = client.post(
        "/api/mcp/servers",
        json={
            "name": "Local Files",
            "transport": "stdio",
            "command": "mcp-files",
            "args": ["--stdio"],
            "default_tool_approval_mode": "auto",
        },
    )
    server_id = created.json()["id"]
    listed = client.get("/api/mcp/servers")
    detail = client.get(f"/api/mcp/servers/{server_id}")
    patched = client.patch(
        f"/api/mcp/servers/{server_id}",
        json={"name": "Local Files Renamed", "tool_timeout_sec": 77},
    )
    toggled = client.post(f"/api/mcp/servers/{server_id}/toggle", json={"enabled": False})

    repositories = client.app.state.repositories
    repositories.mcp_tools.upsert_many(
        server_id,
        [
            {
                "raw_name": "read_file",
                "model_name": f"mcp__{server_id}__read_file",
                "callable_namespace": f"mcp__{server_id}",
                "callable_name": "read_file",
                "description": "Read file",
                "input_schema": {"type": "object"},
                "schema_hash": "hash-read",
            }
        ],
    )
    deleted = client.delete(f"/api/mcp/servers/{server_id}")

    assert created.status_code == 200
    assert listed.status_code == 200
    assert listed.json()["total"] == 1
    assert listed.json()["list"][0]["auth_type"] == "none"
    assert detail.status_code == 200
    assert detail.json()["status"] == "unknown"
    assert detail.json()["tools_count"] == 0
    assert detail.json()["last_error_message"] is None
    assert detail.json()["args"] == ["--stdio"]
    assert "env" not in detail.json()
    assert patched.status_code == 200
    assert patched.json()["name"] == "Local Files Renamed"
    assert patched.json()["tool_timeout_sec"] == 77
    assert toggled.status_code == 200
    assert toggled.json()["enabled"] is False
    assert toggled.json()["status"] == "disabled"
    assert deleted.status_code == 200
    assert deleted.json() == {"deleted": True, "server_id": server_id}
    assert repositories.mcp_tools.get_by_raw_name(server_id, "read_file") is None


def test_delete_server_drops_cached_client_before_deleting_record(tmp_path) -> None:
    app = create_app(AppSettings(data_dir=tmp_path / "data"))
    app.state.mcp_manager.client_factory = FakeClientFactory(shutdown_fail_names={"Shutdown Fail"})
    client = TestClient(app)
    server_id = _create_http_server(client, "Shutdown Fail")

    refreshed = client.post(f"/api/mcp/servers/{server_id}/refresh")
    deleted = client.delete(f"/api/mcp/servers/{server_id}")

    assert refreshed.status_code == 200
    assert refreshed.json()["ok"] is True
    assert deleted.status_code == 200
    assert deleted.json() == {"deleted": True, "server_id": server_id}
    assert app.state.repositories.mcp_servers.get(server_id) is None
    assert app.state.repositories.mcp_tools.get_by_raw_name(server_id, "search") is None


def test_update_server_drop_client_shutdown_error_does_not_poison_status(tmp_path) -> None:
    app = create_app(AppSettings(data_dir=tmp_path / "data"))
    app.state.mcp_manager.client_factory = FakeClientFactory(shutdown_fail_names={"Shutdown Fail"})
    client = TestClient(app)
    server_id = _create_http_server(client, "Shutdown Fail")

    refreshed = client.post(f"/api/mcp/servers/{server_id}/refresh")
    patched = client.patch(f"/api/mcp/servers/{server_id}", json={"enabled": False})

    status = app.state.repositories.mcp_server_status.get(server_id)
    assert refreshed.status_code == 200
    assert refreshed.json()["status"] == "online"
    assert patched.status_code == 200
    assert patched.json()["enabled"] is False
    assert status is not None
    assert status.status == "online"
    assert status.last_error_code is None


def test_mcp_server_detail_returns_secret_references_without_raw_values(tmp_path) -> None:
    client = TestClient(create_app(AppSettings(data_dir=tmp_path / "data")))

    created = client.post(
        "/api/mcp/servers",
        json={
            "name": "Secure MCP",
            "transport": "streamable_http",
            "url": "https://mcp.example.test/mcp",
            "env": {"MCP_TOKEN": "raw-env-token"},
            "headers": {"X-Api-Key": "raw-header-token"},
            "env_headers": {"X-Env-Token": "MCP_TOKEN"},
            "bearer_token_env_var": "MCP_BEARER_TOKEN",
            "secret_refs": {"api_key": "secret:configured"},
        },
    )
    server_id = created.json()["id"]
    detail = client.get(f"/api/mcp/servers/{server_id}")

    assert created.status_code == 200
    assert detail.status_code == 200
    body = detail.json()
    body_text = str(body)
    assert body["env_keys"] == ["MCP_TOKEN"]
    assert body["header_keys"] == ["X-Api-Key"]
    assert body["env_header_keys"] == ["X-Env-Token"]
    assert body["bearer_token_env_var"] == "MCP_BEARER_TOKEN"
    assert body["secret_ref_keys"] == ["api_key"]
    assert "env" not in body
    assert "headers" not in body
    assert "env_headers" not in body
    assert "secret_refs" not in body
    assert "raw-env-token" not in body_text
    assert "raw-header-token" not in body_text
    assert "secret:configured" not in body_text


def test_mcp_server_test_connection_success_and_failure(tmp_path) -> None:
    app = create_app(AppSettings(data_dir=tmp_path / "data"))
    app.state.mcp_manager.client_factory = FakeClientFactory(fail_names={"Fail MCP"})
    client = TestClient(app)
    ok_id = _create_http_server(client, "OK MCP")
    fail_id = _create_http_server(client, "Fail MCP")

    ok = client.post(f"/api/mcp/servers/{ok_id}/test")
    failed = client.post(f"/api/mcp/servers/{fail_id}/test")

    assert ok.status_code == 200
    assert ok.json()["ok"] is True
    assert ok.json()["status"] == "online"
    assert ok.json()["capabilities"]["tools"] is True
    ok_status = app.state.repositories.mcp_server_status.get(ok_id)
    assert ok_status is not None
    assert ok_status.status == "online"
    assert ok_status.last_connected_at is not None
    assert failed.status_code == 200
    assert failed.json()["ok"] is False
    assert failed.json()["status"] == "offline"
    assert failed.json()["error"]["code"] == "timeout"
    failed_status = app.state.repositories.mcp_server_status.get(fail_id)
    assert failed_status is not None
    assert failed_status.status == "offline"
    assert failed_status.last_error_code == "timeout"
    assert app.state.repositories.mcp_tools.list_by_server(ok_id) == []


def test_mcp_server_config_test_is_temporary_and_discovers_tools(tmp_path) -> None:
    app = create_app(AppSettings(data_dir=tmp_path / "data"))
    app.state.mcp_manager.client_factory = FakeClientFactory()
    client = TestClient(app)

    tested = client.post(
        "/api/mcp/servers/test",
        json={
            "server": {
                "name": "Temporary MCP",
                "transport": "streamable_http",
                "url": "https://mcp.example.test/mcp",
            }
        },
    )

    assert tested.status_code == 200
    body = tested.json()
    assert body["ok"] is True
    assert body["server_id"].startswith("temporary-")
    assert body["status"] == "online"
    assert body["tools_count"] == 1
    assert app.state.repositories.mcp_servers.list()[1] == 0
    assert app.state.repositories.mcp_server_status.get(body["server_id"]) is None
    assert app.state.repositories.mcp_tools.list_by_server(body["server_id"]) == []


def test_mcp_server_refresh_single_and_all(tmp_path) -> None:
    app = create_app(AppSettings(data_dir=tmp_path / "data"))
    app.state.mcp_manager.client_factory = FakeClientFactory(fail_names={"Refresh All Fail"})
    client = TestClient(app)
    server_id = _create_http_server(client, "Refresh MCP")
    all_ok_id = _create_http_server(client, "Refresh All OK")
    all_fail_id = _create_http_server(client, "Refresh All Fail")

    refreshed = client.post(f"/api/mcp/servers/{server_id}/refresh")
    refresh_all = client.post("/api/mcp/servers/refresh")

    assert refreshed.status_code == 200
    assert refreshed.json()["ok"] is True
    assert refreshed.json()["tools_count"] == 1
    assert app.state.repositories.mcp_tools.get_by_raw_name(server_id, "search") is not None
    assert refresh_all.status_code == 200
    assert refresh_all.json()["ok"] is False
    by_server = {item["server_id"]: item for item in refresh_all.json()["list"]}
    assert by_server[all_ok_id]["ok"] is True
    assert by_server[all_fail_id]["ok"] is False
    assert by_server[all_fail_id]["error"]["code"] == "timeout"


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


class FakeClientFactory:
    def __init__(
        self,
        *,
        fail_names: set[str] | None = None,
        shutdown_fail_names: set[str] | None = None,
    ) -> None:
        self.fail_names = fail_names or set()
        self.shutdown_fail_names = shutdown_fail_names or set()
        self.created: list[str] = []

    def create_client(self, server: McpServerRecord) -> FakeMcpClient:
        self.created.append(server.id)
        if server.name in self.fail_names:
            return FakeMcpClient(server.id, error=McpRuntimeError(McpErrorCode.TIMEOUT))
        return FakeMcpClient(
            server.id,
            shutdown_error=(
                RuntimeError("shutdown failed")
                if server.name in self.shutdown_fail_names
                else None
            ),
        )


class FakeMcpClient(McpClientBase):
    def __init__(
        self,
        server_id: str,
        *,
        error: BaseException | None = None,
        shutdown_error: BaseException | None = None,
    ) -> None:
        super().__init__(server_id=server_id)
        self.error = error
        self.shutdown_error = shutdown_error

    async def initialize(
        self,
        *,
        timeout_sec: float | None = None,
        cancellation: McpCancellationToken | None = None,
    ) -> McpClientInitializeResult:
        if self.error is not None:
            raise self.error
        self.transition_status(McpServerStatus.ONLINE, reason="test")
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
        return [
            McpClientToolSpec(
                name="search",
                description="Search",
                input_schema={"type": "object"},
                annotations={"readOnlyHint": True},
            )
        ]

    async def call_tool(
        self,
        raw_tool_name: str,
        arguments: dict[str, Any] | None = None,
        *,
        call_id: str | None = None,
        timeout_sec: float | None = None,
        cancellation: McpCancellationToken | None = None,
    ) -> McpClientToolResult:
        raise NotImplementedError

    async def cancel_call(self, call_id: str) -> bool:
        return False

    async def shutdown(self, *, timeout_sec: float | None = None) -> None:
        if self.shutdown_error is not None:
            raise self.shutdown_error
        self.transition_status(McpServerStatus.OFFLINE, reason="shutdown")
