from __future__ import annotations

import json

import httpx
import pytest

from backend.app.web.errors import WebProviderError
from backend.app.web.models import WebFetchRequest
from backend.app.web.provider import WebProviderContext
from backend.app.web.providers.tavily import (
    TavilyProvider,
    normalize_tavily_extract_response,
)


def test_tavily_extract_response_normalizes_all_success() -> None:
    request = WebFetchRequest(
        urls=["https://example.com/article", "https://other.test/docs"]
    )

    response = normalize_tavily_extract_response(
        request,
        {
            "results": [
                {
                    "url": "https://EXAMPLE.com:443/article#fragment",
                    "raw_content": "Article content",
                    "favicon": "https://example.com/favicon.ico",
                    "images": ["must-not-pass"],
                },
                {"url": "https://other.test/docs", "raw_content": "Docs content"},
            ],
            "failed_results": [],
            "response_time": 0.25,
            "request_id": "extract-request",
        },
    )

    assert response.status == "success"
    assert [item.status for item in response.items] == ["success", "success"]
    assert response.items[0].content == "Article content"
    assert response.items[0].source is not None
    assert response.items[0].source.url == "https://example.com/article"
    assert response.duration_ms == 250
    assert "must-not-pass" not in json.dumps(response.model_dump())


def test_tavily_extract_response_preserves_success_on_partial_failure() -> None:
    request = WebFetchRequest(urls=["https://ok.test", "https://failed.test"])

    response = normalize_tavily_extract_response(
        request,
        {
            "results": [{"url": "https://ok.test", "raw_content": "kept"}],
            "failed_results": [
                {"url": "https://failed.test", "error": "raw provider failure"}
            ],
        },
    )

    assert response.status == "partial_failure"
    assert response.items[0].content == "kept"
    assert response.items[1].error_code == "fetch_failed"
    assert "raw provider failure" not in json.dumps(response.model_dump())


def test_tavily_extract_response_returns_stable_all_failed_items() -> None:
    request = WebFetchRequest(urls=["https://one.test", "https://two.test"])

    response = normalize_tavily_extract_response(
        request,
        {
            "results": [],
            "failed_results": [{"url": "https://one.test"}, {"url": "https://two.test"}],
        },
    )

    assert response.status == "failed"
    assert [item.error_code for item in response.items] == ["fetch_failed", "fetch_failed"]


def test_tavily_extract_response_marks_url_missing_from_provider_response() -> None:
    response = normalize_tavily_extract_response(
        WebFetchRequest(urls=["https://returned.test", "https://missing.test"]),
        {
            "results": [{"url": "https://returned.test", "raw_content": "returned"}],
            "failed_results": [],
        },
    )

    assert response.status == "partial_failure"
    assert response.items[1].error_code == "response_missing"


def test_tavily_extract_response_distinguishes_empty_success_from_failure() -> None:
    response = normalize_tavily_extract_response(
        WebFetchRequest(urls=["https://empty.test"]),
        {"results": [{"url": "https://empty.test", "raw_content": ""}]},
    )

    item = response.items[0]
    assert item.status == "success"
    assert item.content is None
    assert item.source is not None
    assert item.source.metadata == {"empty_content": True}


def test_tavily_extract_response_reuses_success_for_duplicate_input_urls() -> None:
    response = normalize_tavily_extract_response(
        WebFetchRequest(urls=["https://same.test", "https://same.test/"]),
        {"results": [{"url": "https://same.test", "raw_content": "same"}]},
    )

    assert len(response.items) == 2
    assert response.items[0].source is not None
    assert response.items[1].source is not None
    assert response.items[0].source.source_id == response.items[1].source.source_id


@pytest.mark.parametrize(
    "response",
    [
        {},
        {"results": {}},
        {"results": [], "failed_results": {}},
        {"results": ["invalid"]},
        {"results": [{"url": "https://one.test"}]},
        {"results": [{"url": "file:///secret", "raw_content": "x"}]},
        {"results": [{"url": "https://unexpected.test", "raw_content": "x"}]},
        {"results": [], "failed_results": [{}]},
        {
            "results": [{"url": "https://one.test", "raw_content": "ok"}],
            "failed_results": [{"url": "https://one.test"}],
        },
    ],
)
def test_tavily_extract_response_rejects_invalid_shapes(response: dict) -> None:
    with pytest.raises(WebProviderError) as caught:
        normalize_tavily_extract_response(
            WebFetchRequest(urls=["https://one.test"]),
            response,
        )

    assert caught.value.code == "response_invalid"


@pytest.mark.anyio
async def test_tavily_provider_fetch_calls_extract_without_local_target_request() -> None:
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(
            200,
            json={
                "results": [
                    {"url": "https://target.example/article", "raw_content": "content"}
                ]
            },
        )

    async with httpx.AsyncClient(
        base_url="https://mock.tavily.test",
        transport=httpx.MockTransport(handler),
    ) as client:
        response = await TavilyProvider(http_client=client).fetch(
            WebFetchRequest(urls=["https://target.example/article"]),
            WebProviderContext(secrets={"api_key": "test-secret"}),
        )

    assert len(captured) == 1
    assert captured[0].url == "https://mock.tavily.test/extract"
    assert response.items[0].content == "content"
