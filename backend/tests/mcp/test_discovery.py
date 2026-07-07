from __future__ import annotations

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
from backend.app.mcp.errors import McpRuntimeError
from backend.app.mcp.manager import McpManager
from backend.app.mcp.types import McpErrorCode, McpServerStatus
from backend.app.storage import McpServerRecord, StorageRepositories, init_database


def _repositories(tmp_path) -> StorageRepositories:
    return StorageRepositories(init_database(tmp_path / "app.db"))


def _create_server(repositories: StorageRepositories, server_id: str = "srv_refresh") -> None:
    repositories.mcp_servers.create(
        server_id=server_id,
        name=f"Refresh MCP {server_id}",
        transport="streamable_http",
        url="https://mcp.example.test/mcp",
    )


@pytest.mark.asyncio
async def test_refresh_capabilities_persists_tools_status_and_audit(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories)
    client = FakeDiscoveryClient(
        tools=[
            McpClientToolSpec(
                name="echo",
                description="Echo text",
                input_schema={"type": "object"},
                annotations={"readOnlyHint": True},
                raw={"source": "mock"},
            )
        ],
        capabilities=McpClientCapabilities(resources_reserved=True),
    )
    manager = _manager(tmp_path, repositories, client)

    report = await manager.refresh_capabilities("srv_refresh")

    tool = repositories.mcp_tools.get_by_raw_name("srv_refresh", "echo")
    status = repositories.mcp_server_status.get("srv_refresh")
    audits, total = repositories.mcp_audit_log.list(event_type="refresh.completed")

    assert report.status == "online"
    assert report.tools_count == 1
    assert report.resources_reserved_count == 1
    assert tool.model_name == "mcp__srv_refresh__echo"
    assert tool.input_schema == {"type": "object"}
    assert status.last_refresh_revision == 1
    assert status.tools_count == 1
    assert status.resources_reserved_count == 1
    assert client.list_resources_calls == 0
    assert total == 1
    assert audits[0].detail["tools_count"] == 1


@pytest.mark.asyncio
async def test_refresh_marks_first_discovery_new_then_unchanged_active(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories)
    first_client = FakeDiscoveryClient(
        tools=[_tool("echo", {"type": "object"})],
    )
    second_client = FakeDiscoveryClient(
        tools=[_tool("echo", {"type": "object"})],
    )
    manager = _manager(tmp_path, repositories, first_client, second_client)

    first_report = await manager.refresh_capabilities("srv_refresh")
    first_tool = repositories.mcp_tools.get_by_raw_name("srv_refresh", "echo")
    first_schema_hash = first_tool.schema_hash

    second_report = await manager.refresh_capabilities("srv_refresh")
    second_tool = repositories.mcp_tools.get_by_raw_name("srv_refresh", "echo")

    assert first_report.refresh_revision == 1
    assert second_report.refresh_revision == 2
    assert first_tool.discovery_status == "new"
    assert second_tool.discovery_status == "active"
    assert second_tool.schema_hash == first_schema_hash
    assert second_report.schema_changed_tools_count == 0


@pytest.mark.asyncio
async def test_refresh_marks_removed_and_schema_changed_without_losing_model_name(
    tmp_path,
) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories)
    first_client = FakeDiscoveryClient(
        tools=[
            _tool("echo", {"type": "object"}),
            _tool("obsolete", {"type": "object"}),
        ],
    )
    second_client = FakeDiscoveryClient(
        tools=[_tool("echo", {"type": "object", "required": ["text"]})],
    )
    manager = _manager(tmp_path, repositories, first_client, second_client)

    await manager.refresh_capabilities("srv_refresh")
    report = await manager.refresh_capabilities("srv_refresh")

    echo = repositories.mcp_tools.get_by_raw_name("srv_refresh", "echo")
    obsolete = repositories.mcp_tools.get_by_raw_name("srv_refresh", "obsolete")

    assert report.schema_changed_tools_count == 1
    assert report.removed_tools_count == 1
    assert echo.discovery_status == "schema_changed"
    assert echo.model_name == "mcp__srv_refresh__echo"
    assert obsolete.discovery_status == "removed"
    assert obsolete.removed_at is not None


@pytest.mark.asyncio
async def test_refresh_auth_failure_preserves_existing_tools_and_writes_audit(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories)
    repositories.mcp_tools.upsert_many(
        "srv_refresh",
        [
            {
                "raw_name": "existing",
                "model_name": "mcp__srv_refresh__existing",
                "callable_namespace": "mcp__srv_refresh",
                "callable_name": "existing",
                "input_schema": {"type": "object"},
                "schema_hash": "hash-existing",
            }
        ],
    )
    manager = _manager(
        tmp_path,
        repositories,
        FakeDiscoveryClient(
            initialize_error=McpRuntimeError(McpErrorCode.AUTH_REQUIRED, "auth required")
        ),
    )

    with pytest.raises(McpRuntimeError) as exc_info:
        await manager.refresh_capabilities("srv_refresh")

    tool = repositories.mcp_tools.get_by_raw_name("srv_refresh", "existing")
    status = repositories.mcp_server_status.get("srv_refresh")
    audits, total = repositories.mcp_audit_log.list(event_type="refresh.failed")

    assert exc_info.value.code == McpErrorCode.AUTH_REQUIRED
    assert tool.discovery_status == "new"
    assert status.status == "auth_required"
    assert status.last_error_code == "auth_required"
    assert total == 1
    assert audits[0].detail["error_code"] == "auth_required"


