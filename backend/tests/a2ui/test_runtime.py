from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from langgraph.errors import GraphInterrupt
from langgraph.types import Interrupt

from backend.app.a2ui.registry import build_builtin_a2ui_registry
from backend.app.a2ui.resume_context import build_a2ui_resume_context
from backend.app.a2ui.runtime import A2UIRuntime, resolve_a2ui_stream_id
from backend.app.a2ui.schemas import A2UISchemaValidationError
from backend.app.core.request_context import (
    clear_a2ui_stream_context,
    consume_a2ui_stream_context,
    register_a2ui_stream_context,
    reset_a2ui_resume_context,
    set_a2ui_resume_context,
)
from backend.app.events.event_types import DomainEventType
from backend.app.storage import StorageRepositories, init_database
from backend.app.tools import ToolExecutionContext


class RecordingDispatcher:
    def __init__(self) -> None:
        self.events: list[dict[str, Any]] = []

    async def emit_event(self, **kwargs: Any) -> dict[str, Any]:
        self.events.append(kwargs)
        return kwargs


@pytest.mark.asyncio
async def test_a2ui_runtime_render_emits_created_without_interaction(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    dispatcher = RecordingDispatcher()
    registry = build_builtin_a2ui_registry()
    runtime = A2UIRuntime(repositories=repositories, dispatcher=dispatcher, registry=registry)

    result = json.loads(
        await runtime.handle_tool_call(
            registry.require("chart"),
            {
                "title": "Metrics",
                "charts": [
                    {
                        "type": "column",
                        "title": "活跃用户",
                        "series": [
                            {
                                "name": "用户数",
                                "items": [
                                    {"name": "一月", "value": 120},
                                    {"name": "二月", "value": 180},
                                ],
                            }
                        ],
                    },
                    {
                        "type": "pie",
                        "title": "用户分布",
                        "items": [
                            {"name": "新用户", "value": 60},
                            {"name": "老用户", "value": 40},
                        ],
                    },
                ],
            },
            _context(tmp_path),
            {"tool_call_id": "tool-call-1"},
        )
    )

    assert result["status"] == "rendered"
    assert result["stream_id"] == resolve_a2ui_stream_id(
        render_key="chart",
        tool_call_id="tool-call-1",
        trace_id="trace-1",
    )
    assert repositories.a2ui_interactions.list_by_session("session-1") == []
    assert [event["event_type"] for event in dispatcher.events] == [
        DomainEventType.A2UI_CREATED.value
    ]
    created = dispatcher.events[0]["payload"]
    assert created["a2ui"]["mode"] == "render"
    assert created["a2ui"]["interaction"] is None


@pytest.mark.asyncio
async def test_a2ui_runtime_reuses_registered_stream_context(tmp_path) -> None:
    clear_a2ui_stream_context()
    repositories = _repositories(tmp_path)
    dispatcher = RecordingDispatcher()
    registry = build_builtin_a2ui_registry()
    runtime = A2UIRuntime(repositories=repositories, dispatcher=dispatcher, registry=registry)
    register_a2ui_stream_context(
        "chart",
        {
            "stream_id": "trace-1:a2ui:tool-call-1",
            "tool_call_id": "tool-call-1",
            "render_key": "chart",
            "run_id": "run-1",
        },
    )

    result = json.loads(
        await runtime.handle_tool_call(
            registry.require("chart"),
            {"title": "Metrics", "charts": [{"type": "column", "items": [{"name": "一月", "value": 120}]}]},
            _context(tmp_path),
            {"tool_call_id": "tool-call-1"},
        )
    )

    assert result["stream_id"] == "trace-1:a2ui:tool-call-1"
    assert dispatcher.events[0]["payload"]["a2ui"]["stream_id"] == "trace-1:a2ui:tool-call-1"
    assert consume_a2ui_stream_context("chart", tool_call_id="tool-call-1") is None


@pytest.mark.asyncio
async def test_a2ui_runtime_consumes_queued_stream_context_when_tool_call_id_mismatches(tmp_path) -> None:
    clear_a2ui_stream_context()
    repositories = _repositories(tmp_path)
    dispatcher = RecordingDispatcher()
    registry = build_builtin_a2ui_registry()
    runtime = A2UIRuntime(repositories=repositories, dispatcher=dispatcher, registry=registry)
    register_a2ui_stream_context(
        "chart",
        {
            "stream_id": "trace-1:a2ui:other-call",
            "tool_call_id": "other-call",
            "render_key": "chart",
            "run_id": "run-1",
        },
    )

    result = json.loads(
        await runtime.handle_tool_call(
            registry.require("chart"),
            {"title": "Metrics", "charts": [{"type": "column", "items": [{"name": "一月", "value": 120}]}]},
            _context(tmp_path),
            {"tool_call_id": "tool-call-1"},
        )
    )

    assert result["stream_id"] == "trace-1:a2ui:other-call"
    assert dispatcher.events[0]["payload"]["a2ui"]["tool_call_id"] == "tool-call-1"
    assert consume_a2ui_stream_context("chart", tool_call_id="other-call") is None


@pytest.mark.asyncio
async def test_a2ui_runtime_prefers_stream_context_with_matching_run_id(tmp_path) -> None:
    clear_a2ui_stream_context()
    repositories = _repositories(tmp_path)
    dispatcher = RecordingDispatcher()
    registry = build_builtin_a2ui_registry()
    runtime = A2UIRuntime(repositories=repositories, dispatcher=dispatcher, registry=registry)
    register_a2ui_stream_context(
        "chart",
        {
            "stream_id": "trace-1:a2ui:older-call",
            "tool_call_id": "older-call",
            "render_key": "chart",
            "run_id": "older-run",
        },
    )
    register_a2ui_stream_context(
        "chart",
        {
            "stream_id": "trace-1:a2ui:current-call",
            "tool_call_id": "current-call",
            "render_key": "chart",
            "run_id": "tool-run-1",
        },
    )

    result = json.loads(
        await runtime.handle_tool_call(
            registry.require("chart"),
            {"title": "Metrics", "charts": [{"type": "column", "items": [{"name": "一月", "value": 120}]}]},
            _context(tmp_path),
            {"tool_call_id": "missing-call", "run_id": "tool-run-1"},
        )
    )

    assert result["stream_id"] == "trace-1:a2ui:current-call"
    assert consume_a2ui_stream_context("chart", tool_call_id="older-call") == {
        "stream_id": "trace-1:a2ui:older-call",
        "tool_call_id": "older-call",
        "render_key": "chart",
        "run_id": "older-run",
    }


@pytest.mark.asyncio
async def test_a2ui_runtime_interactive_creates_interaction_waits_and_interrupts(
    tmp_path,
) -> None:
    repositories = _repositories(tmp_path)
    dispatcher = RecordingDispatcher()
    interrupted: dict[str, Any] = {}

    def interrupt_fn(payload: dict[str, Any]) -> dict[str, Any]:
        interrupted.update(payload)
        return {"confirmed": True}

    registry = build_builtin_a2ui_registry()
    runtime = A2UIRuntime(
        repositories=repositories,
        dispatcher=dispatcher,
        registry=registry,
        interrupt_fn=interrupt_fn,
    )

    result = json.loads(
        await runtime.handle_tool_call(
            registry.require("confirm"),
            {"title": "是否继续?"},
            _context(tmp_path),
            {
                "tool_call_id": "tool-call-1",
                "configurable": {"checkpoint_id": "checkpoint-1", "checkpoint_ns": ""},
            },
        )
    )

    records = repositories.a2ui_interactions.list_by_session("session-1")
    assert len(records) == 1
    record = records[0]
    assert record.render_key == "confirm"
    assert record.tool_call_id == "tool-call-1"
    assert record.checkpoint_id == "checkpoint-1"
    assert record.interrupt_id == "tool-call-1"
    assert record.can_submit is True
    assert repositories.sessions.get("session-1").status == "waiting_input"
    assert result["status"] == "resumed"
    assert result["interaction_id"] == record.id
    assert result["resume"] == {"confirmed": True}
    assert [event["event_type"] for event in dispatcher.events] == [
        DomainEventType.A2UI_CREATED.value,
        DomainEventType.TURN_WAITING_INPUT.value,
    ]
    assert dispatcher.events[0]["payload"]["interaction_id"] == record.id
    assert dispatcher.events[1]["payload"]["interaction_id"] == record.id
    assert interrupted["checkpoint"]["checkpoint_id"] == "checkpoint-1"
    assert interrupted["a2ui"]["interaction"]["interaction_id"] == record.id


@pytest.mark.asyncio
async def test_a2ui_runtime_backfills_langgraph_interrupt_id(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    dispatcher = RecordingDispatcher()

    def interrupt_fn(payload: dict[str, Any]) -> None:
        raise GraphInterrupt(
            (
                Interrupt(
                    value=payload,
                    id="langgraph-interrupt-1",
                ),
            )
        )

    registry = build_builtin_a2ui_registry()
    runtime = A2UIRuntime(
        repositories=repositories,
        dispatcher=dispatcher,
        registry=registry,
        interrupt_fn=interrupt_fn,
    )

    with pytest.raises(GraphInterrupt):
        await runtime.handle_tool_call(
            registry.require("confirm"),
            {"title": "是否继续?"},
            _context(tmp_path),
            {"tool_call_id": "tool-call-1"},
        )

    record = repositories.a2ui_interactions.list_by_session("session-1")[0]
    assert record.interrupt_id == "langgraph-interrupt-1"


@pytest.mark.asyncio
async def test_a2ui_runtime_consumes_resume_payload_without_duplicate_interaction(
    tmp_path,
) -> None:
    repositories = _repositories(tmp_path)
    dispatcher = RecordingDispatcher()
    registry = build_builtin_a2ui_registry()
    runtime = A2UIRuntime(repositories=repositories, dispatcher=dispatcher, registry=registry)
    repositories.a2ui_interactions.create(
        interaction_id="a2ui-existing",
        session_id="session-1",
        trace_id="trace-1",
        active_session_id="thread-1",
        turn_index=3,
        tool_call_id="tool-call-1",
        stream_id="trace-1:a2ui:tool-call-1",
        render_key="confirm",
        mode="interactive",
        payload={"title": "是否继续?"},
        input_schema=registry.require("confirm").input_schema,
        submit_schema_snapshot=registry.require("confirm").submit_schema,
        langgraph_thread_id="thread-1",
        checkpoint_ns="",
        checkpoint_id="checkpoint-1",
        interrupt_id="interrupt-1",
        resume_group_id="group-1",
    )
    resume_payload = {
        "status": "submitted",
        "interaction_id": "a2ui-existing",
        "render_key": "confirm",
        "submit_result": {"confirmed": True},
    }
    token = set_a2ui_resume_context(
        build_a2ui_resume_context(
            payloads_by_tool_call_id={"tool-call-1": resume_payload},
            payloads_by_render_key={"confirm": [resume_payload]},
        )
    )
    try:
        result = json.loads(
            await runtime.handle_tool_call(
                registry.require("confirm"),
                {"title": "是否继续?"},
                _context(tmp_path),
                {"tool_call_id": "tool-call-1"},
            )
        )
    finally:
        reset_a2ui_resume_context(token)

    assert result == resume_payload
    assert len(repositories.a2ui_interactions.list_by_session("session-1")) == 1
    assert dispatcher.events == []


@pytest.mark.asyncio
async def test_a2ui_runtime_rejects_invalid_payload(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    dispatcher = RecordingDispatcher()
    registry = build_builtin_a2ui_registry()
    runtime = A2UIRuntime(repositories=repositories, dispatcher=dispatcher, registry=registry)

    with pytest.raises(A2UISchemaValidationError, match="title"):
        await runtime.handle_tool_call(
            registry.require("confirm"),
            {"description": "缺少标题"},
            _context(tmp_path),
            {"tool_call_id": "tool-call-1"},
        )

    assert dispatcher.events == []
    assert repositories.a2ui_interactions.list_by_session("session-1") == []


@pytest.mark.asyncio
async def test_a2ui_runtime_rejects_legacy_chart_payload(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    dispatcher = RecordingDispatcher()
    registry = build_builtin_a2ui_registry()
    runtime = A2UIRuntime(repositories=repositories, dispatcher=dispatcher, registry=registry)

    with pytest.raises(A2UISchemaValidationError, match="charts"):
        await runtime.handle_tool_call(
            registry.require("chart"),
            {"title": "Metrics", "chart_type": "bar"},
            _context(tmp_path),
            {"tool_call_id": "tool-call-1"},
        )

    assert dispatcher.events == []


@pytest.mark.asyncio
async def test_a2ui_runtime_rejects_object_chart_summary(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    dispatcher = RecordingDispatcher()
    registry = build_builtin_a2ui_registry()
    runtime = A2UIRuntime(repositories=repositories, dispatcher=dispatcher, registry=registry)

    with pytest.raises(A2UISchemaValidationError, match=r"\$\.summary"):
        await runtime.handle_tool_call(
            registry.require("chart"),
            {
                "title": "Metrics",
                "summary": {"text": "对象摘要不属于当前 chart 契约"},
                "charts": [{"type": "column", "items": [{"name": "一月", "value": 120}]}],
            },
            _context(tmp_path),
            {"tool_call_id": "tool-call-1"},
        )

    assert dispatcher.events == []


def _repositories(tmp_path: Path) -> StorageRepositories:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    repositories.sessions.create(
        session_id="session-1",
        user_id="local-user",
        scene_id="desktop-agent",
    )
    return repositories


def _context(tmp_path: Path) -> ToolExecutionContext:
    return ToolExecutionContext(
        session_id="session-1",
        user_id="local-user",
        workspace_root=tmp_path,
        turn_index=3,
        trace_id="trace-1",
        metadata={"active_session_id": "session-1", "thread_id": "thread-1"},
    )
