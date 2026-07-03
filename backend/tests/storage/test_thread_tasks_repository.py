from __future__ import annotations

import time

import pytest

from backend.app.storage import StorageRepositories, init_database


def _repositories(tmp_path) -> StorageRepositories:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    repositories.sessions.create(
        session_id="session-1",
        user_id="user-1",
        scene_id="scene-1",
    )
    return repositories


def test_thread_tasks_repository_create_get_list_and_open_lookup(tmp_path) -> None:
    repositories = _repositories(tmp_path)

    task = repositories.thread_tasks.create(
        task_id="task-1",
        session_id="session-1",
        type="goal",
        title="目标",
        objective="完成长程任务",
        metadata={"source": "composer_goal"},
    )

    assert task.id == "task-1"
    assert task.session_id == "session-1"
    assert task.type == "goal"
    assert task.title == "目标"
    assert task.objective == "完成长程任务"
    assert task.status == "active"
    assert task.metadata == {"source": "composer_goal"}
    assert task.is_open is True
    assert repositories.thread_tasks.get("task-1") == task
    assert repositories.thread_tasks.get_open_by_session("session-1") == task
    assert [item.id for item in repositories.thread_tasks.list_by_session("session-1")] == [
        "task-1"
    ]


def test_thread_tasks_repository_update_soft_delete_and_reopen(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    first = repositories.thread_tasks.create(
        task_id="task-1",
        session_id="session-1",
        type="goal",
        objective="完成长程任务",
    )

    updated = repositories.thread_tasks.update(
        first.id,
        title="更新目标",
        objective="完成更新后的任务",
        status="paused",
        metadata={"edited": True},
        evidence=[{"type": "manual", "title": "checked"}],
        blocked_audit={"key": "env", "count": 1},
        current_run_id="run-1",
        turn_count=2,
        elapsed_seconds=9,
        token_usage={"total_tokens": 12},
    )

    assert updated is not None
    assert updated.title == "更新目标"
    assert updated.objective == "完成更新后的任务"
    assert updated.status == "paused"
    assert updated.metadata == {"edited": True}
    assert updated.evidence == [{"type": "manual", "title": "checked"}]
    assert updated.blocked_audit == {"key": "env", "count": 1}
    assert updated.current_run_id == "run-1"
    assert updated.turn_count == 2
    assert updated.elapsed_seconds == 9
    assert updated.token_usage == {"total_tokens": 12}

    deleted = repositories.thread_tasks.soft_delete(first.id)

    assert deleted is not None
    assert deleted.deleted_at is not None
    assert repositories.thread_tasks.get(first.id) is None
    assert repositories.thread_tasks.get(first.id, include_deleted=True) == deleted
    assert repositories.thread_tasks.get_open_by_session("session-1") is None

    second = repositories.thread_tasks.create(
        task_id="task-2",
        session_id="session-1",
        type="goal",
        objective="新的长程任务",
    )

    assert repositories.thread_tasks.get_open_by_session("session-1") == second


def test_thread_tasks_repository_accepts_custom_type_and_rejects_invalid_format(tmp_path) -> None:
    repositories = _repositories(tmp_path)

    custom = repositories.thread_tasks.create(
        task_id="task-custom-type",
        session_id="session-1",
        type="research",
        objective="未来类型由服务注册表控制",
    )
    assert custom.type == "research"

    for invalid_type in ["", "Research", "bad space", "1bad", "x" * 65]:
        with pytest.raises(ValueError, match="类型"):
            repositories.thread_tasks.create(
                task_id=f"task-invalid-type-{invalid_type or 'empty'}",
                session_id="session-1",
                type=invalid_type,
                objective="非法格式",
                status="complete",
            )

    with pytest.raises(ValueError, match="状态"):
        repositories.thread_tasks.create(
            task_id="task-invalid-status",
            session_id="session-1",
            type="goal",
            objective="状态错误",
            status="waiting",
        )


def test_thread_task_runs_repository_create_attach_finish_and_list(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    task = repositories.thread_tasks.create(
        task_id="task-1",
        session_id="session-1",
        type="goal",
        objective="完成长程任务",
    )

    first = repositories.thread_task_runs.create_running(
        run_id="run-1",
        task_id=task.id,
        session_id=task.session_id,
        trace_id="trace-before",
    )
    time.sleep(0.001)
    second = repositories.thread_task_runs.create_running(
        run_id="run-2",
        task_id=task.id,
        session_id=task.session_id,
    )

    assert first.is_running is True
    assert first.trace_id == "trace-before"

    attached = repositories.thread_task_runs.attach_turn(
        first.id,
        turn_index=7,
        trace_id="trace-after",
    )
    assert attached is not None
    assert attached.turn_index == 7
    assert attached.trace_id == "trace-after"

    finished = repositories.thread_task_runs.finish(
        first.id,
        status="succeeded",
        summary={"summary": "done"},
        error={"retries": 0},
    )

    assert finished is not None
    assert finished.status == "succeeded"
    assert finished.finished_at is not None
    assert finished.summary == {"summary": "done"}
    assert finished.error == {"retries": 0}
    assert [item.id for item in repositories.thread_task_runs.list_by_task(task.id)] == [
        second.id,
        first.id,
    ]
    assert repositories.thread_task_runs.get_running_by_task(task.id) == second

    repositories.thread_task_runs.finish(second.id, status="skipped")
    assert repositories.thread_task_runs.get_running_by_task(task.id) is None


def test_thread_task_runs_repository_rejects_running_as_finish_status(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    task = repositories.thread_tasks.create(
        task_id="task-1",
        session_id="session-1",
        type="goal",
        objective="完成长程任务",
    )
    run = repositories.thread_task_runs.create_running(
        run_id="run-1",
        task_id=task.id,
        session_id=task.session_id,
    )

    with pytest.raises(ValueError, match="完成状态"):
        repositories.thread_task_runs.finish(run.id, status="running")
