from __future__ import annotations

from typing import Any

from backend.app.events import DomainEvent, DomainEventType, EventDispatcher
from backend.app.model import ToolSpec
from backend.app.tools import FunctionTool, ToolExecutionContext, ToolRegistry
from backend.app.tools.base import ToolExecutionResult
from backend.app.tools.orchestrator import ToolOrchestrator


class RecordingConsumer:
    def __init__(self) -> None:
        self.events: list[DomainEvent] = []

    async def handle(self, event: DomainEvent) -> None:
        self.events.append(event)


class ExplodingTool:
    name = "explode"
    description = "always raises"
    parameters = {"type": "object"}
    enabled = True

    def to_tool_spec(self) -> ToolSpec:
        return ToolSpec(name=self.name, description=self.description, parameters=self.parameters)

    async def run(
        self,
        args: dict[str, Any],
        context: ToolExecutionContext,
    ) -> ToolExecutionResult:
        raise RuntimeError("boom")


def _context(tmp_path) -> ToolExecutionContext:
    return ToolExecutionContext(
        session_id="ses_tool",
        user_id="local-user",
        workspace_root=tmp_path,
        turn_index=2,
        trace_id="trace_1",
        metadata={"tool_metadata": {"source": "test"}},
    )


def _orchestrator(registry: ToolRegistry, consumer: RecordingConsumer) -> ToolOrchestrator:
    dispatcher = EventDispatcher([consumer.handle])
    return ToolOrchestrator(registry=registry, dispatcher=dispatcher)


async def test_tool_orchestrator_emits_start_and_finish_events(tmp_path) -> None:
    registry = ToolRegistry()
    registry.register(
        FunctionTool(
            name="echo",
            description="echo args",
            parameters={"type": "object"},
            handler=lambda args, context: {"value": args["value"]},
        )
    )
    consumer = RecordingConsumer()

    result = await _orchestrator(registry, consumer).execute(
        "echo",
        {"value": "ok"},
        _context(tmp_path),
        run_id="run_1",
    )

    assert result.ok is True
    assert [event.event_type for event in consumer.events] == [
        DomainEventType.LLM_TOOL_STARTED.value,
        DomainEventType.LLM_TOOL_FINISHED.value,
    ]
    started, finished = consumer.events
    assert started.run_id == "run_1"
    assert finished.run_id == "run_1"
    assert started.payload["tool"] == "echo"
    assert started.payload["params"] == {"value": "ok"}
    assert started.payload["is_subagent"] is False
    assert started.payload["metadata"] == {"source": "test"}
    assert finished.payload["status"] == "completed"
    assert finished.payload["duration_ms"] >= 0
    assert finished.payload["output_data"]["result"] == {"value": "ok"}
    assert finished.payload["result"] == '{"value": "ok"}'


async def test_tool_orchestrator_emits_failed_event_for_tool_result_error(tmp_path) -> None:
    registry = ToolRegistry()
    registry.register(
        FunctionTool(
            name="fail",
            description="raises",
            parameters={"type": "object"},
            handler=lambda args, context: (_ for _ in ()).throw(ValueError("bad")),
        )
    )
    consumer = RecordingConsumer()

    result = await _orchestrator(registry, consumer).execute("fail", {}, _context(tmp_path))

    assert result.ok is False
    assert [event.event_type for event in consumer.events] == [
        DomainEventType.LLM_TOOL_STARTED.value,
        DomainEventType.LLM_TOOL_FAILED.value,
    ]
    failed = consumer.events[-1]
    assert failed.payload["status"] == "failed"
    assert failed.payload["error"] == "bad"
    assert failed.payload["error_type"] == "tool_execution_failed"
    assert failed.payload["duration_ms"] >= 0


async def test_tool_orchestrator_wraps_unexpected_tool_exception(tmp_path) -> None:
    registry = ToolRegistry()
    registry.register(ExplodingTool())
    consumer = RecordingConsumer()

    result = await _orchestrator(registry, consumer).execute("explode", {}, _context(tmp_path))

    assert result.ok is False
    assert result.error["code"] == "tool_execution_failed"
    assert consumer.events[-1].event_type == DomainEventType.LLM_TOOL_FAILED.value
    assert consumer.events[-1].payload["error"] == "boom"


async def test_tool_orchestrator_emits_failed_event_for_missing_tool(tmp_path) -> None:
    consumer = RecordingConsumer()

    result = await _orchestrator(ToolRegistry(), consumer).execute(
        "missing",
        {"path": "x"},
        _context(tmp_path),
    )

    assert result.ok is False
    assert result.error["code"] == "tool_not_found"
    assert [event.event_type for event in consumer.events] == [
        DomainEventType.LLM_TOOL_STARTED.value,
        DomainEventType.LLM_TOOL_FAILED.value,
    ]
    assert consumer.events[-1].payload["tool"] == "missing"


async def test_tool_orchestrator_preserves_subagent_fields_and_ui_payload(tmp_path) -> None:
    registry = ToolRegistry()
    registry.register(
        FunctionTool(
            name="update_plan",
            description="plan",
            parameters={"type": "object"},
            handler=lambda args, context: {
                "ui_payload": {"entries": [{"content": "实现", "status": "completed"}]}
            },
        )
    )
    consumer = RecordingConsumer()

    await _orchestrator(registry, consumer).execute(
        "update_plan",
        {},
        _context(tmp_path),
        parent_run_id="parent_1",
        subagent_name="worker",
        subagent_id="sub_1",
    )

    started, finished = consumer.events
    assert started.payload["is_subagent"] is True
    assert started.payload["subagent_name"] == "worker"
    assert started.payload["subagent_id"] == "sub_1"
    assert finished.payload["parent_run_id"] == "parent_1"
    assert finished.payload["ui_payload"] == {
        "entries": [{"content": "实现", "status": "completed"}]
    }
