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
        "pending_approvals": [],
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
                "pending_approvals": [],
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
        "pending_approvals": [],
    }
