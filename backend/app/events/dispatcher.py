from __future__ import annotations

from collections.abc import Awaitable, Callable, Iterable
from typing import Any, Protocol

from backend.app.events.domain import DomainEvent
from backend.app.events.event_types import ensure_known_event_type

ProjectionConsumer = Callable[[DomainEvent], Awaitable[None]]
ProjectionFlusher = Callable[[], Awaitable[None]]


class Projection(Protocol):
    async def handle(self, event: DomainEvent) -> None:
        ...

    async def flush(self) -> None:
        ...


class EventDispatcher:
    def __init__(self, consumers: Iterable[ProjectionConsumer] | None = None) -> None:
        self._consumers: list[ProjectionConsumer] = []
        self._flushers: list[ProjectionFlusher] = []
        for consumer in consumers or ():
            self.register(consumer)

    @property
    def consumers(self) -> tuple[ProjectionConsumer, ...]:
        return tuple(self._consumers)

    def register(self, consumer: ProjectionConsumer | None) -> None:
        if consumer is None:
            return
        self._consumers.append(consumer)

    def register_projection(self, projection: Projection) -> None:
        self.register(projection.handle)
        self._flushers.append(projection.flush)

    async def emit(self, event: DomainEvent) -> None:
        ensure_known_event_type(event.event_type)
        errors: list[BaseException] = []
        for consumer in self._consumers:
            try:
                await consumer(event)
            except BaseException as exc:
                errors.append(exc)
        if errors:
            raise errors[0]

    async def emit_event(
        self,
        *,
        event_type: str,
        source: str,
        payload: dict[str, Any],
        trace_id: str | None = None,
        user_id: str | None = None,
        original_session_id: str | None = None,
        active_session_id: str | None = None,
        run_id: str | None = None,
        turn_index: int | None = None,
        tags: dict[str, Any] | None = None,
    ) -> DomainEvent:
        event = DomainEvent(
            event_type=event_type,
            source=source,
            payload=payload,
            trace_id=trace_id,
            user_id=user_id,
            original_session_id=original_session_id,
            active_session_id=active_session_id,
            run_id=run_id,
            turn_index=turn_index,
            tags=tags or {},
        )
        await self.emit(event)
        return event

    async def flush(self) -> None:
        errors: list[BaseException] = []
        for flusher in self._flushers:
            try:
                await flusher()
            except BaseException as exc:
                errors.append(exc)
        if errors:
            raise errors[0]

    def clone_with_consumers(self, consumers: Iterable[ProjectionConsumer]) -> EventDispatcher:
        clone = EventDispatcher(self._consumers)
        clone._flushers = list(self._flushers)
        for consumer in consumers:
            clone.register(consumer)
        return clone

