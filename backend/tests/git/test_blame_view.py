from __future__ import annotations

from pathlib import Path

import pytest

from backend.app.git.access import GitAncestorGrantStore
from backend.app.git.models import GitApiError, GitDiscoveryRequest, GitRepositoryRequest
from backend.app.git.query_service import GitQueryService


@pytest.mark.asyncio
async def test_blame_pages_large_files_and_marks_working_tree_lines(
    git_repo_factory,
    tmp_path: Path,
) -> None:
    repo = git_repo_factory.create("blame-window")
    repo.write("large.txt", "".join(f"line {index}\n" for index in range(1, 451)))
    committed_oid = repo.commit("large file", "large.txt")
    lines = repo.path.joinpath("large.txt").read_text(encoding="utf-8").splitlines()
    lines[149] = "working line"
    repo.write("large.txt", "\n".join(lines) + "\n")
    service, request = _service(repo, tmp_path)

    first = await service.blame(request, "large.txt", line_count=100)
    second = await service.blame(request, "large.txt", start_line=101, line_count=100)
    committed = await service.blame(
        request,
        "large.txt",
        revision=committed_oid,
        start_line=145,
        line_count=10,
    )

    assert len(first.lines) == 100
    assert first.next_start_line == 101
    assert second.start_line == 101
    assert second.next_start_line == 201
    assert second.lines[49].final_line == 150
    assert second.lines[49].uncommitted is True
    assert committed.revision == committed_oid
    assert all(not line.uncommitted for line in committed.lines)
    assert committed.lines[5].content == "line 150"


@pytest.mark.asyncio
async def test_blame_follows_rename_and_applies_repo_scoped_ignore_revs(
    git_repo_factory,
    tmp_path: Path,
) -> None:
    repo = git_repo_factory.create("blame-rename")
    repo.write("old.txt", "alpha\nbeta\n")
    base_oid = repo.commit("old file", "old.txt")
    repo.run("mv", "old.txt", "renamed.txt")
    repo.commit("rename file", "renamed.txt")
    repo.write("renamed.txt", "alpha formatted\nbeta\n")
    ignored_oid = repo.commit("format alpha", "renamed.txt")
    repo.write(".git-blame-ignore-revs", f"{ignored_oid}\n")
    service, request = _service(repo, tmp_path)

    page = await service.blame(
        request,
        "renamed.txt",
        ignore_revs_file=".git-blame-ignore-revs",
        line_count=20,
    )

    assert page.ignore_revs_file == ".git-blame-ignore-revs"
    assert page.lines[0].object_id != ignored_oid
    assert any(line.object_id == base_oid for line in page.lines)
    assert any(line.filename in {"old.txt", "renamed.txt"} for line in page.lines)

    with pytest.raises(GitApiError, match="does not exist"):
        await service.blame(
            request,
            "renamed.txt",
            ignore_revs_file="missing-ignore-revs",
        )


def _service(repo, tmp_path: Path) -> tuple[GitQueryService, GitRepositoryRequest]:
    service = GitQueryService(grants=GitAncestorGrantStore(tmp_path / "blame-grants.json"))
    discovery = service.discover(
        GitDiscoveryRequest(workspace_id="workspace-blame", project_root=str(repo.path))
    )
    return service, GitRepositoryRequest(
        workspace_id="workspace-blame",
        project_root=str(repo.path),
        repository_id=discovery.repositories[0].id,
    )
