from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from backend.app.subagents.errors import SubagentError, SubagentErrorCode
from backend.app.subagents.models import SubagentRunSnapshot
from backend.app.subagents.ownership import (
    assert_run_collection_isolated,
    run_ownership_key,
)

NOW = datetime(2026, 7, 18, 8, 0, tzinfo=UTC)


def _run(
    number: int,
    *,
    subagent_id: str,
    child_session_id: str,
    role: str,
    state: str = "running",
    parent_session_id: str = "parent-1",
) -> SubagentRunSnapshot:
    payload: dict[str, object] = {
        "run_id": f"run-{number}",
        "subagent_id": subagent_id,
        "child_session_id": child_session_id,
        "parent_session_id": parent_session_id,
        "parent_trace_id": f"trace-{number}",
        "parent_tool_call_id": f"tool-{number}",
        "parent_timeline_sequence": number,
        "initiated_by": "main_agent",
        "role": role,
        "task": f"task {number}",
        "state": state,
        "version": 1,
        "created_at": NOW,
    }
    if state != "queued":
        payload["started_at"] = NOW
    if state in {"completed", "failed", "cancelled", "interrupted"}:
        payload["finished_at"] = NOW + timedelta(seconds=1)
    if state == "completed":
        payload["final_report"] = "done"
    if state == "failed":
        payload.update(error_code="FAILED", error_message="failed")
    return SubagentRunSnapshot.model_validate(payload)


def test_multiple_explorer_instances_may_run_in_parallel() -> None:
    runs = [
        _run(1, subagent_id="explorer-1", child_session_id="child-1", role="explorer"),
        _run(2, subagent_id="explorer-2", child_session_id="child-2", role="explorer"),
    ]
    assert_run_collection_isolated(runs)
    assert run_ownership_key(runs[0]) != run_ownership_key(runs[1])


def test_multiple_worker_instances_may_run_in_parallel() -> None:
    assert_run_collection_isolated(
        [
            _run(1, subagent_id="worker-1", child_session_id="child-1", role="worker"),
            _run(2, subagent_id="worker-2", child_session_id="child-2", role="worker"),
        ]
    )


def test_explorer_and_worker_may_run_in_parallel_without_role_mutex() -> None:
    assert_run_collection_isolated(
        [
            _run(1, subagent_id="explorer-1", child_session_id="child-1", role="explorer"),
            _run(2, subagent_id="worker-1", child_session_id="child-2", role="worker"),
        ]
    )


def test_same_instance_may_keep_terminal_history_and_one_active_run() -> None:
    assert_run_collection_isolated(
        [
            _run(
                1,
                subagent_id="worker-1",
                child_session_id="child-1",
                role="worker",
                state="completed",
            ),
            _run(2, subagent_id="worker-1", child_session_id="child-1", role="worker"),
        ]
    )


def test_same_instance_cannot_have_two_active_runs() -> None:
    with pytest.raises(SubagentError) as exc_info:
        assert_run_collection_isolated(
            [
                _run(1, subagent_id="worker-1", child_session_id="child-1", role="worker"),
                _run(2, subagent_id="worker-1", child_session_id="child-1", role="worker"),
            ]
        )
    assert exc_info.value.code is SubagentErrorCode.RUN_ALREADY_ACTIVE


@pytest.mark.parametrize("changed", ["parent", "child", "role"])
def test_instance_identity_cannot_change_across_resume_history(changed: str) -> None:
    original = _run(
        1,
        subagent_id="worker-1",
        child_session_id="child-1",
        role="worker",
        state="completed",
    )
    kwargs = {
        "subagent_id": "worker-1",
        "child_session_id": "child-2" if changed == "child" else "child-1",
        "role": "explorer" if changed == "role" else "worker",
        "parent_session_id": "parent-2" if changed == "parent" else "parent-1",
    }
    resumed = _run(2, **kwargs)
    with pytest.raises(SubagentError) as exc_info:
        assert_run_collection_isolated([original, resumed])
    assert exc_info.value.code is SubagentErrorCode.SUBAGENT_PARENT_INVALID


def test_parallel_runs_require_unique_parent_timeline_sequences() -> None:
    first = _run(1, subagent_id="worker-1", child_session_id="child-1", role="worker")
    second = _run(2, subagent_id="worker-2", child_session_id="child-2", role="worker")
    conflicting = SubagentRunSnapshot.model_validate(
        {**second.model_dump(), "parent_timeline_sequence": first.parent_timeline_sequence}
    )
    with pytest.raises(SubagentError) as exc_info:
        assert_run_collection_isolated([first, conflicting])
    assert exc_info.value.code is SubagentErrorCode.RUN_VERSION_CONFLICT


def test_two_parents_are_isolated_even_when_sequence_numbers_match() -> None:
    assert_run_collection_isolated(
        [
            _run(1, subagent_id="worker-1", child_session_id="child-1", role="worker"),
            _run(
                1,
                subagent_id="worker-2",
                child_session_id="child-2",
                role="worker",
                parent_session_id="parent-2",
            ).model_copy(update={"run_id": "run-parent-2"}),
        ]
    )
