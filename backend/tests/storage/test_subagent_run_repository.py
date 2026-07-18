from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from threading import Barrier

import pytest

from backend.app.storage import StorageRepositories, init_database
from backend.app.subagents.errors import SubagentError, SubagentErrorCode
from backend.app.subagents.models import SubagentRunSnapshot

NOW = datetime(2026, 7, 18, 8, 0, tzinfo=UTC)


def _repositories(tmp_path) -> StorageRepositories:
    return StorageRepositories(init_database(tmp_path / "app.db"))


def _create_parent(repositories: StorageRepositories, parent_id: str = "parent-1") -> None:
    repositories.sessions.create(
        session_id=parent_id,
        user_id="local-user",
        scene_id="desktop-agent",
        session_type="workspace",
    )


def _create_child(
    repositories: StorageRepositories,
    *,
    subagent_id: str,
    parent_id: str = "parent-1",
    role: str = "worker",
) -> str:
    child_id = f"child-{subagent_id}"
    repositories.sessions.create(
        session_id=child_id,
        user_id="local-user",
        scene_id="desktop-agent",
        session_type="workspace",
        session_tag="subagent",
        parent_session_id=parent_id,
        visibility="internal",
        agent_kind="subagent",
        subagent_id=subagent_id,
        subagent_role=role,
    )
    return child_id


def _snapshot(
    number: int,
    *,
    subagent_id: str,
    child_session_id: str,
    state: str = "queued",
    parent_id: str = "parent-1",
    role: str = "worker",
) -> SubagentRunSnapshot:
    created_at = NOW + timedelta(seconds=number)
    payload: dict[str, object] = {
        "run_id": f"run-{number}",
        "subagent_id": subagent_id,
        "child_session_id": child_session_id,
        "parent_session_id": parent_id,
        "parent_trace_id": f"trace-{number}",
        "parent_tool_call_id": f"tool-{number}",
        "parent_timeline_sequence": number,
        "initiated_by": "main_agent",
        "role": role,
        "task": f"task {number}",
        "state": state,
        "version": 1,
        "created_at": created_at,
        "queued_at": created_at,
        "updated_at": created_at,
    }
    if state != "queued":
        payload["started_at"] = created_at
    if state in {"completed", "failed", "cancelled", "interrupted"}:
        payload["finished_at"] = created_at + timedelta(seconds=1)
    if state == "completed":
        payload["final_report"] = "done"
    if state == "failed":
        payload.update(error_code="FAILED", error_message="failed")
    return SubagentRunSnapshot.model_validate(payload)


