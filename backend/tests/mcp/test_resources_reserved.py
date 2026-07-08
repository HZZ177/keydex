from __future__ import annotations

import pytest

from backend.app.api.mcp import router
from backend.app.core.config import AppSettings
from backend.app.mcp.errors import McpRuntimeError
from backend.app.mcp.manager import McpManager
from backend.app.mcp.resources import McpResourcesReservedService
from backend.app.mcp.runtime import McpRuntimeSnapshotBuilder, McpRuntimeSnapshotContext
from backend.app.mcp.service import list_mcp_tools, server_payload
from backend.app.mcp.tools import McpCapabilitySearchIndex, mcp_local_tools_from_snapshot
from backend.app.mcp.types import McpErrorCode
from backend.app.storage import StorageRepositories, init_database


def _repositories(tmp_path) -> StorageRepositories:
    return StorageRepositories(init_database(tmp_path / "app.db"))


def _create_server(repositories: StorageRepositories) -> None:
    repositories.mcp_servers.create(
        server_id="srv_resources",
        name="Resources MCP",
        transport="streamable_http",
        url="https://mcp.example.test/mcp",
    )


def test_resources_reserved_service_lists_local_summaries_but_read_denies(
    tmp_path,
) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories)
    repositories.mcp_resources.upsert_resources(
        "srv_resources",
        [
            {
                "uri": "file:///workspace/guide.md",
                "name": "Guide",
                "description": "Reserved resource",
                "mime_type": "text/markdown",
                "meta": {"source": "test"},
            }
        ],
    )
    repositories.mcp_resources.upsert_templates(
        "srv_resources",
        [
            {
                "uri_template": "file:///workspace/{path}",
                "name": "Workspace file",
            }
        ],
    )
    service = McpResourcesReservedService(repositories)
    manager = McpManager(
        settings=AppSettings(data_dir=tmp_path / "data"),
        repositories=repositories,
    )

    resources = service.list_resources_reserved("srv_resources")
    templates = manager.list_resource_templates_reserved("srv_resources")

    assert resources[0].to_dict() == {
        "uri": "file:///workspace/guide.md",
        "reserved_only": True,
        "name": "Guide",
        "description": "Reserved resource",
        "mime_type": "text/markdown",
        "meta": {"source": "test"},
    }
    assert templates[0].uri_template == "file:///workspace/{path}"
    assert templates[0].reserved_only is True
    with pytest.raises(McpRuntimeError) as exc_info:
        manager.read_resource_reserved("srv_resources", "file:///workspace/guide.md")
    assert exc_info.value.code == McpErrorCode.RESOURCE_RESERVED
    assert exc_info.value.detail == {
        "server_id": "srv_resources",
        "uri": "file:///workspace/guide.md",
        "reserved_only": True,
    }


def test_mcp_router_does_not_register_resource_endpoints() -> None:
    paths = {
        getattr(route, "path_format", getattr(route, "path", ""))
        for route in router.routes
    }

    assert all("/resources" not in path for path in paths)
    assert all("/resource-templates" not in path for path in paths)


def test_reserved_resources_do_not_enter_snapshot_or_local_tool_registry(
    tmp_path,
) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories)
    repositories.mcp_resources.upsert_resources(
        "srv_resources",
        [{"uri": "file:///workspace/guide.md", "name": "Guide"}],
    )
    repositories.mcp_server_status.update_refresh_counts(
        "srv_resources",
        status="online",
        tools_count=0,
        resources_reserved_count=1,
    )
    server = repositories.mcp_servers.get("srv_resources")
    assert server is not None
    payload = server_payload(repositories, server, detail=False)

    snapshot = McpRuntimeSnapshotBuilder(
        repositories,
        direct_tool_budget=40,
    ).build_snapshot(McpRuntimeSnapshotContext(session_id="session-a"))
    tools = mcp_local_tools_from_snapshot(snapshot, executor=object())
    search_index = McpCapabilitySearchIndex(snapshot.visible_tools)

    assert payload["resources_reserved_count"] == 1
    assert payload["resources_reserved"] is True
    assert snapshot.visible_tools == []
    assert tools == []
    assert search_index.list_tools() == []
    assert search_index.search(query="guide") == []


def test_server_payload_reports_tool_availability_stats(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("KEYDEX_MCP_DIRECT_TOOL_BUDGET", "3")
    repositories = _repositories(tmp_path)
    _create_server(repositories)
    repositories.mcp_server_status.update_refresh_counts(
        "srv_resources",
        status="online",
        tools_count=5,
        resources_reserved_count=0,
    )
    repositories.mcp_tools.upsert_many(
        "srv_resources",
        [
            {
                "raw_name": f"tool_{index}",
                "model_name": f"mcp__srv_resources__tool_{index}",
                "callable_namespace": "mcp__srv_resources",
                "callable_name": f"tool_{index}",
                "description": f"Tool {index}",
                "input_schema": {"type": "object"},
                "schema_hash": f"hash-{index}",
            }
            for index in range(5)
        ],
    )
    repositories.mcp_tools.record_call_result("srv_resources", "tool_0", success=True)

    server = repositories.mcp_servers.get("srv_resources")
    assert server is not None
    payload = server_payload(repositories, server, detail=False)

    assert payload["tools_count"] == 5
    assert payload["direct_tools_count"] == 0
    assert payload["on_demand_tools_count"] == 5
    assert payload["recently_used_tools_count"] == 1

    repositories.mcp_tool_policies.upsert(
        server_id="srv_resources",
        raw_tool_name="tool_4",
        enabled=False,
    )
    listed_tools = list_mcp_tools(repositories, "srv_resources", limit=1000)["list"]
    availability_by_name = {
        str(tool["raw_name"]): tool["availability_mode"]
        for tool in listed_tools
    }

    assert list(availability_by_name.values()).count("direct") == 0
    assert list(availability_by_name.values()).count("on_demand") == 4
    assert availability_by_name["tool_4"] == "disabled"
