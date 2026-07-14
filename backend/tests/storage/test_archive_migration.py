from __future__ import annotations

import re
import sqlite3

import pytest

from backend.app.storage import init_database
from backend.app.storage.db import SCHEMA_SQL


_LEGACY_RELATION_TABLES = (
    "session_forks",
    "attachments",
    "session_pending_inputs",
    "a2ui_interactions",
    "command_approval_requests",
    "command_approval_audit",
    "trace_record",
    "file_history_session_state",
    "file_history_snapshots",
    "file_history_snapshot_entries",
    "file_history_tracked_files",
    "file_history_mutations",
    "file_history_path_heads",
    "file_history_operations",
    "file_history_operation_files",
    "file_history_locks",
    "checkpoints_v2",
    "checkpoint_writes_v2",
)


def _create_unchanged_legacy_relation_tables(conn: sqlite3.Connection) -> None:
    """Create the pre-migration child tables around legacy lifecycle parents."""

    for table in _LEGACY_RELATION_TABLES:
        match = re.search(
            rf"create table if not exists {re.escape(table)}\s*\(.*?\n\);",
            SCHEMA_SQL,
            flags=re.DOTALL,
        )
        assert match is not None, f"missing schema for {table}"
        conn.execute(match.group(0))


def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
    return {str(row["name"]) for row in conn.execute(f"pragma table_info({table})")}


def _indexes(conn: sqlite3.Connection, table: str) -> set[str]:
    return {str(row["name"]) for row in conn.execute(f"pragma index_list({table})")}


