from __future__ import annotations

import pytest

from backend.app.mcp.errors import McpRuntimeError
from backend.app.mcp.runtime import McpRuntimeSnapshotBuilder, McpRuntimeSnapshotContext
from backend.app.mcp.tools import McpActiveToolWindow, mcp_capability_discovery_tools_from_snapshot
from backend.app.mcp.types import McpErrorCode
from backend.app.storage import StorageRepositories, init_database
from backend.app.tools.base import ToolExecutionContext


def _repositories(tmp_path) -> StorageRepositories:
    return StorageRepositories(init_database(tmp_path / "app.db"))


def _create_server(
    repositories: StorageRepositories,
    *,
    server_id: str = "srv_snapshot",
    required: bool = False,
    status: str = "online",
) -> None:
    repositories.mcp_servers.create(
        server_id=server_id,
        name=f"Snapshot MCP {server_id}",
        transport="streamable_http",
        url="https://mcp.example.test/mcp",
        required=required,
    )
    if status == "online":
        repositories.mcp_server_status.update_refresh_counts(
            server_id,
            status="online",
            tools_count=1,
        )
    else:
        repositories.mcp_server_status.upsert(server_id, status=status)


def _tool(
    repositories: StorageRepositories,
    raw_name: str,
    *,
    server_id: str = "srv_snapshot",
) -> None:
    repositories.mcp_tools.upsert_many(
        server_id,
        [
            {
                "raw_name": raw_name,
                "model_name": f"mcp__{server_id}__{raw_name}",
                "callable_namespace": f"mcp__{server_id}",
                "callable_name": raw_name,
                "description": f"MCP description {raw_name}",
                "input_schema": {"type": "object"},
                "schema_hash": f"hash-{raw_name}",
                "annotations": {"readOnlyHint": True},
            }
        ],
    )


def _builder(repositories: StorageRepositories) -> McpRuntimeSnapshotBuilder:
    return McpRuntimeSnapshotBuilder(repositories, direct_tool_budget=40)


def _tool_context(tmp_path) -> ToolExecutionContext:
    return ToolExecutionContext(
        session_id="session-a",
        user_id="user-a",
        workspace_root=tmp_path,
        turn_index=1,
        trace_id="trace-a",
        metadata={},
    )


def test_snapshot_persists_visible_contracts_and_status(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories)
    _tool(repositories, "visible")
    _tool(repositories, "disabled")
    repositories.mcp_tool_policies.upsert(
        server_id="srv_snapshot",
        raw_tool_name="disabled",
        enabled=False,
    )

    snapshot = _builder(repositories).build_snapshot(
        McpRuntimeSnapshotContext(session_id="session-a", turn_id="turn-a")
    )

    assert snapshot.session_id == "session-a"
    assert snapshot.turn_id == "turn-a"
    assert snapshot.tool_inventory_revision == 1
    assert [tool["raw_name"] for tool in snapshot.visible_tools] == ["visible"]
    assert snapshot.visible_tools[0]["server_name"] == "Snapshot MCP srv_snapshot"
    assert snapshot.visible_tools[0]["description"] == "MCP description visible"
    assert snapshot.server_status["srv_snapshot"]["status"] == "online"
    assert snapshot.policy_summary["unavailable_tools"] == 1
    assert repositories.mcp_runtime_snapshots.get(snapshot.id) == snapshot


def test_snapshot_persists_active_model_names_for_runtime_panel(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories)
    _tool(repositories, "visible")

    snapshot = _builder(repositories).build_snapshot(
        McpRuntimeSnapshotContext(
            session_id="session-a",
            active_model_names={"mcp__srv_snapshot__visible"},
        )
    )

    assert snapshot.policy_summary["active_model_names"] == ["mcp__srv_snapshot__visible"]
    stored = repositories.mcp_runtime_snapshots.get(snapshot.id)
    assert stored is not None
    assert stored.policy_summary["active_model_names"] == ["mcp__srv_snapshot__visible"]


