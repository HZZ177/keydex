from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any


@dataclass(slots=True)
class DomainEvent:
    event_type: str
    source: str
    payload: dict[str, Any]
    trace_id: str | None = None
    user_id: str | None = None
    original_session_id: str | None = None
    active_session_id: str | None = None
    run_id: str | None = None
    turn_index: int | None = None
    timestamp_ms: int = field(default_factory=lambda: int(time.time() * 1000))
    tags: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not self.event_type:
            raise ValueError("DomainEvent.event_type 不能为空")
        if not self.source:
            raise ValueError("DomainEvent.source 不能为空")
        if self.payload is None:
            raise ValueError("DomainEvent.payload 不能为空")

    def to_dict(self) -> dict[str, Any]:
        return {
            "event_type": self.event_type,
            "source": self.source,
            "payload": self.payload,
            "trace_id": self.trace_id,
            "user_id": self.user_id,
            "original_session_id": self.original_session_id,
            "active_session_id": self.active_session_id,
            "run_id": self.run_id,
            "turn_index": self.turn_index,
            "timestamp_ms": self.timestamp_ms,
            "tags": self.tags,
        }

    @classmethod
    def from_dict(cls, value: dict[str, Any]) -> DomainEvent:
        return cls(
            event_type=str(value["event_type"]),
            source=str(value["source"]),
            payload=dict(value.get("payload") or {}),
            trace_id=value.get("trace_id"),
            user_id=value.get("user_id"),
            original_session_id=value.get("original_session_id"),
            active_session_id=value.get("active_session_id"),
            run_id=value.get("run_id"),
            turn_index=value.get("turn_index"),
            timestamp_ms=int(value.get("timestamp_ms") or int(time.time() * 1000)),
            tags=dict(value.get("tags") or {}),
        )

