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
                    "id": "call_choice",
                    "index": 0,
                    "name": "choice",
                    "args": '{"title":"选择方案","options":[{"label":"继续","value":"yes"',
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
                    "args": '}],"description":"现在执行部署"}',
                }
            ],
        ),
        model_run_id="model-run-1",
    )

    assert len(first_progress) == 1
    assert is_a2ui_stream_payload(first_progress[0]) is True
    assert a2ui_stream_event_type(first_progress[0]) == DomainEventType.A2UI_STREAM_STARTED.value
    first_payload = strip_a2ui_stream_marker(first_progress[0])
    assert first_payload["render_key"] == "choice"
    assert first_payload["stream_id"] == "trace-1:a2ui:call_choice"
    assert first_payload["stream_group_id"] == "trace-1:a2ui:call_choice"
    assert first_payload["stream"]["status"] == "start"
    assert first_payload["stream"]["args_delta"] == '{"title":"选择方案","options":[{"label":"继续","value":"yes"'
    assert first_payload["stream"]["json_parse_status"] == "partial"

    assert len(second_progress) == 1
    assert a2ui_stream_event_type(second_progress[0]) == DomainEventType.A2UI_STREAM_CHUNK.value
    second_payload = strip_a2ui_stream_marker(second_progress[0])
    assert second_payload["stream"]["status"] == "chunk"
    assert second_payload["stream"]["parsed_payload"] == {
        "title": "选择方案",
        "options": [{"label": "继续", "value": "yes"}],
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
                    "id": "call_choice",
                    "index": 0,
                    "name": "choice",
                    "args": '{"title":"选择方案","options":[{"label":"继续","value":"yes"}]}',
                }
            ],
        ),
        model_run_id="model-run-1",
    )

    finished = bridge.finish_for_tool_call("call_choice")
    repeated = bridge.finish_for_tool_call("call_choice")

    assert finished is not None
    assert a2ui_stream_event_type(finished) == DomainEventType.A2UI_STREAM_FINISHED.value
    payload = strip_a2ui_stream_marker(finished)
    assert payload["stream_id"] == "trace-1:a2ui:call_choice"
    assert payload["stream_group_id"] == "trace-1:a2ui:call_choice"
    assert payload["stream"]["status"] == "finish"
    assert payload["stream"]["finish_reason"] == "tool_call_started"
    assert payload["stream"]["parsed_payload"] == {
        "title": "选择方案",
        "options": [{"label": "继续", "value": "yes"}],
    }
    stream_context = consume_a2ui_stream_context("choice", tool_call_id="call_choice")
    assert stream_context == {
        "stream_id": "trace-1:a2ui:call_choice",
        "stream_group_id": "trace-1:a2ui:call_choice",
        "tool_call_id": "call_choice",
        "render_key": "choice",
        "run_id": "",
    }
    assert repeated is None


def test_a2ui_stream_bridge_model_end_finish_registers_later_on_tool_start() -> None:
    clear_a2ui_stream_context()
    bridge = A2UIStreamBridge(trace_id="trace-1")
    pipeline = ToolCallChunkPipeline(collectors=bridge.collectors)
    pipeline.process_chunk(
        AIMessageChunk(
            content="",
            tool_call_chunks=[
                {
                    "id": "call_chart",
                    "index": 0,
                    "name": "chart",
                    "args": '{"title":"趋势","charts":[{"type":"trend"}]}',
                }
            ],
        ),
        model_run_id="model-run-1",
    )

    model_end_payloads = bridge.finish_for_model_end()
    tool_start_payload = bridge.finish_for_tool_call("call_chart", run_id="tool_chart")

    assert len(model_end_payloads) == 1
    model_end_payload = strip_a2ui_stream_marker(model_end_payloads[0])
    assert model_end_payload["stream"]["finish_reason"] == "tool_args_completed"
    assert tool_start_payload is None
    stream_context = consume_a2ui_stream_context("chart", tool_call_id="call_chart")
    assert stream_context == {
        "stream_id": "trace-1:a2ui:call_chart",
        "stream_group_id": "trace-1:a2ui:call_chart",
        "tool_call_id": "call_chart",
        "render_key": "chart",
        "run_id": "tool_chart",
    }


def test_a2ui_stream_bridge_discard_all_does_not_register_for_created() -> None:
    clear_a2ui_stream_context()
    bridge = A2UIStreamBridge(trace_id="trace-1")
    pipeline = ToolCallChunkPipeline(collectors=bridge.collectors)
    pipeline.process_chunk(
        AIMessageChunk(
            content="",
            tool_call_chunks=[
                {"id": "call_bad", "index": 0, "name": "chart", "args": '{"title":'}
            ],
        ),
        model_run_id="model-run-1",
    )

    discarded = bridge.discard_all(finish_reason="invalid_tool_call")
    repeated = bridge.finish_for_tool_call("call_bad", run_id="tool_bad")

    assert len(discarded) == 1
    payload = strip_a2ui_stream_marker(discarded[0])
    assert payload["stream"]["finish_reason"] == "invalid_tool_call"
    assert repeated is None
    assert consume_a2ui_stream_context("chart", tool_call_id="call_bad") is None


