from __future__ import annotations

import json
import sqlite3

import pytest

from backend.app.storage import init_database


def _table_names(db_path) -> set[str]:
    db = init_database(db_path)
    with db.connect() as conn:
        rows = conn.execute(
            "select name from sqlite_master where type = 'table' and name not like 'sqlite_%'"
        ).fetchall()
    return {str(row["name"]) for row in rows}


def test_init_database_creates_core_tables_idempotently(tmp_path) -> None:
    db_path = tmp_path / "app.db"

    first = _table_names(db_path)
    second = _table_names(db_path)

    expected = {
        "settings",
        "web_settings",
        "web_provider_configs",
        "model_providers",
        "model_defaults",
        "mcp_servers",
        "mcp_server_status",
        "mcp_tools",
        "mcp_tool_policies",
        "mcp_session_tool_usage",
        "mcp_resources",
        "mcp_resource_templates",
        "mcp_oauth_tokens",
        "mcp_trust_rules",
        "mcp_session_tool_overrides",
        "mcp_runtime_snapshots",
        "mcp_audit_log",
        "workspaces",
        "workspace_annotations",
        "sessions",
        "session_forks",
        "message_events",
        "a2ui_interactions",
        "compression_staging",
        "trace_record",
        "llm_request_logs",
        "trace_event_log",
        "file_history_session_state",
        "file_history_snapshots",
        "file_history_snapshot_entries",
        "file_history_tracked_files",
        "file_history_mutations",
        "file_history_path_heads",
        "file_history_operations",
        "file_history_operation_files",
        "file_history_locks",
    }
    assert expected.issubset(first)
    assert expected.issubset(second)


def test_init_database_creates_default_web_settings_idempotently(tmp_path) -> None:
    db_path = tmp_path / "app.db"
    db = init_database(db_path)
    with db.connect() as conn:
        default_row = conn.execute("select * from web_settings where id = 1").fetchone()
        conn.execute(
            "update web_settings set enabled = 1, active_provider_id = 'provider-b' where id = 1"
        )

    db.init_schema()
    with db.connect() as conn:
        preserved = conn.execute("select * from web_settings where id = 1").fetchone()

    assert default_row is not None
    assert default_row["enabled"] == 0
    assert default_row["active_provider_id"] == "tavily"
    assert preserved["enabled"] == 1
    assert preserved["active_provider_id"] == "provider-b"


def test_init_database_adds_web_tables_to_existing_database(tmp_path) -> None:
    db_path = tmp_path / "legacy.db"
    with sqlite3.connect(db_path) as conn:
        conn.execute(
            "create table settings ("
            "key text primary key, value_json text not null, updated_at text not null)"
        )
        conn.execute(
            "insert into settings values ('legacy', '{\"kept\":true}', '2026-07-15T00:00:00Z')"
        )

    db = init_database(db_path)
    with db.connect() as conn:
        web_tables = {
            row["name"]
            for row in conn.execute(
                "select name from sqlite_master where type = 'table' and name like 'web_%'"
            ).fetchall()
        }
        legacy = conn.execute("select value_json from settings where key = 'legacy'").fetchone()

    assert web_tables == {"web_settings", "web_provider_configs"}
    assert legacy["value_json"] == '{"kept":true}'


def test_web_provider_config_schema_enforces_unique_provider_and_default_json(tmp_path) -> None:
    db = init_database(tmp_path / "app.db")
    with db.connect() as conn:
        conn.execute(
            "insert into web_provider_configs "
            "(provider_id, created_at, updated_at) values (?, ?, ?)",
            ("tavily", "2026-07-15T00:00:00Z", "2026-07-15T00:00:00Z"),
        )
        row = conn.execute(
            "select config_json, secrets_json from web_provider_configs "
            "where provider_id = 'tavily'"
        ).fetchone()
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "insert into web_provider_configs "
                "(provider_id, created_at, updated_at) values (?, ?, ?)",
                ("tavily", "2026-07-15T00:00:00Z", "2026-07-15T00:00:00Z"),
            )

    assert row["config_json"] == "{}"
    assert row["secrets_json"] == "{}"


def test_init_database_replaces_legacy_workspace_annotations_schema(tmp_path) -> None:
    db_path = tmp_path / "app.db"
    with sqlite3.connect(db_path) as conn:
        conn.executescript(
            """
            create table workspace_file_annotations (
              id text primary key,
              scope_type text not null,
              scope_id text not null,
              path text not null,
              anchor_type text not null,
              comment text not null,
              created_at text not null,
              updated_at text not null
            );
            insert into workspace_file_annotations (
              id, scope_type, scope_id, path, anchor_type, comment, created_at, updated_at
            ) values (
              'legacy-ann', 'workspace', 'workspace-1', 'README.md', 'file', 'Legacy',
              '2026-07-11T00:00:00Z', '2026-07-11T00:00:00Z'
            );
            """
        )

    db = init_database(db_path)
    with db.connect() as conn:
        tables = {
            str(row["name"])
            for row in conn.execute(
                "select name from sqlite_master where type = 'table' and name not like 'sqlite_%'"
            ).fetchall()
        }
        columns = {
            str(row["name"])
            for row in conn.execute("pragma table_info(workspace_annotations)").fetchall()
        }
        indexes = {
            str(row["name"])
            for row in conn.execute("pragma index_list(workspace_annotations)").fetchall()
        }

    assert "workspace_file_annotations" not in tables
    assert columns == {
        "id",
        "workspace_id",
        "document_path",
        "target_type",
        "selector_json",
        "body",
        "created_at",
        "updated_at",
    }
    assert "idx_workspace_annotations_document" in indexes


