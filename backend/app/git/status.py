from __future__ import annotations

from dataclasses import dataclass

from .models import (
    GitBranchResponse,
    GitChangedFileResponse,
    GitFileStatusCode,
    GitStatusResponse,
)


class GitStatusParseError(ValueError):
    pass


@dataclass
class _Branch:
    head: str | None = None
    detached_at: str | None = None
    upstream: str | None = None
    ahead: int = 0
    behind: int = 0
    unborn: bool = False


_STATUS_MAP: dict[str, GitFileStatusCode] = {
    "A": GitFileStatusCode.ADDED,
    "M": GitFileStatusCode.MODIFIED,
    "D": GitFileStatusCode.DELETED,
    "R": GitFileStatusCode.RENAMED,
    "C": GitFileStatusCode.COPIED,
    "T": GitFileStatusCode.TYPE_CHANGED,
    "U": GitFileStatusCode.CONFLICTED,
}
_CONFLICT_XY = {"DD", "AU", "UD", "UA", "DU", "AA", "UU"}


def parse_porcelain_v2_status(
    payload: str,
    *,
    repository_id: str,
    repository_version: str,
) -> GitStatusResponse:
    branch = _Branch()
    files: list[GitChangedFileResponse] = []
    tokens = payload.split("\x00")
    index = 0
    while index < len(tokens):
        token = tokens[index]
        index += 1
        if not token:
            continue
        for item in token.splitlines():
            if item.startswith("# "):
                _parse_branch_header(item, branch)
            elif item.startswith(("1 ", "u ", "? ", "! ")):
                files.append(_parse_file_record(item))
            elif item.startswith("2 "):
                if index >= len(tokens):
                    raise GitStatusParseError("Rename record is missing its original path")
                original_path = tokens[index]
                index += 1
                files.append(_parse_file_record(item, original_path=original_path))
            elif item.strip():
                raise GitStatusParseError(f"Unknown porcelain v2 record: {item[:40]}")
    return GitStatusResponse(
        repository_id=repository_id,
        repository_version=repository_version,
        branch=GitBranchResponse(
            head=branch.head,
            detached_at=branch.detached_at,
            upstream=branch.upstream,
            ahead=branch.ahead,
            behind=branch.behind,
            unborn=branch.unborn,
        ),
        files=files,
    )


def _parse_branch_header(record: str, branch: _Branch) -> None:
    key, separator, value = record[2:].partition(" ")
    if not separator:
        return
    if key == "branch.oid":
        branch.unborn = value == "(initial)"
        if value not in {"(initial)", "(unknown)"}:
            branch.detached_at = value
    elif key == "branch.head":
        if value == "(unknown)":
            raise GitStatusParseError(
                "Git HEAD points to an unreadable or missing commit"
            )
        if value == "(detached)":
            branch.head = None
        else:
            branch.head = value
            branch.detached_at = None
    elif key == "branch.upstream":
        branch.upstream = value
    elif key == "branch.ab":
        parts = value.split()
        if len(parts) == 2 and parts[0].startswith("+") and parts[1].startswith("-"):
            branch.ahead = int(parts[0][1:])
            branch.behind = int(parts[1][1:])


def _parse_file_record(record: str, *, original_path: str | None = None) -> GitChangedFileResponse:
    kind = record[0]
    if kind == "?":
        return GitChangedFileResponse(
            path=record[2:], worktree_status=GitFileStatusCode.UNTRACKED
        )
    if kind == "!":
        return GitChangedFileResponse(path=record[2:], worktree_status=GitFileStatusCode.IGNORED)
    if kind == "1":
        parts = record.split(" ", 8)
        if len(parts) != 9:
            raise GitStatusParseError("Malformed ordinary porcelain record")
        xy, submodule, path = parts[1], parts[2], parts[8]
    elif kind == "2":
        parts = record.split(" ", 9)
        if len(parts) != 10:
            raise GitStatusParseError("Malformed rename/copy porcelain record")
        xy, submodule, path = parts[1], parts[2], parts[9]
    elif kind == "u":
        parts = record.split(" ", 10)
        if len(parts) != 11:
            raise GitStatusParseError("Malformed unmerged porcelain record")
        xy, submodule, path = parts[1], parts[2], parts[10]
    else:
        raise GitStatusParseError(f"Unsupported file record: {kind}")
    if len(xy) != 2:
        raise GitStatusParseError("Porcelain XY status must contain two characters")
    conflicted = kind == "u" or xy in _CONFLICT_XY or "U" in xy
    return GitChangedFileResponse(
        path=path,
        original_path=original_path,
        index_status=GitFileStatusCode.CONFLICTED if conflicted else _status(xy[0]),
        worktree_status=GitFileStatusCode.CONFLICTED if conflicted else _status(xy[1]),
        conflicted=conflicted,
        submodule=submodule.startswith("S"),
    )


def _status(code: str) -> GitFileStatusCode | None:
    if code == ".":
        return None
    try:
        return _STATUS_MAP[code]
    except KeyError as exc:
        raise GitStatusParseError(f"Unknown porcelain status code: {code}") from exc
