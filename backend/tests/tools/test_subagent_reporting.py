from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace

import pytest

from backend.app.subagents.models import SubagentRunSnapshot
from backend.app.subagents.reporting import (
    DELEGATE_SUBAGENT_MAX_REPORT_BYTES,
    extract_subagent_final_report,
    format_delegate_subagent_result,
)

NOW = datetime(2026, 7, 18, 13, 0, tzinfo=UTC)


def _completed_snapshot(*, report: str = "bounded final report") -> SubagentRunSnapshot:
    return SubagentRunSnapshot(
        run_id="run-1",
        subagent_id="subagent-1",
        child_session_id="child-1",
        parent_session_id="parent-1",
        parent_trace_id="trace-secret",
        parent_tool_call_id="tool-call-1",
        parent_timeline_sequence=7,
        initiated_by="main_agent",
        role="explorer",
        task="sensitive delegated task",
        state="completed",
        version=3,
        final_report=report,
        created_at=NOW,
        queued_at=NOW,
        started_at=NOW,
        finished_at=NOW,
        updated_at=NOW,
    )


@pytest.mark.parametrize(
    ("result", "expected"),
    [
        (SimpleNamespace(final_content="  final assistant report  "), "final assistant report"),
        ("  direct report  ", "direct report"),
        (SimpleNamespace(final_content="   "), None),
        (SimpleNamespace(final_content=[{"role": "assistant"}]), None),
    ],
)
def test_extract_final_report_uses_only_non_empty_current_assistant_content(
    result,
    expected,
) -> None:
    assert extract_subagent_final_report(result) == expected


def test_completed_tool_result_exposes_only_terminal_identity_and_report() -> None:
    snapshot = _completed_snapshot()

    result = format_delegate_subagent_result(snapshot)

    assert result == {
        "schema_version": 1,
        "ok": True,
        "state": "completed",
        "subagent_id": "subagent-1",
        "run_id": "run-1",
        "child_session_id": "child-1",
        "role": "explorer",
        "final_report": "bounded final report",
        "report_truncated": False,
    }
    serialized = str(result)
    assert "sensitive delegated task" not in serialized
    assert "trace-secret" not in serialized
    assert "parent_session_id" not in result
    assert "parent_tool_call_id" not in result
    assert "transcript" not in result
    assert "reasoning" not in result


def test_completed_tool_result_bounds_utf8_without_mutating_durable_report() -> None:
    full_report = "调查结论" * (DELEGATE_SUBAGENT_MAX_REPORT_BYTES // 3)
    snapshot = _completed_snapshot(report=full_report)

    result = format_delegate_subagent_result(snapshot)

    assert result["report_truncated"] is True
    assert len(result["final_report"].encode("utf-8")) <= DELEGATE_SUBAGENT_MAX_REPORT_BYTES
    assert result["final_report"] != full_report
    assert snapshot.final_report == full_report


@pytest.mark.parametrize(
    ("state", "error_code", "error_message", "expected_code", "retryable"),
    [
        ("failed", "MISSING_FINAL_REPORT", "missing report", "MISSING_FINAL_REPORT", False),
        ("failed", "SUBAGENT_RUN_FAILED", "provider failed", "SUBAGENT_RUN_FAILED", True),
        ("cancelled", None, None, "SUBAGENT_CANCELLED", False),
        ("interrupted", None, None, "SUBAGENT_INTERRUPTED", True),
    ],
)
def test_non_success_terminal_results_are_explicit_and_never_fake_success(
    state,
    error_code,
    error_message,
    expected_code,
    retryable,
) -> None:
    payload = _completed_snapshot().model_dump()
    payload.update(
        state=state,
        final_report=None,
        error_code=error_code,
        error_message=error_message,
    )
    snapshot = SubagentRunSnapshot.model_validate(payload)

    result = format_delegate_subagent_result(snapshot)

    assert result["ok"] is False
    assert result["state"] == state
    assert result["error"]["code"] == expected_code
    assert result["error"]["retryable"] is retryable
    assert "final_report" not in result


def test_formatter_rejects_active_snapshot() -> None:
    payload = _completed_snapshot().model_dump()
    payload.update(
        state="running",
        final_report=None,
        finished_at=None,
        error_code=None,
        error_message=None,
    )
    snapshot = SubagentRunSnapshot.model_validate(payload)

    with pytest.raises(ValueError, match="terminal"):
        format_delegate_subagent_result(snapshot)
