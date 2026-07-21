from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time
from dataclasses import dataclass
from typing import Any

_CURSOR_SCHEMA = "keydex.search_cursor.v1"
_CURSOR_SECRET = secrets.token_bytes(32)
_CURSOR_RUNTIME = secrets.token_hex(8)
_CURSOR_TTL_SECONDS = 60 * 60


class InvalidContinuationCursor(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class SearchContinuation:
    tool_name: str
    offset: int
    logical_query_id: str
    page_index: int


def issue_search_cursor(
    *,
    tool_name: str,
    args: dict[str, Any],
    offset: int,
    logical_query_id: str | None = None,
    page_index: int = 1,
) -> str:
    payload = {
        "schema": _CURSOR_SCHEMA,
        "runtime": _CURSOR_RUNTIME,
        "tool": tool_name,
        "scope": _scope_fingerprint(tool_name, args),
        "offset": max(0, int(offset)),
        "logical_query_id": logical_query_id or f"lq_{secrets.token_hex(12)}",
        "page_index": max(1, int(page_index)),
        "issued_at": int(time.time()),
    }
    encoded = _b64(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8"))
    signature = _b64(hmac.new(_CURSOR_SECRET, encoded.encode("ascii"), hashlib.sha256).digest())
    return f"{encoded}.{signature}"


def validate_search_cursor(
    cursor: str,
    *,
    tool_name: str,
    args: dict[str, Any],
    now: int | None = None,
) -> SearchContinuation:
    try:
        encoded, signature = str(cursor).split(".", 1)
        expected = _b64(hmac.new(_CURSOR_SECRET, encoded.encode("ascii"), hashlib.sha256).digest())
        if not hmac.compare_digest(signature, expected):
            raise InvalidContinuationCursor("cursor signature mismatch")
        payload = json.loads(_unb64(encoded).decode("utf-8"))
    except InvalidContinuationCursor:
        raise
    except Exception as exc:
        raise InvalidContinuationCursor("invalid cursor encoding") from exc
    current = int(time.time()) if now is None else int(now)
    if payload.get("schema") != _CURSOR_SCHEMA or payload.get("runtime") != _CURSOR_RUNTIME:
        raise InvalidContinuationCursor("cursor version mismatch")
    if payload.get("tool") != tool_name:
        raise InvalidContinuationCursor("cursor tool mismatch")
    if payload.get("scope") != _scope_fingerprint(tool_name, args):
        raise InvalidContinuationCursor("cursor query or scope mismatch")
    issued_at = int(payload.get("issued_at") or 0)
    if issued_at <= 0 or current - issued_at > _CURSOR_TTL_SECONDS or issued_at > current + 60:
        raise InvalidContinuationCursor("cursor expired")
    return SearchContinuation(
        tool_name=tool_name,
        offset=max(0, int(payload.get("offset") or 0)),
        logical_query_id=str(payload.get("logical_query_id") or ""),
        page_index=max(1, int(payload.get("page_index") or 1)),
    )


def _scope_fingerprint(tool_name: str, args: dict[str, Any]) -> str:
    excluded = {"cursor", "next_cursor", "limit"}
    normalized = {
        str(key): _normalize(value)
        for key, value in args.items()
        if str(key) not in excluded and value is not None
    }
    raw = json.dumps(
        {"tool": tool_name, "args": normalized},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def _normalize(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): _normalize(item) for key, item in sorted(value.items())}
    if isinstance(value, (list, tuple)):
        return [_normalize(item) for item in value]
    if isinstance(value, str):
        return value.replace("\\", "/")
    return value


def _b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _unb64(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
