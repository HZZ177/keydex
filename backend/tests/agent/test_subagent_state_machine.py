from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from backend.app.subagents.errors import SubagentError, SubagentErrorCode
from backend.app.subagents.models import SubagentInstanceState, SubagentRunSnapshot
from backend.app.subagents.state_machine import (
    close_instance,
    derive_instance_state,
    ensure_instance_can_start,
    merge_versioned_snapshot,
    set_blocked_on,
    transition_run,
)

NOW = datetime(2026, 7, 18, 8, 0, tzinfo=UTC)


def _run(state: str, *, suffix: str = "1") -> SubagentRunSnapshot:
    payload: dict[str, object] = {
        "run_id": f"run-{suffix}",
        "subagent_id": "subagent-1",
        "child_session_id": "child-1",
        "parent_session_id": "parent-1",
        "parent_trace_id": "trace-1",
        "parent_tool_call_id": "tool-1",
        "parent_timeline_sequence": int(suffix),
        "initiated_by": "main_agent",
        "role": "worker",
        "task": "Do the bounded task",
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
        payload["error_code"] = "TEST_FAILURE"
        payload["error_message"] = "failed"
    return SubagentRunSnapshot.model_validate(payload)


def test_ist_001_new_instance_without_active_run_is_idle() -> None:
    assert derive_instance_state(closed_at=None, runs=[]) is SubagentInstanceState.IDLE


@pytest.mark.parametrize(
    "active_state",
    [
        pytest.param("queued", id="UT-IST-002-queued"),
        pytest.param("running", id="UT-IST-002-running"),
    ],
)
def test_ist_002_active_run_derives_running(active_state: str) -> None:
    assert derive_instance_state(
        closed_at=None, runs=[_run(active_state)]
    ) is SubagentInstanceState.RUNNING


@pytest.mark.parametrize(
    ("state", "test_id"),
    [
        pytest.param("completed", "UT-IST-003", id="UT-IST-003-completed-idle"),
        pytest.param("failed", "UT-IST-004", id="UT-IST-004-failed-idle"),
        pytest.param("cancelled", "UT-IST-005", id="UT-IST-005-cancelled-idle"),
        pytest.param(
            "interrupted", "UT-IST-006", id="UT-IST-006-interrupted-idle"
        ),
    ],
)
def test_ist_003_006_terminal_history_derives_idle(state: str, test_id: str) -> None:
    assert test_id
    assert derive_instance_state(
        closed_at=None, runs=[_run(state)]
    ) is SubagentInstanceState.IDLE


def test_ist_007_idle_instance_can_close() -> None:
    closed_at = close_instance(closed_at=None, runs=[], now=NOW)
    assert closed_at == NOW
    assert derive_instance_state(
        closed_at=closed_at, runs=[]
    ) is SubagentInstanceState.CLOSED


def test_ist_010_second_active_run_is_rejected() -> None:
    with pytest.raises(SubagentError) as exc_info:
        ensure_instance_can_start(closed_at=None, runs=[_run("running")])
    assert exc_info.value.code is SubagentErrorCode.RUN_ALREADY_ACTIVE

    with pytest.raises(SubagentError) as inconsistent:
        derive_instance_state(
            closed_at=None,
            runs=[_run("queued", suffix="1"), _run("running", suffix="2")],
        )
    assert inconsistent.value.code is SubagentErrorCode.RUN_ALREADY_ACTIVE


def test_ist_011_running_instance_must_be_cancelled_before_close() -> None:
    with pytest.raises(SubagentError) as exc_info:
        close_instance(closed_at=None, runs=[_run("running")], now=NOW)
    assert exc_info.value.code is SubagentErrorCode.SUBAGENT_CLOSE_REQUIRES_CANCEL


@pytest.mark.parametrize(
    ("operation", "test_id"),
    [
        pytest.param("start", "UT-IST-012", id="UT-IST-012-closed-start"),
        pytest.param("derive_idle", "UT-IST-013", id="UT-IST-013-closed-stays-closed"),
        pytest.param("resume", "UT-IST-014", id="UT-IST-014-closed-resume"),
    ],
)
def test_ist_012_014_closed_instance_cannot_return_to_running_or_idle(
    operation: str, test_id: str
) -> None:
    assert test_id
    if operation == "derive_idle":
        assert derive_instance_state(
            closed_at=NOW, runs=[_run("completed")]
        ) is SubagentInstanceState.CLOSED
    else:
        with pytest.raises(SubagentError) as exc_info:
            ensure_instance_can_start(closed_at=NOW, runs=[])
        assert exc_info.value.code is SubagentErrorCode.SUBAGENT_CLOSED


def test_ist_015_repeated_close_is_idempotent() -> None:
    first_closed_at = close_instance(closed_at=None, runs=[], now=NOW)
    second_closed_at = close_instance(
        closed_at=first_closed_at,
        runs=[_run("completed")],
        now=NOW + timedelta(hours=1),
    )
    assert second_closed_at == first_closed_at


def test_rst_001_created_run_is_queued_at_version_one() -> None:
    run = _run("queued")
    assert run.state.value == "queued"
    assert run.version == 1
    assert run.started_at is None
    assert run.finished_at is None


def test_rst_002_queued_to_running_sets_start_time_and_increments_version() -> None:
    run = transition_run(_run("queued"), "running", expected_version=1, now=NOW)
    assert run.state.value == "running"
    assert run.started_at == NOW
    assert run.finished_at is None
    assert run.version == 2


@pytest.mark.parametrize(
    ("state", "kwargs", "test_id"),
    [
        ("cancelled", {}, "UT-RST-003"),
        (
            "failed",
            {"error_code": "START_FAILED", "error_message": "could not start"},
            "UT-RST-004",
        ),
        ("interrupted", {}, "UT-RST-005"),
    ],
)
def test_rst_003_005_queued_can_end_without_starting(
    state: str, kwargs: dict[str, object], test_id: str
) -> None:
    assert test_id
    run = transition_run(
        _run("queued"), state, expected_version=1, now=NOW + timedelta(seconds=1), **kwargs
    )
    assert run.state.value == state
    assert run.started_at is None
    assert run.finished_at == NOW + timedelta(seconds=1)
    assert run.version == 2


@pytest.mark.parametrize(
    ("state", "kwargs", "test_id"),
    [
        ("completed", {"final_report": "done"}, "UT-RST-006"),
        (
            "failed",
            {"error_code": "CHILD_FAILED", "error_message": "child failed"},
            "UT-RST-007",
        ),
        ("cancelled", {}, "UT-RST-008"),
        ("interrupted", {}, "UT-RST-009"),
    ],
)
def test_rst_006_009_running_can_enter_each_terminal_state(
    state: str, kwargs: dict[str, object], test_id: str
) -> None:
    assert test_id
    run = transition_run(
        _run("running"), state, expected_version=1, now=NOW + timedelta(seconds=1), **kwargs
    )
    assert run.state.value == state
    assert run.finished_at == NOW + timedelta(seconds=1)
    assert run.version == 2


@pytest.mark.parametrize(
    ("from_state", "to_state", "test_id"),
    [
        ("queued", "completed", "UT-RST-020"),
        ("running", "queued", "UT-RST-021"),
    ],
)
def test_rst_020_021_rejects_invalid_active_transitions(
    from_state: str, to_state: str, test_id: str
) -> None:
    original = _run(from_state)
    with pytest.raises(SubagentError) as exc_info:
        transition_run(original, to_state, expected_version=1, now=NOW)
    assert test_id
    assert exc_info.value.code is SubagentErrorCode.RUN_TRANSITION_INVALID
    assert original.version == 1


@pytest.mark.parametrize(
    "terminal_state",
    [
        pytest.param("completed", id="from-completed"),
        pytest.param("failed", id="from-failed"),
        pytest.param("cancelled", id="from-cancelled"),
        pytest.param("interrupted", id="from-interrupted"),
    ],
)
@pytest.mark.parametrize(
    "requested_state",
    [
        pytest.param("queued", id="to-queued"),
        pytest.param("running", id="to-running"),
        pytest.param("completed", id="to-completed"),
        pytest.param("failed", id="to-failed"),
        pytest.param("cancelled", id="to-cancelled"),
        pytest.param("interrupted", id="to-interrupted"),
    ],
)
def test_rst_022_030_terminal_state_is_immutable(
    terminal_state: str, requested_state: str
) -> None:
    original = _run(terminal_state)
    kwargs: dict[str, object] = {}
    if requested_state == terminal_state == "completed":
        kwargs["final_report"] = "done"
    if requested_state == terminal_state == "failed":
        kwargs.update(error_code="TEST_FAILURE", error_message="failed")

    if requested_state == terminal_state:
        assert transition_run(
            original, requested_state, expected_version=1, now=NOW, **kwargs
        ) is original
    else:
        with pytest.raises(SubagentError) as exc_info:
            transition_run(original, requested_state, expected_version=1, now=NOW)
        assert exc_info.value.code is SubagentErrorCode.RUN_TERMINAL
    assert original.version == 1


def test_rst_031_same_terminal_payload_replay_is_idempotent() -> None:
    original = _run("completed")
    replayed = transition_run(
        original,
        "completed",
        expected_version=1,
        now=NOW + timedelta(hours=1),
        final_report="done",
    )
    assert replayed is original


def test_rst_032_different_terminal_payload_replay_is_rejected() -> None:
    original = _run("completed")
    with pytest.raises(SubagentError) as exc_info:
        transition_run(
            original,
            "completed",
            expected_version=1,
            now=NOW,
            final_report="different",
        )
    assert exc_info.value.code is SubagentErrorCode.RUN_TERMINAL
    assert original.final_report == "done"


@pytest.mark.parametrize("blocked_on", ["approval", "user_input", "external_tool"])
def test_blk_001_006_running_block_reason_is_orthogonal_and_clearable(
    blocked_on: str,
) -> None:
    original = _run("running")
    blocked = set_blocked_on(original, blocked_on, expected_version=1)
    assert blocked.state.value == "running"
    assert blocked.blocked_on.value == blocked_on
    assert blocked.version == 2

    cleared = set_blocked_on(blocked, None, expected_version=2)
    assert cleared.state.value == "running"
    assert cleared.blocked_on is None
    assert cleared.version == 3


@pytest.mark.parametrize(
    "state", ["queued", "completed", "failed", "cancelled", "interrupted"]
)
def test_blk_007_011_non_running_run_rejects_block_reason(state: str) -> None:
    with pytest.raises(SubagentError) as exc_info:
        set_blocked_on(_run(state), "approval", expected_version=1)
    assert exc_info.value.code is SubagentErrorCode.RUN_TRANSITION_INVALID


def test_blk_012_terminal_transition_atomically_clears_block_reason() -> None:
    blocked = set_blocked_on(_run("running"), "approval", expected_version=1)
    completed = transition_run(
        blocked,
        "completed",
        expected_version=2,
        now=NOW + timedelta(seconds=1),
        final_report="approved and done",
    )
    assert completed.blocked_on is None
    assert completed.state.value == "completed"


def test_ver_001_each_real_change_increments_version_once() -> None:
    running = _run("running")
    blocked = set_blocked_on(running, "user_input", expected_version=1)
    duplicate = set_blocked_on(blocked, "user_input", expected_version=2)
    assert blocked.version == 2
    assert duplicate is blocked


def test_ver_002_stale_expected_version_is_rejected_without_mutation() -> None:
    original = _run("running")
    with pytest.raises(SubagentError) as exc_info:
        set_blocked_on(original, "approval", expected_version=0)
    assert exc_info.value.code is SubagentErrorCode.RUN_VERSION_CONFLICT
    assert original.version == 1
    assert original.blocked_on is None


def test_ver_003_identical_same_version_snapshot_is_idempotent() -> None:
    original = _run("running")
    duplicate = SubagentRunSnapshot.model_validate(original.model_dump())
    assert merge_versioned_snapshot(original, duplicate) is original


def test_ver_004_lower_version_snapshot_cannot_overwrite_newer_state() -> None:
    old = _run("running")
    current = set_blocked_on(old, "approval", expected_version=1)
    assert merge_versioned_snapshot(current, old) is current


def test_ver_005_conflicting_same_version_snapshot_is_rejected() -> None:
    current = _run("running")
    conflicting = SubagentRunSnapshot.model_validate(
        {**current.model_dump(), "task": "different payload"}
    )
    with pytest.raises(SubagentError) as exc_info:
        merge_versioned_snapshot(current, conflicting)
    assert exc_info.value.code is SubagentErrorCode.RUN_VERSION_CONFLICT
