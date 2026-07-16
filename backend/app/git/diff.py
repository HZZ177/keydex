from __future__ import annotations

import re
import shlex
from dataclasses import dataclass

from .models import GitDiffHunkResponse, GitFileDiffResponse, GitFileStatusCode


class GitDiffParseError(ValueError):
    pass


_HUNK = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")


@dataclass(frozen=True)
class GitNumstat:
    path: str
    original_path: str | None
    additions: int | None
    deletions: int | None


def parse_git_diff(payload: str, *, truncated: bool = False) -> list[GitFileDiffResponse]:
    lines = payload.splitlines(keepends=True)
    starts = [index for index, line in enumerate(lines) if line.startswith("diff --git ")]
    diffs: list[GitFileDiffResponse] = []
    for position, start in enumerate(starts):
        end = starts[position + 1] if position + 1 < len(starts) else len(lines)
        section = lines[start:end]
        diffs.append(_parse_file_diff(section, truncated=truncated))
    return diffs


def _parse_file_diff(lines: list[str], *, truncated: bool) -> GitFileDiffResponse:
    if not lines:
        raise GitDiffParseError("Empty diff section")
    header_paths = _diff_header_paths(lines[0].rstrip("\r\n"))
    old_path, new_path = header_paths
    status = GitFileStatusCode.MODIFIED
    binary = False
    old_mode = None
    new_mode = None
    hunks: list[GitDiffHunkResponse] = []
    index = 1
    while index < len(lines):
        line = lines[index].rstrip("\r\n")
        if line.startswith("new file mode "):
            status = GitFileStatusCode.ADDED
            new_mode = line.removeprefix("new file mode ")
        elif line.startswith("deleted file mode "):
            status = GitFileStatusCode.DELETED
            old_mode = line.removeprefix("deleted file mode ")
        elif line.startswith("old mode "):
            old_mode = line.removeprefix("old mode ")
            status = GitFileStatusCode.TYPE_CHANGED
        elif line.startswith("new mode "):
            new_mode = line.removeprefix("new mode ")
        elif line.startswith("rename from "):
            old_path = _unquote_path(line.removeprefix("rename from "))
            status = GitFileStatusCode.RENAMED
        elif line.startswith("rename to "):
            new_path = _unquote_path(line.removeprefix("rename to "))
        elif line.startswith("copy from "):
            old_path = _unquote_path(line.removeprefix("copy from "))
            status = GitFileStatusCode.COPIED
        elif line.startswith("copy to "):
            new_path = _unquote_path(line.removeprefix("copy to "))
        elif line.startswith("--- "):
            old_path = _patch_path(line[4:])
        elif line.startswith("+++ "):
            new_path = _patch_path(line[4:])
        elif line.startswith("Binary files ") or line.startswith("GIT binary patch"):
            binary = True
        elif line.startswith("@@ "):
            match = _HUNK.match(line)
            if not match:
                raise GitDiffParseError(f"Malformed hunk header: {line}")
            hunk_lines: list[str] = []
            index += 1
            while index < len(lines) and not lines[index].startswith("@@ "):
                hunk_lines.append(lines[index].rstrip("\r\n"))
                index += 1
            hunks.append(
                GitDiffHunkResponse(
                    header=line,
                    old_start=int(match.group(1)),
                    old_lines=int(match.group(2) or "1"),
                    new_start=int(match.group(3)),
                    new_lines=int(match.group(4) or "1"),
                    lines=hunk_lines,
                )
            )
            continue
        index += 1
    if old_path is None and new_path is not None:
        status = GitFileStatusCode.ADDED
    elif new_path is None and old_path is not None:
        status = GitFileStatusCode.DELETED
    return GitFileDiffResponse(
        old_path=old_path,
        new_path=new_path,
        status=status,
        binary=binary,
        old_mode=old_mode,
        new_mode=new_mode,
        hunks=hunks,
        raw_patch="".join(lines),
        truncated=truncated,
    )


def parse_numstat_z(payload: str) -> list[GitNumstat]:
    tokens = payload.split("\x00")
    results: list[GitNumstat] = []
    index = 0
    while index < len(tokens):
        token = tokens[index]
        index += 1
        if not token:
            continue
        parts = token.split("\t", 2)
        if len(parts) != 3:
            raise GitDiffParseError("Malformed numstat record")
        additions, deletions, path = parts
        original_path = None
        if path == "":
            if index + 1 >= len(tokens):
                raise GitDiffParseError("Rename numstat record is incomplete")
            original_path = tokens[index]
            path = tokens[index + 1]
            index += 2
        results.append(
            GitNumstat(
                path=path,
                original_path=original_path,
                additions=None if additions == "-" else int(additions),
                deletions=None if deletions == "-" else int(deletions),
            )
        )
    return results


def apply_numstat(
    diffs: list[GitFileDiffResponse], numstats: list[GitNumstat]
) -> list[GitFileDiffResponse]:
    by_path = {item.path: item for item in numstats}
    return [
        diff.model_copy(
            update={
                "additions": by_path.get(diff.new_path or diff.old_path or "").additions,
                "deletions": by_path.get(diff.new_path or diff.old_path or "").deletions,
            }
        )
        if by_path.get(diff.new_path or diff.old_path or "")
        else diff
        for diff in diffs
    ]


def _diff_header_paths(line: str) -> tuple[str | None, str | None]:
    prefix = "diff --git "
    if not line.startswith(prefix):
        raise GitDiffParseError("Malformed diff --git header")
    try:
        parts = shlex.split(line)
    except ValueError as exc:
        raise GitDiffParseError("Malformed diff header") from exc
    if len(parts) == 4:
        return _strip_ab(parts[2]), _strip_ab(parts[3])

    # With `core.quotepath=false`, Git intentionally leaves Unicode paths
    # readable and may also leave spaces unquoted in the `diff --git` line.
    # The a/ and b/ prefixes are the only stable separator in that form.
    # Prefer the final separator so an old path containing " b/" remains
    # parseable in the common rename/same-path cases; the authoritative
    # ---/+++ or rename from/to headers below still replace these values.
    payload = line[len(prefix) :]
    separator = payload.rfind(" b/")
    if payload.startswith("a/") and separator > 1:
        return _strip_ab(payload[:separator]), _strip_ab(payload[separator + 1 :])
    raise GitDiffParseError("Malformed diff --git header")


def _patch_path(value: str) -> str | None:
    path = _unquote_path(value)
    return None if path == "/dev/null" else _strip_ab(path)


def _strip_ab(path: str) -> str:
    return path[2:] if path.startswith(("a/", "b/")) else path


def _unquote_path(value: str) -> str:
    text = value.strip()
    if text.startswith('"'):
        try:
            values = shlex.split(text)
        except ValueError as exc:
            raise GitDiffParseError("Malformed quoted Git path") from exc
        if len(values) != 1:
            raise GitDiffParseError("Git path contained unexpected fields")
        return values[0]
    return text
