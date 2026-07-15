import pytest

from backend.app.web.errors import WebProviderError
from backend.app.web.models import WebCapability
from backend.app.web.provider import WebProviderDescriptor
from backend.app.web.providers.tavily import TavilyProvider
from backend.app.web.registry import (
    WebProviderRegistry,
    WebProviderRegistryError,
    build_default_web_provider_registry,
)
from backend.tests.web.test_provider import SearchOnlyProvider


def test_default_registry_exposes_tavily_without_provider_specific_branches() -> None:
    registry = build_default_web_provider_registry()

    assert [item.provider_id for item in registry.descriptors()] == ["tavily"]
    assert registry.require("tavily").descriptor.capabilities == {"search", "fetch"}


def test_registry_rejects_duplicate_provider_ids() -> None:
    registry = WebProviderRegistry([TavilyProvider()])

    with pytest.raises(WebProviderRegistryError, match="已注册"):
        registry.register(TavilyProvider())


def test_registry_returns_stable_order_and_capability_views() -> None:
    registry = build_default_web_provider_registry(extra_providers=[SearchOnlyProvider()])

    assert [provider.descriptor.provider_id for provider in registry.list()] == [
        "search-only",
        "tavily",
    ]
    assert [
        provider.descriptor.provider_id
        for provider in registry.for_capability(WebCapability.FETCH)
    ] == ["tavily"]


def test_registry_unknown_provider_uses_stable_error() -> None:
    registry = WebProviderRegistry()

    with pytest.raises(WebProviderError) as caught:
        registry.require("missing")

    assert caught.value.code == "provider_not_selected"


def test_registry_rejects_objects_without_provider_protocol() -> None:
    registry = WebProviderRegistry()

    with pytest.raises(WebProviderRegistryError, match="未实现"):
        registry.register(object())  # type: ignore[arg-type]


def test_tavily_descriptor_is_provider_neutral() -> None:
    descriptor: WebProviderDescriptor = TavilyProvider.descriptor

    assert descriptor.provider_id == "tavily"
    assert descriptor.supports(WebCapability.SEARCH)
    assert descriptor.supports(WebCapability.FETCH)
    assert descriptor.credential_setup is not None
    assert descriptor.credential_setup.label == "获取 Tavily 密钥"
    assert descriptor.credential_setup.url == "https://app.tavily.com/home"
    assert "1,000 API Credits" in (descriptor.credential_setup.help_text or "")
