from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import httpx
import pytest

from backend.app.mcp.auth import (
    McpHttpAuthConfig,
    compose_http_headers,
    redact_http_headers,
)
from backend.app.mcp.errors import McpClientAuthError, McpClientValidationError, McpRuntimeError
from backend.app.mcp.transports import (
    McpStreamableHttpClient,
    McpStreamableHttpTransportConfig,
)
from backend.app.mcp.types import McpErrorCode, McpServerStatus


@pytest.mark.asyncio
async def test_streamable_http_initializes_with_composed_headers_and_lists_tools(
    monkeypatch,
) -> None:
    monkeypatch.setenv("MCP_HEADER_TOKEN", "env-header-token")
    monkeypatch.setenv("MCP_BEARER_TOKEN", "env-bearer-token")
    factory = FakeStreamableHttpContextFactory()
    sessions = FakeHttpSessionFactory()
    config = McpStreamableHttpTransportConfig(
        server_id="srv_http",
        url="https://mcp.example.test/mcp",
        headers={"X-Static": "static"},
        env_headers={"X-Env-Token": "MCP_HEADER_TOKEN"},
        bearer_token_env_var="MCP_BEARER_TOKEN",
        connect_timeout_sec=12,
        read_timeout_sec=34,
        tool_timeout_sec=56,
    )
    client = McpStreamableHttpClient(
        config,
        streamable_http_client_factory=factory,
        session_factory=sessions,
    )

    initialized = await client.initialize()
    tools = await client.list_tools()
    tool_result = await client.call_tool("echo", {"text": "hello"}, call_id="call_1")

    http_client = factory.calls[0]["http_client"]
    assert client.status == McpServerStatus.ONLINE
    assert initialized.capabilities.tools is True
    assert tools[0].name == "echo"
    assert tool_result.content[0]["text"] == "hello"
    assert factory.calls[0]["url"] == "https://mcp.example.test/mcp"
    assert http_client.headers["x-static"] == "static"
    assert http_client.headers["x-env-token"] == "env-header-token"
    assert http_client.headers["authorization"] == "Bearer env-bearer-token"
    assert http_client.timeout.connect == 12
    assert http_client.timeout.read == 34


def test_streamable_http_config_validates_url_and_auth_headers(monkeypatch) -> None:
    monkeypatch.setenv("MCP_TOKEN", "token-value")
    headers = compose_http_headers(
        McpHttpAuthConfig(
            headers={"X-Static": "static"},
            env_headers={"X-Token": "MCP_TOKEN"},
            bearer_token_env_var="MCP_TOKEN",
        )
    )

    assert headers["X-Static"] == "static"
    assert headers["X-Token"] == "token-value"
    assert headers["Authorization"] == "Bearer token-value"
    assert redact_http_headers(headers)["Authorization"] == "***REDACTED***"

    with pytest.raises(McpClientValidationError):
        McpStreamableHttpTransportConfig(server_id="srv_http", url="")
    with pytest.raises(McpClientValidationError):
        McpStreamableHttpTransportConfig(server_id="srv_http", url="ftp://example.test/mcp")
    with pytest.raises(McpClientAuthError):
        compose_http_headers(McpHttpAuthConfig(env_headers={"X-Token": "MISSING_ENV"}))


@pytest.mark.parametrize("status_code", [401, 403])
@pytest.mark.asyncio
async def test_streamable_http_auth_status_maps_to_auth_required(status_code: int) -> None:
    sessions = FakeHttpSessionFactory(initialize_error=_http_status_error(status_code))
    client = McpStreamableHttpClient(
        McpStreamableHttpTransportConfig(
            server_id="srv_http",
            url="https://mcp.example.test/mcp",
        ),
        streamable_http_client_factory=FakeStreamableHttpContextFactory(),
        session_factory=sessions,
    )

    with pytest.raises(McpRuntimeError) as exc_info:
        await client.initialize()

    assert exc_info.value.code == McpErrorCode.AUTH_REQUIRED
    assert client.status == McpServerStatus.AUTH_REQUIRED


@pytest.mark.asyncio
async def test_streamable_http_read_timeout_maps_to_timeout() -> None:
    sessions = FakeHttpSessionFactory(list_tools_error=httpx.ReadTimeout("read timeout"))
    client = McpStreamableHttpClient(
        McpStreamableHttpTransportConfig(
            server_id="srv_http",
            url="https://mcp.example.test/mcp",
            read_timeout_sec=0.01,
        ),
        streamable_http_client_factory=FakeStreamableHttpContextFactory(),
        session_factory=sessions,
    )

    await client.initialize()
    with pytest.raises(McpRuntimeError) as exc_info:
        await client.list_tools()

    assert exc_info.value.code == McpErrorCode.TIMEOUT
    assert client.status == McpServerStatus.OFFLINE


