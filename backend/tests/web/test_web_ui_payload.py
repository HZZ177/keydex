from __future__ import annotations

import pytest
from pydantic import ValidationError

from backend.app.web.ui_payload import (
    WebActivityError,
    WebActivityPayload,
    WebActivitySource,
    WebFetchActivityItem,
    build_web_activity_finished,
)


def _source() -> WebActivitySource:
    return WebActivitySource(
        source_id="src_example",
        url="https://example.com/article",
        domain="example.com",
        title="Example",
        snippet="Summary",
    )


@pytest.mark.parametrize(
    "status",
    ["running", "completed", "empty", "cancelled"],
)
def test_search_activity_supports_visible_lifecycle_states(status: str) -> None:
    payload = WebActivityPayload(
        activity_type="search",
        status=status,
        query="recent news",
        sources=[_source()] if status == "completed" else [],
    )

    assert payload.kind == "web_activity"
    assert payload.schema_version == 1
    assert payload.status == status


def test_fetch_activity_supports_partial_failure_and_truncation() -> None:
    source = _source().model_copy(update={"truncated": True})
    payload = WebActivityPayload(
        activity_type="fetch",
        status="partial_failure",
        requested_urls=[source.url, "https://failed.example/"],
        items=[
            WebFetchActivityItem(
                requested_url=source.url,
                status="success",
                source=source,
            ),
            WebFetchActivityItem(
                requested_url="https://failed.example/",
                status="failed",
                error=WebActivityError(
                    code="fetch_failed",
                    message="网页内容读取失败",
                    retryable=True,
                ),
            ),
        ],
    )

    assert payload.items[0].source is not None
    assert payload.items[0].source.truncated is True
    assert payload.items[1].error is not None


def test_failed_activity_requires_sanitized_error() -> None:
    with pytest.raises(ValidationError):
        WebActivityPayload(activity_type="search", status="failed", query="x")


def test_schema_rejects_provider_raw_content_and_secrets() -> None:
    with pytest.raises(ValidationError):
        WebActivityPayload(
            activity_type="search",
            status="running",
            query="x",
            api_key="secret",  # type: ignore[call-arg]
        )
    with pytest.raises(ValidationError):
        WebFetchActivityItem(
            requested_url="https://example.com",
            status="success",
            source=_source(),
            content="unbounded body",  # type: ignore[call-arg]
        )


def test_unknown_schema_version_is_rejected() -> None:
    with pytest.raises(ValidationError):
        WebActivityPayload.model_validate(
            {
                "kind": "web_activity",
                "schema_version": 2,
                "activity_type": "search",
                "status": "running",
            }
        )


def test_search_activity_keeps_all_twenty_agent_visible_sources() -> None:
    sources = [
        {
            "source_id": f"src_{index}",
            "url": f"https://example.com/article/{index}",
            "domain": "example.com",
            "title": f"Source {index}",
        }
        for index in range(20)
    ]

    payload = build_web_activity_finished(
        "web_search",
        {"query": "research", "sources": sources},
        started_at_ms=100,
        ended_at_ms=200,
        duration_ms=100,
    )

    assert payload is not None
    assert len(payload["sources"]) == 20
    assert payload["sources"][-1]["source_id"] == "src_19"


def test_search_activity_rejects_more_sources_than_agent_contract_allows() -> None:
    sources = [
        _source().model_copy(update={"source_id": f"src_{index}"})
        for index in range(21)
    ]

    with pytest.raises(ValidationError):
        WebActivityPayload(
            activity_type="search",
            status="completed",
            query="research",
            sources=sources,
        )
