from __future__ import annotations

from dataclasses import asdict

import pytest

from backend.app.services.archive_lifecycle_service import (
    ArchiveLifecycleError,
    ArchiveLifecycleService,
)
from backend.app.services.session_service import SessionArchivedError, SessionService
from backend.app.services.workspace_service import WorkspaceArchivedError
from backend.app.storage import (
    THREAD_TASK_TYPE_GOAL,
    StorageRepositories,
    init_database,
)


def _repositories(tmp_path) -> StorageRepositories:
    return StorageRepositories(init_database(tmp_path / "app.db"))


def _workspace(repositories, tmp_path, workspace_id="ws-archive-service"):
    root = tmp_path / workspace_id
    root.mkdir()
    return repositories.workspaces.create(
        workspace_id=workspace_id,
        root_path=root,
        name=f"Project {workspace_id}",
    )


def _session(
    repositories,
    session_id: str,
    *,
    workspace_id: str | None = None,
    status: str = "active",
):
    return repositories.sessions.create(
        session_id=session_id,
        user_id="local-user",
        scene_id="desktop-agent",
        workspace_id=workspace_id,
        session_type="workspace" if workspace_id else "chat",
        status=status,
        title=f"Title {session_id}",
    )


def _add_all_blockers(repositories, session_id: str, cwd: str) -> None:
    repositories.command_approvals.create(
        approval_id=f"approval-{session_id}",
        session_id=session_id,
        command="secret command --token value",
        cwd=cwd,
        title="Sensitive approval title",
    )
    repositories.a2ui_interactions.create(
        interaction_id=f"a2ui-{session_id}",
        session_id=session_id,
        stream_id="stream-1",
        render_key="render-1",
        mode="interactive",
        payload={"secret": "payload"},
        input_schema={},
        submit_schema_snapshot={},
    )
    repositories.pending_inputs.create_or_get(
        session_id=session_id,
        message="sensitive queued user input",
        mode="queue",
    )
    task = repositories.thread_tasks.create(
        task_id=f"task-{session_id}",
        session_id=session_id,
        type=THREAD_TASK_TYPE_GOAL,
        objective="Sensitive task objective",
    )
    repositories.thread_task_runs.create_running(
        run_id=f"run-{session_id}",
        task_id=task.id,
        session_id=session_id,
    )


def _archive_session_direct(repositories, session_id: str, origin: str, archived_at: str) -> None:
    with repositories.db.transaction() as conn:
        conn.execute(
            "update sessions set archived_at = ?, archive_origin = ? where id = ?",
            (archived_at, origin, session_id),
        )


