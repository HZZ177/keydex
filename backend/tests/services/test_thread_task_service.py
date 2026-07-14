from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta

import pytest

from backend.app.core.logger import logger
from backend.app.events import DomainEventType
from backend.app.services import (
    ChatRequest,
    ChatStreamAlreadyRunningError,
    ChatTurnResult,
    ThreadTaskConflictError,
    ThreadTaskElapsedTicker,
    ThreadTaskNotFoundError,
    ThreadTaskRuntime,
    ThreadTaskService,
    ThreadTaskStateLocks,
    ThreadTaskTransitionError,
    ThreadTaskValidationError,
)
from backend.app.services.thread_task_service import ThreadTaskSessionArchivedError
from backend.app.storage import StorageRepositories, init_database


class RecordingChatStreamManager:
    def __init__(
        self,
        *,
        status: str = "idle",
        start_error: Exception | None = None,
    ) -> None:
        self.status_value = status
        self.start_error = start_error
        self.requests = []

    async def status(self, session_id: str | None = None):
        cleaned = (session_id or "").strip()
        return {
            "session_id": cleaned or None,
            "status": self.status_value,
            "running_sessions": (
                [{"session_id": cleaned, "started_at_ms": 1}]
                if self.status_value == "running" and cleaned
                else []
            ),
            "waiting_approval_sessions": (
                [{"session_id": cleaned}]
                if self.status_value == "waiting_approval" and cleaned
                else []
            ),
            "pending_approvals": [],
        }

    async def start_chat(self, request):
        if self.start_error is not None:
            raise self.start_error
        self.requests.append(request)
        return request.session_id or ""


class RecordingThreadTaskEventPublisher:
    def __init__(self) -> None:
        self.events: list[dict] = []

    def publish(self, **kwargs) -> None:
        self.events.append(kwargs)

    async def publish_async(self, **kwargs) -> None:
        self.events.append(kwargs)


class RecordingBroadcastManager:
    def __init__(self) -> None:
        self.events: list[dict] = []

    async def broadcast(self, *, session_id: str, action: str, data: dict) -> bool:
        self.events.append({"session_id": session_id, "action": action, "data": data})
        return True


class MutableClock:
    def __init__(self, value: datetime) -> None:
        self.value = value

    def __call__(self) -> datetime:
        return self.value

    def advance(self, seconds: int) -> None:
        self.value += timedelta(seconds=seconds)


def _repositories(tmp_path) -> StorageRepositories:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    repositories.sessions.create(
        session_id="session-1",
        user_id="user-1",
        scene_id="scene-1",
    )
    return repositories


def _service(
    repositories: StorageRepositories,
    *,
    state_locks: ThreadTaskStateLocks | None = None,
    event_publisher: RecordingThreadTaskEventPublisher | None = None,
    task_type_labels: dict[str, str] | None = None,
    now_provider=None,
) -> ThreadTaskService:
    return ThreadTaskService(
        repositories,
        state_locks=state_locks,
        event_publisher=event_publisher,
        task_type_labels=task_type_labels,
        now_provider=now_provider,
    )


def _capture_loguru_messages() -> tuple[list[str], int]:
    messages: list[str] = []
    sink_id = logger.add(
        lambda message: messages.append(str(message.record["message"])),
        level="INFO",
        format="{message}",
    )
    return messages, sink_id


def _finish_trace(
    repositories: StorageRepositories,
    *,
    trace_id: str,
    status: str = "completed",
    duration_ms: int = 2000,
    total_input_tokens: int = 3,
    total_output_tokens: int = 5,
) -> None:
    repositories.trace_records.create(
        trace_id=trace_id,
        session_id="session-1",
        scene_id="scene-1",
        user_id="user-1",
        turn_index=1,
        root_node_id=f"{trace_id}-root",
    )
    repositories.trace_records.finish(
        trace_id,
        status=status,
        duration_ms=duration_ms,
        total_input_tokens=total_input_tokens,
        total_output_tokens=total_output_tokens,
    )


def _task_request(task_id: str, run_id: str) -> ChatRequest:
    return ChatRequest(
        session_id="session-1",
        message="",
        runtime_params={
            "thread_task": {
                "task_id": task_id,
                "run_id": run_id,
                "trigger": "task_continue",
                "type": "goal",
            }
        },
    )


