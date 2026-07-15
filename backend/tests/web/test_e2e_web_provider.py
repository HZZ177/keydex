from __future__ import annotations

import pytest

from backend.app.web.errors import WebErrorCode, WebProviderError
from backend.app.web.models import WebFetchRequest, WebSearchRequest
from backend.app.web.provider import WebProviderContext
from backend.app.web.testing import E2EWebProvider


def context(*, api_key: str = "e2e-fake-key") -> WebProviderContext:
    return WebProviderContext(
        config={"project_id": "e2e-project"},
        secrets={"api_key": api_key},
    )


@pytest.mark.asyncio
async def test_e2e_provider_search_success_empty_and_error_matrix() -> None:
    provider = E2EWebProvider()

    success = await provider.search(WebSearchRequest(query="citation"), context())
    empty = await provider.search(WebSearchRequest(query="empty fixture"), context())

    assert len(success.sources) == 3
    assert success.sources[0].title == "E2E Citation Source"
    assert [source.domain for source in success.sources] == [
        "e2e.web.test",
        "docs.e2e.web.test",
        "guide.e2e.web.test",
    ]
    assert empty.sources == []
    with pytest.raises(WebProviderError) as rate_limited:
        await provider.search(WebSearchRequest(query="error-rate"), context())
    assert rate_limited.value.payload.code == WebErrorCode.RATE_LIMITED
    assert rate_limited.value.payload.retry_after_seconds == 2


@pytest.mark.asyncio
async def test_e2e_provider_fetch_preserves_partial_success_and_order() -> None:
    provider = E2EWebProvider()
    urls = [
        "https://one.e2e.web.test/article",
        "https://fail.e2e.web.test/article",
        "https://two.e2e.web.test/article",
    ]

    result = await provider.fetch(WebFetchRequest(urls=urls), context())

    assert result.status == "partial_failure"
    assert [item.requested_url for item in result.items] == urls
    assert [item.status for item in result.items] == ["success", "failed", "success"]
    assert result.items[0].content and "确定性 Mock Provider" in result.items[0].content


@pytest.mark.asyncio
async def test_e2e_provider_connection_is_config_driven_and_records_requests() -> None:
    provider = E2EWebProvider()

    assert (await provider.check_connection(context())).ok is True
    assert (await provider.check_connection(context(api_key="e2e-bad-key"))).ok is False
    await provider.search(WebSearchRequest(query="record me"), context())
    await provider.fetch(WebFetchRequest(urls=["https://e2e.web.test/article"]), context())

    assert [request.query for request in provider.search_requests] == ["record me"]
    assert provider.fetch_requests[0].urls == ["https://e2e.web.test/article"]


@pytest.mark.asyncio
async def test_e2e_provider_rejects_missing_test_configuration() -> None:
    provider = E2EWebProvider()

    with pytest.raises(WebProviderError) as missing_secret:
        await provider.search(
            WebSearchRequest(query="missing"),
            WebProviderContext(config={"project_id": "project"}),
        )
    assert missing_secret.value.payload.code == WebErrorCode.PROVIDER_NOT_CONFIGURED
