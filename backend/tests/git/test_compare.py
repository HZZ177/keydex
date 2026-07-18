from __future__ import annotations

from pathlib import Path

import pytest

from backend.app.git.access import GitAncestorGrantStore
from backend.app.git.models import GitApiError, GitDiscoveryRequest, GitRepositoryRequest
from backend.app.git.query_service import GitQueryService


@pytest.mark.asyncio
async def test_compare_preserves_two_dot_three_dot_and_commit_parent_semantics(
    git_repo_factory,
    tmp_path: Path,
) -> None:
    repo = git_repo_factory.create("compare")
    base_oid = repo.run("rev-parse", "HEAD").stdout.strip()
    repo.run("switch", "-c", "topic")
    repo.write("topic.txt", "topic\n")
    topic_oid = repo.commit("topic", "topic.txt")
    repo.run("switch", "main")
    repo.write("main.txt", "main\n")
    main_oid = repo.commit("main", "main.txt")
    service, request = _service(repo, tmp_path)

    two_dot = await service.compare(request, mode="two_dot", left="main", right="topic")
    three_dot = await service.compare(request, mode="three_dot", left="main", right="topic")
    parent = await service.compare(
        request,
        mode="commit",
        left=base_oid,
        right=main_oid,
    )

    assert two_dot.left_object_id == main_oid
    assert two_dot.right_object_id == topic_oid
    assert two_dot.comparison_base_object_id == main_oid
    assert two_dot.merge_base_object_id is None
    assert {item.new_path or item.old_path for item in two_dot.files} == {"main.txt", "topic.txt"}

    assert three_dot.merge_base_object_id == base_oid
    assert three_dot.comparison_base_object_id == base_oid
    assert {item.new_path or item.old_path for item in three_dot.files} == {"topic.txt"}

    assert parent.left_label == base_oid
    assert parent.right_label == main_oid
    assert {item.new_path for item in parent.files} == {"main.txt"}


@pytest.mark.asyncio
async def test_compare_working_tree_and_validation_are_explicit(
    git_repo_factory,
    tmp_path: Path,
) -> None:
    repo = git_repo_factory.create("compare-working")
    repo.write("README.md", "working change\n")
    repo.write("new.txt", "untracked is intentionally not in git diff\n")
    service, request = _service(repo, tmp_path)

    working = await service.compare(request, mode="working_tree", left="HEAD")
    selected = await service.compare(
        request,
        mode="working_tree",
        left="HEAD",
        path="README.md",
    )
    assert working.right_label == "Working tree"
    assert working.right_object_id is None
    assert working.left_object_id == working.comparison_base_object_id
    assert {item.new_path for item in working.files} == {"README.md"}
    assert working.files[0].raw_patch == ""
    assert working.files[0].hunks == []
    assert len(selected.files) == 1
    assert selected.files[0].new_path == "README.md"
    assert selected.files[0].raw_patch.startswith("diff --git ")
    assert selected.files[0].hunks

    with pytest.raises(GitApiError, match="requires two revisions"):
        await service.compare(request, mode="three_dot", left="HEAD")
    with pytest.raises(GitApiError, match="Invalid Git ref name"):
        await service.compare(request, mode="two_dot", left="--all", right="HEAD")
    with pytest.raises(GitApiError, match="was not found") as missing:
        await service.compare(request, mode="two_dot", left="missing", right="HEAD")
    assert missing.value.payload.code == "git_repository_not_found"


def _service(repo, tmp_path: Path) -> tuple[GitQueryService, GitRepositoryRequest]:
    service = GitQueryService(grants=GitAncestorGrantStore(tmp_path / "compare-grants.json"))
    discovery = service.discover(
        GitDiscoveryRequest(workspace_id="workspace-compare", project_root=str(repo.path))
    )
    return service, GitRepositoryRequest(
        workspace_id="workspace-compare",
        project_root=str(repo.path),
        repository_id=discovery.repositories[0].id,
    )
