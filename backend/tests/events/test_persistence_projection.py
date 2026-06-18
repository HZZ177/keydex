from __future__ import annotations

from typing import Any

import pytest

from backend.app.events import DomainEvent, DomainEventType, PersistenceProjection
from backend.app.storage import StorageRepositories, init_database


def _repositories(tmp_path) -> StorageRepositories:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    repositories.sessions.create(
        session_id="ses_persist",
        user_id="local-user",
        scene_id="desktop-agent",
    )
    return repositories


def _event(
    event_type: DomainEventType,
    payload: dict[str, Any],
    *,
    timestamp_ms: int = 100,
) -> DomainEvent:
    return DomainEvent(
        event_type=event_type.value,
        source="test",
        payload=payload,
        trace_id="trace_1",
        original_session_id="ses_persist",
        active_session_id="ses_persist",
        run_id="run_1",
        turn_index=1,
        timestamp_ms=timestamp_ms,
    )


@pytest.mark.asyncio
async def test_persistence_projection_batches_continuous_streams_on_flush(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    projection = PersistenceProjection(
        repository=repositories.message_events,
        session_id="ses_persist",
        turn_index=1,
    )

    await projection.handle(_event(DomainEventType.LLM_STREAM, {"content": "你"}))
    await projection.handle(_event(DomainEventType.LLM_STREAM, {"content": "好"}))

    assert repositories.message_events.list_by_session("ses_persist") == []

    await projection.flush()
    events = repositories.message_events.list_by_session("ses_persist")

    assert len(events) == 1
    assert events[0].action == "stream_batch"
    assert events[0].data["content"] == "你好"
    assert events[0].data["_canonical"]["event_type"] == "llm.stream"


@pytest.mark.asyncio
async def test_persistence_projection_flushes_stream_before_tool_start(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    projection = PersistenceProjection(
        repository=repositories.message_events,
        session_id="ses_persist",
        turn_index=1,
    )

    await projection.handle(_event(DomainEventType.LLM_STREAM, {"content": "读取"}))
    await projection.handle(
        _event(
            DomainEventType.LLM_TOOL_STARTED,
            {"tool": "read_file", "run_id": "tool_1", "params": {"path": "a.py"}},
        )
    )

    events = repositories.message_events.list_by_session("ses_persist")

    assert [event.action for event in events] == ["stream_batch", "tool_start"]
    assert events[1].data["tool"] == "read_file"
    assert events[1].data["_canonical"]["action"] == "tool_start"


@pytest.mark.asyncio
async def test_persistence_projection_writes_tool_end_and_completed_payload(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    projection = PersistenceProjection(
        repository=repositories.message_events,
        session_id="ses_persist",
        turn_index=1,
    )

    await projection.handle(
        _event(DomainEventType.LLM_TOOL_FINISHED, {"tool": "read_file", "result": "ok"})
    )
    await projection.handle(
        _event(
            DomainEventType.TURN_COMPLETED,
            {
                "trace_id": "trace_1",
                "final_content": "完成",
                "latest_llm_token_usage": {"input_tokens": 1, "output_tokens": 2},
            },
        )
    )

    events = repositories.message_events.list_by_session("ses_persist")

    assert [event.action for event in events] == ["tool_end", "completed"]
    assert events[1].data["ghost_footer"]["trace_id"] == "trace_1"
    assert events[1].data["ghost_footer"]["latest_llm_token_usage"] == {
        "input_tokens": 1,
        "output_tokens": 2,
    }


@pytest.mark.asyncio
async def test_persistence_projection_keeps_subagent_stream_separate(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    projection = PersistenceProjection(
        repository=repositories.message_events,
        session_id="ses_persist",
        turn_index=1,
    )

    await projection.handle(_event(DomainEventType.LLM_STREAM, {"content": "主"}))
    await projection.handle(
        _event(
            DomainEventType.LLM_STREAM,
            {
                "content": "子",
                "is_subagent": True,
                "subagent_id": "sub_1",
                "subagent_name": "worker",
            },
        )
    )
    await projection.flush()

    events = repositories.message_events.list_by_session("ses_persist")

    assert [event.data["content"] for event in events] == ["主", "子"]
    assert events[1].data["is_subagent"] is True
    assert events[1].data["subagent_id"] == "sub_1"


@pytest.mark.asyncio
async def test_persistence_projection_propagates_flush_errors() -> None:
    class FailingRepository:
        def append(self, **_: Any) -> None:
            raise RuntimeError("append failed")

    projection = PersistenceProjection(
        repository=FailingRepository(),
        session_id="ses_persist",
        turn_index=1,
    )

    await projection.handle(_event(DomainEventType.LLM_STREAM, {"content": "x"}))

    with pytest.raises(RuntimeError, match="append failed"):
        await projection.flush()
