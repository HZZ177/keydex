from __future__ import annotations

from backend.app.web.models import (
    WEB_SEARCH_MAX_RESULTS,
    WebFetchItem,
    WebFetchResponse,
    WebSearchResponse,
    WebSource,
)
from backend.app.web.policies import (
    WEB_FETCH_PAGE_CHAR_BUDGET,
    WEB_FETCH_TOTAL_CHAR_BUDGET,
    apply_fetch_content_budget,
    apply_search_source_budget,
)


def _source(index: int) -> WebSource:
    url = f"https://example.com/{index}"
    return WebSource(
        source_id=f"src_{index}",
        url=url,
        domain="example.com",
        title=f"Source {index}",
    )


def _fetch_response(contents: list[str | None]) -> WebFetchResponse:
    return WebFetchResponse(
        provider_id="test",
        status="success",
        items=[
            WebFetchItem(
                requested_url=f"https://example.com/{index}",
                status="success",
                source=_source(index),
                content=content,
            )
            for index, content in enumerate(contents)
        ],
    )


def test_search_budget_honors_requested_source_count_with_metadata() -> None:
    response = WebSearchResponse(
        provider_id="test",
        query="query",
        sources=[_source(index) for index in range(8)],
    )

    budgeted = apply_search_source_budget(response, max_sources=5)

    assert len(budgeted.sources) == 5
    assert [source.source_id for source in budgeted.sources] == [
        f"src_{index}" for index in range(5)
    ]
    assert budgeted.metadata == {
        "source_count_original": 8,
        "source_count_returned": 5,
        "sources_truncated": True,
    }


def test_search_budget_marks_results_within_budget_without_dropping_metadata() -> None:
    response = WebSearchResponse(
        provider_id="test",
        query="query",
        sources=[_source(0)],
        metadata={"provider_request_id": "request-1"},
    )

    budgeted = apply_search_source_budget(response, max_sources=5)

    assert budgeted.sources == response.sources
    assert budgeted.metadata["provider_request_id"] == "request-1"
    assert budgeted.metadata["sources_truncated"] is False


def test_search_budget_never_exceeds_global_maximum() -> None:
    response = WebSearchResponse(
        provider_id="test",
        query="query",
        sources=[_source(index) for index in range(WEB_SEARCH_MAX_RESULTS + 4)],
    )

    budgeted = apply_search_source_budget(response, max_sources=100)

    assert len(budgeted.sources) == WEB_SEARCH_MAX_RESULTS
    assert budgeted.metadata["sources_truncated"] is True


def test_fetch_budget_keeps_content_at_exact_page_boundary() -> None:
    content = "a" * WEB_FETCH_PAGE_CHAR_BUDGET

    item = apply_fetch_content_budget(_fetch_response([content])).items[0]

    assert item.content == content
    assert item.source is not None
    assert item.source.truncated is False
    assert item.source.metadata == {
        "original_content_chars": WEB_FETCH_PAGE_CHAR_BUDGET,
        "content_chars": WEB_FETCH_PAGE_CHAR_BUDGET,
    }


def test_fetch_budget_truncates_single_page_stably() -> None:
    content = "0123456789" * 2_500
    response = _fetch_response([content])

    first = apply_fetch_content_budget(response)
    second = apply_fetch_content_budget(response)

    assert first == second
    assert first.items[0].content == content[:WEB_FETCH_PAGE_CHAR_BUDGET]
    assert first.items[0].source is not None
    assert first.items[0].source.truncated is True
    assert first.items[0].source.url == response.items[0].source.url
    assert first.items[0].source.source_id == response.items[0].source.source_id


def test_fetch_budget_applies_total_budget_in_stable_input_order() -> None:
    response = _fetch_response(["a" * 20_000, "b" * 20_000, "c" * 20_000, "d" * 20_000])

    budgeted = apply_fetch_content_budget(response)

    assert [len(item.content or "") for item in budgeted.items] == [20_000, 20_000, 20_000, 0]
    assert budgeted.items[3].source is not None
    assert budgeted.items[3].source.truncated is True
    assert budgeted.metadata["content_chars_returned"] == WEB_FETCH_TOTAL_CHAR_BUDGET


def test_fetch_budget_preserves_empty_success_with_explicit_metadata() -> None:
    item = apply_fetch_content_budget(_fetch_response([None])).items[0]

    assert item.status == "success"
    assert item.content is None
    assert item.source is not None
    assert item.source.truncated is False
    assert item.source.metadata == {"original_content_chars": 0, "content_chars": 0}


def test_fetch_budget_counts_unicode_codepoints_without_splitting() -> None:
    content = "网" * (WEB_FETCH_PAGE_CHAR_BUDGET + 3)

    item = apply_fetch_content_budget(_fetch_response([content])).items[0]

    assert item.content == "网" * WEB_FETCH_PAGE_CHAR_BUDGET
    assert len(item.content or "") == WEB_FETCH_PAGE_CHAR_BUDGET


def test_fetch_budget_does_not_charge_failed_items() -> None:
    response = WebFetchResponse(
        provider_id="test",
        status="partial_failure",
        items=[
            WebFetchItem(
                requested_url="https://failed.test",
                status="failed",
                error_code="fetch_failed",
                error_message="failed",
            ),
            WebFetchItem(
                requested_url="https://example.com/1",
                status="success",
                source=_source(1),
                content="x" * WEB_FETCH_PAGE_CHAR_BUDGET,
            ),
        ],
    )

    budgeted = apply_fetch_content_budget(response)

    assert budgeted.items[0] == response.items[0]
    assert len(budgeted.items[1].content or "") == WEB_FETCH_PAGE_CHAR_BUDGET
