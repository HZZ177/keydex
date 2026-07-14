"""Service layer package for the kt-agentloop backend replacement.

The package keeps historical re-exports for callers, but resolves them lazily so
importing a light service submodule does not pull the LangChain agent runtime
into backend startup.
"""

from __future__ import annotations

from importlib import import_module
from typing import Any

_EXPORTS = {
    "ChatCancellationToken": ("backend.app.services.chat_types", "ChatCancellationToken"),
    "ChatRequest": ("backend.app.services.chat_types", "ChatRequest"),
    "ChatTurnResult": ("backend.app.services.chat_types", "ChatTurnResult"),
    "ChatService": ("backend.app.services.chat_service", "ChatService"),
    "ChatStreamAlreadyRunningError": (
        "backend.app.services.chat_stream_manager",
        "ChatStreamAlreadyRunningError",
    ),
    "ChatStreamManager": ("backend.app.services.chat_stream_manager", "ChatStreamManager"),
    "ChatStreamMissingSessionError": (
        "backend.app.services.chat_stream_manager",
        "ChatStreamMissingSessionError",
    ),
    "ContextCompressionOutcome": (
        "backend.app.services.context_compression_service",
        "ContextCompressionOutcome",
    ),
    "ContextCompressionService": (
        "backend.app.services.context_compression_service",
        "ContextCompressionService",
    ),
    "GetHistoryRequest": ("backend.app.services.session_service", "GetHistoryRequest"),
    "ListSessionsRequest": ("backend.app.services.session_service", "ListSessionsRequest"),
    "MessageEventService": ("backend.app.services.message_event_service", "MessageEventService"),
    "SessionNotFoundError": ("backend.app.services.session_service", "SessionNotFoundError"),
    "SessionArchivedError": ("backend.app.services.session_service", "SessionArchivedError"),
    "SessionService": ("backend.app.services.session_service", "SessionService"),
    "SessionValidationError": ("backend.app.services.session_service", "SessionValidationError"),
    "ThreadTaskConflictError": (
        "backend.app.services.thread_task_service",
        "ThreadTaskConflictError",
    ),
    "ThreadTaskNotFoundError": (
        "backend.app.services.thread_task_service",
        "ThreadTaskNotFoundError",
    ),
    "ThreadTaskService": ("backend.app.services.thread_task_service", "ThreadTaskService"),
    "ThreadTaskServiceError": (
        "backend.app.services.thread_task_service",
        "ThreadTaskServiceError",
    ),
    "ThreadTaskRuntime": (
        "backend.app.services.thread_task_runtime",
        "ThreadTaskRuntime",
    ),
    "ThreadTaskEventPublisher": (
        "backend.app.services.thread_task_events",
        "ThreadTaskEventPublisher",
    ),
    "ThreadTaskElapsedTicker": (
        "backend.app.services.thread_task_elapsed_ticker",
        "ThreadTaskElapsedTicker",
    ),
    "ThreadTaskStateLocks": (
        "backend.app.services.thread_task_runtime",
        "ThreadTaskStateLocks",
    ),
    "ThreadTaskSessionNotFoundError": (
        "backend.app.services.thread_task_service",
        "ThreadTaskSessionNotFoundError",
    ),
    "ThreadTaskTransitionError": (
        "backend.app.services.thread_task_service",
        "ThreadTaskTransitionError",
    ),
    "ThreadTaskValidationError": (
        "backend.app.services.thread_task_service",
        "ThreadTaskValidationError",
    ),
    "UsageRequestNotFoundError": (
        "backend.app.services.usage_service",
        "UsageRequestNotFoundError",
    ),
    "UsageRequestQuery": ("backend.app.services.usage_service", "UsageRequestQuery"),
    "UsageService": ("backend.app.services.usage_service", "UsageService"),
    "UsageValidationError": ("backend.app.services.usage_service", "UsageValidationError"),
    "WorkspaceArchivedError": ("backend.app.services.workspace_service", "WorkspaceArchivedError"),
    "WorkspaceNotFoundError": ("backend.app.services.workspace_service", "WorkspaceNotFoundError"),
    "WorkspaceRuntimeContext": (
        "backend.app.services.workspace_service",
        "WorkspaceRuntimeContext",
    ),
    "WorkspaceService": ("backend.app.services.workspace_service", "WorkspaceService"),
    "WorkspaceServiceError": ("backend.app.services.workspace_service", "WorkspaceServiceError"),
}

__all__ = list(_EXPORTS)


def __getattr__(name: str) -> Any:
    if name not in _EXPORTS:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    module_name, export_name = _EXPORTS[name]
    value = getattr(import_module(module_name), export_name)
    globals()[name] = value
    return value
