from __future__ import annotations

from typing import Any

import pytest

from backend.app.events import ChatProjection, DomainEvent, DomainEventType


class RecordingChatAdapter:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send(self, *, session_id: str, action: str, data: dict[str, Any]) -> bool:
        self.sent.append({"session_id": session_id, "action": action, "data": data})
        return True


def _event(event_type: DomainEventType, payload: dict[str, Any]) -> DomainEvent:
    return DomainEvent(
        event_type=event_type.value,
        source="test",
        payload=payload,
        trace_id="trace_1",
        original_session_id="ses_original",
        active_session_id="ses_active",
        turn_index=1,
    )


@pytest.mark.asyncio
async def test_chat_projection_maps_llm_stream_to_stream_action() -> None:
    adapter = RecordingChatAdapter()
    projection = ChatProjection(adapter)

    await projection.handle(_event(DomainEventType.LLM_STREAM, {"content": "hello"}))

    assert adapter.sent[0]["session_id"] == "ses_original"
    assert adapter.sent[0]["action"] == "stream"
    assert adapter.sent[0]["data"]["content"] == "hello"
    assert adapter.sent[0]["data"]["session_id"] == "ses_original"
    assert isinstance(adapter.sent[0]["data"]["timestamp_ms"], int)


@pytest.mark.asyncio
async def test_chat_projection_maps_first_token_signal_without_waiting_for_content() -> None:
    adapter = RecordingChatAdapter()
    projection = ChatProjection(adapter)

    await projection.handle(
        _event(
            DomainEventType.LLM_FIRST_TOKEN_RECEIVED,
            {"first_token_at_ms": 1_782_905_000_000},
        )
    )

    assert adapter.sent[0]["action"] == "llm_first_token"
    assert adapter.sent[0]["data"]["first_token_at_ms"] == 1_782_905_000_000


@pytest.mark.asyncio
async def test_chat_projection_maps_thread_task_events_to_task_actions() -> None:
    adapter = RecordingChatAdapter()
    projection = ChatProjection(adapter)

    await projection.handle(
        _event(
            DomainEventType.THREAD_TASK_UPDATED,
            {"task_id": "task-1", "task": {"id": "task-1", "status": "active"}},
        )
    )
    await projection.handle(
        _event(
            DomainEventType.THREAD_TASK_DELETED,
            {"task_id": "task-1", "task": {"id": "task-1", "deleted_at": "now"}},
        )
    )
    await projection.handle(
        _event(
            DomainEventType.THREAD_TASK_RUN_STARTED,
            {"task_id": "task-1", "run_id": "run-1", "run": {"status": "running"}},
        )
    )
    await projection.handle(
        _event(
            DomainEventType.THREAD_TASK_RUN_FINISHED,
            {"task_id": "task-1", "run_id": "run-1", "run": {"status": "succeeded"}},
        )
    )
    await projection.handle(
        _event(
            DomainEventType.THREAD_TASK_STATUS_UPDATED,
            {
                "task_id": "task-1",
                "run_id": "run-1",
                "status": "complete",
                "summary": "目标已完成",
            },
        )
    )

    assert [item["action"] for item in adapter.sent] == [
        "task_updated",
        "task_deleted",
        "task_run_started",
        "task_run_finished",
        "thread_task_status",
    ]
    assert adapter.sent[0]["data"]["task"]["status"] == "active"
    assert adapter.sent[1]["data"]["task"]["deleted_at"] == "now"
    assert adapter.sent[2]["data"]["run"]["status"] == "running"
    assert adapter.sent[3]["data"]["run_id"] == "run-1"
    assert adapter.sent[4]["data"]["summary"] == "目标已完成"


@pytest.mark.asyncio
async def test_chat_projection_maps_pending_input_events_to_pending_actions() -> None:
    adapter = RecordingChatAdapter()
    projection = ChatProjection(adapter)

    for event_type in (
        DomainEventType.PENDING_INPUT_SUBMITTED,
        DomainEventType.PENDING_INPUT_UPDATED,
        DomainEventType.PENDING_INPUT_CANCELLED,
        DomainEventType.PENDING_INPUT_DELIVERED,
        DomainEventType.PENDING_INPUT_CONVERTED,
        DomainEventType.PENDING_INPUT_PAUSED,
        DomainEventType.PENDING_INPUT_RESUMED,
        DomainEventType.PENDING_INPUT_FAILED,
    ):
        await projection.handle(
            _event(
                event_type,
                {
                    "pending_input_id": "pending-1",
                    "pending_input": {"id": "pending-1", "message": "待发送"},
                },
            )
        )

    assert [item["action"] for item in adapter.sent] == [
        "pending_input_submitted",
        "pending_input_updated",
        "pending_input_cancelled",
        "pending_input_delivered",
        "pending_input_converted",
        "pending_input_paused",
        "pending_input_resumed",
        "pending_input_failed",
    ]
    assert all(item["data"]["pending_input_id"] == "pending-1" for item in adapter.sent)


