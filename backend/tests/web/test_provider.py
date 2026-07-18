import pytest
from pydantic import ValidationError

from backend.app.web.errors import WebProviderError
from backend.app.web.models import WebCapability, WebSearchRequest, WebSearchResponse
from backend.app.web.provider import (
    BaseWebProvider,
    WebConnectionCheckResult,
    WebProvider,
    WebProviderContext,
    WebProviderDescriptor,
    WebProviderSetupLink,
    ensure_provider_capability,
)


class SearchOnlyProvider(BaseWebProvider):
    descriptor = WebProviderDescriptor(
        provider_id="search-only",
        display_name="Search only",
        description="Search-only test provider",
        capabilities={WebCapability.SEARCH},
    )

    async def search(
        self,
        request: WebSearchRequest,
        context: WebProviderContext,
    ) -> WebSearchResponse:
        del context
        return WebSearchResponse(provider_id=self.descriptor.provider_id, query=request.query)

    async def check_connection(
        self,
        context: WebProviderContext,
    ) -> WebConnectionCheckResult:
        context.require_secret("api_key")
        return WebConnectionCheckResult(provider_id=self.descriptor.provider_id, ok=True)


def test_provider_descriptor_declares_capabilities() -> None:
    descriptor = SearchOnlyProvider.descriptor

    assert descriptor.supports(WebCapability.SEARCH)
    assert not descriptor.supports(WebCapability.FETCH)


@pytest.mark.parametrize("provider_id", ["Tavily", "1provider", "bad provider", ""])
def test_provider_descriptor_rejects_unstable_ids(provider_id: str) -> None:
    with pytest.raises(ValidationError):
        WebProviderDescriptor(
            provider_id=provider_id,
            display_name="Provider",
            description="Description",
            capabilities={WebCapability.SEARCH},
        )


def test_provider_descriptor_requires_at_least_one_capability() -> None:
    with pytest.raises(ValidationError):
        WebProviderDescriptor(
            provider_id="empty-provider",
            display_name="Provider",
            description="Description",
            capabilities=set(),
        )


def test_provider_setup_link_accepts_https_without_credentials() -> None:
    setup = WebProviderSetupLink(
        label="获取密钥",
        url=" https://provider.example/account/keys ",
        help_text="免费额度说明",
    )

    assert setup.url == "https://provider.example/account/keys"


@pytest.mark.parametrize(
    "url",
    [
        "http://provider.example/keys",
        "javascript:alert(1)",
        "https://user:secret@provider.example/keys",
        "not-a-url",
    ],
)
def test_provider_setup_link_rejects_unsafe_urls(url: str) -> None:
    with pytest.raises(ValidationError):
        WebProviderSetupLink(label="获取密钥", url=url)


@pytest.mark.asyncio
async def test_search_only_provider_uses_default_unsupported_fetch() -> None:
    provider = SearchOnlyProvider()

    assert isinstance(provider, WebProvider)
    with pytest.raises(WebProviderError) as caught:
        await provider.fetch(
            request={"urls": ["https://example.com"]},  # type: ignore[arg-type]
            context=WebProviderContext(),
        )

    assert caught.value.code == "unsupported_capability"


def test_capability_guard_fails_before_provider_call() -> None:
    provider = SearchOnlyProvider()

    ensure_provider_capability(provider, WebCapability.SEARCH)
    with pytest.raises(WebProviderError) as caught:
        ensure_provider_capability(provider, WebCapability.FETCH)

    assert caught.value.to_public_dict()["details"]["provider_id"] == "search-only"


def test_provider_context_requires_non_empty_secret() -> None:
    context = WebProviderContext(secrets={"api_key": "  "})

    with pytest.raises(WebProviderError) as caught:
        context.require_secret("api_key")

    assert caught.value.code == "provider_not_configured"


def test_connection_result_enforces_success_and_failure_shapes() -> None:
    with pytest.raises(ValidationError):
        WebConnectionCheckResult(provider_id="search-only", ok=False)
    with pytest.raises(ValidationError):
        WebConnectionCheckResult(
            provider_id="search-only",
            ok=True,
            error={"code": "network_unavailable", "message": "offline"},
        )
