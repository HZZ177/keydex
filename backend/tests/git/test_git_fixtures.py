from __future__ import annotations

from pathlib import Path


def test_fixture_builds_unicode_history_conflicts_and_local_bare_remote(
    git_repo_factory,
) -> None:
    repository = git_repo_factory.create("complete")
    repository.write("中文 目录/emoji-😀.txt", "hello\n")
    unicode_oid = repository.commit("unicode fixture", "中文 目录/emoji-😀.txt")
    assert len(unicode_oid) == 40

    remote: Path = git_repo_factory.create_bare("origin")
    repository.run("remote", "add", "origin", str(remote))
    repository.run("push", "-u", "origin", "main")
    assert repository.run("rev-parse", "origin/main").stdout.strip() == unicode_oid

    repository.create_conflict()
    status = repository.run("status", "--porcelain", "-z").stdout
    assert "UU conflict.txt" in status
    repository.run("merge", "--abort")


def test_fixture_can_create_an_unborn_repository_and_is_prefix_bounded(git_repo_factory) -> None:
    repository = git_repo_factory.create("unborn", initial_commit=False)
    assert repository.path.name.startswith("e2e-git-")
    assert repository.run("rev-parse", "--verify", "HEAD", check=False).returncode != 0
