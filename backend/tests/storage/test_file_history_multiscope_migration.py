from __future__ import annotations

from backend.app.storage import init_database


NOW = "2026-07-15T00:00:00Z"


def _create_populated_legacy_history(db) -> None:
    with db.connect() as conn:
        conn.execute("pragma foreign_keys = off")
        conn.executescript(
            """
            drop table file_history_operation_files;
            drop table file_history_path_heads;
            drop table file_history_mutations;
            drop table file_history_tracked_files;
            drop table file_history_snapshot_entries;
            drop table file_history_snapshot_scopes;

            create table file_history_snapshot_entries (
              snapshot_id text, canonical_path text, display_path text, state text,
              backup_file_name text, version integer, backup_time text, size integer,
              mode integer, content_hash text
            );
            create table file_history_tracked_files (
              session_id text, canonical_path text, display_path text, latest_version integer,
              first_snapshot_id text, last_snapshot_id text, last_observed_state text,
              last_observed_hash text, last_observed_size integer,
              last_observed_mtime_ns integer, last_observed_mode integer,
              created_at text, updated_at text
            );
            create table file_history_mutations (
              id text, session_id text, active_session_id text, trace_id text,
              turn_index integer, snapshot_id text, workspace_identity text,
              canonical_path text, display_path text, tool_name text, tool_call_id text,
              batch_id text, mutation_kind text, before_state text, before_hash text,
              after_state text, after_hash text, status text, error_code text,
              created_at text, updated_at text
            );
            create table file_history_path_heads (
              workspace_identity text, canonical_path text, display_path text,
              session_id text, trace_id text, mutation_id text, state text,
              content_hash text, revision integer, updated_at text
            );
            create table file_history_operation_files (
              operation_id text, canonical_path text, display_path text,
              preview_current_state text, preview_current_hash text, target_state text,
              target_backup_file_name text, target_hash text, target_size integer,
              target_mode integer, classification text, reason_code text,
              writer_session_id text, user_authorized integer, result_state text,
              error_code text, safety_state text, safety_backup_file_name text,
              safety_hash text, safety_size integer, safety_mode integer, updated_at text
            );
            """
        )
        conn.execute(
            "insert into sessions (id, user_id, scene_id, status, created_at, updated_at) "
            "values ('session-1', 'user-1', 'scene-1', 'active', ?, ?)",
            (NOW, NOW),
        )
        conn.execute(
            """
            insert into file_history_snapshots (
              id, session_id, kind, sequence, workspace_root, workspace_identity,
              status, created_at, updated_at
            ) values ('snapshot-1', 'session-1', 'input', 1,
                      'Z:/offline/project', 'z:/offline/project', 'ready', ?, ?)
            """,
            (NOW, NOW),
        )
        conn.execute(
            """
            insert into file_history_snapshot_entries values (
              'snapshot-1', 'src/a.txt', 'src/a.txt', 'file', 'legacy@v1',
              1, ?, 3, 420, 'aaa'
            )
            """,
            (NOW,),
        )
        conn.execute(
            """
            insert into file_history_tracked_files values (
              'session-1', 'src/a.txt', 'src/a.txt', 1, 'snapshot-1', 'snapshot-1',
              'file', 'aaa', 3, 1, 420, ?, ?
            )
            """,
            (NOW, NOW),
        )
        conn.execute(
            """
            insert into file_history_mutations values (
              'mutation-1', 'session-1', 'session-1', 'trace-1', 1, 'snapshot-1',
              'z:/offline/project', 'src/a.txt', 'src/a.txt', 'edit_file', 'call-1',
              null, 'update', 'file', 'aaa', 'file', 'bbb', 'committed', null, ?, ?
            )
            """,
            (NOW, NOW),
        )
        conn.execute(
            """
            insert into file_history_path_heads values (
              'z:/offline/project', 'src/a.txt', 'src/a.txt', 'session-1', 'trace-1',
              'mutation-1', 'file', 'bbb', 1, ?
            )
            """,
            (NOW,),
        )
        conn.execute(
            """
            insert into file_history_operations (
              id, request_id, session_id, target_snapshot_id, workspace_identity,
              mode, decision, state, created_at, updated_at
            ) values ('operation-1', 'request-1', 'session-1', 'snapshot-1',
                      'z:/offline/project', 'code', 'full', 'previewed', ?, ?)
            """,
            (NOW, NOW),
        )
        conn.execute(
            """
            insert into file_history_operation_files values (
              'operation-1', 'src/a.txt', 'src/a.txt', 'file', 'bbb', 'file',
              'legacy@v1', 'aaa', 3, 420, 'ready', null, 'session-1', 1,
              'pending', null, null, null, null, null, null, ?
            )
            """,
            (NOW,),
        )


def test_legacy_file_history_migrates_losslessly_and_idempotently(tmp_path) -> None:
    db = init_database(tmp_path / "legacy.db")
    _create_populated_legacy_history(db)

    db.init_schema()
    db.init_schema()

    with db.connect() as conn:
        columns = {
            row["name"]
            for row in conn.execute("pragma table_info(file_history_snapshot_entries)")
        }
        scope = conn.execute("select * from file_history_snapshot_scopes").fetchone()
        counts = {
            table: conn.execute(f"select count(*) from {table}").fetchone()[0]
            for table in (
                "file_history_snapshot_entries",
                "file_history_tracked_files",
                "file_history_mutations",
                "file_history_path_heads",
                "file_history_operation_files",
            )
        }
        foreign_key_errors = conn.execute("pragma foreign_key_check").fetchall()

    assert {"scope_kind", "scope_identity", "scope_root", "scope_label"}.issubset(columns)
    assert scope["scope_kind"] == "workspace"
    assert scope["scope_identity"] == "z:/offline/project"
    assert scope["scope_root"] == "Z:/offline/project"
    assert counts == {table: 1 for table in counts}
    assert foreign_key_errors == []