def test_workspace_annotations_schema_enforces_target_shape_and_workspace_cascade(
    tmp_path,
) -> None:
    db = init_database(tmp_path / "app.db")
    with db.connect() as conn:
        conn.execute(
            """
            insert into workspaces (
              id, name, root_path, normalized_root_path, created_at, updated_at
            ) values (
              'workspace-1', 'Workspace', '/tmp/workspace', '/tmp/workspace',
              '2026-07-11T00:00:00Z', '2026-07-11T00:00:00Z'
            )
            """
        )
        conn.execute(
            """
            insert into workspace_annotations (
              id, workspace_id, document_path, target_type, selector_json, body,
              created_at, updated_at
            ) values (
              'document-ann', 'workspace-1', 'README.md', 'document', null, 'Whole file',
              '2026-07-11T00:00:00Z', '2026-07-11T00:00:00Z'
            )
            """
        )
        conn.execute(
            """
            insert into workspace_annotations (
              id, workspace_id, document_path, target_type, selector_json, body,
              created_at, updated_at
            ) values (
              'text-ann', 'workspace-1', 'README.md', 'text', '{}', 'Selected text',
              '2026-07-11T00:00:01Z', '2026-07-11T00:00:01Z'
            )
            """
        )

        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                """
                insert into workspace_annotations (
                  id, workspace_id, document_path, target_type, selector_json, body,
                  created_at, updated_at
                ) values (
                  'bad-document', 'workspace-1', 'README.md', 'document', '{}', 'Bad',
                  '2026-07-11T00:00:02Z', '2026-07-11T00:00:02Z'
                )
                """
            )
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                """
                insert into workspace_annotations (
                  id, workspace_id, document_path, target_type, selector_json, body,
                  created_at, updated_at
                ) values (
                  'bad-text', 'workspace-1', 'README.md', 'text', null, 'Bad',
                  '2026-07-11T00:00:03Z', '2026-07-11T00:00:03Z'
                )
                """
            )

        conn.execute("delete from workspaces where id = 'workspace-1'")
        remaining = conn.execute("select count(*) from workspace_annotations").fetchone()

    assert remaining is not None
    assert remaining[0] == 0


def test_database_connections_use_busy_timeout_and_wal(tmp_path) -> None:
    db = init_database(tmp_path / "app.db")

    with db.connect() as conn:
        busy_timeout = conn.execute("pragma busy_timeout").fetchone()
        journal_mode = conn.execute("pragma journal_mode").fetchone()

    assert busy_timeout is not None
    assert busy_timeout[0] >= 30000
    assert journal_mode is not None
    assert str(journal_mode[0]).lower() == "wal"


def test_file_history_schema_is_idempotent_and_supports_restore_results(tmp_path) -> None:
    db_path = tmp_path / "app.db"
    db = init_database(db_path)
    init_database(db_path)

    with db.connect() as conn:
        trace_columns = {
            str(row["name"]) for row in conn.execute("pragma table_info(trace_record)")
        }
        operation_indexes = {
            str(row["name"])
            for row in conn.execute("pragma index_list(file_history_operations)")
        }
        session_indexes = {
            str(row["name"])
            for row in conn.execute("pragma index_list(file_history_snapshots)")
        }

        conn.execute(
            """
            insert into sessions (
              id, user_id, scene_id, status, created_at, updated_at
            ) values ('session-file-history', 'user', 'scene', 'active', ?, ?)
            """,
            ("2026-07-14T00:00:00Z", "2026-07-14T00:00:00Z"),
        )
        conn.execute(
            """
            insert into file_history_snapshots (
              id, session_id, kind, sequence, workspace_root, workspace_identity,
              status, created_at, updated_at
            ) values (?, ?, 'restore_result', 1, ?, ?, 'ready', ?, ?)
            """,
            (
                "snapshot-restore-result",
                "session-file-history",
                str(tmp_path),
                str(tmp_path).casefold(),
                "2026-07-14T00:00:01Z",
                "2026-07-14T00:00:01Z",
            ),
        )
        conn.execute(
            """
            insert into file_history_session_state (
              session_id, active_snapshot_id, next_sequence, state,
              created_at, updated_at
            ) values (?, ?, 2, 'blocked', ?, ?)
            """,
            (
                "session-file-history",
                "snapshot-restore-result",
                "2026-07-14T00:00:02Z",
                "2026-07-14T00:00:02Z",
            ),
        )
        row = conn.execute(
            "select active_snapshot_id, next_sequence, state from file_history_session_state"
        ).fetchone()

    assert {"input_file_snapshot_id", "input_file_snapshot_status"}.issubset(trace_columns)
    assert {
        "idx_file_history_operations_session_created",
        "idx_file_history_operations_state",
        "idx_file_history_operations_target",
    }.issubset(operation_indexes)
    assert {
        "idx_file_history_snapshots_session_status_sequence",
        "idx_file_history_snapshots_trace",
        "idx_file_history_snapshots_parent",
    }.issubset(session_indexes)
    assert row is not None
    assert dict(row) == {
        "active_snapshot_id": "snapshot-restore-result",
        "next_sequence": 2,
        "state": "blocked",
    }


