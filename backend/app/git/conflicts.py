from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from .models import GitApiError

GitConflictKind = Literal[
    "both_modified", "add_add", "delete_modify", "rename", "binary", "submodule"
]


@dataclass(frozen=True)
class GitUnmergedIndexEntry:
    path: str
    stage: Literal[1, 2, 3]
    object_id: str
    mode: str


def parse_unmerged_index(value: str) -> list[GitUnmergedIndexEntry]:
    entries: list[GitUnmergedIndexEntry] = []
    for record in value.split("\0"):
        if not record:
            continue
        header, separator, path = record.partition("\t")
        parts = header.split()
        if not separator or len(parts) != 3 or parts[2] not in {"1", "2", "3"}:
            raise GitApiError("git_parse_failed", "Git returned an invalid unmerged index record")
        mode, object_id, stage = parts
        if len(mode) != 6 or not mode.isdigit() or len(object_id) < 4 or not path:
            raise GitApiError("git_parse_failed", "Git returned invalid unmerged stage metadata")
        entries.append(
            GitUnmergedIndexEntry(
                path=path,
                stage=int(stage),  # type: ignore[arg-type]
                object_id=object_id,
                mode=mode,
            )
        )
    return entries


def classify_conflict(
    stages: set[int],
    *,
    binary: bool,
    submodule: bool,
    rename: bool,
) -> GitConflictKind:
    if submodule:
        return "submodule"
    if binary:
        return "binary"
    if rename:
        return "rename"
    if stages == {2, 3}:
        return "add_add"
    if stages in ({1, 2}, {1, 3}):
        return "delete_modify"
    return "both_modified"


def resolution_actions(kind: GitConflictKind) -> tuple[str, ...]:
    if kind == "submodule":
        return ("accept_ours", "accept_theirs")
    if kind == "binary":
        return ("accept_ours", "accept_theirs", "delete")
    if kind == "delete_modify":
        return ("keep_modified", "accept_delete")
    if kind == "rename":
        return ("accept_ours", "accept_theirs", "edit", "delete")
    return ("accept_ours", "accept_theirs", "edit", "take_both", "delete")


def decode_conflict_content(payload: bytes) -> tuple[str | None, bool, str, str]:
    if b"\0" in payload[:8000]:
        return None, True, "binary", "none"
    encoding = "utf-8-bom" if payload.startswith(b"\xef\xbb\xbf") else "utf-8"
    try:
        text = payload.decode("utf-8-sig", errors="strict")
    except UnicodeDecodeError:
        return None, True, "unsupported", "none"
    crlf = text.count("\r\n")
    lf = text.count("\n") - crlf
    eol = "mixed" if crlf and lf else "crlf" if crlf else "lf" if lf else "none"
    return text, False, encoding, eol
