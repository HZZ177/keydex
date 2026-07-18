from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from backend.app.services.archive_lifecycle_service import ArchiveLifecycleError
from backend.app.services.purge_service import PurgeDatabaseExecutor, PurgePlanner
from backend.app.storage import StorageRepositories, init_database
from backend.app.subagents.models import SubagentRunSnapshot

NOW = datetime(2026, 7, 18, 8, 0, tzinfo=UTC)


def _setup(tmp_path) -> tuple[StorageRepositories, str, str]:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    parent = repositories.sessions.create(
        session_id="parent-session",
        user_id="local-user",
        scene_id="desktop-agent",
        session_type="workspace",
    )
    child = repositories.sessions.create(
        session_id="child-session",
        user_id="local-user",
        scene_id="desktop-agent",
        session_type="workspace",
        session_tag="subagent",
        parent_session_id=parent.id,
        visibility="internal",
        agent_kind="subagent",
        subagent_id="subagent-1",
        subagent_role="worker",
    )
    repositories.subagent_runs.create(
        SubagentRunSnapshot(
            run_id="run-1",
            subagent_id="subagent-1",
            child_session_id=child.id,
            parent_session_id=parent.id,
            parent_trace_id="trace-1",
            parent_tool_call_id="tool-1",
            parent_timeline_sequence=0,
            initiated_by="main_agent",
            role="worker",
            task="bounded task",
            state="completed",
            version=2,
            final_report="done",
            created_at=NOW,
            queued_at=NOW,
            started_at=NOW,
            finished_at=NOW + timedelta(seconds=1),
            updated_at=NOW + timedelta(seconds=1),
        )
    )
    return repositories, parent.id, child.id


def test_parent_archive_and_restore_cascade_child_without_listing_it(tmp_path) -> None:
    repositories, parent_id, child_id = _setup(tmp_path)

    archived = repositories.sessions.archive_manual(
        parent_id, archived_at="2026-07-18T08:00:00Z"
    )

    assert archived.changed is True
    assert repositories.sessions.get_archived(parent_id) is not None
    child_archived = repositories.sessions.get_archived(
        child_id, include_internal=True
    )
    assert child_archived is not None
    assert child_archived.archive_origin == "manual"
    assert [item.session.id for item in repositories.sessions.list_archived().items] == [
        parent_id
    ]

    restored = repositories.sessions.restore(parent_id)

    assert restored.changed is True
    assert repositories.sessions.get(parent_id) is not None
    assert repositories.sessions.get(child_id) is None
    child_restored = repositories.sessions.get(child_id, include_internal=True)
    assert child_restored is not None
    assert child_restored.archived_at is None


def test_parent_purge_plan_and_execution_include_child_and_run(tmp_path) -> None:
    repositories, parent_id, child_id = _setup(tmp_path)
    repositories.sessions.archive_manual(parent_id, archived_at="2026-07-18T08:00:00Z")
    planner = PurgePlanner(repositories, data_dir=tmp_path)

    plan = planner.plan_session(parent_id)

    assert plan.session_ids == (parent_id, child_id)
    assert plan.database_counts["subagent_run"] == 1

    counts = PurgeDatabaseExecutor(repositories).execute(plan)

    assert counts["subagent_run"] == 1
    assert counts["sessions"] == 2
    assert repositories.sessions.get_archived(parent_id) is None
    assert repositories.sessions.get_archived(child_id, include_internal=True) is None
    assert repositories.subagent_runs.get("run-1") is None


def test_internal_child_cannot_be_archived_restored_pinned_or_purged_directly(tmp_path) -> None:
    repositories, _, child_id = _setup(tmp_path)

    assert repositories.sessions.set_pinned(child_id, True) is None
    assert repositories.sessions.archive_manual(
        child_id, archived_at="2026-07-18T08:00:00Z"
    ).changed is False
    assert repositories.sessions.restore(child_id).changed is False

    planner = PurgePlanner(repositories, data_dir=tmp_path)
    with pytest.raises(ArchiveLifecycleError) as exc_info:
        planner.plan_session(child_id)
    assert exc_info.value.code == "not_found"
