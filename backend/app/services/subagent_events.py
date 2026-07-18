from __future__ import annotations

import asyncio
from typing import Any

from backend.app.events import (
    ChatProjection,
    DomainEvent,
    DomainEventType,
    EventDispatcher,
    PersistenceProjection,
)
from backend.app.subagents.models import SubagentRunSnapshot


class _BroadcastAdapter:
    def __init__(self, manager: Any) -> None:
        self._manager = manager

    async def send(self, *, session_id: str, action: str, data: dict[str, Any]) -> bool:
        return await self._manager.broadcast(
            session_id=session_id,
            action=action,
            data=data,
        )


class SubagentRunEventPublisher:
    """Persist and broadcast one full, versioned snapshot per committed Run version."""

    def __init__(self, *, repositories: Any, chat_stream_manager: Any | None = None) -> None:
        self._repositories = repositories
        self._chat_stream_manager = chat_stream_manager
        self._publish_lock = asyncio.Lock()

    async def publish(self, snapshot: SubagentRunSnapshot) -> None:
        turn_index = self._resolve_parent_turn_index(snapshot)
        event = self.build_event(snapshot, turn_index=turn_index)
        event_id = str(event.tags["event_id"])
        async with self._publish_lock:
            if self._repositories.message_events.get(event_id) is not None:
                return
            dispatcher = EventDispatcher()
            dispatcher.register_projection(
                PersistenceProjection(
                    repository=self._repositories.message_events,
                    session_id=snapshot.parent_session_id,
                    turn_index=turn_index,
                )
            )
            if self._chat_stream_manager is not None:
                dispatcher.register_projection(
                    ChatProjection(_BroadcastAdapter(self._chat_stream_manager))
                )
            await dispatcher.emit(event)
            await dispatcher.flush()

    @staticmethod
    def build_event(
        snapshot: SubagentRunSnapshot,
        *,
        turn_index: int = 0,
    ) -> DomainEvent:
        event_key = f"subagent_run:{snapshot.run_id}:{snapshot.version}"
        payload = snapshot.model_dump(mode="json")
        payload["event_key"] = event_key
        payload["session_id"] = snapshot.parent_session_id
        return DomainEvent(
            event_type=DomainEventType.SUBAGENT_RUN_UPDATED.value,
            source="subagent_runtime",
            payload=payload,
            trace_id=snapshot.parent_trace_id,
            original_session_id=snapshot.parent_session_id,
            active_session_id=snapshot.parent_session_id,
            run_id=snapshot.run_id,
            turn_index=turn_index,
            tags={"event_id": event_key},
        )

    def _resolve_parent_turn_index(self, snapshot: SubagentRunSnapshot) -> int:
        parent_trace_id = str(snapshot.parent_trace_id or "").strip()
        if not parent_trace_id:
            return 0
        trace = self._repositories.trace_records.get(parent_trace_id)
        if trace is None or trace.session_id != snapshot.parent_session_id:
            return 0
        return max(0, int(trace.turn_index))