def test_snapshot_keeps_all_tools_on_demand_when_over_budget_without_activation(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories)
    _tool(repositories, "one")
    _tool(repositories, "two")
    _tool(repositories, "three")

    snapshot = McpRuntimeSnapshotBuilder(repositories, direct_tool_budget=2).build_snapshot(
        McpRuntimeSnapshotContext(
            session_id="session-a",
            recent_model_names=["mcp__srv_snapshot__three"],
        )
    )

    assert {
        (tool["raw_name"], tool["exposure"]) for tool in snapshot.visible_tools
    } == {
        ("one", "on_demand"),
        ("two", "on_demand"),
        ("three", "on_demand"),
    }
    assert snapshot.direct_available_tools == 0
    assert snapshot.on_demand_tools == 3


def test_snapshot_does_not_preload_session_recent_success_when_over_budget(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories)
    _tool(repositories, "one")
    _tool(repositories, "two")
    _tool(repositories, "three")
    repositories.mcp_session_tool_usage.record_success(
        session_id="session-a",
        server_id="srv_snapshot",
        raw_tool_name="three",
        model_name="mcp__srv_snapshot__three",
    )

    snapshot = McpRuntimeSnapshotBuilder(repositories, direct_tool_budget=2).build_snapshot(
        McpRuntimeSnapshotContext(session_id="session-a")
    )

    assert {
        (tool["raw_name"], tool["exposure"]) for tool in snapshot.visible_tools
    } == {
        ("one", "on_demand"),
        ("two", "on_demand"),
        ("three", "on_demand"),
    }


def test_snapshot_preloads_priority_policy_when_over_budget(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories)
    _tool(repositories, "one")
    _tool(repositories, "two")
    _tool(repositories, "three")
    _tool(repositories, "four")
    repositories.mcp_tool_policies.upsert(
        server_id="srv_snapshot",
        raw_tool_name="two",
        priority_available=True,
    )
    repositories.mcp_tool_policies.upsert(
        server_id="srv_snapshot",
        raw_tool_name="three",
        priority_available=True,
    )

    snapshot = McpRuntimeSnapshotBuilder(repositories, direct_tool_budget=1).build_snapshot(
        McpRuntimeSnapshotContext(session_id="session-a")
    )

    assert {
        (tool["raw_name"], tool["exposure"]) for tool in snapshot.visible_tools
    } == {
        ("one", "on_demand"),
        ("two", "direct"),
        ("three", "direct"),
        ("four", "on_demand"),
    }
    assert snapshot.direct_available_tools == 2
    assert snapshot.on_demand_tools == 2
    assert snapshot.policy_summary["priority_available_tools"] == 2


def test_snapshot_does_not_expose_disabled_priority_tool(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories)
    _tool(repositories, "one")
    _tool(repositories, "two")
    _tool(repositories, "three")
    repositories.mcp_tool_policies.upsert(
        server_id="srv_snapshot",
        raw_tool_name="three",
        enabled=False,
        priority_available=True,
    )

    snapshot = McpRuntimeSnapshotBuilder(repositories, direct_tool_budget=2).build_snapshot(
        McpRuntimeSnapshotContext(session_id="session-a")
    )

    assert [tool["raw_name"] for tool in snapshot.visible_tools] == ["one", "two"]
    assert snapshot.unavailable_tools == 1


def test_snapshot_is_frozen_after_policy_changes(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories)
    _tool(repositories, "tool")
    snapshot = _builder(repositories).build_snapshot(
        McpRuntimeSnapshotContext(session_id="session-a")
    )

    repositories.mcp_tool_policies.upsert(
        server_id="srv_snapshot",
        raw_tool_name="tool",
        enabled=False,
    )
    stored = repositories.mcp_runtime_snapshots.get(snapshot.id)
    next_snapshot = _builder(repositories).build_snapshot(
        McpRuntimeSnapshotContext(session_id="session-a")
    )

    assert [tool["raw_name"] for tool in stored.visible_tools] == ["tool"]
    assert next_snapshot.visible_tools == []