@pytest.mark.asyncio
async def test_refresh_list_tools_failure_preserves_existing_discovery_and_writes_audit(
    tmp_path,
) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories)
    manager = _manager(
        tmp_path,
        repositories,
        FakeDiscoveryClient(tools=[_tool("existing", {"type": "object"})]),
        FakeDiscoveryClient(
            list_tools_error=McpRuntimeError(
                McpErrorCode.PROTOCOL_ERROR,
                "list tools failed",
            )
        ),
    )
    await manager.refresh_capabilities("srv_refresh")

    with pytest.raises(McpRuntimeError) as exc_info:
        await manager.refresh_capabilities("srv_refresh")

    existing_tool = repositories.mcp_tools.get_by_raw_name("srv_refresh", "existing")
    status = repositories.mcp_server_status.get("srv_refresh")
    audits, total = repositories.mcp_audit_log.list(event_type="refresh.failed")

    assert exc_info.value.code == McpErrorCode.PROTOCOL_ERROR
    assert existing_tool.discovery_status == "new"
    assert status.status == "error"
    assert status.last_error_code == "protocol_error"
    assert total == 1
    assert audits[0].detail["error_code"] == "protocol_error"


@pytest.mark.asyncio
async def test_refresh_applies_schema_change_action_policy(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories)
    first_client = FakeDiscoveryClient(
        tools=[
            _tool("keep_tool", {"type": "object"}),
            _tool("review_tool", {"type": "object"}),
            _tool("disable_tool", {"type": "object"}),
        ],
    )
    second_client = FakeDiscoveryClient(
        tools=[
            _tool("keep_tool", {"type": "object", "required": ["value"]}),
            _tool("review_tool", {"type": "object", "required": ["value"]}),
            _tool("disable_tool", {"type": "object", "required": ["value"]}),
        ],
    )
    manager = _manager(tmp_path, repositories, first_client, second_client)
    await manager.refresh_capabilities("srv_refresh")
    repositories.mcp_tool_policies.upsert(
        server_id="srv_refresh",
        raw_tool_name="keep_tool",
        enabled=True,
        approval_mode="auto",
        schema_change_action="keep_enabled",
    )
    repositories.mcp_tool_policies.upsert(
        server_id="srv_refresh",
        raw_tool_name="review_tool",
        enabled=True,
        approval_mode="auto",
        schema_change_action="require_review",
    )
    repositories.mcp_tool_policies.upsert(
        server_id="srv_refresh",
        raw_tool_name="disable_tool",
        enabled=True,
        approval_mode="auto",
        schema_change_action="disable",
    )

    report = await manager.refresh_capabilities("srv_refresh")

    keep_policy = repositories.mcp_tool_policies.get("srv_refresh", "keep_tool")
    review_policy = repositories.mcp_tool_policies.get("srv_refresh", "review_tool")
    disable_policy = repositories.mcp_tool_policies.get("srv_refresh", "disable_tool")

    assert report.schema_changed_tools_count == 3
    assert keep_policy.enabled is True
    assert keep_policy.approval_mode == "auto"
    assert review_policy.enabled is True
    assert review_policy.approval_mode == "prompt"
    assert disable_policy.enabled is False
    assert disable_policy.approval_mode == "auto"


@pytest.mark.asyncio
async def test_refresh_timeout_maps_to_offline_and_audit(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories)
    manager = _manager(
        tmp_path,
        repositories,
        FakeDiscoveryClient(initialize_error=TimeoutError("slow server")),
    )

    with pytest.raises(McpRuntimeError) as exc_info:
        await manager.refresh_capabilities("srv_refresh")

    status = repositories.mcp_server_status.get("srv_refresh")
    audits, total = repositories.mcp_audit_log.list(event_type="refresh.failed")

    assert exc_info.value.code == McpErrorCode.TIMEOUT
    assert status.status == "offline"
    assert status.last_error_code == "timeout"
    assert total == 1
    assert audits[0].detail["error_code"] == "timeout"


def _manager(
    tmp_path,
    repositories: StorageRepositories,
    *clients: FakeDiscoveryClient,
) -> McpManager:
    return McpManager(
        settings=AppSettings(data_dir=tmp_path / "data"),
        repositories=repositories,
        client_factory=SequencedClientFactory(list(clients)),
    )


def _tool(name: str, input_schema: dict[str, Any]) -> McpClientToolSpec:
    return McpClientToolSpec(
        name=name,
        description=f"Tool {name}",
        input_schema=input_schema,
    )


class SequencedClientFactory:
    def __init__(self, clients: list[FakeDiscoveryClient]) -> None:
        self.clients = clients
        self.index = 0

    def create_client(self, server: McpServerRecord):
        client = self.clients[self.index]
        self.index += 1
        return client


class FakeDiscoveryClient(McpClientBase):
    def __init__(
        self,
        *,
        tools: list[McpClientToolSpec] | None = None,
        capabilities: McpClientCapabilities | None = None,
        initialize_error: BaseException | None = None,
        list_tools_error: BaseException | None = None,
    ) -> None:
        super().__init__(server_id="srv_refresh")
        self.tools = tools or []
        self.capabilities = capabilities or McpClientCapabilities()
        self.initialize_error = initialize_error
        self.list_tools_error = list_tools_error
        self.list_resources_calls = 0
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
            server_info={"name": "fake-refresh"},
            capabilities=self.capabilities,
        )

    async def list_tools(
        self,
        *,
        timeout_sec: float | None = None,
        cancellation: McpCancellationToken | None = None,
    ) -> list[McpClientToolSpec]:
        if self.list_tools_error is not None:
            raise self.list_tools_error
        return self.tools

    async def list_resources(self, *_args: Any, **_kwargs: Any) -> list[Any]:
        self.list_resources_calls += 1
        raise AssertionError("resources are reserved and must not be listed")

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
