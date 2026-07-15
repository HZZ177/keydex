from __future__ import annotations

import asyncio

import httpx
import pytest

from backend.app.web.providers.tavily_http import (
    TavilyHttpClient,
    TavilyHttpStatusError,
    TavilyResponseError,
)


def _client(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        base_url="https://mock.tavily.test",
        transport=httpx.MockTransport(handler),
    )


@pytest.mark.anyio
async def test_tavily_http_client_returns_json_and_sends_bearer_auth() -> None:
    captured: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return httpx.Response(200, json={"results": []})

    async with _client(handler) as transport_client:
        result = await TavilyHttpClient(
            "test-api-key",
            client=transport_client,
        ).request_json("POST", "/search", payload={"query": "Keydex"})

    assert result == {"results": []}
    assert captured[0].headers["Authorization"] == "Bearer test-api-key"
    assert captured[0].headers["Accept"] == "application/json"
    assert captured[0].url == "https://mock.tavily.test/search"


@pytest.mark.anyio
async def test_tavily_http_client_rejects_non_json_and_non_object_json() -> None:
    responses = iter(
        (
            httpx.Response(200, text="not-json"),
            httpx.Response(200, json=["not", "an", "object"]),
        )
    )

    async with _client(lambda _request: next(responses)) as transport_client:
        client = TavilyHttpClient("test-api-key", client=transport_client)
        with pytest.raises(TavilyResponseError, match="非 JSON"):
            await client.request_json("POST", "/search", payload={})
        with pytest.raises(TavilyResponseError, match="顶层不是对象"):
            await client.request_json("POST", "/search", payload={})


@pytest.mark.anyio
async def test_tavily_http_client_preserves_timeout_and_connect_errors() -> None:
    errors = iter(
        (
            httpx.ReadTimeout("slow response"),
            httpx.ConnectError("offline"),
        )
    )

    def handler(request: httpx.Request) -> httpx.Response:
        raise next(errors)

    async with _client(handler) as transport_client:
        client = TavilyHttpClient("test-api-key", client=transport_client)
        with pytest.raises(httpx.ReadTimeout):
            await client.request_json("POST", "/search", payload={})
        with pytest.raises(httpx.ConnectError):
            await client.request_json("POST", "/search", payload={})


@pytest.mark.anyio
async def test_tavily_http_client_propagates_cancellation() -> None:
    async def handler(request: httpx.Request) -> httpx.Response:
        del request
        raise asyncio.CancelledError

    async with _client(handler) as transport_client:
        client = TavilyHttpClient("test-api-key", client=transport_client)
        with pytest.raises(asyncio.CancelledError):
            await client.request_json("POST", "/search", payload={})


@pytest.mark.anyio
async def test_tavily_http_client_supports_custom_base_url_with_mock_transport() -> None:
    captured: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        captured.append(str(request.url))
        return httpx.Response(200, json={})

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as transport_client:
        client = TavilyHttpClient(
            "test-api-key",
            client=transport_client,
            base_url="https://custom.tavily.test/api/",
        )
        await client.request_json("GET", "/usage")

    assert captured == ["https://custom.tavily.test/api/usage"]


@pytest.mark.anyio
async def test_tavily_http_status_error_contains_only_safe_metadata() -> None:
    raw = "never-include-this-api-key"

    def handler(request: httpx.Request) -> httpx.Response:
        assert raw in request.headers["Authorization"]
        return httpx.Response(
            429,
            headers={"Retry-After": "7", "X-Request-ID": "request-1"},
            text=f"quota for {raw}",
        )

    async with _client(handler) as transport_client:
        client = TavilyHttpClient(raw, client=transport_client)
        with pytest.raises(TavilyHttpStatusError) as caught:
            await client.request_json("POST", "/search", payload={})

    assert caught.value.status_code == 429
    assert caught.value.retry_after == "7"
    assert caught.value.request_id == "request-1"
    assert raw not in str(caught.value)
    assert raw not in repr(caught.value)


def test_tavily_http_client_rejects_empty_key_without_echoing_input() -> None:
    with pytest.raises(ValueError, match="不能为空") as caught:
        TavilyHttpClient("   ")

    assert "   " not in str(caught.value)
