from __future__ import annotations

import pytest

from backend.app.events import DomainEvent, DomainEventType, EventDispatcher


def _event() -> DomainEvent:
    return DomainEvent(
        event_type=DomainEventType.TURN_STARTED.value,
        source="test",
        payload={"ok": True},
    )


@pytest.mark.asyncio
async def test_dispatcher_delivers_event_to_multiple_consumers_in_order() -> None:
    received: list[str] = []

    async def first(event: DomainEvent) -> None:
        received.append(f"first:{event.event_type}")

    async def second(event: DomainEvent) -> None:
        received.append(f"second:{event.payload['ok']}")

    dispatcher = EventDispatcher([first, second])

    await dispatcher.emit(_event())

    assert received == ["first:turn.started", "second:True"]


@pytest.mark.asyncio
async def test_dispatcher_does_not_swallow_projection_errors() -> None:
    received: list[str] = []

    async def failing(_: DomainEvent) -> None:
        received.append("failing")
        raise RuntimeError("projection failed")

    async def still_called(_: DomainEvent) -> None:
        received.append("still_called")

    dispatcher = EventDispatcher([failing, still_called])

    with pytest.raises(RuntimeError, match="projection failed"):
        await dispatcher.emit(_event())

    assert received == ["failing", "still_called"]


@pytest.mark.asyncio
async def test_dispatcher_rejects_unknown_event_type() -> None:
    dispatcher = EventDispatcher()
    event = DomainEvent(event_type="not.real", source="test", payload={})

    with pytest.raises(ValueError, match="未知 DomainEventType"):
        await dispatcher.emit(event)


@pytest.mark.asyncio
async def test_dispatcher_emit_event_builds_and_dispatches_domain_event() -> None:
    received: list[DomainEvent] = []

    async def consumer(event: DomainEvent) -> None:
        received.append(event)

    dispatcher = EventDispatcher([consumer])

    event = await dispatcher.emit_event(
        event_type=DomainEventType.LLM_STREAM.value,
        source="event_handler",
        payload={"content": "hello"},
        trace_id="trace_1",
        original_session_id="ses_1",
    )

    assert received == [event]
    assert event.trace_id == "trace_1"
    assert event.original_session_id == "ses_1"


@pytest.mark.asyncio
async def test_dispatcher_flushes_registered_projections_in_order() -> None:
    calls: list[str] = []

    class ProjectionStub:
        def __init__(self, name: str) -> None:
            self.name = name

        async def handle(self, event: DomainEvent) -> None:
            calls.append(f"{self.name}:handle:{event.event_type}")

        async def flush(self) -> None:
            calls.append(f"{self.name}:flush")

    dispatcher = EventDispatcher()
    dispatcher.register_projection(ProjectionStub("a"))
    dispatcher.register_projection(ProjectionStub("b"))

    await dispatcher.emit(_event())
    await dispatcher.flush()

    assert calls == [
        "a:handle:turn.started",
        "b:handle:turn.started",
        "a:flush",
        "b:flush",
    ]
