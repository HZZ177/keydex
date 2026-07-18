from __future__ import annotations

from backend.app.git.diff import (
    apply_numstat,
    diff_summaries,
    parse_git_diff,
    parse_name_status_z,
    parse_numstat_z,
)


def test_parses_text_hunks_rename_binary_modes_and_no_newline_marker() -> None:
    payload = (
        "diff --git \"a/old name.txt\" \"b/new name.txt\"\n"
        "similarity index 80%\nrename from old name.txt\nrename to new name.txt\n"
        "--- \"a/old name.txt\"\n+++ \"b/new name.txt\"\n"
        "@@ -1,2 +1,3 @@ section\n line\n-old\n+new\n+extra\n"
        "\\ No newline at end of file\n"
        "diff --git a/image.bin b/image.bin\nindex aaa..bbb 100644\n"
        "Binary files a/image.bin and b/image.bin differ\n"
        "diff --git a/script.sh b/script.sh\nold mode 100644\nnew mode 100755\n"
    )
    diffs = parse_git_diff(payload)
    assert [(item.status, item.old_path, item.new_path) for item in diffs] == [
        ("renamed", "old name.txt", "new name.txt"),
        ("modified", "image.bin", "image.bin"),
        ("type_changed", "script.sh", "script.sh"),
    ]
    assert diffs[0].hunks[0].old_lines == 2
    assert diffs[0].hunks[0].new_lines == 3
    assert diffs[0].hunks[0].lines[-1] == "\\ No newline at end of file"
    assert diffs[1].binary is True
    assert (diffs[2].old_mode, diffs[2].new_mode) == ("100644", "100755")


def test_preserves_raw_patch_and_covers_add_delete_copy_and_truncation() -> None:
    payload = (
        "diff --git a/new.txt b/new.txt\r\n"
        "new file mode 100644\r\n--- /dev/null\r\n+++ b/new.txt\r\n"
        "@@ -0,0 +1 @@\r\n+new\r\n"
        "diff --git a/old.txt b/old.txt\r\n"
        "deleted file mode 100644\r\n--- a/old.txt\r\n+++ /dev/null\r\n"
        "@@ -1 +0,0 @@\r\n-old\r\n"
        "diff --git a/source.txt b/copied.txt\r\n"
        "similarity index 100%\r\ncopy from source.txt\r\ncopy to copied.txt\r\n"
    )

    diffs = parse_git_diff(payload, truncated=True)

    assert [item.status for item in diffs] == ["added", "deleted", "copied"]
    assert diffs[0].old_path is None and diffs[0].new_path == "new.txt"
    assert diffs[1].old_path == "old.txt" and diffs[1].new_path is None
    assert (diffs[2].old_path, diffs[2].new_path) == ("source.txt", "copied.txt")
    assert all(item.truncated is True for item in diffs)
    assert "".join(item.raw_patch for item in diffs) == payload


def test_parses_zero_terminated_numstat_for_text_binary_and_rename() -> None:
    stats = parse_numstat_z(
        "10\t2\tsrc/a.ts\x00-\t-\timage.bin\x001\t1\t\x00old.txt\x00new.txt\x00"
    )
    assert [(item.path, item.original_path, item.additions, item.deletions) for item in stats] == [
        ("src/a.ts", None, 10, 2),
        ("image.bin", None, None, None),
        ("new.txt", "old.txt", 1, 1),
    ]


def test_builds_complete_patchless_summaries_from_name_status_and_numstat() -> None:
    changes = parse_name_status_z(
        "M\x00src/a.ts\x00A\x00new.txt\x00D\x00old.txt\x00"
        "R095\x00before.md\x00after.md\x00C100\x00source.bin\x00copy.bin\x00"
    )
    summaries = diff_summaries(changes, parse_numstat_z(
        "10\t2\tsrc/a.ts\x001\t0\tnew.txt\x000\t4\told.txt\x00"
        "3\t1\t\x00before.md\x00after.md\x00-\t-\t\x00source.bin\x00copy.bin\x00"
    ))

    assert [item.status for item in summaries] == [
        "modified", "added", "deleted", "renamed", "copied",
    ]
    assert [(item.old_path, item.new_path) for item in summaries] == [
        ("src/a.ts", "src/a.ts"),
        (None, "new.txt"),
        ("old.txt", None),
        ("before.md", "after.md"),
        ("source.bin", "copy.bin"),
    ]
    assert summaries[3].additions == 3
    assert summaries[4].binary is True
    assert all(item.raw_patch == "" and item.truncated is False for item in summaries)


def test_parses_real_diff_and_applies_numstat(git_repo_factory) -> None:
    repository = git_repo_factory.create("diff")
    repository.write("old.txt", "line 1\nline 2\n")
    repository.commit("add old", "old.txt")
    repository.run("mv", "old.txt", "new.txt")
    repository.write("new.txt", "line 1\nchanged\nextra\n")
    patch = repository.run(
        "-c",
        "core.quotepath=false",
        "diff",
        "--patch",
        "--binary",
        "--find-renames=20%",
        "HEAD",
    ).stdout
    numstat = repository.run(
        "-c", "core.quotepath=false", "diff", "--find-renames=20%", "--numstat", "-z", "HEAD"
    ).stdout
    diffs = apply_numstat(parse_git_diff(patch), parse_numstat_z(numstat))
    assert len(diffs) == 1
    assert diffs[0].new_path == "new.txt"
    assert diffs[0].old_path == "old.txt"
    assert diffs[0].additions == 2
    assert diffs[0].deletions == 1
    assert diffs[0].hunks


def test_parses_real_unicode_space_and_emoji_path_with_quotepath_disabled(
    git_repo_factory,
) -> None:
    repository = git_repo_factory.create("unicode-diff")
    path = "中文 空格 😀.txt"
    repository.write(path, "before\n")
    repository.commit("add unicode path", path)
    repository.write(path, "after\n")

    patch = repository.run(
        "-c",
        "core.quotepath=false",
        "diff",
        "--patch",
        "--binary",
        "HEAD",
        "--",
        path,
    ).stdout
    parsed = parse_git_diff(patch)

    assert len(parsed) == 1
    assert parsed[0].old_path == path
    assert parsed[0].new_path == path
    assert parsed[0].hunks[0].lines == ["-before", "+after"]
