from __future__ import annotations

import json

import httpx
import pytest

from backend.app.web.errors import WebProviderError
from backend.app.web.models import WebSearchRequest
from backend.app.web.provider import WebProviderContext
from backend.app.web.providers.tavily import (
    TavilyProvider,
    normalize_tavily_search_response,
)


def test_tavily_search_response_normalizes_complete_result() -> None:
    request = WebSearchRequest(query="Keydex")

    response = normalize_tavily_search_response(
        request,
        {
            "results": [
                {
                    "title": " Keydex Docs ",
                    "url": "HTTPS://EXAMPLE.COM:443/docs#section",
                    "content": " Search and fetch docs. ",
                    "favicon": "https://example.com/favicon.ico",
                    "published_date": "2026-07-15",
                    "score": 0.82,
                    "provider_private": "must-not-pass",
                }
            ],
            "response_time": "1.25",
            "request_id": "request-1",
            "usage": {"credits": 1, "private": "ignored"},
            "answer": "must-not-pass",
        },
    )

    source = response.sources[0]
    assert source.url == "https://example.com/docs"
    assert source.domain == "example.com"
    assert source.title == "Keydex Docs"
    assert source.snippet == "Search and fetch docs."
    assert source.published_at == "2026-07-15"
    assert source.score == 0.82
    assert response.duration_ms == 1250
    assert response.metadata == {"provider_request_id": "request-1", "credits": 1}
    assert "provider_private" not in json.dumps(response.model_dump())
    assert "must-not-pass" not in json.dumps(response.model_dump())


def test_tavily_search_response_accepts_empty_and_minimal_results() -> None:
    request = WebSearchRequest(query="nothing")

    empty = normalize_tavily_search_response(request, {"results": []})
    minimal = normalize_tavily_search_response(
        request,
        {"results": [{"url": "https://example.com"}]},
    )

    assert empty.sources == []
    assert minimal.sources[0].url == "https://example.com/"
    assert minimal.sources[0].title is None
    assert minimal.sources[0].favicon is None
    assert minimal.sources[0].published_at is None


def test_tavily_search_response_deduplicates_normalized_urls_stably() -> None:
    response = normalize_tavily_search_response(
        WebSearchRequest(query="duplicates"),
        {
            "results": [
                {"url": "https://example.com", "title": "first"},
                {"url": "https://EXAMPLE.com:443/#fragment", "title": "second"},
                {"url": "https://other.test/path", "title": "third"},
            ]
        },
    )

    assert [source.title for source in response.sources] == ["first", "third"]
    assert response.sources[0].source_id.startswith("src_")


@pytest.mark.parametrize(
    "response",
    [
        {},
        {"results": {}},
        {"results": ["invalid"]},
        {"results": [{}]},
        {"results": [{"url": "file:///secret"}]},
        {"results": [{"url": "https://example.com", "favicon": "data:image/png,x"}]},
        {"results": [{"url": "https://example.com", "score": "high"}]},
        {"results": [{"url": "https://example.com", "score": 1.5}]},
        {"results": [], "response_time": "invalid"},
    ],
)
def test_tavily_search_response_rejects_invalid_shapes(response: dict) -> None:
    with pytest.raises(WebProviderError) as caught:
        normalize_tavily_search_response(WebSearchRequest(query="query"), response)

    assert caught.value.code == "response_invalid"
    assert "response" not in caught.value.payload.diagnostic


@pytest.mark.anyio
async def test_tavily_provider_search_calls_http_and_returns_normalized_sources() -> None:
    captured: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(json.loads(request.content))
        return httpx.Response(
            200,
            json={"results": [{"url": "https://example.com", "content": "snippet"}]},
        )

    async with httpx.AsyncClient(
        base_url="https://mock.tavily.test",
        transport=httpx.MockTransport(handler),
    ) as client:
        response = await TavilyProvider(http_client=client).search(
            WebSearchRequest(query="Keydex"),
            WebProviderContext(secrets={"api_key": "test-secret"}),
        )

    assert captured[0]["query"] == "Keydex"
    assert captured[0]["include_answer"] is False
    assert response.sources[0].snippet == "snippet"
