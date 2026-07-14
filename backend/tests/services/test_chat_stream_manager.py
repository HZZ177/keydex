from __future__ import annotations

import asyncio
from typing import Any

import pytest

from backend.app.services import (
    ChatRequest,
    ChatStreamAlreadyRunningError,
    ChatStreamManager,
    ThreadTaskRuntime,
)
from backend.app.services.chat_types import (
    PENDING_INPUT_STATUS_DELIVERED,
    PENDING_INPUT_STATUS_PENDING_STEER,
    PENDING_INPUT_STATUS_QUEUED,
)
from backend.app.storage import StorageRepositories, init_database


class RecordingAdapter:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send(self, *, session_id: str, action: str, data: dict[str, Any]) -> bool:
        self.sent.append({"session_id": session_id, "action": action, "data": data})
        return True


class BlockingChatService:
    def __init__(self) -> None:
        self.started: dict[str, asyncio.Event] = {}
        self.after_first_send: dict[str, asyncio.Event] = {}
        self.release: dict[str, asyncio.Event] = {}
        self.finished: dict[str, asyncio.Event] = {}
        self.cancellations: dict[str, Any] = {}

    def prepare(self, session_id: str) -> None:
        self.started.setdefault(session_id, asyncio.Event())
        self.after_first_send.setdefault(session_id, asyncio.Event())
        self.release.setdefault(session_id, asyncio.Event())
        self.finished.setdefault(session_id, asyncio.Event())

    async def handle_chat(self, request, *, chat_adapter, cancellation):
        session_id = request.session_id or ""
        self.prepare(session_id)
        self.started[session_id].set()
        self.cancellations[session_id] = cancellation

        await chat_adapter.send(
            session_id=session_id,
            action="stream",
            data={"content": f"first:{session_id}"},
        )
        self.after_first_send[session_id].set()
        await self.release[session_id].wait()

        if not cancellation.is_cancelled():
            await chat_adapter.send(
                session_id=session_id,
                action="completed",
                data={"final_content": f"done:{session_id}"},
            )
        self.finished[session_id].set()


class SequencedBlockingChatService:
    def __init__(self) -> None:
        self.requests: list[Any] = []
        self.started: list[asyncio.Event] = []
        self.after_first_send: list[asyncio.Event] = []
        self.release: list[asyncio.Event] = []
        self.finished: list[asyncio.Event] = []
        self.cancellations: list[Any] = []

    async def handle_chat(self, request, *, chat_adapter, cancellation):
        index = len(self.requests)
        self.requests.append(request)
        self.cancellations.append(cancellation)
        self.started.append(asyncio.Event())
        self.after_first_send.append(asyncio.Event())
        self.release.append(asyncio.Event())
        self.finished.append(asyncio.Event())

        session_id = request.session_id or ""
        self.started[index].set()
        await chat_adapter.send(
            session_id=session_id,
            action="stream",
            data={"content": f"first:{index}:{request.message}"},
        )
        self.after_first_send[index].set()
        await self.release[index].wait()

        if not cancellation.is_cancelled():
            await chat_adapter.send(
                session_id=session_id,
                action="completed",
                data={"final_content": f"done:{index}:{request.message}"},
            )
        self.finished[index].set()


class NeverEndingChatService:
    def __init__(self) -> None:
        self.started: dict[str, asyncio.Event] = {}
        self.cancelled: dict[str, asyncio.Event] = {}
        self.finished: dict[str, asyncio.Event] = {}
        self.cancellations: dict[str, Any] = {}

    def prepare(self, session_id: str) -> None:
        self.started.setdefault(session_id, asyncio.Event())
        self.cancelled.setdefault(session_id, asyncio.Event())
        self.finished.setdefault(session_id, asyncio.Event())

    async def handle_chat(self, request, *, chat_adapter, cancellation):
        session_id = request.session_id or ""
        self.prepare(session_id)
        self.cancellations[session_id] = cancellation
        self.started[session_id].set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            self.cancelled[session_id].set()
            raise
        finally:
            self.finished[session_id].set()