def test_a2ui_stream_bridge_tool_error_replaces_finished_stream() -> None:
    clear_a2ui_stream_context()
    bridge = A2UIStreamBridge(trace_id="trace-1")
    pipeline = ToolCallChunkPipeline(collectors=bridge.collectors)
    pipeline.process_chunk(
        AIMessageChunk(
            content="",
            tool_call_chunks=[
                {
                    "id": "call_chart",
                    "index": 0,
                    "name": "chart",
                    "args": '{"title":"趋势","charts":[{"type":"trend"}]}',
                }
            ],
        ),
        model_run_id="model-run-1",
    )

    model_end_payloads = bridge.finish_for_model_end()
    tool_start_payload = bridge.finish_for_tool_call("call_chart", run_id="tool_chart")
    failed = bridge.fail_for_tool_call(
        "call_chart",
        run_id="tool_chart",
        error="$.charts[0].series[0].items[6].value: expected number",
    )
    repeated_failed = bridge.fail_for_tool_call("call_chart", run_id="tool_chart", error="重复错误")

    assert len(model_end_payloads) == 1
    assert tool_start_payload is None
    assert failed is not None
    payload = strip_a2ui_stream_marker(failed)
    assert payload["stream_id"] == "trace-1:a2ui:call_chart"
    assert payload["stream"]["status"] == "failed"
    assert payload["stream"]["finish_reason"] == "tool_error"
    assert payload["stream"]["error"] == "$.charts[0].series[0].items[6].value: expected number"
    assert repeated_failed is None


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
    finished = bridge.finish_for_tool_call(tool_call_id, run_id="tool_chart")

    assert tool_call_id == "call_chart"
    first_payload = strip_a2ui_stream_marker(first_progress[0])
    second_payload = strip_a2ui_stream_marker(second_progress[0])
    finished_payload = strip_a2ui_stream_marker(finished or {})
    assert first_payload["stream_id"] == "trace-1:a2ui:model-run-late:0"
    assert second_payload["stream_id"] == first_payload["stream_id"]
    assert finished_payload["stream_id"] == first_payload["stream_id"]
    assert first_payload["stream_group_id"] == first_payload["stream_id"]
    assert second_payload["stream_group_id"] == first_payload["stream_id"]
    assert finished_payload["stream_group_id"] == first_payload["stream_id"]
    assert second_payload["tool_call_id"] == "call_chart"
    stream_context = consume_a2ui_stream_context("chart", tool_call_id="call_chart")
    assert stream_context == {
        "stream_id": "trace-1:a2ui:model-run-late:0",
        "stream_group_id": "trace-1:a2ui:model-run-late:0",
        "tool_call_id": "call_chart",
        "render_key": "chart",
        "run_id": "tool_chart",
    }


def test_a2ui_stream_bridge_keeps_one_component_when_model_run_id_drifts() -> None:
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
                    "args": '{"title":"产品功能使用趋势"',
                }
            ],
        ),
        model_run_id="model-run-a",
    )
    second_progress = pipeline.process_chunk(
        AIMessageChunk(
            content="",
            tool_call_chunks=[
                {
                    "id": None,
                    "index": 0,
                    "name": None,
                    "args": ',"charts":[{"type":"line","items":[{"name":"W1","value":420}]}]}',
                }
            ],
        ),
        model_run_id="model-run-b",
    )
    tool_call_id = pipeline.bind_tool_run(
        run_id="tool_chart",
        tool_name="chart",
        params={
            "title": "产品功能使用趋势",
            "charts": [{"type": "line", "items": [{"name": "W1", "value": 420}]}],
        },
    )
    finished = bridge.finish_for_tool_call(tool_call_id, run_id="tool_chart")

    assert len(first_progress) == 1
    assert len(second_progress) == 1
    assert finished is not None
    first_payload = strip_a2ui_stream_marker(first_progress[0])
    second_payload = strip_a2ui_stream_marker(second_progress[0])
    finished_payload = strip_a2ui_stream_marker(finished)
    event_types = [
        a2ui_stream_event_type(item)
        for item in [first_progress[0], second_progress[0], finished]
    ]
    assert event_types == [
        DomainEventType.A2UI_STREAM_STARTED.value,
        DomainEventType.A2UI_STREAM_CHUNK.value,
        DomainEventType.A2UI_STREAM_FINISHED.value,
    ]
    assert second_payload["stream_id"] == first_payload["stream_id"]
    assert finished_payload["stream_id"] == first_payload["stream_id"]
    assert second_payload["stream_group_id"] == first_payload["stream_id"]
    assert second_payload["stream"]["parsed_payload"] == {
        "title": "产品功能使用趋势",
        "charts": [{"type": "line", "items": [{"name": "W1", "value": 420}]}],
    }
    stream_context = consume_a2ui_stream_context("chart", tool_call_id=tool_call_id)
    assert stream_context == {
        "stream_id": first_payload["stream_id"],
        "stream_group_id": first_payload["stream_id"],
        "tool_call_id": tool_call_id,
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
