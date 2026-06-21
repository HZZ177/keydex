from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from backend.app.storage import (
    LLMRequestLogRecord,
    StorageRepositories,
    TraceEventLogRecord,
    TraceRecord,
)


class UsageRequestNotFoundError(Exception):
    """Raised when a usage request log cannot be found."""


class UsageValidationError(ValueError):
    """Raised when usage query parameters are invalid."""


@dataclass(frozen=True)
class UsageRequestQuery:
    start_time: str | None = None
    end_time: str | None = None
    model: str | None = None
    status: str | None = None
    page: int = 1
    page_size: int = 20


class UsageService:
    def __init__(self, repositories: StorageRepositories) -> None:
        self.repositories = repositories

    def get_summary(
        self,
        *,
        start_time: str | None = None,
        end_time: str | None = None,
        model: str | None = None,
    ) -> dict[str, Any]:
        return self.repositories.llm_request_logs.summary(
            start_time=start_time,
            end_time=end_time,
            model=model,
        )

    def get_trend(
        self,
        *,
        start_time: str | None = None,
        end_time: str | None = None,
        model: str | None = None,
        bucket: str = "day",
        timezone_offset_minutes: int = 0,
    ) -> list[dict[str, Any]]:
        try:
            return self.repositories.llm_request_logs.trend(
                start_time=start_time,
                end_time=end_time,
                model=model,
                bucket=bucket,
                timezone_offset_minutes=timezone_offset_minutes,
            )
        except ValueError as exc:
            raise UsageValidationError(str(exc)) from exc

    def list_requests(self, query: UsageRequestQuery) -> dict[str, Any]:
        if query.page < 1:
            raise UsageValidationError("页码必须大于等于 1")
        if query.page_size < 1 or query.page_size > 200:
            raise UsageValidationError("每页数量必须在 1 到 200 之间")
        records, total = self.repositories.llm_request_logs.list(
            start_time=query.start_time,
            end_time=query.end_time,
            model=query.model,
            status=query.status,
            page=query.page,
            page_size=query.page_size,
        )
        return {
            "list": [_request_log_to_dict(record) for record in records],
            "total": total,
            "page": query.page,
            "page_size": query.page_size,
        }

    def get_request_detail(self, request_id: str) -> dict[str, Any]:
        record = self.repositories.llm_request_logs.get(request_id)
        if record is None:
            raise UsageRequestNotFoundError(f"请求日志不存在: {request_id}")
        trace = self.repositories.trace_records.get(record.trace_record_id)
        events = self.repositories.trace_event_logs.list_by_trace_record(record.trace_record_id)
        return {
            "request": _request_log_to_dict(record, include_previews=True),
            "trace": _trace_to_dict(trace) if trace else None,
            "events": [_event_to_summary(event) for event in events],
        }


def _request_log_to_dict(
    record: LLMRequestLogRecord,
    *,
    include_previews: bool = True,
) -> dict[str, Any]:
    data: dict[str, Any] = {
        "id": record.id,
        "created_at": record.created_at,
        "updated_at": record.updated_at,
        "trace_id": record.trace_id,
        "trace_record_id": record.trace_record_id,
        "session_id": record.session_id,
        "active_session_id": record.active_session_id,
        "gateway_thread_id": record.gateway_thread_id,
        "gateway_trace_id": record.gateway_trace_id,
        "turn_index": record.turn_index,
        "provider_id": record.provider_id,
        "provider_name": record.provider_name,
        "model": record.model,
        "status": record.status,
        "start_time": record.start_time,
        "end_time": record.end_time,
        "duration_ms": record.duration_ms,
        "input_tokens": record.input_tokens,
        "cache_read_tokens": record.cache_read_tokens,
        "output_tokens": record.output_tokens,
        "total_tokens": record.total_tokens,
        "error_message": record.error_message,
    }
    if include_previews:
        data["request_preview"] = record.request_preview
        data["response_preview"] = record.response_preview
        data["metadata"] = record.metadata or {}
    return data


def _trace_to_dict(record: TraceRecord) -> dict[str, Any]:
    return {
        "trace_id": record.trace_id,
        "session_id": record.session_id,
        "active_session_id": record.active_session_id,
        "scene_id": record.scene_id,
        "scene_name": record.scene_name,
        "user_id": record.user_id,
        "turn_index": record.turn_index,
        "status": record.status,
        "start_time": record.start_time,
        "end_time": record.end_time,
        "duration_ms": record.duration_ms,
        "total_input_tokens": record.total_input_tokens,
        "total_cache_read_tokens": record.total_cache_read_tokens,
        "total_output_tokens": record.total_output_tokens,
        "total_tokens": record.total_tokens,
        "user_message_preview": record.user_message_preview,
    }


def _event_to_summary(record: TraceEventLogRecord) -> dict[str, Any]:
    return {
        "id": record.id,
        "event_type": record.event_type,
        "source": record.source,
        "occurred_at": record.occurred_at,
        "sequence_no": record.sequence_no,
        "run_id": record.run_id,
        "turn_index": record.turn_index,
        "payload_summary": _payload_summary(record.payload),
    }


def _payload_summary(payload: dict[str, Any]) -> str:
    text = json.dumps(_safe_payload(payload), ensure_ascii=False, separators=(",", ":"))
    return text if len(text) <= 500 else f"{text[:500]}..."


def _safe_payload(payload: Any) -> Any:
    if isinstance(payload, dict):
        return {
            str(key): _safe_payload(value)
            for key, value in payload.items()
            if str(key).lower() not in {"api_key", "authorization", "headers", "x-api-key"}
        }
    if isinstance(payload, list):
        return [_safe_payload(item) for item in payload[:20]]
    if payload is None or isinstance(payload, str | int | float | bool):
        return payload
    return str(payload)
