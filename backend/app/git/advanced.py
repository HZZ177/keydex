from __future__ import annotations

import json
import re
from pathlib import Path

from .models import (
    GitBisectResponse,
    GitBlameLineResponse,
    GitLfsFileResponse,
    GitLfsLockResponse,
    GitReflogEntryResponse,
    GitSubmoduleResponse,
    GitWorktreeResponse,
)


class GitAdvancedParseError(ValueError):
    pass


REFLOG_FORMAT = "%H%x00%gD%x00%gN%x00%gE%x00%gI%x00%gs%x00"


def parse_blame_porcelain(payload: str) -> list[GitBlameLineResponse]:
    lines = payload.splitlines()
    result: list[GitBlameLineResponse] = []
    metadata_by_oid: dict[str, dict[str, str]] = {}
    index = 0
    header_re = re.compile(r"^([0-9a-f^]{4,64}) (\d+) (\d+)(?: (\d+))?$")
    while index < len(lines):
        match = header_re.match(lines[index])
        if not match:
            raise GitAdvancedParseError(f"Invalid blame header: {lines[index]!r}")
        raw_oid, original_line, final_line, _group_size = match.groups()
        object_id = raw_oid.lstrip("^")
        boundary = raw_oid.startswith("^")
        index += 1
        metadata = dict(metadata_by_oid.get(object_id, {}))
        while index < len(lines) and not lines[index].startswith("\t"):
            key, separator, value = lines[index].partition(" ")
            if header_re.match(lines[index]):
                break
            metadata[key] = value if separator else "true"
            index += 1
        if index >= len(lines) or not lines[index].startswith("\t"):
            raise GitAdvancedParseError("Blame record is missing source content")
        metadata_by_oid[object_id] = metadata
        result.append(
            GitBlameLineResponse(
                object_id=object_id,
                original_line=int(original_line),
                final_line=int(final_line),
                author_name=metadata.get("author", ""),
                author_email=metadata.get("author-mail", "").strip("<>"),
                authored_at=_optional_int(metadata.get("author-time")),
                summary=metadata.get("summary", ""),
                filename=metadata.get("filename", "unknown"),
                content=lines[index][1:],
                boundary=boundary or "boundary" in metadata,
                uncommitted=set(object_id) == {"0"},
            )
        )
        index += 1
    return result


def parse_reflog(payload: str) -> list[GitReflogEntryResponse]:
    fields = payload.split("\x00")
    while fields and not fields[-1].strip("\r\n"):
        fields.pop()
    if len(fields) % 6:
        raise GitAdvancedParseError("Reflog output has an incomplete record")
    entries: list[GitReflogEntryResponse] = []
    for offset in range(0, len(fields), 6):
        oid, selector, actor_name, actor_email, occurred_at, subject = fields[offset : offset + 6]
        oid = oid.lstrip("\r\n")
        subject = subject.rstrip("\r\n")
        action, separator, message = subject.partition(": ")
        entries.append(
            GitReflogEntryResponse(
                selector=selector,
                object_id=oid,
                actor_name=actor_name,
                actor_email=actor_email,
                occurred_at=occurred_at,
                action=action if separator else "update",
                message=message if separator else subject,
            )
        )
    return entries


def parse_submodule_status(payload: str) -> list[GitSubmoduleResponse]:
    state_map = {" ": "clean", "-": "uninitialized", "+": "different", "U": "conflicted"}
    result: list[GitSubmoduleResponse] = []
    for line in payload.splitlines():
        if not line:
            continue
        prefix, body = line[0], line[1:]
        if prefix not in state_map:
            raise GitAdvancedParseError(f"Unknown submodule state: {prefix!r}")
        oid, separator, rest = body.partition(" ")
        if not separator:
            raise GitAdvancedParseError("Submodule output is missing a path")
        path, separator, description = rest.rpartition(" (")
        if not separator or not description.endswith(")"):
            path, description = rest, ""
        else:
            description = description[:-1]
        result.append(
            GitSubmoduleResponse(
                path=path,
                object_id=oid,
                state=state_map[prefix],
                description=description,
            )
        )
    return result


