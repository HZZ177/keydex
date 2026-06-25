from __future__ import annotations

import asyncio
from typing import Any

import pytest

from backend.app.services import (
    ChatRequest,
    ChatStreamAlreadyRunningError,
    ChatStreamManager,
)


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
