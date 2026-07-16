from __future__ import annotations

import json
from pathlib import Path

import pytest

from backend.app.git.advanced import (
    GitAdvancedParseError,
    parse_blame_porcelain,
    parse_lfs_json,
    parse_lfs_locks_json,
    parse_reflog,
    parse_submodule_status,
    parse_worktree_porcelain,
    read_bisect_state,
)


def test_parse_blame_porcelain_reuses_metadata_and_marks_boundary() -> None:
    payload = (
        "^abcd1234 1 1 2\n"
        "author Ada Lovelace\n"
        "author-mail <ada@example.invalid>\n"
        "author-time 1700000000\n"
        "summary initial\n"
        "boundary\n"
        "filename hello world.txt\n"
        "\tfirst\n"
        "abcd1234 2 2\n"
        "filename hello world.txt\n"
        "\tsecond\n"
    )

    lines = parse_blame_porcelain(payload)

    assert [(line.final_line, line.author_name, line.content) for line in lines] == [
        (1, "Ada Lovelace", "first"),
        (2, "Ada Lovelace", "second"),
    ]
    assert lines[0].boundary is True
    assert lines[0].author_email == "ada@example.invalid"


def test_parse_reflog_and_reject_incomplete_records() -> None:
    payload = (
        "abcd1234\x00HEAD@{0}\x00Ada\x00ada@example.invalid\x00"
        "2026-07-15T10:00:00+08:00\x00checkout: moving from main to topic\x00"
    )

    entry = parse_reflog(payload)[0]

    assert (entry.selector, entry.action, entry.message) == (
        "HEAD@{0}",
        "checkout",
        "moving from main to topic",
    )
    with pytest.raises(GitAdvancedParseError):
        parse_reflog("abcd\x00HEAD@{0}")


def test_parse_submodule_and_worktree_porcelain() -> None:
    submodules = parse_submodule_status(
        " abcdef12 libs/clean (heads/main)\n-12345678 libs/new\n+deadbeef libs/changed (v1.0)\n"
    )
    assert [item.state for item in submodules] == ["clean", "uninitialized", "different"]
    worktrees = parse_worktree_porcelain(
        "worktree C:/repo\nHEAD abcdef12\nbranch refs/heads/main\n\n"
        "worktree C:/repo-topic\nHEAD deadbeef\ndetached\nlocked maintenance\n"
    )
    assert worktrees[0].branch == "refs/heads/main"
    assert worktrees[1].detached is True
    assert worktrees[1].locked_reason == "maintenance"


def test_read_bisect_state_and_parse_lfs(tmp_path: Path) -> None:
    (tmp_path / "BISECT_START").write_text("main\n", encoding="utf-8")
    (tmp_path / "BISECT_GOOD").write_text("good1\ngood2\n", encoding="utf-8")
    (tmp_path / "BISECT_BAD").write_text("bad1\n", encoding="utf-8")
    (tmp_path / "BISECT_EXPECTED_REV").write_text("current1\n", encoding="utf-8")
    state = read_bisect_state(tmp_path)
    assert state.active is True
    assert state.good_revisions == ["good1", "good2"]
    assert state.current_revision == "current1"

    files = parse_lfs_json(
        json.dumps(
            [
                {"name": "large.bin", "oid": "sha256:abc", "size": 42},
                {"path": "missing.bin", "object_id": "sha256:def", "missing": True},
            ]
        )
    )
    assert [(file.path, file.status) for file in files] == [
        ("large.bin", "tracked"),
        ("missing.bin", "missing"),
    ]
    assert parse_lfs_json('{"files":{}}') == []
    sectioned = parse_lfs_json(
        json.dumps({"files": {"objects": [{"name": "nested.bin", "oid": "sha256:nested"}]}})
    )
    assert [(file.path, file.object_id) for file in sectioned] == [("nested.bin", "sha256:nested")]
    locks = parse_lfs_locks_json(
        json.dumps(
            {
                "locks": [
                    {
                        "id": "lock-1",
                        "path": "large.bin",
                        "owner": {"name": "Ada"},
                        "locked_at": "2026-07-16T00:00:00Z",
                    }
                ]
            }
        )
    )
    assert [(lock.id, lock.path, lock.owner) for lock in locks] == [("lock-1", "large.bin", "Ada")]


def test_submodule_parser_preserves_paths_with_spaces_and_descriptions() -> None:
    parsed = parse_submodule_status(f" {'a' * 40} modules/my child (heads/main-2-gabcdef)\n")
    assert parsed[0].path == "modules/my child"
    assert parsed[0].description == "heads/main-2-gabcdef"
