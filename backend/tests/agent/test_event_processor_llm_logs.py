from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

import pytest
from langchain_core.messages import AIMessage

from backend.app.agent.event_processor import process_agent_events
from backend.app.agent.factory import register_llm_gateway_trace_id
from backend.app.events import DomainEvent, DomainEventType, EventDispatcher
from backend.app.storage import StorageRepositories, init_database


class NeverCancelled:
    def is_cancelled(self) -> bool:
        return False


async def _event_stream(events: list[dict[str, Any]]) -> AsyncIterator[dict[str, Any]]:
    for event in events:
        yield event


async def _event_stream_with_gateway_trace(
    events: list[dict[str, Any]],
    *,
    run_id: str,
    gateway_trace_id: str,
) -> AsyncIterator[dict[str, Any]]:
    for event in events:
        yield event
        if event.get("event") == "on_chat_model_start":
            register_llm_gateway_trace_id(run_id, gateway_trace_id)


def _repositories(tmp_path) -> StorageRepositories:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    repositories.sessions.create(
        session_id="ses_agent",
        user_id="local-user",
        scene_id="desktop-agent",
    )
    repositories.trace_records.create(
        trace_id="trace_agent",
        session_id="ses_agent",
        active_session_id="ses_agent",
        scene_id="desktop-agent",
        user_id="local-user",
        turn_index=1,
        root_node_id="trace_agent-root",
    )
    return repositories


@pytest.mark.asyncio
async def test_process_agent_events_writes_llm_request_log_on_model_end(tmp_path) -> None:
    repositories = _repositories(tmp_path)

    result = await process_agent_events(
        _event_stream_with_gateway_trace(
            [
                {
                    "event": "on_chat_model_start",
                    "run_id": "run_1",
                    "name": "ChatOpenAI",
                    "metadata": {
                        "ls_provider": "openai",
                        "ls_model_name": "deepseek-v4-flash",
                        "authorization": "secret",
                    },
                    "data": {"input": {"messages": [["user", "你好"]]}},
                },
                {
                    "event": "on_chat_model_end",
                    "run_id": "run_1",
                    "data": {
                        "output": AIMessage(
                            content="你好，已收到",
                            usage_metadata={
                                "input_tokens": 12,
                                "output_tokens": 8,
                                "total_tokens": 20,
                                "input_token_details": {"cache_read": 5},
                            },
                        )
                    },
                },
            ],
            run_id="run_1",
            gateway_trace_id="gateway_trace_run_1",
        ),
        dispatcher=EventDispatcher(),
        cancellation=NeverCancelled(),
        session_id="ses_agent",
        trace_id="trace_agent",
        user_id="local-user",
        active_session_id="ses_agent",
        turn_index=1,
        model="runtime-model",
        llm_request_logs=repositories.llm_request_logs,
    )

    record = repositories.llm_request_logs.get("run_1")
    assert record is not None
    assert record.status == "completed"
    assert record.model == "deepseek-v4-flash"
    assert record.provider_name == "openai"
    assert record.gateway_thread_id == "trace_agent"
    assert record.gateway_trace_id == "gateway_trace_run_1"
    assert record.input_tokens == 12
    assert record.output_tokens == 8
    assert record.cache_read_tokens == 5
    assert record.total_tokens == 20
    assert record.response_preview == "你好，已收到"
    assert record.metadata is not None
    assert "authorization" not in record.metadata["langchain_metadata"]
    assert result.chain_token_usage["llm_call_count"] == 1


@pytest.mark.asyncio
async def test_process_agent_events_marks_llm_request_log_failed_on_model_error(tmp_path) -> None:
    repositories = _repositories(tmp_path)

    await process_agent_events(
        _event_stream_with_gateway_trace(
            [
                {
                    "event": "on_chat_model_start",
                    "run_id": "run_error",
                    "name": "ChatOpenAI",
                    "metadata": {},
                    "data": {"input": {"messages": [["user", "你好"]]}},
                },
                {
                    "event": "on_chat_model_error",
                    "run_id": "run_error",
                    "data": {"error": "HTTP 400"},
                },
            ],
            run_id="run_error",
            gateway_trace_id="gateway_trace_run_error",
        ),
        dispatcher=EventDispatcher(),
        cancellation=NeverCancelled(),
        session_id="ses_agent",
        trace_id="trace_agent",
        user_id="local-user",
        active_session_id="ses_agent",
        turn_index=1,
        model="runtime-model",
        llm_request_logs=repositories.llm_request_logs,
    )

    record = repositories.llm_request_logs.get("run_error")
    assert record is not None
    assert record.status == "failed"
    assert record.model == "runtime-model"
    assert record.gateway_thread_id == "trace_agent"
    assert record.gateway_trace_id == "gateway_trace_run_error"
    assert record.error_message == "HTTP 400"


@pytest.mark.asyncio
async def test_process_agent_events_marks_serialized_local_tool_error_failed() -> None:
    emitted: list[DomainEvent] = []

    async def capture(event: DomainEvent) -> None:
        emitted.append(event)

    result = await process_agent_events(
        _event_stream(
            [
                {
                    "event": "on_tool_start",
                    "run_id": "tool_error",
                    "name": "read_file",
                    "data": {"input": {"path": "missing.txt"}},
                },
                {
                    "event": "on_tool_end",
                    "run_id": "tool_error",
                    "name": "read_file",
                    "data": {
                        "output": (
                            '{"code":"file_not_found","message":"文件不存在",'
                            '"details":{"path":"missing.txt"}}'
                        )
                    },
                },
            ]
        ),
        dispatcher=EventDispatcher([capture]),
        cancellation=NeverCancelled(),
        session_id="ses_agent",
        trace_id="trace_agent",
        user_id="local-user",
        active_session_id="ses_agent",
        turn_index=1,
        model="runtime-model",
    )

    tool_events = [event for event in emitted if event.run_id == "tool_error"]
    assert [event.event_type for event in tool_events] == [
        DomainEventType.LLM_TOOL_STARTED.value,
        DomainEventType.LLM_TOOL_FAILED.value,
    ]
    assert tool_events[1].payload["status"] == "failed"
    assert "file_not_found" in tool_events[1].payload["error"]
    assert result.final_content == ""
