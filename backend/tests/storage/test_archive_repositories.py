from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
import sqlite3
from time import perf_counter

import pytest

from backend.app.services.session_service import SessionService
from backend.app.services.workspace_service import WorkspaceService
from backend.app.storage import StorageRepositories, init_database


def _repositories(tmp_path) -> StorageRepositories:
    return StorageRepositories(init_database(tmp_path / "app.db"))


def _archive_workspace(repositories, workspace_id: str, archived_at: str) -> None:
    with repositories.db.transaction() as conn:
        conn.execute(
            "update workspaces set archived_at = ? where id = ?",
            (archived_at, workspace_id),
        )


def _archive_session(
    repositories,
    session_id: str,
    archived_at: str,
    origin: str = "manual",
) -> None:
    with repositories.db.transaction() as conn:
        conn.execute(
            "update sessions set archived_at = ?, archive_origin = ? where id = ?",
            (archived_at, origin, session_id),
        )


def test_workspace_and_session_records_serialize_archive_fields_without_legacy_flags(
    tmp_path,
) -> None:
    repositories = _repositories(tmp_path)
    root = tmp_path / "project"
    root.mkdir()
    workspace = repositories.workspaces.create(
        workspace_id="ws-record",
        root_path=root,
        name="Record project",
    )
    session = repositories.sessions.create(
        session_id="ses-record",
        user_id="local-user",
        scene_id="desktop-agent",
        workspace_id=workspace.id,
        session_type="workspace",
        cwd=str(root.resolve()),
        workspace_roots=[str(root.resolve())],
        title="Record session",
    )

    assert workspace.archived_at is None
    assert workspace.is_archived is False
    assert session.archived_at is None
    assert session.archive_origin is None
    assert session.is_archived is False

    workspace_payload = WorkspaceService.serialize_workspace(workspace)
    session_payload = SessionService(
        repositories.sessions,
        repositories.message_events,
        repositories.workspaces,
        repositories.session_forks,
    )._serialize_session(session)

    assert workspace_payload["archived_at"] is None
    assert session_payload["archived_at"] is None
    assert session_payload["archive_origin"] is None
    assert "is_deleted" not in workspace_payload
    assert "is_deleted" not in session_payload
    assert "archived" not in session_payload