class RecordingTaskRuntime:
    def __init__(self) -> None:
        self.manager: ChatStreamManager | None = None
        self.calls: list[dict[str, Any]] = []
        self.finish_calls: list[dict[str, Any]] = []
        self.cancel_calls: list[dict[str, Any]] = []
        self.events: list[str] = []
        self.called = asyncio.Event()
        self.cancelled = asyncio.Event()

    def bind_chat_stream_manager(self, manager: ChatStreamManager) -> None:
        self.manager = manager

    async def handle_chat_finished(
        self,
        session_id: str,
        *,
        request: ChatRequest | None = None,
        result: Any | None = None,
        error: BaseException | None = None,
    ) -> None:
        self.finish_calls.append(
            {
                "session_id": session_id,
                "request": request,
                "result": result,
                "error": error,
            }
        )
        self.events.append("finished")

    async def handle_user_cancelled(
        self,
        session_id: str,
        *,
        request: ChatRequest | None = None,
        result: Any | None = None,
        error: BaseException | None = None,
    ) -> None:
        self.cancel_calls.append(
            {
                "session_id": session_id,
                "request": request,
                "result": result,
                "error": error,
            }
        )
        self.events.append("cancelled")
        self.cancelled.set()

    async def continue_if_idle(self, session_id: str, *, reason: str = "auto_continue"):
        assert self.manager is not None
        status = await self.manager.status(session_id)
        self.calls.append({"session_id": session_id, "reason": reason, "status": status})
        self.events.append("continue")
        self.called.set()
        return {"status": "checked"}


@pytest.mark.asyncio
async def test_chat_stream_manager_unsubscribe_does_not_cancel_running_turn() -> None:
    service = BlockingChatService()
    service.prepare("ses-a")
    manager = ChatStreamManager(service)  # type: ignore[arg-type]
    adapter = RecordingAdapter()

    await manager.subscribe("ses-a", adapter)
    await manager.start_chat(ChatRequest(session_id="ses-a", message="hello", model="fake"))
    await asyncio.wait_for(service.after_first_send["ses-a"].wait(), timeout=1)

    await manager.unsubscribe_all(adapter)
    service.release["ses-a"].set()
    await asyncio.wait_for(service.finished["ses-a"].wait(), timeout=1)

    assert service.cancellations["ses-a"].is_cancelled() is False
    assert [item["action"] for item in adapter.sent] == ["stream"]
    assert await manager.status("ses-a") == {
        "session_id": "ses-a",
        "status": "idle",
        "running_sessions": [],
        "waiting_approval_sessions": [],
        "waiting_input_sessions": [],
        "pending_approvals": [],
        "pending_inputs": [],
    }


@pytest.mark.asyncio
async def test_chat_stream_manager_finish_notifies_thread_task_runtime_after_idle() -> None:
    service = BlockingChatService()
    service.prepare("ses-a")
    manager = ChatStreamManager(service)  # type: ignore[arg-type]
    runtime = RecordingTaskRuntime()
    manager.set_thread_task_runtime(runtime)

    await manager.start_chat(ChatRequest(session_id="ses-a", message="hello", model="fake"))
    await asyncio.wait_for(service.after_first_send["ses-a"].wait(), timeout=1)

    service.release["ses-a"].set()
    await asyncio.wait_for(service.finished["ses-a"].wait(), timeout=1)
    await asyncio.wait_for(runtime.called.wait(), timeout=1)

    assert len(runtime.finish_calls) == 1
    assert runtime.finish_calls[0]["session_id"] == "ses-a"
    assert runtime.finish_calls[0]["request"].message == "hello"
    assert runtime.finish_calls[0]["error"] is None
    assert runtime.events == ["finished", "continue"]
    assert runtime.calls == [
        {
            "session_id": "ses-a",
            "reason": "run_finished",
            "status": {
                "session_id": "ses-a",
                "status": "idle",
                "running_sessions": [],
                "waiting_approval_sessions": [],
                "waiting_input_sessions": [],
                "pending_approvals": [],
                "pending_inputs": [],
            },
        }
    ]


