from __future__ import annotations

from typing import Any, Protocol

from backend.app.core.logger import logger
from backend.app.events.actions import ChatAction
from backend.app.events.domain import DomainEvent
from backend.app.events.event_types import DomainEventType


class ChatProjectionAdapter(Protocol):
    async def send(self, *, session_id: str, action: str, data: dict[str, Any]) -> bool: ...


class ChatProjection:
    EVENT_TYPE_TO_ACTION = {
        DomainEventType.LLM_STREAM: ChatAction.STREAM,
        DomainEventType.MESSAGE_SYSTEM_CREATED: ChatAction.SYSTEM_MESSAGE,
        DomainEventType.LLM_TOOL_STARTED: ChatAction.TOOL_START,
        DomainEventType.LLM_TOOL_PROGRESS: ChatAction.TOOL_PROGRESS,
        DomainEventType.LLM_TOOL_FINISHED: ChatAction.TOOL_END,
        DomainEventType.LLM_TOOL_FAILED: ChatAction.TOOL_END,
        DomainEventType.APPROVAL_REQUESTED: ChatAction.APPROVAL_REQUESTED,
        DomainEventType.APPROVAL_RESOLVED: ChatAction.APPROVAL_RESOLVED,
        DomainEventType.SUBAGENT_STARTED: ChatAction.SUBAGENT_START,
        DomainEventType.SUBAGENT_FINISHED: ChatAction.SUBAGENT_END,
        DomainEventType.SUBAGENT_FAILED: ChatAction.SUBAGENT_ERROR,
        DomainEventType.TURN_CANCELLED: ChatAction.CANCELLED,
        DomainEventType.TURN_FAILED: ChatAction.ERROR,
        DomainEventType.TURN_STARTED: ChatAction.TURN_STARTED,
        DomainEventType.TURN_COMPLETED: ChatAction.COMPLETED,
        DomainEventType.TASK_FINISHED_CHAT: ChatAction.TASK_RESULT,
        DomainEventType.THREAD_TASK_UPDATED: ChatAction.TASK_UPDATED,
        DomainEventType.THREAD_TASK_DELETED: ChatAction.TASK_DELETED,
        DomainEventType.THREAD_TASK_RUN_STARTED: ChatAction.TASK_RUN_STARTED,
        DomainEventType.THREAD_TASK_RUN_FINISHED: ChatAction.TASK_RUN_FINISHED,
        DomainEventType.THREAD_TASK_STATUS_UPDATED: ChatAction.THREAD_TASK_STATUS,
        DomainEventType.REASONING_STREAM: ChatAction.REASONING,
        DomainEventType.REASONING_FINISHED: ChatAction.REASONING,
        DomainEventType.SESSION_TITLE_UPDATED: ChatAction.SESSION_TITLE_UPDATED,
        DomainEventType.MIDDLEWARE_PROGRESS: ChatAction.MIDDLEWARE_PROGRESS,
    }
    _REASONING_EVENT_TYPES = {
        DomainEventType.REASONING_STREAM,
        DomainEventType.REASONING_FINISHED,
    }

    def __init__(self, adapter: ChatProjectionAdapter) -> None:
        self.adapter = adapter

    async def handle(self, event: DomainEvent) -> None:
        event_type = DomainEventType(event.event_type)
        action = self.EVENT_TYPE_TO_ACTION.get(event_type)
        if action is None:
            return

        session_id = event.original_session_id or event.active_session_id or ""
        if event_type in self._REASONING_EVENT_TYPES:
            await self._send_reasoning_event(event=event, action=action, session_id=session_id)
            return

        payload = dict(event.payload or {})
        payload.setdefault("session_id", session_id)
        payload.setdefault("trace_id", event.trace_id)
        payload.setdefault("turn_index", event.turn_index)
        payload.setdefault("timestamp_ms", event.timestamp_ms)
        sent = await self.adapter.send(session_id=session_id, action=action.value, data=payload)
        logger.debug(
            f"[ChatProjection] 推送实时事件 | session_id={session_id} | "
            f"action={action.value} | event_type={event.event_type} | sent={sent}"
        )

    async def _send_reasoning_event(
        self,
        *,
        event: DomainEvent,
        action: ChatAction,
        session_id: str,
    ) -> None:
        payload = event.payload or {}
        chat_data: dict[str, Any] = {
            "session_id": session_id,
            "kind": payload.get("kind", "reasoning"),
            "done": payload.get("done", False),
            "trace_id": event.trace_id or payload.get("trace_id"),
            "timestamp_ms": event.timestamp_ms,
        }
        if "content" in payload:
            chat_data["content"] = payload["content"]
        if "text" in payload:
            chat_data["text"] = payload["text"]
        if "cancel_main" in payload:
            chat_data["cancel_main"] = payload["cancel_main"]
        sent = await self.adapter.send(session_id=session_id, action=action.value, data=chat_data)
        logger.debug(
            f"[ChatProjection] 推送 reasoning 事件 | session_id={session_id} | "
            f"action={action.value} | done={chat_data.get('done')} | sent={sent}"
        )

    async def flush(self) -> None:
        return None
