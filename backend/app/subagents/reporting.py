from __future__ import annotations

from typing import Any

from backend.app.subagents.errors import SubagentErrorCode
from backend.app.subagents.models import SubagentRunSnapshot, SubagentRunState

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
) -> dict[str, Any]:
    """Build the complete model-visible terminal result without child internals."""

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
    return {
        **base,
        "ok": True,
        "final_report": report,
        "report_truncated": snapshot.report_truncated,
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