@pytest.mark.asyncio
async def test_chat_stream_manager_user_cancel_pauses_task_runtime_without_auto_continue() -> None:
    service = NeverEndingChatService()
    service.prepare("ses-a")
    manager = ChatStreamManager(service)  # type: ignore[arg-type]
    runtime = RecordingTaskRuntime()
    manager.set_thread_task_runtime(runtime)

    await manager.start_chat(ChatRequest(session_id="ses-a", message="hello", model="fake"))
    await asyncio.wait_for(service.started["ses-a"].wait(), timeout=1)

    assert await manager.cancel("ses-a") is True
    await asyncio.wait_for(service.cancelled["ses-a"].wait(), timeout=1)
    await asyncio.wait_for(service.finished["ses-a"].wait(), timeout=1)
    await asyncio.wait_for(runtime.cancelled.wait(), timeout=1)

    assert len(runtime.finish_calls) == 1
    assert len(runtime.cancel_calls) == 1
    assert runtime.cancel_calls[0]["session_id"] == "ses-a"
    assert runtime.cancel_calls[0]["request"].message == "hello"
    assert type(runtime.cancel_calls[0]["error"]).__name__ == "CancelledError"
    assert runtime.events == ["finished", "cancelled"]
    assert runtime.calls == []


@pytest.mark.asyncio
async def test_chat_stream_manager_finish_notifies_after_finish_callback() -> None:
    service = BlockingChatService()
    service.prepare("ses-a")
    manager = ChatStreamManager(service)  # type: ignore[arg-type]
    calls: list[dict[str, Any]] = []
    called = asyncio.Event()

    async def after_finish(session_id: str) -> None:
        calls.append({"session_id": session_id, "status": await manager.status(session_id)})
        called.set()

    manager.set_after_run_finished_callback(after_finish)

    await manager.start_chat(ChatRequest(session_id="ses-a", message="hello", model="fake"))
    await asyncio.wait_for(service.after_first_send["ses-a"].wait(), timeout=1)

    service.release["ses-a"].set()
    await asyncio.wait_for(service.finished["ses-a"].wait(), timeout=1)
    await asyncio.wait_for(called.wait(), timeout=1)

    assert calls[0]["session_id"] == "ses-a"
    assert calls[0]["status"]["status"] == "idle"


@pytest.mark.asyncio
async def test_chat_stream_manager_runs_different_sessions_in_parallel() -> None:
    service = BlockingChatService()
    service.prepare("ses-a")
    service.prepare("ses-b")
    manager = ChatStreamManager(service)  # type: ignore[arg-type]
    adapter_a = RecordingAdapter()
    adapter_b = RecordingAdapter()

    await manager.subscribe("ses-a", adapter_a)
    await manager.subscribe("ses-b", adapter_b)
    await manager.start_chat(ChatRequest(session_id="ses-a", message="a", model="fake"))
    await manager.start_chat(ChatRequest(session_id="ses-b", message="b", model="fake"))
    await asyncio.wait_for(service.after_first_send["ses-a"].wait(), timeout=1)
    await asyncio.wait_for(service.after_first_send["ses-b"].wait(), timeout=1)

    status = await manager.status()
    assert status["status"] == "idle"
    assert [item["session_id"] for item in status["running_sessions"]] == ["ses-a", "ses-b"]

    with pytest.raises(ChatStreamAlreadyRunningError):
        await manager.start_chat(ChatRequest(session_id="ses-a", message="again", model="fake"))

    service.release["ses-a"].set()
    service.release["ses-b"].set()
    await asyncio.wait_for(service.finished["ses-a"].wait(), timeout=1)
    await asyncio.wait_for(service.finished["ses-b"].wait(), timeout=1)

    assert [item["action"] for item in adapter_a.sent] == ["stream", "completed"]
    assert [item["action"] for item in adapter_b.sent] == ["stream", "completed"]


@pytest.mark.asyncio
async def test_thread_task_runtime_gate_skips_running_session() -> None:
    service = BlockingChatService()
    service.prepare("ses-a")
    manager = ChatStreamManager(service)  # type: ignore[arg-type]
    runtime = ThreadTaskRuntime()
    manager.set_thread_task_runtime(runtime)

    await manager.start_chat(ChatRequest(session_id="ses-a", message="hello", model="fake"))
    await asyncio.wait_for(service.after_first_send["ses-a"].wait(), timeout=1)

    result = await runtime.continue_if_idle("ses-a")

    assert result["status"] == "skipped"
    assert result["reason"] == "running"
    assert result["chat_status"]["status"] == "running"

    service.release["ses-a"].set()
    await asyncio.wait_for(service.finished["ses-a"].wait(), timeout=1)


