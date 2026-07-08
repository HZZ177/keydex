from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Any

import pytest
from langchain_core.messages import AIMessageChunk
from langgraph.errors import GraphInterrupt
from langgraph.types import Interrupt

from backend.app.agent.event_processor import process_agent_events
from backend.app.events import DomainEvent, DomainEventType, EventDispatcher


class NeverCancelled:
    def is_cancelled(self) -> bool:
        return False


async def _event_stream(events: list[dict[str, Any]]) -> AsyncIterator[dict[str, Any]]:
    for event in events:
        yield event


async def _a2ui_interrupting_stream() -> AsyncIterator[dict[str, Any]]:
    yield {
        "event": "on_chat_model_stream",
        "run_id": "model_run",
        "data": {"chunk": AIMessageChunk(content="处理中")},
    }
    raise GraphInterrupt(
        (
            Interrupt(
                value={"reason": "a2ui", "interaction_id": "a2ui-1"},
                id="interrupt-1",
            ),
        )
    )


@pytest.mark.asyncio
async def test_event_processor_splits_a2ui_stream_and_skips_regular_tool_cards() -> None:
    emitted: list[DomainEvent] = []

    async def capture(event: DomainEvent) -> None:
        emitted.append(event)

    await process_agent_events(
        _event_stream(
            [
                {
                    "event": "on_chat_model_stream",
                    "run_id": "model_run",
                    "data": {
                        "chunk": AIMessageChunk(
                            content="",
                            tool_call_chunks=[
                                {
                                    "id": "call_confirm",
                                    "index": 0,
                                    "name": "confirm",
                                    "args": '{"title":"是否继续',
                                }
                            ],
                        )
                    },
                },
                {
                    "event": "on_chat_model_stream",
                    "run_id": "model_run",
                    "data": {
                        "chunk": AIMessageChunk(
                            content="",
                            tool_call_chunks=[
                                {
                                    "id": None,
                                    "index": 0,
                                    "name": None,
                                    "args": '?"}',
                                }
                            ],
                        )
                    },
                },
                {
                    "event": "on_tool_start",
                    "run_id": "tool_confirm",
                    "name": "confirm",
                    "data": {"input": {"title": "是否继续?"}},
                },
                {
                    "event": "on_tool_end",
                    "run_id": "tool_confirm",
                    "name": "confirm",
                    "data": {"output": '{"status":"resumed"}'},
                },
            ]
        ),
        dispatcher=EventDispatcher([capture]),
        cancellation=NeverCancelled(),
        session_id="session-1",
        trace_id="trace-1",
        user_id="local-user",
        active_session_id="session-1",
        turn_index=1,
    )

    assert [event.event_type for event in emitted] == [
        DomainEventType.A2UI_STREAM_STARTED.value,
        DomainEventType.A2UI_STREAM_CHUNK.value,
        DomainEventType.A2UI_STREAM_FINISHED.value,
    ]
    assert not any(
        event.event_type
        in {
            DomainEventType.LLM_TOOL_STARTED.value,
            DomainEventType.LLM_TOOL_FINISHED.value,
            DomainEventType.LLM_TOOL_PROGRESS.value,
        }
        for event in emitted
    )
    assert emitted[0].payload["stream"]["status"] == "start"
    assert emitted[1].payload["stream"]["parsed_payload"] == {"title": "是否继续?"}
    assert emitted[2].payload["stream"]["status"] == "finish"
    assert emitted[2].payload["stream_id"] == "trace-1:a2ui:call_confirm"


