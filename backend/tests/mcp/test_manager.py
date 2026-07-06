from __future__ import annotations

from typing import Any

import pytest

from backend.app.core.config import AppSettings
from backend.app.mcp.client import (
    McpCancellationToken,
    McpClientBase,
    McpClientCapabilities,
    McpClientInitializeResult,
    McpClientPromptResult,
    McpClientPromptSpec,
    McpClientToolResult,
    McpClientToolSpec,
)
from backend.app.mcp.errors import McpRuntimeError
from backend.app.mcp.manager import McpManager
from backend.app.mcp.types import McpErrorCode, McpServerStatus
from backend.app.storage import McpServerRecord, StorageRepositories, init_database


def _repositories(tmp_path) -> StorageRepositories:
    return StorageRepositories(init_database(tmp_path / "app.db"))


def _create_server(
    repositories: StorageRepositories,
    *,
    server_id: str = "srv_manager",
    connect_mode: str = "on_demand",
    enabled: bool = True,
    auto_refresh: bool = True,
    refresh_interval_sec: int = 1800,
) -> None:
    repositories.mcp_servers.create(
        server_id=server_id,
        name=f"Manager MCP {server_id}",
        transport="streamable_http",
        url="https://mcp.example.test/mcp",
        connect_mode=connect_mode,
        enabled=enabled,
        auto_refresh=auto_refresh,
        refresh_interval_sec=refresh_interval_sec,
    )


@pytest.mark.asyncio
async def test_manager_disabled_reports_disabled_and_does_not_create_clients(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories, connect_mode="on_startup")
    factory = RecordingClientFactory()
    manager = McpManager(
        settings=AppSettings(data_dir=tmp_path / "data", mcp_enabled=False),
        repositories=repositories,
        client_factory=factory,
    )

    await manager.start()

    assert manager.status().to_dict() == {
        "enabled": False,
        "runtime_status": "disabled",
        "started": True,
        "active_client_count": 0,
    }
    assert factory.created == []
    with pytest.raises(McpRuntimeError) as exc_info:
        await manager.get_or_create_client("srv_manager")
    assert exc_info.value.code == McpErrorCode.MCP_DISABLED


@pytest.mark.asyncio
async def test_manager_get_or_connect_creates_client_once_and_writes_online_status(
    tmp_path,
) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories)
    factory = RecordingClientFactory()
    manager = McpManager(
        settings=AppSettings(data_dir=tmp_path / "data"),
        repositories=repositories,
        client_factory=factory,
    )

    client = await manager.get_or_connect_client("srv_manager")
    cached = await manager.get_or_create_client("srv_manager")
    status = repositories.mcp_server_status.get("srv_manager")

    assert cached is client
    assert factory.created == ["srv_manager"]
    assert status.status == "online"
    assert status.capabilities["tools"] is True
    assert status.server_info == {"name": "fake-srv_manager"}
    assert status.last_connected_at is not None
    assert status.last_refresh_at is not None


@pytest.mark.asyncio
async def test_manager_disabled_server_marks_disabled_without_creating_client(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories, enabled=False)
    factory = RecordingClientFactory()
    manager = McpManager(
        settings=AppSettings(data_dir=tmp_path / "data"),
        repositories=repositories,
        client_factory=factory,
    )

    with pytest.raises(McpRuntimeError) as exc_info:
        await manager.get_or_create_client("srv_manager")

    assert exc_info.value.code == McpErrorCode.SERVER_DISABLED
    assert factory.created == []
    assert manager.active_client_count == 0
    assert repositories.mcp_server_status.get("srv_manager").status == "disabled"


@pytest.mark.asyncio
async def test_manager_shutdown_closes_active_clients_and_marks_offline(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories)
    factory = RecordingClientFactory()
    manager = McpManager(
        settings=AppSettings(data_dir=tmp_path / "data"),
        repositories=repositories,
        client_factory=factory,
    )
    client = await manager.get_or_create_client("srv_manager")

    await manager.shutdown()

    assert client.shutdown_calls == 1
    assert manager.active_client_count == 0
    assert repositories.mcp_server_status.get("srv_manager").status == "offline"


@pytest.mark.asyncio
async def test_manager_recreates_client_when_server_config_changes(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories)
    factory = RecordingClientFactory()
    manager = McpManager(
        settings=AppSettings(data_dir=tmp_path / "data"),
        repositories=repositories,
        client_factory=factory,
    )
    first = await manager.get_or_create_client("srv_manager")

    repositories.mcp_servers.update("srv_manager", description="new config")
    second = await manager.get_or_create_client("srv_manager")

    assert second is not first
    assert first.shutdown_calls == 1
    assert factory.created == ["srv_manager", "srv_manager"]