def _create_legacy_archive_database(
    path,
    *,
    invalid_child: bool = False,
    with_full_relation_fixture: bool = False,
) -> None:
    with sqlite3.connect(path) as conn:
        conn.executescript(
            """
            pragma foreign_keys = off;
            create table workspaces (
              id text primary key,
              name text not null,
              root_path text not null,
              normalized_root_path text not null,
              type text not null default 'project',
              created_at text not null,
              updated_at text not null,
              last_opened_at text,
              is_deleted integer not null default 0
            );
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
              workspace_id text,
              session_type text not null default 'chat',
              cwd text,
              workspace_roots_json text not null default '[]',
              current_model_provider_id text,
              current_model text,
              context_window_usage_json text,
              context_compression_epoch integer not null default 0,
              pinned_at text,
              title text,
              title_source text not null default 'manual',
              created_at text not null,
              updated_at text not null,
              is_deleted integer not null default 0,
              foreign key(workspace_id) references workspaces(id) on delete set null
            );
            create table message_events (
              id text primary key,
              session_id text not null,
              trace_record_id text,
              seq integer not null,
              turn_index integer not null default 0,
              action text not null,
              data_json text,
              created_at text not null,
              updated_at text not null,
              is_deleted integer not null default 0,
              foreign key(session_id) references sessions(id) on delete cascade
            );
            insert into workspaces (
              id, name, root_path, normalized_root_path, created_at, updated_at, is_deleted
            ) values
              ('ws-active', 'Active', 'D:/active', 'd:/active',
               '2026-07-01T00:00:00Z', '2026-07-02T00:00:00Z', 0),
              ('ws-deleted', 'Deleted', 'D:/deleted', 'd:/deleted',
               '2026-07-01T00:00:00Z', '2026-07-02T00:00:00Z', 1);
            insert into sessions (
              id, user_id, scene_id, status, session_tag, active_session_id,
              workspace_id, title, created_at, updated_at, is_deleted
            ) values
              ('ses-active-active', 'local-user', 'desktop-agent', 'active', 'chat',
               'ses-active-active', 'ws-active', 'AA',
               '2026-07-01T00:00:00Z', '2026-07-02T00:00:00Z', 0),
              ('ses-deleted-active', 'local-user', 'desktop-agent', 'closed', 'chat',
               'ses-deleted-active', 'ws-active', 'DA',
               '2026-07-01T00:00:00Z', '2026-07-02T00:00:00Z', 1),
              ('ses-active-deleted', 'local-user', 'desktop-agent', 'active', 'chat',
               'ses-active-deleted', 'ws-deleted', 'AD',
               '2026-07-01T00:00:00Z', '2026-07-02T00:00:00Z', 0),
              ('ses-deleted-deleted', 'local-user', 'desktop-agent', 'closed', 'chat',
               'ses-deleted-deleted', 'ws-deleted', 'DD',
               '2026-07-01T00:00:00Z', '2026-07-02T00:00:00Z', 1);
            insert into message_events (
              id, session_id, seq, action, created_at, updated_at
            ) values (
              'evt-1', 'ses-active-active', 1, 'user_message',
              '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z'
            );
            """
        )
        if with_full_relation_fixture:
            _create_unchanged_legacy_relation_tables(conn)
            conn.executescript(
                """
                insert into session_forks (
                  id, source_session_id, target_session_id,
                  source_message_event_id, target_message_event_id,
                  source_turn_index, target_turn_index, created_at, updated_at
                ) values (
                  'fork-legacy', 'ses-active-active', 'ses-deleted-active',
                  'source-event', 'target-event', 1, 1,
                  '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z'
                );
                insert into attachments (
                  id, session_id, user_id, type, source, name, path, mime_type,
                  size, created_at, updated_at
                ) values (
                  'attachment-legacy', 'ses-active-active', 'local-user', 'image',
                  'pasted', 'legacy.png', 'D:/legacy.png', 'image/png', 1,
                  '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z'
                );
                insert into session_pending_inputs (
                  id, session_id, mode, status, message, created_at, updated_at
                ) values (
                  'pending-legacy', 'ses-active-active', 'queue', 'queued', 'queued',
                  '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z'
                );
                insert into a2ui_interactions (
                  id, session_id, stream_id, render_key, mode, created_at, updated_at
                ) values (
                  'a2ui-legacy', 'ses-active-active', 'stream-legacy', 'render-legacy',
                  'render', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z'
                );
                insert into command_approval_requests (
                  id, session_id, title, command, status, created_at, updated_at
                ) values (
                  'approval-legacy', 'ses-active-active', 'Confirm', 'echo legacy',
                  'approved', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z'
                );
                insert into command_approval_audit (
                  id, approval_id, session_id, command, decision, created_at
                ) values (
                  'audit-legacy', 'approval-legacy', 'ses-active-active',
                  'echo legacy', 'approved', '2026-07-01T00:00:00Z'
                );
                insert into trace_record (
                  trace_id, session_id, scene_id, user_id, turn_index, root_node_id,
                  status, start_time, created_at, updated_at
                ) values (
                  'trace-legacy', 'ses-active-active', 'desktop-agent', 'local-user',
                  1, 'root-legacy', 'completed', '2026-07-01T00:00:00Z',
                  '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z'
                );
                insert into file_history_snapshots (
                  id, session_id, kind, sequence, workspace_root,
                  workspace_identity, status, created_at, updated_at
                ) values (
                  'snapshot-legacy', 'ses-active-active', 'input', 1, 'D:/active',
                  'legacy-workspace', 'ready', '2026-07-01T00:00:00Z',
                  '2026-07-01T00:00:00Z'
                );
                insert into file_history_session_state (
                  session_id, active_snapshot_id, created_at, updated_at
                ) values (
                  'ses-active-active', 'snapshot-legacy',
                  '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z'
                );
                insert into file_history_snapshot_entries (
                  snapshot_id, canonical_path, display_path, state, version, backup_time
                ) values (
                  'snapshot-legacy', 'legacy.txt', 'legacy.txt', 'missing', 1,
                  '2026-07-01T00:00:00Z'
                );
                insert into file_history_tracked_files (
                  session_id, canonical_path, display_path, latest_version,
                  first_snapshot_id, last_snapshot_id, last_observed_state,
                  created_at, updated_at
                ) values (
                  'ses-active-active', 'legacy.txt', 'legacy.txt', 1,
                  'snapshot-legacy', 'snapshot-legacy', 'missing',
                  '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z'
                );
                insert into file_history_mutations (
                  id, session_id, snapshot_id, workspace_identity, canonical_path,
                  display_path, mutation_kind, before_state, after_state, status,
                  created_at, updated_at
                ) values (
                  'mutation-legacy', 'ses-active-active', 'snapshot-legacy',
                  'legacy-workspace', 'legacy.txt', 'legacy.txt', 'update',
                  'missing', 'missing', 'committed', '2026-07-01T00:00:00Z',
                  '2026-07-01T00:00:00Z'
                );
                insert into file_history_path_heads (
                  workspace_identity, canonical_path, display_path, session_id,
                  mutation_id, state, updated_at
                ) values (
                  'legacy-workspace', 'legacy.txt', 'legacy.txt', 'ses-active-active',
                  'mutation-legacy', 'missing', '2026-07-01T00:00:00Z'
                );
                insert into file_history_operations (
                  id, request_id, session_id, target_snapshot_id, workspace_identity,
                  mode, decision, state, created_at, updated_at
                ) values (
                  'operation-legacy', 'request-legacy', 'ses-active-active',
                  'snapshot-legacy', 'legacy-workspace', 'both', 'full', 'full',
                  '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z'
                );
                insert into file_history_operation_files (
                  operation_id, canonical_path, display_path, preview_current_state,
                  target_state, classification, writer_session_id, updated_at
                ) values (
                  'operation-legacy', 'legacy.txt', 'legacy.txt', 'missing', 'missing',
                  'ready', 'ses-active-active', '2026-07-01T00:00:00Z'
                );
                insert into file_history_locks (
                  lock_key, owner_operation_id, acquired_at, expires_at
                ) values (
                  'lock-legacy', 'operation-legacy', '2026-07-01T00:00:00Z',
                  '2026-07-01T00:05:00Z'
                );
                insert into checkpoints_v2 (
                  thread_id, checkpoint_ns, checkpoint_id, created_at,
                  checkpoint_blob, metadata
                ) values (
                  'ses-active-active', '', 'checkpoint-legacy',
                  '2026-07-01T00:00:00Z', x'00', '{}'
                );
                insert into checkpoint_writes_v2 (
                  thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel,
                  created_at
                ) values (
                  'ses-active-active', '', 'checkpoint-legacy', 'task-legacy', 0,
                  'messages', '2026-07-01T00:00:00Z'
                );
                """
            )
        if invalid_child:
            conn.execute(
                """
                insert into message_events (
                  id, session_id, seq, action, created_at, updated_at
                ) values (
                  'evt-invalid', 'ses-missing', 1, 'user_message',
                  '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z'
                )
                """
            )


