from __future__ import annotations

import asyncio

import pytest

from backend.app.storage import StorageRepositories, init_database
from backend.app.web.config import WebProviderConfigField
from backend.app.web.errors import WebErrorCode, WebProviderError, web_error
from backend.app.web.models import (
    WebCapability,
    WebFetchItem,
    WebFetchRequest,
    WebFetchResponse,
    WebSource,
)
from backend.app.web.provider import BaseWebProvider, WebProviderContext, WebProviderDescriptor
from backend.app.web.registry import WebProviderRegistry
from backend.app.web.service import WebService


class RecordingFetchProvider(BaseWebProvider):
    descriptor = WebProviderDescriptor(
        provider_id="recording",
        display_name="Recording",
        description="记录 Fetch 调用",
        capabilities=frozenset({WebCapability.FETCH}),
        config_fields=(
            WebProviderConfigField(
                key="api_key",
                field_type="secret",
                label="API Key",
                required=True,
            ),
        ),
    )

    def __init__(self) -> None:
        self.requests: list[WebFetchRequest] = []
        self.contexts: list[WebProviderContext] = []
        self.error: BaseException | None = None
        self.response: WebFetchResponse | None = None

    async def fetch(
        self,
        request: WebFetchRequest,
        context: WebProviderContext,
    ) -> WebFetchResponse:
        self.requests.append(request)
        self.contexts.append(context)
        if self.error is not None:
            raise self.error
        if self.response is not None:
            return self.response
        return _success_response(request.urls, ["content"] * len(request.urls))


def _source(url: str, *, metadata: dict | None = None) -> WebSource:
    return WebSource(
        source_id="provider-private-id",
        url=url,
        domain="example.com",
        metadata=metadata or {"raw_provider_field": "drop-me"},
    )


def _success_response(urls: list[str], contents: list[str]) -> WebFetchResponse:
    return WebFetchResponse(
        provider_id="recording",
        status="success",
        items=[
            WebFetchItem(
                requested_url=url,
                status="success",
                source=_source(url),
                content=content,
            )
            for url, content in zip(urls, contents, strict=True)
        ],
        metadata={"provider_request_id": "request-1", "raw": "drop-me"},
    )


def _service(tmp_path) -> tuple[WebService, RecordingFetchProvider]:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    repositories.web_settings.upsert_provider(
        "recording",
        config={},
        secrets={"api_key": "runtime-secret"},
    )
    repositories.web_settings.save(
        enabled=True,
        active_provider_id="recording",
        providers={},
    )
    provider = RecordingFetchProvider()
    return WebService(repositories, WebProviderRegistry((provider,))), provider


@pytest.mark.anyio
async def test_web_service_fetch_deduplicates_urls_and_forwards_query(tmp_path) -> None:
    service, provider = _service(tmp_path)

    response = await service.fetch(
        WebFetchRequest(
            urls=["https://EXAMPLE.com:443/a#x", "https://example.com/a"],
            query="target section",
        )
    )

    assert provider.requests[0].urls == ["https://example.com/a"]
    assert provider.requests[0].query == "target section"
    assert provider.contexts[0].secrets == {"api_key": "runtime-secret"}
    assert len(response.items) == 1
    assert response.items[0].source is not None
    assert response.items[0].source.source_id.startswith("src_")
    assert response.metadata["provider_request_id"] == "request-1"
    assert "raw" not in response.metadata


@pytest.mark.anyio
async def test_web_service_fetch_rejects_unsafe_url_before_provider_call(tmp_path) -> None:
    service, provider = _service(tmp_path)

    with pytest.raises(WebProviderError) as caught:
        await service.fetch(WebFetchRequest(urls=["http://127.0.0.1/private"]))

    assert caught.value.code == "unsafe_url"
    assert provider.requests == []


