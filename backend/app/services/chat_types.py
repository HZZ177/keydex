from __future__ import annotations

from dataclasses import dataclass
from typing import Any


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
    model: str = ""
    system_prompt: str | None = None
    runtime_params: dict[str, Any] | None = None


@dataclass(frozen=True)
class ChatTurnResult:
    session_id: str
    trace_id: str
    turn_index: int
    status: str
    final_content: str = ""
    error: str | None = None
