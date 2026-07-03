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
    ) -> Any: ...


class PersistenceProjection:
    EVENT_TYPE_TO_ACTION = {
        DomainEventType.MESSAGE_USER_CREATED: ReplayAction.USER_MESSAGE,
        DomainEventType.MESSAGE_SYSTEM_CREATED: ReplayAction.SYSTEM_MESSAGE,
        DomainEventType.MESSAGE_AI_CREATED: ReplayAction.AI_MESSAGE,
        DomainEventType.LLM_TOOL_STARTED: ReplayAction.TOOL_START,
        DomainEventType.LLM_TOOL_FINISHED: ReplayAction.TOOL_END,
        DomainEventType.LLM_TOOL_FAILED: ReplayAction.TOOL_END,
        DomainEventType.APPROVAL_REQUESTED: ReplayAction.APPROVAL_REQUESTED,
        DomainEventType.APPROVAL_RESOLVED: ReplayAction.APPROVAL_RESOLVED,
        DomainEventType.SUBAGENT_STARTED: ReplayAction.SUBAGENT_START,
        DomainEventType.SUBAGENT_FINISHED: ReplayAction.SUBAGENT_END,
        DomainEventType.SUBAGENT_FAILED: ReplayAction.SUBAGENT_ERROR,
        DomainEventType.MEMORY_RECALLED: ReplayAction.MEMORY_RECALLED,
        DomainEventType.TURN_CANCELLED: ReplayAction.CANCELLED,
        DomainEventType.TURN_FAILED: ReplayAction.ERROR,
        DomainEventType.TURN_STARTED: ReplayAction.TURN_STARTED,
        DomainEventType.TURN_COMPLETED: ReplayAction.COMPLETED,
        DomainEventType.THREAD_TASK_UPDATED: ReplayAction.TASK_UPDATED,
        DomainEventType.THREAD_TASK_DELETED: ReplayAction.TASK_DELETED,
        DomainEventType.THREAD_TASK_RUN_STARTED: ReplayAction.TASK_RUN_STARTED,
        DomainEventType.THREAD_TASK_RUN_FINISHED: ReplayAction.TASK_RUN_FINISHED,
        DomainEventType.THREAD_TASK_STATUS_UPDATED: ReplayAction.THREAD_TASK_STATUS,
        DomainEventType.REASONING_FINISHED: ReplayAction.REASONING,
        DomainEventType.MIDDLEWARE_PROGRESS: ReplayAction.MIDDLEWARE_PROGRESS,
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
        self._reasoning_buffers: dict[str, dict[str, Any]] = {}
        self._flushed_reasoning_text: dict[str, str] = {}

    async def handle(self, event: DomainEvent) -> None:
        if not self._session_id:
            return
        event_type = DomainEventType(event.event_type)

        if event_type == DomainEventType.REASONING_STREAM:
            await self._flush_stream_buffers()
            self._collect_reasoning(event)
            return
        if event_type == DomainEventType.LLM_STREAM:
            await self._flush_reasoning_buffers()
            self._collect_stream(event)
            return
        if event_type == DomainEventType.REASONING_FINISHED:
            await self._handle_reasoning_finished(event)
            return

        action = self.EVENT_TYPE_TO_ACTION.get(event_type)
        if action is None:
            return

        await self.flush()
        await self._save(action.value, self._build_replay_payload(event, action.value), event)

    async def flush(self) -> None:
        await self._flush_stream_buffers()
        await self._flush_reasoning_buffers()

    async def _flush_stream_buffers(self) -> None:
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

    async def _flush_reasoning_buffers(self) -> None:
        for key in list(self._reasoning_buffers):
            await self._flush_reasoning_buffer(key)

    async def _flush_reasoning_buffer(self, key: str) -> None:
        buffer_item = self._reasoning_buffers.pop(key, None)
        if not buffer_item:
            return
        content = str(buffer_item.get("content") or "")
        if not content:
            return
        meta = dict(buffer_item.get("meta") or {})
        event = buffer_item.get("event")
        payload = {
            "kind": meta.get("kind", "reasoning"),
            "text": content,
            "done": bool(meta.get("done", False)),
        }
        if "cancel_main" in meta:
            payload["cancel_main"] = meta.get("cancel_main")
        if trace_id := meta.get("trace_id"):
            payload["trace_id"] = trace_id
        message_time_ms = meta.get("messageTimeMs") or getattr(event, "timestamp_ms", None)
        await self._save(
            ReplayAction.REASONING.value,
            self._wrap_payload(
                ReplayAction.REASONING.value,
                payload,
                event_type=DomainEventType.REASONING_STREAM.value,
                source=getattr(event, "source", "persistence_projection"),
                run_id=getattr(event, "run_id", None),
                timestamp_ms=getattr(event, "timestamp_ms", None),
                message_time_ms=message_time_ms,
            ),
            event,
        )
        self._flushed_reasoning_text[key] = (
            self._flushed_reasoning_text.get(key, "") + content
        )

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

    def _collect_reasoning(self, event: DomainEvent) -> None:
        payload = event.payload or {}
        content = str(payload.get("text", payload.get("content", "")) or "")
        if not content:
            return
        key = self._reasoning_key(event, payload)
        buffer_item = self._reasoning_buffers.setdefault(
            key,
            {
                "content": "",
                "meta": {
                    "kind": payload.get("kind", "reasoning"),
                    "messageTimeMs": payload.get("messageTimeMs") or event.timestamp_ms,
                    "trace_id": payload.get("trace_id") or event.trace_id,
                },
                "event": event,
            },
        )
        buffer_item["content"] = str(buffer_item["content"]) + content
        meta = dict(buffer_item.get("meta") or {})
        meta.update(
            {
                "kind": payload.get("kind", meta.get("kind", "reasoning")),
                "trace_id": payload.get("trace_id") or meta.get("trace_id") or event.trace_id,
            }
        )
        if "cancel_main" in payload:
            meta["cancel_main"] = payload.get("cancel_main")
        buffer_item["meta"] = meta
        buffer_item["event"] = event

    async def _handle_reasoning_finished(self, event: DomainEvent) -> None:
        await self._flush_stream_buffers()
        payload = dict(event.payload or {})
        final_text = str(payload.get("text", payload.get("content", "")) or "")
        key = self._reasoning_key(event, payload)
        already_flushed = self._flushed_reasoning_text.get(key, "")
        buffer_item = self._reasoning_buffers.get(key)
        if buffer_item is not None:
            text = str(buffer_item.get("content") or "")
            if final_text:
                if final_text.startswith(already_flushed):
                    text = final_text[len(already_flushed) :]
                else:
                    text = final_text
            buffer_item["content"] = text
            meta = dict(buffer_item.get("meta") or {})
            meta.update(
                {
                    "kind": payload.get("kind", meta.get("kind", "reasoning")),
                    "done": True,
                    "trace_id": payload.get("trace_id") or meta.get("trace_id") or event.trace_id,
                }
            )
            if "cancel_main" in payload:
                meta["cancel_main"] = payload.get("cancel_main")
            if payload.get("messageTimeMs") is not None:
                meta["messageTimeMs"] = payload.get("messageTimeMs")
            buffer_item["meta"] = meta
            buffer_item["event"] = event
            await self._flush_reasoning_buffer(key)
            return

        if not final_text:
            return
        if already_flushed:
            if final_text == already_flushed:
                return
            if final_text.startswith(already_flushed):
                final_text = final_text[len(already_flushed) :]
        if not final_text:
            return
        await self._save(
            ReplayAction.REASONING.value,
            self._wrap_payload(
                ReplayAction.REASONING.value,
                {
                    **payload,
                    "text": final_text,
                    "done": True,
                },
                event_type=DomainEventType.REASONING_FINISHED.value,
                source=event.source,
                run_id=event.run_id,
                timestamp_ms=event.timestamp_ms,
                message_time_ms=(
                    payload.get("messageTimeMs")
                    or payload.get("end_time")
                    or event.timestamp_ms
                ),
            ),
            event,
        )
        self._flushed_reasoning_text[key] = already_flushed + final_text

    @staticmethod
    def _reasoning_key(event: DomainEvent, payload: dict[str, Any]) -> str:
        kind = str(payload.get("kind") or "reasoning")
        return f"{event.run_id or 'reasoning'}:{kind}"

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
