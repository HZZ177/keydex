from __future__ import annotations

import pytest
from pydantic import ValidationError

from backend.app.web.models import WebFetchRequest
from backend.app.web.providers.tavily import build_tavily_extract_payload


def test_tavily_extract_payload_maps_single_url_with_fixed_basic_policy() -> None:
    payload = build_tavily_extract_payload(
        WebFetchRequest(urls=["https://example.com/article"])
    )

    assert payload == {
        "urls": ["https://example.com/article"],
        "extract_depth": "basic",
        "include_images": False,
        "include_favicon": True,
        "format": "markdown",
        "include_usage": False,
    }


def test_tavily_extract_payload_preserves_five_url_order_and_duplicates() -> None:
    urls = [
        "https://one.test",
        "https://two.test",
        "https://one.test",
        "https://four.test",
        "https://five.test",
    ]

    payload = build_tavily_extract_payload(WebFetchRequest(urls=urls))

    assert payload["urls"] == urls


def test_tavily_extract_payload_maps_optional_reranking_query() -> None:
    payload = build_tavily_extract_payload(
        WebFetchRequest(
            urls=["https://example.com/article"],
            query=" machine learning applications ",
        )
    )

    assert payload["query"] == "machine learning applications"
    assert payload["chunks_per_source"] == 3


def test_tavily_extract_payload_omits_empty_query() -> None:
    request = WebFetchRequest(urls=["https://example.com/article"], query="   ")

    payload = build_tavily_extract_payload(request)

    assert request.query is None
    assert "query" not in payload
    assert "chunks_per_source" not in payload


@pytest.mark.parametrize(
    "urls",
    [[], [f"https://example.com/{index}" for index in range(6)]],
)
def test_web_fetch_request_rejects_zero_or_more_than_five_urls(urls: list[str]) -> None:
    with pytest.raises(ValidationError):
        WebFetchRequest(urls=urls)


def test_tavily_extract_does_not_expose_provider_tuning_parameters() -> None:
    with pytest.raises(ValidationError):
        WebFetchRequest(
            urls=["https://example.com"],
            extract_depth="advanced",
            format="text",
        )
