from __future__ import annotations

from typing import Any

import pytest

from backend.app.core.errors import error_envelope
from backend.app.events import (
    ChatProjection,
    DomainEvent,
    DomainEventType,
    PersistenceProjection,
    TurnCompletedAggregator,
)
from backend.app.services import MessageEventService
from backend.app.storage import StorageRepositories, init_database

SESSION_ID = "ses_pipeline"
TRACE_ID = "trace_pipeline"


class RecordingChatAdapter:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send(self, *, session_id: str, action: str, data: dict[str, Any]) -> bool:
        self.sent.append({"session_id": session_id, "action": action, "data": data})
        return True


def _repositories(tmp_path) -> StorageRepositories:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    repositories.sessions.create(
        session_id=SESSION_ID,
        user_id="local-user",
        scene_id="desktop-agent",
    )
    return repositories


def _event(
    event_type: DomainEventType,
    payload: dict[str, Any],
    *,
    timestamp_ms: int = 100,
    run_id: str | None = "run_1",
    turn_index: int = 1,
) -> DomainEvent:
    return DomainEvent(
        event_type=event_type.value,
        source="test",
        payload=payload,
        trace_id=TRACE_ID,
        user_id="local-user",
        original_session_id=SESSION_ID,
        active_session_id=SESSION_ID,
        run_id=run_id,
        turn_index=turn_index,
        timestamp_ms=timestamp_ms,
    )


async def _project_events(
    events: list[DomainEvent],
    *,
    repositories: StorageRepositories,
    chat_adapter: RecordingChatAdapter,
) -> None:
    chat_projection = ChatProjection(chat_adapter)
    persistence_projection = PersistenceProjection(
        repository=repositories.message_events,
        session_id=SESSION_ID,
        turn_index=1,
    )
    for event in events:
        await chat_projection.handle(event)
        await persistence_projection.handle(event)
    await chat_projection.flush()
    await persistence_projection.flush()


async def _aggregate_terminal_payload(
    events: list[DomainEvent],
    *,
    terminal: str,
) -> dict[str, Any]:
    aggregator = TurnCompletedAggregator()
    for event in events:
        await aggregator.handle(event)

    if terminal == "completed":
        return aggregator.build_completed_data(
            session_id=SESSION_ID,
            trace_id=TRACE_ID,
            user_id="local-user",
            scene_id="desktop-agent",
            latest_llm_token_usage={"input_tokens": 3, "output_tokens": 5},
        )
    if terminal == "cancelled":
        return aggregator.build_cancelled_data(
            session_id=SESSION_ID,
            trace_id=TRACE_ID,
            user_id="local-user",
            scene_id="desktop-agent",
            reason="user",
        )
    if terminal == "failed":
        return aggregator.build_failed_data(
            session_id=SESSION_ID,
            trace_id=TRACE_ID,
            user_id="local-user",
            scene_id="desktop-agent",
            error=error_envelope(
                "llm_bad_request",
                "模型请求参数无效",
                details={
                    "status_code": 400,
                    "provider": {
                        "code": "content_anti_probe_blocking",
                        "message": "短消息命中测活探针关键词",
                        "request_id": "req_pipeline_123",
                    },
                },
                status=400,
            ).to_public_dict(),
        )
    raise AssertionError(f"未知终态: {terminal}")


