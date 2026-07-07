from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from mcp.client.sse import SSEError

from backend.app.mcp.errors import McpClientValidationError, McpRuntimeError
from backend.app.mcp.transports import McpSseClient, McpSseTransportConfig
from backend.app.mcp.types import McpErrorCode, McpServerStatus


@pytest.mark.asyncio
async def test_sse_transport_initializes_and_lists_tools_with_message_url(monkeypatch) -> None:
    monkeypatch.setenv("MCP_SSE_TOKEN", "env-token")
    factory = FakeSseContextFactory()
    client = McpSseClient(
        McpSseTransportConfig(
            server_id="srv_sse",
            sse_url="https://mcp.example.test/sse",
            message_url="https://mcp.example.test/messages",
            env_headers={"X-Token": "MCP_SSE_TOKEN"},
            sse_read_timeout_sec=123,
        ),
        sse_client_factory=factory,
        session_factory=FakeSseSessionFactory(),
    )

    initialized = await client.initialize()
    tools = await client.list_tools()

    assert client.status == McpServerStatus.ONLINE
    assert initialized.capabilities.tools is True
    assert tools[0].name == "echo"
    assert factory.calls[0]["sse_url"] == "https://mcp.example.test/sse"
    assert factory.calls[0]["message_url"] == "https://mcp.example.test/messages"
    assert factory.calls[0]["headers"] == {"X-Token": "env-token"}
    assert factory.calls[0]["sse_read_timeout"] == 123


def test_sse_transport_validates_message_url() -> None:
    with pytest.raises(McpClientValidationError):
        McpSseTransportConfig(
            server_id="srv_sse",
            sse_url="",
            message_url="https://mcp.example.test/messages",
        )
    with pytest.raises(McpClientValidationError):
        McpSseTransportConfig(
            server_id="srv_sse",
            sse_url="ftp://mcp.example.test/sse",
            message_url="https://mcp.example.test/messages",
        )
    with pytest.raises(McpClientValidationError):
        McpSseTransportConfig(
            server_id="srv_sse",
            sse_url="https://mcp.example.test/sse",
            message_url="",
        )
    with pytest.raises(McpClientValidationError):
        McpSseTransportConfig(
            server_id="srv_sse",
            sse_url="https://mcp.example.test/sse",
            message_url="https://other.example.test/messages",
        )


@pytest.mark.asyncio
async def test_sse_read_timeout_maps_to_timeout() -> None:
    client = McpSseClient(
        McpSseTransportConfig(
            server_id="srv_sse",
            sse_url="https://mcp.example.test/sse",
            message_url="https://mcp.example.test/messages",
            sse_read_timeout_sec=0.01,
        ),
        sse_client_factory=FakeSseContextFactory(),
        session_factory=FakeSseSessionFactory(list_tools_error=httpx.ReadTimeout("sse read")),
    )

    await client.initialize()
    with pytest.raises(McpRuntimeError) as exc_info:
        await client.list_tools()

    assert exc_info.value.code == McpErrorCode.TIMEOUT
    assert client.status == McpServerStatus.OFFLINE


@pytest.mark.asyncio
async def test_sse_disconnect_maps_to_offline() -> None:
    client = McpSseClient(
        McpSseTransportConfig(
            server_id="srv_sse",
            sse_url="https://mcp.example.test/sse",
            message_url="https://mcp.example.test/messages",
        ),
        sse_client_factory=FakeSseContextFactory(),
        session_factory=FakeSseSessionFactory(list_tools_error=SSEError("disconnect")),
    )

    await client.initialize()
    with pytest.raises(McpRuntimeError) as exc_info:
        await client.list_tools()

    assert exc_info.value.code == McpErrorCode.SERVER_OFFLINE
    assert client.status == McpServerStatus.OFFLINE


class FakeSseContextFactory:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def __call__(
        self,
        sse_url: str,
        *,
        message_url: str,
        headers: dict[str, str],
        timeout: float,
        sse_read_timeout: float,
    ) -> FakeSseContext:
        self.calls.append(
            {
                "sse_url": sse_url,
                "message_url": message_url,
                "headers": headers,
                "timeout": timeout,
                "sse_read_timeout": sse_read_timeout,
            }
        )
        return FakeSseContext()


class FakeSseContext:
    async def __aenter__(self) -> tuple[str, str]:
        return "read-stream", "write-stream"

    async def __aexit__(self, *_args: Any) -> None:
        return None


class FakeSseSessionFactory:
    def __init__(self, *, list_tools_error: BaseException | None = None) -> None:
        self.list_tools_error = list_tools_error

    def __call__(self, read_stream: Any, write_stream: Any) -> FakeSseSession:
        return FakeSseSession(list_tools_error=self.list_tools_error)


class FakeSseSession:
    def __init__(self, *, list_tools_error: BaseException | None) -> None:
        self.list_tools_error = list_tools_error

    async def __aenter__(self) -> FakeSseSession:
        return self

    async def __aexit__(self, *_args: Any) -> None:
        return None

    async def initialize(self) -> SimpleNamespace:
        return SimpleNamespace(
            protocolVersion="2025-06-18",
            serverInfo=SimpleNamespace(name="fake-sse"),
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
        return SimpleNamespace(
            content=[{"type": "text", "text": arguments.get("text", "")}],
            structuredContent={"tool": name},
            isError=False,
            meta={},
        )
