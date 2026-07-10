from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

PendingInputMode = Literal["steer", "queue"]
PENDING_INPUT_MODE_STEER = "steer"
PENDING_INPUT_MODE_QUEUE = "queue"
PENDING_INPUT_MODES = frozenset({PENDING_INPUT_MODE_STEER, PENDING_INPUT_MODE_QUEUE})

PENDING_INPUT_STATUS_PENDING_STEER = "pending_steer"
PENDING_INPUT_STATUS_QUEUED = "queued"
PENDING_INPUT_STATUS_STARTING = "starting"
PENDING_INPUT_STATUS_RUNNING = "running"
PENDING_INPUT_STATUS_DELIVERED = "delivered"
PENDING_INPUT_STATUS_CANCELLED = "cancelled"
PENDING_INPUT_STATUS_FAILED = "failed"
PENDING_INPUT_STATUS_CONVERTED = "converted"
PENDING_INPUT_ACTIVE_STATUSES = frozenset(
    {
        PENDING_INPUT_STATUS_PENDING_STEER,
        PENDING_INPUT_STATUS_QUEUED,
        PENDING_INPUT_STATUS_STARTING,
        PENDING_INPUT_STATUS_RUNNING,
    }
)
PENDING_INPUT_EDITABLE_STATUSES = frozenset(
    {
        PENDING_INPUT_STATUS_PENDING_STEER,
        PENDING_INPUT_STATUS_QUEUED,
    }
)
PENDING_INPUT_TERMINAL_STATUSES = frozenset(
    {
        PENDING_INPUT_STATUS_DELIVERED,
        PENDING_INPUT_STATUS_CANCELLED,
        PENDING_INPUT_STATUS_FAILED,
        PENDING_INPUT_STATUS_CONVERTED,
    }
)
PENDING_INPUT_STATUSES = PENDING_INPUT_ACTIVE_STATUSES | PENDING_INPUT_TERMINAL_STATUSES


class ChatCancellationToken:
    def __init__(self) -> None:
        self._cancelled = False

    def cancel(self) -> None:
        self._cancelled = True

    def is_cancelled(self) -> bool:
        return self._cancelled


@dataclass(frozen=True)
class ChatRequest:
    message: str
    session_id: str | None = None
    user_id: str | None = None
    scene_id: str | None = None
    provider_id: str = ""
    model: str = ""
    system_prompt: str | None = None
    runtime_params: dict[str, Any] | None = None
    attachments: list[dict[str, Any]] | None = None
    delivery_mode: PendingInputMode = PENDING_INPUT_MODE_STEER
    client_input_id: str | None = None
    pending_input_id: str | None = None


@dataclass(frozen=True)
class ChatTurnResult:
    session_id: str
    trace_id: str
    turn_index: int
    status: str
    final_content: str = ""
    error: str | None = None
