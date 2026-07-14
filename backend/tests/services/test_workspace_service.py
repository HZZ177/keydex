from __future__ import annotations

import pytest

from backend.app.services import (
    WorkspaceArchivedError,
    WorkspaceNotFoundError,
    WorkspaceService,
    WorkspaceServiceError,
)
from backend.app.storage import StorageRepositories, init_database


def _repositories(tmp_path) -> StorageRepositories:
    return StorageRepositories(init_database(tmp_path / "app.db"))


def _service(repositories: StorageRepositories) -> WorkspaceService:
    return WorkspaceService(repositories.workspaces)


def test_workspace_service_creates_lists_renames_and_touches(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    service = _service(repositories)
    project = tmp_path / "project"
    project.mkdir()

    created = service.create_workspace(root_path=project, name="项目")
    duplicated = service.create_workspace(root_path=project / ".", name="重复")
    renamed = service.rename_workspace(created["id"], "新项目")
    touched = service.touch_workspace(created["id"])
    listed = service.list_workspaces()

    assert duplicated["id"] == created["id"]
    assert renamed["name"] == "新项目"
    assert touched["last_opened_at"] is not None
    assert listed["total"] == 1
    assert listed["list"][0]["id"] == created["id"]


def test_workspace_service_maps_path_errors(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    service = _service(repositories)
    file_path = tmp_path / "file.txt"
    file_path.write_text("x", encoding="utf-8")

    cases = [
        (" ", "workspace_path_empty"),
        (tmp_path / "missing", "workspace_path_not_found"),
        (file_path, "workspace_not_directory"),
    ]

    for root_path, code in cases:
        with pytest.raises(WorkspaceServiceError) as exc:
            service.create_workspace(root_path=root_path)
        assert exc.value.code == code


def test_workspace_service_distinguishes_missing_and_archived_workspace(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    service = _service(repositories)
    project = tmp_path / "project"
    project.mkdir()
    workspace = service.create_workspace(root_path=project)

    with pytest.raises(WorkspaceNotFoundError) as missing:
        service.get_workspace("missing")
    assert missing.value.code == "workspace_not_found"

    repositories.workspaces.archive_project(
        workspace["id"],
        archived_at="2026-07-14T12:00:00Z",
    )

    with pytest.raises(WorkspaceArchivedError) as archived:
        service.get_workspace(workspace["id"])
    assert archived.value.code == "workspace_archived"


def test_workspace_service_builds_runtime_context_for_session(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    service = _service(repositories)
    project = tmp_path / "project"
    project.mkdir()
    workspace = service.create_workspace(root_path=project)
    session = repositories.sessions.create(
        session_id="ses_project",
        user_id="local-user",
        scene_id="desktop-agent",
        workspace_id=workspace["id"],
        session_type="workspace",
        cwd=str(project),
        workspace_roots=[str(project)],
    )

    context = service.runtime_context_for_session(session)

    assert context.workspace_id == workspace["id"]
    assert context.cwd == project.resolve()
    assert context.workspace_roots == [project.resolve()]


def test_workspace_service_rejects_invalid_session_workspace_binding(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    service = _service(repositories)
    project = tmp_path / "project"
    outside = tmp_path / "outside"
    project.mkdir()
    outside.mkdir()
    workspace = service.create_workspace(root_path=project)
    chat_session = repositories.sessions.create(
        session_id="ses_chat",
        user_id="local-user",
        scene_id="desktop-agent",
    )
    missing_binding = repositories.sessions.create(
        session_id="ses_missing_binding",
        user_id="local-user",
        scene_id="desktop-agent",
        session_type="workspace",
    )
    outside_session = repositories.sessions.create(
        session_id="ses_outside",
        user_id="local-user",
        scene_id="desktop-agent",
        workspace_id=workspace["id"],
        session_type="workspace",
        cwd=str(outside),
        workspace_roots=[str(project)],
    )

    with pytest.raises(WorkspaceServiceError) as chat_error:
        service.runtime_context_for_session(chat_session)
    assert chat_error.value.code == "session_not_workspace"

    with pytest.raises(WorkspaceServiceError) as missing_error:
        service.runtime_context_for_session(missing_binding)
    assert missing_error.value.code == "session_workspace_missing"

    with pytest.raises(WorkspaceServiceError) as outside_error:
        service.runtime_context_for_session(outside_session)
    assert outside_error.value.code == "session_cwd_forbidden"
