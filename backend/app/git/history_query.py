from __future__ import annotations

import re
from dataclasses import dataclass, replace
from datetime import date, datetime

from .history import LOG_FORMAT
from .security import GitParameterError, validate_repo_relative_path, validate_revision

_HASH_PREFIX = re.compile(r"^[0-9a-fA-F]{4,64}$")


@dataclass(frozen=True)
class GitHistoryQuery:
    text: str | None = None
    hash_prefix: str | None = None
    revision: str | None = None
    author: str | None = None
    since: str | None = None
    until: str | None = None
    path: str | None = None
    first_parent: bool = False
    merges_only: bool = False
    exact_revision: str | None = None


def normalize_history_query(query: GitHistoryQuery) -> GitHistoryQuery:
    return GitHistoryQuery(
        text=_safe_text(query.text, "History text", 512),
        hash_prefix=_hash_prefix(query.hash_prefix),
        revision=_history_revision(query.revision) if query.revision else None,
        author=_safe_text(query.author, "History author", 256),
        since=_date_value(query.since, "History since"),
        until=_date_value(query.until, "History until"),
        path=validate_repo_relative_path(query.path) if query.path else None,
        first_parent=bool(query.first_parent),
        merges_only=bool(query.merges_only),
        exact_revision=validate_revision(query.exact_revision) if query.exact_revision else None,
    )


def with_exact_revision(query: GitHistoryQuery, object_id: str) -> GitHistoryQuery:
    if not re.fullmatch(r"[0-9a-fA-F]{40,64}", object_id):
        raise GitParameterError("Resolved history object ID is invalid")
    return replace(query, exact_revision=object_id)


def build_history_log_args(
    query: GitHistoryQuery,
    *,
    offset: int,
    limit: int,
) -> list[str]:
    normalized = normalize_history_query(query)
    args = [
        "log",
        "--topo-order",
        "--date-order",
        f"--max-count={limit + 1}",
        f"--skip={offset}",
        f"--format={LOG_FORMAT}",
        "--decorate=full",
    ]
    if normalized.text:
        args.extend(["--regexp-ignore-case", "--fixed-strings", f"--grep={normalized.text}"])
    if normalized.author:
        args.append(f"--author={normalized.author}")
    if normalized.since:
        args.append(f"--since={normalized.since}")
    if normalized.until:
        args.append(f"--until={normalized.until}")
    if normalized.first_parent:
        args.append("--first-parent")
    if normalized.merges_only:
        args.append("--merges")

    if normalized.exact_revision:
        args.append(f"{normalized.exact_revision}^!")
    elif normalized.revision:
        args.append(normalized.revision)
    else:
        args.append("--all")
    if normalized.path:
        args.extend(["--", normalized.path])
    return args


def _safe_text(value: str | None, label: str, max_length: int) -> str | None:
    if value is None:
        return None
    normalized = value.strip()
    if not normalized:
        return None
    if (
        len(normalized) > max_length
        or "\x00" in normalized
        or "\r" in normalized
        or "\n" in normalized
    ):
        raise GitParameterError(f"{label} is invalid")
    return normalized


def _hash_prefix(value: str | None) -> str | None:
    normalized = _safe_text(value, "History hash", 64)
    if normalized is None:
        return None
    if not _HASH_PREFIX.fullmatch(normalized):
        raise GitParameterError("History hash must contain 4 to 64 hexadecimal characters")
    return normalized.lower()


def _history_revision(value: str) -> str:
    revision = value.strip()
    separator = "..." if "..." in revision else ".." if ".." in revision else None
    if separator is None:
        return validate_revision(revision)
    if revision.count(separator) != 1:
        raise GitParameterError("History revision range is invalid")
    left, right = revision.split(separator, 1)
    if not left or not right:
        raise GitParameterError("History revision range requires two revisions")
    return f"{validate_revision(left)}{separator}{validate_revision(right)}"


def _date_value(value: str | None, label: str) -> str | None:
    normalized = _safe_text(value, label, 64)
    if normalized is None:
        return None
    try:
        if "T" in normalized or " " in normalized:
            datetime.fromisoformat(normalized.replace("Z", "+00:00"))
        else:
            date.fromisoformat(normalized)
    except ValueError as exc:
        raise GitParameterError(f"{label} must be an ISO date or datetime") from exc
    return normalized
