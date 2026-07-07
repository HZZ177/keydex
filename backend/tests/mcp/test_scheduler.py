from __future__ import annotations

import asyncio
from typing import Any

import pytest

from backend.app.core.config import AppSettings
from backend.app.mcp.client import (
    McpCancellationToken,
    McpClientBase,
    McpClientCapabilities,
    McpClientInitializeResult,
    McpClientToolResult,
    McpClientToolSpec,
)
from backend.app.mcp.discovery import McpRefreshReport
from backend.app.mcp.errors import McpRuntimeError
from backend.app.mcp.manager import McpManager
from backend.app.mcp.types import McpErrorCode, McpServerStatus
from backend.app.storage import McpServerRecord, StorageRepositories, init_database


def _repositories(tmp_path) -> StorageRepositories:
    return StorageRepositories(init_database(tmp_path / "app.db"))


def _create_server(
    repositories: StorageRepositories,
    *,
    server_id: str,
    enabled: bool = True,
    auto_refresh: bool = True,
    refresh_interval_sec: int = 60,
) -> None:
    repositories.mcp_servers.create(
        server_id=server_id,
        name=f"Scheduled MCP {server_id}",
        transport="streamable_http",
        url="https://mcp.example.test/mcp",
        enabled=enabled,
        auto_refresh=auto_refresh,
        refresh_interval_sec=refresh_interval_sec,
    )


@pytest.mark.asyncio
async def test_start_schedules_enabled_auto_refresh_servers_only(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories, server_id="srv_auto")
    _create_server(repositories, server_id="srv_disabled", enabled=False)
    _create_server(repositories, server_id="srv_manual", auto_refresh=False)
    manager = _manager(tmp_path, repositories)

    await manager.start()

    assert manager.scheduled_refresh_server_ids() == ["srv_auto"]
    assert manager.scheduled_refresh_intervals() == {"srv_auto": 60}
    await manager.shutdown()


@pytest.mark.asyncio
async def test_sync_auto_refresh_tasks_updates_interval_and_removes_disabled(
    tmp_path,
) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories, server_id="srv_auto", refresh_interval_sec=5)
    manager = _manager(tmp_path, repositories)
    await manager.start()

    repositories.mcp_servers.update("srv_auto", refresh_interval_sec=9)
    await manager.sync_auto_refresh_tasks()

    assert manager.scheduled_refresh_intervals() == {"srv_auto": 9}

    repositories.mcp_servers.update("srv_auto", auto_refresh=False)
    await manager.sync_auto_refresh_tasks()

    assert manager.scheduled_refresh_server_ids() == []
    await manager.shutdown()


@pytest.mark.asyncio
async def test_trigger_auto_refresh_runs_scheduled_refresh_path(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories, server_id="srv_auto")
    discovery = RecordingDiscoveryService()
    manager = _manager(tmp_path, repositories)
    manager.discovery_service = discovery

    report = await manager.trigger_auto_refresh("srv_auto")

    assert report is not None
    assert report.server_id == "srv_auto"
    assert discovery.calls == ["srv_auto"]


@pytest.mark.asyncio
async def test_auto_refresh_skips_when_same_server_refresh_is_running(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories, server_id="srv_auto")
    discovery = BlockingDiscoveryService()
    manager = _manager(tmp_path, repositories)
    manager.discovery_service = discovery

    manual_task = asyncio.create_task(manager.refresh_capabilities("srv_auto"))
    await discovery.started.wait()
    skipped = await manager.trigger_auto_refresh("srv_auto")
    discovery.release.set()
    report = await manual_task

    assert skipped is None
    assert report.server_id == "srv_auto"
    assert discovery.calls == 1
    assert discovery.max_concurrent == 1


@pytest.mark.asyncio
async def test_trigger_auto_refresh_error_writes_status_and_audit(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories, server_id="srv_auto")
    manager = _manager(
        tmp_path,
        repositories,
        client_factory=StaticClientFactory(
            FakeSchedulerClient(server_id="srv_auto", initialize_error=TimeoutError("slow"))
        ),
    )

    with pytest.raises(McpRuntimeError) as exc_info:
        await manager.trigger_auto_refresh("srv_auto")

    status = repositories.mcp_server_status.get("srv_auto")
    audits, total = repositories.mcp_audit_log.list(event_type="refresh.failed")

    assert exc_info.value.code == McpErrorCode.TIMEOUT
    assert status.status == "offline"
    assert status.last_error_code == "timeout"
    assert total == 1
    assert audits[0].detail["error_code"] == "timeout"


@pytest.mark.asyncio
async def test_shutdown_cancels_auto_refresh_tasks(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories, server_id="srv_auto")
    manager = _manager(tmp_path, repositories)
    await manager.start()

    await manager.shutdown()

    assert manager.scheduled_refresh_server_ids() == []
    assert manager.auto_refresh_task_count == 0


def _manager(
    tmp_path,
    repositories: StorageRepositories,
    *,
    client_factory=None,
) -> McpManager:
    return McpManager(
        settings=AppSettings(data_dir=tmp_path / "data"),
        repositories=repositories,
        client_factory=client_factory or StaticClientFactory(FakeSchedulerClient()),
    )


def _report(server_id: str) -> McpRefreshReport:
    return McpRefreshReport(
        server_id=server_id,
        status="online",
        tools_count=0,
        resources_reserved_count=0,
        removed_tools_count=0,
        schema_changed_tools_count=0,
        refresh_revision=1,
        duration_ms=0,
    )


class RecordingDiscoveryService:
    def __init__(self) -> None:
        self.calls: list[str] = []

    async def refresh_server(
        self,
        *,
        server: McpServerRecord,
        client,
        cancellation: McpCancellationToken | None = None,
    ) -> McpRefreshReport:
        self.calls.append(server.id)
        return _report(server.id)


class BlockingDiscoveryService:
    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.calls = 0
        self.active = 0
        self.max_concurrent = 0

    async def refresh_server(
        self,
        *,
        server: McpServerRecord,
        client,
        cancellation: McpCancellationToken | None = None,
    ) -> McpRefreshReport:
        self.calls += 1
        self.active += 1
        self.max_concurrent = max(self.max_concurrent, self.active)
        self.started.set()
        await self.release.wait()
        self.active -= 1
        return _report(server.id)


class StaticClientFactory:
    def __init__(self, client: FakeSchedulerClient) -> None:
        self.client = client

    def create_client(self, server: McpServerRecord):
        return self.client


class FakeSchedulerClient(McpClientBase):
    def __init__(
        self,
        server_id: str = "srv_auto",
        *,
        initialize_error: BaseException | None = None,
    ) -> None:
        super().__init__(server_id=server_id)
        self.initialize_error = initialize_error
        self.shutdown_calls = 0

    async def initialize(
        self,
        *,
        timeout_sec: float | None = None,
        cancellation: McpCancellationToken | None = None,
    ) -> McpClientInitializeResult:
        if self.initialize_error is not None:
            raise self.initialize_error
        self.transition_status(McpServerStatus.ONLINE, reason="test_initialized")
        return McpClientInitializeResult(
            protocol_version="2026-03-26",
            server_info={"name": "fake-scheduler"},
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
        raise NotImplementedError

    async def cancel_call(self, call_id: str) -> bool:
        return False

    async def shutdown(self, *, timeout_sec: float | None = None) -> None:
        self.shutdown_calls += 1