def test_archived_record_mappers_preserve_lifecycle_source(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    session = repositories.sessions.create(
        session_id="ses-archived-record",
        user_id="local-user",
        scene_id="desktop-agent",
        title="Archived record",
    )
    with repositories.db.transaction() as conn:
        conn.execute(
            """
            update sessions
            set archived_at = ?, archive_origin = 'manual'
            where id = ?
            """,
            ("2026-07-14T02:00:00Z", session.id),
        )

    archived = repositories.sessions.get_archived(session.id)

    assert archived is not None
    assert archived.archived_at == "2026-07-14T02:00:00Z"
    assert archived.archive_origin == "manual"
    assert archived.is_archived is True
    assert repositories.sessions.get(session.id) is None


def test_archived_tabs_are_disjoint_and_project_counts_are_aggregated(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    archived_root = tmp_path / "archived-project"
    active_root = tmp_path / "active-project"
    archived_root.mkdir()
    active_root.mkdir()
    archived_workspace = repositories.workspaces.create(
        workspace_id="ws-archived",
        root_path=archived_root,
        name="归档项目",
    )
    active_workspace = repositories.workspaces.create(
        workspace_id="ws-active",
        root_path=active_root,
        name="Active project",
    )
    for session_id, origin in (
        ("ses-project-1", "project"),
        ("ses-project-2", "project"),
        ("ses-manual-child", "manual"),
    ):
        repositories.sessions.create(
            session_id=session_id,
            user_id="local-user",
            scene_id="desktop-agent",
            workspace_id=archived_workspace.id,
            title=session_id,
        )
        _archive_session(repositories, session_id, "2026-07-14T03:00:00Z", origin)
    active_workspace_session = repositories.sessions.create(
        session_id="ses-active-workspace-manual",
        user_id="local-user",
        scene_id="desktop-agent",
        workspace_id=active_workspace.id,
        title="手动归档会话",
    )
    standalone_session = repositories.sessions.create(
        session_id="ses-standalone-manual",
        user_id="local-user",
        scene_id="desktop-agent",
        title="Standalone archived",
    )
    _archive_session(
        repositories,
        active_workspace_session.id,
        "2026-07-14T04:00:00Z",
    )
    _archive_session(repositories, standalone_session.id, "2026-07-14T05:00:00Z")
    _archive_workspace(repositories, archived_workspace.id, "2026-07-14T06:00:00Z")

    project_page = repositories.workspaces.list_archived()
    session_page = repositories.sessions.list_archived()

    assert project_page.has_more is False
    assert project_page.next_cursor is None
    assert len(project_page.items) == 1
    project = project_page.items[0]
    assert project.workspace.id == archived_workspace.id
    assert project.session_total == 3
    assert project.project_session_count == 2
    assert project.manual_session_count == 1
    assert {item.session.id for item in session_page.items} == {
        active_workspace_session.id,
        standalone_session.id,
    }


def test_archived_session_cursor_is_stable_for_equal_timestamps(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    archived_at = "2026-07-14T07:00:00Z"
    for index in range(7):
        session = repositories.sessions.create(
            session_id=f"ses-page-{index}",
            user_id="local-user",
            scene_id="desktop-agent",
            title=f"Page {index}",
        )
        _archive_session(repositories, session.id, archived_at)

    first = repositories.sessions.list_archived(limit=3)
    newer = repositories.sessions.create(
        session_id="ses-newer",
        user_id="local-user",
        scene_id="desktop-agent",
        title="Newer",
    )
    _archive_session(repositories, newer.id, "2026-07-14T08:00:00Z")
    second = repositories.sessions.list_archived(limit=3, cursor=first.next_cursor)
    third = repositories.sessions.list_archived(limit=3, cursor=second.next_cursor)

    seen = [
        *(item.session.id for item in first.items),
        *(item.session.id for item in second.items),
        *(item.session.id for item in third.items),
    ]
    assert len(seen) == 7
    assert len(set(seen)) == 7
    assert newer.id not in seen
    assert first.has_more is True
    assert second.has_more is True
    assert third.has_more is False
    assert third.next_cursor is None


def test_archived_search_treats_special_characters_as_literals(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    root = tmp_path / "MiXeD_100%"
    root.mkdir()
    workspace = repositories.workspaces.create(
        workspace_id="ws-search",
        root_path=root,
        name="中文项目 100%_quote'",
    )
    session = repositories.sessions.create(
        session_id="ses-search",
        user_id="local-user",
        scene_id="desktop-agent",
        workspace_id=workspace.id,
        title="中文会话 100%_quote'",
    )
    _archive_workspace(repositories, workspace.id, "2026-07-14T09:00:00Z")
    _archive_session(repositories, session.id, "2026-07-14T09:00:00Z")

    assert repositories.workspaces.list_archived(query="中文项目").items[0].workspace.id == workspace.id
    assert repositories.workspaces.list_archived(query="mixed_100%").items[0].workspace.id == workspace.id
    assert repositories.sessions.list_archived(query="100%_quote'", exclude_archived_workspaces=False).items[0].session.id == session.id
    assert repositories.sessions.list_archived(query="中文项目", exclude_archived_workspaces=False).items == []
    assert repositories.sessions.list_archived(workspace_ids=[workspace.id], exclude_archived_workspaces=False).items[0].session.id == session.id
    assert repositories.sessions.list_archived(query="%' or 1=1 --", exclude_archived_workspaces=False).items == []


def test_archived_list_rejects_invalid_cursor(tmp_path) -> None:
    repositories = _repositories(tmp_path)

    try:
        repositories.sessions.list_archived(cursor="not-a-cursor")
    except ValueError as exc:
        assert str(exc) == "归档列表 cursor 无效"
    else:
        raise AssertionError("invalid cursor should be rejected")


def test_session_archive_restore_round_trip_preserves_activity_fields(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    session = repositories.sessions.create(
        session_id="ses-round-trip",
        user_id="local-user",
        scene_id="desktop-agent",
        title="Round trip",
    )
    repositories.sessions.set_pinned(session.id, True)
    before = repositories.sessions.get(session.id)
    assert before is not None

    archived = repositories.sessions.archive_manual(
        session.id,
        archived_at="2026-07-14T10:00:00Z",
    )
    archived_again = repositories.sessions.archive_manual(
        session.id,
        archived_at="2026-07-14T11:00:00Z",
    )
    restored = repositories.sessions.restore(session.id)
    restored_again = repositories.sessions.restore(session.id)

    assert archived.changed is True
    assert archived.record is not None
    assert archived.record.archived_at == "2026-07-14T10:00:00Z"
    assert archived.record.archive_origin == "manual"
    assert archived_again.changed is False
    assert archived_again.record == archived.record
    assert restored.changed is True
    assert restored.record is not None
    assert restored.record.archived_at is None
    assert restored.record.archive_origin is None
    assert restored_again.changed is False
    before_payload = asdict(before)
    restored_payload = asdict(restored.record)
    before_payload.pop("archived_at")
    before_payload.pop("archive_origin")
    restored_payload.pop("archived_at")
    restored_payload.pop("archive_origin")
    assert restored_payload == before_payload


def test_manual_archive_does_not_overwrite_project_origin(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    session = repositories.sessions.create(
        session_id="ses-project-origin",
        user_id="local-user",
        scene_id="desktop-agent",
    )
    _archive_session(
        repositories,
        session.id,
        "2026-07-14T12:00:00Z",
        origin="project",
    )

    result = repositories.sessions.archive_manual(
        session.id,
        archived_at="2026-07-14T13:00:00Z",
    )

    assert result.changed is False
    assert result.record is not None
    assert result.record.archive_origin == "project"
    assert result.record.archived_at == "2026-07-14T12:00:00Z"


def test_concurrent_session_archive_has_single_winner(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    session = repositories.sessions.create(
        session_id="ses-concurrent",
        user_id="local-user",
        scene_id="desktop-agent",
    )

    def archive(archived_at: str):
        return repositories.sessions.archive_manual(session.id, archived_at=archived_at)

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(
            executor.map(
                archive,
                ("2026-07-14T14:00:00Z", "2026-07-14T15:00:00Z"),
            )
        )

    assert sum(result.changed for result in results) == 1
    persisted = repositories.sessions.get_archived(session.id)
    assert persisted is not None
    assert persisted.archived_at in {
        "2026-07-14T14:00:00Z",
        "2026-07-14T15:00:00Z",
    }


def test_session_lifecycle_commands_distinguish_missing_records(tmp_path) -> None:
    repositories = _repositories(tmp_path)

    archived = repositories.sessions.archive_manual(
        "missing-session",
        archived_at="2026-07-14T16:00:00Z",
    )
    restored = repositories.sessions.restore("missing-session")

    assert archived.changed is False
    assert archived.record is None
    assert restored.changed is False
    assert restored.record is None


def test_project_archive_and_restore_modes_preserve_origins(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    root = tmp_path / "project-lifecycle"
    root.mkdir()
    workspace = repositories.workspaces.create(
        workspace_id="ws-lifecycle",
        root_path=root,
        name="Lifecycle",
    )
    for session_id in ("ses-active-1", "ses-active-2"):
        repositories.sessions.create(
            session_id=session_id,
            user_id="local-user",
            scene_id="desktop-agent",
            workspace_id=workspace.id,
        )
    manual = repositories.sessions.create(
        session_id="ses-manual-preserved",
        user_id="local-user",
        scene_id="desktop-agent",
        workspace_id=workspace.id,
    )
    project = repositories.sessions.create(
        session_id="ses-project-preserved",
        user_id="local-user",
        scene_id="desktop-agent",
        workspace_id=workspace.id,
    )
    _archive_session(repositories, manual.id, "2026-07-13T01:00:00Z", "manual")
    _archive_session(repositories, project.id, "2026-07-13T02:00:00Z", "project")

    archived = repositories.workspaces.archive_project(
        workspace.id,
        archived_at="2026-07-14T01:00:00Z",
    )
    duplicate = repositories.workspaces.archive_project(
        workspace.id,
        archived_at="2026-07-14T02:00:00Z",
    )
    project_only = repositories.workspaces.restore_project_only(workspace.id)
    project_only_session = repositories.sessions.get_archived("ses-active-1")
    archived_again = repositories.workspaces.archive_project(
        workspace.id,
        archived_at="2026-07-14T03:00:00Z",
    )
    restored_all = repositories.workspaces.restore_with_project_sessions(workspace.id)

    assert archived.changed is True
    assert archived.newly_archived == 2
    assert archived.manual_preserved == 1
    assert archived.project_preserved == 1
    assert duplicate.changed is False
    assert duplicate.record is not None
    assert duplicate.record.archived_at == "2026-07-14T01:00:00Z"
    assert project_only.changed is True
    assert project_only.restored_sessions == 0
    assert project_only_session is not None
    assert archived_again.changed is True
    assert archived_again.newly_archived == 0
    assert archived_again.project_preserved == 3
    assert restored_all.changed is True
    assert restored_all.restored_sessions == 3
    assert repositories.sessions.get("ses-active-1") is not None
    assert repositories.sessions.get(project.id) is not None
    preserved_manual = repositories.sessions.get_archived(manual.id)
    assert preserved_manual is not None
    assert preserved_manual.archive_origin == "manual"
    assert preserved_manual.archived_at == "2026-07-13T01:00:00Z"


def test_project_archive_rolls_back_when_child_update_fails(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    root = tmp_path / "archive-rollback"
    root.mkdir()
    workspace = repositories.workspaces.create(
        workspace_id="ws-archive-rollback",
        root_path=root,
    )
    session = repositories.sessions.create(
        session_id="ses-archive-rollback",
        user_id="local-user",
        scene_id="desktop-agent",
        workspace_id=workspace.id,
    )
    with repositories.db.transaction() as conn:
        conn.execute(
            """
            create trigger fail_project_session_archive
            before update of archive_origin on sessions
            when new.archive_origin = 'project'
            begin
              select raise(abort, 'injected archive failure');
            end
            """
        )

    with pytest.raises(sqlite3.IntegrityError, match="injected archive failure"):
        repositories.workspaces.archive_project(
            workspace.id,
            archived_at="2026-07-14T04:00:00Z",
        )

    assert repositories.workspaces.get(workspace.id) is not None
    assert repositories.sessions.get(session.id) is not None


def test_project_restore_rolls_back_when_child_restore_fails(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    root = tmp_path / "restore-rollback"
    root.mkdir()
    workspace = repositories.workspaces.create(
        workspace_id="ws-restore-rollback",
        root_path=root,
    )
    session = repositories.sessions.create(
        session_id="ses-restore-rollback",
        user_id="local-user",
        scene_id="desktop-agent",
        workspace_id=workspace.id,
    )
    repositories.workspaces.archive_project(
        workspace.id,
        archived_at="2026-07-14T05:00:00Z",
    )
    with repositories.db.transaction() as conn:
        conn.execute(
            """
            create trigger fail_project_session_restore
            before update of archive_origin on sessions
            when old.archive_origin = 'project' and new.archive_origin is null
            begin
              select raise(abort, 'injected restore failure');
            end
            """
        )

    with pytest.raises(sqlite3.IntegrityError, match="injected restore failure"):
        repositories.workspaces.restore_with_project_sessions(workspace.id)

    assert repositories.workspaces.get_archived(workspace.id) is not None
    archived_session = repositories.sessions.get_archived(session.id)
    assert archived_session is not None
    assert archived_session.archive_origin == "project"


def test_project_archive_and_restore_1000_sessions_use_constant_updates_under_five_seconds(
    tmp_path,
    monkeypatch,
) -> None:
    repositories = _repositories(tmp_path)
    root = tmp_path / "bulk-project"
    root.mkdir()
    workspace = repositories.workspaces.create(
        workspace_id="ws-bulk",
        root_path=root,
    )
    rows = [
        (
            f"ses-bulk-{index}",
            "local-user",
            "desktop-agent",
            "active",
            workspace.id,
            "2026-07-14T00:00:00Z",
            "2026-07-14T00:00:00Z",
        )
        for index in range(1000)
    ]
    with repositories.db.transaction() as conn:
        conn.executemany(
            """
            insert into sessions (
              id, user_id, scene_id, status, workspace_id, created_at, updated_at
            ) values (?, ?, ?, ?, ?, ?, ?)
            """,
            rows,
        )
    statements: list[str] = []
    original_connect = repositories.db.connect

    def traced_connect():
        conn = original_connect()
        conn.set_trace_callback(statements.append)
        return conn

    monkeypatch.setattr(repositories.db, "connect", traced_connect)

    archive_started = perf_counter()
    result = repositories.workspaces.archive_project(
        workspace.id,
        archived_at="2026-07-14T06:00:00Z",
    )
    archive_elapsed = perf_counter() - archive_started

    updates = [statement for statement in statements if statement.lstrip().lower().startswith("update")]
    assert result.newly_archived == 1000
    assert sum("update workspaces" in statement.lower() for statement in updates) == 1
    assert sum("update sessions" in statement.lower() for statement in updates) == 1
    assert archive_elapsed < 5.0

    statements.clear()
    restore_started = perf_counter()
    restored = repositories.workspaces.restore_with_project_sessions(workspace.id)
    restore_elapsed = perf_counter() - restore_started

    restore_updates = [statement for statement in statements if statement.lstrip().lower().startswith("update")]
    assert restored.restored_sessions == 1000
    assert sum("update workspaces" in statement.lower() for statement in restore_updates) == 1
    assert sum("update sessions" in statement.lower() for statement in restore_updates) == 1
    assert restore_elapsed < 5.0
