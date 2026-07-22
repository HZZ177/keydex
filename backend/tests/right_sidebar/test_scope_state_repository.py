from __future__ import annotations

import sqlite3

import pytest

from backend.app.right_sidebar.models import RightSidebarScopeStateDocument
from backend.app.right_sidebar.repository import RightSidebarRevisionConflict
from backend.app.storage import Database, StorageRepositories


def _state(panel_id: str = "files-1") -> RightSidebarScopeStateDocument:
    return RightSidebarScopeStateDocument.model_validate(
        {
            "version": 2,
            "activePanelId": panel_id,
            "panelOrder": [panel_id],
            "panels": {
                panel_id: {"id": panel_id, "kind": "files", "schemaVersion": 1},
            },
            "nextPanelSeq": 2,
        }
    )


def test_scope_schema_is_idempotent_and_has_partial_unique_indexes(tmp_path) -> None:
    database = Database(tmp_path / "state.db")
    database.init_schema()
    database.init_schema()

    with database.connect() as conn:
        indexes = {
            str(row["name"]): int(row["partial"])
            for row in conn.execute("pragma index_list('right_sidebar_scope_states')")
        }
        foreign_keys = {
            (str(row["from"]), str(row["table"]), str(row["on_delete"]))
            for row in conn.execute("pragma foreign_key_list('right_sidebar_scope_states')")
        }
        violations = conn.execute("pragma foreign_key_check").fetchall()

    assert indexes["idx_right_sidebar_scope_session"] == 1
    assert indexes["idx_right_sidebar_scope_workspace"] == 1
    assert indexes["idx_right_sidebar_scope_global"] == 1
    assert ("session_id", "sessions", "CASCADE") in foreign_keys
    assert ("workspace_id", "workspaces", "CASCADE") in foreign_keys
    assert violations == []


def test_scope_repository_enforces_compare_and_swap_and_global_singleton(tmp_path) -> None:
    database = Database(tmp_path / "state.db")
    database.init_schema()
    repository = StorageRepositories(database).right_sidebar_scopes

    created = repository.put(
        scope_kind="global",
        scope_id=None,
        state=_state(),
        expected_revision=0,
    )
    updated = repository.put(
        scope_kind="global",
        scope_id=None,
        state=_state("files-2"),
        expected_revision=created.revision,
    )

    assert created.revision == 1
    assert updated.revision == 2
    assert updated.state.active_panel_id == "files-2"
    with pytest.raises(RightSidebarRevisionConflict) as conflict:
        repository.put(
            scope_kind="global",
            scope_id=None,
            state=_state(),
            expected_revision=1,
        )
    assert conflict.value.current is not None
    assert conflict.value.current.revision == 2

    with database.connect() as conn:
        count = conn.execute(
            "select count(*) from right_sidebar_scope_states where scope_kind = 'global'"
        ).fetchone()[0]
    assert count == 1


def test_scope_rows_cascade_with_session_and_workspace_parents(tmp_path) -> None:
    database = Database(tmp_path / "state.db")
    database.init_schema()
    repositories = StorageRepositories(database)
    project = tmp_path / "project"
    project.mkdir()
    repositories.workspaces.create(workspace_id="workspace-1", root_path=project)
    repositories.sessions.create(
        session_id="session-1",
        user_id="local-user",
        scene_id="test",
    )
    repositories.right_sidebar_scopes.put(
        scope_kind="workspace",
        scope_id="workspace-1",
        state=_state(),
        expected_revision=0,
    )
    repositories.right_sidebar_scopes.put(
        scope_kind="session",
        scope_id="session-1",
        state=_state(),
        expected_revision=0,
    )

    with database.transaction() as conn:
        conn.execute("delete from sessions where id = ?", ("session-1",))
        conn.execute("delete from workspaces where id = ?", ("workspace-1",))

    with database.connect() as conn:
        count = conn.execute("select count(*) from right_sidebar_scope_states").fetchone()[0]
        violations = conn.execute("pragma foreign_key_check").fetchall()
    assert count == 0
    assert violations == []


def test_scope_database_rejects_invalid_scope_shape(tmp_path) -> None:
    database = Database(tmp_path / "state.db")
    database.init_schema()
    with pytest.raises(sqlite3.IntegrityError):
        with database.transaction() as conn:
            conn.execute(
                """
                insert into right_sidebar_scope_states (
                  id, scope_kind, schema_version, state_json, revision, created_at, updated_at
                ) values ('bad', 'session', 2, '{}', 1, 'now', 'now')
                """
            )


def test_scope_promotion_is_atomic_idempotent_and_returns_stable_mapping(tmp_path) -> None:
    database = Database(tmp_path / "state.db")
    database.init_schema()
    repositories = StorageRepositories(database)
    project = tmp_path / "project"
    project.mkdir()
    repositories.workspaces.create(workspace_id="workspace-1", root_path=project)
    repositories.sessions.create(
        session_id="session-1",
        user_id="local-user",
        scene_id="test",
    )
    repositories.right_sidebar_scopes.put(
        scope_kind="workspace",
        scope_id="workspace-1",
        state=_state("files-1"),
        expected_revision=0,
    )
    repositories.right_sidebar_scopes.put(
        scope_kind="session",
        scope_id="session-1",
        state=_state("files-1"),
        expected_revision=0,
    )

    promoted = repositories.right_sidebar_scopes.promote(
        source_scope_kind="workspace",
        source_scope_id="workspace-1",
        source_revision=1,
        target_session_id="session-1",
    )
    replayed = repositories.right_sidebar_scopes.promote(
        source_scope_kind="workspace",
        source_scope_id="workspace-1",
        source_revision=1,
        target_session_id="session-1",
    )

    remapped_id = promoted.panel_id_mapping["files-1"]
    assert remapped_id == "files-1:promoted:1"
    assert promoted.target.revision == 2
    assert promoted.target.state.panel_order == ["files-1", remapped_id]
    assert repositories.right_sidebar_scopes.get(
        scope_kind="workspace",
        scope_id="workspace-1",
    ) is None
    assert replayed.idempotent_replay is True
    assert replayed.panel_id_mapping == promoted.panel_id_mapping
    assert replayed.target == promoted.target
    with database.connect() as conn:
        promotion_count = conn.execute(
            "select count(*) from right_sidebar_scope_promotions"
        ).fetchone()[0]
    assert promotion_count == 1
