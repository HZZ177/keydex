from __future__ import annotations

from enum import StrEnum


class ChatAction(StrEnum):
    SESSION_CREATED = "session_created"
    BIND_OK = "bind_ok"
    UNBIND_OK = "unbind_ok"
    STREAM = "stream"
    COMPLETED = "completed"
    CANCELLED = "cancelled"
    TOOL_START = "tool_start"
    TOOL_PROGRESS = "tool_progress"
    TOOL_END = "tool_end"
    APPROVAL_REQUESTED = "approval_requested"
    APPROVAL_RESOLVED = "approval_resolved"
    SUBAGENT_START = "subagent_start"
    SUBAGENT_END = "subagent_end"
    SUBAGENT_ERROR = "subagent_error"
    ERROR = "error"
    PONG = "pong"
    STATUS = "status"
    SESSION_CLOSED = "session_closed"
    TASK_RESULT = "task_result"
    REASONING = "reasoning"


class ReplayAction(StrEnum):
    USER_MESSAGE = "user_message"
    SYSTEM_MESSAGE = "system_message"
    AI_MESSAGE = "ai_message"
    STREAM_BATCH = "stream_batch"
    TOOL_START = "tool_start"
    TOOL_END = "tool_end"
    APPROVAL_REQUESTED = "approval_requested"
    APPROVAL_RESOLVED = "approval_resolved"
    SUBAGENT_START = "subagent_start"
    SUBAGENT_END = "subagent_end"
    SUBAGENT_ERROR = "subagent_error"
    MEMORY_RECALLED = "memory_recalled"
    COMPLETED = "completed"
    CANCELLED = "cancelled"
    ERROR = "error"
    SCHEDULED_TASK_RESULT = "scheduled_task_result"
    REASONING = "reasoning"


class CompletedEventItemAction(StrEnum):
    AI_MESSAGE = "ai_message"
    TOOL_START = "tool_start"
    TOOL_END = "tool_end"
    STREAM = "stream"
    REASONING_MESSAGE = "reasoning_message"


class ChatInboundAction(StrEnum):
    CREATE_SESSION = "create_session"
    BIND_SESSION = "bind_session"
    UNBIND_SESSION = "unbind_session"
    CHAT = "chat"
    SCHEDULED_CHAT = "scheduled_chat"
    CLOSE_SESSION = "close_session"
    CANCEL = "cancel"
    APPROVAL_DECISION = "approval_decision"
    PING = "ping"
    GET_STATUS = "get_status"