def test_init_database_creates_mcp_server_schema_and_constraints(tmp_path) -> None:
    db = init_database(tmp_path / "app.db")

    with db.connect() as conn:
        server_columns = {
            str(row["name"]) for row in conn.execute("pragma table_info(mcp_servers)").fetchall()
        }
        status_columns = {
            str(row["name"])
            for row in conn.execute("pragma table_info(mcp_server_status)").fetchall()
        }
        server_indexes = {
            str(row["name"]) for row in conn.execute("pragma index_list(mcp_servers)").fetchall()
        }
        status_indexes = {
            str(row["name"])
            for row in conn.execute("pragma index_list(mcp_server_status)").fetchall()
        }

        conn.execute(
            """
            insert into mcp_servers (
              id, name, transport, command, created_at, updated_at
            ) values (
              'mcp-server-1', 'Local MCP', 'stdio', 'node',
              '2026-07-06T00:00:00Z', '2026-07-06T00:00:00Z'
            )
            """
        )
        conn.execute(
            """
            insert into mcp_server_status (
              server_id, status, capabilities_json, server_info_json, updated_at
            ) values (
              'mcp-server-1', 'online', '{"tools":true}', '{"name":"mock"}',
              '2026-07-06T00:00:00Z'
            )
            """
        )
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                """
                insert into mcp_servers (
                  id, name, transport, created_at, updated_at
                ) values (
                  'mcp-server-bad-transport', 'Bad Transport', 'websocket',
                  '2026-07-06T00:00:00Z', '2026-07-06T00:00:00Z'
                )
                """
            )
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                """
                insert into mcp_server_status (server_id, status, updated_at)
                values ('mcp-server-1', 'waiting', '2026-07-06T00:00:01Z')
                """
            )

    assert {
        "id",
        "name",
        "description",
        "enabled",
        "required",
        "transport",
        "command",
        "args_json",
        "cwd",
        "inherit_environment",
        "env_json",
        "url",
        "sse_url",
        "message_url",
        "headers_json",
        "env_headers_json",
        "bearer_token_env_var",
        "auth_type",
        "secret_refs_json",
        "oauth_config_json",
        "oauth_resource",
        "oauth_scopes_json",
        "startup_timeout_sec",
        "tool_timeout_sec",
        "read_timeout_sec",
        "sse_read_timeout_sec",
        "shutdown_timeout_sec",
        "restart_policy",
        "connect_mode",
        "auto_refresh",
        "refresh_interval_sec",
        "default_tool_exposure_mode",
        "default_tool_approval_mode",
        "supports_parallel_tool_calls",
        "elicitation_enabled",
        "sampling_enabled",
        "resource_reserved_policy_json",
        "created_at",
        "updated_at",
    }.issubset(server_columns)
    assert "workspace_id" not in server_columns
    assert "project_id" not in server_columns
    assert {
        "server_id",
        "status",
        "capabilities_json",
        "server_info_json",
        "last_connected_at",
        "last_refresh_at",
        "last_refresh_revision",
        "last_error_code",
        "last_error_message",
        "last_error_detail_json",
        "tools_count",
        "resources_reserved_count",
        "updated_at",
    }.issubset(status_columns)
    assert {
        "idx_mcp_servers_enabled",
        "idx_mcp_servers_transport",
    }.issubset(server_indexes)
    assert {
        "idx_mcp_server_status_status",
        "idx_mcp_server_status_last_refresh",
    }.issubset(status_indexes)


def test_init_database_removes_legacy_mcp_prompt_schema(tmp_path) -> None:
    db_path = tmp_path / "app.db"
    init_database(db_path)
    with sqlite3.connect(db_path) as conn:
        conn.execute("alter table mcp_servers add column prompt_discovery_enabled integer")
        conn.execute("alter table mcp_server_status add column prompts_count integer")
        conn.execute("alter table mcp_audit_log add column prompt_name text")
        conn.execute("create table mcp_prompts (id text primary key)")
        conn.execute("create table mcp_prompt_policies (id text primary key)")

    db = init_database(db_path)
    with db.connect() as conn:
        tables = {
            str(row["name"])
            for row in conn.execute(
                "select name from sqlite_master where type = 'table' and name not like 'sqlite_%'"
            ).fetchall()
        }
        server_columns = {
            str(row["name"]) for row in conn.execute("pragma table_info(mcp_servers)").fetchall()
        }
        status_columns = {
            str(row["name"])
            for row in conn.execute("pragma table_info(mcp_server_status)").fetchall()
        }
        audit_columns = {
            str(row["name"]) for row in conn.execute("pragma table_info(mcp_audit_log)").fetchall()
        }

    assert "mcp_prompts" not in tables
    assert "mcp_prompt_policies" not in tables
    assert "prompt_discovery_enabled" not in server_columns
    assert "prompts_count" not in status_columns
    assert "prompt_name" not in audit_columns


def test_init_database_normalizes_legacy_mcp_refreshing_status(tmp_path) -> None:
    db_path = tmp_path / "app.db"
    db = init_database(db_path)
    with db.connect() as conn:
        conn.execute(
            """
            insert into mcp_servers (id, name, transport, url, created_at, updated_at)
            values ('mcp-legacy-refreshing', 'Legacy MCP', 'streamable_http',
                    'https://mcp.example.test/mcp', '2026-07-15T00:00:00Z',
                    '2026-07-15T00:00:00Z')
            """
        )
        conn.execute(
            """
            insert into mcp_server_status (server_id, status, updated_at)
            values ('mcp-legacy-refreshing', 'refreshing', '2026-07-15T00:00:00Z')
            """
        )

    migrated = init_database(db_path)

    with migrated.connect() as conn:
        row = conn.execute(
            "select status from mcp_server_status where server_id = ?",
            ("mcp-legacy-refreshing",),
        ).fetchone()
    assert row is not None
    assert row["status"] == "unknown"


def test_init_database_removes_legacy_mcp_risk_schema(tmp_path) -> None:
    db_path = tmp_path / "app.db"
    init_database(db_path)
    with sqlite3.connect(db_path) as conn:
        conn.execute("alter table mcp_tools add column risk_level text")
        conn.execute("create index idx_mcp_tools_risk on mcp_tools(risk_level)")
        conn.execute("alter table mcp_tool_policies add column risk_override text")

    db = init_database(db_path)
    with db.connect() as conn:
        tool_columns = {
            str(row["name"]) for row in conn.execute("pragma table_info(mcp_tools)").fetchall()
        }
        tool_policy_columns = {
            str(row["name"])
            for row in conn.execute("pragma table_info(mcp_tool_policies)").fetchall()
        }
        tool_indexes = {
            str(row["name"]) for row in conn.execute("pragma index_list(mcp_tools)").fetchall()
        }

    assert "risk_level" not in tool_columns
    assert "risk_override" not in tool_policy_columns
    assert "idx_mcp_tools_risk" not in tool_indexes


