from __future__ import annotations

import pytest

from backend.app.mcp.errors import McpRuntimeError
from backend.app.mcp.runtime import (
    McpLiveExecutionGuard,
    McpRuntimeSnapshotBuilder,
    McpRuntimeSnapshotContext,
)
from backend.app.mcp.types import McpErrorCode
from backend.app.storage import StorageRepositories, init_database


def _repositories(tmp_path) -> StorageRepositories:
    return StorageRepositories(init_database(tmp_path / "app.db"))


def _create_server(
    repositories: StorageRepositories,
    *,
    status: str = "online",
    enabled: bool = True,
) -> None:
    repositories.mcp_servers.create(
        server_id="srv_guard",
        name="Guard MCP",
        transport="streamable_http",
        url="https://mcp.example.test/mcp",
        enabled=enabled,
    )
    repositories.mcp_server_status.upsert("srv_guard", status=status)


def _tool(repositories: StorageRepositories, raw_name: str = "tool") -> None:
    repositories.mcp_tools.upsert_many(
        "srv_guard",
        [
            {
                "raw_name": raw_name,
                "model_name": f"mcp__srv_guard__{raw_name}",
                "callable_namespace": "mcp__srv_guard",
                "callable_name": raw_name,
                "description": "MCP tool description",
                "input_schema": {"type": "object"},
                "schema_hash": f"hash-{raw_name}",
                "risk_level": "low",
            }
        ],
    )


def _guard(repositories: StorageRepositories) -> McpLiveExecutionGuard:
    return McpLiveExecutionGuard(repositories)


def test_guard_allows_currently_visible_tool(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories)
    _tool(repositories)

    allowed = _guard(repositories).assert_allowed(
        session_id="session-a",
        server_id="srv_guard",
        raw_tool_name="tool",
    )

    assert allowed.model_name == "mcp__srv_guard__tool"
    assert allowed.tool.raw_name == "tool"


def test_guard_rejects_session_disabled_tool_and_next_snapshot_excludes_it(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories)
    _tool(repositories)
    before = McpRuntimeSnapshotBuilder(repositories, deferred_threshold=40).build_snapshot(
        McpRuntimeSnapshotContext(session_id="session-a")
    )
    repositories.mcp_session_tool_overrides.set(
        session_id="session-a",
        server_id="srv_guard",
        raw_tool_name="tool",
        enabled=False,
    )

    with pytest.raises(McpRuntimeError) as exc_info:
        _guard(repositories).assert_allowed(
            session_id="session-a",
            server_id="srv_guard",
            raw_tool_name="tool",
        )
    after = McpRuntimeSnapshotBuilder(repositories, deferred_threshold=40).build_snapshot(
        McpRuntimeSnapshotContext(session_id="session-a")
    )

    assert [tool["raw_name"] for tool in before.visible_tools] == ["tool"]
    assert exc_info.value.code == McpErrorCode.TOOL_DISABLED_BY_SESSION
    assert after.visible_tools == []


@pytest.mark.parametrize(
    ("status", "expected_code"),
    [
        ("offline", McpErrorCode.SERVER_OFFLINE),
        ("auth_required", McpErrorCode.AUTH_REQUIRED),
    ],
)
def test_guard_rejects_server_status_failures(tmp_path, status: str, expected_code) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories, status=status)
    _tool(repositories)

    with pytest.raises(McpRuntimeError) as exc_info:
        _guard(repositories).assert_allowed(
            session_id="session-a",
            server_id="srv_guard",
            raw_tool_name="tool",
        )

    assert exc_info.value.code == expected_code


def test_guard_rejects_server_disabled(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories, enabled=False)
    _tool(repositories)

    with pytest.raises(McpRuntimeError) as exc_info:
        _guard(repositories).assert_allowed(
            session_id="session-a",
            server_id="srv_guard",
            raw_tool_name="tool",
        )

    assert exc_info.value.code == McpErrorCode.SERVER_DISABLED


def test_guard_rejects_hidden_policy_and_removed_tool_with_stable_errors(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories)
    _tool(repositories, "hidden")
    _tool(repositories, "removed")
    repositories.mcp_tool_policies.upsert(
        server_id="srv_guard",
        raw_tool_name="hidden",
        hidden=True,
    )
    repositories.mcp_tools.set_discovery_status("srv_guard", "removed", "removed")

    with pytest.raises(McpRuntimeError) as hidden_exc:
        _guard(repositories).assert_allowed(
            session_id="session-a",
            server_id="srv_guard",
            raw_tool_name="hidden",
        )
    with pytest.raises(McpRuntimeError) as removed_exc:
        _guard(repositories).assert_allowed(
            session_id="session-a",
            server_id="srv_guard",
            raw_tool_name="removed",
        )
    audits, total = repositories.mcp_audit_log.list(event_type="tool.guard_rejected")

    assert hidden_exc.value.code == McpErrorCode.TOOL_DISABLED_BY_POLICY
    assert removed_exc.value.code == McpErrorCode.TOOL_NOT_FOUND
    assert total == 2
    assert {audit.detail["error_code"] for audit in audits} == {
        "tool_disabled_by_policy",
        "tool_not_found",
    }


def test_guard_rejects_policy_disabled_after_schema_was_sent(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories)
    _tool(repositories)
    snapshot = McpRuntimeSnapshotBuilder(repositories, deferred_threshold=40).build_snapshot(
        McpRuntimeSnapshotContext(session_id="session-a")
    )
    repositories.mcp_tool_policies.upsert(
        server_id="srv_guard",
        raw_tool_name="tool",
        enabled=False,
    )

    with pytest.raises(McpRuntimeError) as exc_info:
        _guard(repositories).assert_allowed(
            session_id="session-a",
            server_id="srv_guard",
            raw_tool_name="tool",
        )
    next_snapshot = McpRuntimeSnapshotBuilder(repositories, deferred_threshold=40).build_snapshot(
        McpRuntimeSnapshotContext(session_id="session-a")
    )

    assert [tool["raw_name"] for tool in snapshot.visible_tools] == ["tool"]
    assert exc_info.value.code == McpErrorCode.TOOL_DISABLED_BY_POLICY
    assert next_snapshot.visible_tools == []
