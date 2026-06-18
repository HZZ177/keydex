from __future__ import annotations

import pytest

from backend.app.events import DomainEvent, DomainEventType, TurnCompletedAggregator


def _event(event_type: DomainEventType, payload: dict, timestamp_ms: int = 100) -> DomainEvent:
    return DomainEvent(
        event_type=event_type.value,
        source="test",
        payload=payload,
        trace_id="trace_1",
        original_session_id="ses_1",
        turn_index=1,
        timestamp_ms=timestamp_ms,
    )


@pytest.mark.asyncio
async def test_completed_aggregator_builds_basic_completed_payload() -> None:
    aggregator = TurnCompletedAggregator()

    await aggregator.handle(_event(DomainEventType.LLM_STREAM, {"content": "你"}))
    await aggregator.handle(_event(DomainEventType.LLM_STREAM, {"content": "好"}))

    payload = aggregator.build_completed_data(
        session_id="ses_1",
        trace_id="trace_1",
        user_id="local-user",
        scene_id="desktop-agent",
        latest_llm_token_usage={"input_tokens": 1, "output_tokens": 2},
    )

    assert payload["status"] == "completed"
    assert payload["final_content"] == "你好"
    assert payload["latest_llm_token_usage"] == {"input_tokens": 1, "output_tokens": 2}
    assert payload["trace_query_context"]["trace_id"] == "trace_1"
    assert payload["events"] == [
        {
            "action": "ai_message",
            "data": {
                "content": "你好",
                "is_subagent": False,
                "subagent_name": None,
                "subagent_id": None,
                "messageTimeMs": 100,
            },
        }
    ]


@pytest.mark.asyncio
async def test_completed_aggregator_keeps_tool_events_in_order() -> None:
    aggregator = TurnCompletedAggregator()

    await aggregator.handle(_event(DomainEventType.LLM_STREAM, {"content": "准备"}))
    await aggregator.handle(
        _event(DomainEventType.LLM_TOOL_STARTED, {"tool": "read_file", "run_id": "tool_1"})
    )
    await aggregator.handle(
        _event(DomainEventType.LLM_TOOL_FINISHED, {"tool": "read_file", "result": "ok"})
    )

    payload = aggregator.build_completed_data(session_id="ses_1", trace_id="trace_1")

    assert [event["action"] for event in payload["events"]] == [
        "ai_message",
        "tool_start",
        "tool_end",
    ]


@pytest.mark.asyncio
async def test_completed_aggregator_records_reasoning_message() -> None:
    aggregator = TurnCompletedAggregator()

    await aggregator.handle(
        _event(
            DomainEventType.REASONING_FINISHED,
            {"kind": "initial_response", "text": "正在分析", "cancel_main": False},
        )
    )

    payload = aggregator.build_completed_data(session_id="ses_1", trace_id="trace_1")

    assert payload["reasoning_routed"] is True
    assert payload["events"] == [
        {
            "action": "reasoning_message",
            "data": {
                "kind": "initial_response",
                "text": "正在分析",
                "done": True,
                "messageTimeMs": 100,
                "cancel_main": False,
            },
        }
    ]


@pytest.mark.asyncio
async def test_completed_aggregator_builds_failed_payload_without_fake_tokens() -> None:
    aggregator = TurnCompletedAggregator()
    await aggregator.handle(_event(DomainEventType.LLM_STREAM, {"content": "半截"}))

    payload = aggregator.build_failed_data(
        session_id="ses_1",
        trace_id="trace_1",
        error="模型失败",
    )

    assert payload["status"] == "failed"
    assert payload["error"] == "模型失败"
    assert payload["final_content"] == "半截"
    assert payload["chain_token_usage"] == {}
    assert payload["latest_llm_token_usage"] == {}


@pytest.mark.asyncio
async def test_completed_aggregator_builds_cancelled_payload() -> None:
    aggregator = TurnCompletedAggregator()
    await aggregator.handle(_event(DomainEventType.LLM_STREAM, {"content": "已输出"}))

    payload = aggregator.build_cancelled_data(
        session_id="ses_1",
        trace_id="trace_1",
        reason="user",
    )

    assert payload["status"] == "cancelled"
    assert payload["reason"] == "user"
    assert payload["final_content"] == "已输出"
