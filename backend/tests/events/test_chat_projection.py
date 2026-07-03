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

    assert [item["action"] for item in adapter.sent] == [
        "task_updated",
        "task_deleted",
        "task_run_started",
        "task_run_finished",
    ]
    assert adapter.sent[0]["data"]["task"]["status"] == "active"
    assert adapter.sent[1]["data"]["task"]["deleted_at"] == "now"
    assert adapter.sent[2]["data"]["run"]["status"] == "running"
    assert adapter.sent[3]["data"]["run_id"] == "run-1"


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
                "stage": "emergency_triggered",
                "notice_id": "context-compression:emergency:trace_1",
            },
        )
    )

    assert adapter.sent[0]["session_id"] == "ses_original"
    assert adapter.sent[0]["action"] == "middleware_progress"
    assert adapter.sent[0]["data"]["stage"] == "emergency_triggered"
    assert adapter.sent[0]["data"]["notice_id"] == "context-compression:emergency:trace_1"


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
    assert isinstance(adapter.sent[0]["data"]["timestamp_ms"], int)
    assert "internal_only" not in adapter.sent[0]["data"]


@pytest.mark.asyncio
async def test_chat_projection_ignores_unmapped_domain_events() -> None:
    adapter = RecordingChatAdapter()
    projection = ChatProjection(adapter)

    await projection.handle(_event(DomainEventType.MESSAGE_USER_CREATED, {"content": "hi"}))

    assert adapter.sent == []
