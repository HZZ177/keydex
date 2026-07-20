from __future__ import annotations

from typing import Any

import pytest
from langchain.agents import create_agent
from langchain.agents.middleware import ToolCallRequest
from langchain.agents.middleware.types import ModelRequest, ModelResponse
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import (
    AIMessage,
    HumanMessage,
    RemoveMessage,
    SystemMessage,
    ToolMessage,
)
from langchain_core.messages.tool import invalid_tool_call
from langchain_core.tools import tool
from langgraph.errors import GraphInterrupt
from langgraph.graph.message import REMOVE_ALL_MESSAGES
from langgraph.types import Interrupt
from pydantic import Field

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
from backend.app.agent.middleware.invalid_tool_call_recovery import (
    InvalidToolCallRecoveryMiddleware,
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


class RecordingToolFriendlyFakeModel(FakeMessagesListChatModel):
    recorded_messages: list[list[Any]] = Field(default_factory=list)

    def bind_tools(
        self,
        tools: list[Any],
        *,
        tool_choice: Any = None,
        **kwargs: Any,
    ) -> Any:
        return self

    def _generate(
        self,
        messages: list[Any],
        stop: list[str] | None = None,
        run_manager: Any = None,
        **kwargs: Any,
    ) -> Any:
        self.recorded_messages.append(list(messages))
        return super()._generate(
            messages,
            stop=stop,
            run_manager=run_manager,
            **kwargs,
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
    assert result.name == "read_file"
    assert "boom" in result.content
    assert "调整参数后重试" in result.content


@pytest.mark.asyncio
async def test_invalid_tool_call_recovery_patches_tool_message_and_retries() -> None:
    middleware = InvalidToolCallRecoveryMiddleware()
    ai_message = AIMessage(content="")
    ai_message.invalid_tool_calls = [
        {"name": "chart", "args": '{"title":', "id": "call_bad"}
    ]

    result = await middleware.aafter_agent(
        {"messages": [HumanMessage(content="画一个图"), ai_message]},
        None,
    )

    assert result is not None
    assert result["jump_to"] == "model"
    messages = result["messages"]
    assert isinstance(messages[0], RemoveMessage)
    assert messages[0].id == REMOVE_ALL_MESSAGES
    patched_ai = messages[2]
    assert isinstance(patched_ai, AIMessage)
    assert patched_ai.invalid_tool_calls == []
    assert patched_ai.tool_calls[0]["id"] == "call_bad"
    assert patched_ai.tool_calls[0]["name"] == "chart"
    tool_message = messages[3]
    assert isinstance(tool_message, ToolMessage)
    assert tool_message.status == "error"
    assert tool_message.tool_call_id == "call_bad"
    assert tool_message.content.startswith(
        InvalidToolCallRecoveryMiddleware.RECOVERY_MESSAGE_PREFIX
    )
    assert "请修正参数后重新发起工具调用" in tool_message.content


@pytest.mark.asyncio
async def test_invalid_tool_call_recovery_closes_mixed_batch_before_model() -> None:
    middleware = InvalidToolCallRecoveryMiddleware()
    ai_message = AIMessage(
        content="继续搜索",
        tool_calls=[
            {
                "name": "search_files",
                "args": {"query": "RevenueService"},
                "id": "call_valid",
                "type": "tool_call",
            }
        ],
        invalid_tool_calls=[
            invalid_tool_call(
                name="grep_files",
                args='{"query":"分摊","include":*.java}',
                id="call_invalid",
                error="invalid JSON",
            )
        ],
    )
    valid_result = ToolMessage(
        content="matched",
        name="search_files",
        tool_call_id="call_valid",
    )

    result = await middleware.abefore_model(
        {
            "messages": [
                HumanMessage(content="查找分摊逻辑"),
                ai_message,
                valid_result,
            ]
        },
        None,
    )

    assert result is not None
    assert "jump_to" not in result
    messages = result["messages"]
    assert isinstance(messages[0], RemoveMessage)
    patched_ai = messages[2]
    assert isinstance(patched_ai, AIMessage)
    assert [call["id"] for call in patched_ai.tool_calls] == [
        "call_valid",
        "call_invalid",
    ]
    assert patched_ai.invalid_tool_calls == []
    assert [message.tool_call_id for message in messages[3:]] == [
        "call_valid",
        "call_invalid",
    ]
    assert messages[4].status == "error"
    assert messages[4].content.startswith(
        InvalidToolCallRecoveryMiddleware.RECOVERY_MESSAGE_PREFIX
    )


@pytest.mark.asyncio
async def test_invalid_tool_call_recovery_repairs_mixed_batch_before_next_llm_call() -> None:
    @tool
    def search_files(query: str) -> str:
        """Search file names for a query."""

        return f"matched:{query}"

    first_response = AIMessage(
        content="继续搜索",
        tool_calls=[
            {
                "name": "search_files",
                "args": {"query": "RevenueService"},
                "id": "call_valid",
                "type": "tool_call",
            }
        ],
        invalid_tool_calls=[
            invalid_tool_call(
                name="grep_files",
                args='{"query":"分摊","include":*.java}',
                id="call_invalid",
                error="invalid JSON",
            )
        ],
    )
    model = RecordingToolFriendlyFakeModel(
        responses=[first_response, AIMessage(content="完成")]
    )
    agent = create_agent(
        model=model,
        tools=[search_files],
        middleware=[InvalidToolCallRecoveryMiddleware()],
    )

    await agent.ainvoke({"messages": [HumanMessage(content="查找分摊逻辑")]})

    assert len(model.recorded_messages) == 2
    second_request_messages = model.recorded_messages[1]
    assistant_index = next(
        index
        for index, message in enumerate(second_request_messages)
        if isinstance(message, AIMessage) and message.tool_calls
    )
    assistant_message = second_request_messages[assistant_index]
    assert [call["id"] for call in assistant_message.tool_calls] == [
        "call_valid",
        "call_invalid",
    ]
    assert assistant_message.invalid_tool_calls == []
    tool_messages = [
        message
        for message in second_request_messages[assistant_index + 1 :]
        if isinstance(message, ToolMessage)
    ]
    assert [message.tool_call_id for message in tool_messages] == [
        "call_valid",
        "call_invalid",
    ]
    assert tool_messages[1].status == "error"


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


@pytest.mark.asyncio
async def test_tool_error_handling_does_not_swallow_graph_interrupts() -> None:
    middleware = ToolErrorHandlingMiddleware()

    async def interrupting_handler(request: ToolCallRequest) -> ToolMessage:
        raise GraphInterrupt((Interrupt(value={"reason": "a2ui"}, id="interrupt-1"),))

    with pytest.raises(GraphInterrupt):
        await middleware.awrap_tool_call(_request(), interrupting_handler)


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


def test_context_compression_keeps_complete_running_steer_batch_in_current_tail() -> None:
    old_user = HumanMessage(content="原始任务")
    steer_frame = SystemMessage(
        content="行进中引导系统框架",
        additional_kwargs={INJECTED_MESSAGE_MARKER: True},
    )
    injected_reference = HumanMessage(
        content="引用上下文",
        additional_kwargs={INJECTED_MESSAGE_MARKER: True},
    )
    first_steer = HumanMessage(
        content="第一条引导",
        additional_kwargs={INJECTED_MESSAGE_MARKER: True},
    )
    second_steer = HumanMessage(
        content="第二条引导",
        additional_kwargs={INJECTED_MESSAGE_MARKER: True},
    )

    source, current_tail = ContextCompressionMiddleware._split_messages_for_blocking_compression(
        [old_user, steer_frame, injected_reference, first_steer, second_steer]
    )

    assert source == [old_user]
    assert current_tail == [steer_frame, injected_reference, first_steer, second_steer]


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
    assert isinstance(messages[1], HumanMessage)
    assert messages[2].content == current_context.content
    assert messages[3].content == current_user.content
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
                        tool_calls=[{"id": "call_1", "name": "list_dir", "args": {}}],
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
                        tool_calls=[{"id": "call_1", "name": "list_dir", "args": {}}],
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
    assert service.message_batches == [["看下现在项目的情况"]]
    messages = result["messages"]
    assert isinstance(messages[1], HumanMessage)
    assert messages[2].content == "我先查看目录"
    assert messages[3].content == tool_result.content
    assert messages[3].tool_call_id == tool_result.tool_call_id
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
                            tool_calls=[
                                {
                                    "id": f"call_{index}",
                                    "name": "read_file",
                                    "args": {},
                                }
                            ],
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
async def test_context_compression_reports_first_materialized_final_request_once(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    session = repositories.sessions.create(
        session_id="ses_final_request",
        user_id="local-user",
        scene_id="desktop-agent",
        title="最终请求诊断",
    )
    events: list[DomainEvent] = []

    async def collect(event: DomainEvent) -> None:
        events.append(event)

    summary = build_context_compression_replacement_messages(
        summary="较早历史摘要",
        boundary_id="boundary-1",
    ).replaced_messages[0]
    state = {
        "context_compression_diagnostics": {
            "boundary_id": "boundary-1",
            "replacement_actual_tokens": 9000,
            "deferred_replay_reserve": 4000,
            "deferred_replay_actual_tokens": 700,
            "deferred_replay_delta_tokens": -3300,
            "materialization_status": "materialized",
        }
    }
    token = set_request_context(
        session_id=session.id,
        active_session_id=session.id,
        trace_id="trace_final_request",
        user_id=session.user_id,
    )
    try:
        middleware = ContextCompressionMiddleware(
            settings=ContextCompressionRuntimeSettings(
                enabled=True,
                context_window_tokens=100_000,
            ),
            repositories=repositories,
            dispatcher=EventDispatcher([collect]),
            checkpointer=object(),
        )

        async def handler(_: ModelRequest) -> ModelResponse:
            return ModelResponse(result=[AIMessage(content="ok")], structured_response=None)

        request = ModelRequest(
            model=object(),
            messages=[summary, HumanMessage(content="近期原始请求")],
            system_message=SystemMessage(content="当前系统上下文"),
            tool_choice=None,
            tools=[],
            response_format=None,
            state=state,
            runtime=None,
            model_settings={},
        )
        await middleware.awrap_model_call(request, handler)
        await middleware.awrap_model_call(request, handler)
    finally:
        reset_request_context(token)

    reports = [
        event.payload
        for event in events
        if event.payload.get("stage") == "compression_final_request"
    ]
    assert len(reports) == 1
    assert reports[0]["boundary_id"] == "boundary-1"
    assert reports[0]["replacement_actual_tokens"] == 9000
    assert reports[0]["deferred_replay_reserve"] == 4000
    assert reports[0]["deferred_replay_actual_tokens"] == 700
    assert reports[0]["system_tool_actual_tokens"] > 0
    assert reports[0]["final_request_actual_tokens"] > 0
    assert reports[0]["provider_hard_window_margin"] > 0


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
