from __future__ import annotations

from enum import StrEnum
from typing import Any


class SubagentErrorCode(StrEnum):
    SUBAGENT_ROLE_INVALID = "SUBAGENT_ROLE_INVALID"
    SUBAGENT_PARENT_INVALID = "SUBAGENT_PARENT_INVALID"
    SUBAGENT_NOT_FOUND = "SUBAGENT_NOT_FOUND"
    RUN_NOT_FOUND = "RUN_NOT_FOUND"
    RUN_ALREADY_ACTIVE = "RUN_ALREADY_ACTIVE"
    RUN_TERMINAL = "RUN_TERMINAL"
    RUN_TRANSITION_INVALID = "RUN_TRANSITION_INVALID"
    RUN_VERSION_CONFLICT = "RUN_VERSION_CONFLICT"
    SUBAGENT_CLOSED = "SUBAGENT_CLOSED"
    SUBAGENT_CLOSE_REQUIRES_CANCEL = "SUBAGENT_CLOSE_REQUIRES_CANCEL"
    STEER_NOT_ALLOWED = "STEER_NOT_ALLOWED"
    CHILD_SESSION_ACCESS_DENIED = "CHILD_SESSION_ACCESS_DENIED"
    MISSING_FINAL_REPORT = "MISSING_FINAL_REPORT"
    ROLE_TOOL_POLICY_VIOLATION = "ROLE_TOOL_POLICY_VIOLATION"
    SUBAGENT_START_FAILED = "SUBAGENT_START_FAILED"
    SUBAGENT_RUN_FAILED = "SUBAGENT_RUN_FAILED"
    SUBAGENT_CANCELLED = "SUBAGENT_CANCELLED"
    SUBAGENT_INTERRUPTED = "SUBAGENT_INTERRUPTED"


class SubagentError(RuntimeError):
    def __init__(
        self,
        code: SubagentErrorCode,
        message: str,
        *,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = dict(details or {})
