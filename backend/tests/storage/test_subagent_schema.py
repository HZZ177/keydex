from __future__ import annotations

import sqlite3

import pytest

from backend.app.storage import StorageRepositories, init_database

SESSION_AGENT_COLUMNS = {
    "visibility",
    "agent_kind",
    "subagent_id",
    "subagent_role",
    "subagent_closed_at",
}


def test_db_001_fresh_database_has_session_agent_columns_indexes_and_constraints(
    tmp_path,
) -> None:
    db = init_database(tmp_path / "app.db")
    with db.connect() as conn:
        columns = {
            row["name"]: row for row in conn.execute("pragma table_info(sessions)").fetchall()
        }
        indexes = {
            row["name"] for row in conn.execute("pragma index_list(sessions)").fetchall()
        }

    assert SESSION_AGENT_COLUMNS.issubset(columns)
    assert columns["visibility"]["dflt_value"] == "'visible'"
    assert columns["agent_kind"]["dflt_value"] == "'main'"
    assert {
        "idx_sessions_visibility",
        "idx_sessions_parent_agent_kind",
        "idx_sessions_subagent_id_unique",
    }.issubset(indexes)


def test_db_002_existing_sessions_migrate_to_visible_main_defaults(tmp_path) -> None:
    db_path = tmp_path / "legacy.db"
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
              archived_at text,
              archive_origin text
            );
            insert into sessions (
              id, user_id, scene_id, status, created_at, updated_at
            ) values (
              'legacy-session', 'local-user', 'desktop-agent', 'active',
              '2026-07-18T00:00:00Z', '2026-07-18T00:00:00Z'
            );
            """
        )

    repositories = StorageRepositories(init_database(db_path))
    migrated = repositories.sessions.get("legacy-session")

    assert migrated is not None
    assert migrated.visibility == "visible"
    assert migrated.agent_kind == "main"
    assert migrated.subagent_id is None
    assert migrated.subagent_role is None


def test_db_003_session_agent_migration_is_idempotent(tmp_path) -> None:
    db_path = tmp_path / "app.db"
    first = init_database(db_path)
    first.init_schema()
    second = init_database(db_path)

    with second.connect() as conn:
        columns = [
            row["name"] for row in conn.execute("pragma table_info(sessions)").fetchall()
        ]
        triggers = {
            row["name"]
            for row in conn.execute(
                "select name from sqlite_master where type = 'trigger' "
                "and name like 'trg_sessions_subagent_shape_%'"
            ).fetchall()
        }

    assert all(columns.count(column) == 1 for column in SESSION_AGENT_COLUMNS)
    assert triggers == {
        "trg_sessions_subagent_shape_insert",
        "trg_sessions_subagent_shape_update",
    }


def test_db_004_existing_visible_session_repository_behavior_is_preserved(tmp_path) -> None:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    session = repositories.sessions.create(
        session_id="main-session",
        user_id="local-user",
        scene_id="desktop-agent",
        session_type="workspace",
    )

    assert session.visibility == "visible"
    assert session.agent_kind == "main"
    assert session.is_internal is False
    assert session.is_subagent is False
    assert repositories.sessions.list() == [session]


def test_subagent_session_shape_is_persisted_without_changing_workspace_type(
    tmp_path,
) -> None:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    parent = repositories.sessions.create(
        session_id="parent-session",
        user_id="local-user",
        scene_id="desktop-agent",
        session_type="workspace",
    )
    child = repositories.sessions.create(
        session_id="child-session",
        user_id="local-user",
        scene_id="desktop-agent",
        session_type="workspace",
        session_tag="subagent",
        parent_session_id=parent.id,
        visibility="internal",
        agent_kind="subagent",
        subagent_id="subagent-1",
        subagent_role="explorer",
    )

    assert child.session_type == "workspace"
    assert child.visibility == "internal"
    assert child.agent_kind == "subagent"
    assert child.subagent_id == "subagent-1"
    assert child.subagent_role == "explorer"
    assert child.parent_session_id == parent.id
    assert child.is_internal is True
    assert child.is_subagent is True


@pytest.mark.parametrize(
    "overrides",
    [
        {"visibility": "visible"},
        {"session_type": "chat"},
        {"session_tag": "chat"},
        {"parent_session_id": None},
        {"subagent_id": None},
        {"subagent_role": "reviewer"},
    ],
)
def test_subagent_session_shape_rejects_incomplete_or_unknown_metadata(
    tmp_path, overrides: dict[str, object]
) -> None:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    payload: dict[str, object] = {
        "session_id": "child-session",
        "user_id": "local-user",
        "scene_id": "desktop-agent",
        "session_type": "workspace",
        "session_tag": "subagent",
        "parent_session_id": "parent-session",
        "visibility": "internal",
        "agent_kind": "subagent",
        "subagent_id": "subagent-1",
        "subagent_role": "worker",
    }
    payload.update(overrides)

    with pytest.raises(ValueError):
        repositories.sessions.create(**payload)


def test_database_trigger_rejects_raw_invalid_subagent_shape(tmp_path) -> None:
    db = init_database(tmp_path / "app.db")
    with db.connect() as conn, pytest.raises(sqlite3.IntegrityError):
        conn.execute(
            """
            insert into sessions (
              id, user_id, scene_id, status, session_type, session_tag,
              visibility, agent_kind, subagent_id, subagent_role,
              created_at, updated_at
            ) values (
              'invalid-child', 'local-user', 'desktop-agent', 'active',
              'workspace', 'subagent', 'visible', 'subagent', 'subagent-1', 'worker',
              '2026-07-18T00:00:00Z', '2026-07-18T00:00:00Z'
            )
            """
        )


def _create_parent_and_child(repositories: StorageRepositories) -> None:
    repositories.sessions.create(
        session_id="parent-session",
        user_id="local-user",
        scene_id="desktop-agent",
        session_type="workspace",
    )
    repositories.sessions.create(
        session_id="child-session",
        user_id="local-user",
        scene_id="desktop-agent",
        session_type="workspace",
        session_tag="subagent",
        parent_session_id="parent-session",
        visibility="internal",
        agent_kind="subagent",
        subagent_id="subagent-1",
        subagent_role="worker",
    )


def _insert_queued_run(
    conn: sqlite3.Connection,
    *,
    run_id: str = "run-1",
    subagent_id: str = "subagent-1",
    child_session_id: str = "child-session",
    sequence: int = 1,
) -> None:
    conn.execute(
        """
        insert into subagent_run (
          run_id, subagent_id, child_session_id, parent_session_id,
          parent_trace_id, parent_tool_call_id, parent_timeline_sequence,
          initiated_by, role, task, state, version,
          created_at, queued_at, updated_at
        ) values (?, ?, ?, 'parent-session', 'trace-1', ?, ?,
                  'main_agent', 'worker', 'bounded task', 'queued', 1, ?, ?, ?)
        """,
        (
            run_id,
            subagent_id,
            child_session_id,
            f"tool-{run_id}",
            sequence,
            "2026-07-18T00:00:00Z",
            "2026-07-18T00:00:00Z",
            "2026-07-18T00:00:00Z",
        ),
    )


def test_db_001_run_table_has_complete_columns_indexes_and_foreign_keys(tmp_path) -> None:
    db = init_database(tmp_path / "app.db")
    with db.connect() as conn:
        columns = {
            row["name"] for row in conn.execute("pragma table_info(subagent_run)").fetchall()
        }
        indexes = {
            row["name"] for row in conn.execute("pragma index_list(subagent_run)").fetchall()
        }
        foreign_keys = conn.execute("pragma foreign_key_list(subagent_run)").fetchall()

    assert columns == {
        "run_id",
        "subagent_id",
        "child_session_id",
        "parent_session_id",
        "parent_trace_id",
        "parent_tool_call_id",
        "parent_timeline_sequence",
        "initiated_by",
        "role",
        "task",
        "state",
        "blocked_on",
        "version",
        "final_report",
        "report_truncated",
        "error_code",
        "error_message",
        "created_at",
        "queued_at",
        "started_at",
        "finished_at",
        "updated_at",
        "cancel_requested_at",
    }
    assert {
        "idx_subagent_run_parent_sequence",
        "idx_subagent_run_active_instance",
        "idx_subagent_run_parent_created",
        "idx_subagent_run_child_created",
        "idx_subagent_run_instance_created",
        "idx_subagent_run_parent_trace_active",
        "idx_subagent_run_state",
    }.issubset(indexes)
    assert {(row["from"], row["table"], row["to"]) for row in foreign_keys} == {
        ("parent_session_id", "sessions", "id"),
        ("child_session_id", "sessions", "id"),
    }


def test_db_005_duplicate_run_id_is_rejected(tmp_path) -> None:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    _create_parent_and_child(repositories)
    with repositories.db.connect() as conn:
        _insert_queued_run(conn)
        with pytest.raises(sqlite3.IntegrityError):
            _insert_queued_run(conn)


def test_db_006_same_instance_has_only_one_active_run(tmp_path) -> None:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    _create_parent_and_child(repositories)
    with repositories.db.connect() as conn:
        _insert_queued_run(conn)
        with pytest.raises(sqlite3.IntegrityError):
            _insert_queued_run(conn, run_id="run-2", sequence=2)

        conn.execute(
            """
            update subagent_run
            set state = 'cancelled', version = 2, finished_at = ?, updated_at = ?
            where run_id = 'run-1'
            """,
            ("2026-07-18T00:00:01Z", "2026-07-18T00:00:01Z"),
        )
        _insert_queued_run(conn, run_id="run-2", sequence=2)


def test_db_007_run_foreign_keys_and_parent_sequence_are_enforced(tmp_path) -> None:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    _create_parent_and_child(repositories)
    with repositories.db.connect() as conn:
        _insert_queued_run(conn)
        conn.execute(
            """
            update subagent_run
            set state = 'cancelled', version = 2, finished_at = ?, updated_at = ?
            where run_id = 'run-1'
            """,
            ("2026-07-18T00:00:01Z", "2026-07-18T00:00:01Z"),
        )
        with pytest.raises(sqlite3.IntegrityError):
            _insert_queued_run(
                conn,
                run_id="run-missing-child",
                subagent_id="subagent-2",
                child_session_id="missing-child",
                sequence=2,
            )
        with pytest.raises(sqlite3.IntegrityError):
            _insert_queued_run(
                conn,
                run_id="run-duplicate-sequence",
                subagent_id="subagent-2",
                sequence=1,
            )


def test_run_state_payload_constraints_reject_invalid_block_and_terminal_shape(
    tmp_path,
) -> None:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    _create_parent_and_child(repositories)
    with repositories.db.connect() as conn:
        _insert_queued_run(conn)
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                "update subagent_run set blocked_on = 'approval' where run_id = 'run-1'"
            )
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                """
                update subagent_run
                set state = 'completed', finished_at = ?, final_report = null
                where run_id = 'run-1'
                """,
                ("2026-07-18T00:00:01Z",),
            )
