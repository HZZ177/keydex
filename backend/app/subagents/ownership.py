from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable

from backend.app.subagents.errors import SubagentError, SubagentErrorCode
from backend.app.subagents.models import ACTIVE_RUN_STATES, SubagentRunSnapshot


def run_ownership_key(run: SubagentRunSnapshot) -> tuple[str, str]:
    """Return the parent-scoped instance key used by locks and authorization."""

    return run.parent_session_id, run.subagent_id


def assert_run_collection_isolated(runs: Iterable[SubagentRunSnapshot]) -> None:
    materialized = list(runs)
    _assert_unique_run_and_timeline_keys(materialized)

    by_subagent: dict[str, list[SubagentRunSnapshot]] = defaultdict(list)
    child_owners: dict[str, tuple[str, str]] = {}
    for run in materialized:
        by_subagent[run.subagent_id].append(run)
        child_owner = (run.parent_session_id, run.subagent_id)
        previous_owner = child_owners.setdefault(run.child_session_id, child_owner)
        if previous_owner != child_owner:
            raise SubagentError(
                SubagentErrorCode.SUBAGENT_PARENT_INVALID,
                "a child Session cannot belong to multiple Sub-Agent instances",
                details={"child_session_id": run.child_session_id},
            )

    for subagent_id, instance_runs in by_subagent.items():
        identities = {
            (run.parent_session_id, run.child_session_id, run.role) for run in instance_runs
        }
        if len(identities) != 1:
            raise SubagentError(
                SubagentErrorCode.SUBAGENT_PARENT_INVALID,
                "a Sub-Agent instance cannot change parent, child Session, or role",
                details={"subagent_id": subagent_id},
            )
        active_run_ids = [
            run.run_id for run in instance_runs if run.state in ACTIVE_RUN_STATES
        ]
        if len(active_run_ids) > 1:
            raise SubagentError(
                SubagentErrorCode.RUN_ALREADY_ACTIVE,
                "a Sub-Agent instance cannot have multiple active Runs",
                details={"subagent_id": subagent_id, "run_ids": active_run_ids},
            )


def _assert_unique_run_and_timeline_keys(runs: list[SubagentRunSnapshot]) -> None:
    run_ids: set[str] = set()
    timeline_keys: set[tuple[str, int]] = set()
    for run in runs:
        if run.run_id in run_ids:
            raise SubagentError(
                SubagentErrorCode.RUN_VERSION_CONFLICT,
                "run_id must be unique",
                details={"run_id": run.run_id},
            )
        run_ids.add(run.run_id)

        timeline_key = (run.parent_session_id, run.parent_timeline_sequence)
        if timeline_key in timeline_keys:
            raise SubagentError(
                SubagentErrorCode.RUN_VERSION_CONFLICT,
                "parent timeline sequence must be unique within a parent Session",
                details={
                    "parent_session_id": run.parent_session_id,
                    "parent_timeline_sequence": run.parent_timeline_sequence,
                },
            )
        timeline_keys.add(timeline_key)