def test_init_database_creates_mcp_discovery_schema_and_constraints(tmp_path) -> None:
    db = init_database(tmp_path / "app.db")

    with db.connect() as conn:
        tool_columns = {
            str(row["name"]) for row in conn.execute("pragma table_info(mcp_tools)").fetchall()
        }
        resource_columns = {
            str(row["name"]) for row in conn.execute("pragma table_info(mcp_resources)").fetchall()
        }
        template_columns = {
            str(row["name"])
            for row in conn.execute("pragma table_info(mcp_resource_templates)").fetchall()
        }
        tool_indexes = {
            str(row["name"]) for row in conn.execute("pragma index_list(mcp_tools)").fetchall()
        }

        for server_id, name in (("server-a", "Server A"), ("server-b", "Server B")):
            conn.execute(
                """
                insert into mcp_servers (
                  id, name, transport, command, created_at, updated_at
                ) values (?, ?, 'stdio', 'node', ?, ?)
                """,
                (server_id, name, "2026-07-06T00:00:00Z", "2026-07-06T00:00:00Z"),
            )
        conn.execute(
            """
            insert into mcp_tools (
              id, server_id, raw_name, model_name, callable_namespace, callable_name,
              input_schema_json, schema_hash, first_seen_at, last_seen_at
            ) values (
              'tool-a', 'server-a', 'create_issue', 'mcp__a__create_issue',
              'mcp__a', 'create_issue', '{}', 'hash-a',
              '2026-07-06T00:00:00Z', '2026-07-06T00:00:00Z'
            )
            """
        )
        conn.execute(
            """
            insert into mcp_tools (
              id, server_id, raw_name, model_name, callable_namespace, callable_name,
              input_schema_json, schema_hash, first_seen_at, last_seen_at
            ) values (
              'tool-b', 'server-b', 'create_issue', 'mcp__b__create_issue',
              'mcp__b', 'create_issue', '{}', 'hash-b',
              '2026-07-06T00:00:00Z', '2026-07-06T00:00:00Z'
            )
            """
        )
        conn.execute(
            """
            insert into mcp_resources (id, server_id, uri)
            values ('resource-a', 'server-a', 'file:///reserved')
            """
        )
        conn.execute(
            """
            insert into mcp_resource_templates (id, server_id, uri_template)
            values ('resource-template-a', 'server-a', 'file:///{path}')
            """
        )
        resource = conn.execute(
            "select reserved_only from mcp_resources where id = 'resource-a'"
        ).fetchone()
        template = conn.execute(
            "select reserved_only from mcp_resource_templates where id = 'resource-template-a'"
        ).fetchone()

        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                """
                insert into mcp_tools (
                  id, server_id, raw_name, model_name, callable_namespace, callable_name,
                  input_schema_json, schema_hash, first_seen_at, last_seen_at
                ) values (
                  'tool-a-duplicate-raw', 'server-a', 'create_issue',
                  'mcp__a__create_issue_2', 'mcp__a', 'create_issue_2', '{}', 'hash-c',
                  '2026-07-06T00:00:00Z', '2026-07-06T00:00:00Z'
                )
                """
            )
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                """
                insert into mcp_tools (
                  id, server_id, raw_name, model_name, callable_namespace, callable_name,
                  input_schema_json, schema_hash, first_seen_at, last_seen_at
                ) values (
                  'tool-duplicate-model', 'server-b', 'close_issue',
                  'mcp__a__create_issue', 'mcp__b', 'close_issue', '{}', 'hash-d',
                  '2026-07-06T00:00:00Z', '2026-07-06T00:00:00Z'
                )
                """
            )
    assert {
        "id",
        "server_id",
        "raw_name",
        "model_name",
        "callable_namespace",
        "callable_name",
        "display_name",
        "description",
        "input_schema_json",
        "annotations_json",
        "meta_json",
        "schema_hash",
        "discovery_status",
        "first_seen_at",
        "last_seen_at",
        "removed_at",
        "last_used_at",
        "call_count",
        "failure_count",
    }.issubset(tool_columns)
    assert {
        "id",
        "server_id",
        "uri",
        "name",
        "description",
        "mime_type",
        "meta_json",
        "last_seen_at",
        "reserved_only",
    }.issubset(resource_columns)
    assert {
        "id",
        "server_id",
        "uri_template",
        "name",
        "description",
        "mime_type",
        "meta_json",
        "last_seen_at",
        "reserved_only",
    }.issubset(template_columns)
    assert {
        "idx_mcp_tools_server",
        "idx_mcp_tools_status",
    }.issubset(tool_indexes)
    assert resource is not None
    assert resource["reserved_only"] == 1
    assert template is not None
    assert template["reserved_only"] == 1