@pytest.mark.asyncio
async def test_manager_auto_refresh_tasks_start_update_and_cancel(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories, server_id="srv_auto", auto_refresh=True, refresh_interval_sec=30)
    _create_server(repositories, server_id="srv_manual", auto_refresh=False)
    manager = McpManager(
        settings=AppSettings(data_dir=tmp_path / "data"),
        repositories=repositories,
        client_factory=RecordingClientFactory(),
    )

    await manager.sync_auto_refresh_tasks()

    assert manager.scheduled_refresh_server_ids() == ["srv_auto"]
    assert manager.scheduled_refresh_intervals() == {"srv_auto": 30}

    repositories.mcp_servers.update("srv_auto", refresh_interval_sec=60)
    await manager.sync_auto_refresh_tasks()

    assert manager.scheduled_refresh_intervals() == {"srv_auto": 60}

    repositories.mcp_servers.update("srv_auto", auto_refresh=False)
    await manager.sync_auto_refresh_tasks()

    assert manager.scheduled_refresh_server_ids() == []
    assert manager.auto_refresh_task_count == 0


@pytest.mark.asyncio
async def test_manager_start_records_non_required_startup_failure_without_raising(
    tmp_path,
) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories, connect_mode="on_startup")
    manager = McpManager(
        settings=AppSettings(data_dir=tmp_path / "data"),
        repositories=repositories,
        client_factory=RecordingClientFactory(fail_initialize=True),
    )

    await manager.start()

    status = repositories.mcp_server_status.get("srv_manager")
    assert manager.started is True
    assert manager.active_client_count == 0
    assert status.status == "offline"
    assert status.last_error_code == "server_offline"


@pytest.mark.asyncio
async def test_manager_cancel_running_call_delegates_to_cached_client_and_audits(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories)
    factory = RecordingClientFactory()
    manager = McpManager(
        settings=AppSettings(data_dir=tmp_path / "data"),
        repositories=repositories,
        client_factory=factory,
    )
    client = await manager.get_or_create_client("srv_manager")
    manager._register_running_call(
        call_id="call-running",
        session_id="session-a",
        snapshot_id="snapshot-a",
        server_id="srv_manager",
        server_name="Manager MCP srv_manager",
        raw_tool_name="read_fixture",
        model_name="mcp__srv_manager__read_fixture",
        risk_level="low",
        approval_mode="auto",
    )

    result = await manager.cancel_call("call-running")
    missing = await manager.cancel_call("call-missing")
    audits, total = repositories.mcp_audit_log.list(event_type="tool.cancelled")

    assert result["cancelled"] is True
    assert result["server_id"] == "srv_manager"
    assert missing == {"call_id": "call-missing", "cancelled": False, "reason": "call_not_running"}
    assert client.cancelled_calls == ["call-running"]
    assert total == 1
    assert audits[0].call_id == "call-running"
    assert audits[0].status == "cancelled"


class RecordingClientFactory:
    def __init__(self, *, fail_initialize: bool = False) -> None:
        self.fail_initialize = fail_initialize
        self.created: list[str] = []
        self.clients: list[FakeManagerClient] = []

    def create_client(self, server: McpServerRecord):
        self.created.append(server.id)
        client = FakeManagerClient(server.id, fail_initialize=self.fail_initialize)
        self.clients.append(client)
        return client


class FakeManagerClient(McpClientBase):
    def __init__(self, server_id: str, *, fail_initialize: bool = False) -> None:
        super().__init__(server_id=server_id)
        self.fail_initialize = fail_initialize
        self.shutdown_calls = 0
        self.cancelled_calls: list[str] = []

    async def initialize(
        self,
        *,
        timeout_sec: float | None = None,
        cancellation: McpCancellationToken | None = None,
    ) -> McpClientInitializeResult:
        if self.fail_initialize:
            self.transition_status(McpServerStatus.OFFLINE, reason="test_failure")
            raise McpRuntimeError(McpErrorCode.SERVER_OFFLINE, "offline")
        self.transition_status(McpServerStatus.ONLINE, reason="test_initialized")
        return McpClientInitializeResult(
            protocol_version="2026-03-26",
            server_info={"name": f"fake-{self.server_id}"},
            capabilities=McpClientCapabilities(),
        )

    async def list_tools(
        self,
        *,
        timeout_sec: float | None = None,
        cancellation: McpCancellationToken | None = None,
    ) -> list[McpClientToolSpec]:
        return []

    async def list_prompts(
        self,
        *,
        timeout_sec: float | None = None,
        cancellation: McpCancellationToken | None = None,
    ) -> list[McpClientPromptSpec]:
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
        raise NotImplementedError

    async def get_prompt(
        self,
        raw_prompt_name: str,
        arguments: dict[str, Any] | None = None,
        *,
        timeout_sec: float | None = None,
        cancellation: McpCancellationToken | None = None,
    ) -> McpClientPromptResult:
        raise NotImplementedError

    async def cancel_call(self, call_id: str) -> bool:
        self.cancelled_calls.append(call_id)
        return True

    async def shutdown(self, *, timeout_sec: float | None = None) -> None:
        self.shutdown_calls += 1
        self.transition_status(McpServerStatus.OFFLINE, reason="test_shutdown")
