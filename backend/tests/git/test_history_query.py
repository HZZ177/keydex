from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from backend.app.git.access import GitAncestorGrantStore
from backend.app.git.history_query import GitHistoryQuery, build_history_log_args
from backend.app.git.models import GitApiError, GitDiscoveryRequest, GitRepositoryRequest
from backend.app.git.query_service import GitQueryService
from backend.app.git.security import GitParameterError


def test_history_query_builder_combines_filters_and_separates_pathspec() -> None:
    args = build_history_log_args(
        GitHistoryQuery(
            text="release [literal]",
            revision="feature/topic",
            author="Alice Example",
            since="2026-01-01",
            until="2026-07-16T23:59:59+08:00",
            path="src/history view.tsx",
            first_parent=True,
            merges_only=True,
        ),
        offset=25,
        limit=50,
    )

    assert args[0:3] == ["log", "--topo-order", "--date-order"]
    assert "--max-count=51" in args
    assert "--skip=25" in args
    assert "--fixed-strings" in args
    assert "--grep=release [literal]" in args
    assert "--author=Alice Example" in args
    assert "--since=2026-01-01" in args
    assert "--until=2026-07-16T23:59:59+08:00" in args
    assert "--first-parent" in args
    assert "--merges" in args
    assert args[-3:] == ["feature/topic", "--", "src/history view.tsx"]


def test_history_query_accepts_safe_two_and_three_dot_revision_ranges() -> None:
    two_dot = build_history_log_args(
        GitHistoryQuery(revision="origin/main..HEAD"),
        offset=0,
        limit=20,
    )
    three_dot = build_history_log_args(
        GitHistoryQuery(revision="main...feature/topic"),
        offset=0,
        limit=20,
    )

    assert "origin/main..HEAD" in two_dot
    assert "main...feature/topic" in three_dot


@pytest.mark.parametrize("revision", ["..HEAD", "HEAD..", "HEAD....main", "main..--all"])
def test_history_query_rejects_malformed_or_unsafe_revision_ranges(revision: str) -> None:
    with pytest.raises(GitParameterError):
        build_history_log_args(GitHistoryQuery(revision=revision), offset=0, limit=10)


@pytest.mark.parametrize(
    ("query", "message"),
    [
        (GitHistoryQuery(revision="--all"), "Invalid Git ref name"),
        (GitHistoryQuery(path="../outside"), "traversal"),
        (GitHistoryQuery(hash_prefix="not-a-hash"), "hexadecimal"),
        (GitHistoryQuery(since="next Thursday"), "ISO date"),
        (GitHistoryQuery(text="bad\noption"), "invalid"),
    ],
)
def test_history_query_rejects_unsafe_or_ambiguous_input(
    query: GitHistoryQuery,
    message: str,
) -> None:
    with pytest.raises(GitParameterError, match=message):
        build_history_log_args(query, offset=0, limit=10)


@pytest.mark.asyncio
async def test_history_query_filters_real_repository_and_resolves_hash(
    git_repo_factory,
    tmp_path: Path,
) -> None:
    repo = git_repo_factory.create("history-filters")
    repo.run("config", "user.name", "Alice Example")
    repo.run("config", "user.email", "alice@example.invalid")
    _set_commit_date(repo, "2025-06-01T10:00:00+00:00")
    repo.write("docs/guide.md", "guide\n")
    guide_oid = repo.commit("docs: searchable guide", "docs/guide.md")

    repo.run("switch", "-c", "feature/topic")
    repo.run("config", "user.name", "Bob Example")
    repo.run("config", "user.email", "bob@example.invalid")
    _set_commit_date(repo, "2026-01-15T10:00:00+00:00")
    repo.write("src/topic.py", "topic = True\n")
    topic_oid = repo.commit("feat: topic implementation", "src/topic.py")

    repo.run("switch", "main")
    repo.run("config", "user.name", "Alice Example")
    repo.run("config", "user.email", "alice@example.invalid")
    _set_commit_date(repo, "2026-02-15T10:00:00+00:00")
    repo.write("src/main.py", "main = True\n")
    main_oid = repo.commit("feat: main implementation", "src/main.py")
    _set_commit_date(repo, "2026-03-15T10:00:00+00:00")
    repo.run("merge", "--no-ff", "feature/topic", "-m", "merge topic")

    service, request = _service(repo, tmp_path)

    text_page = await service.history(request, query=GitHistoryQuery(text="searchable guide"))
    assert [item.object_id for item in text_page.commits] == [guide_oid]

    author_page = await service.history(request, query=GitHistoryQuery(author="Bob Example"))
    assert [item.object_id for item in author_page.commits] == [topic_oid]

    path_page = await service.history(request, query=GitHistoryQuery(path="src/topic.py"))
    assert topic_oid in {item.object_id for item in path_page.commits}
    assert all(item.subject != "feat: main implementation" for item in path_page.commits)

    merge_page = await service.history(request, query=GitHistoryQuery(merges_only=True))
    assert [item.subject for item in merge_page.commits] == ["merge topic"]

    first_parent_page = await service.history(
        request,
        query=GitHistoryQuery(revision="main", first_parent=True),
    )
    assert "feat: topic implementation" not in {item.subject for item in first_parent_page.commits}

    date_page = await service.history(
        request,
        query=GitHistoryQuery(since="2026-02-01", until="2026-02-28"),
    )
    assert [item.object_id for item in date_page.commits] == [main_oid]

    hash_page = await service.history(
        request,
        query=GitHistoryQuery(hash_prefix=topic_oid[:10], revision="feature/topic"),
    )
    assert [item.object_id for item in hash_page.commits] == [topic_oid]

    unreachable_page = await service.history(
        request,
        query=GitHistoryQuery(hash_prefix=main_oid[:10], revision="feature/topic"),
    )
    assert unreachable_page.commits == []

    missing_hash_page = await service.history(
        request,
        query=GitHistoryQuery(hash_prefix="deadbeef"),
    )
    assert missing_hash_page.commits == []


@pytest.mark.asyncio
async def test_invalid_revision_is_rejected_before_any_git_process(
    git_repo_factory,
    tmp_path: Path,
) -> None:
    repo = git_repo_factory.create("history-invalid")
    service, request = _service(repo, tmp_path)
    runner = AsyncMock()
    service._runner = runner  # type: ignore[assignment]

    with pytest.raises(GitApiError) as error:
        await service.history(request, query=GitHistoryQuery(revision="--all"))

    assert error.value.payload.code == "git_validation_failed"
    runner.run.assert_not_awaited()


def _service(repo, tmp_path: Path) -> tuple[GitQueryService, GitRepositoryRequest]:
    service = GitQueryService(grants=GitAncestorGrantStore(tmp_path / "history-grants.json"))
    discovery = service.discover(
        GitDiscoveryRequest(workspace_id="workspace-history", project_root=str(repo.path))
    )
    request = GitRepositoryRequest(
        workspace_id="workspace-history",
        project_root=str(repo.path),
        repository_id=discovery.repositories[0].id,
    )
    return service, request


def _set_commit_date(repo, value: str) -> None:
    repo.env["GIT_AUTHOR_DATE"] = value
    repo.env["GIT_COMMITTER_DATE"] = value
