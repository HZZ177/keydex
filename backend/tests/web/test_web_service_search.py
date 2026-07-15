from __future__ import annotations

import asyncio

import pytest
from pydantic import ValidationError

from backend.app.storage import StorageRepositories, init_database
from backend.app.web.config import WebProviderConfigField
from backend.app.web.errors import WebErrorCode, WebProviderError, web_error
from backend.app.web.models import WebCapability, WebSearchRequest, WebSearchResponse, WebSource
from backend.app.web.provider import BaseWebProvider, WebProviderContext, WebProviderDescriptor
from backend.app.web.registry import WebProviderRegistry
from backend.app.web.service import WebService


class RecordingSearchProvider(BaseWebProvider):
    descriptor = WebProviderDescriptor(
        provider_id="recording",
        display_name="Recording",
        description="记录 Search 调用",
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

    def __init__(self) -> None:
        self.requests: list[WebSearchRequest] = []
        self.contexts: list[WebProviderContext] = []
        self.sources: list[WebSource] = []
        self.error: BaseException | None = None
        self.response_provider_id = "recording"

    async def search(
        self,
        request: WebSearchRequest,
        context: WebProviderContext,
    ) -> WebSearchResponse:
        self.requests.append(request)
        self.contexts.append(context)
        if self.error is not None:
            raise self.error
        return WebSearchResponse(
            provider_id=self.response_provider_id,
            query="provider-mutated-query",
            sources=self.sources,
            metadata={
                "provider_request_id": "request-1",
                "credits": 1,
                "raw_provider_field": "drop-me",
            },
        )


def _source(index: int) -> WebSource:
    return WebSource(
        source_id=f"src_{index}",
        url=f"https://example.com/{index}",
        domain="example.com",
        title=f"Source {index}",
        metadata={"provider_private": "drop-me"},
    )


def _service(tmp_path) -> tuple[WebService, RecordingSearchProvider]:
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
    provider = RecordingSearchProvider()
    return WebService(repositories, WebProviderRegistry((provider,))), provider


@pytest.mark.anyio
async def test_web_service_search_forwards_semantic_request_and_controls_metadata(tmp_path) -> None:
    service, provider = _service(tmp_path)
    provider.sources = [_source(0)]
    request = WebSearchRequest(
        query="recent Keydex",
        time_range="week",
        domains=["example.com"],
    )

    response = await service.search(request)

    assert provider.requests == [request]
    assert provider.contexts[0].secrets == {"api_key": "runtime-secret"}
    assert response.query == "recent Keydex"
    assert response.metadata == {
        "provider_request_id": "request-1",
        "credits": 1,
        "source_count_original": 1,
        "source_count_returned": 1,
        "sources_truncated": False,
    }
    assert response.sources[0].metadata == {}


@pytest.mark.anyio
async def test_web_service_search_accepts_empty_results(tmp_path) -> None:
    service, _provider = _service(tmp_path)

    response = await service.search(WebSearchRequest(query="no results"))

    assert response.sources == []
    assert response.metadata["source_count_returned"] == 0


@pytest.mark.anyio
async def test_web_service_search_uses_five_sources_by_default(tmp_path) -> None:
    service, provider = _service(tmp_path)
    provider.sources = [_source(index) for index in range(8)]

    response = await service.search(WebSearchRequest(query="many results"))

    assert [source.source_id for source in response.sources] == [
        f"src_{index}" for index in range(5)
    ]
    assert response.metadata["sources_truncated"] is True


@pytest.mark.anyio
async def test_web_service_search_honors_agent_requested_source_count(tmp_path) -> None:
    service, provider = _service(tmp_path)
    provider.sources = [_source(index) for index in range(20)]

    response = await service.search(
        WebSearchRequest(query="broad research", max_results=14)
    )

    assert [source.source_id for source in response.sources] == [
        f"src_{index}" for index in range(14)
    ]
    assert response.metadata["source_count_original"] == 20
    assert response.metadata["source_count_returned"] == 14
    assert response.metadata["sources_truncated"] is True


@pytest.mark.anyio
@pytest.mark.parametrize(
    "code",
    [
        WebErrorCode.AUTHENTICATION_FAILED,
        WebErrorCode.REQUEST_TIMEOUT,
        WebErrorCode.RATE_LIMITED,
    ],
)
async def test_web_service_search_preserves_stable_provider_errors(
    tmp_path,
    code: WebErrorCode,
) -> None:
    service, provider = _service(tmp_path)
    provider.error = WebProviderError(web_error(code, provider_id="recording"))

    with pytest.raises(WebProviderError) as caught:
        await service.search(WebSearchRequest(query="error"))

    assert caught.value.code == code


@pytest.mark.anyio
async def test_web_service_search_converts_unexpected_error_safely(tmp_path) -> None:
    service, provider = _service(tmp_path)
    raw = "unexpected-private-value"
    provider.error = RuntimeError(raw)

    with pytest.raises(WebProviderError) as caught:
        await service.search(WebSearchRequest(query="error"))

    assert caught.value.code == "provider_unavailable"
    assert raw not in str(caught.value.payload.to_log_dict())


@pytest.mark.anyio
async def test_web_service_search_propagates_cancellation(tmp_path) -> None:
    service, provider = _service(tmp_path)
    provider.error = asyncio.CancelledError()

    with pytest.raises(asyncio.CancelledError):
        await service.search(WebSearchRequest(query="cancel"))


@pytest.mark.anyio
async def test_web_service_search_rejects_mismatched_provider_response(tmp_path) -> None:
    service, provider = _service(tmp_path)
    provider.response_provider_id = "other-provider"

    with pytest.raises(WebProviderError) as caught:
        await service.search(WebSearchRequest(query="mismatch"))

    assert caught.value.code == "response_invalid"


def test_web_search_request_rejects_invalid_inputs_before_service_call() -> None:
    with pytest.raises(ValidationError):
        WebSearchRequest(query="  ")
    with pytest.raises(ValidationError):
        WebSearchRequest(query="query", time_range="hour")
    with pytest.raises(ValidationError):
        WebSearchRequest(query="query", domains=["https://example.com"])
    with pytest.raises(ValidationError):
        WebSearchRequest(query="query", max_results=0)
    with pytest.raises(ValidationError):
        WebSearchRequest(query="query", max_results=21)
