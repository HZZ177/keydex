from __future__ import annotations

import pytest
from langchain.agents.middleware import ToolCallRequest
from langchain.agents.middleware.types import ModelRequest, ModelResponse
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

from backend.app.agent.checkpoint import SQLiteCheckpointSaver
from backend.app.agent.middleware.auto_title import AutoTitleMiddleware
from backend.app.agent.middleware.builder import build_default_middleware
from backend.app.agent.middleware.common import (
    DuplicateToolForceStopError,
    ToolCallLimitExceededError,
)
from backend.app.agent.middleware.context_compression import ContextCompressionMiddleware
from backend.app.agent.middleware.duplicate_tool_call_guard import (
    DuplicateToolCallGuardMiddleware,
)
from backend.app.agent.middleware.tool_call_limit import ToolCallLimitMiddleware
from backend.app.agent.middleware.tool_error_handling import ToolErrorHandlingMiddleware
from backend.app.agent.runtime_settings import (
    AgentRuntimeSettings,
    AutoTitleRuntimeSettings,
    ContextCompressionRuntimeSettings,
)
from backend.app.core.request_context import reset_request_context, set_request_context
from backend.app.events import DomainEvent, DomainEventType, EventDispatcher
from backend.app.services.context_compression_service import CompressionGenerationResult
from backend.app.storage import StorageRepositories, init_database


def _repositories(tmp_path) -> StorageRepositories:
    return StorageRepositories(init_database(tmp_path / "app.db"))


def _request() -> ToolCallRequest:
    return ToolCallRequest(
        tool_call={"id": "call_1", "name": "read_file", "args": {"path": "a.txt"}},
        tool=None,
        state={},
        runtime=None,
    )


def _checkpoint(checkpoint_id: str, messages: list) -> dict:
    return {
        "v": 1,
        "id": checkpoint_id,
        "ts": f"2026-06-28T00:00:00+00:00:{checkpoint_id}",
        "channel_values": {"messages": messages},
        "channel_versions": {},
        "versions_seen": {},
    }


@pytest.mark.asyncio
async def test_tool_error_handling_middleware_returns_error_tool_message() -> None:
    middleware = ToolErrorHandlingMiddleware()

    async def failing_handler(request: ToolCallRequest) -> ToolMessage:
        raise RuntimeError("boom")

    result = await middleware.awrap_tool_call(_request(), failing_handler)

    assert isinstance(result, ToolMessage)
    assert result.status == "error"
    assert result.tool_call_id == "call_1"
    assert "boom" in result.content


@pytest.mark.asyncio
async def test_duplicate_tool_call_guard_stops_repeated_same_args() -> None:
    middleware = DuplicateToolCallGuardMiddleware(max_repeats=2)

    async def handler(request: ToolCallRequest) -> ToolMessage:
        return ToolMessage(content="ok", tool_call_id="call_1")

    await middleware.awrap_tool_call(_request(), handler)
    await middleware.awrap_tool_call(_request(), handler)

    with pytest.raises(DuplicateToolForceStopError):
        await middleware.awrap_tool_call(_request(), handler)


@pytest.mark.asyncio
async def test_tool_call_limit_middleware_blocks_calls_after_limit() -> None:
    middleware = ToolCallLimitMiddleware(max_tool_calls=2)

    async def handler(request: ToolCallRequest) -> ToolMessage:
        return ToolMessage(content="ok", tool_call_id="call_1")

    await middleware.awrap_tool_call(_request(), handler)
    await middleware.awrap_tool_call(_request(), handler)

    with pytest.raises(ToolCallLimitExceededError) as exc_info:
        await middleware.awrap_tool_call(_request(), handler)

    assert exc_info.value.max_tool_calls == 2
    assert exc_info.value.attempted_count == 3


@pytest.mark.asyncio
async def test_tool_call_limit_middleware_counts_failed_tool_calls() -> None:
    middleware = ToolCallLimitMiddleware(max_tool_calls=1)

    async def failing_handler(request: ToolCallRequest) -> ToolMessage:
        raise RuntimeError("tool failed")

    with pytest.raises(RuntimeError):
        await middleware.awrap_tool_call(_request(), failing_handler)

    with pytest.raises(ToolCallLimitExceededError) as exc_info:
        await middleware.awrap_tool_call(_request(), failing_handler)

    assert exc_info.value.max_tool_calls == 1
    assert exc_info.value.attempted_count == 2


