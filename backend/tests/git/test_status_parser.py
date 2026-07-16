from __future__ import annotations

import pytest

from backend.app.git.status import GitStatusParseError, parse_porcelain_v2_status


def test_parses_branch_tracking_unicode_rename_untracked_and_conflict() -> None:
    payload = (
        "# branch.oid abcdef1234567890\n"
        "# branch.head main\n"
        "# branch.upstream origin/main\n"
        "# branch.ab +2 -3\n"
        "1 M. N... 100644 100644 100644 aaa bbb 中文 文件.txt\x00"
        "2 R. N... 100644 100644 100644 aaa bbb R100 新名字.txt\x00旧名字.txt\x00"
        "? emoji-😀.md\x00"
        "u UU N... 100644 100644 100644 100644 aaa bbb ccc conflict.txt\x00"
    )
    status = parse_porcelain_v2_status(
        payload, repository_id="repo-a", repository_version="version-a"
    )
    assert status.branch.model_dump() == {
        "head": "main",
        "detached_at": None,
        "upstream": "origin/main",
        "ahead": 2,
        "behind": 3,
        "unborn": False,
    }
    assert [(item.path, item.original_path) for item in status.files] == [
        ("中文 文件.txt", None),
        ("新名字.txt", "旧名字.txt"),
        ("emoji-😀.md", None),
        ("conflict.txt", None),
    ]
    assert status.files[1].index_status == "renamed"
    assert status.files[2].worktree_status == "untracked"
    assert status.files[3].conflicted is True


def test_rejects_unknown_branch_head_from_damaged_reference() -> None:
    payload = "# branch.oid (initial)\x00# branch.head (unknown)\x00"

    with pytest.raises(GitStatusParseError, match="HEAD points"):
        parse_porcelain_v2_status(
            payload,
            repository_id="repo-damaged",
            repository_version="v1",
        )


def test_parses_real_porcelain_v2_zero_terminated_output(git_repo_factory) -> None:
    repository = git_repo_factory.create("status")
    repository.write("tracked.txt", "base\n")
    repository.commit("tracked", "tracked.txt")
    repository.write("tracked.txt", "changed\n")
    repository.write("untracked 中文.txt", "new\n")
    repository.write("ignored.log", "ignored\n")
    repository.write(".gitignore", "*.log\n")
    repository.run("add", "--", ".gitignore")
    raw = repository.run(
        "status",
        "--porcelain=v2",
        "--branch",
        "--untracked-files=all",
        "-z",
    ).stdout
    status = parse_porcelain_v2_status(raw, repository_id="repo", repository_version="v1")
    by_path = {item.path: item for item in status.files}
    assert by_path["tracked.txt"].worktree_status == "modified"
    assert by_path[".gitignore"].index_status == "added"
    assert by_path["untracked 中文.txt"].worktree_status == "untracked"
    assert "ignored.log" not in by_path


def test_parses_unborn_and_detached_branch_headers() -> None:
    unborn = parse_porcelain_v2_status(
        "# branch.oid (initial)\n# branch.head main\n",
        repository_id="repo",
        repository_version="v1",
    )
    assert unborn.branch.unborn is True
    assert unborn.branch.head == "main"
    detached = parse_porcelain_v2_status(
        "# branch.oid abcdef1234567890\n# branch.head (detached)\n",
        repository_id="repo",
        repository_version="v2",
    )
    assert detached.branch.head is None
    assert detached.branch.detached_at == "abcdef1234567890"
