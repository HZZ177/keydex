from __future__ import annotations

from pathlib import Path

import pytest

from backend.app.git.access import GitAccessDenied, GitWorktreeGrantStore


def test_worktree_grant_is_exact_persistent_and_parent_repository_scoped(
    tmp_path: Path,
) -> None:
    project = tmp_path / "workspace" / "project"
    external_parent = tmp_path / "external"
    target = external_parent / "topic"
    project.mkdir(parents=True)
    external_parent.mkdir()
    store_path = tmp_path / "data" / "worktree-grants.json"
    store = GitWorktreeGrantStore(store_path)

    grant = store.authorize(
        workspace_id="workspace-a",
        project_root=project,
        parent_repo_id="repo-a",
        worktree_path=target,
    )

    assert grant.scope == "git_worktree"
    reloaded = GitWorktreeGrantStore(store_path)
    assert reloaded.is_authorized(
        workspace_id="workspace-a",
        project_root=project,
        parent_repo_id="repo-a",
        worktree_path=target,
    )
    assert not reloaded.is_authorized(
        workspace_id="workspace-a",
        project_root=project,
        parent_repo_id="repo-b",
        worktree_path=target,
    )
    assert not reloaded.is_authorized(
        workspace_id="workspace-a",
        project_root=project,
        parent_repo_id="repo-a",
        worktree_path=external_parent / "sibling",
    )


def test_worktree_grant_never_follows_shared_git_directory_or_invalid_parent(
    tmp_path: Path,
) -> None:
    project = tmp_path / "workspace" / "project"
    project.mkdir(parents=True)
    store = GitWorktreeGrantStore(tmp_path / "grants.json")

    with pytest.raises(GitAccessDenied, match="inside the project"):
        store.authorize(
            workspace_id="workspace-a",
            project_root=project,
            parent_repo_id="repo-a",
            worktree_path=project / "topic",
        )
    with pytest.raises(GitAccessDenied, match="parent directory must exist"):
        store.authorize(
            workspace_id="workspace-a",
            project_root=project,
            parent_repo_id="repo-a",
            worktree_path=tmp_path / "missing" / "topic",
        )


def test_worktree_grant_revoke_is_exact(tmp_path: Path) -> None:
    project = tmp_path / "project"
    external = tmp_path / "external"
    project.mkdir()
    external.mkdir()
    target = external / "topic"
    store = GitWorktreeGrantStore(tmp_path / "grants.json")
    store.authorize(
        workspace_id="workspace-a",
        project_root=project,
        parent_repo_id="repo-a",
        worktree_path=target,
    )

    assert not store.revoke(
        workspace_id="workspace-a",
        project_root=project,
        parent_repo_id="repo-a",
        worktree_path=external / "other",
    )
    assert store.revoke(
        workspace_id="workspace-a",
        project_root=project,
        parent_repo_id="repo-a",
        worktree_path=target,
    )
    assert not store.is_authorized(
        workspace_id="workspace-a",
        project_root=project,
        parent_repo_id="repo-a",
        worktree_path=target,
    )