@pytest.mark.asyncio
async def test_tool_error_handling_does_not_swallow_force_stop_errors() -> None:
    middleware = ToolErrorHandlingMiddleware()

    async def limit_handler(request: ToolCallRequest) -> ToolMessage:
        raise ToolCallLimitExceededError(max_tool_calls=1, attempted_count=2)

    async def duplicate_handler(request: ToolCallRequest) -> ToolMessage:
        raise DuplicateToolForceStopError(tool_name="read_file", repeat_count=4)

    with pytest.raises(ToolCallLimitExceededError):
        await middleware.awrap_tool_call(_request(), limit_handler)

    with pytest.raises(DuplicateToolForceStopError):
        await middleware.awrap_tool_call(_request(), duplicate_handler)


def test_build_default_middleware_honors_auto_title_config(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    disabled = build_default_middleware(
        AgentRuntimeSettings(auto_title={"enabled": False}),
        repositories=repositories,
        dispatcher=EventDispatcher(),
    )
    enabled = build_default_middleware(
        AgentRuntimeSettings(auto_title={"enabled": True}),
        repositories=repositories,
        dispatcher=EventDispatcher(),
    )

    assert not any(isinstance(item, AutoTitleMiddleware) for item in disabled)
    assert any(isinstance(item, AutoTitleMiddleware) for item in enabled)


@pytest.mark.asyncio
async def test_context_compression_before_model_applies_pending_staging(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    session = repositories.sessions.create(
        session_id="ses_staging",
        user_id="local-user",
        scene_id="desktop-agent",
        title="源会话",
    )
    repositories.compression_staging.create(
        original_session_id=session.id,
        active_session_id=session.id,
        target_session_id=session.id,
        generation=1,
        anchor_message_id="h2",
        l1_content="旧历史摘要",
    )
    token = set_request_context(session_id=session.id, active_session_id=session.id)
    try:
        middleware = ContextCompressionMiddleware(
            settings=ContextCompressionRuntimeSettings(
                enabled=True,
                context_window_tokens=100000,
                trigger_fraction=0.5,
                emergency_fraction=0.9,
                retain_rounds=1,
            ),
            repositories=repositories,
            dispatcher=EventDispatcher(),
            checkpointer=object(),
        )
        result = await middleware.abefore_model(
            {
                "messages": [
                    HumanMessage(content="旧问题", id="h1"),
                    AIMessage(content="旧回答", id="a1"),
                    HumanMessage(content="最近问题", id="h2"),
                    AIMessage(content="最近回答", id="a2"),
                ]
            },
            runtime=None,
        )
    finally:
        reset_request_context(token)

    assert result is not None
    messages = result["messages"]
    assert any("旧历史摘要" in str(getattr(message, "content", "")) for message in messages)
    assert [getattr(message, "content", "") for message in messages[-2:]] == [
        "最近问题",
        "最近回答",
    ]
    staging = repositories.compression_staging.get_latest(original_session_id=session.id)
    assert staging.status == "applied"


@pytest.mark.asyncio
async def test_context_compression_before_model_runs_emergency_compression(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    session = repositories.sessions.create(
        session_id="ses_emergency",
        user_id="local-user",
        scene_id="desktop-agent",
        title="源会话",
    )
    service = FakeCompressionService(l1="紧急摘要")
    token = set_request_context(
        session_id=session.id, active_session_id=session.id, trace_id="trace_1"
    )
    try:
        middleware = ContextCompressionMiddleware(
            settings=ContextCompressionRuntimeSettings(
                enabled=True,
                context_window_tokens=1000,
                trigger_fraction=0.1,
                emergency_fraction=0.5,
                retain_rounds=1,
            ),
            repositories=repositories,
            dispatcher=EventDispatcher(),
            checkpointer=object(),
            compression_service=service,
        )
        result = await middleware.abefore_model(
            {
                "messages": [
                    HumanMessage(content="旧问题", id="h1"),
                    AIMessage(content="旧回答", id="a1"),
                    HumanMessage(content="最近问题", id="h2"),
                    AIMessage(
                        content="最近回答",
                        id="a2",
                        usage_metadata={
                            "input_tokens": 700,
                            "output_tokens": 200,
                            "total_tokens": 900,
                        },
                    ),
                ]
            },
            runtime=None,
        )
    finally:
        reset_request_context(token)

    assert result is not None
    messages = result["messages"]
    assert service.calls == ["initial"]
    assert any("紧急摘要" in str(getattr(message, "content", "")) for message in messages)
    assert [getattr(message, "content", "") for message in messages[-2:]] == [
        "最近问题",
        "最近回答",
    ]


@pytest.mark.asyncio
async def test_context_compression_wrap_model_emits_usage_context_window_snapshot(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    session = repositories.sessions.create(
        session_id="ses_window_snapshot",
        user_id="local-user",
        scene_id="desktop-agent",
        title="源会话",
    )
    events: list[DomainEvent] = []

    async def collect(event: DomainEvent) -> None:
        events.append(event)

    token = set_request_context(
        session_id=session.id,
        active_session_id=session.id,
        trace_id="trace_window",
        user_id=session.user_id,
    )
    try:
        middleware = ContextCompressionMiddleware(
            settings=ContextCompressionRuntimeSettings(
                enabled=True,
                context_window_tokens=1000,
                trigger_fraction=0.75,
                emergency_fraction=0.9,
                retain_rounds=1,
            ),
            repositories=repositories,
            dispatcher=EventDispatcher([collect]),
            checkpointer=object(),
        )

        async def handler(_: ModelRequest) -> ModelResponse:
            return ModelResponse(
                result=[
                    AIMessage(
                        content="回答",
                        usage_metadata={
                            "input_tokens": 620,
                            "output_tokens": 80,
                            "total_tokens": 700,
                        },
                    )
                ],
                structured_response=None,
            )

        result = await middleware.awrap_model_call(
            ModelRequest(
                model=object(),
                messages=[HumanMessage(content="需要分析上下文")],
                system_message=None,
                tool_choice=None,
                tools=[],
                response_format=None,
                state={},
                runtime=None,
                model_settings={},
            ),
            handler,
        )
    finally:
        reset_request_context(token)

    assert isinstance(result, ModelResponse)
    snapshots = [
        event.payload
        for event in events
        if event.event_type == DomainEventType.MIDDLEWARE_PROGRESS.value
        and event.payload.get("stage") == "context_window_snapshot"
    ]
    assert len(snapshots) == 1
    assert snapshots[0]["call_phase"] == "after"
    assert snapshots[0]["call_status"] == "completed"
    assert snapshots[0]["token_source"] == "usage_metadata"
    assert snapshots[0]["token_count"] == 700
    assert snapshots[0]["context_window"] == 1000
    assert snapshots[0]["threshold_fraction"] == 0.75
    assert snapshots[0]["threshold_token_count"] == 750
    assert snapshots[0]["threshold_usage_fraction"] == pytest.approx(700 / 750)
    persisted = repositories.sessions.get(session.id)
    assert persisted is not None
    assert persisted.context_window_usage is not None
    assert persisted.context_window_usage["stage"] == "context_window_snapshot"
    assert persisted.context_window_usage["token_source"] == "usage_metadata"
    assert persisted.context_window_usage["token_count"] == 700
    assert persisted.context_window_usage["threshold_usage_fraction"] == pytest.approx(700 / 750)


@pytest.mark.asyncio
async def test_context_compression_wrap_model_skips_snapshot_without_usage_metadata(
    tmp_path,
) -> None:
    repositories = _repositories(tmp_path)
    session = repositories.sessions.create(
        session_id="ses_window_snapshot_without_usage",
        user_id="local-user",
        scene_id="desktop-agent",
        title="源会话",
    )
    events: list[DomainEvent] = []

    async def collect(event: DomainEvent) -> None:
        events.append(event)

    token = set_request_context(
        session_id=session.id,
        active_session_id=session.id,
        trace_id="trace_window_without_usage",
        user_id=session.user_id,
    )
    try:
        middleware = ContextCompressionMiddleware(
            settings=ContextCompressionRuntimeSettings(
                enabled=True,
                context_window_tokens=1000,
                trigger_fraction=0.75,
                emergency_fraction=0.9,
                retain_rounds=1,
            ),
            repositories=repositories,
            dispatcher=EventDispatcher([collect]),
            checkpointer=object(),
        )

        async def handler(_: ModelRequest) -> ModelResponse:
            return ModelResponse(
                result=[AIMessage(content="回答")],
                structured_response=None,
            )

        result = await middleware.awrap_model_call(
            ModelRequest(
                model=object(),
                messages=[HumanMessage(content="需要分析上下文")],
                system_message=None,
                tool_choice=None,
                tools=[],
                response_format=None,
                state={},
                runtime=None,
                model_settings={},
            ),
            handler,
        )
    finally:
        reset_request_context(token)

    assert isinstance(result, ModelResponse)
    snapshots = [
        event.payload
        for event in events
        if event.event_type == DomainEventType.MIDDLEWARE_PROGRESS.value
        and event.payload.get("stage") == "context_window_snapshot"
    ]
    assert snapshots == []
    persisted = repositories.sessions.get(session.id)
    assert persisted is not None
    assert persisted.context_window_usage is None


@pytest.mark.asyncio
async def test_context_compression_after_agent_schedules_background_staging(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    session = repositories.sessions.create(
        session_id="ses_background",
        user_id="local-user",
        scene_id="desktop-agent",
        title="源会话",
    )
    saver = SQLiteCheckpointSaver(repositories.db)
    source_messages = [
        HumanMessage(content="旧问题", id="h1"),
        AIMessage(content="旧回答", id="a1"),
        HumanMessage(content="最近问题", id="h2"),
        AIMessage(content="最近回答", id="a2"),
    ]
    saver.put(
        {"configurable": {"thread_id": session.id, "checkpoint_ns": ""}},
        _checkpoint("ckpt_1", source_messages),
        {},
        {},
    )
    scheduled = []

    def schedule(coro):
        scheduled.append(coro)
        return object()

    token = set_request_context(
        session_id=session.id, active_session_id=session.id, trace_id="trace_bg"
    )
    try:
        middleware = ContextCompressionMiddleware(
            settings=ContextCompressionRuntimeSettings(
                enabled=True,
                context_window_tokens=1000,
                trigger_fraction=0.1,
                emergency_fraction=0.9,
                retain_rounds=1,
            ),
            repositories=repositories,
            dispatcher=EventDispatcher(),
            checkpointer=saver,
            compression_service=FakeCompressionService(l1="后台摘要"),
            schedule_task=schedule,
        )
        await middleware.aafter_agent(
            {
                "messages": [
                    HumanMessage(content="旧问题", id="h1"),
                    AIMessage(content="旧回答", id="a1"),
                    HumanMessage(content="最近问题", id="h2"),
                    AIMessage(
                        content="最近回答",
                        id="a2",
                        usage_metadata={
                            "input_tokens": 700,
                            "output_tokens": 200,
                            "total_tokens": 900,
                        },
                    ),
                ]
            },
            runtime=None,
        )
        assert len(scheduled) == 1
        await scheduled[0]
    finally:
        reset_request_context(token)

    source = repositories.sessions.get(session.id)
    assert source.active_session_id != session.id
    target = repositories.sessions.get(source.active_session_id)
    assert target.status == "active"
    assert target.parent_session_id == session.id
    assert target.source_checkpoint_id == "ckpt_1"
    staging = repositories.compression_staging.get_latest(
        original_session_id=session.id,
        status="pending",
        target_session_id=target.id,
    )
    assert staging is not None
    assert staging.anchor_message_id == "h2"
    assert staging.l1_content == "后台摘要"
    cloned = saver.get_tuple(
        {
            "configurable": {
                "thread_id": target.id,
                "checkpoint_ns": "",
                "checkpoint_id": "ckpt_1",
            }
        }
    )
    assert cloned is not None


@pytest.mark.asyncio
async def test_auto_title_middleware_schedules_background_title_update(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    session = repositories.sessions.create(
        session_id="ses_auto_title",
        user_id="local-user",
        scene_id="desktop-agent",
        title="默认标题",
    )
    events: list[DomainEvent] = []
    scheduled = []

    async def collect(event: DomainEvent) -> None:
        events.append(event)

    def schedule(coro):
        scheduled.append(coro)
        return object()

    token = set_request_context(
        session_id=session.id,
        active_session_id=session.id,
        user_id=session.user_id,
    )
    try:
        middleware = AutoTitleMiddleware(
            settings=AutoTitleRuntimeSettings(enabled=True),
            repositories=repositories,
            dispatcher=EventDispatcher([collect]),
            title_service=FakeTitleService(repositories, title="自动标题"),
            schedule_task=schedule,
        )

        await middleware.aafter_agent(
            {"messages": [HumanMessage(content="问题"), AIMessage(content="回答")]},
            runtime=None,
        )
        assert len(scheduled) == 1
        await scheduled[0]
    finally:
        reset_request_context(token)

    assert len(events) == 1
    assert events[0].event_type == DomainEventType.SESSION_TITLE_UPDATED.value
    assert events[0].payload["title"] == "自动标题"
    assert events[0].payload["session"]["title_source"] == "auto"


@pytest.mark.asyncio
async def test_auto_title_middleware_skips_when_disabled(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    session = repositories.sessions.create(
        session_id="ses_disabled_title",
        user_id="local-user",
        scene_id="desktop-agent",
        title="默认标题",
    )
    scheduled = []
    token = set_request_context(session_id=session.id, active_session_id=session.id)
    try:
        middleware = AutoTitleMiddleware(
            settings=AutoTitleRuntimeSettings(enabled=False),
            repositories=repositories,
            dispatcher=EventDispatcher(),
            title_service=FakeTitleService(repositories, title="不应生成"),
            schedule_task=lambda coro: scheduled.append(coro),
        )

        await middleware.aafter_agent(
            {"messages": [HumanMessage(content="问题"), AIMessage(content="回答")]},
            runtime=None,
        )
    finally:
        reset_request_context(token)

    assert scheduled == []


@pytest.mark.asyncio
async def test_auto_title_middleware_isolates_background_failure(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    session = repositories.sessions.create(
        session_id="ses_title_failure",
        user_id="local-user",
        scene_id="desktop-agent",
        title="默认标题",
    )
    scheduled = []

    def schedule(coro):
        scheduled.append(coro)
        return object()

    token = set_request_context(session_id=session.id, active_session_id=session.id)
    try:
        middleware = AutoTitleMiddleware(
            settings=AutoTitleRuntimeSettings(enabled=True),
            repositories=repositories,
            dispatcher=EventDispatcher(),
            title_service=FailingTitleService(),
            schedule_task=schedule,
        )

        await middleware.aafter_agent(
            {"messages": [HumanMessage(content="问题"), AIMessage(content="回答")]},
            runtime=None,
        )
        assert len(scheduled) == 1
        await scheduled[0]
    finally:
        reset_request_context(token)

    assert repositories.sessions.get(session.id).title == "默认标题"


class FakeTitleService:
    def __init__(self, repositories: StorageRepositories, *, title: str) -> None:
        self.repositories = repositories
        self.title = title

    async def generate_and_update_session_title(self, *, session_id, messages, settings):
        return self.repositories.sessions.update_title_if_auto_allowed(
            session_id,
            title=self.title,
            only_when_default_title=settings.only_when_default_title,
        )


class FailingTitleService:
    async def generate_and_update_session_title(self, *, session_id, messages, settings):
        raise RuntimeError("title failure")


class FakeCompressionService:
    def __init__(self, *, l1: str, l2: str | None = None) -> None:
        self.l1 = l1
        self.l2 = l2
        self.calls: list[str] = []

    async def generate_compression_result(self, *, material):
        self.calls.append(material.phase)
        return CompressionGenerationResult(
            success=True,
            phase=material.phase,
            new_l1_content=self.l1,
            new_l2_content=self.l2,
        )