@pytest.mark.asyncio
async def test_thread_task_runtime_gate_skips_waiting_approval_session(tmp_path) -> None:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    repositories.sessions.create(
        session_id="ses-approval",
        user_id="local-user",
        scene_id="desktop-agent",
    )
    repositories.command_approvals.create(
        approval_id="approval-1",
        session_id="ses-approval",
        command="pnpm test",
        cwd=".",
        title="是否允许执行命令？",
        details={"command": "pnpm test"},
    )
    service = BlockingChatService()
    service.repositories = repositories
    manager = ChatStreamManager(service)  # type: ignore[arg-type]
    runtime = ThreadTaskRuntime()
    manager.set_thread_task_runtime(runtime)

    result = await runtime.continue_if_idle("ses-approval")

    assert result["status"] == "skipped"
    assert result["reason"] == "waiting_approval"
    assert result["chat_status"]["status"] == "waiting_approval"


@pytest.mark.asyncio
async def test_chat_stream_manager_cancel_interrupts_running_task() -> None:
    service = NeverEndingChatService()
    service.prepare("ses-a")
    manager = ChatStreamManager(service)  # type: ignore[arg-type]

    await manager.start_chat(ChatRequest(session_id="ses-a", message="hello", model="fake"))
    await asyncio.wait_for(service.started["ses-a"].wait(), timeout=1)

    assert await manager.cancel("ses-a") is True
    await asyncio.wait_for(service.cancelled["ses-a"].wait(), timeout=1)
    await asyncio.wait_for(service.finished["ses-a"].wait(), timeout=1)
    assert service.cancellations["ses-a"].is_cancelled() is True

    for _ in range(20):
        if not (await manager.status("ses-a"))["running_sessions"]:
            break
        await asyncio.sleep(0.01)
    assert await manager.status("ses-a") == {
        "session_id": "ses-a",
        "status": "idle",
        "running_sessions": [],
        "waiting_approval_sessions": [],
        "waiting_input_sessions": [],
        "pending_approvals": [],
        "pending_inputs": [],
    }


@pytest.mark.asyncio
async def test_chat_stream_manager_recovers_persisted_run_after_backend_restart(tmp_path) -> None:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    repositories.sessions.create(
        session_id="ses-orphaned",
        user_id="local-user",
        scene_id="desktop-agent",
        status="running",
    )
    queued, _ = repositories.pending_inputs.create_or_get(
        session_id="ses-orphaned",
        message="重启后保留",
        mode="queue",
        client_input_id="restart-queue",
    )
    service = BlockingChatService()
    service.repositories = repositories
    manager = ChatStreamManager(service)  # type: ignore[arg-type]

    recovered = await manager.recover_interrupted_sessions()

    assert recovered == ["ses-orphaned"]
    assert repositories.sessions.get("ses-orphaned").status == "active"
    retained = repositories.pending_inputs.get(queued.id)
    assert retained is not None
    assert retained.paused_at is not None
    assert retained.pause_reason == "backend_restarted"
    assert (await manager.status("ses-orphaned"))["status"] == "idle"


@pytest.mark.asyncio
async def test_chat_stream_manager_does_not_recover_live_in_memory_run(tmp_path) -> None:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    repositories.sessions.create(
        session_id="ses-live",
        user_id="local-user",
        scene_id="desktop-agent",
        status="running",
    )
    service = BlockingChatService()
    service.repositories = repositories
    service.prepare("ses-live")
    manager = ChatStreamManager(service)  # type: ignore[arg-type]
    await manager.start_chat(ChatRequest(session_id="ses-live", message="hello", model="fake"))
    await asyncio.wait_for(service.after_first_send["ses-live"].wait(), timeout=1)

    assert await manager.recover_interrupted_sessions() == []
    assert repositories.sessions.get("ses-live").status == "running"

    service.release["ses-live"].set()
    await asyncio.wait_for(service.finished["ses-live"].wait(), timeout=1)


