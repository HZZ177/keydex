from __future__ import annotations

from typing import Any

from backend.app.subagents.errors import SubagentErrorCode
from backend.app.subagents.models import SubagentRunSnapshot, SubagentRunState

DELEGATE_SUBAGENT_MAX_REPORT_BYTES = 10_000
_REPORT_TRUNCATION_MARKER = (
    "\n...[Sub-Agent final report truncated; open the child session for the complete report]"
)
_RETRYABLE_TERMINAL_ERROR_CODES = frozenset(
    {
        SubagentErrorCode.SUBAGENT_START_FAILED.value,
        SubagentErrorCode.SUBAGENT_RUN_FAILED.value,
        SubagentErrorCode.SUBAGENT_INTERRUPTED.value,
    }
)


def extract_subagent_final_report(result: Any) -> str | None:
    """Extract the current child turn's final assistant report, never its transcript."""

    content = getattr(result, "final_content", result)
    if not isinstance(content, str):
        return None
    report = content.strip()
    return report or None


def format_delegate_subagent_result(
    snapshot: SubagentRunSnapshot,
    *,
    max_report_bytes: int = DELEGATE_SUBAGENT_MAX_REPORT_BYTES,
) -> dict[str, Any]:
    """Build the bounded, model-visible terminal result without child internals."""

    if not snapshot.is_terminal:
        raise ValueError("delegate result formatter requires a terminal Run")
    base = {
        "schema_version": snapshot.schema_version,
        "state": snapshot.state.value,
        "subagent_id": snapshot.subagent_id,
        "run_id": snapshot.run_id,
        "child_session_id": snapshot.child_session_id,
        "role": snapshot.role.value,
    }
    if snapshot.state is not SubagentRunState.COMPLETED:
        error_code, error_message = _terminal_error(snapshot)
        return {
            **base,
            "ok": False,
            "error": {
                "code": error_code,
                "message": error_message,
                "retryable": error_code in _RETRYABLE_TERMINAL_ERROR_CODES,
            },
        }
    report = snapshot.final_report
    if report is None or not report.strip():
        raise ValueError("completed Sub-Agent Run requires a non-empty final report")
    bounded_report, report_truncated = _bounded_utf8_report(
        report,
        max_bytes=max_report_bytes,
    )
    return {
        **base,
        "ok": True,
        "final_report": bounded_report,
        "report_truncated": snapshot.report_truncated or report_truncated,
    }


def _terminal_error(snapshot: SubagentRunSnapshot) -> tuple[str, str]:
    if snapshot.state is SubagentRunState.FAILED:
        return (
            snapshot.error_code or SubagentErrorCode.SUBAGENT_RUN_FAILED.value,
            snapshot.error_message or "Sub-Agent execution failed",
        )
    if snapshot.state is SubagentRunState.CANCELLED:
        return (
            SubagentErrorCode.SUBAGENT_CANCELLED.value,
            "Sub-Agent execution was cancelled",
        )
    if snapshot.state is SubagentRunState.INTERRUPTED:
        return (
            SubagentErrorCode.SUBAGENT_INTERRUPTED.value,
            "Sub-Agent execution was interrupted and may be resumed",
        )
    raise ValueError(f"unsupported Sub-Agent terminal state: {snapshot.state.value}")


def _bounded_utf8_report(value: str, *, max_bytes: int) -> tuple[str, bool]:
    if max_bytes <= 0:
        raise ValueError("max_report_bytes must be positive")
    encoded = value.encode("utf-8")
    if len(encoded) <= max_bytes:
        return value, False

    marker = _REPORT_TRUNCATION_MARKER
    marker_bytes = marker.encode("utf-8")
    if len(marker_bytes) >= max_bytes:
        marker = "...<truncated>"
        marker_bytes = marker.encode("utf-8")
    if len(marker_bytes) >= max_bytes:
        marker = marker_bytes[:max_bytes].decode("utf-8", errors="ignore")
        marker_bytes = marker.encode("utf-8")
    prefix = encoded[: max(0, max_bytes - len(marker_bytes))]
    while prefix:
        try:
            text = prefix.decode("utf-8")
            break
        except UnicodeDecodeError as exc:
            prefix = prefix[: exc.start]
    else:
        text = ""
    return f"{text}{marker}", True