@pytest.mark.asyncio
async def test_chat_projection_maps_turn_started_to_realtime_turn_marker() -> None:
    adapter = RecordingChatAdapter()
    projection = ChatProjection(adapter)

    await projection.handle(
        _event(
            DomainEventType.TURN_STARTED,
            {
                "source": "thread_task",
                "source_label": "目标继续执行",
                "thread_task": {"trigger": "task_continue", "type": "goal", "task_id": "task-1"},
            },
        )
    )

    assert adapter.sent[0]["action"] == "turn_started"
    assert adapter.sent[0]["data"]["source"] == "thread_task"
    assert adapter.sent[0]["data"]["source_label"] == "目标继续执行"
    assert adapter.sent[0]["data"]["turn_index"] == 1
    assert adapter.sent[0]["data"]["trace_id"] == "trace_1"


@pytest.mark.asyncio
async def test_chat_projection_maps_tool_lifecycle_to_tool_actions() -> None:
    adapter = RecordingChatAdapter()
    projection = ChatProjection(adapter)

    await projection.handle(
        _event(
            DomainEventType.LLM_TOOL_STARTED,
            {"tool": "read_file", "run_id": "run_1", "params": {"path": "a.py"}},
        )
    )
    await projection.handle(
        _event(
            DomainEventType.LLM_TOOL_PROGRESS,
            {
                "tool": "apply_patch",
                "run_id": "call_1",
                "tool_call_id": "call_1",
                "files": [{"path": "a.py", "added_lines": 1, "deleted_lines": 0}],
                "status": "running",
            },
        )
    )
    await projection.handle(
        _event(
            DomainEventType.LLM_TOOL_FINISHED,
            {"tool": "read_file", "run_id": "run_1", "result": "ok"},
        )
    )
    await projection.handle(
        _event(
            DomainEventType.LLM_TOOL_FAILED,
            {"tool": "shell", "run_id": "run_2", "error": "failed"},
        )
    )

    assert [item["action"] for item in adapter.sent] == [
        "tool_start",
        "tool_progress",
        "tool_end",
        "tool_end",
    ]
    assert adapter.sent[1]["data"]["files"][0]["path"] == "a.py"
    assert adapter.sent[3]["data"]["error"] == "failed"


@pytest.mark.asyncio
async def test_chat_projection_maps_a2ui_realtime_events() -> None:
    adapter = RecordingChatAdapter()
    projection = ChatProjection(adapter)

    await projection.handle(
        _event(
            DomainEventType.A2UI_STREAM_STARTED,
            {"stream_id": "stream-1", "render_key": "confirm"},
        )
    )
    await projection.handle(
        _event(
            DomainEventType.A2UI_STREAM_CHUNK,
            {
                "stream_id": "stream-1",
                "render_key": "confirm",
                "stream": {"chunk_index": 1},
            },
        )
    )
    await projection.handle(
        _event(
            DomainEventType.A2UI_STREAM_FINISHED,
            {"stream_id": "stream-1", "render_key": "confirm"},
        )
    )
    await projection.handle(
        _event(
            DomainEventType.A2UI_CREATED,
            {"interaction_id": "a2ui-1", "a2ui": {"render_key": "confirm"}},
        )
    )
    await projection.handle(
        _event(
            DomainEventType.TURN_WAITING_INPUT,
            {"interaction_id": "a2ui-1", "reason": "a2ui"},
        )
    )
    await projection.handle(
        _event(
            DomainEventType.A2UI_SUBMITTED,
            {
                "interaction_id": "a2ui-1",
                "request_id": "submit-1",
                "resume": {"status": "started"},
            },
        )
    )
    await projection.handle(
        _event(
            DomainEventType.A2UI_CANCELLED,
            {
                "interaction_id": "a2ui-2",
                "request_id": "cancel-1",
                "resume": {"status": "deferred"},
            },
        )
    )
    await projection.handle(
        _event(
            DomainEventType.A2UI_RESUME_SUCCEEDED,
            {"interaction_id": "a2ui-1", "resume": {"status": "succeeded"}},
        )
    )

    assert [item["action"] for item in adapter.sent] == [
        "a2ui_stream_start",
        "a2ui_stream_chunk",
        "a2ui_stream_finish",
        "a2ui_created",
        "waiting_input",
        "a2ui_submit_ack",
        "a2ui_cancel_ack",
        "a2ui_resume",
    ]
    assert adapter.sent[3]["data"]["interaction_id"] == "a2ui-1"
    assert adapter.sent[4]["data"]["reason"] == "a2ui"
    assert adapter.sent[5]["data"]["resume"]["status"] == "started"


@pytest.mark.asyncio
async def test_chat_projection_maps_turn_terminal_states() -> None:
    adapter = RecordingChatAdapter()
    projection = ChatProjection(adapter)

    await projection.handle(_event(DomainEventType.TURN_COMPLETED, {"final_content": "done"}))
    await projection.handle(_event(DomainEventType.TURN_CANCELLED, {"reason": "user"}))
    await projection.handle(_event(DomainEventType.TURN_FAILED, {"message": "boom"}))

    assert [item["action"] for item in adapter.sent] == ["completed", "cancelled", "error"]


