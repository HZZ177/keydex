from __future__ import annotations

import pytest

from backend.app.mcp.errors import McpRuntimeError
from backend.app.mcp.runtime import McpRuntimeSnapshotBuilder, McpRuntimeSnapshotContext
from backend.app.mcp.types import McpErrorCode
from backend.app.storage import StorageRepositories, init_database


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
    return McpRuntimeSnapshotBuilder(repositories, deferred_threshold=40)


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
    assert snapshot.policy_summary["hidden_tools"] == 1
    assert repositories.mcp_runtime_snapshots.get(snapshot.id) == snapshot


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
    assert snapshot.policy_summary["hidden_tools"] == 1


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
    assert snapshot.policy_summary["hidden_tools"] == 1


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
    assert snapshot.policy_summary["hidden_tools"] == 1


def test_non_workspace_session_persists_empty_snapshot(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories)
    _tool(repositories, "tool")

    snapshot = _builder(repositories).build_snapshot(
        McpRuntimeSnapshotContext(session_id="session-a", workspace_session=False)
    )

    assert snapshot.visible_tools == []
    assert snapshot.policy_summary == {"workspace_session": False, "mode": "disabled"}