@pytest.mark.asyncio
async def test_event_processor_keeps_one_a2ui_stream_when_tool_call_id_arrives_late() -> None:
    emitted: list[DomainEvent] = []

    async def capture(event: DomainEvent) -> None:
        emitted.append(event)

    await process_agent_events(
        _event_stream(
            [
                {
                    "event": "on_chat_model_stream",
                    "run_id": "model_run",
                    "data": {
                        "chunk": AIMessageChunk(
                            content="",
                            tool_call_chunks=[
                                {
                                    "id": None,
                                    "index": 0,
                                    "name": "chart",
                                    "args": '{"title":"Keydex 图表"',
                                }
                            ],
                        )
                    },
                },
                {
                    "event": "on_chat_model_stream",
                    "run_id": "model_run",
                    "data": {
                        "chunk": AIMessageChunk(
                            content="",
                            tool_call_chunks=[
                                {
                                    "id": "call_chart",
                                    "index": 0,
                                    "name": None,
                                    "args": ',"charts":[{"type":"column","items":[{"name":"一月","value":12}]}]}',
                                }
                            ],
                        )
                    },
                },
                {
                    "event": "on_tool_start",
                    "run_id": "tool_chart",
                    "name": "chart",
                    "data": {
                        "input": {
                            "title": "Keydex 图表",
                            "charts": [
                                {
                                    "type": "column",
                                    "items": [{"name": "一月", "value": 12}],
                                }
                            ],
                        }
                    },
                },
                {
                    "event": "on_tool_end",
                    "run_id": "tool_chart",
                    "name": "chart",
                    "data": {"output": '{"status":"rendered"}'},
                },
            ]
        ),
        dispatcher=EventDispatcher([capture]),
        cancellation=NeverCancelled(),
        session_id="session-1",
        trace_id="trace-1",
        user_id="local-user",
        active_session_id="session-1",
        turn_index=1,
    )

    assert [event.event_type for event in emitted] == [
        DomainEventType.A2UI_STREAM_STARTED.value,
        DomainEventType.A2UI_STREAM_CHUNK.value,
        DomainEventType.A2UI_STREAM_FINISHED.value,
    ]
    stream_ids = [event.payload["stream_id"] for event in emitted]
    assert stream_ids == [
        "trace-1:a2ui:model_run:0",
        "trace-1:a2ui:model_run:0",
        "trace-1:a2ui:model_run:0",
    ]
    assert emitted[1].payload["tool_call_id"] == "call_chart"
    assert emitted[2].payload["tool_call_id"] == "call_chart"


@pytest.mark.asyncio
async def test_event_processor_returns_on_a2ui_graph_interrupt() -> None:
    emitted: list[DomainEvent] = []

    async def capture(event: DomainEvent) -> None:
        emitted.append(event)

    result = await process_agent_events(
        _a2ui_interrupting_stream(),
        dispatcher=EventDispatcher([capture]),
        cancellation=NeverCancelled(),
        session_id="session-1",
        trace_id="trace-1",
        user_id="local-user",
        active_session_id="session-1",
        turn_index=1,
    )

    assert result.final_content == "处理中"
    assert [event.event_type for event in emitted] == [DomainEventType.LLM_STREAM.value]


@pytest.mark.asyncio
async def test_event_processor_keeps_regular_tool_progress_with_a2ui_bridge_enabled() -> None:
    emitted: list[DomainEvent] = []

    async def capture(event: DomainEvent) -> None:
        emitted.append(event)

    await process_agent_events(
        _event_stream(
            [
                {
                    "event": "on_chat_model_stream",
                    "run_id": "model_run",
                    "data": {
                        "chunk": AIMessageChunk(
                            content="",
                            tool_call_chunks=[
                                {
                                    "id": "call_patch",
                                    "index": 0,
                                    "name": "apply_patch",
                                    "args": (
                                        '{"patch":"*** Begin Patch\\n'
                                        "*** Update File: src/app.py\\n"
                                        '@@\\n-old\\n+new"}'
                                    ),
                                }
                            ],
                        )
                    },
                }
            ]
        ),
        dispatcher=EventDispatcher([capture]),
        cancellation=NeverCancelled(),
        session_id="session-1",
        trace_id="trace-1",
        user_id="local-user",
        active_session_id="session-1",
        turn_index=1,
    )

    assert [event.event_type for event in emitted] == [DomainEventType.LLM_TOOL_PROGRESS.value]
    assert emitted[0].payload["tool"] == "apply_patch"
    assert emitted[0].payload["files"][0]["path"] == "src/app.py"