def test_snapshot_is_frozen_after_new_tool_is_discovered_until_next_turn(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories)
    _tool(repositories, "existing")
    snapshot = _builder(repositories).build_snapshot(
        McpRuntimeSnapshotContext(session_id="session-a", turn_id="turn-a")
    )

    _tool(repositories, "later")
    stored = repositories.mcp_runtime_snapshots.get(snapshot.id)
    next_snapshot = _builder(repositories).build_snapshot(
        McpRuntimeSnapshotContext(session_id="session-a", turn_id="turn-b")
    )

    assert [tool["raw_name"] for tool in stored.visible_tools] == ["existing"]
    assert [tool["raw_name"] for tool in next_snapshot.visible_tools] == [
        "existing",
        "later",
    ]


def test_required_server_offline_blocks_snapshot(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories, required=True, status="offline")
    _tool(repositories, "tool")

    with pytest.raises(McpRuntimeError) as exc_info:
        _builder(repositories).build_snapshot(McpRuntimeSnapshotContext(session_id="session-a"))

    assert exc_info.value.code == McpErrorCode.SERVER_OFFLINE
    assert exc_info.value.detail == {
        "server_id": "srv_snapshot",
        "server_status": "offline",
    }


def test_required_server_auth_required_blocks_snapshot_with_auth_error(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories, required=True, status="auth_required")
    _tool(repositories, "tool")

    with pytest.raises(McpRuntimeError) as exc_info:
        _builder(repositories).build_snapshot(McpRuntimeSnapshotContext(session_id="session-a"))

    assert exc_info.value.code == McpErrorCode.AUTH_REQUIRED
    assert exc_info.value.detail == {
        "server_id": "srv_snapshot",
        "server_status": "auth_required",
    }


def test_non_required_server_offline_is_recorded_but_tools_are_excluded(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories, required=False, status="offline")
    _tool(repositories, "tool")

    snapshot = _builder(repositories).build_snapshot(
        McpRuntimeSnapshotContext(session_id="session-a")
    )

    assert snapshot.visible_tools == []
    assert snapshot.server_status["srv_snapshot"]["status"] == "offline"
    assert snapshot.policy_summary["unavailable_tools"] == 1


def test_non_required_auth_required_server_is_recorded_but_tools_are_excluded(
    tmp_path,
) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories, required=False, status="auth_required")
    _tool(repositories, "tool")

    snapshot = _builder(repositories).build_snapshot(
        McpRuntimeSnapshotContext(session_id="session-a")
    )

    assert snapshot.visible_tools == []
    assert snapshot.server_status["srv_snapshot"]["status"] == "auth_required"
    assert snapshot.policy_summary["unavailable_tools"] == 1


def test_session_override_disabled_is_not_in_snapshot(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories)
    _tool(repositories, "tool")
    repositories.mcp_session_tool_overrides.set(
        session_id="session-a",
        server_id="srv_snapshot",
        raw_tool_name="tool",
        enabled=False,
    )

    snapshot = _builder(repositories).build_snapshot(
        McpRuntimeSnapshotContext(session_id="session-a")
    )

    assert snapshot.visible_tools == []
    assert snapshot.policy_summary["unavailable_tools"] == 1