@pytest.mark.asyncio
async def test_realtime_persistence_and_history_keep_completed_sequence(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    chat_adapter = RecordingChatAdapter()
    body_events = [
        _event(DomainEventType.MESSAGE_USER_CREATED, {"content": "读文件"}),
        _event(DomainEventType.LLM_STREAM, {"content": "我来"}, timestamp_ms=101),
        _event(
            DomainEventType.LLM_TOOL_STARTED,
            {"tool": "read_file", "run_id": "tool_1", "params": {"path": "a.py"}},
            timestamp_ms=102,
            run_id="tool_1",
        ),
        _event(
            DomainEventType.LLM_TOOL_FINISHED,
            {"tool": "read_file", "run_id": "tool_1", "result": "content", "duration_ms": 12},
            timestamp_ms=103,
            run_id="tool_1",
        ),
        _event(DomainEventType.LLM_STREAM, {"content": "完成"}, timestamp_ms=104),
    ]
    terminal_payload = await _aggregate_terminal_payload(body_events[1:], terminal="completed")
    events = [
        *body_events,
        _event(DomainEventType.TURN_COMPLETED, terminal_payload, timestamp_ms=105, run_id=None),
    ]

    await _project_events(events, repositories=repositories, chat_adapter=chat_adapter)

    persisted_events = repositories.message_events.list_by_session(SESSION_ID)
    messages = MessageEventService(repositories.message_events).get_display_messages(SESSION_ID)

    assert [item["action"] for item in chat_adapter.sent] == [
        "stream",
        "tool_start",
        "tool_end",
        "stream",
        "completed",
    ]
    assert [event.action for event in persisted_events] == [
        "user_message",
        "stream_batch",
        "tool_start",
        "tool_end",
        "stream_batch",
        "completed",
    ]
    assert [message["role"] for message in messages] == [
        "user",
        "assistant",
        "tool",
        "assistant",
    ]
    assert messages[0]["content"] == "读文件"
    assert messages[1]["content"] == "我来"
    assert messages[2]["status"] == "completed"
    assert messages[2]["toolResult"] == "content"
    assert messages[3]["content"] == "完成"
    assert messages[3]["ghostStats"] == {
        "traceId": TRACE_ID,
        "inputTokens": 3,
        "cacheReadTokens": 0,
        "outputTokens": 5,
    }
    assert [event["action"] for event in terminal_payload["events"]] == [
        "ai_message",
        "tool_start",
        "tool_end",
        "ai_message",
    ]


@pytest.mark.asyncio
async def test_system_messages_project_to_realtime_and_history(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    chat_adapter = RecordingChatAdapter()
    event = _event(
        DomainEventType.MESSAGE_SYSTEM_CREATED,
        {
            "content": "上下文已压缩，后续对话将从压缩分支继续。",
            "compression": {"kind": "context_compressed"},
        },
    )

    await _project_events([event], repositories=repositories, chat_adapter=chat_adapter)

    persisted_events = repositories.message_events.list_by_session(SESSION_ID)
    messages = MessageEventService(repositories.message_events).get_display_messages(SESSION_ID)

    assert [item["action"] for item in chat_adapter.sent] == ["system_message"]
    assert chat_adapter.sent[0]["data"]["content"] == "上下文已压缩，后续对话将从压缩分支继续。"
    assert [event.action for event in persisted_events] == ["system_message"]
    assert messages[0]["role"] == "system"
    assert messages[0]["content"] == "上下文已压缩，后续对话将从压缩分支继续。"


@pytest.mark.asyncio
async def test_context_compression_progress_projects_to_realtime_and_history(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    chat_adapter = RecordingChatAdapter()
    events = [
        _event(
            DomainEventType.MIDDLEWARE_PROGRESS,
            {
                "middleware": "ContextCompressionMiddleware",
                "stage": "compression_started",
                "compression_mode": "context",
                "compression_reason": "automatic",
                "notice_id": "context-compression:trace_pipeline",
                "session_id": SESSION_ID,
                "active_session_id": SESSION_ID,
                "trace_id": TRACE_ID,
            },
            timestamp_ms=101,
        ),
        _event(
            DomainEventType.MIDDLEWARE_PROGRESS,
            {
                "middleware": "ContextCompressionMiddleware",
                "stage": "compression_completed",
                "compression_mode": "context",
                "compression_reason": "automatic",
                "notice_id": "context-compression:trace_pipeline",
                "session_id": SESSION_ID,
                "active_session_id": SESSION_ID,
                "trace_id": TRACE_ID,
            },
            timestamp_ms=102,
        ),
    ]

    await _project_events(events, repositories=repositories, chat_adapter=chat_adapter)

    persisted_events = repositories.message_events.list_by_session(SESSION_ID)
    messages = MessageEventService(repositories.message_events).get_display_messages(SESSION_ID)

    assert [item["action"] for item in chat_adapter.sent] == [
        "middleware_progress",
        "middleware_progress",
    ]
    assert [event.action for event in persisted_events] == [
        "middleware_progress",
        "middleware_progress",
    ]
    assert len(messages) == 1
    assert messages[0]["role"] == "system"
    assert messages[0]["content"] == "上下文压缩已完成"
    assert messages[0]["metadata"]["compression"]["stage"] == "compression_completed"


@pytest.mark.asyncio
async def test_thread_task_turn_markers_project_to_realtime_persistence_and_history(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    chat_adapter = RecordingChatAdapter()
    events = [
        _event(
            DomainEventType.TURN_STARTED,
            {
                "source": "thread_task",
                "source_label": "目标继续执行",
                "thread_task": {
                    "task_id": "task-1",
                    "run_id": "run-1",
                    "trigger": "task_continue",
                    "type": "goal",
                },
            },
            timestamp_ms=101,
            run_id="run-1",
            turn_index=2,
        ),
        _event(
            DomainEventType.THREAD_TASK_STATUS_UPDATED,
            {
                "task_id": "task-1",
                "run_id": "run-1",
                "status": "complete",
                "summary": "目标已完成",
                "payload": {"status": "complete", "summary": "目标已完成"},
                "task": {
                    "id": "task-1",
                    "session_id": SESSION_ID,
                    "type": "goal",
                    "type_label": "目标",
                    "objective": "验证 goal 续跑",
                    "status": "complete",
                },
                "ui_payload": {"task": {"id": "task-1", "type": "goal", "objective": "验证 goal 续跑"}},
            },
            timestamp_ms=102,
            run_id="run-1",
            turn_index=2,
        ),
    ]

    await _project_events(events, repositories=repositories, chat_adapter=chat_adapter)

    persisted_events = repositories.message_events.list_by_session(SESSION_ID)
    messages = MessageEventService(repositories.message_events).get_display_messages(SESSION_ID)

    assert [item["action"] for item in chat_adapter.sent] == ["turn_started", "thread_task_status"]
    assert chat_adapter.sent[0]["data"]["thread_task"]["trigger"] == "task_continue"
    assert chat_adapter.sent[1]["data"]["summary"] == "目标已完成"
    assert [event.action for event in persisted_events] == ["turn_started", "thread_task_status"]
    assert [message["role"] for message in messages] == ["turn", "thread_task"]
    assert messages[0]["metadata"]["source"] == "thread_task"
    assert messages[1]["metadata"]["status"] == "complete"


@pytest.mark.asyncio
async def test_realtime_persistence_and_history_keep_cancelled_sequence(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    chat_adapter = RecordingChatAdapter()
    body_events = [
        _event(DomainEventType.LLM_STREAM, {"content": "半截"}, timestamp_ms=101),
    ]
    terminal_payload = await _aggregate_terminal_payload(body_events, terminal="cancelled")
    events = [
        *body_events,
        _event(DomainEventType.TURN_CANCELLED, terminal_payload, timestamp_ms=102, run_id=None),
    ]

    await _project_events(events, repositories=repositories, chat_adapter=chat_adapter)

    persisted_events = repositories.message_events.list_by_session(SESSION_ID)
    messages = MessageEventService(repositories.message_events).get_display_messages(SESSION_ID)

    assert [item["action"] for item in chat_adapter.sent] == ["stream", "cancelled"]
    assert [event.action for event in persisted_events] == ["stream_batch", "cancelled"]
    assert len(messages) == 2
    assert messages[0]["role"] == "assistant"
    assert messages[0]["content"] == "半截"
    assert isinstance(messages[0]["timestamp"], int)
    assert messages[1]["role"] == "assistant"
    assert messages[1]["content"] == ""
    assert messages[1]["status"] == "cancelled"
    assert messages[1]["cancelled"] is True
    assert isinstance(messages[1]["timestamp"], int)
    assert terminal_payload["status"] == "cancelled"
    assert terminal_payload["final_content"] == "半截"


@pytest.mark.asyncio
async def test_realtime_persistence_and_history_keep_error_sequence(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    chat_adapter = RecordingChatAdapter()
    body_events = [
        _event(DomainEventType.LLM_STREAM, {"content": "准备"}, timestamp_ms=101),
        _event(
            DomainEventType.LLM_TOOL_STARTED,
            {"tool": "shell", "run_id": "tool_1", "params": {"command": "dir"}},
            timestamp_ms=102,
            run_id="tool_1",
        ),
        _event(
            DomainEventType.LLM_TOOL_FAILED,
            {"tool": "shell", "run_id": "tool_1", "error": "权限不足"},
            timestamp_ms=103,
            run_id="tool_1",
        ),
    ]
    terminal_payload = await _aggregate_terminal_payload(body_events, terminal="failed")
    events = [
        *body_events,
        _event(DomainEventType.TURN_FAILED, terminal_payload, timestamp_ms=104, run_id=None),
    ]

    await _project_events(events, repositories=repositories, chat_adapter=chat_adapter)

    persisted_events = repositories.message_events.list_by_session(SESSION_ID)
    messages = MessageEventService(repositories.message_events).get_display_messages(SESSION_ID)

    assert [item["action"] for item in chat_adapter.sent] == [
        "stream",
        "tool_start",
        "tool_end",
        "error",
    ]
    expected_error = terminal_payload["error"]
    assert chat_adapter.sent[-1]["data"]["error"] == expected_error
    assert persisted_events[-1].data["error"] == expected_error
    assert "code" not in chat_adapter.sent[-1]["data"]
    assert "message" not in chat_adapter.sent[-1]["data"]
    assert "details" not in chat_adapter.sent[-1]["data"]
    assert chat_adapter.sent[2]["data"]["error"] == "权限不足"
    assert [event.action for event in persisted_events] == [
        "stream_batch",
        "tool_start",
        "tool_end",
        "error",
    ]
    assert [message["role"] for message in messages] == ["assistant", "tool", "error"]
    assert messages[0]["content"] == "准备"
    assert messages[1]["status"] == "error"
    assert messages[1]["toolError"] == "权限不足"
    assert messages[2]["role"] == "error"
    assert messages[2]["content"] == "模型请求参数无效"
    assert messages[2]["metadata"]["turnError"] == expected_error
    assert messages[2]["traceId"] == TRACE_ID
    assert isinstance(messages[2]["timestamp"], int)
    assert terminal_payload["status"] == "failed"
    assert terminal_payload["final_content"] == "准备"


@pytest.mark.asyncio
async def test_realtime_persistence_and_history_keep_subagent_reasoning_sequence(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    chat_adapter = RecordingChatAdapter()
    events = [
        _event(
            DomainEventType.SUBAGENT_STARTED,
            {"subagent_id": "sub_1", "subagent_name": "worker", "task": "检查"},
            timestamp_ms=101,
        ),
        _event(
            DomainEventType.LLM_STREAM,
            {
                "content": "子输出",
                "is_subagent": True,
                "subagent_id": "sub_1",
                "subagent_name": "worker",
            },
            timestamp_ms=102,
        ),
        _event(
            DomainEventType.LLM_TOOL_STARTED,
            {
                "tool": "search",
                "run_id": "tool_1",
                "params": {"q": "x"},
                "is_subagent": True,
                "subagent_id": "sub_1",
            },
            timestamp_ms=103,
            run_id="tool_1",
        ),
        _event(
            DomainEventType.LLM_TOOL_FINISHED,
            {
                "tool": "search",
                "run_id": "tool_1",
                "result": "ok",
                "is_subagent": True,
                "subagent_id": "sub_1",
            },
            timestamp_ms=104,
            run_id="tool_1",
        ),
        _event(
            DomainEventType.SUBAGENT_FINISHED,
            {"subagent_id": "sub_1"},
            timestamp_ms=105,
        ),
        _event(
            DomainEventType.REASONING_FINISHED,
            {"kind": "initial_response", "text": "观察完成", "cancel_main": False},
            timestamp_ms=106,
        ),
    ]

    await _project_events(events, repositories=repositories, chat_adapter=chat_adapter)

    persisted_events = repositories.message_events.list_by_session(SESSION_ID)
    messages = MessageEventService(repositories.message_events).get_display_messages(SESSION_ID)

    assert [item["action"] for item in chat_adapter.sent] == [
        "subagent_start",
        "stream",
        "tool_start",
        "tool_end",
        "subagent_end",
        "reasoning",
    ]
    assert [event.action for event in persisted_events] == [
        "subagent_start",
        "stream_batch",
        "tool_start",
        "tool_end",
        "subagent_end",
        "reasoning",
    ]
    assert messages[0]["role"] == "subagent"
    assert messages[0]["content"] == "子输出"
    assert messages[0]["subagentName"] == "worker"
    assert messages[0]["subagentToolCalls"][0]["status"] == "completed"
    assert messages[0]["subagentToolCalls"][0]["toolResult"] == "ok"
    assert messages[1]["role"] == "reasoning"
    assert messages[1]["content"] == "观察完成"
    assert messages[1]["reasoningKind"] == "initial_response"
    assert isinstance(messages[1]["timestamp"], int)


@pytest.mark.asyncio
async def test_persistence_keeps_reasoning_stream_between_assistant_batches(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    chat_adapter = RecordingChatAdapter()
    base_time = 1_782_905_000_000
    events = [
        _event(
            DomainEventType.LLM_STREAM,
            {"content": "先给结论。"},
            timestamp_ms=base_time + 1,
        ),
        _event(
            DomainEventType.REASONING_STREAM,
            {"kind": "reasoning", "text": "中途思考", "done": False},
            timestamp_ms=base_time + 2,
        ),
        _event(
            DomainEventType.LLM_STREAM,
            {"content": "继续回答。"},
            timestamp_ms=base_time + 3,
        ),
        _event(
            DomainEventType.REASONING_FINISHED,
            {"kind": "reasoning", "text": "中途思考", "done": True},
            timestamp_ms=base_time + 4,
        ),
    ]

    await _project_events(events, repositories=repositories, chat_adapter=chat_adapter)

    persisted_events = repositories.message_events.list_by_session(SESSION_ID)
    messages = MessageEventService(repositories.message_events).get_display_messages(SESSION_ID)

    assert [event.action for event in persisted_events] == [
        "stream_batch",
        "reasoning",
        "stream_batch",
    ]
    assert [message["role"] for message in messages] == [
        "assistant",
        "reasoning",
        "assistant",
    ]
    assert [message["content"] for message in messages] == [
        "先给结论。",
        "中途思考",
        "继续回答。",
    ]
    assert messages[1]["timestamp"] == base_time + 2
    assert messages[1]["reasoningDurationMs"] == 1
