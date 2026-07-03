from __future__ import annotations

import pytest

from backend.app.events import DomainEvent, DomainEventType, EventDispatcher
from backend.app.storage import StorageRepositories, init_database
from backend.app.services import ThreadTaskService
from backend.app.tools import ToolExecutionContext
from backend.app.tools.thread_task import create_thread_task_tools


def _repositories(tmp_path) -> StorageRepositories:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    repositories.sessions.create(
        session_id="session-1",
        user_id="user-1",
        scene_id="scene-1",
    )
    repositories.sessions.create(
        session_id="session-2",
        user_id="user-1",
        scene_id="scene-1",
    )
    return repositories


def _context(
    tmp_path,
    repositories: StorageRepositories,
    session_id: str = "session-1",
    service: ThreadTaskService | None = None,
    dispatcher: EventDispatcher | None = None,
    trace_id: str | None = None,
):
    metadata = {"repositories": repositories}
    if service is not None:
        metadata["thread_task_service"] = service
    if dispatcher is not None:
        metadata["dispatcher"] = dispatcher
    return ToolExecutionContext(
        session_id=session_id,
        user_id="user-1",
        workspace_root=tmp_path,
        turn_index=3,
        trace_id=trace_id,
        metadata=metadata,
    )


async def _run_get_thread_task(tmp_path, repositories: StorageRepositories, session_id="session-1"):
    tool = create_thread_task_tools()[0]
    return await tool.run({}, _context(tmp_path, repositories, session_id))


async def _run_update_thread_task(
    tmp_path,
    repositories: StorageRepositories,
    args,
    *,
    service: ThreadTaskService | None = None,
):
    tool = {tool.name: tool for tool in create_thread_task_tools()}["update_thread_task"]
    return await tool.run(args, _context(tmp_path, repositories, service=service))


@pytest.mark.asyncio
async def test_get_thread_task_returns_no_active_task(tmp_path) -> None:
    repositories = _repositories(tmp_path)

    result = await _run_get_thread_task(tmp_path, repositories)

    assert result.ok is True
    assert result.result["has_task"] is False
    assert result.result["status"] == "no_active_task"