def test_init_database_creates_mcp_policy_runtime_oauth_and_audit_schema(tmp_path) -> None:
    db = init_database(tmp_path / "app.db")

    with db.connect() as conn:
        conn.execute(
            """
            insert into mcp_servers (
              id, name, transport, command, created_at, updated_at
            ) values (
              'server-a', 'Server A', 'stdio', 'node',
              '2026-07-06T00:00:00Z', '2026-07-06T00:00:00Z'
            )
            """
        )
        tool_policy_columns = {
            str(row["name"])
            for row in conn.execute("pragma table_info(mcp_tool_policies)").fetchall()
        }
        oauth_columns = {
            str(row["name"])
            for row in conn.execute("pragma table_info(mcp_oauth_tokens)").fetchall()
        }
        trust_columns = {
            str(row["name"])
            for row in conn.execute("pragma table_info(mcp_trust_rules)").fetchall()
        }
        override_columns = {
            str(row["name"])
            for row in conn.execute("pragma table_info(mcp_session_tool_overrides)").fetchall()
        }
        usage_columns = {
            str(row["name"])
            for row in conn.execute("pragma table_info(mcp_session_tool_usage)").fetchall()
        }
        snapshot_columns = {
            str(row["name"])
            for row in conn.execute("pragma table_info(mcp_runtime_snapshots)").fetchall()
        }
        audit_columns = {
            str(row["name"]) for row in conn.execute("pragma table_info(mcp_audit_log)").fetchall()
        }
        indexes = {
            str(row["name"])
            for table in (
                "mcp_tool_policies",
                "mcp_oauth_tokens",
                "mcp_trust_rules",
                "mcp_session_tool_overrides",
                "mcp_session_tool_usage",
                "mcp_runtime_snapshots",
                "mcp_audit_log",
            )
            for row in conn.execute(f"pragma index_list({table})").fetchall()
        }

        conn.execute(
            """
            insert into mcp_tool_policies (
              id, server_id, raw_tool_name, approval_mode, updated_at
            ) values (
              'tool-policy-a', 'server-a', 'create_issue', 'prompt',
              '2026-07-06T00:00:00Z'
            )
            """
        )
        conn.execute(
            """
            insert into mcp_oauth_tokens (
              id, server_id, account_label, token_ref, refresh_token_ref, status,
              created_at, updated_at
            ) values (
              'oauth-a', 'server-a', 'test-account', 'secret:mcp/token',
              'secret:mcp/refresh', 'active',
              '2026-07-06T00:00:00Z', '2026-07-06T00:00:00Z'
            )
            """
        )
        conn.execute(
            """
            insert into mcp_trust_rules (
              id, server_id, raw_tool_name, rule_kind, scope, session_id,
              approval_mode, created_at, updated_at
            ) values (
              'trust-a', 'server-a', 'create_issue', 'tool', 'session',
              'session-a', 'approve',
              '2026-07-06T00:00:00Z', '2026-07-06T00:00:00Z'
            )
            """
        )
        conn.execute(
            """
            insert into mcp_session_tool_overrides (
              id, session_id, server_id, raw_tool_name, enabled, created_at
            ) values (
              'override-a', 'session-a', 'server-a', 'create_issue', 0,
              '2026-07-06T00:00:00Z'
            )
            """
        )
        conn.execute(
            """
            insert into mcp_session_tool_usage (
              session_id, server_id, raw_tool_name, model_name,
              success_count, last_success_at
            ) values (
              'session-a', 'server-a', 'create_issue', 'mcp__server_a__create_issue',
              1, '2026-07-06T00:00:00Z'
            )
            """
        )
        conn.execute(
            """
            insert into mcp_runtime_snapshots (
              id, session_id, turn_id, tool_inventory_revision,
              visible_tools_json, server_status_json, policy_summary_json, created_at
            ) values (
              'snapshot-a', 'session-a', 'turn-a', 1, '[]', '{}', '{}',
              '2026-07-06T00:00:00Z'
            )
            """
        )
        conn.execute(
            """
            insert into mcp_audit_log (
              id, event_type, server_id, raw_tool_name, session_id, status,
              summary, detail_json, created_at
            ) values (
              'audit-a', 'tool.called', 'server-a', 'create_issue', 'session-a',
              'success', 'called mock tool', '{}', '2026-07-06T00:00:00Z'
            )
            """
        )

        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                """
                insert into mcp_trust_rules (
                  id, rule_kind, scope, approval_mode, created_at, updated_at
                ) values (
                  'trust-bad-scope', 'tool', 'workspace', 'approve',
                  '2026-07-06T00:00:00Z', '2026-07-06T00:00:00Z'
                )
                """
            )
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                """
                insert into mcp_session_tool_overrides (
                  id, session_id, server_id, raw_tool_name, enabled, created_at
                ) values (
                  'override-duplicate', 'session-a', 'server-a', 'create_issue', 1,
                  '2026-07-06T00:00:01Z'
                )
                """
            )
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                """
                insert into mcp_oauth_tokens (
                  id, server_id, token_ref, status, created_at, updated_at
                ) values (
                  'oauth-bad', 'server-a', 'secret:mcp/token-2', 'pending',
                  '2026-07-06T00:00:00Z', '2026-07-06T00:00:00Z'
                )
                """
            )

    assert {
        "id",
        "server_id",
        "raw_tool_name",
        "enabled",
        "hidden",
        "priority_available",
        "approval_mode",
        "parameter_constraints_json",
        "schema_change_action",
        "updated_at",
    }.issubset(tool_policy_columns)
    assert {
        "id",
        "server_id",
        "account_label",
        "token_ref",
        "refresh_token_ref",
        "scopes_json",
        "expires_at",
        "status",
        "created_at",
        "updated_at",
    }.issubset(oauth_columns)
    assert "access_token" not in oauth_columns
    assert "refresh_token" not in oauth_columns
    assert {
        "id",
        "server_id",
        "raw_tool_name",
        "rule_kind",
        "scope",
        "session_id",
        "condition_json",
        "approval_mode",
        "hit_count",
        "created_from_approval_id",
        "expires_at",
        "last_hit_at",
        "created_at",
        "updated_at",
    }.issubset(trust_columns)
    assert {
        "id",
        "session_id",
        "server_id",
        "raw_tool_name",
        "enabled",
        "reason",
        "created_at",
        "expires_at",
    }.issubset(override_columns)
    assert {
        "session_id",
        "server_id",
        "raw_tool_name",
        "model_name",
        "success_count",
        "last_success_at",
    }.issubset(usage_columns)
    assert {
        "id",
        "session_id",
        "turn_id",
        "tool_inventory_revision",
        "visible_tools_json",
        "server_status_json",
        "policy_summary_json",
        "capability_directory_json",
        "direct_available_tools",
        "on_demand_tools",
        "unavailable_tools",
        "created_at",
    }.issubset(snapshot_columns)
    assert {
        "id",
        "event_type",
        "server_id",
        "raw_tool_name",
        "session_id",
        "turn_id",
        "call_id",
        "approval_id",
        "actor",
        "status",
        "duration_ms",
        "summary",
        "detail_json",
        "created_at",
    }.issubset(audit_columns)
    assert {
        "idx_mcp_tool_policies_server",
        "idx_mcp_oauth_tokens_server_status",
        "idx_mcp_trust_rules_server_tool",
        "idx_mcp_trust_rules_scope",
        "idx_mcp_session_tool_overrides_session",
        "idx_mcp_session_tool_usage_recent",
        "idx_mcp_runtime_snapshots_session_turn",
        "idx_mcp_audit_log_server_created",
        "idx_mcp_audit_log_session_created",
        "idx_mcp_audit_log_event_created",
    }.issubset(indexes)


