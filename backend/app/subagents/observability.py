from __future__ import annotations

from datetime import datetime
from typing import Any

from backend.app.subagents.models import SubagentRunSnapshot


def subagent_log_fields(
    event: str,
    snapshot: SubagentRunSnapshot,
    *,
    duration_ms: int | None = None,
    error_code: str | None = None,
) -> dict[str, Any]:
    """Return a bounded allow-list of identifiers and lifecycle metadata.

    Task text, prompts, final reports, transcript content and error messages are
    intentionally not accepted by this API, so callers cannot accidentally log
    child conversation content.
    """

    fields: dict[str, Any] = {
        "event": str(event or "subagent").strip() or "subagent",
        "parent_session_id": snapshot.parent_session_id,
        "parent_trace_id": snapshot.parent_trace_id or "-",
        "parent_tool_call_id": snapshot.parent_tool_call_id or "-",
        "subagent_id": snapshot.subagent_id,
        "run_id": snapshot.run_id,
        "child_session_id": snapshot.child_session_id,
        "role": snapshot.role.value,
        "state": snapshot.state.value,
        "version": snapshot.version,
    }
    resolved_duration = duration_ms
    if resolved_duration is None and snapshot.updated_at is not None:
        resolved_duration = _duration_ms(snapshot.created_at, snapshot.updated_at)
    if resolved_duration is not None:
        fields["duration_ms"] = max(0, int(resolved_duration))
    resolved_error_code = str(error_code or snapshot.error_code or "").strip()
    if resolved_error_code:
        fields["error_code"] = resolved_error_code
    return fields


def format_subagent_log(
    event: str,
    snapshot: SubagentRunSnapshot,
    *,
    duration_ms: int | None = None,
    error_code: str | None = None,
) -> str:
    fields = subagent_log_fields(
        event,
        snapshot,
        duration_ms=duration_ms,
        error_code=error_code,
    )
    return "[SubagentRuntime] " + " | ".join(
        f"{key}={value}" for key, value in fields.items()
    )


def _duration_ms(start: datetime, end: datetime) -> int:
    return max(0, int((end - start).total_seconds() * 1000))
