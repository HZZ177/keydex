from __future__ import annotations

import pytest

from backend.app.security import WorkspacePathError, normalize_workspace_root_for_storage
from backend.app.storage import StorageRepositories, init_database


def _repositories(tmp_path) -> StorageRepositories:
    return StorageRepositories(init_database(tmp_path / "app.db"))


def test_workspace_repository_create_deduplicates_normalized_path(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    project = tmp_path / "Project"
    project.mkdir()

    first = repositories.workspaces.create(
        workspace_id="ws_first",
        root_path=project,
        name="Project",
    )
    second = repositories.workspaces.create(
        workspace_id="ws_second",
        root_path=project / ".",
        name="Duplicate",
    )

    assert second == first
    assert repositories.workspaces.get("ws_first") == first
    assert repositories.workspaces.get("ws_second") is None
    assert repositories.workspaces.list() == [first]
    assert first.normalized_root_path == normalize_workspace_root_for_storage(project)


def test_workspace_repository_validates_invalid_paths(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    file_path = tmp_path / "file.txt"
    file_path.write_text("not a directory", encoding="utf-8")

    with pytest.raises(WorkspacePathError, match="不能为空"):
        repositories.workspaces.create(workspace_id="ws_empty", root_path=" ")
    with pytest.raises(WorkspacePathError, match="不存在"):
        repositories.workspaces.create(workspace_id="ws_missing", root_path=tmp_path / "missing")
    with pytest.raises(WorkspacePathError, match="不是目录"):
        repositories.workspaces.create(workspace_id="ws_file", root_path=file_path)


def test_workspace_repository_updates_touches_and_sorts_by_recent_opened(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    alpha = tmp_path / "alpha"
    beta = tmp_path / "beta"
    alpha.mkdir()
    beta.mkdir()

    alpha_record = repositories.workspaces.create(
        workspace_id="ws_alpha",
        root_path=alpha,
        last_opened_at="2026-06-18T10:00:00Z",
    )
    beta_record = repositories.workspaces.create(
        workspace_id="ws_beta",
        root_path=beta,
        last_opened_at="2026-06-18T11:00:00Z",
    )

    assert [record.id for record in repositories.workspaces.list()] == [
        beta_record.id,
        alpha_record.id,
    ]

    renamed = repositories.workspaces.update(alpha_record.id, name="Alpha Renamed")
    assert renamed is not None
    assert renamed.name == "Alpha Renamed"

    touched = repositories.workspaces.touch(
        alpha_record.id,
        opened_at="2026-06-18T12:00:00Z",
    )
    assert touched is not None
    assert [record.id for record in repositories.workspaces.list()] == [
        alpha_record.id,
        beta_record.id,
    ]


def test_workspace_repository_archives_project_and_releases_active_root(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    project = tmp_path / "project"
    project.mkdir()
    workspace = repositories.workspaces.create(workspace_id="ws_project", root_path=project)
    session = repositories.sessions.create(
        session_id="ses_project",
        user_id="local-user",
        scene_id="desktop-agent",
        workspace_id=workspace.id,
        session_type="workspace",
        cwd=str(project.resolve()),
        workspace_roots=[str(project.resolve())],
    )

    archived = repositories.workspaces.archive_project(
        workspace.id,
        archived_at="2026-07-14T12:00:00Z",
    )

    assert archived.changed is True
    assert archived.record is not None
    assert archived.record.archived_at == "2026-07-14T12:00:00Z"
    assert repositories.workspaces.get(workspace.id) is None
    assert repositories.workspaces.get_archived(workspace.id) == archived.record
    assert repositories.sessions.get(session.id) is None
    archived_session = repositories.sessions.get_archived(session.id)
    assert archived_session is not None
    assert archived_session.archive_origin == "project"

    recreated = repositories.workspaces.create(
        workspace_id="ws_project_new",
        root_path=project,
        name="project-new",
    )
    assert recreated.id == "ws_project_new"
