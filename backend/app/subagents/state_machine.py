from __future__ import annotations

from collections.abc import Iterable
from datetime import datetime

from backend.app.subagents.errors import SubagentError, SubagentErrorCode
from backend.app.subagents.models import (
    ACTIVE_RUN_STATES,
    TERMINAL_RUN_STATES,
    SubagentBlockedOn,
    SubagentInstanceState,
    SubagentRunSnapshot,
    SubagentRunState,
)

_ALLOWED_RUN_TRANSITIONS: dict[SubagentRunState, frozenset[SubagentRunState]] = {
    SubagentRunState.QUEUED: frozenset(
        {
            SubagentRunState.RUNNING,
            SubagentRunState.CANCELLED,
            SubagentRunState.FAILED,
            SubagentRunState.INTERRUPTED,
        }
    ),
    SubagentRunState.RUNNING: TERMINAL_RUN_STATES,
}


def get_active_run(runs: Iterable[SubagentRunSnapshot]) -> SubagentRunSnapshot | None:
    active_runs = [run for run in runs if run.state in ACTIVE_RUN_STATES]
    if len(active_runs) > 1:
        raise SubagentError(
            SubagentErrorCode.RUN_ALREADY_ACTIVE,
            "a Sub-Agent instance cannot have more than one active Run",
            details={"run_ids": [run.run_id for run in active_runs]},
        )
    return active_runs[0] if active_runs else None


def derive_instance_state(
    *,
    closed_at: datetime | None,
    runs: Iterable[SubagentRunSnapshot],
) -> SubagentInstanceState:
    active_run = get_active_run(runs)
    if closed_at is not None:
        if active_run is not None:
            raise SubagentError(
                SubagentErrorCode.SUBAGENT_CLOSED,
                "a closed Sub-Agent instance cannot have an active Run",
                details={"run_id": active_run.run_id},
            )
        return SubagentInstanceState.CLOSED
    if active_run is not None:
        return SubagentInstanceState.RUNNING
    return SubagentInstanceState.IDLE


def ensure_instance_can_start(
    *,
    closed_at: datetime | None,
    runs: Iterable[SubagentRunSnapshot],
) -> None:
    if closed_at is not None:
        raise SubagentError(
            SubagentErrorCode.SUBAGENT_CLOSED,
            "a closed Sub-Agent instance cannot start another Run",
        )
    active_run = get_active_run(runs)
    if active_run is not None:
        raise SubagentError(
            SubagentErrorCode.RUN_ALREADY_ACTIVE,
            "the Sub-Agent instance already has an active Run",
            details={"run_id": active_run.run_id},
        )


def close_instance(
    *,
    closed_at: datetime | None,
    runs: Iterable[SubagentRunSnapshot],
    now: datetime,
) -> datetime:
    active_run = get_active_run(runs)
    if active_run is not None:
        raise SubagentError(
            SubagentErrorCode.SUBAGENT_CLOSE_REQUIRES_CANCEL,
            "an active Run must be cancelled before closing the Sub-Agent instance",
            details={"run_id": active_run.run_id},
        )
    return closed_at or now


