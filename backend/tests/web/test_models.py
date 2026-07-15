import pytest
from pydantic import ValidationError

from backend.app.web.models import (
    WebFetchItem,
    WebFetchRequest,
    WebFetchResponse,
    WebSearchRequest,
    WebSearchResponse,
    WebSource,
)


def _source(url: str = "https://example.com/article") -> WebSource:
    return WebSource(
        source_id="src_example",
        url=url,
        domain="example.com",
        title="Example",
        snippet="A result",
        favicon="https://example.com/favicon.ico",
        score=0.75,
    )


def test_search_models_accept_complete_and_minimal_results() -> None:
    request = WebSearchRequest(
        query="latest release",
        time_range="week",
        domains=["EXAMPLE.COM.", "example.com"],
    )
    response = WebSearchResponse(
        provider_id="provider-a",
        query=request.query,
        sources=[
            _source(),
            WebSource(source_id="src_min", url="https://other.test", domain="other.test"),
        ],
        duration_ms=12,
    )

    assert request.domains == ["example.com"]
    assert request.max_results == 5
    assert len(response.sources) == 2
    assert response.sources[1].title is None


@pytest.mark.parametrize("query", ["", "   "])
def test_search_request_rejects_empty_query(query: str) -> None:
    with pytest.raises(ValidationError):
        WebSearchRequest(query=query)


@pytest.mark.parametrize("domain", ["https://example.com", "example.com/docs", ""])
def test_search_request_rejects_non_hostname_domains(domain: str) -> None:
    with pytest.raises(ValidationError):
        WebSearchRequest(query="query", domains=[domain])


@pytest.mark.parametrize("max_results", [0, 21, True, 5.5, "10"])
def test_search_request_rejects_invalid_result_count(max_results: object) -> None:
    with pytest.raises(ValidationError):
        WebSearchRequest(query="query", max_results=max_results)


def test_fetch_request_enforces_url_count_and_normalizes_empty_query() -> None:
    request = WebFetchRequest(urls=["https://example.com"], query="  ")

    assert request.query is None

    with pytest.raises(ValidationError):
        WebFetchRequest(urls=[])
    with pytest.raises(ValidationError):
        WebFetchRequest(urls=[f"https://example.com/{index}" for index in range(6)])


def test_source_rejects_non_http_urls_and_unknown_fields() -> None:
    with pytest.raises(ValidationError):
        _source("file:///tmp/secret")
    with pytest.raises(ValidationError):
        WebSource(
            source_id="src_bad",
            url="https://example.com",
            domain="example.com",
            provider_private={"raw": True},
        )


def test_fetch_response_accepts_partial_failure() -> None:
    response = WebFetchResponse(
        provider_id="provider-a",
        status="partial_failure",
        items=[
            WebFetchItem(
                requested_url="https://example.com/article",
                status="success",
                source=_source(),
                content="article text",
            ),
            WebFetchItem(
                requested_url="https://example.com/missing",
                status="failed",
                error_code="not_found",
                error_message="Page unavailable",
            ),
        ],
    )

    assert response.status == "partial_failure"
    assert response.items[0].content == "article text"


def test_fetch_response_rejects_mismatched_aggregate_status() -> None:
    with pytest.raises(ValidationError, match="聚合状态"):
        WebFetchResponse(
            provider_id="provider-a",
            status="success",
            items=[
                WebFetchItem(
                    requested_url="https://example.com/missing",
                    status="failed",
                    error_code="not_found",
                )
            ],
        )


def test_fetch_items_enforce_success_and_failure_shapes() -> None:
    with pytest.raises(ValidationError, match="必须包含 source"):
        WebFetchItem(requested_url="https://example.com", status="success")
    with pytest.raises(ValidationError, match="必须包含 error_code"):
        WebFetchItem(requested_url="https://example.com", status="failed")