def test_init_database_creates_workspace_schema_and_session_columns(tmp_path) -> None:
    db = init_database(tmp_path / "app.db")

    with db.connect() as conn:
        workspace_columns = {
            str(row["name"]) for row in conn.execute("pragma table_info(workspaces)").fetchall()
        }
        session_columns = {
            str(row["name"]) for row in conn.execute("pragma table_info(sessions)").fetchall()
        }
        workspace_indexes = {
            str(row["name"]) for row in conn.execute("pragma index_list(workspaces)").fetchall()
        }
        session_indexes = {
            str(row["name"]) for row in conn.execute("pragma index_list(sessions)").fetchall()
        }
        session_fork_columns = {
            str(row["name"]) for row in conn.execute("pragma table_info(session_forks)").fetchall()
        }
        session_fork_indexes = {
            str(row["name"]) for row in conn.execute("pragma index_list(session_forks)").fetchall()
        }

    assert {
        "id",
        "name",
        "root_path",
        "normalized_root_path",
        "type",
        "created_at",
        "updated_at",
        "last_opened_at",
        "is_deleted",
    }.issubset(workspace_columns)
    assert {
        "workspace_id",
        "session_type",
        "cwd",
        "workspace_roots_json",
        "context_compression_epoch",
        "pinned_at",
    }.issubset(session_columns)
    assert {
        "idx_workspaces_normalized_root_active",
        "idx_workspaces_last_opened",
        "idx_workspaces_deleted_updated",
    }.issubset(workspace_indexes)
    assert {
        "idx_sessions_workspace_id",
        "idx_sessions_session_type",
        "idx_sessions_workspace_updated",
        "idx_sessions_type_updated",
        "idx_sessions_pinned_at",
    }.issubset(session_indexes)
    assert {
        "source_session_id",
        "target_session_id",
        "source_message_event_id",
        "target_message_event_id",
        "source_turn_index",
        "target_turn_index",
        "source_checkpoint_id",
        "source_checkpoint_ns",
    }.issubset(session_fork_columns)
    assert {
        "idx_session_forks_target",
        "idx_session_forks_source_message",
        "idx_session_forks_target_message",
        "idx_session_forks_source_turn",
    }.issubset(session_fork_indexes)


def test_init_database_upgrades_legacy_session_schema_idempotently(tmp_path) -> None:
    db_path = tmp_path / "legacy.db"
    default_root = tmp_path / "keydex"
    default_root.mkdir()
    with sqlite3.connect(db_path) as conn:
        conn.executescript(
            """
            create table sessions (
              id text primary key,
              user_id text not null,
              scene_id text not null,
              scene_version_seq integer,
              status text not null,
              is_debug integer not null default 0,
              debug_type text,
              is_scheduled integer not null default 0,
              scheduled_task_id text,
              session_tag text not null default 'chat',
              active_session_id text,
              parent_session_id text,
              child_session_id text,
              source_trace_id text,
              source_active_session_id text,
              source_checkpoint_id text,
              source_checkpoint_ns text,
              title text,
              created_at text not null,
              updated_at text not null,
              is_deleted integer not null default 0
            );
            insert into sessions (
              id, user_id, scene_id, status, session_tag, active_session_id,
              title, created_at, updated_at
            ) values (
              'ses_legacy', 'local-user', 'desktop-agent', 'active', 'chat',
              'ses_legacy', '旧会话', '2026-06-18T00:00:00Z',
              '2026-06-18T00:00:00Z'
            );
            insert into sessions (
              id, user_id, scene_id, status, session_tag, active_session_id,
              title, created_at, updated_at
            ) values (
              'ses_pure', 'local-user', 'desktop-agent', 'active', 'pure_chat',
              'ses_pure', '纯聊天旧会话', '2026-06-18T00:00:00Z',
              '2026-06-18T00:00:00Z'
            );
            """
        )

    init_database(db_path, default_workspace_root=default_root)
    db = init_database(db_path, default_workspace_root=default_root)

    with db.connect() as conn:
        columns = {
            str(row["name"]) for row in conn.execute("pragma table_info(sessions)").fetchall()
        }
        row = conn.execute(
            """
            select workspace_id, session_type, cwd, workspace_roots_json
            from sessions
            where id = 'ses_legacy'
            """
        ).fetchone()
        pure_chat = conn.execute(
            """
            select workspace_id, session_type, cwd, workspace_roots_json
            from sessions
            where id = 'ses_pure'
            """
        ).fetchone()
        workspaces = conn.execute(
            "select id, name, root_path, normalized_root_path from workspaces"
        ).fetchall()

    assert {
        "workspace_id",
        "session_type",
        "cwd",
        "workspace_roots_json",
        "context_compression_epoch",
        "pinned_at",
    }.issubset(columns)
    assert row is not None
    assert len(workspaces) == 1
    assert workspaces[0]["name"] == "keydex"
    assert workspaces[0]["root_path"] == str(default_root.resolve())
    assert row["workspace_id"] == workspaces[0]["id"]
    assert row["session_type"] == "workspace"
    assert row["cwd"] == str(default_root.resolve())
    assert json.loads(row["workspace_roots_json"]) == [str(default_root.resolve())]
    assert pure_chat is not None
    assert pure_chat["workspace_id"] is None
    assert pure_chat["session_type"] == "chat"
    assert pure_chat["cwd"] is None
    assert pure_chat["workspace_roots_json"] == "[]"