@pytest.mark.asyncio
async def test_streamable_http_tool_call_uses_tool_timeout() -> None:
    sessions = FakeHttpSessionFactory(block_tool_call=True)
    client = McpStreamableHttpClient(
        McpStreamableHttpTransportConfig(
            server_id="srv_http",
            url="https://mcp.example.test/mcp",
            tool_timeout_sec=0.01,
        ),
        streamable_http_client_factory=FakeStreamableHttpContextFactory(),
        session_factory=sessions,
    )

    await client.initialize()
    with pytest.raises(McpRuntimeError) as exc_info:
        await client.call_tool("echo", {"text": "hello"}, call_id="call_timeout")

    assert exc_info.value.code == McpErrorCode.TIMEOUT


@pytest.mark.asyncio
async def test_streamable_http_shutdown_exits_transport_context_in_same_task() -> None:
    factory = FakeStreamableHttpContextFactory()
    client = McpStreamableHttpClient(
        McpStreamableHttpTransportConfig(
            server_id="srv_http",
            url="https://mcp.example.test/mcp",
        ),
        streamable_http_client_factory=factory,
        session_factory=FakeHttpSessionFactory(),
    )

    await client.initialize()
    await client.shutdown()

    assert factory.contexts[0].enter_task is factory.contexts[0].exit_task


class FakeStreamableHttpContextFactory:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.contexts: list[FakeStreamableHttpContext] = []

    def __call__(
        self,
        url: str,
        *,
        http_client: httpx.AsyncClient,
        terminate_on_close: bool,
    ) -> FakeStreamableHttpContext:
        self.calls.append(
            {
                "url": url,
                "http_client": http_client,
                "terminate_on_close": terminate_on_close,
            }
        )
        context = FakeStreamableHttpContext()
        self.contexts.append(context)
        return context


class FakeStreamableHttpContext:
    def __init__(self) -> None:
        self.enter_task: asyncio.Task[Any] | None = None
        self.exit_task: asyncio.Task[Any] | None = None

    async def __aenter__(self) -> tuple[str, str, Any]:
        self.enter_task = asyncio.current_task()
        return "read-stream", "write-stream", lambda: "session-id"

    async def __aexit__(self, *_args: Any) -> None:
        self.exit_task = asyncio.current_task()
        return None


class FakeHttpSessionFactory:
    def __init__(
        self,
        *,
        initialize_error: BaseException | None = None,
        list_tools_error: BaseException | None = None,
        block_tool_call: bool = False,
    ) -> None:
        self.initialize_error = initialize_error
        self.list_tools_error = list_tools_error
        self.block_tool_call = block_tool_call

    def __call__(self, read_stream: Any, write_stream: Any) -> FakeHttpSession:
        return FakeHttpSession(
            initialize_error=self.initialize_error,
            list_tools_error=self.list_tools_error,
            block_tool_call=self.block_tool_call,
        )


class FakeHttpSession:
    def __init__(
        self,
        *,
        initialize_error: BaseException | None,
        list_tools_error: BaseException | None,
        block_tool_call: bool,
    ) -> None:
        self.initialize_error = initialize_error
        self.list_tools_error = list_tools_error
        self.block_tool_call = block_tool_call

    async def __aenter__(self) -> FakeHttpSession:
        return self

    async def __aexit__(self, *_args: Any) -> None:
        return None

    async def initialize(self) -> SimpleNamespace:
        if self.initialize_error is not None:
            raise self.initialize_error
        return SimpleNamespace(
            protocolVersion="2025-06-18",
            serverInfo=SimpleNamespace(name="fake-http"),
            capabilities=SimpleNamespace(tools={}),
        )

    async def list_tools(self) -> SimpleNamespace:
        if self.list_tools_error is not None:
            raise self.list_tools_error
        return SimpleNamespace(
            tools=[
                SimpleNamespace(
                    name="echo",
                    description="Echo text",
                    inputSchema={"type": "object"},
                    annotations=None,
                )
            ]
        )

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> SimpleNamespace:
        if self.block_tool_call:
            await asyncio.sleep(60)
        return SimpleNamespace(
            content=[{"type": "text", "text": arguments["text"]}],
            structuredContent={"tool": name},
            isError=False,
            meta={},
        )

def _http_status_error(status_code: int) -> httpx.HTTPStatusError:
    request = httpx.Request("POST", "https://mcp.example.test/mcp")
    response = httpx.Response(status_code, request=request)
    return httpx.HTTPStatusError("HTTP status error", request=request, response=response)