@pytest.mark.asyncio
async def test_chat_stream_manager_reports_waiting_input_sessions(tmp_path) -> None:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    repositories.sessions.create(
        session_id="ses-a",
        user_id="local-user",
        scene_id="desktop-agent",
        status="waiting_input",
    )
    service = BlockingChatService()
    service.repositories = repositories
    manager = ChatStreamManager(service)  # type: ignore[arg-type]

    status = await manager.status("ses-a")

    assert status["status"] == "waiting_input"
    assert status["running_sessions"] == []
    assert status["waiting_input_sessions"] == [{"session_id": "ses-a"}]


@pytest.mark.asyncio
async def test_chat_stream_manager_running_submit_persists_steer_input(tmp_path) -> None:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    repositories.sessions.create(
        session_id="ses-running",
        user_id="local-user",
        scene_id="desktop-agent",
    )
    service = BlockingChatService()
    service.repositories = repositories
    service.prepare("ses-running")
    manager = ChatStreamManager(service)  # type: ignore[arg-type]
    adapter = RecordingAdapter()
    await manager.subscribe("ses-running", adapter)

    await manager.submit_input(
        ChatRequest(session_id="ses-running", message="第一轮", model="fake")
    )
    await asyncio.wait_for(service.after_first_send["ses-running"].wait(), timeout=1)
    result = await manager.submit_input(
        ChatRequest(
            session_id="ses-running",
            message="运行中补充",
            model="fake",
            delivery_mode="steer",
            client_input_id="client-steer-1",
        )
    )

    assert result["status"] == "pending"
    pending = repositories.pending_inputs.list_active_by_session("ses-running")
    assert len(pending) == 1
    assert pending[0].message == "运行中补充"
    assert pending[0].status == PENDING_INPUT_STATUS_PENDING_STEER
    assert adapter.sent[-1]["action"] == "pending_input_submitted"

    service.release["ses-running"].set()
    await asyncio.wait_for(service.finished["ses-running"].wait(), timeout=1)


@pytest.mark.asyncio
async def test_chat_stream_manager_keeps_explicit_steer_when_queue_already_exists(tmp_path) -> None:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    repositories.sessions.create(
        session_id="ses-mixed",
        user_id="local-user",
        scene_id="desktop-agent",
    )
    service = BlockingChatService()
    service.repositories = repositories
    service.prepare("ses-mixed")
    manager = ChatStreamManager(service)  # type: ignore[arg-type]

    await manager.submit_input(ChatRequest(session_id="ses-mixed", message="第一轮", model="fake"))
    await asyncio.wait_for(service.after_first_send["ses-mixed"].wait(), timeout=1)
    queued = await manager.submit_input(
        ChatRequest(
            session_id="ses-mixed",
            message="先进入队列",
            model="fake",
            delivery_mode="queue",
            client_input_id="mixed-queue",
        )
    )
    steered = await manager.submit_input(
        ChatRequest(
            session_id="ses-mixed",
            message="随后仍然引导当前轮次",
            model="fake",
            delivery_mode="steer",
            client_input_id="mixed-steer",
            attachments=[{"attachment_id": "att-kept-structured"}],
        )
    )

    assert queued["pending_input"]["mode"] == "queue"
    assert steered["pending_input"]["mode"] == "steer"
    assert steered["pending_input"]["attachments"] == [
        {"attachment_id": "att-kept-structured"}
    ]

    assert await manager.cancel("ses-mixed") is True
    for _ in range(100):
        if (await manager.status("ses-mixed"))["status"] == "idle":
            break
        await asyncio.sleep(0.01)
    assert (await manager.status("ses-mixed"))["status"] == "idle"


