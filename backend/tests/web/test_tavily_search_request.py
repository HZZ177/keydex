from __future__ import annotations

import pytest
from pydantic import ValidationError

from backend.app.web.models import WebSearchRequest
from backend.app.web.providers.tavily import build_tavily_search_payload


def test_tavily_search_payload_applies_fixed_safe_product_policy() -> None:
    payload = build_tavily_search_payload(WebSearchRequest(query="Keydex web search"))

    assert payload == {
        "query": "Keydex web search",
        "search_depth": "basic",
        "topic": "general",
        "max_results": 5,
        "include_answer": False,
        "include_raw_content": False,
        "include_images": False,
        "include_image_descriptions": False,
        "include_favicon": True,
        "auto_parameters": False,
        "exact_match": False,
        "include_usage": False,
        "safe_search": True,
    }


@pytest.mark.parametrize("time_range", ["day", "week", "month", "year"])
def test_tavily_search_payload_maps_supported_time_range(time_range: str) -> None:
    request = WebSearchRequest(query="recent news", time_range=time_range)

    assert build_tavily_search_payload(request)["time_range"] == time_range


def test_tavily_search_payload_maps_agent_requested_result_count() -> None:
    request = WebSearchRequest(query="broad research", max_results=20)

    assert build_tavily_search_payload(request)["max_results"] == 20


def test_tavily_search_payload_deduplicates_domains_stably() -> None:
    request = WebSearchRequest(
        query="docs",
        domains=["Example.com", "docs.example.com.", "example.com", " DOCS.EXAMPLE.COM "],
    )

    assert build_tavily_search_payload(request)["include_domains"] == [
        "example.com",
        "docs.example.com",
    ]


@pytest.mark.parametrize(
    "payload",
    [
        {"query": ""},
        {"query": "   "},
        {"query": "news", "time_range": "hour"},
        {"query": "news", "max_results": 0},
        {"query": "news", "max_results": 21},
        {"query": "docs", "domains": [f"domain-{index}.test" for index in range(11)]},
    ],
)
def test_web_search_request_rejects_invalid_semantic_input(payload: dict) -> None:
    with pytest.raises(ValidationError):
        WebSearchRequest(**payload)


def test_tavily_search_payload_does_not_accept_provider_tuning_parameters() -> None:
    with pytest.raises(ValidationError):
        WebSearchRequest(
            query="docs",
            search_depth="advanced",
            include_answer=True,
        )
