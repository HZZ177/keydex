from __future__ import annotations

from pathlib import Path

import pytest

from backend.app.git.access import GitAncestorGrantStore
from backend.app.git.models import GitApiError, GitDiscoveryRequest, GitRepositoryRequest
from backend.app.git.query_service import GitQueryService


@pytest.mark.asyncio
async def test_commit_detail_exposes_metadata_files_stats_and_root_diff(
    git_repo_factory,
    tmp_path: Path,
) -> None:
    repo = git_repo_factory.create("commit-detail")
    service, request = _service(repo, tmp_path)
    root_oid = repo.run("rev-parse", "HEAD").stdout.strip()

    root = await service.commit_detail(request, root_oid)

    assert root.commit.object_id == root_oid
    assert root.commit.signature == "unsigned"
    assert root.commit.author_name == "Keydex E2E"
    assert root.selected_parent_id is None
    assert [(item.new_path, item.additions, item.deletions) for item in root.files] == [
        ("README.md", 1, 0)
    ]

    repo.write("asset.bin", "\x00\x01\x02")
    binary_oid = repo.commit("add binary", "asset.bin")
    binary = await service.commit_detail(request, binary_oid)
    assert binary.files[0].new_path == "asset.bin"
    assert binary.files[0].binary is True


@pytest.mark.asyncio
async def test_merge_commit_detail_switches_parent_and_rejects_unrelated_parent(
    git_repo_factory,
    tmp_path: Path,
) -> None:
    repo = git_repo_factory.create("merge-detail")
    repo.run("switch", "-c", "topic")
    repo.write("topic.txt", "topic\n")
    topic_oid = repo.commit("topic change", "topic.txt")
    repo.run("switch", "main")
    repo.write("main.txt", "main\n")
    main_oid = repo.commit("main change", "main.txt")
    repo.run("merge", "--no-ff", "topic", "-m", "merge topic")
    merge_oid = repo.run("rev-parse", "HEAD").stdout.strip()
    service, request = _service(repo, tmp_path)

    default_detail = await service.commit_detail(request, merge_oid)
    topic_detail = await service.commit_detail(request, merge_oid, parent=topic_oid)

    assert default_detail.commit.parent_ids == [main_oid, topic_oid]
    assert default_detail.selected_parent_id == main_oid
    assert {item.new_path for item in default_detail.files} == {"topic.txt"}
    assert topic_detail.selected_parent_id == topic_oid
    assert {item.new_path for item in topic_detail.files} == {"main.txt"}

    unrelated = repo.run("rev-parse", f"{main_oid}^").stdout.strip()
    with pytest.raises(GitApiError, match="does not belong") as error:
        await service.commit_detail(request, merge_oid, parent=unrelated)
    assert error.value.payload.code == "git_validation_failed"


def _service(repo, tmp_path: Path) -> tuple[GitQueryService, GitRepositoryRequest]:
    service = GitQueryService(grants=GitAncestorGrantStore(tmp_path / "detail-grants.json"))
    discovery = service.discover(
        GitDiscoveryRequest(workspace_id="workspace-detail", project_root=str(repo.path))
    )
    return service, GitRepositoryRequest(
        workspace_id="workspace-detail",
        project_root=str(repo.path),
        repository_id=discovery.repositories[0].id,
    )
