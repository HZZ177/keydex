from __future__ import annotations

import os
from pathlib import Path

import pytest

from backend.app.git.access import GitAccessDenied, GitAncestorGrantStore
from backend.app.git.security import (
    GitParameterError,
    ensure_layout_matches,
    require_repository_scope,
    resolve_repo_path,
    resolve_repository_layout,
    validate_ref_name,
    validate_remote_name,
    validate_repo_relative_path,
    validate_revision,
)


def create_repo_layout(path: Path) -> None:
    (path / ".git" / "objects").mkdir(parents=True)
    (path / ".git" / "HEAD").write_text("ref: refs/heads/main\n", encoding="utf-8")


def test_rejects_path_traversal_option_injection_and_invalid_refs(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    create_repo_layout(repo)
    resolve_repository_layout(repo)

    for path in ["../outside", "-n", "/absolute", r"C:\outside", "bad\x00path"]:
        with pytest.raises(GitParameterError):
            validate_repo_relative_path(path)
    for ref in ["-upload-pack=evil", "refs/heads/a..b", "bad@{1", "bad.lock", "a b"]:
        with pytest.raises(GitParameterError):
            validate_ref_name(ref)
    assert validate_revision("HEAD") == "HEAD"
    assert validate_revision("a1b2c3d4") == "a1b2c3d4"
    with pytest.raises(GitParameterError):
        validate_remote_name("origin/main")


def test_resolves_git_file_for_worktree_without_expanding_file_scope(tmp_path: Path) -> None:
    common = tmp_path / "common.git" / "worktrees" / "child"
    common.mkdir(parents=True)
    worktree = tmp_path / "workspace" / "child"
    worktree.mkdir(parents=True)
    relative = os.path.relpath(common, worktree).replace("\\", "/")
    (worktree / ".git").write_text(f"gitdir: {relative}\n", encoding="utf-8")

    layout = resolve_repository_layout(worktree)
    assert layout.worktree_root == worktree.resolve()
    assert layout.git_dir == common.resolve()
    assert layout.bare is False
    ensure_layout_matches(layout, worktree)
    with pytest.raises(GitAccessDenied):
        ensure_layout_matches(layout, tmp_path / "other")


def test_scope_requires_explicit_ancestor_grant_and_binds_repository_identity(
    tmp_path: Path,
) -> None:
    ancestor = tmp_path / "repo"
    project = ancestor / "apps" / "project"
    project.mkdir(parents=True)
    create_repo_layout(ancestor)
    layout = resolve_repository_layout(ancestor)
    grants = GitAncestorGrantStore(tmp_path / "grants.json")

    with pytest.raises(GitAccessDenied):
        require_repository_scope(
            layout,
            workspace_id="workspace-a",
            project_root=project,
            repository_id="repo-a",
            grants=grants,
        )
    grants.authorize(
        workspace_id="workspace-a",
        project_root=project,
        repo_id="repo-a",
        repo_root=ancestor,
    )
    assert require_repository_scope(
        layout,
        workspace_id="workspace-a",
        project_root=project,
        repository_id="repo-a",
        grants=grants,
    ) == "ancestor_grant"
    with pytest.raises(GitAccessDenied):
        require_repository_scope(
            layout,
            workspace_id="workspace-a",
            project_root=project,
            repository_id="repo-other",
            grants=grants,
        )


def test_symlink_escape_is_rejected_when_supported(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    outside = tmp_path / "outside"
    create_repo_layout(repo)
    outside.mkdir()
    link = repo / "link"
    try:
        link.symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("symlink creation is unavailable")
    with pytest.raises(GitAccessDenied):
        resolve_repo_path(resolve_repository_layout(repo), "link/file.txt")
