from __future__ import annotations

from typing import Any

from backend.app.core.logger import logger
from backend.app.events.actions import CompletedEventItemAction
from backend.app.events.domain import DomainEvent
from backend.app.events.event_types import DomainEventType


def _build_trace_query_context(trace_id: str) -> dict[str, Any]:
    if not trace_id:
        return {}
    return {
        "trace_id": trace_id,
        "trace_record_id": trace_id,
    }


class TurnCompletedAggregator:
    def __init__(self) -> None:
        self.event_log: list[dict[str, Any]] = []
        self._stream_buffer_parts: list[str] = []
        self._stream_meta: dict[str, Any] = {}
        self._reasoning_routed = False
        self._first_token_at_ms: int | None = None

    @property
    def first_token_at_ms(self) -> int | None:
        return self._first_token_at_ms

    async def handle(self, event: DomainEvent) -> None:
        payload = dict(event.payload or {})
        payload.setdefault("timestamp_ms", event.timestamp_ms)
        self.collect_domain_event(event.event_type, payload)

    async def flush(self) -> None:
        self.flush_stream_buffer()

    def collect_domain_event(self, event_type: str, payload: dict[str, Any]) -> None:
        if event_type == DomainEventType.LLM_FIRST_TOKEN_RECEIVED.value:
            first_token_at_ms = payload.get("first_token_at_ms") or payload.get("timestamp_ms")
            if isinstance(first_token_at_ms, int | float) and not isinstance(first_token_at_ms, bool):
                resolved = int(first_token_at_ms)
                if self._first_token_at_ms is None or resolved < self._first_token_at_ms:
                    self._first_token_at_ms = resolved
            return
        if event_type == DomainEventType.LLM_STREAM.value:
            self._collect_stream(payload)
            return
        if event_type == DomainEventType.LLM_TOOL_STARTED.value:
            self.flush_stream_buffer()
            self._append_timed_event(CompletedEventItemAction.TOOL_START, payload)
            return
        if event_type in {
            DomainEventType.LLM_TOOL_FINISHED.value,
            DomainEventType.LLM_TOOL_FAILED.value,
        }:
            self.flush_stream_buffer()
            self._append_timed_event(CompletedEventItemAction.TOOL_END, payload)
            return
        if event_type == DomainEventType.REASONING_FINISHED.value:
            text = str((payload or {}).get("text", "") or "")
            if not text:
                return
            self.flush_stream_buffer()
            self._reasoning_routed = True
            data = {
                "kind": payload.get("kind"),
                "text": text,
                "done": True,
                "messageTimeMs": payload.get("messageTimeMs")
                or payload.get("end_time")
                or payload.get("timestamp_ms"),
            }
            if "cancel_main" in payload:
                data["cancel_main"] = payload.get("cancel_main")
            for timing_key in ("start_time", "end_time", "duration_ms"):
                if payload.get(timing_key) is not None:
                    data[timing_key] = payload[timing_key]
            self.event_log.append(
                {"action": CompletedEventItemAction.REASONING_MESSAGE.value, "data": data}
            )

    def flush_stream_buffer(self) -> None:
        if not self._stream_buffer_parts:
            return
        self.event_log.append(
            {
                "action": CompletedEventItemAction.AI_MESSAGE.value,
                "data": {
                    "content": "".join(self._stream_buffer_parts),
                    **self._stream_meta,
                    "messageTimeMs": self._stream_meta.get("messageTimeMs")
                    or self._stream_meta.get("timestamp_ms"),
                },
            }
        )
        self._stream_buffer_parts.clear()
        self._stream_meta.clear()

    def build_completed_data(
        self,
        *,
        session_id: str,
        trace_id: str,
        user_id: str = "",
        scene_id: str = "",
        chain_token_usage: dict[str, Any] | None = None,
        latest_llm_token_usage: dict[str, Any] | None = None,
        final_content: str = "",
        scene_name: str = "",
        scene_version_seq: int | None = None,
        trace_query_context: dict[str, Any] | None = None,
        reasoning_routed: bool | None = None,
    ) -> dict[str, Any]:
        return self._build_terminal_data(
            session_id=session_id,
            trace_id=trace_id,
            user_id=user_id,
            scene_id=scene_id,
            status="completed",
            chain_token_usage=chain_token_usage,
            latest_llm_token_usage=latest_llm_token_usage,
            final_content=final_content,
            scene_name=scene_name,
            scene_version_seq=scene_version_seq,
            trace_query_context=trace_query_context,
            reasoning_routed=reasoning_routed,
        )

    def build_cancelled_data(
        self,
        *,
        session_id: str,
        trace_id: str,
        user_id: str = "",
        scene_id: str = "",
        reason: str = "",
    ) -> dict[str, Any]:
        data = self._build_terminal_data(
            session_id=session_id,
            trace_id=trace_id,
            user_id=user_id,
            scene_id=scene_id,
            status="cancelled",
        )
        data["reason"] = reason
        return data

    def build_failed_data(
        self,
        *,
        session_id: str,
        trace_id: str,
        user_id: str = "",
        scene_id: str = "",
        error: Any = "",
    ) -> dict[str, Any]:
        data = self._build_terminal_data(
            session_id=session_id,
            trace_id=trace_id,
            user_id=user_id,
            scene_id=scene_id,
            status="failed",
        )
        data["error"] = error
        return data

    def _collect_stream(self, payload: dict[str, Any]) -> None:
        group_meta = {
            "is_subagent": payload.get("is_subagent", False),
            "subagent_name": payload.get("subagent_name"),
            "subagent_id": payload.get("subagent_id"),
        }
        current_group = {
            "is_subagent": self._stream_meta.get("is_subagent", False),
            "subagent_name": self._stream_meta.get("subagent_name"),
            "subagent_id": self._stream_meta.get("subagent_id"),
        }
        if self._stream_buffer_parts and group_meta != current_group:
            self.flush_stream_buffer()
        self._stream_meta.update(group_meta)
        if self._stream_meta.get("messageTimeMs") is None:
            first_chunk_time = payload.get("messageTimeMs") or payload.get("timestamp_ms")
            if first_chunk_time is not None:
                self._stream_meta["messageTimeMs"] = first_chunk_time
        self._stream_buffer_parts.append(str(payload.get("content") or ""))

    def _append_timed_event(
        self,
        action: CompletedEventItemAction,
        payload: dict[str, Any],
    ) -> None:
        event_payload = dict(payload or {})
        has_message_time = event_payload.get("messageTimeMs") is not None
        if not has_message_time and event_payload.get("timestamp_ms") is not None:
            event_payload["messageTimeMs"] = event_payload["timestamp_ms"]
        self.event_log.append({"action": action.value, "data": event_payload})

    def _build_terminal_data(
        self,
        *,
        session_id: str,
        trace_id: str,
        user_id: str,
        scene_id: str,
        status: str,
        chain_token_usage: dict[str, Any] | None = None,
        latest_llm_token_usage: dict[str, Any] | None = None,
        final_content: str = "",
        scene_name: str = "",
        scene_version_seq: int | None = None,
        trace_query_context: dict[str, Any] | None = None,
        reasoning_routed: bool | None = None,
    ) -> dict[str, Any]:
        self.flush_stream_buffer()
        resolved_reasoning_routed = (
            self._reasoning_routed if reasoning_routed is None else reasoning_routed
        )
        payload: dict[str, Any] = {
            "session_id": session_id,
            "scene_id": scene_id,
            "user_id": user_id,
            "trace_id": trace_id,
            "trace_record_id": trace_id,
            "status": status,
            "events": list(self.event_log),
            "chain_token_usage": chain_token_usage or {},
            "latest_llm_token_usage": latest_llm_token_usage or {},
            "trace_query_context": trace_query_context or _build_trace_query_context(trace_id),
            "final_content": final_content or self._latest_ai_content(),
            "reasoning_routed": resolved_reasoning_routed,
            "scene_name": scene_name,
        }
        if scene_version_seq is not None:
            payload["scene_version_seq"] = scene_version_seq
        if self._first_token_at_ms is not None:
            payload["first_token_at_ms"] = self._first_token_at_ms
        logger.debug(
            "[TurnCompletedAggregator] 构建终局 payload | "
            f"session_id={session_id} | trace_id={trace_id} | status={status} | "
            f"events={len(payload['events'])} | final_content_len={len(payload['final_content'])}"
        )
        return payload

    def _latest_ai_content(self) -> str:
        for event in reversed(self.event_log):
            if event.get("action") == CompletedEventItemAction.AI_MESSAGE.value:
                data = event.get("data") or {}
                return str(data.get("content") or "")
        return ""