@pytest.mark.asyncio
async def test_chat_projection_maps_session_title_updates() -> None:
    adapter = RecordingChatAdapter()
    projection = ChatProjection(adapter)

    await projection.handle(
        _event(
            DomainEventType.SESSION_TITLE_UPDATED,
            {"session_id": "ses_original", "title": "自动标题"},
        )
    )

    assert adapter.sent[0]["session_id"] == "ses_original"
    assert adapter.sent[0]["action"] == "session_title_updated"
    assert adapter.sent[0]["data"]["title"] == "自动标题"


@pytest.mark.asyncio
async def test_chat_projection_maps_middleware_progress() -> None:
    adapter = RecordingChatAdapter()
    projection = ChatProjection(adapter)

    await projection.handle(
        _event(
            DomainEventType.MIDDLEWARE_PROGRESS,
            {
                "middleware": "ContextCompressionMiddleware",
                "stage": "compression_started",
                "compression_mode": "context",
                "notice_id": "context-compression:trace_1",
            },
        )
    )

    assert adapter.sent[0]["session_id"] == "ses_original"
    assert adapter.sent[0]["action"] == "middleware_progress"
    assert adapter.sent[0]["data"]["stage"] == "compression_started"
    assert adapter.sent[0]["data"]["notice_id"] == "context-compression:trace_1"


@pytest.mark.asyncio
async def test_chat_projection_maps_subagent_events() -> None:
    adapter = RecordingChatAdapter()
    projection = ChatProjection(adapter)

    await projection.handle(_event(DomainEventType.SUBAGENT_STARTED, {"subagent_id": "sub_1"}))
    await projection.handle(_event(DomainEventType.SUBAGENT_FINISHED, {"subagent_id": "sub_1"}))
    await projection.handle(
        _event(DomainEventType.SUBAGENT_FAILED, {"subagent_id": "sub_2", "error": "bad"})
    )

    assert [item["action"] for item in adapter.sent] == [
        "subagent_start",
        "subagent_end",
        "subagent_error",
    ]


@pytest.mark.asyncio
async def test_chat_projection_filters_reasoning_payload_for_chat_channel() -> None:
    adapter = RecordingChatAdapter()
    projection = ChatProjection(adapter)

    await projection.handle(
        _event(
            DomainEventType.REASONING_STREAM,
            {
                "kind": "initial_response",
                "text": "thinking",
                "done": False,
                "cancel_main": False,
                "start_time": 100,
                "end_time": 2500,
                "duration_ms": 2400,
                "internal_only": "hidden",
            },
        )
    )

    assert adapter.sent[0]["session_id"] == "ses_original"
    assert adapter.sent[0]["action"] == "reasoning"
    assert adapter.sent[0]["data"]["session_id"] == "ses_original"
    assert adapter.sent[0]["data"]["kind"] == "initial_response"
    assert adapter.sent[0]["data"]["done"] is False
    assert adapter.sent[0]["data"]["trace_id"] == "trace_1"
    assert adapter.sent[0]["data"]["text"] == "thinking"
    assert adapter.sent[0]["data"]["cancel_main"] is False
    assert adapter.sent[0]["data"]["start_time"] == 100
    assert adapter.sent[0]["data"]["end_time"] == 2500
    assert adapter.sent[0]["data"]["duration_ms"] == 2400
    assert isinstance(adapter.sent[0]["data"]["timestamp_ms"], int)
    assert "internal_only" not in adapter.sent[0]["data"]


@pytest.mark.asyncio
async def test_chat_projection_ignores_unmapped_domain_events() -> None:
    adapter = RecordingChatAdapter()
    projection = ChatProjection(adapter)

    await projection.handle(_event(DomainEventType.MESSAGE_USER_CREATED, {"content": "hi"}))

    assert adapter.sent == []


@pytest.mark.asyncio
async def test_chat_projection_sends_only_pending_user_message_events() -> None:
    adapter = RecordingChatAdapter()
    projection = ChatProjection(adapter)
    pending_event = _event(DomainEventType.MESSAGE_USER_CREATED, {"content": "运行中引导"})
    pending_event = DomainEvent(
        event_type=pending_event.event_type,
        source="pending_input_middleware",
        payload=pending_event.payload,
        trace_id=pending_event.trace_id,
        original_session_id=pending_event.original_session_id,
        active_session_id=pending_event.active_session_id,
        turn_index=pending_event.turn_index,
    )

    await projection.handle(pending_event)
    promoted_event = DomainEvent(
        event_type=pending_event.event_type,
        source="pending_input_promotion",
        payload={"content": "排队消息", "pending_input_id": "pending-queue"},
        trace_id=pending_event.trace_id,
        original_session_id=pending_event.original_session_id,
        active_session_id=pending_event.active_session_id,
        turn_index=2,
    )
    await projection.handle(promoted_event)

    assert adapter.sent[0]["action"] == "user_message"
    assert adapter.sent[0]["data"]["content"] == "运行中引导"
    assert adapter.sent[1]["action"] == "user_message"
    assert adapter.sent[1]["data"]["pending_input_id"] == "pending-queue"