def transition_run(
    snapshot: SubagentRunSnapshot,
    to_state: SubagentRunState | str,
    *,
    expected_version: int,
    now: datetime,
    final_report: str | None = None,
    report_truncated: bool = False,
    error_code: str | None = None,
    error_message: str | None = None,
) -> SubagentRunSnapshot:
    try:
        to_state = SubagentRunState(to_state)
    except ValueError as exc:
        raise SubagentError(
            SubagentErrorCode.RUN_TRANSITION_INVALID,
            "the requested Run state is unknown",
            details={"to": str(to_state)},
        ) from exc
    if expected_version != snapshot.version:
        raise SubagentError(
            SubagentErrorCode.RUN_VERSION_CONFLICT,
            "the Run snapshot version is stale",
            details={"expected_version": expected_version, "actual_version": snapshot.version},
        )

    if snapshot.state in TERMINAL_RUN_STATES:
        if snapshot.state is to_state and _terminal_payload_matches(
            snapshot,
            final_report=final_report,
            report_truncated=report_truncated,
            error_code=error_code,
            error_message=error_message,
        ):
            return snapshot
        raise SubagentError(
            SubagentErrorCode.RUN_TERMINAL,
            "terminal Run state is immutable",
            details={"state": snapshot.state.value, "requested_state": to_state.value},
        )

    if to_state not in _ALLOWED_RUN_TRANSITIONS[snapshot.state]:
        raise SubagentError(
            SubagentErrorCode.RUN_TRANSITION_INVALID,
            "the requested Run state transition is not allowed",
            details={"from": snapshot.state.value, "to": to_state.value},
        )

    payload = snapshot.model_dump()
    payload.update(
        {
            "state": to_state,
            "version": snapshot.version + 1,
            "blocked_on": None,
            "final_report": None,
            "report_truncated": False,
            "error_code": None,
            "error_message": None,
            "updated_at": now,
        }
    )
    if to_state is SubagentRunState.RUNNING:
        payload["started_at"] = now
    else:
        payload.update(
            {
                "finished_at": now,
                "final_report": final_report,
                "report_truncated": report_truncated,
                "error_code": error_code,
                "error_message": error_message,
            }
        )
        if to_state is SubagentRunState.CANCELLED:
            payload["cancel_requested_at"] = snapshot.cancel_requested_at or now
    return SubagentRunSnapshot.model_validate(payload)


def _terminal_payload_matches(
    snapshot: SubagentRunSnapshot,
    *,
    final_report: str | None,
    report_truncated: bool,
    error_code: str | None,
    error_message: str | None,
) -> bool:
    return (
        snapshot.final_report == final_report
        and snapshot.report_truncated is report_truncated
        and snapshot.error_code == error_code
        and snapshot.error_message == error_message
    )


def set_blocked_on(
    snapshot: SubagentRunSnapshot,
    blocked_on: SubagentBlockedOn | str | None,
    *,
    expected_version: int,
) -> SubagentRunSnapshot:
    if expected_version != snapshot.version:
        raise SubagentError(
            SubagentErrorCode.RUN_VERSION_CONFLICT,
            "the Run snapshot version is stale",
            details={"expected_version": expected_version, "actual_version": snapshot.version},
        )
    if snapshot.state is not SubagentRunState.RUNNING:
        raise SubagentError(
            SubagentErrorCode.RUN_TRANSITION_INVALID,
            "blocked_on can only change while a Run is running",
            details={"state": snapshot.state.value},
        )
    if blocked_on is not None:
        try:
            blocked_on = SubagentBlockedOn(blocked_on)
        except ValueError as exc:
            raise SubagentError(
                SubagentErrorCode.RUN_TRANSITION_INVALID,
                "the requested blocked_on value is unknown",
                details={"blocked_on": str(blocked_on)},
            ) from exc
    if snapshot.blocked_on is blocked_on:
        return snapshot

    payload = snapshot.model_dump()
    payload.update(blocked_on=blocked_on, version=snapshot.version + 1)
    return SubagentRunSnapshot.model_validate(payload)


def merge_versioned_snapshot(
    current: SubagentRunSnapshot | None,
    incoming: SubagentRunSnapshot,
) -> SubagentRunSnapshot:
    if current is None:
        return incoming
    if incoming.run_id != current.run_id:
        raise SubagentError(
            SubagentErrorCode.RUN_VERSION_CONFLICT,
            "cannot merge snapshots from different Runs",
            details={"current_run_id": current.run_id, "incoming_run_id": incoming.run_id},
        )
    if incoming.version < current.version:
        return current
    if incoming.version == current.version:
        if incoming == current:
            return current
        raise SubagentError(
            SubagentErrorCode.RUN_VERSION_CONFLICT,
            "conflicting Run snapshots have the same version",
            details={"run_id": current.run_id, "version": current.version},
        )
    return incoming