@pytest.mark.anyio
async def test_web_service_fetch_preserves_partial_success_and_sanitizes_failure(tmp_path) -> None:
    service, provider = _service(tmp_path)
    provider.response = WebFetchResponse(
        provider_id="recording",
        status="partial_failure",
        items=[
            WebFetchItem(
                requested_url="https://ok.test/",
                status="success",
                source=_source("https://ok.test/"),
                content="kept content",
            ),
            WebFetchItem(
                requested_url="https://failed.test/",
                status="failed",
                error_code="provider_private_error",
                error_message="raw failure details",
            ),
        ],
    )

    response = await service.fetch(
        WebFetchRequest(urls=["https://ok.test", "https://failed.test"])
    )

    assert response.status == "partial_failure"
    assert response.items[0].content == "kept content"
    assert response.items[1].error_code == "fetch_failed"
    assert response.items[1].error_message == "网页内容读取失败"


@pytest.mark.anyio
async def test_web_service_fetch_preserves_stable_all_failed_response(tmp_path) -> None:
    service, provider = _service(tmp_path)
    provider.response = WebFetchResponse(
        provider_id="recording",
        status="failed",
        items=[
            WebFetchItem(
                requested_url="https://failed.test/",
                status="failed",
                error_code="response_missing",
            )
        ],
    )

    response = await service.fetch(WebFetchRequest(urls=["https://failed.test"]))

    assert response.status == "failed"
    assert response.items[0].error_code == "response_missing"


@pytest.mark.anyio
async def test_web_service_fetch_applies_page_and_total_content_budgets(tmp_path) -> None:
    service, provider = _service(tmp_path)
    urls = [f"https://example.com/{index}" for index in range(4)]
    provider.response = _success_response(urls, ["网" * 25_000] * 4)

    response = await service.fetch(WebFetchRequest(urls=urls))

    assert [len(item.content or "") for item in response.items] == [20_000, 20_000, 20_000, 0]
    assert all(item.source is not None for item in response.items)
    assert [item.source.truncated for item in response.items if item.source] == [
        True,
        True,
        True,
        True,
    ]


@pytest.mark.anyio
@pytest.mark.parametrize(
    "code",
    [WebErrorCode.REQUEST_TIMEOUT, WebErrorCode.AUTHENTICATION_FAILED],
)
async def test_web_service_fetch_preserves_provider_errors(
    tmp_path,
    code: WebErrorCode,
) -> None:
    service, provider = _service(tmp_path)
    provider.error = WebProviderError(web_error(code, provider_id="recording"))

    with pytest.raises(WebProviderError) as caught:
        await service.fetch(WebFetchRequest(urls=["https://example.com"]))

    assert caught.value.code == code


@pytest.mark.anyio
async def test_web_service_fetch_propagates_cancellation(tmp_path) -> None:
    service, provider = _service(tmp_path)
    provider.error = asyncio.CancelledError()

    with pytest.raises(asyncio.CancelledError):
        await service.fetch(WebFetchRequest(urls=["https://example.com"]))


@pytest.mark.anyio
async def test_web_service_fetch_rejects_incomplete_provider_response(tmp_path) -> None:
    service, provider = _service(tmp_path)
    provider.response = _success_response(["https://other.test/"], ["unexpected"])

    with pytest.raises(WebProviderError) as caught:
        await service.fetch(WebFetchRequest(urls=["https://example.com"]))

    assert caught.value.code == "response_invalid"


@pytest.mark.anyio
async def test_web_service_fetch_rejects_unsafe_url_from_provider_response(tmp_path) -> None:
    service, provider = _service(tmp_path)
    provider.response = WebFetchResponse(
        provider_id="recording",
        status="success",
        items=[
            WebFetchItem(
                requested_url="https://example.com/",
                status="success",
                source=_source("http://127.0.0.1/private"),
                content="unexpected",
            )
        ],
    )

    with pytest.raises(WebProviderError) as caught:
        await service.fetch(WebFetchRequest(urls=["https://example.com"]))

    assert caught.value.code == "response_invalid"