def parse_worktree_porcelain(payload: str) -> list[GitWorktreeResponse]:
    result: list[GitWorktreeResponse] = []
    for block in re.split(r"\r?\n\r?\n", payload.strip()):
        if not block:
            continue
        fields: dict[str, str] = {}
        flags: set[str] = set()
        for line in block.splitlines():
            key, separator, value = line.partition(" ")
            if separator:
                fields[key] = value
            else:
                flags.add(key)
        if "worktree" not in fields:
            raise GitAdvancedParseError("Worktree record is missing its path")
        result.append(
            GitWorktreeResponse(
                path=fields["worktree"],
                head=fields.get("HEAD"),
                branch=fields.get("branch"),
                bare="bare" in flags,
                detached="detached" in flags,
                locked_reason=fields.get("locked") or ("locked" if "locked" in flags else None),
                prunable_reason=fields.get("prunable")
                or ("prunable" if "prunable" in flags else None),
            )
        )
    return result


def read_bisect_state(git_dir: str | Path) -> GitBisectResponse:
    root = Path(git_dir)
    good = _read_revision_lines(root / "BISECT_GOOD")
    bad = _read_revision_lines(root / "BISECT_BAD")
    skipped = _read_revision_lines(root / "BISECT_SKIPPED")
    current = _read_first_line(root / "BISECT_EXPECTED_REV")
    return GitBisectResponse(
        active=(root / "BISECT_START").exists(),
        good_revisions=good,
        bad_revisions=bad,
        skipped_revisions=skipped,
        current_revision=current,
    )


def parse_lfs_json(payload: str) -> list[GitLfsFileResponse]:
    try:
        decoded = json.loads(payload)
    except json.JSONDecodeError as exc:
        raise GitAdvancedParseError("Invalid Git LFS JSON output") from exc
    records: object
    if isinstance(decoded, list):
        records = decoded
    elif isinstance(decoded, dict):
        files = decoded.get("files", [])
        if isinstance(files, dict):
            records = [
                record
                for section in files.values()
                if isinstance(section, list)
                for record in section
            ]
        else:
            records = files
    else:
        records = []
    if not isinstance(records, list):
        raise GitAdvancedParseError("Git LFS JSON files must be a list")
    result: list[GitLfsFileResponse] = []
    for record in records:
        if not isinstance(record, dict):
            raise GitAdvancedParseError("Git LFS JSON contains a non-object file")
        result.append(
            GitLfsFileResponse(
                path=str(record.get("name") or record.get("path") or ""),
                object_id=str(record.get("oid") or record.get("object_id") or "unknown"),
                size=record.get("size"),
                status=_lfs_status(record),
            )
        )
    return result


def parse_lfs_locks_json(payload: str) -> list[GitLfsLockResponse]:
    try:
        decoded = json.loads(payload)
    except json.JSONDecodeError as exc:
        raise GitAdvancedParseError("Invalid Git LFS locks JSON output") from exc
    records = decoded if isinstance(decoded, list) else (
        decoded.get("locks", []) if isinstance(decoded, dict) else []
    )
    if not isinstance(records, list):
        raise GitAdvancedParseError("Git LFS JSON locks must be a list")
    result: list[GitLfsLockResponse] = []
    for index, record in enumerate(records):
        if not isinstance(record, dict):
            raise GitAdvancedParseError("Git LFS locks JSON contains a non-object lock")
        owner_value = record.get("owner")
        if isinstance(owner_value, dict):
            owner_value = owner_value.get("name")
        result.append(
            GitLfsLockResponse(
                id=str(record.get("id") or f"path:{record.get('path') or index}"),
                path=str(record.get("path") or "unknown"),
                owner=str(owner_value) if owner_value else None,
                locked_at=str(record.get("locked_at")) if record.get("locked_at") else None,
            )
        )
    return result


def _lfs_status(record: dict[str, object]) -> str:
    if record.get("missing") is True or record.get("downloaded") is False:
        return "missing"
    if record.get("modified") is True:
        return "modified"
    return "tracked"


def _optional_int(value: str | None) -> int | None:
    return int(value) if value else None


def _read_revision_lines(path: Path) -> list[str]:
    if not path.is_file():
        return []
    return [line.strip() for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def _read_first_line(path: Path) -> str | None:
    values = _read_revision_lines(path)
    return values[0] if values else None