def test_thread_task_mutations_reject_archived_session(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    repositories.sessions.archive_manual(
        "session-1",
        archived_at="2026-07-14T00:00:00Z",
    )
    service = _service(repositories)

    with pytest.raises(ThreadTaskSessionArchivedError):
        service.create_task(
            session_id="session-1",
            type="goal",
            title="Archived",
            objective="must not be created",
        )

    assert repositories.thread_tasks.get_open_by_session("session-1") is None


def test_thread_task_service_creates_goal_and_lists_open_task(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    service = _service(repositories)

    task = service.create_task(
        session_id="session-1",
        type="goal",
        title="目标",
        objective=" 完成长程任务 ",
        metadata={"source": "composer_goal"},
    )

    assert task["type"] == "goal"
    assert task["type_label"] == "目标"
    assert task["title"] == "目标"
    assert task["objective"] == "完成长程任务"
    assert task["status"] == "active"
    assert task["metadata"] == {"source": "composer_goal"}
    assert task["is_open"] is True
    assert service.get_open_task("session-1")["id"] == task["id"]
    assert [item["id"] for item in service.list_tasks("session-1")] == [task["id"]]


def test_thread_task_service_stamps_seed_context_compression_epoch(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    repositories.sessions.increment_context_compression_epoch("session-1")
    service = _service(repositories)

    task = service.create_task(
        session_id="session-1",
        type="goal",
        objective="目标",
        metadata={
            "seed_turn_context": {
                "message": "目标",
                "runtime_params": {"message_injection": []},
                "last_replayed_compression_epoch": 0,
            }
        },
    )

    seed = task["metadata"]["seed_turn_context"]
    assert seed["created_compression_epoch"] == 1
    assert seed["last_replayed_compression_epoch"] == 1


def test_thread_task_service_create_emits_task_updated_event(tmp_path) -> None:
    publisher = RecordingThreadTaskEventPublisher()
    service = _service(_repositories(tmp_path), event_publisher=publisher)

    task = service.create_task(session_id="session-1", type="goal", objective="目标")

    assert len(publisher.events) == 1
    event = publisher.events[0]
    assert event["event_type"] == DomainEventType.THREAD_TASK_UPDATED
    assert event["session_id"] == "session-1"
    assert event["payload"]["task_id"] == task["id"]
    assert event["payload"]["task"]["status"] == "active"


def test_thread_task_service_logs_lifecycle_fields_without_full_objective(tmp_path) -> None:
    service = _service(_repositories(tmp_path))
    long_objective = "目标-" + ("很长" * 120)
    messages, sink_id = _capture_loguru_messages()
    try:
        task = service.create_task(session_id="session-1", type="goal", objective=long_objective)
        service.mark_system_stopped(
            session_id="session-1",
            task_id=task["id"],
            reason="连续系统失败",
            run_id="run-log",
            trace_id="trace-log",
            failure_count=3,
        )
    finally:
        logger.remove(sink_id)

    joined = "\n".join(messages)
    assert "[ThreadTask] created" in joined
    assert "[ThreadTask] system_stopped" in joined
    assert "session_id=session-1" in joined
    assert f"task_id={task['id']}" in joined
    assert "type=goal" in joined
    assert "status=system_stopped" in joined
    assert "run_id=run-log" in joined
    assert "trace_id=trace-log" in joined
    assert "failure_count=3" in joined
    assert f"objective_len={len(long_objective)}" in joined
    assert long_objective not in joined


def test_thread_task_service_allows_registered_internal_task_types(tmp_path) -> None:
    service = _service(
        _repositories(tmp_path),
        task_type_labels={"research": "调研"},
    )

    task = service.create_task(
        session_id="session-1",
        type="research",
        objective="调研扩展边界",
        metadata={"consumer": "internal"},
    )

    assert task["type"] == "research"
    assert task["type_label"] == "调研"
    assert task["metadata"] == {"consumer": "internal"}


def test_thread_task_service_rejects_invalid_create_payload(tmp_path) -> None:
    service = _service(_repositories(tmp_path))

    with pytest.raises(ThreadTaskValidationError) as empty_error:
        service.create_task(session_id="session-1", type="goal", objective=" ")
    assert empty_error.value.code == "invalid_task_objective"

    with pytest.raises(ThreadTaskValidationError) as type_error:
        service.create_task(session_id="session-1", type="research", objective="调研")
    assert type_error.value.code == "unsupported_task_type"


def test_thread_task_service_rejects_second_open_task(tmp_path) -> None:
    service = _service(_repositories(tmp_path))

    service.create_task(session_id="session-1", type="goal", objective="第一个目标")

    with pytest.raises(ThreadTaskConflictError):
        service.create_task(session_id="session-1", type="goal", objective="第二个目标")


def test_thread_task_service_edits_active_task_without_resetting_accounting(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    service = _service(repositories)
    task = service.create_task(session_id="session-1", type="goal", objective="旧目标")
    repositories.thread_tasks.update(task["id"], turn_count=2, elapsed_seconds=15)

    edited = service.edit_task(
        session_id="session-1",
        task_id=task["id"],
        objective="新目标",
        metadata={"edited": True},
    )

    assert edited["objective"] == "新目标"
    assert edited["metadata"] == {"edited": True}
    assert edited["status"] == "active"
    assert edited["turn_count"] == 2
    assert edited["elapsed_seconds"] == 15


def test_thread_task_service_pause_resume_cancel_and_delete(tmp_path) -> None:
    service = _service(_repositories(tmp_path))
    task = service.create_task(session_id="session-1", type="goal", objective="目标")

    paused = service.pause_task(session_id="session-1", task_id=task["id"])
    resumed = service.resume_task(session_id="session-1", task_id=task["id"])
    cancelled = service.cancel_task(session_id="session-1", task_id=task["id"])

    assert paused["status"] == "paused"
    assert resumed["status"] == "active"
    assert cancelled["status"] == "cancelled"
    assert cancelled["is_terminal"] is True

    with pytest.raises(ThreadTaskTransitionError):
        service.resume_task(session_id="session-1", task_id=task["id"])

    deleted = service.delete_task(session_id="session-1", task_id=task["id"])
    assert deleted["deleted_at"] is not None

    with pytest.raises(ThreadTaskNotFoundError):
        service.list_runs(session_id="session-1", task_id=task["id"])


def test_thread_task_service_elapsed_uses_active_lifecycle_and_excludes_paused_time(tmp_path) -> None:
    clock = MutableClock(datetime(2026, 7, 3, 0, 0, 0, tzinfo=UTC))
    service = _service(_repositories(tmp_path), now_provider=clock)
    task = service.create_task(session_id="session-1", type="goal", objective="目标")

    clock.advance(5)
    active = service.get_open_task("session-1")
    assert active is not None
    assert active["elapsed_seconds"] == 5
    assert active["metadata"] == {}

    paused = service.pause_task(session_id="session-1", task_id=task["id"])
    assert paused["elapsed_seconds"] == 5

    clock.advance(10)
    paused_from_list = service.list_tasks("session-1")[0]
    assert paused_from_list["elapsed_seconds"] == 5

    resumed = service.resume_task(session_id="session-1", task_id=task["id"])
    assert resumed["elapsed_seconds"] == 5

    clock.advance(4)
    running_again = service.get_open_task("session-1")
    assert running_again is not None
    assert running_again["elapsed_seconds"] == 9

    completed = service.update_task_from_agent(
        session_id="session-1",
        task_id=task["id"],
        status="complete",
        payload={
            "summary": "完成",
            "checklist": ["已验证"],
            "evidence": [{"summary": "通过"}],
        },
    )
    assert completed["elapsed_seconds"] == 9

    clock.advance(8)
    completed_from_list = service.list_tasks("session-1")[0]
    assert completed_from_list["elapsed_seconds"] == 9


@pytest.mark.asyncio
async def test_thread_task_elapsed_ticker_broadcasts_backend_elapsed_seconds(tmp_path) -> None:
    clock = MutableClock(datetime(2026, 7, 3, 0, 0, 0, tzinfo=UTC))
    service = _service(_repositories(tmp_path), now_provider=clock)
    task = service.create_task(session_id="session-1", type="goal", objective="目标")
    manager = RecordingBroadcastManager()
    ticker = ThreadTaskElapsedTicker(
        thread_task_service=service,
        chat_stream_manager=manager,
        interval_seconds=1,
    )

    clock.advance(3)
    sent_count = await ticker.publish_once()

    assert sent_count == 1
    assert manager.events[0]["action"] == "task_updated"
    assert manager.events[0]["data"]["timer_tick"] is True
    assert manager.events[0]["data"]["task_id"] == task["id"]
    assert manager.events[0]["data"]["task"]["elapsed_seconds"] == 3

    service.pause_task(session_id="session-1", task_id=task["id"])
    clock.advance(5)

    assert await ticker.publish_once() == 0
    assert len(manager.events) == 1


def test_thread_task_service_stops_elapsed_timer_when_blocked(tmp_path) -> None:
    clock = MutableClock(datetime(2026, 7, 3, 0, 0, 0, tzinfo=UTC))
    service = _service(_repositories(tmp_path), now_provider=clock)
    task = service.create_task(session_id="session-1", type="goal", objective="目标")
    blocked_payload = {
        "reason": "等待账号",
        "blocked_audit_key": "missing-account",
        "attempts": ["检查本地配置"],
    }

    clock.advance(2)
    for _ in range(2):
        with pytest.raises(ThreadTaskTransitionError):
            service.update_task_from_agent(
                session_id="session-1",
                task_id=task["id"],
                status="blocked",
                payload=blocked_payload,
            )
    clock.advance(3)

    blocked = service.update_task_from_agent(
        session_id="session-1",
        task_id=task["id"],
        status="blocked",
        payload=blocked_payload,
    )

    assert blocked["status"] == "blocked"
    assert blocked["elapsed_seconds"] == 5

    clock.advance(10)
    blocked_from_list = service.list_tasks("session-1")[0]
    assert blocked_from_list["elapsed_seconds"] == 5


def test_thread_task_service_rejects_editing_terminal_task(tmp_path) -> None:
    service = _service(_repositories(tmp_path))
    task = service.create_task(session_id="session-1", type="goal", objective="目标")
    service.cancel_task(session_id="session-1", task_id=task["id"])

    with pytest.raises(ThreadTaskTransitionError):
        service.edit_task(session_id="session-1", task_id=task["id"], objective="新目标")


def test_thread_task_service_enforces_actor_status_boundaries(tmp_path) -> None:
    service = _service(_repositories(tmp_path))
    task = service.create_task(session_id="session-1", type="goal", objective="目标")

    with pytest.raises(ThreadTaskTransitionError, match="用户只能"):
        service.update_task_from_user(
            session_id="session-1",
            task_id=task["id"],
            status="complete",
        )
    with pytest.raises(ThreadTaskTransitionError, match="用户只能"):
        service.update_task_from_user(
            session_id="session-1",
            task_id=task["id"],
            status="system_stopped",
        )
    with pytest.raises(ThreadTaskTransitionError, match="agent 只能"):
        service.update_task_from_agent(
            session_id="session-1",
            task_id=task["id"],
            status="paused",
            payload={},
        )

    paused = service.update_task_from_user(
        session_id="session-1",
        task_id=task["id"],
        status="paused",
    )
    resumed = service.update_task_from_user(
        session_id="session-1",
        task_id=task["id"],
        status="active",
    )

    assert paused["status"] == "paused"
    assert resumed["status"] == "active"


def test_thread_task_service_requires_complete_evidence(tmp_path) -> None:
    service = _service(_repositories(tmp_path))
    task = service.create_task(session_id="session-1", type="goal", objective="目标")

    with pytest.raises(ThreadTaskValidationError, match="evidence"):
        service.update_task_from_agent(
            session_id="session-1",
            task_id=task["id"],
            status="complete",
            payload={
                "summary": "已完成",
                "checklist": [{"item": "测试", "status": "passed"}],
                "evidence": [],
            },
        )

    current = service.get_open_task("session-1")
    assert current is not None
    assert current["status"] == "active"


def test_thread_task_service_marks_complete_with_evidence(tmp_path) -> None:
    service = _service(_repositories(tmp_path))
    task = service.create_task(session_id="session-1", type="goal", objective="目标")

    completed = service.update_task_from_agent(
        session_id="session-1",
        task_id=task["id"],
        status="complete",
        payload={
            "summary": "已完成",
            "checklist": [{"item": "测试", "status": "passed"}],
            "evidence": [{"type": "test", "title": "pytest passed"}],
        },
    )

    assert completed["status"] == "complete"
    assert completed["is_terminal"] is True
    assert service.get_open_task("session-1") is None
    assert completed["evidence"][0]["type"] == "completion_summary"
    assert completed["evidence"][1] == {"type": "test", "title": "pytest passed"}


def test_thread_task_service_complete_emits_task_updated_event(tmp_path) -> None:
    publisher = RecordingThreadTaskEventPublisher()
    service = _service(_repositories(tmp_path), event_publisher=publisher)
    task = service.create_task(session_id="session-1", type="goal", objective="目标")
    publisher.events.clear()

    completed = service.update_task_from_agent(
        session_id="session-1",
        task_id=task["id"],
        status="complete",
        payload={
            "summary": "已完成",
            "checklist": [{"item": "测试", "status": "passed"}],
            "evidence": [{"type": "test", "title": "pytest passed"}],
        },
    )

    assert completed["status"] == "complete"
    assert [event["event_type"] for event in publisher.events] == [
        DomainEventType.THREAD_TASK_UPDATED
    ]
    assert publisher.events[0]["payload"]["task"]["status"] == "complete"


def test_thread_task_service_delete_emits_task_deleted_event(tmp_path) -> None:
    publisher = RecordingThreadTaskEventPublisher()
    service = _service(_repositories(tmp_path), event_publisher=publisher)
    task = service.create_task(session_id="session-1", type="goal", objective="目标")
    publisher.events.clear()

    deleted = service.delete_task(session_id="session-1", task_id=task["id"])

    assert deleted["deleted_at"] is not None
    assert [event["event_type"] for event in publisher.events] == [
        DomainEventType.THREAD_TASK_DELETED
    ]
    assert publisher.events[0]["payload"]["task_id"] == task["id"]
    assert publisher.events[0]["payload"]["task"]["status"] == "cancelled"


def test_thread_task_service_requires_three_repeated_blocked_audits(tmp_path) -> None:
    service = _service(_repositories(tmp_path))
    task = service.create_task(session_id="session-1", type="goal", objective="目标")
    payload = {
        "reason": "等待外部凭据",
        "attempts": ["检查环境", "查找配置"],
        "blocked_audit_key": "missing-credential",
    }

    with pytest.raises(ThreadTaskTransitionError, match="连续至少三轮"):
        service.update_task_from_agent(
            session_id="session-1",
            task_id=task["id"],
            status="blocked",
            payload=payload,
        )
    first = service.get_open_task("session-1")
    assert first is not None
    assert first["status"] == "active"
    assert first["blocked_audit"]["count"] == 1

    with pytest.raises(ThreadTaskTransitionError, match="连续至少三轮"):
        service.update_task_from_agent(
            session_id="session-1",
            task_id=task["id"],
            status="blocked",
            payload={**payload, "reason": "仍然等待外部凭据"},
        )
    second = service.get_open_task("session-1")
    assert second is not None
    assert second["blocked_audit"]["count"] == 2

    blocked = service.update_task_from_agent(
        session_id="session-1",
        task_id=task["id"],
        status="blocked",
        payload=payload,
    )
    assert blocked["status"] == "blocked"
    assert blocked["blocked_audit"]["count"] == 3


def test_thread_task_service_resets_blocked_audit_when_key_changes_or_user_resumes(
    tmp_path,
) -> None:
    service = _service(_repositories(tmp_path))
    task = service.create_task(session_id="session-1", type="goal", objective="目标")
    first_payload = {
        "reason": "等待外部凭据",
        "attempts": ["检查环境"],
        "blocked_audit_key": "missing-credential",
    }
    second_payload = {
        "reason": "等待网络恢复",
        "attempts": ["重试请求"],
        "blocked_audit_key": "network-down",
    }

    with pytest.raises(ThreadTaskTransitionError):
        service.update_task_from_agent(
            session_id="session-1",
            task_id=task["id"],
            status="blocked",
            payload=first_payload,
        )
    with pytest.raises(ThreadTaskTransitionError):
        service.update_task_from_agent(
            session_id="session-1",
            task_id=task["id"],
            status="blocked",
            payload=second_payload,
        )
    current = service.get_open_task("session-1")
    assert current is not None
    assert current["blocked_audit"]["key"] == "network-down"
    assert current["blocked_audit"]["count"] == 1

    with pytest.raises(ThreadTaskTransitionError):
        service.update_task_from_agent(
            session_id="session-1",
            task_id=task["id"],
            status="blocked",
            payload=second_payload,
        )
    blocked = service.update_task_from_agent(
        session_id="session-1",
        task_id=task["id"],
        status="blocked",
        payload=second_payload,
    )
    assert blocked["status"] == "blocked"

    resumed = service.resume_task(session_id="session-1", task_id=task["id"])
    assert resumed["status"] == "active"
    assert resumed["blocked_audit"] == {}


def test_thread_task_service_marks_system_stopped_only_through_system_method(tmp_path) -> None:
    service = _service(_repositories(tmp_path))
    task = service.create_task(session_id="session-1", type="goal", objective="目标")

    with pytest.raises(ThreadTaskTransitionError):
        service.update_task_from_user(
            session_id="session-1",
            task_id=task["id"],
            status="system_stopped",
        )
    with pytest.raises(ThreadTaskTransitionError):
        service.update_task_from_agent(
            session_id="session-1",
            task_id=task["id"],
            status="system_stopped",
            payload={},
        )

    stopped = service.mark_system_stopped(
        session_id="session-1",
        task_id=task["id"],
        reason="运行环境不可继续",
        run_id="run-1",
        trace_id="trace-1",
    )

    assert stopped["status"] == "system_stopped"
    assert stopped["system_stop_reason"] == "运行环境不可继续"
    assert stopped["current_run_id"] == "run-1"
    assert stopped["metadata"]["system_stop"]["trace_id"] == "trace-1"
    assert stopped["is_terminal"] is True
    assert service.get_open_task("session-1") is None


def test_thread_task_service_system_failure_threshold_stops_task(tmp_path) -> None:
    service = _service(_repositories(tmp_path))
    task = service.create_task(session_id="session-1", type="goal", objective="目标")

    first = service.record_system_failure(
        session_id="session-1",
        task_id=task["id"],
        reason="start_chat failed",
        run_id="run-1",
    )
    second = service.record_system_failure(
        session_id="session-1",
        task_id=task["id"],
        reason="start_chat failed",
        run_id="run-2",
    )
    third = service.record_system_failure(
        session_id="session-1",
        task_id=task["id"],
        reason="start_chat failed",
        run_id="run-3",
        trace_id="trace-3",
    )

    assert first["status"] == "active"
    assert first["metadata"]["system_failures"]["count"] == 1
    assert second["status"] == "active"
    assert second["metadata"]["system_failures"]["count"] == 2
    assert third["status"] == "system_stopped"
    assert third["system_stop_reason"] == "start_chat failed"
    assert third["metadata"]["system_stop"]["failure_count"] == 3


def test_thread_task_service_uses_shared_state_lock_for_external_mutations(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    state_locks = ThreadTaskStateLocks()
    service = _service(repositories, state_locks=state_locks)
    task = service.create_task(session_id="session-1", type="goal", objective="目标")

    with ThreadPoolExecutor(max_workers=1) as executor:
        with state_locks.acquire("session-1"):
            future = executor.submit(
                service.pause_task,
                session_id="session-1",
                task_id=task["id"],
            )
            assert future.done() is False

        assert future.result(timeout=2)["status"] == "paused"


def test_thread_task_runtime_permit_shares_state_lock_with_service(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    state_locks = ThreadTaskStateLocks()
    runtime = ThreadTaskRuntime(state_locks=state_locks)
    service = _service(repositories, state_locks=state_locks)
    task = service.create_task(session_id="session-1", type="goal", objective="目标")

    with ThreadPoolExecutor(max_workers=1) as executor:
        with runtime.task_state_permit("session-1"):
            future = executor.submit(
                service.delete_task,
                session_id="session-1",
                task_id=task["id"],
            )
            assert future.done() is False

        assert future.result(timeout=2)["deleted_at"] is not None


@pytest.mark.asyncio
async def test_thread_task_runtime_starts_hidden_continuation_for_active_idle_task(
    tmp_path,
) -> None:
    repositories = _repositories(tmp_path)
    repositories.sessions.update(
        "session-1",
        current_model_provider_id="provider-1",
        current_model="qwen-coder",
    )
    state_locks = ThreadTaskStateLocks()
    service = _service(repositories, state_locks=state_locks)
    task = service.create_task(
        session_id="session-1",
        type="goal",
        objective="完成 <runtime> & 测试",
    )
    manager = RecordingChatStreamManager()
    runtime = ThreadTaskRuntime(
        state_locks=state_locks,
        repositories=repositories,
        thread_task_service=service,
        chat_stream_manager=manager,
    )

    result = await runtime.continue_if_idle("session-1", reason="auto_continue")

    assert result["status"] == "started"
    assert result["task_id"] == task["id"]
    run = repositories.thread_task_runs.get(result["run_id"])
    assert run is not None
    assert run.status == "running"
    assert run.summary["reason"] == "auto_continue"
    assert repositories.thread_tasks.get(task["id"]).current_run_id == run.id

    assert len(manager.requests) == 1
    request = manager.requests[0]
    assert request.session_id == "session-1"
    assert request.message == ""
    assert request.provider_id == "provider-1"
    assert request.model == "qwen-coder"
    assert request.runtime_params["thread_task"] == {
        "task_id": task["id"],
        "run_id": run.id,
        "trigger": "task_continue",
        "type": "goal",
        "reason": "auto_continue",
        "context_compression_epoch": 0,
    }
    injection = request.runtime_params["message_injection"][0]
    assert injection["hidden_for_transcript"] is True
    assert injection["metadata"]["source"] == "thread_task"
    assert injection["metadata"]["run_id"] == run.id
    assert "完成 &lt;runtime&gt; &amp; 测试" in injection["content"]


@pytest.mark.asyncio
async def test_thread_task_runtime_does_not_replay_seed_context_without_new_compression(
    tmp_path,
) -> None:
    repositories = _repositories(tmp_path)
    state_locks = ThreadTaskStateLocks()
    service = _service(repositories, state_locks=state_locks)
    task = service.create_task(
        session_id="session-1",
        type="goal",
        objective="完成目标",
        metadata={
            "seed_turn_context": {
                "message": "完成目标",
                "runtime_params": {
                    "message_injection": [
                        {
                            "type": "follow",
                            "role": "HumanMessage",
                            "content": "用户通过 @ 引用了文件：README.md",
                        }
                    ],
                    "skill_activation": {
                        "skill_name": "dev-plan-execute",
                        "source": "workspace",
                        "origin": "slash",
                    },
                },
                "attachments": [{"attachment_id": "image-1", "type": "image"}],
            }
        },
    )
    manager = RecordingChatStreamManager()
    runtime = ThreadTaskRuntime(
        state_locks=state_locks,
        repositories=repositories,
        thread_task_service=service,
        chat_stream_manager=manager,
    )

    result = await runtime.continue_if_idle("session-1", reason="auto_continue")

    assert result["status"] == "started"
    request = manager.requests[0]
    assert request.message == ""
    assert request.attachments is None
    assert "skill_activation" not in request.runtime_params
    assert request.runtime_params["thread_task"]["context_compression_epoch"] == 0
    assert request.runtime_params["message_injection"][0]["metadata"]["source"] == "thread_task"
    run = repositories.thread_task_runs.get(result["run_id"])
    assert run.summary["seed_context_replayed"] is False
    seed = repositories.thread_tasks.get(task["id"]).metadata["seed_turn_context"]
    assert seed["last_replayed_compression_epoch"] == 0


@pytest.mark.asyncio
async def test_thread_task_runtime_replays_structured_seed_context_after_compression_epoch_advances(
    tmp_path,
) -> None:
    repositories = _repositories(tmp_path)
    state_locks = ThreadTaskStateLocks()
    service = _service(repositories, state_locks=state_locks)
    task = service.create_task(
        session_id="session-1",
        type="goal",
        objective="完成目标",
        metadata={
            "seed_turn_context": {
                "message": "完成目标，请参考这些上下文",
                "runtime_params": {
                    "message_injection": [
                        {
                            "type": "follow",
                            "role": "HumanMessage",
                            "content": "用户通过 @ 引用了文件：README.md",
                            "metadata": {"path": "README.md"},
                        }
                    ],
                    "skill_activation": {
                        "skill_name": "dev-plan-execute",
                        "source": "workspace",
                        "origin": "slash",
                    },
                    "thread_task": {"task_id": "stale"},
                },
                "attachments": [
                    {
                        "attachment_id": "image-1",
                        "type": "image",
                        "name": "screenshot.png",
                    }
                ],
            }
        },
    )
    repositories.sessions.increment_context_compression_epoch("session-1")
    manager = RecordingChatStreamManager()
    runtime = ThreadTaskRuntime(
        state_locks=state_locks,
        repositories=repositories,
        thread_task_service=service,
        chat_stream_manager=manager,
    )

    result = await runtime.continue_if_idle("session-1", reason="auto_continue")

    assert result["status"] == "started"
    request = manager.requests[0]
    assert request.message == ""
    assert request.attachments == [
        {"attachment_id": "image-1", "type": "image", "name": "screenshot.png"}
    ]
    assert request.runtime_params["hide_user_message_for_transcript"] is True
    assert request.runtime_params["thread_task"]["seed_context_replayed"] is True
    assert request.runtime_params["thread_task"]["context_compression_epoch"] == 1
    assert request.runtime_params["skill_activation"] == {
        "skill_name": "dev-plan-execute",
        "source": "workspace",
        "origin": "slash",
    }
    assert request.runtime_params["thread_task"]["task_id"] == task["id"]
    assert (
        request.runtime_params["message_injection"][0]["content"]
        == "用户通过 @ 引用了文件：README.md"
    )
    assert request.runtime_params["message_injection"][0]["hidden_for_transcript"] is True
    assert (
        request.runtime_params["message_injection"][0]["metadata"]["source"]
        == "thread_task_seed_context"
    )
    assert request.runtime_params["message_injection"][1]["metadata"]["source"] == "thread_task"
    run = repositories.thread_task_runs.get(result["run_id"])
    assert run.summary["seed_context_replayed"] is True
    seed = repositories.thread_tasks.get(task["id"]).metadata["seed_turn_context"]
    assert seed["last_replayed_compression_epoch"] == 1
    assert seed["replay_history"][-1]["run_id"] == result["run_id"]


@pytest.mark.asyncio
async def test_thread_task_runtime_does_not_replay_raw_seed_message_after_compression(
    tmp_path,
) -> None:
    repositories = _repositories(tmp_path)
    state_locks = ThreadTaskStateLocks()
    service = _service(repositories, state_locks=state_locks)
    task = service.create_task(
        session_id="session-1",
        type="goal",
        objective="完成目标",
        metadata={
            "seed_turn_context": {
                "message": "这是一段只应该作为目标正文存在的原始用户输入",
                "runtime_params": {},
                "attachments": [],
            }
        },
    )
    repositories.sessions.increment_context_compression_epoch("session-1")
    manager = RecordingChatStreamManager()
    runtime = ThreadTaskRuntime(
        state_locks=state_locks,
        repositories=repositories,
        thread_task_service=service,
        chat_stream_manager=manager,
    )

    result = await runtime.continue_if_idle("session-1", reason="auto_continue")

    assert result["status"] == "started"
    request = manager.requests[0]
    assert request.message == ""
    assert request.attachments is None
    assert "hide_user_message_for_transcript" not in request.runtime_params
    assert request.runtime_params["thread_task"]["context_compression_epoch"] == 1
    assert "seed_context_replayed" not in request.runtime_params["thread_task"]
    assert request.runtime_params["message_injection"][0]["metadata"]["source"] == "thread_task"
    run = repositories.thread_task_runs.get(result["run_id"])
    assert run.summary["seed_context_replayed"] is False
    seed = repositories.thread_tasks.get(task["id"]).metadata["seed_turn_context"]
    assert seed["last_replayed_compression_epoch"] == 0


@pytest.mark.asyncio
async def test_thread_task_runtime_emits_run_started_and_finished_events(
    tmp_path,
) -> None:
    repositories = _repositories(tmp_path)
    state_locks = ThreadTaskStateLocks()
    publisher = RecordingThreadTaskEventPublisher()
    service = _service(repositories, state_locks=state_locks, event_publisher=publisher)
    task = service.create_task(session_id="session-1", type="goal", objective="目标")
    publisher.events.clear()
    manager = RecordingChatStreamManager()
    runtime = ThreadTaskRuntime(
        state_locks=state_locks,
        repositories=repositories,
        thread_task_service=service,
        chat_stream_manager=manager,
        event_publisher=publisher,
    )

    started = await runtime.continue_if_idle("session-1", reason="auto_continue")
    _finish_trace(repositories, trace_id="trace-run-events", duration_ms=1000)
    finished = await runtime.handle_chat_finished(
        "session-1",
        request=manager.requests[0],
        result=ChatTurnResult(
            session_id="session-1",
            trace_id="trace-run-events",
            turn_index=12,
            status="completed",
            final_content="完成一步",
        ),
    )

    assert started["status"] == "started"
    assert finished["run_status"] == "succeeded"
    assert [event["event_type"] for event in publisher.events] == [
        DomainEventType.THREAD_TASK_RUN_STARTED,
        DomainEventType.THREAD_TASK_RUN_FINISHED,
    ]
    started_event = publisher.events[0]
    assert started_event["payload"]["task_id"] == task["id"]
    assert started_event["payload"]["run_id"] == started["run_id"]
    assert started_event["payload"]["task"]["current_run_id"] == started["run_id"]
    finished_event = publisher.events[1]
    assert finished_event["payload"]["trace_id"] == "trace-run-events"
    assert finished_event["payload"]["turn_index"] == 12
    assert finished_event["payload"]["run"]["status"] == "succeeded"
    assert finished_event["payload"]["task"]["current_run_id"] is None


@pytest.mark.asyncio
async def test_thread_task_runtime_logs_continuation_lifecycle_fields(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    state_locks = ThreadTaskStateLocks()
    service = _service(repositories, state_locks=state_locks)
    long_objective = "目标-" + ("继续" * 120)
    task = service.create_task(session_id="session-1", type="goal", objective=long_objective)
    manager = RecordingChatStreamManager()
    runtime = ThreadTaskRuntime(
        state_locks=state_locks,
        repositories=repositories,
        thread_task_service=service,
        chat_stream_manager=manager,
    )
    messages, sink_id = _capture_loguru_messages()
    try:
        started = await runtime.continue_if_idle("session-1", reason="auto_continue")
        _finish_trace(repositories, trace_id="trace-runtime-log", duration_ms=1000)
        await runtime.handle_chat_finished(
            "session-1",
            request=manager.requests[0],
            result=ChatTurnResult(
                session_id="session-1",
                trace_id="trace-runtime-log",
                turn_index=7,
                status="completed",
                final_content="完成一步",
            ),
        )
    finally:
        logger.remove(sink_id)

    joined = "\n".join(messages)
    assert "[ThreadTaskRuntime] continuation_started" in joined
    assert "[ThreadTaskRuntime] run_finished" in joined
    assert "session_id=session-1" in joined
    assert f"task_id={task['id']}" in joined
    assert f"run_id={started['run_id']}" in joined
    assert "trigger=auto_continue" in joined
    assert "trace_id=trace-runtime-log" in joined
    assert "turn_index=7" in joined
    assert "run_status=succeeded" in joined
    assert f"objective_len={len(long_objective)}" in joined
    assert long_objective not in joined


@pytest.mark.asyncio
async def test_thread_task_runtime_skips_archived_session(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    state_locks = ThreadTaskStateLocks()
    service = _service(repositories, state_locks=state_locks)
    task = service.create_task(session_id="session-1", type="goal", objective="目标")
    repositories.sessions.archive_manual(
        "session-1",
        archived_at="2026-07-14T12:00:00Z",
    )
    manager = RecordingChatStreamManager()
    runtime = ThreadTaskRuntime(
        state_locks=state_locks,
        repositories=repositories,
        thread_task_service=service,
        chat_stream_manager=manager,
    )

    result = await runtime.continue_if_idle("session-1")

    assert result["status"] == "skipped"
    assert result["reason"] == "session_missing_or_archived"
    assert repositories.thread_task_runs.list_by_task(task["id"]) == []
    assert manager.requests == []


@pytest.mark.asyncio
async def test_thread_task_runtime_does_not_duplicate_running_task_run(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    state_locks = ThreadTaskStateLocks()
    service = _service(repositories, state_locks=state_locks)
    task = service.create_task(session_id="session-1", type="goal", objective="目标")
    manager = RecordingChatStreamManager()
    runtime = ThreadTaskRuntime(
        state_locks=state_locks,
        repositories=repositories,
        thread_task_service=service,
        chat_stream_manager=manager,
    )

    first = await runtime.continue_if_idle("session-1")
    second = await runtime.continue_if_idle("session-1")

    assert first["status"] == "started"
    assert second["status"] == "skipped"
    assert second["reason"] == "task_run_running"
    assert second["run_id"] == first["run_id"]
    assert len(repositories.thread_task_runs.list_by_task(task["id"])) == 1
    assert len(manager.requests) == 1


@pytest.mark.asyncio
async def test_thread_task_runtime_only_resumes_when_chat_session_is_idle(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    state_locks = ThreadTaskStateLocks()
    service = _service(repositories, state_locks=state_locks)
    task = service.create_task(session_id="session-1", type="goal", objective="目标")
    manager = RecordingChatStreamManager(status="running")
    runtime = ThreadTaskRuntime(
        state_locks=state_locks,
        repositories=repositories,
        thread_task_service=service,
        chat_stream_manager=manager,
    )

    result = await runtime.continue_if_idle("session-1")

    assert result["status"] == "skipped"
    assert result["reason"] == "running"
    assert repositories.thread_task_runs.list_by_task(task["id"]) == []
    assert manager.requests == []


@pytest.mark.asyncio
async def test_thread_task_runtime_does_not_start_paused_or_complete_task(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    state_locks = ThreadTaskStateLocks()
    service = _service(repositories, state_locks=state_locks)
    paused = service.create_task(session_id="session-1", type="goal", objective="暂停目标")
    service.pause_task(session_id="session-1", task_id=paused["id"])
    manager = RecordingChatStreamManager()
    runtime = ThreadTaskRuntime(
        state_locks=state_locks,
        repositories=repositories,
        thread_task_service=service,
        chat_stream_manager=manager,
    )

    paused_result = await runtime.continue_if_idle("session-1")

    assert paused_result["status"] == "skipped"
    assert paused_result["reason"] == "task_not_active"
    assert repositories.thread_task_runs.list_by_task(paused["id"]) == []
    assert manager.requests == []

    service.delete_task(session_id="session-1", task_id=paused["id"])
    active = service.create_task(session_id="session-1", type="goal", objective="完成目标")
    service.update_task_from_agent(
        session_id="session-1",
        task_id=active["id"],
        status="complete",
        payload={
            "summary": "已完成",
            "checklist": [{"item": "目标", "status": "passed", "evidence": "done"}],
            "evidence": [{"type": "test", "summary": "passed"}],
        },
    )

    complete_result = await runtime.continue_if_idle("session-1")

    assert complete_result["status"] == "skipped"
    assert complete_result["reason"] == "no_active_task"
    assert repositories.thread_task_runs.list_by_task(active["id"]) == []
    assert manager.requests == []


@pytest.mark.asyncio
async def test_thread_task_runtime_marks_run_skipped_when_start_chat_is_busy(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    state_locks = ThreadTaskStateLocks()
    service = _service(repositories, state_locks=state_locks)
    task = service.create_task(session_id="session-1", type="goal", objective="目标")
    runtime = ThreadTaskRuntime(
        state_locks=state_locks,
        repositories=repositories,
        thread_task_service=service,
        chat_stream_manager=RecordingChatStreamManager(
            start_error=ChatStreamAlreadyRunningError("busy")
        ),
    )

    result = await runtime.continue_if_idle("session-1")

    assert result["status"] == "skipped"
    assert result["reason"] == "busy"
    run = repositories.thread_task_runs.get(result["run_id"])
    assert run is not None
    assert run.status == "skipped"
    assert run.summary == {"reason": "busy"}
    assert repositories.thread_tasks.get(task["id"]).current_run_id is None


@pytest.mark.asyncio
async def test_thread_task_runtime_marks_run_failed_and_records_system_failure(
    tmp_path,
) -> None:
    repositories = _repositories(tmp_path)
    state_locks = ThreadTaskStateLocks()
    service = _service(repositories, state_locks=state_locks)
    task = service.create_task(session_id="session-1", type="goal", objective="目标")
    runtime = ThreadTaskRuntime(
        state_locks=state_locks,
        repositories=repositories,
        thread_task_service=service,
        chat_stream_manager=RecordingChatStreamManager(start_error=RuntimeError("boom")),
    )

    result = await runtime.continue_if_idle("session-1")

    assert result["status"] == "failed"
    assert result["reason"] == "start_chat failed: RuntimeError"
    run = repositories.thread_task_runs.get(result["run_id"])
    assert run is not None
    assert run.status == "failed"
    assert run.error["reason"] == "start_chat failed: RuntimeError"
    updated = repositories.thread_tasks.get(task["id"])
    assert updated.metadata["system_failures"]["count"] == 1
    assert updated.metadata["system_failures"]["run_id"] == run.id


@pytest.mark.asyncio
async def test_thread_task_runtime_finish_succeeded_run_updates_task_run_accounting(
    tmp_path,
) -> None:
    repositories = _repositories(tmp_path)
    state_locks = ThreadTaskStateLocks()
    service = _service(repositories, state_locks=state_locks)
    task = service.create_task(session_id="session-1", type="goal", objective="目标")
    run = repositories.thread_task_runs.create_running(
        run_id="run-1",
        task_id=task["id"],
        session_id="session-1",
    )
    repositories.thread_tasks.update(task["id"], current_run_id=run.id)
    _finish_trace(
        repositories,
        trace_id="trace-1",
        duration_ms=2500,
        total_input_tokens=10,
        total_output_tokens=4,
    )
    runtime = ThreadTaskRuntime(
        state_locks=state_locks,
        repositories=repositories,
        thread_task_service=service,
        chat_stream_manager=RecordingChatStreamManager(),
    )

    result = await runtime.handle_chat_finished(
        "session-1",
        request=_task_request(task["id"], run.id),
        result=ChatTurnResult(
            session_id="session-1",
            trace_id="trace-1",
            turn_index=4,
            status="completed",
            final_content="继续完成了一步",
        ),
    )

    assert result["run_status"] == "succeeded"
    finished_run = repositories.thread_task_runs.get(run.id)
    assert finished_run.status == "succeeded"
    assert finished_run.finished_at is not None
    assert finished_run.turn_index == 4
    assert finished_run.trace_id == "trace-1"
    assert finished_run.summary["final_content_preview"] == "继续完成了一步"
    updated = repositories.thread_tasks.get(task["id"])
    assert updated.turn_count == 1
    assert updated.elapsed_seconds == 0
    assert updated.current_run_id is None
    assert updated.token_usage["latest"]["trace_id"] == "trace-1"
    assert updated.token_usage["total_tokens"] == 14


@pytest.mark.asyncio
async def test_thread_task_runtime_finish_failed_run_records_error_and_failure(
    tmp_path,
) -> None:
    repositories = _repositories(tmp_path)
    state_locks = ThreadTaskStateLocks()
    service = _service(repositories, state_locks=state_locks)
    task = service.create_task(session_id="session-1", type="goal", objective="目标")
    run = repositories.thread_task_runs.create_running(
        run_id="run-1",
        task_id=task["id"],
        session_id="session-1",
    )
    repositories.thread_tasks.update(task["id"], current_run_id=run.id)
    _finish_trace(repositories, trace_id="trace-failed", status="failed", duration_ms=1000)
    runtime = ThreadTaskRuntime(
        state_locks=state_locks,
        repositories=repositories,
        thread_task_service=service,
        chat_stream_manager=RecordingChatStreamManager(),
    )

    result = await runtime.handle_chat_finished(
        "session-1",
        request=_task_request(task["id"], run.id),
        result=ChatTurnResult(
            session_id="session-1",
            trace_id="trace-failed",
            turn_index=5,
            status="failed",
            error="模型失败",
        ),
    )

    assert result["run_status"] == "failed"
    finished_run = repositories.thread_task_runs.get(run.id)
    assert finished_run.status == "failed"
    assert finished_run.error == {"reason": "turn_failed", "message": "模型失败"}
    updated = repositories.thread_tasks.get(task["id"])
    assert updated.turn_count == 1
    assert updated.metadata["system_failures"]["count"] == 1
    assert updated.metadata["system_failures"]["trace_id"] == "trace-failed"


@pytest.mark.asyncio
async def test_thread_task_runtime_finish_cancelled_run_does_not_record_failure(
    tmp_path,
) -> None:
    repositories = _repositories(tmp_path)
    state_locks = ThreadTaskStateLocks()
    service = _service(repositories, state_locks=state_locks)
    task = service.create_task(session_id="session-1", type="goal", objective="目标")
    run = repositories.thread_task_runs.create_running(
        run_id="run-1",
        task_id=task["id"],
        session_id="session-1",
    )
    repositories.thread_tasks.update(task["id"], current_run_id=run.id)
    _finish_trace(repositories, trace_id="trace-cancelled", status="cancelled", duration_ms=1000)
    runtime = ThreadTaskRuntime(
        state_locks=state_locks,
        repositories=repositories,
        thread_task_service=service,
        chat_stream_manager=RecordingChatStreamManager(),
    )

    result = await runtime.handle_chat_finished(
        "session-1",
        request=_task_request(task["id"], run.id),
        result=ChatTurnResult(
            session_id="session-1",
            trace_id="trace-cancelled",
            turn_index=6,
            status="cancelled",
        ),
    )

    assert result["run_status"] == "cancelled"
    assert repositories.thread_task_runs.get(run.id).status == "cancelled"
    updated = repositories.thread_tasks.get(task["id"])
    assert updated.turn_count == 1
    assert "system_failures" not in updated.metadata


@pytest.mark.asyncio
async def test_thread_task_runtime_user_cancel_pauses_active_task(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    state_locks = ThreadTaskStateLocks()
    publisher = RecordingThreadTaskEventPublisher()
    service = _service(
        repositories,
        state_locks=state_locks,
        event_publisher=publisher,
    )
    task = service.create_task(session_id="session-1", type="goal", objective="目标")
    publisher.events.clear()
    runtime = ThreadTaskRuntime(
        state_locks=state_locks,
        repositories=repositories,
        thread_task_service=service,
        chat_stream_manager=RecordingChatStreamManager(),
    )

    result = await runtime.handle_user_cancelled(
        "session-1",
        request=ChatRequest(session_id="session-1", message="用户首轮目标输入"),
        result=ChatTurnResult(
            session_id="session-1",
            trace_id="trace-cancelled",
            turn_index=6,
            status="cancelled",
        ),
    )

    assert result["status"] == "paused"
    updated = repositories.thread_tasks.get(task["id"])
    assert updated.status == "paused"
    assert updated.is_open is True
    assert [event["event_type"] for event in publisher.events] == [
        DomainEventType.THREAD_TASK_UPDATED
    ]
    assert publisher.events[0]["payload"]["task"]["status"] == "paused"


@pytest.mark.asyncio
async def test_thread_task_runtime_does_not_continue_after_task_completed_in_turn(
    tmp_path,
) -> None:
    repositories = _repositories(tmp_path)
    state_locks = ThreadTaskStateLocks()
    service = _service(repositories, state_locks=state_locks)
    task = service.create_task(session_id="session-1", type="goal", objective="目标")
    run = repositories.thread_task_runs.create_running(
        run_id="run-1",
        task_id=task["id"],
        session_id="session-1",
    )
    repositories.thread_tasks.update(task["id"], current_run_id=run.id)
    service.update_task_from_agent(
        session_id="session-1",
        task_id=task["id"],
        status="complete",
        payload={
            "summary": "已完成",
            "checklist": [{"item": "目标", "status": "passed", "evidence": "done"}],
            "evidence": [{"type": "test", "summary": "passed"}],
        },
    )
    _finish_trace(repositories, trace_id="trace-complete", duration_ms=1000)
    manager = RecordingChatStreamManager()
    runtime = ThreadTaskRuntime(
        state_locks=state_locks,
        repositories=repositories,
        thread_task_service=service,
        chat_stream_manager=manager,
    )

    await runtime.handle_chat_finished(
        "session-1",
        request=_task_request(task["id"], run.id),
        result=ChatTurnResult(
            session_id="session-1",
            trace_id="trace-complete",
            turn_index=7,
            status="completed",
        ),
    )
    continue_result = await runtime.continue_if_idle("session-1")

    assert repositories.thread_task_runs.get(run.id).status == "succeeded"
    assert continue_result["status"] == "skipped"
    assert continue_result["reason"] == "no_active_task"
    assert manager.requests == []


@pytest.mark.asyncio
async def test_thread_task_runtime_continues_after_active_run_finished(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    state_locks = ThreadTaskStateLocks()
    service = _service(repositories, state_locks=state_locks)
    task = service.create_task(session_id="session-1", type="goal", objective="目标")
    run = repositories.thread_task_runs.create_running(
        run_id="run-1",
        task_id=task["id"],
        session_id="session-1",
    )
    repositories.thread_tasks.update(task["id"], current_run_id=run.id)
    _finish_trace(repositories, trace_id="trace-active", duration_ms=1000)
    manager = RecordingChatStreamManager()
    runtime = ThreadTaskRuntime(
        state_locks=state_locks,
        repositories=repositories,
        thread_task_service=service,
        chat_stream_manager=manager,
    )

    await runtime.handle_chat_finished(
        "session-1",
        request=_task_request(task["id"], run.id),
        result=ChatTurnResult(
            session_id="session-1",
            trace_id="trace-active",
            turn_index=8,
            status="completed",
        ),
    )
    continue_result = await runtime.continue_if_idle("session-1")

    assert repositories.thread_task_runs.get(run.id).status == "succeeded"
    assert continue_result["status"] == "started"
    assert len(manager.requests) == 1


@pytest.mark.asyncio
async def test_thread_task_runtime_does_not_continue_after_running_task_deleted(
    tmp_path,
) -> None:
    repositories = _repositories(tmp_path)
    state_locks = ThreadTaskStateLocks()
    publisher = RecordingThreadTaskEventPublisher()
    service = _service(repositories, state_locks=state_locks, event_publisher=publisher)
    task = service.create_task(session_id="session-1", type="goal", objective="目标")
    run = repositories.thread_task_runs.create_running(
        run_id="run-1",
        task_id=task["id"],
        session_id="session-1",
    )
    repositories.thread_tasks.update(task["id"], current_run_id=run.id)
    deleted = service.delete_task(session_id="session-1", task_id=task["id"])
    publisher.events.clear()
    _finish_trace(repositories, trace_id="trace-deleted", duration_ms=1000)
    manager = RecordingChatStreamManager()
    runtime = ThreadTaskRuntime(
        state_locks=state_locks,
        repositories=repositories,
        thread_task_service=service,
        chat_stream_manager=manager,
        event_publisher=publisher,
    )

    await runtime.handle_chat_finished(
        "session-1",
        request=_task_request(task["id"], run.id),
        result=ChatTurnResult(
            session_id="session-1",
            trace_id="trace-deleted",
            turn_index=9,
            status="completed",
        ),
    )
    continue_result = await runtime.continue_if_idle("session-1")

    assert deleted["status"] == "cancelled"
    assert repositories.thread_task_runs.get(run.id).status == "succeeded"
    assert continue_result["status"] == "skipped"
    assert continue_result["reason"] == "no_active_task"
    assert manager.requests == []
    assert [event["event_type"] for event in publisher.events] == [
        DomainEventType.THREAD_TASK_RUN_FINISHED
    ]
    assert publisher.events[0]["payload"]["task"]["status"] == "cancelled"
    assert not any(
        event["event_type"] == DomainEventType.THREAD_TASK_UPDATED
        and event["payload"].get("task", {}).get("status") == "active"
        for event in publisher.events
    )


@pytest.mark.asyncio
async def test_thread_task_runtime_does_not_continue_after_running_task_cancelled(
    tmp_path,
) -> None:
    repositories = _repositories(tmp_path)
    state_locks = ThreadTaskStateLocks()
    service = _service(repositories, state_locks=state_locks)
    task = service.create_task(session_id="session-1", type="goal", objective="目标")
    run = repositories.thread_task_runs.create_running(
        run_id="run-1",
        task_id=task["id"],
        session_id="session-1",
    )
    repositories.thread_tasks.update(task["id"], current_run_id=run.id)
    cancelled = service.cancel_task(session_id="session-1", task_id=task["id"])
    _finish_trace(repositories, trace_id="trace-task-cancelled", duration_ms=1000)
    manager = RecordingChatStreamManager()
    runtime = ThreadTaskRuntime(
        state_locks=state_locks,
        repositories=repositories,
        thread_task_service=service,
        chat_stream_manager=manager,
    )

    await runtime.handle_chat_finished(
        "session-1",
        request=_task_request(task["id"], run.id),
        result=ChatTurnResult(
            session_id="session-1",
            trace_id="trace-task-cancelled",
            turn_index=10,
            status="completed",
        ),
    )
    continue_result = await runtime.continue_if_idle("session-1")

    assert cancelled["status"] == "cancelled"
    assert repositories.thread_tasks.get(task["id"], include_deleted=True).status == "cancelled"
    assert repositories.thread_task_runs.get(run.id).status == "succeeded"
    assert continue_result["status"] == "skipped"
    assert continue_result["reason"] == "no_active_task"
    assert manager.requests == []


@pytest.mark.asyncio
async def test_thread_task_runtime_ignores_plain_chat_cancel_for_task_state(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    state_locks = ThreadTaskStateLocks()
    service = _service(repositories, state_locks=state_locks)
    task = service.create_task(session_id="session-1", type="goal", objective="目标")
    runtime = ThreadTaskRuntime(
        state_locks=state_locks,
        repositories=repositories,
        thread_task_service=service,
        chat_stream_manager=RecordingChatStreamManager(),
    )

    result = await runtime.handle_chat_finished(
        "session-1",
        request=ChatRequest(session_id="session-1", message="普通消息"),
        result=ChatTurnResult(
            session_id="session-1",
            trace_id="trace-plain-cancel",
            turn_index=11,
            status="cancelled",
        ),
    )

    assert result is None
    assert service.get_open_task("session-1")["id"] == task["id"]
    assert service.get_open_task("session-1")["status"] == "active"
