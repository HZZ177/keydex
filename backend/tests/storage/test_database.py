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
        "model_providers",
        "model_defaults",
        "workspaces",
        "sessions",
        "message_events",
        "trace_record",
        "llm_request_logs",
        "trace_event_log",
    }
    assert expected.issubset(first)
    assert expected.issubset(second)


def test_database_connections_use_busy_timeout_and_wal(tmp_path) -> None:
    db = init_database(tmp_path / "app.db")

    with db.connect() as conn:
        busy_timeout = conn.execute("pragma busy_timeout").fetchone()
        journal_mode = conn.execute("pragma journal_mode").fetchone()

    assert busy_timeout is not None
    assert busy_timeout[0] >= 30000
    assert journal_mode is not None
    assert str(journal_mode[0]).lower() == "wal"


def test_init_database_creates_workspace_schema_and_session_columns(tmp_path) -> None:
    db = init_database(tmp_path / "app.db")

    with db.connect() as conn:
        workspace_columns = {
            str(row["name"])
            for row in conn.execute("pragma table_info(workspaces)").fetchall()
        }
        session_columns = {
            str(row["name"])
            for row in conn.execute("pragma table_info(sessions)").fetchall()
        }
        workspace_indexes = {
            str(row["name"])
            for row in conn.execute("pragma index_list(workspaces)").fetchall()
        }
        session_indexes = {
            str(row["name"])
            for row in conn.execute("pragma index_list(sessions)").fetchall()
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
    }.issubset(session_indexes)


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
            str(row["name"])
            for row in conn.execute("pragma table_info(sessions)").fetchall()
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
