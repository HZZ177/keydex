from __future__ import annotations

import asyncio
from typing import Any

from backend.app.core.logger import logger
from backend.app.events import (
    ChatProjection,
    DomainEvent,
    DomainEventType,
    EventDispatcher,
    PersistenceProjection,
)


class _BroadcastAdapter:
    def __init__(self, manager: Any) -> None:
        self._manager = manager

    async def send(self, *, session_id: str, action: str, data: dict[str, Any]) -> bool:
        return await self._manager.broadcast(session_id=session_id, action=action, data=data)


class ThreadTaskEventPublisher:
    def __init__(self, *, repositories: Any, chat_stream_manager: Any | None = None) -> None:
        self._repositories = repositories
        self._chat_stream_manager = chat_stream_manager

    async def publish_async(
        self,
        *,
        event_type: DomainEventType,
        session_id: str,
        payload: dict[str, Any],
        trace_id: str | None = None,
        run_id: str | None = None,
        turn_index: int | None = None,
    ) -> None:
        resolved_turn_index = int(turn_index or 0)
        event = self._build_event(
            event_type=event_type,
            session_id=session_id,
            payload=payload,
            trace_id=trace_id,
            run_id=run_id,
            turn_index=resolved_turn_index,
        )
        await self._dispatch(event, session_id=session_id, turn_index=resolved_turn_index)

    def publish(
        self,
        *,
        event_type: DomainEventType,
        session_id: str,
        payload: dict[str, Any],
        trace_id: str | None = None,
        run_id: str | None = None,
        turn_index: int | None = None,
    ) -> None:
        resolved_turn_index = int(turn_index or 0)
        event = self._build_event(
            event_type=event_type,
            session_id=session_id,
            payload=payload,
            trace_id=trace_id,
            run_id=run_id,
            turn_index=resolved_turn_index,
        )
        self._dispatch_background(event, session_id=session_id, turn_index=resolved_turn_index)

    @staticmethod
    def _build_event(
        *,
        event_type: DomainEventType,
        session_id: str,
        payload: dict[str, Any],
        trace_id: str | None,
        run_id: str | None,
        turn_index: int,
    ) -> DomainEvent:
        return DomainEvent(
            event_type=event_type.value,
            source="thread_task",
            payload={**payload, "session_id": session_id},
            trace_id=trace_id,
            original_session_id=session_id,
            active_session_id=session_id,
            run_id=run_id,
            turn_index=turn_index,
        )

    async def _dispatch(self, event: DomainEvent, *, session_id: str, turn_index: int) -> None:
        dispatcher = EventDispatcher()
        dispatcher.register_projection(
            PersistenceProjection(
                repository=self._repositories.message_events,
                session_id=session_id,
                turn_index=turn_index,
            )
        )
        if self._chat_stream_manager is not None:
            dispatcher.register_projection(
                ChatProjection(self._chat_adapter(self._chat_stream_manager))
            )
        await dispatcher.emit(event)
        await dispatcher.flush()

    @staticmethod
    def _chat_adapter(chat_stream_manager: Any) -> Any:
        if callable(getattr(chat_stream_manager, "send", None)):
            return chat_stream_manager
        return _BroadcastAdapter(chat_stream_manager)

    def _dispatch_background(self, event: DomainEvent, *, session_id: str, turn_index: int) -> None:
        async def run() -> None:
            await self._dispatch(event, session_id=session_id, turn_index=turn_index)

        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            asyncio.run(run())
            return

        task = loop.create_task(run())
        task.add_done_callback(_log_background_error)


def _log_background_error(task: asyncio.Task) -> None:
    try:
        task.result()
    except Exception as exc:
        logger.opt(exception=True).warning(
            f"[ThreadTaskEventPublisher] 后台事件发送失败 | error={exc}"
        )
