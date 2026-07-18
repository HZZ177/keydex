from __future__ import annotations

from datetime import UTC, datetime

from backend.app.subagents.models import (
    SubagentInitiator,
    SubagentRole,
    SubagentRunSnapshot,
    SubagentRunState,
)
from backend.app.subagents.observability import (
    format_subagent_log,
    subagent_log_fields,
)


def test_log_fields_correlate_parent_child_and_run_without_conversation_content() -> None:
    snapshot = _snapshot()

    fields = subagent_log_fields("transition", snapshot)
    message = format_subagent_log("transition", snapshot)

    assert fields == {
        "event": "transition",
        "parent_session_id": "parent-1",
        "parent_trace_id": "trace-1",
        "parent_tool_call_id": "tool-call-1",
        "subagent_id": "subagent-1",
        "run_id": "run-1",
        "child_session_id": "child-1",
        "role": "worker",
        "state": "failed",
        "version": 3,
        "duration_ms": 2000,
        "error_code": "SUBAGENT_RUN_FAILED",
    }
    assert "secret task payload" not in message
    assert "private transcript" not in message
    assert "provider secret" not in message
    assert "run_id=run-1" in message
    assert "error_code=SUBAGENT_RUN_FAILED" in message


def test_explicit_operation_duration_is_bounded_and_does_not_expand_schema() -> None:
    fields = subagent_log_fields("wait", _snapshot(), duration_ms=-10)

    assert fields["duration_ms"] == 0
    assert set(fields).isdisjoint({"task", "prompt", "final_report", "error_message"})


def _snapshot() -> SubagentRunSnapshot:
    started = datetime(2026, 7, 18, 0, 0, 0, tzinfo=UTC)
    finished = datetime(2026, 7, 18, 0, 0, 2, tzinfo=UTC)
    return SubagentRunSnapshot(
        run_id="run-1",
        subagent_id="subagent-1",
        child_session_id="child-1",
        parent_session_id="parent-1",
        parent_trace_id="trace-1",
        parent_tool_call_id="tool-call-1",
        parent_timeline_sequence=4,
        initiated_by=SubagentInitiator.MAIN_AGENT,
        role=SubagentRole.WORKER,
        task="secret task payload",
        state=SubagentRunState.FAILED,
        version=3,
        error_code="SUBAGENT_RUN_FAILED",
        error_message="provider secret and private transcript",
        created_at=started,
        queued_at=started,
        started_at=started,
        finished_at=finished,
        updated_at=finished,
    )