@pytest.mark.asyncio
async def test_chat_stream_manager_waiting_input_forces_queue(tmp_path) -> None:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    repositories.sessions.create(
        session_id="ses-waiting",
        user_id="local-user",
        scene_id="desktop-agent",
        status="waiting_input",
    )
    service = BlockingChatService()
    service.repositories = repositories
    manager = ChatStreamManager(service)  # type: ignore[arg-type]

    result = await manager.submit_input(
        ChatRequest(
            session_id="ses-waiting",
            message="等待输入时提交",
            model="fake",
            delivery_mode="steer",
            client_input_id="client-queue-1",
        )
    )

    assert result["status"] == "pending"
    pending = repositories.pending_inputs.list_active_by_session("ses-waiting")
    assert len(pending) == 1
    assert pending[0].status == PENDING_INPUT_STATUS_QUEUED
    assert pending[0].mode == "queue"


@pytest.mark.asyncio
async def test_chat_stream_manager_reorders_pending_inputs_with_one_batch_event(tmp_path) -> None:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    repositories.sessions.create(
        session_id="ses-reorder",
        user_id="local-user",
        scene_id="desktop-agent",
    )
    first, _ = repositories.pending_inputs.create_or_get(
        session_id="ses-reorder",
        message="先排队",
        mode="queue",
        client_input_id="manager-reorder-1",
    )
    second, _ = repositories.pending_inputs.create_or_get(
        session_id="ses-reorder",
        message="后排队",
        mode="queue",
        client_input_id="manager-reorder-2",
    )
    service = BlockingChatService()
    service.repositories = repositories
    manager = ChatStreamManager(service)  # type: ignore[arg-type]
    adapter = RecordingAdapter()
    await manager.subscribe("ses-reorder", adapter)

    result = await manager.reorder_pending_inputs(
        session_id="ses-reorder",
        pending_input_ids=[second.id, first.id],
    )

    assert result is not None
    assert [item["id"] for item in result] == [second.id, first.id]
    assert adapter.sent[-1]["action"] == "pending_inputs_reordered"
    assert [
        item["id"] for item in adapter.sent[-1]["data"]["pending_inputs"]
    ] == [second.id, first.id]
    persisted = repositories.message_events.list_by_session("ses-reorder")
    assert persisted[-1].action == "pending_inputs_reordered"


@pytest.mark.asyncio
async def test_chat_stream_manager_cancel_retains_queue_without_auto_drain(tmp_path) -> None:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    repositories.sessions.create(
        session_id="ses-cancel-queue",
        user_id="local-user",
        scene_id="desktop-agent",
    )
    service = NeverEndingChatService()
    service.repositories = repositories
    service.prepare("ses-cancel-queue")
    manager = ChatStreamManager(service)  # type: ignore[arg-type]

    await manager.submit_input(
        ChatRequest(session_id="ses-cancel-queue", message="第一轮", model="fake")
    )
    await asyncio.wait_for(service.started["ses-cancel-queue"].wait(), timeout=1)
    await manager.submit_input(
        ChatRequest(
            session_id="ses-cancel-queue",
            message="取消后保留",
            model="fake",
            delivery_mode="queue",
            client_input_id="client-cancel-retain",
        )
    )

    assert await manager.cancel("ses-cancel-queue") is True
    await asyncio.wait_for(service.finished["ses-cancel-queue"].wait(), timeout=1)

    retained = repositories.pending_inputs.get_by_client_input_id(
        "ses-cancel-queue",
        "client-cancel-retain",
    )
    assert retained is not None
    assert retained.status == PENDING_INPUT_STATUS_QUEUED
    assert retained.paused_at is not None
    assert retained.pause_reason == "user_stopped"
    assert await manager.status("ses-cancel-queue") == {
        "session_id": "ses-cancel-queue",
        "status": "idle",
        "running_sessions": [],
        "waiting_approval_sessions": [],
        "waiting_input_sessions": [],
        "pending_approvals": [],
        "pending_inputs": [retained.to_dict()],
    }


