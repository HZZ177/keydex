from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from backend.app.web.provider import WebProviderContext
from backend.app.web.providers.tavily import TavilyProvider


async def _check_with_handler(handler, *, key: str = "test-secret"):
    async with httpx.AsyncClient(
        base_url="https://mock.tavily.test",
        transport=httpx.MockTransport(handler),
    ) as client:
        return await TavilyProvider(http_client=client).check_connection(
            WebProviderContext(secrets={"api_key": key})
        )


@pytest.mark.anyio
async def test_tavily_connection_check_uses_credit_free_usage_endpoint() -> None:
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(
            200,
            json={"key": {"usage": 1, "limit": 1000}, "account": {}},
        )

    result = await _check_with_handler(handler)

    assert result.ok is True
    assert result.error is None
    assert result.duration_ms is not None
    assert len(captured) == 1
    assert captured[0].method == "GET"
    assert captured[0].url == "https://mock.tavily.test/usage"
    assert captured[0].content == b""


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("status_code", "expected_code"),
    [
        (401, "authentication_failed"),
        (432, "quota_exhausted"),
        (433, "quota_exhausted"),
        (429, "rate_limited"),
    ],
)
async def test_tavily_connection_check_maps_http_failures(
    status_code: int,
    expected_code: str,
) -> None:
    result = await _check_with_handler(
        lambda _request: httpx.Response(
            status_code,
            headers={"Retry-After": "6"},
            text="private provider error",
        )
    )

    assert result.ok is False
    assert result.error is not None
    assert result.error.code == expected_code
    assert result.error.retry_after_seconds == (6 if status_code == 429 else None)


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("error", "expected_code"),
    [
        (httpx.ReadTimeout("slow"), "request_timeout"),
        (httpx.ConnectError("offline"), "network_unavailable"),
    ],
)
async def test_tavily_connection_check_maps_transport_failures(
    error: Exception,
    expected_code: str,
) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        del request
        raise error

    result = await _check_with_handler(handler)

    assert result.ok is False
    assert result.error is not None
    assert result.error.code == expected_code


@pytest.mark.anyio
async def test_tavily_connection_check_propagates_cancellation() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        del request
        raise asyncio.CancelledError

    with pytest.raises(asyncio.CancelledError):
        await _check_with_handler(handler)


@pytest.mark.anyio
async def test_tavily_connection_check_does_not_return_or_log_secret_material() -> None:
    raw = "connection-check-private-key"

    def handler(request: httpx.Request) -> httpx.Response:
        assert raw in request.headers["Authorization"]
        return httpx.Response(401, text=f"invalid {raw}")

    result = await _check_with_handler(handler, key=raw)
    serialized = json.dumps(result.model_dump(mode="json"), ensure_ascii=False)

    assert result.ok is False
    assert raw not in serialized


@pytest.mark.anyio
async def test_tavily_connection_check_reports_missing_key_without_request() -> None:
    requests: list[httpx.Request] = []

    result = await _check_with_handler(
        lambda request: requests.append(request) or httpx.Response(200, json={}),
        key="",
    )

    assert result.ok is False
    assert result.error is not None
    assert result.error.code == "provider_not_configured"
    assert requests == []