@pytest.mark.asyncio
async def test_capability_discovery_cannot_return_unavailable_tools(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories, server_id="srv_online", status="online")
    _tool(repositories, "available_direct", server_id="srv_online")
    _tool(repositories, "available_search", server_id="srv_online")
    _tool(repositories, "disabled_policy", server_id="srv_online")
    _tool(repositories, "hidden_policy", server_id="srv_online")
    _tool(repositories, "removed_tool", server_id="srv_online")
    _tool(repositories, "session_disabled", server_id="srv_online")
    repositories.mcp_tool_policies.upsert(
        server_id="srv_online",
        raw_tool_name="disabled_policy",
        enabled=False,
    )
    repositories.mcp_tool_policies.upsert(
        server_id="srv_online",
        raw_tool_name="hidden_policy",
        hidden=True,
    )
    repositories.mcp_tools.set_discovery_status("srv_online", "removed_tool", "removed")
    repositories.mcp_session_tool_overrides.set(
        session_id="session-a",
        server_id="srv_online",
        raw_tool_name="session_disabled",
        enabled=False,
    )
    _create_server(repositories, server_id="srv_offline", status="offline")
    _tool(repositories, "offline_tool", server_id="srv_offline")
    _create_server(repositories, server_id="srv_auth", status="auth_required")
    _tool(repositories, "auth_tool", server_id="srv_auth")
    _create_server(repositories, server_id="srv_disabled", status="online")
    repositories.mcp_servers.set_enabled("srv_disabled", False)
    _tool(repositories, "server_disabled_tool", server_id="srv_disabled")

    snapshot = McpRuntimeSnapshotBuilder(repositories, direct_tool_budget=1).build_snapshot(
        McpRuntimeSnapshotContext(session_id="session-a")
    )
    discovery_tools = mcp_capability_discovery_tools_from_snapshot(
        snapshot,
        McpActiveToolWindow(),
    )
    result = await discovery_tools[0].run({}, _tool_context(tmp_path))

    assert [tool["raw_name"] for tool in snapshot.visible_tools] == [
        "available_direct",
        "available_search",
    ]
    assert {item["raw_name"] for item in result.result["tools"]} == {
        "available_direct",
        "available_search",
    }

    for unavailable_query in (
        "disabled_policy",
        "hidden_policy",
        "removed_tool",
        "session_disabled",
        "offline_tool",
        "auth_tool",
        "server_disabled_tool",
    ):
        unavailable = await discovery_tools[0].run(
            {"query": unavailable_query},
            _tool_context(tmp_path),
        )
        assert unavailable.ok is True
        assert unavailable.result["tools"] == []
        assert unavailable.result["activation"]["activated_model_names"] == []


def test_snapshot_policy_summary_contains_server_capability_directory(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories, server_id="srv_online", status="online")
    _tool(repositories, "read_file", server_id="srv_online")
    _create_server(repositories, server_id="srv_offline", status="offline")
    _tool(repositories, "search_docs", server_id="srv_offline")
    _create_server(repositories, server_id="srv_auth", status="auth_required")
    _tool(repositories, "secure_read", server_id="srv_auth")
    _create_server(repositories, server_id="srv_disabled", status="online")
    _tool(repositories, "disabled_tool", server_id="srv_disabled")
    repositories.mcp_servers.set_enabled("srv_disabled", False)
    _create_server(repositories, server_id="srv_empty", status="online")

    snapshot = _builder(repositories).build_snapshot(
        McpRuntimeSnapshotContext(session_id="session-a")
    )

    directory = {
        item["server_id"]: item
        for item in snapshot.capability_directory
    }
    assert snapshot.policy_summary["capability_directory"] == snapshot.capability_directory
    assert snapshot.direct_available_tools == 1
    assert snapshot.on_demand_tools == 0
    assert snapshot.unavailable_tools == 3
    assert directory["srv_online"]["status"] == "online"
    assert directory["srv_online"]["status_label"] == "在线"
    assert directory["srv_online"]["available_tool_count"] == 1
    assert directory["srv_online"]["direct_tool_count"] == 1
    assert directory["srv_online"]["capability_keywords"] == ["read_file"]
    assert directory["srv_offline"]["status"] == "offline"
    assert directory["srv_offline"]["status_label"] == "离线"
    assert directory["srv_offline"]["available_tool_count"] == 0
    assert directory["srv_auth"]["status"] == "auth_required"
    assert directory["srv_auth"]["status_label"] == "需要认证"
    assert directory["srv_auth"]["requires_auth"] is True
    assert directory["srv_disabled"]["status"] == "disabled"
    assert directory["srv_disabled"]["status_label"] == "已停用"
    assert directory["srv_empty"]["status"] == "online"
    assert directory["srv_empty"]["available_tool_count"] == 0


def test_non_workspace_session_persists_empty_snapshot(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories)
    _tool(repositories, "tool")

    snapshot = _builder(repositories).build_snapshot(
        McpRuntimeSnapshotContext(session_id="session-a", workspace_session=False)
    )

    assert snapshot.visible_tools == []
    assert snapshot.policy_summary == {
        "workspace_session": False,
        "availability": "unavailable",
        "reason": "not_workspace_session",
    }