@pytest.mark.asyncio
async def test_chat_stream_manager_resumes_paused_queue_and_starts_next_turn(tmp_path) -> None:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    repositories.sessions.create(
        session_id="ses-resume-queue",
        user_id="local-user",
        scene_id="desktop-agent",
    )
    queued, _ = repositories.pending_inputs.create_or_get(
        session_id="ses-resume-queue",
        message="恢复后发送",
        mode="queue",
        model="fake",
    )
    repositories.pending_inputs.pause_active_for_session("ses-resume-queue")
    service = SequencedBlockingChatService()
    service.repositories = repositories
    manager = ChatStreamManager(service)  # type: ignore[arg-type]
    adapter = RecordingAdapter()
    await manager.subscribe("ses-resume-queue", adapter)

    resumed = await manager.resume_pending_inputs(
        session_id="ses-resume-queue",
        pending_input_id=queued.id,
    )

    assert resumed is not None
    await _wait_for_event_at(service.started, 0)
    assert service.requests[0].message == "恢复后发送"
    assert [
        item["action"] for item in adapter.sent if item["action"].startswith("pending_input_")
    ] == [
        "pending_input_resumed",
        "pending_input_delivered",
    ]
    service.release[0].set()
    await asyncio.wait_for(service.finished[0].wait(), timeout=1)


@pytest.mark.asyncio
async def test_chat_stream_manager_finish_converts_steers_and_drains_queue(tmp_path) -> None:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    repositories.sessions.create(
        session_id="ses-drain",
        user_id="local-user",
        scene_id="desktop-agent",
    )
    service = SequencedBlockingChatService()
    service.repositories = repositories
    manager = ChatStreamManager(service)  # type: ignore[arg-type]
    runtime = RecordingTaskRuntime()
    manager.set_thread_task_runtime(runtime)
    adapter = RecordingAdapter()
    await manager.subscribe("ses-drain", adapter)

    await manager.submit_input(ChatRequest(session_id="ses-drain", message="第一轮", model="fake"))
    await _wait_for_event_at(service.after_first_send, 0)
    steer_result = await manager.submit_input(
        ChatRequest(
            session_id="ses-drain",
            message="未被下一次模型请求消费的引导",
            model="fake",
            delivery_mode="steer",
            client_input_id="client-leftover-steer",
        )
    )
    queue_result = await manager.submit_input(
        ChatRequest(
            session_id="ses-drain",
            message="明确等待队列",
            model="fake",
            delivery_mode="queue",
            client_input_id="client-queued",
        )
    )

    assert steer_result["pending_input"]["status"] == PENDING_INPUT_STATUS_PENDING_STEER
    assert queue_result["pending_input"]["status"] == PENDING_INPUT_STATUS_QUEUED

    service.release[0].set()
    await asyncio.wait_for(service.finished[0].wait(), timeout=1)
    await _wait_for_event_at(service.after_first_send, 1)
    assert runtime.calls == []

    records = {
        record.client_input_id: record
        for record in repositories.pending_inputs.list_active_by_session("ses-drain")
    }
    assert "client-leftover-steer" not in records
    assert records["client-queued"].status == PENDING_INPUT_STATUS_QUEUED
    delivered_steer = repositories.pending_inputs.get_by_client_input_id(
        "ses-drain",
        "client-leftover-steer",
    )
    assert delivered_steer is not None
    assert delivered_steer.status == PENDING_INPUT_STATUS_DELIVERED
    assert service.requests[1].pending_input_id == delivered_steer.id

    service.release[1].set()
    await asyncio.wait_for(service.finished[1].wait(), timeout=1)
    await _wait_for_event_at(service.after_first_send, 2)

    delivered_queue = repositories.pending_inputs.get_by_client_input_id(
        "ses-drain",
        "client-queued",
    )
    assert delivered_queue is not None
    assert delivered_queue.status == PENDING_INPUT_STATUS_DELIVERED
    assert service.requests[2].pending_input_id == delivered_queue.id

    service.release[2].set()
    await asyncio.wait_for(service.finished[2].wait(), timeout=1)


async def _wait_for_event_at(
    events: list[asyncio.Event],
    index: int,
    *,
    timeout: float = 1.0,
) -> None:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while len(events) <= index:
        remaining = deadline - loop.time()
        if remaining <= 0:
            raise TimeoutError(f"event index {index} was not created")
        await asyncio.sleep(min(0.01, remaining))
    await asyncio.wait_for(events[index].wait(), timeout=max(0.01, deadline - loop.time()))
