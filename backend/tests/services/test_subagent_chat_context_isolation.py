from __future__ import annotations

import asyncio
from contextvars import ContextVar
from typing import Any

import pytest
from langchain_core.runnables.config import var_child_runnable_config

from backend.app.services import ChatRequest, ChatStreamManager

_active_parent_agent: ContextVar[str] = ContextVar(
    "test_active_parent_agent",
    default="",
)


class ContextRecordingChatService:
    def __init__(self) -> None:
        self.seen_context: dict[str, str] = {}
        self.seen_runnable_config: dict[str, Any] = {}
        self.finished: dict[str, asyncio.Event] = {}

    async def handle_chat(
        self,
        request: ChatRequest,
        *,
        chat_adapter: Any,
        cancellation: Any,
    ) -> None:
        session_id = request.session_id or ""
        self.seen_context[session_id] = _active_parent_agent.get()
        self.seen_runnable_config[session_id] = var_child_runnable_config.get()
        self.finished.setdefault(session_id, asyncio.Event()).set()


@pytest.mark.asyncio
async def test_subagent_chat_does_not_inherit_parent_agent_context() -> None:
    service = ContextRecordingChatService()
    manager = ChatStreamManager(service)  # type: ignore[arg-type]
    lifecycle_finished = asyncio.Event()
    lifecycle_context: list[str] = []

    async def observe_finish(*args: Any, **kwargs: Any) -> None:
        lifecycle_context.append(_active_parent_agent.get())
        lifecycle_finished.set()

    manager.add_run_lifecycle_observer(observe_finish)
    token = _active_parent_agent.set("parent-agent-loop")
    runnable_token = var_child_runnable_config.set(
        {"tags": ["parent-agent-loop"]}
    )
    try:
        await manager.start_chat(
            ChatRequest(
                session_id="child-session",
                message="inspect",
                model="fake",
                subagent_run_id="subagent-run-1",
                subagent_parent_session_id="parent-session",
            )
        )
        await asyncio.wait_for(
            service.finished.setdefault("child-session", asyncio.Event()).wait(),
            timeout=1,
        )
        await asyncio.wait_for(lifecycle_finished.wait(), timeout=1)
    finally:
        var_child_runnable_config.reset(runnable_token)
        _active_parent_agent.reset(token)

    assert service.seen_context["child-session"] == ""
    assert service.seen_runnable_config["child-session"] is None
    assert lifecycle_context == [""]


@pytest.mark.asyncio
async def test_regular_chat_keeps_existing_background_context_contract() -> None:
    service = ContextRecordingChatService()
    manager = ChatStreamManager(service)  # type: ignore[arg-type]
    token = _active_parent_agent.set("websocket-chat")
    runnable_token = var_child_runnable_config.set({"tags": ["websocket-chat"]})
    try:
        await manager.start_chat(
            ChatRequest(
                session_id="main-session",
                message="hello",
                model="fake",
            )
        )
        await asyncio.wait_for(
            service.finished.setdefault("main-session", asyncio.Event()).wait(),
            timeout=1,
        )
    finally:
        var_child_runnable_config.reset(runnable_token)
        _active_parent_agent.reset(token)

    assert service.seen_context["main-session"] == "websocket-chat"
    assert service.seen_runnable_config["main-session"] == {
        "tags": ["websocket-chat"]
    }