def test_db_020_create_and_get_returns_complete_record_and_snapshot(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_parent(repositories)
    child_id = _create_child(repositories, subagent_id="worker-1")
    snapshot = _snapshot(1, subagent_id="worker-1", child_session_id=child_id)

    created = repositories.subagent_runs.create(snapshot)

    assert repositories.subagent_runs.get(snapshot.run_id) == created
    assert created.to_snapshot() == snapshot
    assert created.report_truncated is False


def test_db_021_list_by_parent_returns_all_runs_in_stable_sequence(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_parent(repositories)
    child_2 = _create_child(repositories, subagent_id="worker-2")
    child_1 = _create_child(repositories, subagent_id="worker-1")
    repositories.subagent_runs.create(
        _snapshot(2, subagent_id="worker-2", child_session_id=child_2)
    )
    repositories.subagent_runs.create(
        _snapshot(1, subagent_id="worker-1", child_session_id=child_1)
    )

    runs = repositories.subagent_runs.list_by_parent("parent-1")

    assert [run.run_id for run in runs] == ["run-1", "run-2"]


def test_db_022_list_by_subagent_keeps_resume_history(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_parent(repositories)
    child_id = _create_child(repositories, subagent_id="worker-1")
    repositories.subagent_runs.create(
        _snapshot(
            1,
            subagent_id="worker-1",
            child_session_id=child_id,
            state="completed",
        )
    )
    repositories.subagent_runs.create(
        _snapshot(2, subagent_id="worker-1", child_session_id=child_id)
    )

    runs = repositories.subagent_runs.list_by_subagent(
        "worker-1", parent_session_id="parent-1"
    )

    assert [(run.run_id, run.state) for run in runs] == [
        ("run-1", "completed"),
        ("run-2", "queued"),
    ]


def test_db_023_get_active_returns_only_queued_or_running(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_parent(repositories)
    child_id = _create_child(repositories, subagent_id="worker-1")
    repositories.subagent_runs.create(
        _snapshot(
            1,
            subagent_id="worker-1",
            child_session_id=child_id,
            state="cancelled",
        )
    )
    assert repositories.subagent_runs.get_active("worker-1") is None

    active = repositories.subagent_runs.create(
        _snapshot(2, subagent_id="worker-1", child_session_id=child_id)
    )
    assert repositories.subagent_runs.get_active("worker-1") == active


def test_db_028_parent_scoped_get_does_not_leak_another_parent(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_parent(repositories, "parent-1")
    _create_parent(repositories, "parent-2")
    child_id = _create_child(repositories, subagent_id="worker-1", parent_id="parent-1")
    repositories.subagent_runs.create(
        _snapshot(1, subagent_id="worker-1", child_session_id=child_id)
    )

    assert repositories.subagent_runs.get(
        "run-1", parent_session_id="parent-2"
    ) is None
    assert repositories.subagent_runs.list_by_parent("parent-2") == []


def test_db_029_parallel_instances_keep_independent_versions_and_roles(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_parent(repositories)
    explorer_child = _create_child(
        repositories, subagent_id="explorer-1", role="explorer"
    )
    worker_child = _create_child(repositories, subagent_id="worker-1", role="worker")
    explorer = repositories.subagent_runs.create(
        _snapshot(
            1,
            subagent_id="explorer-1",
            child_session_id=explorer_child,
            role="explorer",
        )
    )
    worker = repositories.subagent_runs.create(
        _snapshot(2, subagent_id="worker-1", child_session_id=worker_child)
    )

    assert explorer.version == worker.version == 1
    assert explorer.role == "explorer"
    assert worker.role == "worker"


def test_db_030_reconciliation_query_returns_only_active_runs(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_parent(repositories)
    active_child = _create_child(repositories, subagent_id="worker-active")
    terminal_child = _create_child(repositories, subagent_id="worker-terminal")
    repositories.subagent_runs.create(
        _snapshot(1, subagent_id="worker-active", child_session_id=active_child)
    )
    repositories.subagent_runs.create(
        _snapshot(
            2,
            subagent_id="worker-terminal",
            child_session_id=terminal_child,
            state="interrupted",
        )
    )

    candidates = repositories.subagent_runs.list_reconciliation_candidates()

    assert [record.run_id for record in candidates] == ["run-1"]


def test_db_031_resume_history_and_next_sequence_are_stable(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_parent(repositories)
    child_id = _create_child(repositories, subagent_id="worker-1")
    repositories.subagent_runs.create(
        _snapshot(
            1,
            subagent_id="worker-1",
            child_session_id=child_id,
            state="completed",
        )
    )

    with repositories.db.transaction(immediate=True) as conn:
        next_sequence = repositories.subagent_runs.next_parent_sequence(
            "parent-1", connection=conn
        )
        resumed = _snapshot(2, subagent_id="worker-1", child_session_id=child_id)
        assert resumed.parent_timeline_sequence == next_sequence
        repositories.subagent_runs.create(resumed, connection=conn)

    assert [
        record.run_id for record in repositories.subagent_runs.list_by_subagent("worker-1")
    ] == ["run-1", "run-2"]


def _create_queued_run(repositories: StorageRepositories) -> None:
    _create_parent(repositories)
    child_id = _create_child(repositories, subagent_id="worker-1")
    repositories.subagent_runs.create(
        _snapshot(1, subagent_id="worker-1", child_session_id=child_id)
    )


def test_db_024_expected_version_transition_is_atomic(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_queued_run(repositories)

    running = repositories.subagent_runs.transition(
        "run-1", "running", expected_version=1, now=NOW + timedelta(seconds=2)
    )

    assert running.state == "running"
    assert running.version == 2
    assert running.started_at is not None
    with pytest.raises(SubagentError) as exc_info:
        repositories.subagent_runs.transition(
            "run-1", "cancelled", expected_version=1, now=NOW + timedelta(seconds=3)
        )
    assert exc_info.value.code is SubagentErrorCode.RUN_VERSION_CONFLICT


def test_db_025_blocked_on_updates_only_running_and_increments_version(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_queued_run(repositories)
    with pytest.raises(SubagentError):
        repositories.subagent_runs.update_blocked_on(
            "run-1", "approval", expected_version=1, now=NOW
        )

    running = repositories.subagent_runs.transition(
        "run-1", "running", expected_version=1, now=NOW + timedelta(seconds=2)
    )
    blocked = repositories.subagent_runs.update_blocked_on(
        "run-1", "approval", expected_version=running.version, now=NOW + timedelta(seconds=3)
    )

    assert blocked.state == "running"
    assert blocked.blocked_on == "approval"
    assert blocked.version == 3


def test_db_026_completed_transition_persists_report_and_clears_block(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_queued_run(repositories)
    running = repositories.subagent_runs.transition(
        "run-1", "running", expected_version=1, now=NOW + timedelta(seconds=2)
    )
    blocked = repositories.subagent_runs.update_blocked_on(
        "run-1", "external_tool", expected_version=running.version, now=NOW
    )
    completed = repositories.subagent_runs.transition(
        "run-1",
        "completed",
        expected_version=blocked.version,
        now=NOW + timedelta(seconds=4),
        final_report="final report",
    )

    assert completed.state == "completed"
    assert completed.blocked_on is None
    assert completed.final_report == "final report"
    assert completed.finished_at is not None

    replay = repositories.subagent_runs.transition(
        "run-1",
        "completed",
        expected_version=blocked.version,
        now=NOW + timedelta(hours=1),
        final_report="final report",
    )
    assert replay == completed


def test_db_027_failed_transition_persists_error_without_success_report(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_queued_run(repositories)
    failed = repositories.subagent_runs.transition(
        "run-1",
        "failed",
        expected_version=1,
        now=NOW + timedelta(seconds=1),
        error_code="SUBAGENT_START_FAILED",
        error_message="start failed",
    )

    assert failed.state == "failed"
    assert failed.error_code == "SUBAGENT_START_FAILED"
    assert failed.error_message == "start failed"
    assert failed.final_report is None


def test_race_010_only_one_competing_terminal_cas_wins(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_queued_run(repositories)
    running = repositories.subagent_runs.transition(
        "run-1", "running", expected_version=1, now=NOW + timedelta(seconds=1)
    )
    barrier = Barrier(2)

    def finish(state: str) -> str:
        barrier.wait()
        try:
            kwargs = {"final_report": "done"} if state == "completed" else {}
            result = repositories.subagent_runs.transition(
                "run-1",
                state,
                expected_version=running.version,
                now=NOW + timedelta(seconds=2),
                **kwargs,
            )
            return result.state
        except SubagentError as exc:
            return exc.code.value

    with ThreadPoolExecutor(max_workers=2) as executor:
        outcomes = set(executor.map(finish, ["completed", "cancelled"]))

    assert len(outcomes & {"completed", "cancelled"}) == 1
    assert SubagentErrorCode.RUN_VERSION_CONFLICT.value in outcomes
    assert repositories.subagent_runs.get("run-1").state in {"completed", "cancelled"}


def test_race_011_failed_and_interrupted_cannot_overwrite_each_other(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_queued_run(repositories)
    barrier = Barrier(2)

    def finish(state: str) -> str:
        barrier.wait()
        try:
            kwargs = (
                {"error_code": "CHILD_FAILED", "error_message": "child failed"}
                if state == "failed"
                else {}
            )
            result = repositories.subagent_runs.transition(
                "run-1",
                state,
                expected_version=1,
                now=NOW + timedelta(seconds=1),
                **kwargs,
            )
            return result.state
        except SubagentError as exc:
            return exc.code.value

    with ThreadPoolExecutor(max_workers=2) as executor:
        outcomes = set(executor.map(finish, ["failed", "interrupted"]))

    assert len(outcomes & {"failed", "interrupted"}) == 1
    assert SubagentErrorCode.RUN_VERSION_CONFLICT.value in outcomes
    assert repositories.subagent_runs.get("run-1").state in {"failed", "interrupted"}


def test_parent_run_relationship_controls_internal_child_lookup(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_parent(repositories, "parent-1")
    _create_parent(repositories, "parent-2")
    child_id = _create_child(repositories, subagent_id="worker-1", parent_id="parent-1")
    repositories.subagent_runs.create(
        _snapshot(1, subagent_id="worker-1", child_session_id=child_id)
    )

    allowed = repositories.sessions.get_internal_for_parent(
        child_session_id=child_id,
        parent_session_id="parent-1",
        run_id="run-1",
    )
    wrong_parent = repositories.sessions.get_internal_for_parent(
        child_session_id=child_id,
        parent_session_id="parent-2",
        run_id="run-1",
    )
    wrong_run = repositories.sessions.get_internal_for_parent(
        child_session_id=child_id,
        parent_session_id="parent-1",
        run_id="missing-run",
    )

    assert allowed is not None
    assert allowed.id == child_id
    assert wrong_parent is None
    assert wrong_run is None


def test_subagent_lookup_is_parent_scoped_and_does_not_use_parent_child_field(
    tmp_path,
) -> None:
    repositories = _repositories(tmp_path)
    _create_parent(repositories, "parent-1")
    _create_parent(repositories, "parent-2")
    child_id = _create_child(repositories, subagent_id="worker-1", parent_id="parent-1")

    with repositories.db.transaction() as conn:
        conn.execute(
            "update sessions set child_session_id = 'incorrect-single-child' "
            "where id = 'parent-1'"
        )

    child = repositories.sessions.get_subagent_for_parent(
        subagent_id="worker-1", parent_session_id="parent-1"
    )

    assert child is not None
    assert child.id == child_id
    assert repositories.sessions.get_subagent_for_parent(
        subagent_id="worker-1", parent_session_id="parent-2"
    ) is None
