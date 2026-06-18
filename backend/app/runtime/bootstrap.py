from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from backend.app.core.config import AppSettings
from backend.app.storage import Database, StorageRepositories
from backend.app.tools import ToolRegistry


@dataclass(slots=True)
class DesktopAgentRuntime:
    """Composition root for the kt-agentloop backend replacement.

    The runtime owns the shared shell dependencies that later issues will wire
    into session, event, chat, and tool services. Keeping this object explicit
    prevents new work from reintroducing the removed Thread/Turn/Item runtime.
    """

    settings: AppSettings
    database: Database
    repositories: StorageRepositories
    model_provider_client_provider: Callable[[], Any]
    tool_registry: ToolRegistry
    chat_service: Any
    protocol: str = "kt-agentloop"

    @property
    def capabilities(self) -> tuple[str, ...]:
        return (
            "settings",
            "model_providers",
            "sessions",
            "message_events",
            "checkpoints",
            "domain_events",
            "tools",
            "langchain_agent",
            "chat_ws",
        )


def create_desktop_runtime(
    *,
    settings: AppSettings,
    database: Database,
    repositories: StorageRepositories,
    model_provider_client_provider: Callable[[], Any],
    tool_registry: ToolRegistry,
    chat_service: Any,
) -> DesktopAgentRuntime:
    return DesktopAgentRuntime(
        settings=settings,
        database=database,
        repositories=repositories,
        model_provider_client_provider=model_provider_client_provider,
        tool_registry=tool_registry,
        chat_service=chat_service,
    )
