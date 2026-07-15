from __future__ import annotations

from pathlib import Path

from backend.app.agent.tool_capabilities import ToolCapability
from backend.app.core.config import AppSettings
from backend.app.keydex import KeydexRuntimeCache
from backend.app.services.chat_service import ChatService
from backend.app.storage import StorageRepositories, init_database
from backend.app.tools import ToolExecutionContext
from backend.app.web.config import WebProviderConfigField
from backend.app.web.models import WebCapability
from backend.app.web.provider import BaseWebProvider, WebProviderDescriptor
from backend.app.web.registry import WebProviderRegistry
from backend.app.web.service import WebService


class SearchOnlyProvider(BaseWebProvider):
    descriptor = WebProviderDescriptor(
        provider_id="search-only",
        display_name="Search Only",
        description="search",
        capabilities=frozenset({WebCapability.SEARCH}),
        config_fields=(
            WebProviderConfigField(
                key="api_key",
                field_type="secret",
                label="API Key",
                required=True,
            ),
        ),
    )


class FullProvider(BaseWebProvider):
    descriptor = WebProviderDescriptor(
        provider_id="full",
        display_name="Full",
        description="search and fetch",
        capabilities=frozenset({WebCapability.SEARCH, WebCapability.FETCH}),
        config_fields=SearchOnlyProvider.descriptor.config_fields,
    )


def _service(tmp_path: Path) -> tuple[ChatService, StorageRepositories]:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    registry = WebProviderRegistry((SearchOnlyProvider(), FullProvider()))
    return (
        ChatService(
            settings=AppSettings(data_dir=tmp_path / "data", workspace_root=tmp_path),
            repositories=repositories,
            agent_runner=object(),  # type: ignore[arg-type]
            keydex_runtime_cache=KeydexRuntimeCache(system_root=tmp_path / "keydex"),
            web_service=WebService(repositories, registry),
        ),
        repositories,
    )


def _context(tmp_path: Path, *capabilities: ToolCapability) -> ToolExecutionContext:
    return ToolExecutionContext(
        session_id="ses-chat",
        user_id="local-user",
        workspace_root=tmp_path,
        turn_index=1,
        metadata={"tool_capabilities": frozenset(capabilities)},
    )


def _enable(
    repositories: StorageRepositories,
    provider_id: str,
    *,
    api_key: str | None,
) -> None:
    if api_key:
        repositories.web_settings.upsert_provider(
            provider_id,
            config={},
            secrets={"api_key": api_key},
        )
    repositories.web_settings.save(
        enabled=True,
        active_provider_id=provider_id,
        providers={},
    )


def test_chat_web_disabled_adds_no_runtime_tools(tmp_path: Path) -> None:
    service, _repositories = _service(tmp_path)
    context = _context(tmp_path)

    tools = service._build_web_runtime_tools(tool_context=context)

    assert tools == []
    assert context.metadata["tool_capabilities"] == frozenset()


def test_chat_search_only_provider_adds_only_search(tmp_path: Path) -> None:
    service, repositories = _service(tmp_path)
    _enable(repositories, "search-only", api_key="configured")
    context = _context(tmp_path)

    tools = service._build_web_runtime_tools(tool_context=context)

    assert [tool.name for tool in tools] == ["web_search"]
    assert context.metadata["tool_capabilities"] == frozenset({ToolCapability.WEB})


def test_chat_full_provider_adds_web_without_workspace_capability(tmp_path: Path) -> None:
    service, repositories = _service(tmp_path)
    _enable(repositories, "full", api_key="configured")
    context = _context(tmp_path)

    tools = service._build_web_runtime_tools(tool_context=context)

    assert [tool.name for tool in tools] == ["web_search", "web_fetch"]
    assert ToolCapability.WORKSPACE not in context.metadata["tool_capabilities"]
    assert context.metadata["web_capabilities"] == frozenset(
        {WebCapability.SEARCH, WebCapability.FETCH}
    )


def test_chat_missing_required_key_adds_no_web_tools(tmp_path: Path) -> None:
    service, repositories = _service(tmp_path)
    _enable(repositories, "full", api_key=None)
    context = _context(tmp_path)

    tools = service._build_web_runtime_tools(tool_context=context)

    assert tools == []
    assert context.metadata["tool_capabilities"] == frozenset()


def test_workspace_capability_is_preserved_when_web_is_added(tmp_path: Path) -> None:
    service, repositories = _service(tmp_path)
    _enable(repositories, "full", api_key="configured")
    context = _context(tmp_path, ToolCapability.WORKSPACE, ToolCapability.SKILL)

    service._build_web_runtime_tools(tool_context=context)

    assert context.metadata["tool_capabilities"] == frozenset(
        {ToolCapability.WORKSPACE, ToolCapability.SKILL, ToolCapability.WEB}
    )
