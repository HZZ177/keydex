from __future__ import annotations

import pytest
from langchain.agents.middleware import ToolCallRequest
from langchain.agents.middleware.types import ModelRequest, ModelResponse
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage

from backend.app.agent.context_compression_utils import (
    build_context_compression_replacement_messages,
)
from backend.app.agent.middleware import context_compression as context_compression_module
from backend.app.agent.middleware.auto_title import AutoTitleMiddleware
from backend.app.agent.middleware.builder import build_default_middleware
from backend.app.agent.middleware.common import DuplicateToolForceStopError
from backend.app.agent.middleware.context_compression import (
    CURRENT_TURN_MESSAGE_MARKER,
    INJECTED_MESSAGE_MARKER,
    ContextCompressionMiddleware,
)
from backend.app.agent.middleware.duplicate_tool_call_guard import (
    DuplicateToolCallGuardMiddleware,
)
from backend.app.agent.middleware.tool_error_handling import ToolErrorHandlingMiddleware
from backend.app.agent.runtime_settings import (
    AgentRuntimeSettings,
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
async def test_tool_error_handling_does_not_swallow_force_stop_errors() -> None:
    middleware = ToolErrorHandlingMiddleware()

    async def duplicate_handler(request: ToolCallRequest) -> ToolMessage:
        raise DuplicateToolForceStopError(tool_name="read_file", repeat_count=4)

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
async def test_context_compression_before_model_runs_blocking_compression(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    session = repositories.sessions.create(
        session_id="ses_compress",
        user_id="local-user",
        scene_id="desktop-agent",
        title="源会话",
    )
    events: list[DomainEvent] = []

    async def collect(event: DomainEvent) -> None:
        events.append(event)

    service = FakeCompressionService(summary="阻塞式摘要")
    current_context = SystemMessage(
        content="当前轮引用上下文",
        additional_kwargs={INJECTED_MESSAGE_MARKER: True},
    )
    current_user = HumanMessage(
        content="当前问题",
        id="h_current",
        additional_kwargs={CURRENT_TURN_MESSAGE_MARKER: True},
    )
    token = set_request_context(
        session_id=session.id, active_session_id=session.id, trace_id="trace_1"
    )
    try:
        middleware = ContextCompressionMiddleware(
            settings=ContextCompressionRuntimeSettings(
                enabled=True,
                context_window_tokens=1000,
                trigger_fraction=0.1,
            ),
            repositories=repositories,
            dispatcher=EventDispatcher([collect]),
            checkpointer=object(),
            compression_service=service,
        )
        result = await middleware.abefore_model(
            {
                "messages": [
                    HumanMessage(content="旧问题", id="h1"),
                    AIMessage(
                        content="最近回答",
                        id="a1",
                        usage_metadata={
                            "input_tokens": 700,
                            "output_tokens": 200,
                            "total_tokens": 900,
                        },
                    ),
                    current_context,
                    current_user,
                ]
            },
            runtime=None,
        )
    finally:
        reset_request_context(token)

    assert result is not None
    messages = result["messages"]
    assert isinstance(messages[1], SystemMessage)
    assert messages[2] is current_context
    assert messages[3] is current_user
    assert "阻塞式摘要" in str(messages[1].content)
    assert "当前问题" not in str(messages[1].content)
    assert service.calls == ["automatic"]
    assert service.message_batches == [["旧问题", "最近回答"]]
    stages = [event.payload["stage"] for event in events]
    assert "compression_started" in stages
    assert "compression_completed" in stages
    compression_notice_ids = {
        event.payload["notice_id"]
        for event in events
        if event.payload["stage"] in {"compression_started", "compression_completed"}
    }
    assert len(compression_notice_ids) == 1
    assert next(iter(compression_notice_ids)).startswith("context-compression:trace_1:")
    assert repositories.sessions.get(session.id).context_compression_epoch == 1


@pytest.mark.asyncio
async def test_context_compression_before_model_skips_when_only_current_turn_exists(
    tmp_path,
) -> None:
    repositories = _repositories(tmp_path)
    session = repositories.sessions.create(
        session_id="ses_current_only",
        user_id="local-user",
        scene_id="desktop-agent",
        title="源会话",
    )
    events: list[DomainEvent] = []

    async def collect(event: DomainEvent) -> None:
        events.append(event)

    service = FakeCompressionService(summary="不应调用")
    token = set_request_context(
        session_id=session.id, active_session_id=session.id, trace_id="trace_current_only"
    )
    try:
        middleware = ContextCompressionMiddleware(
            settings=ContextCompressionRuntimeSettings(
                enabled=True,
                context_window_tokens=1000,
                trigger_fraction=0.1,
            ),
            repositories=repositories,
            dispatcher=EventDispatcher([collect]),
            checkpointer=object(),
            compression_service=service,
        )
        result = await middleware.abefore_model(
            {
                "messages": [
                    HumanMessage(
                        content="当前问题很长，足以超过人为调低的阈值" * 80,
                        additional_kwargs={CURRENT_TURN_MESSAGE_MARKER: True},
                    )
                ]
            },
            runtime=None,
        )
    finally:
        reset_request_context(token)

    assert result is None
    assert service.calls == []
    stages = [event.payload["stage"] for event in events]
    assert "compression_started" not in stages
    assert "compression_completed" not in stages
    snapshots = [
        event.payload for event in events if event.payload["stage"] == "context_window_snapshot"
    ]
    assert snapshots[0]["compression_message_count"] == 0
    assert snapshots[0]["retain_message_count"] == 1


@pytest.mark.asyncio
async def test_context_compression_before_model_skips_below_threshold(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    session = repositories.sessions.create(
        session_id="ses_skip",
        user_id="local-user",
        scene_id="desktop-agent",
        title="源会话",
    )
    service = FakeCompressionService(summary="不应调用")
    token = set_request_context(session_id=session.id, active_session_id=session.id)
    try:
        middleware = ContextCompressionMiddleware(
            settings=ContextCompressionRuntimeSettings(
                enabled=True,
                context_window_tokens=1000,
                trigger_fraction=0.9,
            ),
            repositories=repositories,
            dispatcher=EventDispatcher(),
            checkpointer=object(),
            compression_service=service,
        )
        result = await middleware.abefore_model(
            {"messages": [HumanMessage(content="短消息", id="h1")]},
            runtime=None,
        )
    finally:
        reset_request_context(token)

    assert result is None
    assert service.calls == []


@pytest.mark.asyncio
async def test_context_compression_before_model_adds_pending_estimate_to_latest_real_usage(
    tmp_path,
    monkeypatch,
) -> None:
    repositories = _repositories(tmp_path)
    session = repositories.sessions.create(
        session_id="ses_pending_estimate",
        user_id="local-user",
        scene_id="desktop-agent",
        title="预测窗口",
    )
    events: list[DomainEvent] = []

    async def collect(event: DomainEvent) -> None:
        events.append(event)

    def fake_count_tokens(*, messages, **_kwargs) -> int:
        return sum(len(str(getattr(message, "content", "") or "")) for message in messages)

    monkeypatch.setattr(
        context_compression_module,
        "count_tokens_approximately",
        fake_count_tokens,
    )
    service = FakeCompressionService(summary="压缩摘要")
    token = set_request_context(
        session_id=session.id,
        active_session_id=session.id,
        trace_id="trace_pending_estimate",
    )
    try:
        middleware = ContextCompressionMiddleware(
            settings=ContextCompressionRuntimeSettings(
                enabled=True,
                context_window_tokens=1000,
                trigger_fraction=0.75,
            ),
            repositories=repositories,
            dispatcher=EventDispatcher([collect]),
            checkpointer=object(),
            compression_service=service,
        )
        result = await middleware.abefore_model(
            {
                "messages": [
                    HumanMessage(content="旧问题", id="h1"),
                    AIMessage(
                        content="旧回答",
                        id="a1",
                        usage_metadata={
                            "input_tokens": 620,
                            "output_tokens": 80,
                            "total_tokens": 700,
                        },
                    ),
                    HumanMessage(
                        content="x" * 60,
                        id="h_current",
                        additional_kwargs={CURRENT_TURN_MESSAGE_MARKER: True},
                    ),
                ]
            },
            runtime=None,
        )
    finally:
        reset_request_context(token)

    assert result is not None
    assert service.calls == ["automatic"]
    assert service.message_batches == [["旧问题", "旧回答"]]
    snapshots = [
        event.payload for event in events if event.payload["stage"] == "context_window_snapshot"
    ]
    assert len(snapshots) == 1
    assert snapshots[0]["call_phase"] == "before"
    assert snapshots[0]["token_source"] == "usage_metadata_plus_pending_estimate"
    assert snapshots[0]["usage_source"] == "message_usage_metadata"
    assert snapshots[0]["usage_token_count"] == 700
    assert snapshots[0]["estimated_pending_token_count"] == 60
    assert snapshots[0]["pending_message_count"] == 1
    assert snapshots[0]["token_count"] == 760


@pytest.mark.asyncio
async def test_context_compression_before_model_estimates_only_after_latest_usage(
    tmp_path,
    monkeypatch,
) -> None:
    repositories = _repositories(tmp_path)
    session = repositories.sessions.create(
        session_id="ses_followup_estimate",
        user_id="local-user",
        scene_id="desktop-agent",
        title="同轮续采样",
    )
    events: list[DomainEvent] = []

    async def collect(event: DomainEvent) -> None:
        events.append(event)

    def fake_count_tokens(*, messages, **_kwargs) -> int:
        return sum(len(str(getattr(message, "content", "") or "")) for message in messages)

    monkeypatch.setattr(
        context_compression_module,
        "count_tokens_approximately",
        fake_count_tokens,
    )
    service = FakeCompressionService(summary="不应调用")
    token = set_request_context(
        session_id=session.id,
        active_session_id=session.id,
        trace_id="trace_followup_estimate",
    )
    try:
        middleware = ContextCompressionMiddleware(
            settings=ContextCompressionRuntimeSettings(
                enabled=True,
                context_window_tokens=1000,
                trigger_fraction=0.95,
            ),
            repositories=repositories,
            dispatcher=EventDispatcher([collect]),
            checkpointer=object(),
            compression_service=service,
        )
        result = await middleware.abefore_model(
            {
                "messages": [
                    HumanMessage(content="旧问题", id="h1"),
                    AIMessage(
                        content="旧回答",
                        id="a1",
                        usage_metadata={
                            "input_tokens": 620,
                            "output_tokens": 80,
                            "total_tokens": 700,
                        },
                    ),
                    HumanMessage(
                        content="x" * 100,
                        id="h_current",
                        additional_kwargs={CURRENT_TURN_MESSAGE_MARKER: True},
                    ),
                    AIMessage(
                        content="调用工具",
                        id="a_tool",
                        usage_metadata={
                            "input_tokens": 720,
                            "output_tokens": 40,
                            "total_tokens": 760,
                        },
                    ),
                    ToolMessage(content="y" * 20, tool_call_id="call_1"),
                ]
            },
            runtime=None,
        )
    finally:
        reset_request_context(token)

    assert result is None
    assert service.calls == []
    snapshots = [
        event.payload for event in events if event.payload["stage"] == "context_window_snapshot"
    ]
    assert len(snapshots) == 1
    assert snapshots[0]["usage_token_count"] == 760
    assert snapshots[0]["estimated_pending_token_count"] == 20
    assert snapshots[0]["pending_message_count"] == 1
    assert snapshots[0]["token_count"] == 780


@pytest.mark.asyncio
async def test_context_compression_before_model_compresses_current_turn_after_tool_call(
    tmp_path,
    monkeypatch,
) -> None:
    repositories = _repositories(tmp_path)
    session = repositories.sessions.create(
        session_id="ses_mid_turn_compress",
        user_id="local-user",
        scene_id="desktop-agent",
        title="工具后续采样",
    )

    def fake_count_tokens(*, messages, **_kwargs) -> int:
        return sum(len(str(getattr(message, "content", "") or "")) for message in messages)

    monkeypatch.setattr(
        context_compression_module,
        "count_tokens_approximately",
        fake_count_tokens,
    )
    service = FakeCompressionService(summary="当前轮工具结果摘要")
    current_user = HumanMessage(
        content="看下现在项目的情况",
        id="h_current",
        additional_kwargs={CURRENT_TURN_MESSAGE_MARKER: True},
    )
    tool_result = ToolMessage(content="y" * 80, tool_call_id="call_1")
    token = set_request_context(
        session_id=session.id,
        active_session_id=session.id,
        trace_id="trace_mid_turn_compress",
    )
    try:
        middleware = ContextCompressionMiddleware(
            settings=ContextCompressionRuntimeSettings(
                enabled=True,
                context_window_tokens=1000,
                trigger_fraction=0.75,
            ),
            repositories=repositories,
            dispatcher=EventDispatcher(),
            checkpointer=object(),
            compression_service=service,
        )
        result = await middleware.abefore_model(
            {
                "messages": [
                    current_user,
                    AIMessage(
                        content="我先查看目录",
                        id="a_tool",
                        usage_metadata={
                            "input_tokens": 720,
                            "output_tokens": 40,
                            "total_tokens": 760,
                        },
                    ),
                    tool_result,
                ]
            },
            runtime=None,
        )
    finally:
        reset_request_context(token)

    assert result is not None
    assert service.calls == ["automatic"]
    assert service.message_batches == [["看下现在项目的情况", "我先查看目录", "y" * 80]]
    messages = result["messages"]
    assert isinstance(messages[1], SystemMessage)
    assert messages[2] is current_user
    assert tool_result not in messages
    assert "当前轮工具结果摘要" in str(messages[1].content)


@pytest.mark.asyncio
async def test_context_compression_before_model_uses_distinct_notice_per_operation(
    tmp_path,
    monkeypatch,
) -> None:
    repositories = _repositories(tmp_path)
    session = repositories.sessions.create(
        session_id="ses_multi_compress_notice",
        user_id="local-user",
        scene_id="desktop-agent",
        title="同轮多次压缩",
    )
    events: list[DomainEvent] = []

    async def collect(event: DomainEvent) -> None:
        events.append(event)

    def fake_count_tokens(*, messages, **_kwargs) -> int:
        return sum(len(str(getattr(message, "content", "") or "")) for message in messages)

    monkeypatch.setattr(
        context_compression_module,
        "count_tokens_approximately",
        fake_count_tokens,
    )
    service = FakeCompressionService(summary="压缩摘要")
    token = set_request_context(
        session_id=session.id,
        active_session_id=session.id,
        trace_id="trace_multi_compress",
    )
    try:
        middleware = ContextCompressionMiddleware(
            settings=ContextCompressionRuntimeSettings(
                enabled=True,
                context_window_tokens=1000,
                trigger_fraction=0.75,
            ),
            repositories=repositories,
            dispatcher=EventDispatcher([collect]),
            checkpointer=object(),
            compression_service=service,
        )
        for index in range(2):
            result = await middleware.abefore_model(
                {
                    "messages": [
                        HumanMessage(
                            content=f"当前请求 {index}",
                            id=f"h_current_{index}",
                            additional_kwargs={CURRENT_TURN_MESSAGE_MARKER: True},
                        ),
                        AIMessage(
                            content="读取工具结果",
                            id=f"a_tool_{index}",
                            usage_metadata={
                                "input_tokens": 720,
                                "output_tokens": 40,
                                "total_tokens": 760,
                            },
                        ),
                        ToolMessage(content="y" * 80, tool_call_id=f"call_{index}"),
                    ]
                },
                runtime=None,
            )
            assert result is not None
    finally:
        reset_request_context(token)

    progress_events = [
        event.payload
        for event in events
        if event.payload["stage"] in {"compression_started", "compression_completed"}
    ]
    assert [event["stage"] for event in progress_events] == [
        "compression_started",
        "compression_completed",
        "compression_started",
        "compression_completed",
    ]
    first_notice_id = progress_events[0]["notice_id"]
    second_notice_id = progress_events[2]["notice_id"]
    assert progress_events[1]["notice_id"] == first_notice_id
    assert progress_events[3]["notice_id"] == second_notice_id
    assert first_notice_id != second_notice_id
    assert first_notice_id.startswith("context-compression:trace_multi_compress:")
    assert second_notice_id.startswith("context-compression:trace_multi_compress:")


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
async def test_context_compression_after_agent_is_noop(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    middleware = ContextCompressionMiddleware(
        settings=ContextCompressionRuntimeSettings(enabled=True),
        repositories=repositories,
        dispatcher=EventDispatcher(),
        checkpointer=object(),
    )

    assert await middleware.aafter_agent({"messages": [HumanMessage(content="x")]}, None) is None


class FakeCompressionService:
    def __init__(self, *, summary: str) -> None:
        self.summary = summary
        self.calls: list[str] = []
        self.message_batches: list[list[str]] = []

    async def generate_compression_result(self, *, session, messages, reason, **_kwargs):
        self.calls.append(reason)
        self.message_batches.append([str(message.content) for message in messages])
        replacement = build_context_compression_replacement_messages(
            summary=self.summary,
            source_messages=messages,
        )
        return CompressionGenerationResult(
            success=True,
            reason=reason,
            summary=self.summary,
            replacement_messages=replacement.replaced_messages,
            compression_message_count=len(messages),
            total_message_count=len(messages),
        )
