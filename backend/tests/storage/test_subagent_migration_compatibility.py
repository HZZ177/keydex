from __future__ import annotations

import sqlite3

import pytest

from backend.app.storage import StorageRepositories, init_database
from backend.app.storage.db import Database

SUBAGENT_SESSION_COLUMNS = (
    "subagent_closed_at",
    "subagent_role",
    "subagent_id",
    "agent_kind",
    "visibility",
)


def _strip_subagent_schema(db_path) -> None:
    """Turn a current fixture into the last pre-Sub-Agent database shape."""
    with sqlite3.connect(db_path) as conn:
        conn.executescript(
            """
            drop trigger if exists trg_sessions_subagent_shape_insert;
            drop trigger if exists trg_sessions_subagent_shape_update;
            drop index if exists idx_sessions_visibility;
            drop index if exists idx_sessions_parent_agent_kind;
            drop index if exists idx_sessions_subagent_id_unique;
            drop table if exists subagent_run;
            """
        )
        for column in SUBAGENT_SESSION_COLUMNS:
            conn.execute(f"alter table sessions drop column {column}")


def _seed_legacy_relations(db_path) -> tuple[int, str]:
    repositories = StorageRepositories(init_database(db_path))
    parent = repositories.sessions.create(
        session_id="legacy-parent",
        user_id="local-user",
        scene_id="desktop-agent",
        session_type="workspace",
    )
    compression = repositories.sessions.create(
        session_id="legacy-compression",
        user_id="local-user",
        scene_id="desktop-agent",
        session_type="workspace",
        session_tag=repositories.sessions.INTERNAL_CONTEXT_COMPRESSION_SESSION_TAG,
        parent_session_id=parent.id,
    )
    branch = repositories.sessions.create(
        session_id="legacy-branch",
        user_id="local-user",
        scene_id="desktop-agent",
        session_type="workspace",
        parent_session_id=parent.id,
    )
    repositories.trace_records.create(
        trace_id="legacy-trace",
        session_id=parent.id,
        active_session_id=parent.id,
        scene_id="desktop-agent",
        user_id="local-user",
        turn_index=1,
        root_node_id="root",
        metadata={"legacy": True},
    )
    repositories.session_forks.create(
        fork_id="legacy-fork",
        source_session_id=parent.id,
        target_session_id=branch.id,
        source_message_event_id="source-message",
        target_message_event_id="target-message",
        source_turn_index=1,
        target_turn_index=1,
        source_trace_id="legacy-trace",
    )
    staging = repositories.compression_staging.create(
        original_session_id=parent.id,
        active_session_id=parent.id,
        target_session_id=compression.id,
        generation=1,
        l1_content="legacy summary",
    )
    _strip_subagent_schema(db_path)
    return staging.id, compression.id


def test_ft_db_002_004_legacy_relations_survive_subagent_schema_upgrade(tmp_path) -> None:
    db_path = tmp_path / "legacy-relations.db"
    staging_id, compression_id = _seed_legacy_relations(db_path)

    repositories = StorageRepositories(init_database(db_path))

    parent = repositories.sessions.get("legacy-parent")
    assert parent is not None
    assert parent.visibility == "visible"
    assert parent.agent_kind == "main"
    assert repositories.trace_records.get("legacy-trace") is not None
    assert repositories.session_forks.get("legacy-fork") is not None
    assert repositories.compression_staging.get(staging_id) is not None
    assert repositories.sessions.get(compression_id) is not None
    assert [item.id for item in repositories.sessions.list()] == [
        "legacy-branch",
        "legacy-parent",
    ]


def test_ft_db_003_failed_upgrade_keeps_legacy_data_and_can_be_retried(
    tmp_path, monkeypatch
) -> None:
    db_path = tmp_path / "retryable-upgrade.db"
    _seed_legacy_relations(db_path)

    def fail_run_schema(_conn) -> None:
        raise RuntimeError("injected subagent migration failure")

    with monkeypatch.context() as scoped:
        scoped.setattr(Database, "_ensure_subagent_run_schema", staticmethod(fail_run_schema))
        with pytest.raises(RuntimeError, match="injected subagent migration failure"):
            Database(db_path).init_schema()

    with sqlite3.connect(db_path) as conn:
        assert conn.execute(
            "select count(*) from sessions where id = 'legacy-parent'"
        ).fetchone()[0] == 1
        assert conn.execute(
            "select count(*) from trace_record where trace_id = 'legacy-trace'"
        ).fetchone()[0] == 1

    repositories = StorageRepositories(init_database(db_path))
    assert repositories.sessions.get("legacy-parent") is not None
    assert repositories.trace_records.get("legacy-trace") is not None
    assert repositories.session_forks.get("legacy-fork") is not None