@pytest.mark.asyncio
async def test_get_thread_task_returns_active_goal_objective(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    task = repositories.thread_tasks.create(
        task_id="task-1",
        session_id="session-1",
        type="goal",
        objective="完成目标",
    )
    run = repositories.thread_task_runs.create_running(
        run_id="run-1",
        task_id=task.id,
        session_id="session-1",
        summary={"turn_status": "running"},
    )

    result = await _run_get_thread_task(tmp_path, repositories)

    assert result.ok is True
    assert result.result["has_task"] is True
    assert result.result["task_id"] == task.id
    assert result.result["type"] == "goal"
    assert result.result["objective"] == "完成目标"
    assert result.result["status"] == "active"
    assert result.result["recent_result"]["run_id"] == run.id


@pytest.mark.asyncio
async def test_get_thread_task_does_not_return_deleted_task(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    task = repositories.thread_tasks.create(
        task_id="task-1",
        session_id="session-1",
        type="goal",
        objective="完成目标",
    )
    repositories.thread_tasks.soft_delete(task.id)

    result = await _run_get_thread_task(tmp_path, repositories)

    assert result.ok is True
    assert result.result["status"] == "no_active_task"


@pytest.mark.asyncio
async def test_get_thread_task_is_scoped_to_current_session(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    repositories.thread_tasks.create(
        task_id="task-other",
        session_id="session-2",
        type="goal",
        objective="另一个会话的目标",
    )

    result = await _run_get_thread_task(tmp_path, repositories, session_id="session-1")

    assert result.ok is True
    assert result.result["status"] == "no_active_task"


@pytest.mark.asyncio
async def test_thread_task_tools_require_session_context(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    tool = {tool.name: tool for tool in create_thread_task_tools()}["get_thread_task"]

    result = await tool.run({}, _context(tmp_path, repositories, session_id=""))

    assert result.ok is False
    assert result.error["code"] == "thread_task_session_missing"


@pytest.mark.asyncio
async def test_update_thread_task_rejects_unsupported_status(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    repositories.thread_tasks.create(
        task_id="task-1",
        session_id="session-1",
        type="goal",
        objective="完成目标",
    )

    result = await _run_update_thread_task(
        tmp_path,
        repositories,
        {"status": "paused", "summary": "暂停"},
    )

    assert result.ok is False
    assert result.error["code"] == "invalid_task_status"
    assert repositories.thread_tasks.get("task-1").status == "active"


@pytest.mark.asyncio
async def test_update_thread_task_complete_requires_evidence(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    repositories.thread_tasks.create(
        task_id="task-1",
        session_id="session-1",
        type="goal",
        objective="完成目标",
    )

    result = await _run_update_thread_task(
        tmp_path,
        repositories,
        {
            "status": "complete",
            "summary": "完成",
            "checklist": [{"item": "目标", "status": "passed", "evidence": "done"}],
        },
    )

    assert result.ok is False
    assert result.error["code"] == "invalid_tool_args"
    assert repositories.thread_tasks.get("task-1").status == "active"


@pytest.mark.asyncio
async def test_update_thread_task_complete_success_returns_ui_payload(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    service = ThreadTaskService(repositories)
    task = service.create_task(session_id="session-1", type="goal", objective="完成目标")

    result = await _run_update_thread_task(
        tmp_path,
        repositories,
        {
            "status": "complete",
            "summary": "目标已完成",
            "checklist": [{"item": "目标", "status": "passed", "evidence": "pytest"}],
            "evidence": [{"type": "test", "summary": "pytest passed"}],
        },
        service=service,
    )

    assert result.ok is True
    assert result.result["task_id"] == task["id"]
    assert result.result["status"] == "complete"
    assert result.result["ui_payload"]["task"]["status"] == "complete"
    assert repositories.thread_tasks.get(task["id"]).status == "complete"


@pytest.mark.asyncio
async def test_update_thread_task_complete_emits_semantic_status_event(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    service = ThreadTaskService(repositories)
    task = service.create_task(session_id="session-1", type="goal", objective="完成目标")
    run = repositories.thread_task_runs.create_running(
        run_id="run-1",
        task_id=task["id"],
        session_id="session-1",
        turn_index=3,
        trace_id="trace-goal",
    )
    repositories.thread_tasks.update(task["id"], current_run_id=run.id)
    events: list[DomainEvent] = []

    async def record_event(event: DomainEvent) -> None:
        events.append(event)

    dispatcher = EventDispatcher([record_event])
    tool = {tool.name: tool for tool in create_thread_task_tools()}["update_thread_task"]

    result = await tool.run(
        {
            "status": "complete",
            "summary": "目标已完成",
            "checklist": [{"item": "目标", "status": "passed", "evidence": "pytest"}],
            "evidence": [{"type": "test", "summary": "pytest passed"}],
        },
        _context(
            tmp_path,
            repositories,
            service=service,
            dispatcher=dispatcher,
            trace_id="trace-goal",
        ),
    )

    assert result.ok is True
    assert len(events) == 1
    assert events[0].event_type == DomainEventType.THREAD_TASK_STATUS_UPDATED.value
    assert events[0].trace_id == "trace-goal"
    assert events[0].turn_index == 3
    assert events[0].run_id == run.id
    assert events[0].payload["task_id"] == task["id"]
    assert events[0].payload["run_id"] == run.id
    assert events[0].payload["status"] == "complete"
    assert events[0].payload["summary"] == "目标已完成"


@pytest.mark.asyncio
async def test_update_thread_task_complete_accepts_string_evidence(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    service = ThreadTaskService(repositories)
    task = service.create_task(session_id="session-1", type="goal", objective="完成目标")

    result = await _run_update_thread_task(
        tmp_path,
        repositories,
        {
            "status": "complete",
            "summary": "目标已完成",
            "checklist": [{"item": "目标", "status": "passed", "evidence": "pytest"}],
            "evidence": ["pytest passed", {"type": "note", "summary": "页面验证通过"}],
        },
        service=service,
    )

    assert result.ok is True
    stored = repositories.thread_tasks.get(task["id"])
    assert stored.evidence[1] == {"type": "note", "detail": "pytest passed"}
    assert stored.evidence[2]["summary"] == "页面验证通过"


@pytest.mark.asyncio
async def test_update_thread_task_blocked_requires_three_repeated_audits(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    service = ThreadTaskService(repositories)
    service.create_task(session_id="session-1", type="goal", objective="完成目标")
    payload = {
        "status": "blocked",
        "summary": "等待外部凭据",
        "reason": "等待外部凭据",
        "attempts": ["检查环境"],
        "blocked_audit_key": "missing-credential",
    }

    first = await _run_update_thread_task(tmp_path, repositories, payload, service=service)
    second = await _run_update_thread_task(tmp_path, repositories, payload, service=service)
    third = await _run_update_thread_task(tmp_path, repositories, payload, service=service)

    assert first.ok is False
    assert first.error["code"] == "status_transition_not_allowed"
    assert second.ok is False
    assert second.error["code"] == "status_transition_not_allowed"
    assert third.ok is True
    assert third.result["status"] == "blocked"
    assert third.result["ui_payload"]["task"]["blocked_audit"]["count"] == 3