def test_init_database_does_not_migrate_new_schema_pure_chat_sessions(tmp_path) -> None:
    db_path = tmp_path / "app.db"
    default_root = tmp_path / "keydex"
    default_root.mkdir()
    db = init_database(db_path, default_workspace_root=default_root)

    with db.connect() as conn:
        conn.execute(
            """
            insert into sessions (
              id, user_id, scene_id, status, session_tag, session_type,
              workspace_id, workspace_roots_json, title, created_at, updated_at
            ) values (
              'ses_chat', 'local-user', 'desktop-agent', 'active', 'chat',
              'chat', null, '[]', '新纯聊天',
              '2026-06-18T00:00:00Z', '2026-06-18T00:00:00Z'
            )
            """
        )

    init_database(db_path, default_workspace_root=default_root)

    with db.connect() as conn:
        row = conn.execute(
            """
            select workspace_id, session_type, cwd, workspace_roots_json
            from sessions
            where id = 'ses_chat'
            """
        ).fetchone()
        workspace_count = conn.execute("select count(*) as count from workspaces").fetchone()

    assert row is not None
    assert row["workspace_id"] is None
    assert row["session_type"] == "chat"
    assert row["cwd"] is None
    assert row["workspace_roots_json"] == "[]"
    assert workspace_count is not None
    assert workspace_count["count"] == 0


def test_init_database_creates_llm_request_log_columns_and_indexes(tmp_path) -> None:
    db = init_database(tmp_path / "app.db")

    with db.connect() as conn:
        columns = {
            str(row["name"])
            for row in conn.execute("pragma table_info(llm_request_logs)").fetchall()
        }
        indexes = {
            str(row["name"])
            for row in conn.execute("pragma index_list(llm_request_logs)").fetchall()
        }

    assert {
        "id",
        "trace_id",
        "trace_record_id",
        "session_id",
        "active_session_id",
        "gateway_thread_id",
        "gateway_trace_id",
        "turn_index",
        "provider_id",
        "provider_name",
        "model",
        "status",
        "start_time",
        "end_time",
        "duration_ms",
        "time_to_first_token",
        "input_tokens",
        "cache_read_tokens",
        "output_tokens",
        "total_tokens",
        "request_preview",
        "response_preview",
        "error_message",
        "metadata_json",
        "created_at",
        "updated_at",
        "is_deleted",
    }.issubset(columns)
    assert {
        "idx_llm_request_logs_time",
        "idx_llm_request_logs_trace",
        "idx_llm_request_logs_model_time",
        "idx_llm_request_logs_status_time",
        "idx_llm_request_logs_gateway_trace",
        "idx_llm_request_logs_gateway_thread_time",
    }.issubset(indexes)


def test_init_database_creates_compression_staging_schema(tmp_path) -> None:
    db = init_database(tmp_path / "app.db")

    with db.connect() as conn:
        columns = {
            str(row["name"])
            for row in conn.execute("pragma table_info(compression_staging)").fetchall()
        }
        indexes = {
            str(row["name"])
            for row in conn.execute("pragma index_list(compression_staging)").fetchall()
        }

    assert {
        "id",
        "original_session_id",
        "active_session_id",
        "target_session_id",
        "generation",
        "status",
        "staging_strategy",
        "anchor_message_id",
        "source_last_message_id",
        "l1_content",
        "l2_content",
        "failure_reason",
        "applied_at",
        "created_at",
        "updated_at",
        "is_deleted",
    }.issubset(columns)
    assert {
        "idx_compression_staging_original_status_target",
        "idx_compression_staging_original_generation",
    }.issubset(indexes)


def test_init_database_creates_a2ui_interactions_schema(tmp_path) -> None:
    db_path = tmp_path / "app.db"
    init_database(db_path)
    db = init_database(db_path)

    with db.connect() as conn:
        columns = {
            str(row["name"])
            for row in conn.execute("pragma table_info(a2ui_interactions)").fetchall()
        }
        indexes = {
            str(row["name"])
            for row in conn.execute("pragma index_list(a2ui_interactions)").fetchall()
        }

        conn.execute(
            """
            insert into a2ui_interactions (
              id, session_id, trace_id, turn_index, tool_call_id, stream_id,
              render_key, mode, payload_json, input_schema_json,
              submit_schema_snapshot_json, created_at, updated_at
            ) values (
              'a2ui-1', 'session-1', 'trace-1', 1, 'tool-call-1', 'stream-1',
              'confirm', 'interactive', '{}', '{}', '{}',
              '2026-07-08T00:00:00Z', '2026-07-08T00:00:00Z'
            )
            """
        )
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                """
                insert into a2ui_interactions (
                  id, session_id, turn_index, stream_id, render_key, mode,
                  status, created_at, updated_at
                ) values (
                  'a2ui-bad-status', 'session-1', 1, 'stream-bad', 'confirm',
                  'interactive', 'waiting', '2026-07-08T00:00:00Z',
                  '2026-07-08T00:00:00Z'
                )
                """
            )
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                """
                insert into a2ui_interactions (
                  id, session_id, turn_index, stream_id, render_key, mode,
                  resume_status, created_at, updated_at
                ) values (
                  'a2ui-bad-resume', 'session-1', 1, 'stream-bad-resume', 'confirm',
                  'interactive', 'running', '2026-07-08T00:00:00Z',
                  '2026-07-08T00:00:00Z'
                )
                """
            )

    assert {
        "id",
        "session_id",
        "trace_id",
        "active_session_id",
        "turn_index",
        "tool_call_id",
        "stream_id",
        "render_key",
        "mode",
        "payload_json",
        "input_schema_json",
        "submit_schema_snapshot_json",
        "status",
        "submit_request_id",
        "cancel_request_id",
        "submit_result_json",
        "cancel_reason",
        "langgraph_thread_id",
        "checkpoint_ns",
        "checkpoint_id",
        "interrupt_id",
        "resume_group_id",
        "resume_status",
        "resume_payload_json",
        "resume_error",
        "created_at",
        "updated_at",
        "submitted_at",
        "cancelled_at",
        "resume_started_at",
        "resume_finished_at",
        "is_deleted",
    }.issubset(columns)
    assert {
        "idx_a2ui_interactions_session_status",
        "idx_a2ui_interactions_session_turn",
        "idx_a2ui_interactions_resume_group",
        "idx_a2ui_interactions_tool_call",
        "idx_a2ui_interactions_session_tool_call_unique",
    }.issubset(indexes)


