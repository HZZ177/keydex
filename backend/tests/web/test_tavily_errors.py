from __future__ import annotations

import httpx
import pytest

from backend.app.web.errors import WebProviderError
from backend.app.web.models import WebSearchRequest
from backend.app.web.provider import WebProviderContext
from backend.app.web.providers.tavily import TavilyProvider, map_tavily_error
from backend.app.web.providers.tavily_http import (
    TavilyHttpStatusError,
    TavilyResponseError,
)


@pytest.mark.parametrize(
    ("status_code", "expected_code", "retryable"),
    [
        (400, "invalid_request", False),
        (401, "authentication_failed", False),
        (403, "authentication_failed", False),
        (402, "quota_exhausted", False),
        (432, "quota_exhausted", False),
        (433, "quota_exhausted", False),
        (429, "rate_limited", True),
        (500, "provider_unavailable", True),
        (503, "provider_unavailable", True),
        (418, "provider_unavailable", True),
    ],
)
def test_map_tavily_http_statuses(
    status_code: int,
    expected_code: str,
    retryable: bool,
) -> None:
    mapped = map_tavily_error(
        TavilyHttpStatusError(
            status_code,
            retry_after="12",
            request_id="safe-request-id",
        )
    )

    assert mapped.code == expected_code
    assert mapped.payload.retryable is retryable
    assert mapped.payload.retry_after_seconds == (12 if status_code == 429 else None)
    assert mapped.payload.diagnostic == {
        "status_code": status_code,
        "provider_request_id": "safe-request-id",
    }
    public = mapped.to_public_dict()
    assert public["status"] == status_code
    assert public["details"]["provider_id"] == "tavily"
    assert public["details"]["provider_request_id"] == "safe-request-id"


@pytest.mark.parametrize("retry_after", [None, "", "invalid", "-1", "Wed, 21 Oct 2026"])
def test_map_tavily_rate_limit_ignores_unsafe_retry_after(retry_after: str | None) -> None:
    mapped = map_tavily_error(TavilyHttpStatusError(429, retry_after=retry_after))

    assert mapped.code == "rate_limited"
    assert mapped.payload.retry_after_seconds is None


@pytest.mark.parametrize(
    ("error", "expected_code"),
    [
        (httpx.ReadTimeout("slow"), "request_timeout"),
        (httpx.ConnectTimeout("connect slow"), "request_timeout"),
        (httpx.ConnectError("dns failed"), "network_unavailable"),
        (httpx.ReadError("connection reset"), "network_unavailable"),
        (TavilyResponseError("invalid json"), "response_invalid"),
        (RuntimeError("unknown"), "provider_unavailable"),
    ],
)
def test_map_tavily_transport_and_response_errors(error: Exception, expected_code: str) -> None:
    mapped = map_tavily_error(error)

    assert mapped.code == expected_code
    assert mapped.payload.provider_id == "tavily"
    assert mapped.payload.diagnostic == {"type": type(error).__name__}


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("status_code", "expected_code"),
    [(401, "authentication_failed"), (432, "quota_exhausted"), (429, "rate_limited")],
)
async def test_tavily_provider_maps_mock_http_errors(
    status_code: int,
    expected_code: str,
) -> None:
    raw = "error-map-secret"

    def handler(request: httpx.Request) -> httpx.Response:
        assert raw in request.headers["Authorization"]
        return httpx.Response(
            status_code,
            headers={"Retry-After": "9"},
            text=f"provider body contains {raw}",
        )

    async with httpx.AsyncClient(
        base_url="https://mock.tavily.test",
        transport=httpx.MockTransport(handler),
    ) as client:
        with pytest.raises(WebProviderError) as caught:
            await TavilyProvider(http_client=client).search(
                WebSearchRequest(query="query"),
                WebProviderContext(secrets={"api_key": raw}),
            )

    assert caught.value.code == expected_code
    assert raw not in str(caught.value.payload.to_log_dict())


@pytest.mark.anyio
async def test_tavily_provider_maps_non_json_success_response() -> None:
    async with httpx.AsyncClient(
        base_url="https://mock.tavily.test",
        transport=httpx.MockTransport(
            lambda _request: httpx.Response(200, text="not-json")
        ),
    ) as client:
        with pytest.raises(WebProviderError) as caught:
            await TavilyProvider(http_client=client).search(
                WebSearchRequest(query="query"),
                WebProviderContext(secrets={"api_key": "safe-test-key"}),
            )

    assert caught.value.code == "response_invalid"
