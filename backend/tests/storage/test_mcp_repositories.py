from __future__ import annotations

import pytest

from backend.app.storage import StorageRepositories, init_database


def _repositories(tmp_path) -> StorageRepositories:
    return StorageRepositories(init_database(tmp_path / "app.db"))


def test_mcp_server_repository_crud_toggle_filter_and_cascade(tmp_path) -> None:
    repositories = _repositories(tmp_path)

    server = repositories.mcp_servers.create(
        server_id="mcp-server-a",
        name="Local MCP",
        transport="stdio",
        command="node",
        args=["server.js"],
        env={"KEY": "VALUE"},
        default_tool_exposure_mode="allow_all_except_disabled",
    )

    assert server.id == "mcp-server-a"
    assert server.name == "Local MCP"
    assert server.enabled is True
    assert server.transport == "stdio"
    assert server.args == ["server.js"]
    assert server.env == {"KEY": "VALUE"}
    assert server.refresh_interval_sec == 60
    assert repositories.mcp_servers.get(server.id) == server
    assert repositories.mcp_server_status.get(server.id).status == "unknown"

    updated = repositories.mcp_servers.update(
        server.id,
        name="Local MCP Renamed",
        description="local test server",
        tool_timeout_sec=77,
    )

    assert updated is not None
    assert updated.name == "Local MCP Renamed"
    assert updated.description == "local test server"
    assert updated.tool_timeout_sec == 77
    assert repositories.mcp_server_status.get(server.id).status == "unknown"

    disabled = repositories.mcp_servers.set_enabled(server.id, False)
    disabled_servers, total_disabled = repositories.mcp_servers.list(enabled=False)

    assert disabled is not None
    assert disabled.enabled is False
    assert total_disabled == 1
    assert [item.id for item in disabled_servers] == [server.id]

    repositories.mcp_servers.create(
        server_id="mcp-server-b",
        name="Remote MCP",
        transport="streamable_http",
        url="http://127.0.0.1:9000/mcp",
    )
    stdio_servers, total_stdio = repositories.mcp_servers.list(transport="stdio")

    assert total_stdio == 1
    assert [item.id for item in stdio_servers] == [server.id]

    with repositories.db.transaction() as conn:
        conn.execute(
            """
            insert into mcp_tools (
              id, server_id, raw_name, model_name, callable_namespace, callable_name,
              input_schema_json, schema_hash, first_seen_at, last_seen_at
            ) values (
              'tool-a', 'mcp-server-a', 'create_issue', 'mcp__a__create_issue',
              'mcp__a', 'create_issue', '{}', 'hash-a',
              '2026-07-06T00:00:00Z', '2026-07-06T00:00:00Z'
            )
            """
        )

    assert repositories.mcp_servers.delete(server.id) is True
    assert repositories.mcp_servers.get(server.id) is None
    assert repositories.mcp_server_status.get(server.id) is None
    with repositories.db.connect() as conn:
        tool_count = conn.execute(
            "select count(*) as count from mcp_tools where server_id = ?",
            (server.id,),
        ).fetchone()
    assert tool_count["count"] == 0


