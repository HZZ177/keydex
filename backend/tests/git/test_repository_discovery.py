from __future__ import annotations

from pathlib import Path

import pytest

from backend.app.git.access import GitAncestorGrantStore
from backend.app.git.discovery import discover_git_repositories, repository_id
from backend.app.git.models import GitCapabilityResponse, GitDiscoveryRequest
from backend.app.git.security import resolve_repository_layout

CAPABILITY = GitCapabilityResponse(available=True, executable="git", version="2.49.0")


def discover(path: Path, grants: GitAncestorGrantStore, **kwargs):
    return discover_git_repositories(
        GitDiscoveryRequest(workspace_id="workspace-a", project_root=str(path), **kwargs),
        grants=grants,
        capability=CAPABILITY,
    )


def test_discovers_workspace_sibling_and_nested_roots_without_collapsing_them(
    git_repo_factory,
    tmp_path: Path,
) -> None:
    workspace = git_repo_factory.create("workspace").path
    nested = workspace / "packages" / "nested"
    nested.mkdir(parents=True)
    git_repo_factory.root = nested.parent
    nested_repo = git_repo_factory.create("nested").path
    grants = GitAncestorGrantStore(tmp_path / "grants.json")

    response = discover(workspace, grants)
    assert [item.display_path for item in response.repositories] == [
        ".",
        f"packages/{nested_repo.name}",
    ]
    assert response.repositories[0].kind == "workspace"
    assert response.repositories[1].kind == "nested"
    assert response.repositories[1].parent_repo_id == response.repositories[0].id


def test_ignores_nested_repositories_under_gitignored_directories(
    git_repo_factory,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    workspace_repo = git_repo_factory.create("workspace-ignored")
    workspace = workspace_repo.path
    workspace_repo.write(".gitignore", "/.dev/\n/actions-runner/\n")
    workspace_repo.run("add", ".gitignore")
    workspace_repo.run("commit", "-m", "test: ignore runtime directories")
    ignored_roots = [workspace / ".dev" / "test", workspace / "actions-runner" / "_work"]
    for index, root in enumerate(ignored_roots):
        root.mkdir(parents=True)
        git_repo_factory.root = root
        git_repo_factory.create(f"nested-{index}")
    grants = GitAncestorGrantStore(tmp_path / "grants.json")
    visited: list[Path] = []
    original_resolve = resolve_repository_layout

    def tracked_resolve(path: str | Path):
        candidate = Path(path).resolve()
        visited.append(candidate)
        return original_resolve(candidate)

    monkeypatch.setattr("backend.app.git.discovery.resolve_repository_layout", tracked_resolve)

    response = discover(workspace, grants)

    assert [item.display_path for item in response.repositories] == ["."]
    assert all(
        not candidate.is_relative_to(ignored_root)
        for candidate in visited
        for ignored_root in ignored_roots
    )


def test_reports_nearest_ancestor_as_pending_then_granted(git_repo_factory, tmp_path: Path) -> None:
    ancestor = git_repo_factory.create("ancestor").path
    project = ancestor / "apps" / "project"
    project.mkdir(parents=True)
    grants = GitAncestorGrantStore(tmp_path / "grants.json")

    pending = discover(project, grants)
    assert pending.repositories == []
    assert pending.ancestor_candidate is not None
    assert pending.ancestor_candidate.ancestor_authorization == "pending"

    layout = resolve_repository_layout(ancestor)
    grants.authorize(
        workspace_id="workspace-a",
        project_root=project,
        repo_id=repository_id(layout),
        repo_root=ancestor,
    )
    granted = discover(project, grants)
    assert granted.ancestor_candidate is not None
    assert granted.ancestor_candidate.ancestor_authorization == "granted"


def test_respects_depth_and_directory_limits(git_repo_factory, tmp_path: Path) -> None:
    workspace = git_repo_factory.create("limits").path
    deep = workspace / "a" / "b" / "c"
    deep.mkdir(parents=True)
    git_repo_factory.root = deep.parent
    git_repo_factory.create("deep")
    grants = GitAncestorGrantStore(tmp_path / "grants.json")

    shallow = discover(workspace, grants, max_depth=1)
    assert len(shallow.repositories) == 1
    with pytest.raises(ValueError, match="directory limit"):
        discover(workspace, grants, max_directories=1)


def test_missing_git_capability_returns_actionable_empty_discovery(tmp_path: Path) -> None:
    response = discover_git_repositories(
        GitDiscoveryRequest(workspace_id="workspace-a", project_root=str(tmp_path)),
        grants=GitAncestorGrantStore(tmp_path / "grants.json"),
        capability=GitCapabilityResponse(available=False, reason="git executable was not found"),
    )
    assert response.repositories == []
    assert response.capability.reason == "git executable was not found"