def test_fresh_database_uses_archive_lifecycle_schema(tmp_path) -> None:
    db = init_database(tmp_path / "app.db")

    with db.connect() as conn:
        workspace_columns = _columns(conn, "workspaces")
        session_columns = _columns(conn, "sessions")
        workspace_indexes = _indexes(conn, "workspaces")
        session_indexes = _indexes(conn, "sessions")

    assert "archived_at" in workspace_columns
    assert "is_deleted" not in workspace_columns
    assert {"archived_at", "archive_origin"}.issubset(session_columns)
    assert "is_deleted" not in session_columns
    assert {
        "idx_workspaces_normalized_root_active",
        "idx_workspaces_archived",
    }.issubset(workspace_indexes)
    assert {"idx_sessions_archived", "idx_sessions_workspace_archive"}.issubset(
        session_indexes
    )


def test_session_archive_columns_enforce_matching_state(tmp_path) -> None:
    db = init_database(tmp_path / "app.db")
    base = (
        "ses-1",
        "local-user",
        "desktop-agent",
        "active",
        "chat",
        "2026-07-14T00:00:00Z",
        "2026-07-14T00:00:00Z",
    )

    with db.connect() as conn:
        conn.execute(
            """
            insert into sessions (
              id, user_id, scene_id, status, session_tag, created_at, updated_at,
              archived_at, archive_origin
            ) values (?, ?, ?, ?, ?, ?, ?, null, null)
            """,
            base,
        )
        conn.execute(
            """
            insert into sessions (
              id, user_id, scene_id, status, session_tag, created_at, updated_at,
              archived_at, archive_origin
            ) values ('ses-2', ?, ?, ?, ?, ?, ?, '2026-07-14T01:00:00Z', 'manual')
            """,
            base[1:],
        )

        invalid_pairs = (
            ("ses-invalid-1", None, "manual"),
            ("ses-invalid-2", "2026-07-14T01:00:00Z", None),
            ("ses-invalid-3", "2026-07-14T01:00:00Z", "unknown"),
        )
        for session_id, archived_at, origin in invalid_pairs:
            with pytest.raises(sqlite3.IntegrityError):
                conn.execute(
                    """
                    insert into sessions (
                      id, user_id, scene_id, status, session_tag, created_at, updated_at,
                      archived_at, archive_origin
                    ) values (?, 'local-user', 'desktop-agent', 'active', 'chat',
                              '2026-07-14T00:00:00Z', '2026-07-14T00:00:00Z', ?, ?)
                    """,
                    (session_id, archived_at, origin),
                )


def test_archived_workspace_releases_active_root_uniqueness(tmp_path) -> None:
    db = init_database(tmp_path / "app.db")
    values = (
        "Demo",
        "D:/Projects/demo",
        "d:/projects/demo",
        "2026-07-14T00:00:00Z",
        "2026-07-14T00:00:00Z",
    )

    with db.connect() as conn:
        conn.execute(
            """
            insert into workspaces (
              id, name, root_path, normalized_root_path, created_at, updated_at
            ) values ('ws-1', ?, ?, ?, ?, ?)
            """,
            values,
        )
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                """
                insert into workspaces (
                  id, name, root_path, normalized_root_path, created_at, updated_at
                ) values ('ws-duplicate', ?, ?, ?, ?, ?)
                """,
                values,
            )
        conn.execute(
            "update workspaces set archived_at = '2026-07-14T01:00:00Z' where id = 'ws-1'"
        )
        conn.execute(
            """
            insert into workspaces (
              id, name, root_path, normalized_root_path, created_at, updated_at
            ) values ('ws-2', ?, ?, ?, ?, ?)
            """,
            values,
        )


