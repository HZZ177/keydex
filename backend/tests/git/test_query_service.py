from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from backend.app.git.access import GitAncestorGrantStore
from backend.app.git.models import (
    GitApiError,
    GitCapabilityResponse,
    GitDiscoveryRequest,
    GitRepositoryRequest,
    GitWorktreePathsRequest,
)
from backend.app.git.query_service import (
    GitQueryService,
    decode_cursor,
    encode_cursor,
    repository_version,
)
from backend.app.git.runner import GitCliRunner


def _request(repo, repository_id: str) -> GitRepositoryRequest:
    return GitRepositoryRequest(
        workspace_id="workspace-query",
        project_root=str(repo.path),
        repository_id=repository_id,
    )


def test_git_capability_probe_is_reused_across_project_discovery(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    calls = 0

    def probe() -> GitCapabilityResponse:
        nonlocal calls
        calls += 1
        return GitCapabilityResponse(available=False, reason="test")

    monkeypatch.setattr("backend.app.git.query_service.probe_git_capabilities", probe)
    service = GitQueryService(grants=GitAncestorGrantStore(tmp_path / "grants.json"))
    request = GitDiscoveryRequest(workspace_id="workspace-query", project_root=str(tmp_path))

    service.discover(request)
    service.discover(request)

    assert calls == 1


@pytest.mark.asyncio
async def test_query_service_routes_real_status_refs_history_diff_and_blame(
    git_repo_factory,
    tmp_path: Path,
) -> None:
    repo = git_repo_factory.create("query")
    repo.run("switch", "-c", "topic")
    repo.write("README.md", "# changed\n")
    repo.write("new file.txt", "new\n")
    repo.write(".gitignore", "ignored.log\n")
    repo.run("add", "--", ".gitignore")
    repo.run("commit", "-m", "ignore fixture file")
    repo.write("ignored.log", "ignored\n")
    grants = GitAncestorGrantStore(tmp_path / "grants.json")
    service = GitQueryService(grants=grants)
    discovery = service.discover(
        GitDiscoveryRequest(workspace_id="workspace-query", project_root=str(repo.path))
    )
    request = _request(repo, discovery.repositories[0].id)

    status = await service.status(request)
    refs = await service.refs(request)
    history = await service.history(request, limit=1)
    diff = await service.diff(request)
    scoped_diff = await service.diff(request, path="README.md")
    blame = await service.blame(request, "README.md")
    reflog = await service.reflog(request, limit=20)

    assert status.branch.head == "topic"
    assert {item.path for item in status.files} == {"README.md", "new file.txt"}
    assert any(ref.short_name == "topic" and ref.current for ref in refs.refs)
    assert history.commits[0].subject == "ignore fixture file"
    assert diff.files[0].new_path == "README.md"
    assert [item.new_path for item in scoped_diff.files] == ["README.md"]
    with pytest.raises(GitApiError, match="traversal"):
        await service.diff(request, path="../README.md")
    assert blame.lines[0].filename == "README.md"
    assert blame.start_line == 1
    assert blame.next_start_line is None
    assert any(entry.action == "checkout" for entry in reflog.entries)
    versions = {status.repository_version, refs.repository_version, history.repository_version}
    assert len(versions) == 1


@pytest.mark.asyncio
async def test_query_cache_is_versioned_and_cursor_is_bound_to_repository(
    git_repo_factory,
    tmp_path: Path,
) -> None:
    repo = git_repo_factory.create("cache")
    grants = GitAncestorGrantStore(tmp_path / "grants.json")
    service = GitQueryService(grants=grants)
    discovery = service.discover(
        GitDiscoveryRequest(workspace_id="workspace-query", project_root=str(repo.path))
    )
    request = _request(repo, discovery.repositories[0].id)
    first = await service.status(request)

    repo.write("changed.txt", "new version\n")
    second = await service.status(request)
    assert second.repository_version == first.repository_version
    assert second is not first
    assert {item.path for item in second.files} == {"changed.txt"}

    repo.run("add", "--", "changed.txt")
    third = await service.status(request)
    assert third.repository_version != second.repository_version

    cursor = encode_cursor(request.repository_id, third.repository_version, 25)
    assert decode_cursor(cursor, request.repository_id, third.repository_version) == 25
    with pytest.raises(Exception, match="invalid or stale"):
        decode_cursor(cursor, "another-repo", third.repository_version)


@pytest.mark.asyncio
async def test_worktree_paths_returns_only_paths_relevant_to_git_refresh(
    git_repo_factory,
    tmp_path: Path,
) -> None:
    repo = git_repo_factory.create("worktree-paths")
    repo.write(".gitignore", "*.log\nignored-directory/\n")
    repo.run("add", "--", ".gitignore")
    repo.run("commit", "-m", "add ignore rules")
    repo.write("ignored.log", "ignored\n")
    repo.write("ignored-directory/cache.json", "{}\n")
    service = GitQueryService(grants=GitAncestorGrantStore(tmp_path / "grants.json"))
    discovery = service.discover(
        GitDiscoveryRequest(workspace_id="workspace-query", project_root=str(repo.path))
    )
    repository_id = discovery.repositories[0].id

    result = await service.worktree_paths(
        GitWorktreePathsRequest(
            workspace_id="workspace-query",
            project_root=str(repo.path),
            repository_id=repository_id,
            paths=["README.md", "ignored.log", "ignored-directory/cache.json"],
        )
    )

    assert result.repository_id == repository_id
    assert result.paths == ["README.md"]


@pytest.mark.asyncio
async def test_status_returns_post_query_repository_version_after_conflict_resolution(
    git_repo_factory,
    tmp_path: Path,
) -> None:
    repo = git_repo_factory.create("status-version")
    repo.create_conflict()
    repo.run("checkout", "--ours", "--", "conflict.txt")
    repo.run("add", "--", "conflict.txt")
    service = GitQueryService(grants=GitAncestorGrantStore(tmp_path / "grants.json"))
    discovery = service.discover(
        GitDiscoveryRequest(workspace_id="workspace-query", project_root=str(repo.path))
    )
    repository = discovery.repositories[0]

    status = await service.status(_request(repo, repository.id))

    assert status.repository_version == repository_version(repository)
    assert status.operation is not None
    assert status.operation.kind == "merge"


@pytest.mark.asyncio
async def test_status_disables_optional_index_locks(
    git_repo_factory,
    tmp_path: Path,
) -> None:
    class RecordingRunner:
        def __init__(self) -> None:
            self.delegate = GitCliRunner()
            self.environments: list[dict[str, str]] = []

        async def run(self, args, **kwargs):
            self.environments.append(dict(kwargs.get("env") or {}))
            return await self.delegate.run(args, **kwargs)

    repo = git_repo_factory.create("status-no-optional-locks")
    repo.write("README.md", "# changed\n")
    runner = RecordingRunner()
    service = GitQueryService(
        grants=GitAncestorGrantStore(tmp_path / "grants.json"),
        runner=runner,  # type: ignore[arg-type]
    )
    discovery = service.discover(
        GitDiscoveryRequest(workspace_id="workspace-query", project_root=str(repo.path))
    )

    await service.status(_request(repo, discovery.repositories[0].id))

    assert runner.environments
    assert all(
        environment["GIT_OPTIONAL_LOCKS"] == "0" for environment in runner.environments
    )


@pytest.mark.asyncio
async def test_identical_git_queries_share_one_inflight_execution(tmp_path: Path) -> None:
    service = GitQueryService(grants=GitAncestorGrantStore(tmp_path / "grants.json"))
    request = GitRepositoryRequest(
        workspace_id="workspace-query",
        project_root=str(tmp_path),
        repository_id="repo-a",
    )
    release = asyncio.Event()
    calls = 0

    async def query() -> str:
        nonlocal calls
        calls += 1
        await release.wait()
        return "shared"

    tasks = [
        asyncio.create_task(service.coalesced_query(request, "status", query))
        for _ in range(20)
    ]
    for _ in range(100):
        if calls == 1:
            break
        await asyncio.sleep(0)

    assert calls == 1
    release.set()
    assert await asyncio.gather(*tasks) == ["shared"] * 20


@pytest.mark.asyncio
async def test_abandoned_coalesced_query_cancels_its_underlying_work(tmp_path: Path) -> None:
    service = GitQueryService(grants=GitAncestorGrantStore(tmp_path / "grants.json"))
    request = GitRepositoryRequest(
        workspace_id="workspace-query",
        project_root=str(tmp_path),
        repository_id="repo-a",
    )
    started = asyncio.Event()
    cancelled = asyncio.Event()

    async def query() -> str:
        started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancelled.set()
            raise
        return "unreachable"

    task = asyncio.create_task(service.coalesced_query(request, "diff", query))
    await started.wait()
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task
    await asyncio.wait_for(cancelled.wait(), timeout=1)


@pytest.mark.asyncio
async def test_git_queries_coalesce_duplicates_and_use_the_global_concurrency_budget(
    tmp_path: Path,
) -> None:
    service = GitQueryService(
        grants=GitAncestorGrantStore(tmp_path / "grants.json"),
        max_concurrent_queries=2,
    )
    request_a = GitRepositoryRequest(
        workspace_id="workspace-query",
        project_root=str(tmp_path),
        repository_id="repo-a",
    )
    request_b = request_a.model_copy(update={"repository_id": "repo-b"})
    release = asyncio.Event()
    started: list[str] = []
    active_by_repository = {"repo-a": 0, "repo-b": 0}
    maximum_by_repository = {"repo-a": 0, "repo-b": 0}
    maximum_total = 0

    async def query(label: str, repository_id: str) -> str:
        nonlocal maximum_total
        started.append(label)
        active_by_repository[repository_id] += 1
        maximum_by_repository[repository_id] = max(
            maximum_by_repository[repository_id], active_by_repository[repository_id]
        )
        maximum_total = max(maximum_total, sum(active_by_repository.values()))
        await release.wait()
        active_by_repository[repository_id] -= 1
        return label

    tasks = [
        asyncio.create_task(
            service.coalesced_query(
                request_a, "status", lambda: query("a-status", "repo-a")
            )
        ),
        asyncio.create_task(
            service.coalesced_query(
                request_a, "diff", lambda: query("a-diff", "repo-a")
            )
        ),
        asyncio.create_task(
            service.coalesced_query(
                request_b, "status", lambda: query("b-status", "repo-b")
            )
        ),
    ]
    for _ in range(100):
        if len(started) == 2:
            break
        await asyncio.sleep(0)

    assert set(started) == {"a-status", "a-diff"}
    assert maximum_total == 2
    assert maximum_by_repository["repo-a"] == 2
    release.set()
    assert set(await asyncio.gather(*tasks)) == {"a-status", "a-diff", "b-status"}
    assert maximum_by_repository["repo-a"] == 2


@pytest.mark.asyncio
async def test_bare_repository_rejects_worktree_only_queries_without_running_git(
    git_repo_factory,
    tmp_path: Path,
) -> None:
    bare_root = git_repo_factory.create_bare("bare-query")
    service = GitQueryService(grants=GitAncestorGrantStore(tmp_path / "grants.json"))
    discovery = service.discover(
        GitDiscoveryRequest(workspace_id="workspace-query", project_root=str(bare_root))
    )
    repository = discovery.repositories[0]
    request = GitRepositoryRequest(
        workspace_id="workspace-query",
        project_root=str(bare_root),
        repository_id=repository.id,
    )

    assert repository.bare is True
    with pytest.raises(Exception, match="unavailable for a bare repository"):
        await service.status(request)
    with pytest.raises(Exception, match="unavailable for a bare repository"):
        await service.diff(request)
