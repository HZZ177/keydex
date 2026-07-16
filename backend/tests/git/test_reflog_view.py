from __future__ import annotations

from pathlib import Path

import pytest

from backend.app.git.access import GitAncestorGrantStore
from backend.app.git.models import GitApiError, GitDiscoveryRequest, GitRepositoryRequest
from backend.app.git.query_service import GitQueryService


@pytest.mark.asyncio
async def test_reflog_pages_head_and_branch_entries_with_action_mapping(
    git_repo_factory,
    tmp_path: Path,
) -> None:
    repo = git_repo_factory.create("reflog-view")
    repo.write("one.txt", "one\n")
    first_oid = repo.commit("first", "one.txt")
    repo.run("switch", "-c", "topic")
    repo.write("topic.txt", "topic\n")
    topic_oid = repo.commit("topic", "topic.txt")
    repo.run("switch", "main")
    service, request = _service(repo, tmp_path)

    head_page = await service.reflog(request, ref="HEAD", limit=2)
    branch_page = await service.reflog(request, ref="topic", limit=10)

    assert head_page.ref == "HEAD"
    assert len(head_page.entries) == 2
    assert head_page.next_cursor is not None
    assert any(entry.action == "checkout" for entry in head_page.entries)
    assert branch_page.ref == "topic"
    assert branch_page.entries[0].object_id == topic_oid
    assert branch_page.entries[0].action == "commit"
    assert any(entry.object_id == first_oid for entry in branch_page.entries)

    next_page = await service.reflog(
        request,
        ref="HEAD",
        cursor=head_page.next_cursor,
        limit=2,
    )
    assert {entry.selector for entry in head_page.entries}.isdisjoint(
        entry.selector for entry in next_page.entries
    )


@pytest.mark.asyncio
async def test_reflog_rejects_option_shaped_ref(
    git_repo_factory,
    tmp_path: Path,
) -> None:
    repo = git_repo_factory.create("reflog-invalid")
    service, request = _service(repo, tmp_path)
    with pytest.raises(GitApiError, match="Invalid Git ref name") as error:
        await service.reflog(request, ref="--all")
    assert error.value.payload.code == "git_validation_failed"


def _service(repo, tmp_path: Path) -> tuple[GitQueryService, GitRepositoryRequest]:
    service = GitQueryService(grants=GitAncestorGrantStore(tmp_path / "reflog-grants.json"))
    discovery = service.discover(
        GitDiscoveryRequest(workspace_id="workspace-reflog", project_root=str(repo.path))
    )
    return service, GitRepositoryRequest(
        workspace_id="workspace-reflog",
        project_root=str(repo.path),
        repository_id=discovery.repositories[0].id,
    )