def test_legacy_soft_deleted_rows_migrate_to_archive_origins_idempotently(tmp_path) -> None:
    db_path = tmp_path / "legacy.db"
    _create_legacy_archive_database(db_path)

    first = init_database(db_path)
    with first.connect() as conn:
        workspace_rows = {
            str(row["id"]): row
            for row in conn.execute(
                "select id, updated_at, archived_at from workspaces order by id"
            )
        }
        session_rows = {
            str(row["id"]): row
            for row in conn.execute(
                """
                select id, updated_at, archived_at, archive_origin
                from sessions order by id
                """
            )
        }
        migrated_times = {
            row["archived_at"]
            for row in [*workspace_rows.values(), *session_rows.values()]
            if row["archived_at"] is not None
        }
        assert conn.execute("pragma foreign_key_check").fetchall() == []
        assert conn.execute(
            "select session_id from message_events where id = 'evt-1'"
        ).fetchone()["session_id"] == "ses-active-active"

    assert workspace_rows["ws-active"]["archived_at"] is None
    assert workspace_rows["ws-deleted"]["archived_at"] is not None
    assert session_rows["ses-active-active"]["archive_origin"] is None
    assert session_rows["ses-deleted-active"]["archive_origin"] == "manual"
    assert session_rows["ses-active-deleted"]["archive_origin"] == "project"
    assert session_rows["ses-deleted-deleted"]["archive_origin"] == "manual"
    assert {row["updated_at"] for row in workspace_rows.values()} == {
        "2026-07-02T00:00:00Z"
    }
    assert {row["updated_at"] for row in session_rows.values()} == {
        "2026-07-02T00:00:00Z"
    }
    assert len(migrated_times) == 1

    second = init_database(db_path)
    with second.connect() as conn:
        second_times = {
            row["archived_at"]
            for row in conn.execute(
                """
                select archived_at from workspaces where archived_at is not null
                union all
                select archived_at from sessions where archived_at is not null
                """
            )
        }
        assert "is_deleted" not in _columns(conn, "workspaces")
        assert "is_deleted" not in _columns(conn, "sessions")
        assert conn.execute("pragma integrity_check").fetchone()[0] == "ok"

    assert second_times == migrated_times


def test_legacy_archive_migration_preserves_all_session_relation_families(tmp_path) -> None:
    db_path = tmp_path / "legacy-relations.db"
    _create_legacy_archive_database(db_path, with_full_relation_fixture=True)

    init_database(db_path)
    db = init_database(db_path)

    expected_rows = {
        "session_forks": ("id", "fork-legacy"),
        "attachments": ("id", "attachment-legacy"),
        "message_events": ("id", "evt-1"),
        "session_pending_inputs": ("id", "pending-legacy"),
        "a2ui_interactions": ("id", "a2ui-legacy"),
        "command_approval_requests": ("id", "approval-legacy"),
        "command_approval_audit": ("id", "audit-legacy"),
        "trace_record": ("trace_id", "trace-legacy"),
        "file_history_session_state": ("session_id", "ses-active-active"),
        "file_history_snapshots": ("id", "snapshot-legacy"),
        "file_history_snapshot_entries": ("snapshot_id", "snapshot-legacy"),
        "file_history_tracked_files": ("session_id", "ses-active-active"),
        "file_history_mutations": ("id", "mutation-legacy"),
        "file_history_path_heads": ("session_id", "ses-active-active"),
        "file_history_operations": ("id", "operation-legacy"),
        "file_history_operation_files": ("operation_id", "operation-legacy"),
        "file_history_locks": ("lock_key", "lock-legacy"),
        "checkpoints_v2": ("checkpoint_id", "checkpoint-legacy"),
        "checkpoint_writes_v2": ("task_id", "task-legacy"),
    }
    with db.connect() as conn:
        for table, (column, value) in expected_rows.items():
            assert conn.execute(
                f'select count(*) as total from "{table}" where "{column}" = ?',
                (value,),
            ).fetchone()["total"] == 1
        assert conn.execute("pragma foreign_key_check").fetchall() == []
        assert conn.execute("pragma integrity_check").fetchone()[0] == "ok"


def test_legacy_archive_migration_rolls_back_when_foreign_keys_are_invalid(tmp_path) -> None:
    db_path = tmp_path / "invalid-legacy.db"
    _create_legacy_archive_database(db_path, invalid_child=True)

    with pytest.raises(RuntimeError, match="外键校验失败"):
        init_database(db_path)

    with sqlite3.connect(db_path) as conn:
        columns = {str(row[1]) for row in conn.execute("pragma table_info(sessions)")}
        session_count = conn.execute("select count(*) from sessions").fetchone()[0]
        invalid_event = conn.execute(
            "select session_id from message_events where id = 'evt-invalid'"
        ).fetchone()[0]

    assert "is_deleted" in columns
    assert "archived_at" not in columns
    assert session_count == 4
    assert invalid_event == "ses-missing"
