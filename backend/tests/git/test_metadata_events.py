from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from backend.app.git.access import GitAncestorGrantStore
from backend.app.git.events import GitMetadataEventService, git_metadata_domains
from backend.app.git.models import GitDiscoveryRequest, GitRepositoryRequest
from backend.app.git.query_service import GitQueryService


class Subscriber:
    def __init__(self) -> None:
        self.events: list[dict] = []

    async def send(self, *, session_id, action, data):
        self.events.append({"session_id": session_id, "action": action, "data": data})
        return True


def test_git_metadata_path_domain_map_is_precise() -> None:
    assert git_metadata_domains("index") == {"status", "diff"}
    assert git_metadata_domains("index.lock") == set()
    assert git_metadata_domains("refs/heads/main") == {"status", "refs", "history"}
    assert git_metadata_domains("logs/HEAD") == {"history", "reflog"}
    assert git_metadata_domains("rebase-merge/msgnum") == {"status", "operation"}
    assert git_metadata_domains("objects/ab/cdef") == set()


@pytest.mark.asyncio
async def test_metadata_batch_coalesces_domains_invalidates_once_and_versions_event(
    git_repo_factory,
    tmp_path: Path,
) -> None:
    repo = git_repo_factory.create("events")
    query = GitQueryService(grants=GitAncestorGrantStore(tmp_path / "grants.json"))
    repository = query.discover(
        GitDiscoveryRequest(workspace_id="workspace-events", project_root=str(repo.path))
    ).repositories[0]
    invalidated: list[str] = []
    service = GitMetadataEventService(
        invalidate=invalidated.append,
        start_tasks=False,
    )
    subscriber = Subscriber()
    await service.subscribe(repository, subscriber)

    await service.handle_raw_changes(
        repository.id,
        [
            ("modified", Path(repository.git_dir_path) / "index"),
            ("modified", Path(repository.git_dir_path) / "refs" / "heads" / "main"),
            ("modified", Path(repository.git_dir_path) / "objects" / "ignored"),
        ],
    )

    assert invalidated == [repository.id]
    assert len(subscriber.events) == 1
    payload = subscriber.events[0]["data"]
    assert payload["sequence"] == 1
    assert payload["repository_version"]
    assert payload["domains"] == ["diff", "history", "refs", "status"]
    await service.close()


@pytest.mark.asyncio
async def test_read_only_status_and_diff_do_not_emit_metadata_refresh(
    git_repo_factory,
    tmp_path: Path,
) -> None:
    repo = git_repo_factory.create("read-only-events")
    repo.write("README.md", "# changed\n")
    query = GitQueryService(grants=GitAncestorGrantStore(tmp_path / "grants.json"))
    repository = query.discover(
        GitDiscoveryRequest(workspace_id="workspace-events", project_root=str(repo.path))
    ).repositories[0]
    request = GitRepositoryRequest(
        workspace_id="workspace-events",
        project_root=str(repo.path),
        repository_id=repository.id,
    )
    service = GitMetadataEventService(invalidate=query.invalidate)
    subscriber = Subscriber()
    await service.subscribe(repository, subscriber)
    try:
        await asyncio.sleep(0.2)
        await query.status(request)
        await query.diff(request)
        await asyncio.sleep(0.4)

        assert subscriber.events == []
    finally:
        await service.close()


@pytest.mark.asyncio
async def test_real_git_directory_watcher_reports_external_branch_creation(
    git_repo_factory,
    tmp_path: Path,
) -> None:
    repo = git_repo_factory.create("real-events")
    query = GitQueryService(grants=GitAncestorGrantStore(tmp_path / "grants.json"))
    repository = query.discover(
        GitDiscoveryRequest(workspace_id="workspace-events", project_root=str(repo.path))
    ).repositories[0]
    service = GitMetadataEventService(invalidate=query.invalidate)
    subscriber = Subscriber()
    await service.subscribe(repository, subscriber)
    try:
        await asyncio.sleep(0.2)
        repo.run("branch", "external-refresh")
        async with asyncio.timeout(10):
            while not subscriber.events:
                await asyncio.sleep(0.05)

        payload = subscriber.events[-1]["data"]
        assert "refs" in payload["domains"]
        assert any(path.endswith("refs/heads/external-refresh") for path in payload["paths"])
    finally:
        await service.close()