def test_mcp_refresh_interval_old_default_migrates_to_sixty_seconds(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    server = repositories.mcp_servers.create(
        server_id="mcp-old-refresh-default",
        name="Old Refresh MCP",
        transport="streamable_http",
        url="https://mcp.example.test/mcp",
    )
    repositories.mcp_servers.update(server.id, refresh_interval_sec=1800)

    assert repositories.mcp_servers.get(server.id).refresh_interval_sec == 1800

    repositories.db.init_schema()

    assert repositories.mcp_servers.get(server.id).refresh_interval_sec == 60


def test_mcp_server_status_repository_upserts_errors_and_refresh_counts(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    repositories.mcp_servers.create(
        server_id="mcp-server-a",
        name="Local MCP",
        transport="stdio",
        command="node",
    )

    refreshing = repositories.mcp_server_status.upsert(
        "mcp-server-a",
        status="refreshing",
        capabilities={"tools": True},
        server_info={"name": "mock"},
        tools_count=1,
    )

    assert refreshing.status == "refreshing"
    assert refreshing.capabilities == {"tools": True}
    assert refreshing.server_info == {"name": "mock"}
    assert refreshing.tools_count == 1

    first_refresh = repositories.mcp_server_status.update_refresh_counts(
        "mcp-server-a",
        capabilities={"tools": True},
        server_info={"name": "mock", "version": "1"},
        tools_count=3,
        resources_reserved_count=1,
    )
    second_refresh = repositories.mcp_server_status.update_refresh_counts(
        "mcp-server-a",
        tools_count=4,
    )

    assert first_refresh.status == "online"
    assert first_refresh.last_refresh_revision == 1
    assert first_refresh.tools_count == 3
    assert first_refresh.resources_reserved_count == 1
    assert second_refresh.last_refresh_revision == 2
    assert second_refresh.tools_count == 4
    assert second_refresh.last_error_code is None

    failed = repositories.mcp_server_status.update_error(
        "mcp-server-a",
        status="offline",
        error_code="connect_timeout",
        error_message="connection timed out",
        error_detail={"timeout": 30},
    )

    assert failed.status == "offline"
    assert failed.last_error_code == "connect_timeout"
    assert failed.last_error_detail == {"timeout": 30}


def test_mcp_server_repositories_validate_enums(tmp_path) -> None:
    repositories = _repositories(tmp_path)

    with pytest.raises(ValueError, match="transport"):
        repositories.mcp_servers.create(
            server_id="bad-transport",
            name="Bad",
            transport="websocket",
        )

    with pytest.raises(ValueError, match="名称"):
        repositories.mcp_servers.create(
            server_id="bad-name",
            name=" ",
            transport="stdio",
        )

    with pytest.raises(ValueError, match="status"):
        repositories.mcp_server_status.upsert("missing", status="waiting")


def test_mcp_tool_repository_upserts_status_and_filters(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    repositories.mcp_servers.create(
        server_id="mcp-server-a",
        name="Local MCP",
        transport="stdio",
        command="node",
    )

    tools = repositories.mcp_tools.upsert_many(
        "mcp-server-a",
        [
            {
                "id": "tool-create",
                "raw_name": "create_issue",
                "model_name": "mcp__local__create_issue",
                "callable_namespace": "mcp__local",
                "callable_name": "create_issue",
                "description": "Create issue",
                "input_schema": {"type": "object"},
                "schema_hash": "hash-1",
            },
            {
                "id": "tool-list",
                "raw_name": "list_issues",
                "model_name": "mcp__local__list_issues",
                "callable_namespace": "mcp__local",
                "callable_name": "list_issues",
                "input_schema": {"type": "object"},
                "schema_hash": "hash-list",
            },
        ],
    )

    assert [tool.raw_name for tool in tools] == ["create_issue", "list_issues"]
    assert repositories.mcp_tools.get_by_model_name("mcp__local__create_issue").raw_name == (
        "create_issue"
    )
    assert [tool.raw_name for tool in repositories.mcp_tools.list_by_server("mcp-server-a")] == [
        "create_issue",
        "list_issues",
    ]
    changed = repositories.mcp_tools.upsert_many(
        "mcp-server-a",
        [
            {
                "raw_name": "create_issue",
                "model_name": "mcp__local__create_issue",
                "callable_namespace": "mcp__local",
                "callable_name": "create_issue",
                "input_schema": {"type": "object", "required": ["title"]},
                "schema_hash": "hash-2",
            }
        ],
    )

    assert changed[0].discovery_status == "schema_changed"
    assert changed[0].schema_hash == "hash-2"

    removed_count = repositories.mcp_tools.mark_removed_missing(
        "mcp-server-a",
        seen_raw_names=["create_issue"],
    )
    removed = repositories.mcp_tools.get_by_raw_name("mcp-server-a", "list_issues")

    assert removed_count == 1
    assert removed is not None
    assert removed.discovery_status == "removed"
    assert removed.removed_at is not None

    with repositories.db.transaction() as conn:
        conn.execute(
            """
            insert into mcp_tool_policies (
              id, server_id, raw_tool_name, enabled, updated_at
            ) values (
              'policy-create', 'mcp-server-a', 'create_issue', 0,
              '2026-07-06T00:00:00Z'
            )
            """
        )

    assert [tool.raw_name for tool in repositories.mcp_tools.list_by_server(
        "mcp-server-a",
        enabled=False,
    )] == ["create_issue"]
    assert [tool.raw_name for tool in repositories.mcp_tools.list_by_server(
        "mcp-server-a",
        enabled=True,
    )] == ["list_issues"]


def test_mcp_session_tool_usage_records_recent_success_by_session(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    repositories.mcp_servers.create(
        server_id="mcp-server-a",
        name="Local MCP",
        transport="stdio",
        command="node",
    )

    repositories.mcp_session_tool_usage.record_success(
        session_id="session-a",
        server_id="mcp-server-a",
        raw_tool_name="list_issues",
        model_name="mcp__local__list_issues",
    )
    latest = repositories.mcp_session_tool_usage.record_success(
        session_id="session-a",
        server_id="mcp-server-a",
        raw_tool_name="create_issue",
        model_name="mcp__local__create_issue",
    )
    repeated = repositories.mcp_session_tool_usage.record_success(
        session_id="session-a",
        server_id="mcp-server-a",
        raw_tool_name="create_issue",
        model_name="mcp__local__create_issue",
    )
    repositories.mcp_session_tool_usage.record_success(
        session_id="session-b",
        server_id="mcp-server-a",
        raw_tool_name="delete_issue",
        model_name="mcp__local__delete_issue",
    )

    assert latest.success_count == 1
    assert repeated.success_count == 2
    assert repositories.mcp_session_tool_usage.list_recent_model_names("session-a") == [
        "mcp__local__create_issue",
        "mcp__local__list_issues",
    ]
    assert repositories.mcp_session_tool_usage.list_recent_model_names("session-b") == [
        "mcp__local__delete_issue"
    ]


def test_mcp_resource_repositories_upsert_reserved_records(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    repositories.mcp_servers.create(
        server_id="mcp-server-a",
        name="Local MCP",
        transport="stdio",
        command="node",
    )

    resources = repositories.mcp_resources.upsert_resources(
        "mcp-server-a",
        [
            {
                "id": "resource-a",
                "uri": "file:///reserved",
                "name": "Reserved",
                "meta": {"capability": "resources"},
            }
        ],
    )
    templates = repositories.mcp_resources.upsert_templates(
        "mcp-server-a",
        [
            {
                "id": "template-a",
                "uri_template": "file:///{path}",
                "name": "Reserved template",
            }
        ],
    )

    assert resources[0].reserved_only is True
    assert resources[0].meta == {"capability": "resources"}
    assert templates[0].reserved_only is True
    assert templates[0].uri_template == "file:///{path}"


def test_mcp_tool_policy_repository_bulk_update(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    repositories.mcp_servers.create(
        server_id="mcp-server-a",
        name="Local MCP",
        transport="stdio",
        command="node",
    )

    with pytest.raises(ValueError, match="approval_mode"):
        repositories.mcp_tool_policies.bulk_update(
            "mcp-server-a",
            [
                {"raw_tool_name": "create_issue", "enabled": False},
                {"raw_tool_name": "delete_issue", "approval_mode": "always"},
            ],
        )

    assert repositories.mcp_tool_policies.list_by_server("mcp-server-a") == []

    policies = repositories.mcp_tool_policies.bulk_update(
        "mcp-server-a",
        [
            {
                "raw_tool_name": "create_issue",
                "enabled": False,
                "priority_available": True,
                "approval_mode": "prompt",
                "parameter_constraints": {"title": {"maxLength": 120}},
            },
            {
                "raw_tool_name": "list_issues",
                "enabled": True,
                "approval_mode": "auto",
                "schema_change_action": "keep_enabled",
            },
        ],
    )

    assert [policy.raw_tool_name for policy in policies] == ["create_issue", "list_issues"]
    create_policy = repositories.mcp_tool_policies.get("mcp-server-a", "create_issue")
    assert create_policy is not None
    assert create_policy.enabled is False
    assert create_policy.priority_available is True
    assert create_policy.approval_mode == "prompt"
    assert create_policy.parameter_constraints == {"title": {"maxLength": 120}}

def test_mcp_session_override_snapshot_trust_and_audit_repositories(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    repositories.mcp_servers.create(
        server_id="mcp-server-a",
        name="Local MCP",
        transport="stdio",
        command="node",
    )

    disabled = repositories.mcp_session_tool_overrides.set(
        session_id="session-a",
        server_id="mcp-server-a",
        raw_tool_name="create_issue",
        enabled=False,
        reason="user disabled",
    )
    enabled = repositories.mcp_session_tool_overrides.set(
        session_id="session-a",
        server_id="mcp-server-a",
        raw_tool_name="create_issue",
        enabled=True,
        reason="user enabled",
    )

    assert disabled.id == enabled.id
    assert enabled.enabled is True
    assert enabled.reason == "user enabled"
    assert repositories.mcp_session_tool_overrides.list_by_session("session-a") == [enabled]

    snapshot = repositories.mcp_runtime_snapshots.save(
        snapshot_id="snapshot-a",
        session_id="session-a",
        turn_id="turn-a",
        tool_inventory_revision=1,
        visible_tools=[{"model_name": "mcp__local__create_issue"}],
        server_status={"mcp-server-a": "online"},
        policy_summary={"approval": "auto"},
        capability_directory=[
            {
                "server_id": "mcp-server-a",
                "server_name": "Local MCP",
                "status": "online",
                "available_tool_count": 1,
            }
        ],
        direct_available_tools=1,
        on_demand_tools=0,
        unavailable_tools=2,
    )

    assert snapshot.visible_tools == [{"model_name": "mcp__local__create_issue"}]
    assert snapshot.capability_directory == [
        {
            "server_id": "mcp-server-a",
            "server_name": "Local MCP",
            "status": "online",
            "available_tool_count": 1,
        }
    ]
    assert snapshot.direct_available_tools == 1
    assert snapshot.on_demand_tools == 0
    assert snapshot.unavailable_tools == 2
    assert repositories.mcp_runtime_snapshots.list_by_session(
        "session-a",
        turn_id="turn-a",
    ) == [snapshot]

    legacy_summary_snapshot = repositories.mcp_runtime_snapshots.save(
        snapshot_id="snapshot-legacy-summary",
        session_id="session-a",
        tool_inventory_revision=1,
        visible_tools=[],
        server_status={},
        policy_summary={
            "capability_directory": [{"server_id": "legacy"}],
            "direct_available_tools": 9,
            "on_demand_tools": 8,
            "unavailable_tools": 7,
        },
    )

    assert legacy_summary_snapshot.capability_directory == []
    assert legacy_summary_snapshot.direct_available_tools == 0
    assert legacy_summary_snapshot.on_demand_tools == 0
    assert legacy_summary_snapshot.unavailable_tools == 0

    trust = repositories.mcp_trust_rules.create(
        rule_id="trust-a",
        server_id="mcp-server-a",
        raw_tool_name="create_issue",
        rule_kind="tool",
        scope="session",
        session_id="session-a",
        approval_mode="approve",
        condition={"args_hash": "abc"},
    )
    hit = repositories.mcp_trust_rules.touch_hit(trust.id)

    assert hit is not None
    assert hit.hit_count == 1
    assert hit.last_hit_at is not None
    assert repositories.mcp_trust_rules.list(scope="session", session_id="session-a") == [hit]

    repositories.mcp_audit_log.append(
        audit_id="audit-a",
        event_type="tool.called",
        server_id="mcp-server-a",
        raw_tool_name="create_issue",
        session_id="session-a",
        status="success",
        summary="called tool",
        detail={"safe": True},
    )
    repositories.mcp_audit_log.append(
        audit_id="audit-b",
        event_type="server.refreshed",
        server_id="mcp-server-a",
        status="success",
    )

    tool_audits, total_tool_audits = repositories.mcp_audit_log.list(event_type="tool.called")
    server_audits, total_server_audits = repositories.mcp_audit_log.list(
        server_id="mcp-server-a",
        limit=1,
    )
    success_audits, total_success_audits = repositories.mcp_audit_log.list(
        server_id="mcp-server-a",
        status="success",
    )

    assert total_tool_audits == 1
    assert tool_audits[0].detail == {"safe": True}
    assert total_server_audits == 2
    assert len(server_audits) == 1
    assert total_success_audits == 2
    assert {audit.id for audit in success_audits} == {"audit-a", "audit-b"}

    assert repositories.mcp_session_tool_overrides.delete(
        "session-a",
        "mcp-server-a",
        "create_issue",
    ) is True
    assert repositories.mcp_trust_rules.delete(trust.id) is True


def test_mcp_runtime_snapshot_rejects_malformed_json_shapes(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    with repositories.db.transaction() as conn:
        conn.execute(
            """
            insert into mcp_runtime_snapshots (
              id, session_id, tool_inventory_revision, visible_tools_json,
              server_status_json, policy_summary_json, capability_directory_json,
              created_at
            ) values (
              'snapshot-bad-visible', 'session-a', 1, '{}',
              '{}', '{}', '[]', '2026-07-08T00:00:00Z'
            )
            """
        )
        conn.execute(
            """
            insert into mcp_runtime_snapshots (
              id, session_id, tool_inventory_revision, visible_tools_json,
              server_status_json, policy_summary_json, capability_directory_json,
              created_at
            ) values (
              'snapshot-bad-directory', 'session-a', 1, '[]',
              '{}', '{}', '{}', '2026-07-08T00:00:00Z'
            )
            """
        )

    with pytest.raises(ValueError, match="visible_tools_json 必须是 JSON 数组"):
        repositories.mcp_runtime_snapshots.get("snapshot-bad-visible")

    with pytest.raises(ValueError, match="capability_directory_json 必须是 JSON 数组"):
        repositories.mcp_runtime_snapshots.get("snapshot-bad-directory")