def test_init_database_creates_thread_task_schema(tmp_path) -> None:
    db = init_database(tmp_path / "app.db")

    with db.connect() as conn:
        task_columns = {
            str(row["name"]) for row in conn.execute("pragma table_info(thread_tasks)").fetchall()
        }
        run_columns = {
            str(row["name"])
            for row in conn.execute("pragma table_info(thread_task_runs)").fetchall()
        }
        task_indexes = {
            str(row["name"]) for row in conn.execute("pragma index_list(thread_tasks)").fetchall()
        }
        run_indexes = {
            str(row["name"])
            for row in conn.execute("pragma index_list(thread_task_runs)").fetchall()
        }

    assert {
        "id",
        "session_id",
        "type",
        "title",
        "objective",
        "status",
        "metadata_json",
        "evidence_json",
        "blocked_audit_json",
        "system_stop_reason",
        "current_run_id",
        "turn_count",
        "elapsed_seconds",
        "token_usage_json",
        "created_at",
        "updated_at",
        "deleted_at",
    }.issubset(task_columns)
    assert {
        "id",
        "task_id",
        "session_id",
        "turn_index",
        "trace_id",
        "status",
        "summary_json",
        "error_json",
        "started_at",
        "finished_at",
        "created_at",
        "updated_at",
    }.issubset(run_columns)
    assert {
        "idx_thread_tasks_session_updated",
        "idx_thread_tasks_session_status",
        "idx_thread_tasks_one_open_per_session",
    }.issubset(task_indexes)
    assert {
        "idx_thread_task_runs_task_started",
        "idx_thread_task_runs_session_started",
        "idx_thread_task_runs_status_started",
    }.issubset(run_indexes)


def test_thread_task_schema_enforces_status_and_single_open_task(tmp_path) -> None:
    db = init_database(tmp_path / "app.db")

    with db.connect() as conn:
        conn.execute(
            """
            insert into sessions (
              id, user_id, scene_id, status, created_at, updated_at
            ) values (
              'session-1', 'user-1', 'scene-1', 'idle',
              '2026-07-03T00:00:00Z', '2026-07-03T00:00:00Z'
            )
            """
        )
        conn.execute(
            """
            insert into thread_tasks (
              id, session_id, type, objective, status, created_at, updated_at
            ) values (
              'task-1', 'session-1', 'goal', 'finish the work', 'active',
              '2026-07-03T00:00:00Z', '2026-07-03T00:00:00Z'
            )
            """
        )
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                """
                insert into thread_tasks (
                  id, session_id, type, objective, status, created_at, updated_at
                ) values (
                  'task-2', 'session-1', 'goal', 'second open task', 'paused',
                  '2026-07-03T00:00:01Z', '2026-07-03T00:00:01Z'
                )
                """
            )
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                """
                insert into thread_tasks (
                  id, session_id, type, objective, status, created_at, updated_at
                ) values (
                  'task-bad', 'session-1', 'goal', 'invalid status', 'waiting',
                  '2026-07-03T00:00:02Z', '2026-07-03T00:00:02Z'
                )
                """
            )
        conn.execute(
            """
            update thread_tasks
            set status = 'complete',
                updated_at = '2026-07-03T00:00:03Z'
            where id = 'task-1'
            """
        )
        conn.execute(
            """
            insert into thread_tasks (
              id, session_id, type, objective, status, created_at, updated_at
            ) values (
              'task-3', 'session-1', 'goal', 'new open task', 'active',
              '2026-07-03T00:00:04Z', '2026-07-03T00:00:04Z'
            )
            """
        )
        conn.execute(
            """
            insert into thread_task_runs (
              id, task_id, session_id, status, started_at, created_at, updated_at
            ) values (
              'run-1', 'task-3', 'session-1', 'running',
              '2026-07-03T00:00:05Z', '2026-07-03T00:00:05Z', '2026-07-03T00:00:05Z'
            )
            """
        )
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                """
                insert into thread_task_runs (
                  id, task_id, session_id, status, started_at, created_at, updated_at
                ) values (
                  'run-bad', 'task-3', 'session-1', 'done',
                  '2026-07-03T00:00:06Z', '2026-07-03T00:00:06Z', '2026-07-03T00:00:06Z'
                )
                """
            )


def test_init_database_no_longer_creates_legacy_thread_turn_item_tables(tmp_path) -> None:
    tables = _table_names(tmp_path / "app.db")

    assert "threads" not in tables
    assert "turns" not in tables
    assert "items" not in tables
    assert "events" not in tables
    assert "approvals" not in tables


def test_database_transaction_commits_and_rolls_back(tmp_path) -> None:
    db = init_database(tmp_path / "app.db")

    with db.transaction() as conn:
        conn.execute(
            "insert into settings (key, value_json, updated_at) values (?, ?, ?)",
            ("committed", "{}", "2026-06-18T00:00:00Z"),
        )

    with db.connect() as conn:
        committed = conn.execute(
            "select value_json from settings where key = ?",
            ("committed",),
        ).fetchone()
    assert committed is not None

    with pytest.raises(RuntimeError):
        with db.transaction() as conn:
            conn.execute(
                "insert into settings (key, value_json, updated_at) values (?, ?, ?)",
                ("rolled_back", "{}", "2026-06-18T00:00:00Z"),
            )
            raise RuntimeError("force rollback")

    with db.connect() as conn:
        rolled_back = conn.execute(
            "select value_json from settings where key = ?",
            ("rolled_back",),
        ).fetchone()
    assert rolled_back is None
