from __future__ import annotations

from typing import Any, Protocol

from backend.app.core.ids import new_id
from backend.app.core.logger import logger
from backend.app.events.actions import ReplayAction
from backend.app.events.domain import DomainEvent
from backend.app.events.event_types import DomainEventType


class MessageEventAppender(Protocol):
    def append(
        self,
        *,
        event_id: str,
        session_id: str,
        turn_index: int,
        action: str,
        data: dict[str, Any] | None = None,
        trace_record_id: str | None = None,
    ) -> Any:
        ...


class PersistenceProjection:
    EVENT_TYPE_TO_ACTION = {
        DomainEventType.MESSAGE_USER_CREATED: ReplayAction.USER_MESSAGE,
        DomainEventType.MESSAGE_SYSTEM_CREATED: ReplayAction.SYSTEM_MESSAGE,
        DomainEventType.MESSAGE_AI_CREATED: ReplayAction.AI_MESSAGE,
        DomainEventType.LLM_TOOL_STARTED: ReplayAction.TOOL_START,
        DomainEventType.LLM_TOOL_FINISHED: ReplayAction.TOOL_END,
        DomainEventType.LLM_TOOL_FAILED: ReplayAction.TOOL_END,
        DomainEventType.SUBAGENT_STARTED: ReplayAction.SUBAGENT_START,
        DomainEventType.SUBAGENT_FINISHED: ReplayAction.SUBAGENT_END,
        DomainEventType.SUBAGENT_FAILED: ReplayAction.SUBAGENT_ERROR,
        DomainEventType.MEMORY_RECALLED: ReplayAction.MEMORY_RECALLED,
        DomainEventType.TURN_CANCELLED: ReplayAction.CANCELLED,
        DomainEventType.TURN_FAILED: ReplayAction.ERROR,
        DomainEventType.TURN_COMPLETED: ReplayAction.COMPLETED,
        DomainEventType.REASONING_FINISHED: ReplayAction.REASONING,
    }

    def __init__(
        self,
        *,
        repository: MessageEventAppender,
        session_id: str,
        turn_index: int,
    ) -> None:
        self._repository = repository
        self._session_id = session_id
        self._turn_index = turn_index
        self._stream_buffer = ""
        self._stream_buffer_event: DomainEvent | None = None
        self._subagent_stream_buffers: dict[str, dict[str, Any]] = {}

    async def handle(self, event: DomainEvent) -> None:
        if not self._session_id:
            return
        event_type = DomainEventType(event.event_type)

        if event_type == DomainEventType.REASONING_STREAM:
            return
        if event_type == DomainEventType.LLM_STREAM:
            self._collect_stream(event)
            return

        action = self.EVENT_TYPE_TO_ACTION.get(event_type)
        if action is None:
            return

        await self.flush()
        await self._save(action.value, self._build_replay_payload(event, action.value), event)

    async def flush(self) -> None:
        if self._stream_buffer:
            event = self._stream_buffer_event
            await self._save(
                ReplayAction.STREAM_BATCH.value,
                self._wrap_payload(
                    ReplayAction.STREAM_BATCH.value,
                    {"content": self._stream_buffer},
                    event_type=DomainEventType.LLM_STREAM.value,
                    source=getattr(event, "source", "persistence_projection"),
                    run_id=getattr(event, "run_id", None),
                    timestamp_ms=getattr(event, "timestamp_ms", None),
                    message_time_ms=getattr(event, "timestamp_ms", None),
                ),
                event,
            )
            self._stream_buffer = ""
            self._stream_buffer_event = None

        for subagent_id, buffer_item in list(self._subagent_stream_buffers.items()):
            content = str(buffer_item.get("content") or "")
            if not content:
                continue
            meta = dict(buffer_item.get("meta") or {})
            event = buffer_item.get("event")
            await self._save(
                ReplayAction.STREAM_BATCH.value,
                self._wrap_payload(
                    ReplayAction.STREAM_BATCH.value,
                    {
                        "content": content,
                        "is_subagent": True,
                        "subagent_id": subagent_id,
                        "subagent_name": meta.get("subagent_name", ""),
                    },
                    event_type=DomainEventType.LLM_STREAM.value,
                    source=getattr(event, "source", "persistence_projection"),
                    run_id=getattr(event, "run_id", None),
                    timestamp_ms=getattr(event, "timestamp_ms", None),
                    message_time_ms=meta.get("messageTimeMs")
                    or getattr(event, "timestamp_ms", None),
                ),
                event,
            )
        self._subagent_stream_buffers.clear()

    def _collect_stream(self, event: DomainEvent) -> None:
        payload = event.payload or {}
        content = str(payload.get("content") or "")
        if not content:
            return

        subagent_id = payload.get("subagent_id")
        if payload.get("is_subagent") and subagent_id:
            buffer_item = self._subagent_stream_buffers.setdefault(
                str(subagent_id),
                {"content": "", "meta": payload, "event": event},
            )
            buffer_item["content"] = str(buffer_item["content"]) + content
            buffer_item["meta"] = payload
            buffer_item["event"] = event
            return

        self._stream_buffer += content
        self._stream_buffer_event = event

    def _build_replay_payload(self, event: DomainEvent, action: str) -> dict[str, Any]:
        payload = dict(event.payload or {})
        if DomainEventType(event.event_type) == DomainEventType.TURN_COMPLETED:
            payload = self._normalize_turn_completed_payload(payload)
        return self._wrap_payload(
            action,
            payload,
            event_type=event.event_type,
            source=event.source,
            run_id=event.run_id,
            timestamp_ms=event.timestamp_ms,
            message_time_ms=payload.get("messageTimeMs") or event.tags.get("messageTimeMs"),
        )

    @staticmethod
    def _normalize_turn_completed_payload(payload: dict[str, Any]) -> dict[str, Any]:
        normalized = dict(payload)
        trace_id = str(normalized.get("trace_id") or "").strip()
        normalized["ghost_footer"] = {
            "trace_id": trace_id,
            "chain_token_usage": normalized.get("chain_token_usage") or {},
            "latest_llm_token_usage": normalized.get("latest_llm_token_usage") or {},
            "trace_query_context": normalized.get("trace_query_context") or {},
        }
        return normalized

    @staticmethod
    def _wrap_payload(
        action: str,
        payload: dict[str, Any],
        *,
        event_type: str,
        source: str,
        run_id: str | None = None,
        timestamp_ms: int | None = None,
        message_time_ms: int | None = None,
    ) -> dict[str, Any]:
        wrapped = dict(payload)
        resolved_message_time_ms = message_time_ms if message_time_ms is not None else timestamp_ms
        if resolved_message_time_ms is not None and "messageTimeMs" not in wrapped:
            wrapped["messageTimeMs"] = resolved_message_time_ms
        wrapped["_canonical"] = {
            "schema_version": 2,
            "projection": "persistence",
            "action": action,
            "event_type": event_type,
            "source": source,
            "run_id": run_id,
            "timestamp_ms": timestamp_ms,
        }
        return wrapped

    async def _save(
        self,
        action: str,
        payload: dict[str, Any],
        event: DomainEvent | None,
    ) -> None:
        fallback_trace_id = event.trace_id if event else ""
        trace_record_id = str(payload.get("trace_record_id") or fallback_trace_id or "").strip()
        record = self._repository.append(
            event_id=new_id(),
            session_id=self._session_id,
            trace_record_id=trace_record_id or None,
            turn_index=self._turn_index,
            action=action,
            data=payload,
        )
        logger.debug(
            f"[PersistenceProjection] 保存消息事件 | session_id={self._session_id} | "
            f"turn_index={self._turn_index} | action={action} | event_id={record.id} | "
            f"seq={getattr(record, 'seq', '-')}"
        )