def test_preflight_reports_all_blocker_types_without_sensitive_content_or_writes(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    session = _session(repositories, "ses-preflight", status="running")
    _add_all_blockers(repositories, session.id, str(tmp_path))
    with repositories.db.connect() as conn:
        before = conn.execute("select * from sessions where id = ?", (session.id,)).fetchone()

    preflight = ArchiveLifecycleService(repositories).preflight_sessions([session.id])

    assert {item["type"] for item in preflight.blockers} == {
        "session_running",
        "command_approval",
        "a2ui_input",
        "pending_input",
        "thread_task",
        "thread_task_run",
    }
    assert preflight.blocker_count == 6
    serialized = repr(preflight.blockers)
    assert "secret command" not in serialized
    assert "sensitive queued" not in serialized
    assert str(tmp_path) not in serialized
    with repositories.db.connect() as conn:
        after = conn.execute("select * from sessions where id = ?", (session.id,)).fetchone()
    assert tuple(after) == tuple(before)


def test_stop_for_archive_closes_every_blocker_idempotently(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    session = _session(repositories, "ses-stop", status="running")
    _add_all_blockers(repositories, session.id, str(tmp_path))
    service = ArchiveLifecycleService(repositories)

    first = service.stop_sessions_for_archive([session.id])
    second = service.stop_sessions_for_archive([session.id])

    assert first.ready_to_archive is True
    assert second.ready_to_archive is True
    assert service.preflight_sessions([session.id]).ready_to_archive is True
    assert repositories.sessions.get(session.id).status == "closed"
    assert repositories.command_approvals.list_pending(session_id=session.id) == []
    assert repositories.a2ui_interactions.get_waiting_by_session(session.id) == []
    assert repositories.pending_inputs.list_active_by_session(session.id) == []
    assert repositories.thread_tasks.get_open_by_session(session.id) is None
    run = repositories.thread_task_runs.get(f"run-{session.id}")
    assert run is not None
    assert run.status == "cancelled"


def test_pending_input_preflight_and_stop_cover_steer_queue_starting_and_running(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    session = _session(repositories, "ses-pending-matrix")
    statuses = ("pending_steer", "queued", "starting", "running")
    with repositories.db.transaction() as conn:
        for index, status in enumerate(statuses):
            conn.execute(
                """
                insert into session_pending_inputs (
                  id, session_id, mode, status, message, created_at, updated_at
                ) values (?, ?, ?, ?, 'pending', 'now', 'now')
                """,
                (
                    f"pending-{index}",
                    session.id,
                    "steer" if status == "pending_steer" else "queue",
                    status,
                ),
            )
    service = ArchiveLifecycleService(repositories)

    preflight = service.preflight_sessions([session.id])
    pending = next(item for item in preflight.blockers if item["type"] == "pending_input")
    assert pending["count"] == 4

    stopped = service.stop_sessions_for_archive([session.id])

    assert stopped.ready_to_archive is True
    assert service.preflight_sessions([session.id]).ready_to_archive is True
    with repositories.db.connect() as conn:
        rows = conn.execute(
            """
            select status, error_code, lock_owner, lock_expires_at
            from session_pending_inputs where session_id = ? order by id
            """,
            (session.id,),
        ).fetchall()
    assert {row["status"] for row in rows} == {"cancelled"}
    assert {row["error_code"] for row in rows} == {"session_archived"}
    assert all(row["lock_owner"] is None and row["lock_expires_at"] is None for row in rows)


def test_manual_session_archive_requires_confirmation_then_preserves_fields(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    session = _session(repositories, "ses-manual-archive", status="running")
    repositories.sessions.set_pinned(session.id, True)
    before = repositories.sessions.get(session.id)
    assert before is not None
    service = ArchiveLifecycleService(repositories)

    with pytest.raises(ArchiveLifecycleError) as unconfirmed:
        service.archive_session(
            session.id,
            request_id="req-manual-unconfirmed",
            stop_if_active=False,
        )
    assert unconfirmed.value.code == "archive_requires_stop_confirmation"
    assert repositories.sessions.get(session.id) is not None

    result = service.archive_session(
        session.id,
        request_id="req-manual-confirmed",
        stop_if_active=True,
    )
    archived = repositories.sessions.get_archived(session.id)

    assert result["changed"] is True
    assert result["archive_origin"] == "manual"
    assert result["event"]["type"] == "session_archived"
    assert archived is not None
    before_payload = asdict(before)
    archived_payload = asdict(archived)
    for field in ("archived_at", "archive_origin", "status"):
        before_payload.pop(field)
        archived_payload.pop(field)
    assert archived_payload == before_payload


def test_archive_request_replay_has_no_second_event_and_payload_conflicts(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    session = _session(repositories, "ses-replay")
    service = ArchiveLifecycleService(repositories)

    first = service.archive_session(session.id, request_id="req-replay")
    replay = service.archive_session(session.id, request_id="req-replay")

    assert first["changed"] is True
    assert replay["replayed"] is True
    assert replay["event"] is None
    assert replay["operation_id"] == first["operation_id"]
    with pytest.raises(ArchiveLifecycleError) as conflict:
        service.archive_session(
            session.id,
            request_id="req-replay",
            stop_if_active=True,
        )
    assert conflict.value.code == "request_id_conflict"


def test_workspace_lock_blocks_child_session_restore(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    workspace = _workspace(repositories, tmp_path, "ws-lock-parent")
    session = _session(repositories, "ses-lock-child", workspace_id=workspace.id)
    _archive_session_direct(repositories, session.id, "manual", "2026-07-14T01:00:00Z")
    owner = repositories.lifecycle_operations.create_or_replay(
        request_id="req-owner-lock",
        entity_type="workspace",
        entity_id=workspace.id,
        action="archive",
        payload={},
    ).operation
    assert repositories.lifecycle_operations.acquire_lock(
        operation_id=owner.id,
        entity_type="workspace",
        entity_id=workspace.id,
    ) is True

    with pytest.raises(ArchiveLifecycleError) as locked:
        ArchiveLifecycleService(repositories).restore_session(
            session.id,
            request_id="req-child-restore-locked",
        )

    assert locked.value.code == "lifecycle_locked"
    assert repositories.sessions.get_archived(session.id) is not None


def test_project_archive_stops_successful_sessions_but_does_not_archive_on_stop_failure(
    tmp_path,
) -> None:
    repositories = _repositories(tmp_path)
    workspace = _workspace(repositories, tmp_path, "ws-stop-failure")
    first = _session(repositories, "ses-stop-first", workspace_id=workspace.id, status="running")
    second = _session(repositories, "ses-stop-second", workspace_id=workspace.id, status="running")
    service = ArchiveLifecycleService(
        repositories,
        stop_session_hook=lambda session_id: session_id != second.id,
    )

    with pytest.raises(ArchiveLifecycleError) as stopped:
        service.archive_workspace(
            workspace.id,
            request_id="req-workspace-stop-failure",
            stop_active_sessions=True,
        )

    assert stopped.value.code == "archive_stop_failed"
    assert repositories.workspaces.get(workspace.id) is not None
    assert repositories.sessions.get(first.id).status == "closed"
    assert repositories.sessions.get(second.id).status == "running"
    assert repositories.sessions.get(first.id).archived_at is None
    assert repositories.sessions.get(second.id).archived_at is None


def test_workspace_archive_returns_aggregate_counts_without_session_event_fanout(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    workspace = _workspace(repositories, tmp_path, "ws-aggregate")
    active = _session(repositories, "ses-project-active", workspace_id=workspace.id)
    manual = _session(repositories, "ses-project-manual", workspace_id=workspace.id)
    inherited = _session(repositories, "ses-project-inherited", workspace_id=workspace.id)
    _archive_session_direct(repositories, manual.id, "manual", "2026-07-13T01:00:00Z")
    _archive_session_direct(repositories, inherited.id, "project", "2026-07-13T02:00:00Z")

    result = ArchiveLifecycleService(repositories).archive_workspace(
        workspace.id,
        request_id="req-workspace-aggregate",
    )

    assert result["newly_archived"] == 1
    assert result["manual_preserved"] == 1
    assert result["project_preserved"] == 1
    assert result["event"].items() >= {
        "type": "workspace_archived",
        "workspace_id": workspace.id,
        "archived_at": result["archived_at"],
        "newly_archived": 1,
        "request_id": "req-workspace-aggregate",
        "changed": True,
    }.items()
    assert repositories.sessions.get_archived(active.id).archive_origin == "project"


def test_session_restore_rejects_archived_parent_with_safe_navigation_context(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    workspace = _workspace(repositories, tmp_path, "ws-restore-conflict")
    session = _session(repositories, "ses-restore-conflict", workspace_id=workspace.id)
    repositories.workspaces.archive_project(
        workspace.id,
        archived_at="2026-07-14T02:00:00Z",
    )

    with pytest.raises(ArchiveLifecycleError) as conflict:
        ArchiveLifecycleService(repositories).restore_session(
            session.id,
            request_id="req-restore-conflict",
        )

    assert conflict.value.code == "workspace_archived"
    assert conflict.value.details == {
        "workspace_id": workspace.id,
        "workspace_name": workspace.name,
        "archived_at": "2026-07-14T02:00:00Z",
    }
    assert str(tmp_path) not in repr(conflict.value.details)
    assert repositories.sessions.get_archived(session.id) is not None


def test_workspace_restore_modes_protect_manual_sessions_and_restore_legacy_project_sessions(
    tmp_path,
) -> None:
    repositories = _repositories(tmp_path)
    workspace = _workspace(repositories, tmp_path, "ws-restore-modes")
    project_session = _session(repositories, "ses-restore-project", workspace_id=workspace.id)
    manual_session = _session(repositories, "ses-restore-manual", workspace_id=workspace.id)
    _archive_session_direct(repositories, manual_session.id, "manual", "2026-07-13T01:00:00Z")
    repositories.workspaces.archive_project(
        workspace.id,
        archived_at="2026-07-14T03:00:00Z",
    )
    service = ArchiveLifecycleService(repositories)

    project_only = service.restore_workspace(
        workspace.id,
        request_id="req-project-only",
        mode="project_only",
    )
    with_sessions = service.restore_workspace(
        workspace.id,
        request_id="req-with-sessions",
        mode="with_project_sessions",
    )

    assert project_only["remaining_total"] == 2
    assert project_only["remaining_project"] == 1
    assert project_only["remaining_manual"] == 1
    assert with_sessions["changed"] is True
    assert with_sessions["restored_project_sessions"] == 1
    assert repositories.sessions.get(project_session.id) is not None
    preserved = repositories.sessions.get_archived(manual_session.id)
    assert preserved is not None
    assert preserved.archive_origin == "manual"
    assert preserved.archived_at == "2026-07-13T01:00:00Z"


def test_workspace_restore_modes_preserve_origin_across_multiple_archive_cycles(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    workspace = _workspace(repositories, tmp_path, "ws-restore-cycles")
    first_cycle = _session(repositories, "ses-first-cycle", workspace_id=workspace.id)
    manual = _session(repositories, "ses-manual-cycle", workspace_id=workspace.id)
    _archive_session_direct(repositories, manual.id, "manual", "2026-07-13T01:00:00Z")
    service = ArchiveLifecycleService(repositories)

    service.archive_workspace(workspace.id, request_id="req-cycle-archive-1")
    first_archived_at = repositories.sessions.get_archived(first_cycle.id).archived_at
    project_only = service.restore_workspace(
        workspace.id,
        request_id="req-cycle-project-only",
        mode="project_only",
    )
    second_cycle = _session(repositories, "ses-second-cycle", workspace_id=workspace.id)
    service.archive_workspace(workspace.id, request_id="req-cycle-archive-2")

    assert project_only["remaining_project"] == 1
    assert repositories.sessions.get_archived(first_cycle.id).archived_at == first_archived_at
    assert repositories.sessions.get_archived(first_cycle.id).archive_origin == "project"
    assert repositories.sessions.get_archived(second_cycle.id).archive_origin == "project"
    assert repositories.sessions.get_archived(manual.id).archive_origin == "manual"

    restored = service.restore_workspace(
        workspace.id,
        request_id="req-cycle-with-sessions",
        mode="with_project_sessions",
    )

    assert restored["restored_project_sessions"] == 2
    assert restored["remaining_manual"] == 1
    assert repositories.sessions.get(first_cycle.id) is not None
    assert repositories.sessions.get(second_cycle.id) is not None
    preserved_manual = repositories.sessions.get_archived(manual.id)
    assert preserved_manual is not None
    assert preserved_manual.archive_origin == "manual"


def test_workspace_archive_database_failure_releases_lock_and_retries_same_request(
    tmp_path,
    monkeypatch,
) -> None:
    repositories = _repositories(tmp_path)
    workspace = _workspace(repositories, tmp_path, "ws-archive-db-retry")
    session = _session(repositories, "ses-archive-db-retry", workspace_id=workspace.id)
    service = ArchiveLifecycleService(repositories)
    original_archive = repositories.workspaces.archive_project

    def fail_archive(*args, **kwargs):
        raise RuntimeError("injected archive database failure")

    monkeypatch.setattr(repositories.workspaces, "archive_project", fail_archive)
    with pytest.raises(RuntimeError, match="injected archive database failure"):
        service.archive_workspace(workspace.id, request_id="req-archive-db-retry")

    assert repositories.workspaces.get(workspace.id) is not None
    assert repositories.sessions.get(session.id) is not None
    operation = repositories.lifecycle_operations.get_by_request(
        entity_type="workspace",
        entity_id=workspace.id,
        request_id="req-archive-db-retry",
    )
    assert operation is not None
    assert operation.state == "planned"
    assert repositories.lifecycle_operations.release_locks(operation.id) == 0

    monkeypatch.setattr(repositories.workspaces, "archive_project", original_archive)
    completed = service.archive_workspace(workspace.id, request_id="req-archive-db-retry")

    assert completed["changed"] is True
    assert repositories.workspaces.get_archived(workspace.id) is not None
    assert repositories.sessions.get_archived(session.id).archive_origin == "project"


def test_catalog_tabs_are_disjoint_safe_and_read_only(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    archived_workspace = _workspace(repositories, tmp_path, "ws-catalog-archived")
    active_workspace = _workspace(repositories, tmp_path, "ws-catalog-active")
    hidden = _session(repositories, "ses-catalog-hidden", workspace_id=archived_workspace.id)
    visible = _session(repositories, "ses-catalog-visible", workspace_id=active_workspace.id)
    untitled = _session(repositories, "ses-catalog-untitled")
    repositories.sessions.update(untitled.id, title=" ")
    _archive_session_direct(repositories, visible.id, "manual", "2026-07-14T04:00:00Z")
    _archive_session_direct(repositories, untitled.id, "manual", "2026-07-14T05:00:00Z")
    repositories.workspaces.archive_project(
        archived_workspace.id,
        archived_at="2026-07-14T06:00:00Z",
    )
    before = repositories.workspaces.get(active_workspace.id)
    service = ArchiveLifecycleService(repositories)

    projects = service.list_archived_workspaces(limit=500)
    sessions = service.list_archived_sessions(limit=500)

    assert [item["id"] for item in projects["list"]] == [archived_workspace.id]
    assert "root_path" not in projects["list"][0]
    assert {item["id"] for item in sessions["list"]} == {visible.id, untitled.id}
    assert hidden.id not in {item["id"] for item in sessions["list"]}
    assert str(tmp_path) not in repr(projects)
    assert repositories.workspaces.get(active_workspace.id) == before


def test_normal_session_and_workspace_entry_points_reject_archived_entities(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    workspace = _workspace(repositories, tmp_path, "ws-entry-guard")
    session = _session(repositories, "ses-entry-guard")
    _archive_session_direct(repositories, session.id, "manual", "2026-07-14T07:00:00Z")
    repositories.workspaces.archive_project(
        workspace.id,
        archived_at="2026-07-14T07:00:00Z",
    )
    session_service = SessionService(
        repositories.sessions,
        repositories.message_events,
        repositories.workspaces,
        repositories.session_forks,
    )

    with pytest.raises(SessionArchivedError) as archived_session:
        session_service.get_session_detail(session.id)
    with pytest.raises(WorkspaceArchivedError):
        session_service.create_session(
            user_id="local-user",
            scene_id="desktop-agent",
            session_type="workspace",
            workspace_id=workspace.id,
        )

    assert archived_session.value.code == "entity_archived"
