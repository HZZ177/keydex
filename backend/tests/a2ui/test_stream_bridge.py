from __future__ import annotations

from langchain_core.messages import AIMessageChunk

from backend.app.a2ui.stream_bridge import (
    A2UIStreamBridge,
    a2ui_stream_event_type,
    is_a2ui_stream_payload,
    strip_a2ui_stream_marker,
)
from backend.app.agent.tool_call_progress import ToolCallChunkPipeline, default_collectors
from backend.app.core.request_context import clear_a2ui_stream_context, consume_a2ui_stream_context
from backend.app.events.event_types import DomainEventType


def test_a2ui_stream_bridge_reuses_tool_call_chunk_pipeline_for_stream_payloads() -> None:
    bridge = A2UIStreamBridge(trace_id="trace-1")
    pipeline = ToolCallChunkPipeline(collectors=[*default_collectors(), *bridge.collectors])

    first_progress = pipeline.process_chunk(
        AIMessageChunk(
            content="",
            tool_call_chunks=[
                {
                    "id": "call_confirm",
                    "index": 0,
                    "name": "confirm",
                    "args": '{"title":"是否继续',
                }
            ],
        ),
        model_run_id="model-run-1",
    )
    second_progress = pipeline.process_chunk(
        AIMessageChunk(
            content="",
            tool_call_chunks=[
                {
                    "id": None,
                    "index": 0,
                    "name": None,
                    "args": '?","description":"现在执行部署"}',
                }
            ],
        ),
        model_run_id="model-run-1",
    )

    assert len(first_progress) == 1
    assert is_a2ui_stream_payload(first_progress[0]) is True
    assert a2ui_stream_event_type(first_progress[0]) == DomainEventType.A2UI_STREAM_STARTED.value
    first_payload = strip_a2ui_stream_marker(first_progress[0])
    assert first_payload["render_key"] == "confirm"
    assert first_payload["stream_id"] == "trace-1:a2ui:call_confirm"
    assert first_payload["stream"]["status"] == "start"
    assert first_payload["stream"]["args_delta"] == '{"title":"是否继续'
    assert first_payload["stream"]["json_parse_status"] == "partial"

    assert len(second_progress) == 1
    assert a2ui_stream_event_type(second_progress[0]) == DomainEventType.A2UI_STREAM_CHUNK.value
    second_payload = strip_a2ui_stream_marker(second_progress[0])
    assert second_payload["stream"]["status"] == "chunk"
    assert second_payload["stream"]["parsed_payload"] == {
        "title": "是否继续?",
        "description": "现在执行部署",
    }
    assert second_payload["stream"]["json_parse_status"] == "complete"


def test_a2ui_stream_bridge_finishes_by_tool_call_id() -> None:
    clear_a2ui_stream_context()
    bridge = A2UIStreamBridge(trace_id="trace-1")
    pipeline = ToolCallChunkPipeline(collectors=bridge.collectors)
    pipeline.process_chunk(
        AIMessageChunk(
            content="",
            tool_call_chunks=[
                {
                    "id": "call_confirm",
                    "index": 0,
                    "name": "confirm",
                    "args": '{"title":"是否继续?"}',
                }
            ],
        ),
        model_run_id="model-run-1",
    )

    finished = bridge.finish_for_tool_call("call_confirm")
    repeated = bridge.finish_for_tool_call("call_confirm")

    assert finished is not None
    assert a2ui_stream_event_type(finished) == DomainEventType.A2UI_STREAM_FINISHED.value
    payload = strip_a2ui_stream_marker(finished)
    assert payload["stream_id"] == "trace-1:a2ui:call_confirm"
    assert payload["stream"]["status"] == "finish"
    assert payload["stream"]["finish_reason"] == "tool_call_started"
    assert payload["stream"]["parsed_payload"] == {"title": "是否继续?"}
    stream_context = consume_a2ui_stream_context("confirm", tool_call_id="call_confirm")
    assert stream_context == {
        "stream_id": "trace-1:a2ui:call_confirm",
        "tool_call_id": "call_confirm",
        "render_key": "confirm",
        "run_id": "",
    }
    assert repeated is None


def test_a2ui_stream_bridge_keeps_stream_id_stable_when_tool_call_id_arrives_late() -> None:
    clear_a2ui_stream_context()
    bridge = A2UIStreamBridge(trace_id="trace-1")
    pipeline = ToolCallChunkPipeline(collectors=bridge.collectors)

    first_progress = pipeline.process_chunk(
        AIMessageChunk(
            content="",
            tool_call_chunks=[
                {
                    "id": None,
                    "index": 0,
                    "name": "chart",
                    "args": '{"title":"Keydex 图表"',
                }
            ],
        ),
        model_run_id="model-run-late",
    )
    second_progress = pipeline.process_chunk(
        AIMessageChunk(
            content="",
            tool_call_chunks=[
                {
                    "id": "call_chart",
                    "index": 0,
                    "name": None,
                    "args": ',"charts":[{"type":"column","items":[{"name":"一月","value":12}]}]}',
                }
            ],
        ),
        model_run_id="model-run-late",
    )
    tool_call_id = pipeline.bind_tool_run(
        run_id="tool_chart",
        tool_name="chart",
        params={
            "title": "Keydex 图表",
            "charts": [{"type": "column", "items": [{"name": "一月", "value": 12}]}],
        },
    )
    finished = bridge.finish_for_tool_call(tool_call_id)

    assert tool_call_id == "call_chart"
    first_payload = strip_a2ui_stream_marker(first_progress[0])
    second_payload = strip_a2ui_stream_marker(second_progress[0])
    finished_payload = strip_a2ui_stream_marker(finished or {})
    assert first_payload["stream_id"] == "trace-1:a2ui:model-run-late:0"
    assert second_payload["stream_id"] == first_payload["stream_id"]
    assert finished_payload["stream_id"] == first_payload["stream_id"]
    assert second_payload["tool_call_id"] == "call_chart"
    stream_context = consume_a2ui_stream_context("chart", tool_call_id="call_chart")
    assert stream_context == {
        "stream_id": "trace-1:a2ui:model-run-late:0",
        "tool_call_id": "call_chart",
        "render_key": "chart",
        "run_id": "tool_chart",
    }


def test_a2ui_stream_bridge_does_not_break_existing_tool_progress() -> None:
    bridge = A2UIStreamBridge()
    pipeline = ToolCallChunkPipeline(collectors=[*default_collectors(), *bridge.collectors])

    progress = pipeline.process_chunk(
        AIMessageChunk(
            content="",
            tool_call_chunks=[
                {
                    "id": "call_patch",
                    "index": 0,
                    "name": "apply_patch",
                    "args": (
                        '{"patch":"*** Begin Patch\\n'
                        "*** Update File: src/app.py\\n@@\\n-old\\n+new\\n"
                        '*** End Patch"}'
                    ),
                }
            ],
        ),
        model_run_id="model-run-1",
    )

    assert len(progress) == 1
    assert is_a2ui_stream_payload(progress[0]) is False
    assert progress[0]["tool"] == "apply_patch"
    assert progress[0]["files"][0]["path"] == "src/app.py"
