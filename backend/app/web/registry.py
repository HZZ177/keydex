from __future__ import annotations

from collections.abc import Iterable

from backend.app.web.errors import WebErrorCode, WebProviderError, web_error
from backend.app.web.models import WebCapability
from backend.app.web.provider import WebProvider, WebProviderDescriptor


class WebProviderRegistryError(ValueError):
    pass


class WebProviderRegistry:
    def __init__(self, providers: Iterable[WebProvider] = ()) -> None:
        self._providers: dict[str, WebProvider] = {}
        for provider in providers:
            self.register(provider)

    def register(self, provider: WebProvider) -> WebProvider:
        if not isinstance(provider, WebProvider):
            raise WebProviderRegistryError("对象未实现 WebProvider 协议")
        provider_id = provider.descriptor.provider_id
        if provider_id in self._providers:
            raise WebProviderRegistryError(f"Web Provider 已注册: {provider_id}")
        self._providers[provider_id] = provider
        return provider

    def get(self, provider_id: str) -> WebProvider | None:
        return self._providers.get(provider_id)

    def require(self, provider_id: str) -> WebProvider:
        provider = self.get(provider_id)
        if provider is None:
            raise WebProviderError(
                web_error(
                    WebErrorCode.PROVIDER_NOT_SELECTED,
                    diagnostic={"provider_id": provider_id},
                )
            )
        return provider

    def list(self) -> tuple[WebProvider, ...]:
        return tuple(self._providers[key] for key in sorted(self._providers))

    def descriptors(self) -> tuple[WebProviderDescriptor, ...]:
        return tuple(provider.descriptor for provider in self.list())

    def for_capability(self, capability: WebCapability) -> tuple[WebProvider, ...]:
        return tuple(
            provider for provider in self.list() if provider.descriptor.supports(capability)
        )

    def __len__(self) -> int:
        return len(self._providers)


def build_default_web_provider_registry(
    *,
    extra_providers: Iterable[WebProvider] = (),
) -> WebProviderRegistry:
    from backend.app.web.providers.tavily import TavilyProvider

    registry = WebProviderRegistry([TavilyProvider()])
    for provider in extra_providers:
        registry.register(provider)
    return registry
