from __future__ import annotations

from enum import StrEnum


class DomainEventType(StrEnum):
    TASK_FINISHED = "task.finished"
    TASK_FINISHED_CHAT = "task.finished.chat"
    SESSION_STATUS_CHANGED = "session.status_changed"
    SESSION_TITLE_UPDATED = "session.title_updated"
    SESSION_HAS_UPDATE = "session.has_update"
    SYSTEM_NOTICE = "system.notice"
    WORKBENCH_WORKSPACE_STATE_CHANGED = "workbench.workspace.state_changed"
    THREAD_TASK_UPDATED = "thread_task.updated"
    THREAD_TASK_DELETED = "thread_task.deleted"
    THREAD_TASK_RUN_STARTED = "thread_task.run.started"
    THREAD_TASK_RUN_FINISHED = "thread_task.run.finished"

    MESSAGE_USER_CREATED = "message.user.created"
    MESSAGE_SYSTEM_CREATED = "message.system.created"
    MESSAGE_AI_CREATED = "message.ai.created"
    MESSAGES_INJECTED = "messages.injected"

    LLM_STREAM = "llm.stream"
    LLM_STARTED = "llm.started"
    LLM_FINISHED = "llm.finished"
    LLM_FAILED = "llm.failed"
    LLM_MESSAGE_STARTED = "llm.message.started"
    LLM_MESSAGE_FINISHED = "llm.message.finished"
    LLM_MESSAGE_FAILED = "llm.message.failed"
    LLM_TOOL_STARTED = "llm.tool.started"
    LLM_TOOL_PROGRESS = "llm.tool.progress"
    LLM_TOOL_FINISHED = "llm.tool.finished"
    LLM_TOOL_FAILED = "llm.tool.failed"

    APPROVAL_REQUESTED = "approval.requested"
    APPROVAL_RESOLVED = "approval.resolved"

    SUBAGENT_STARTED = "subagent.started"
    SUBAGENT_FINISHED = "subagent.finished"
    SUBAGENT_FAILED = "subagent.failed"

    DEBUG_CONTEXT_READY = "debug.context.ready"
    MIDDLEWARE_STARTED = "middleware.started"
    MIDDLEWARE_PROGRESS = "middleware.progress"
    MIDDLEWARE_FINISHED = "middleware.finished"
    MIDDLEWARE_FAILED = "middleware.failed"
    ASSEMBLE_STARTED = "assemble.started"
    ASSEMBLE_PROGRESS = "assemble.progress"
    ASSEMBLE_STEP_STARTED = "assemble.step.started"
    ASSEMBLE_STEP_FINISHED = "assemble.step.finished"
    ASSEMBLE_STEP_FAILED = "assemble.step.failed"
    ASSEMBLE_FINISHED = "assemble.finished"
    ASSEMBLE_FAILED = "assemble.failed"
    MEMORY_RECALLED = "memory.recalled"

    TURN_STARTED = "turn.started"
    TURN_COMPLETED = "turn.completed"
    TURN_CANCELLED = "turn.cancelled"
    TURN_FAILED = "turn.failed"

    REASONING_STARTED = "reasoning.started"
    REASONING_STREAM = "reasoning.stream"
    REASONING_FINISHED = "reasoning.finished"
    REASONING_FAILED = "reasoning.failed"


CORE_EVENT_TYPES = frozenset(
    {
        DomainEventType.MESSAGE_USER_CREATED,
        DomainEventType.MESSAGE_SYSTEM_CREATED,
        DomainEventType.MESSAGE_AI_CREATED,
        DomainEventType.LLM_STREAM,
        DomainEventType.LLM_STARTED,
        DomainEventType.LLM_FINISHED,
        DomainEventType.LLM_FAILED,
        DomainEventType.LLM_MESSAGE_STARTED,
        DomainEventType.LLM_MESSAGE_FINISHED,
        DomainEventType.LLM_MESSAGE_FAILED,
        DomainEventType.LLM_TOOL_STARTED,
        DomainEventType.LLM_TOOL_PROGRESS,
        DomainEventType.LLM_TOOL_FINISHED,
        DomainEventType.LLM_TOOL_FAILED,
        DomainEventType.APPROVAL_REQUESTED,
        DomainEventType.APPROVAL_RESOLVED,
        DomainEventType.SUBAGENT_STARTED,
        DomainEventType.SUBAGENT_FINISHED,
        DomainEventType.SUBAGENT_FAILED,
        DomainEventType.MEMORY_RECALLED,
        DomainEventType.TURN_STARTED,
        DomainEventType.TURN_COMPLETED,
        DomainEventType.TURN_CANCELLED,
        DomainEventType.TURN_FAILED,
        DomainEventType.REASONING_STARTED,
        DomainEventType.REASONING_STREAM,
        DomainEventType.REASONING_FINISHED,
        DomainEventType.REASONING_FAILED,
        DomainEventType.TASK_FINISHED_CHAT,
        DomainEventType.THREAD_TASK_UPDATED,
        DomainEventType.THREAD_TASK_DELETED,
        DomainEventType.THREAD_TASK_RUN_STARTED,
        DomainEventType.THREAD_TASK_RUN_FINISHED,
        DomainEventType.MIDDLEWARE_PROGRESS,
    }
)


def ensure_known_event_type(value: str) -> DomainEventType:
    try:
        return DomainEventType(value)
    except ValueError as exc:
        raise ValueError(f"未知 DomainEventType: {value}") from exc
