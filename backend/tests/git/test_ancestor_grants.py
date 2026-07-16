from __future__ import annotations

from pathlib import Path

import pytest

from backend.app.git.access import GitAccessDenied, GitAncestorGrantStore
from backend.app.security.workspace import resolve_workspace_path


def test_ancestor_grant_is_explicit_persistent_and_project_scoped(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    project = repo / "apps" / "keydex"
    project.mkdir(parents=True)
    store_path = tmp_path / "data" / "git-ancestor-grants.json"
    store = GitAncestorGrantStore(store_path)

    with pytest.raises(GitAccessDenied):
        store.require_access(
            workspace_id="workspace-a",
            project_root=project,
            repo_id="repo-a",
            repo_root=repo,
        )

    grant = store.authorize(
        workspace_id="workspace-a",
        project_root=project,
        repo_id="repo-a",
        repo_root=repo,
    )
    assert grant.scope == "git_only"
    assert GitAncestorGrantStore(store_path).require_access(
        workspace_id="workspace-a",
        project_root=project,
        repo_id="repo-a",
        repo_root=repo,
    ) == "ancestor_grant"

    with pytest.raises(GitAccessDenied):
        store.require_access(
            workspace_id="workspace-b",
            project_root=project,
            repo_id="repo-a",
            repo_root=repo,
        )


def test_ancestor_grant_never_expands_generic_workspace_file_access(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    project = repo / "project"
    outside_file = repo / "private.txt"
    project.mkdir(parents=True)
    outside_file.write_text("sentinel", encoding="utf-8")
    store = GitAncestorGrantStore(tmp_path / "grants.json")
    store.authorize(
        workspace_id="workspace-a",
        project_root=project,
        repo_id="repo-a",
        repo_root=repo,
    )

    with pytest.raises(ValueError, match="路径不在工作区内"):
        resolve_workspace_path(outside_file, cwd=project, workspace_roots=[project])


def test_revoke_and_invalid_non_ancestor_authorization(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    project = repo / "project"
    project.mkdir(parents=True)
    store = GitAncestorGrantStore(tmp_path / "grants.json")

    with pytest.raises(GitAccessDenied, match="strict ancestor"):
        store.authorize(
            workspace_id="workspace-a",
            project_root=project,
            repo_id="same",
            repo_root=project,
        )

    store.authorize(
        workspace_id="workspace-a",
        project_root=project,
        repo_id="repo-a",
        repo_root=repo,
    )
    assert store.revoke(workspace_id="workspace-a", project_root=project) is True
    assert store.revoke(workspace_id="workspace-a", project_root=project) is False
    with pytest.raises(GitAccessDenied):
        store.require_access(
            workspace_id="workspace-a",
            project_root=project,
            repo_id="repo-a",
            repo_root=repo,
        )
