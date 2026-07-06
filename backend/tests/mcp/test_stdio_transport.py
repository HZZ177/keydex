from __future__ import annotations

import asyncio
import sys
from types import SimpleNamespace
from typing import Any, TextIO

import pytest
from mcp.client.stdio import StdioServerParameters

from backend.app.mcp.errors import (
    McpClientConnectionError,
    McpClientValidationError,
    McpRuntimeError,
)
from backend.app.mcp.transports import McpStdioClient, McpStdioTransportConfig
from backend.app.mcp.types import McpErrorCode, McpServerStatus


@pytest.mark.asyncio
async def test_stdio_transport_initializes_and_lists_with_mock_session() -> None:
    factory = FakeStdioContextFactory()
    sessions = FakeSessionFactory()
    config = McpStdioTransportConfig(
        server_id="srv_stdio",
        command=sys.executable,
        args=["-m", "mock server", "--name=a&b"],
        env={"LOCAL_ONLY": "1"},
        inherit_environment=False,
    )
    client = McpStdioClient(
        config,
        stdio_client_factory=factory,
        session_factory=sessions,
    )

    initialized = await client.initialize()
    tools = await client.list_tools()
    prompts = await client.list_prompts()
    prompt = await client.get_prompt("summarize", {"topic": "MCP"})
    tool_result = await client.call_tool("echo", {"text": "hello"}, call_id="call_1")

    assert client.status == McpServerStatus.ONLINE
    assert initialized.capabilities.tools is True
    assert tools[0].name == "echo"
    assert tools[0].input_schema == {"type": "object"}
    assert prompts[0].arguments[0].name == "topic"
    assert prompt.messages[0]["content"] == "Summarize MCP"
    assert tool_result.call_id == "call_1"
    assert tool_result.content[0]["text"] == "hello"
    assert factory.calls[0].command == sys.executable
    assert factory.calls[0].args == ["-m", "mock server", "--name=a&b"]
    assert factory.calls[0].env == {"LOCAL_ONLY": "1"}


def test_stdio_config_builds_environment_and_validates_command(monkeypatch) -> None:
    monkeypatch.setenv("KEYDEX_MCP_HOST_ENV", "host")
    inherited = McpStdioTransportConfig(
        server_id="srv_stdio",
        command=sys.executable,
        env={"LOCAL": "override"},
        inherit_environment=True,
    )
    isolated = McpStdioTransportConfig(
        server_id="srv_stdio",
        command=sys.executable,
        env={"LOCAL": "only"},
        inherit_environment=False,
    )

    assert inherited.build_environment()["KEYDEX_MCP_HOST_ENV"] == "host"
    assert inherited.build_environment()["LOCAL"] == "override"
    assert isolated.build_environment() == {"LOCAL": "only"}

    with pytest.raises(McpClientValidationError):
        McpStdioTransportConfig(server_id="srv_stdio", command=" ")
    with pytest.raises(McpClientValidationError):
        McpStdioTransportConfig(
            server_id="srv_stdio",
            command=sys.executable,
            args="--stdio",  # type: ignore[arg-type]
        )
    with pytest.raises(McpClientValidationError):
        McpStdioTransportConfig(
            server_id="srv_stdio",
            command=sys.executable,
            args=["--stdio", 123],  # type: ignore[list-item]
        )
    with pytest.raises(McpClientConnectionError):
        McpStdioTransportConfig(
            server_id="srv_stdio",
            command="missing-keydex-mcp-command",
        ).to_sdk_parameters()


@pytest.mark.asyncio
async def test_stdio_startup_timeout_maps_to_timeout_and_closes_contexts() -> None:
    factory = FakeStdioContextFactory()
    sessions = FakeSessionFactory(initialize_delay_sec=1)
    client = McpStdioClient(
        McpStdioTransportConfig(
            server_id="srv_stdio",
            command=sys.executable,
            startup_timeout_sec=0.01,
        ),
        stdio_client_factory=factory,
        session_factory=sessions,
    )

    with pytest.raises(McpRuntimeError) as exc_info:
        await client.initialize()

    assert exc_info.value.code == McpErrorCode.TIMEOUT
    assert client.status == McpServerStatus.OFFLINE
    assert factory.contexts[0].exited is True
    assert sessions.session.exited is True


@pytest.mark.asyncio
async def test_stdio_shutdown_releases_session_and_stdio_context() -> None:
    factory = FakeStdioContextFactory()
    sessions = FakeSessionFactory()
    client = McpStdioClient(
        McpStdioTransportConfig(server_id="srv_stdio", command=sys.executable),
        stdio_client_factory=factory,
        session_factory=sessions,
    )

    await client.initialize()
    await client.shutdown()

    assert client.status == McpServerStatus.OFFLINE
    assert sessions.session.exited is True
    assert factory.contexts[0].exited is True


@pytest.mark.asyncio
async def test_stdio_cancel_call_cancels_active_tool_without_marking_server_error() -> None:
    sessions = FakeSessionFactory(block_tool_call=True)
    client = McpStdioClient(
        McpStdioTransportConfig(server_id="srv_stdio", command=sys.executable),
        stdio_client_factory=FakeStdioContextFactory(),
        session_factory=sessions,
    )
    await client.initialize()

    task = asyncio.create_task(client.call_tool("echo", {"text": "hello"}, call_id="call_cancel"))
    await sessions.session.call_started.wait()
    cancelled = await client.cancel_call("call_cancel")

    with pytest.raises(McpRuntimeError) as exc_info:
        await task

    assert cancelled is True
    assert exc_info.value.code == McpErrorCode.CANCELLED
    assert client.status == McpServerStatus.ONLINE


class FakeStdioContextFactory:
    def __init__(self) -> None:
        self.calls: list[StdioServerParameters] = []
        self.contexts: list[FakeStdioContext] = []

    def __call__(
        self,
        server: StdioServerParameters,
        errlog: TextIO,
    ) -> FakeStdioContext:
        self.calls.append(server)
        context = FakeStdioContext()
        self.contexts.append(context)
        return context


class FakeStdioContext:
    def __init__(self) -> None:
        self.exited = False

    async def __aenter__(self) -> tuple[str, str]:
        return "read-stream", "write-stream"

    async def __aexit__(self, *_args: Any) -> None:
        self.exited = True


class FakeSessionFactory:
    def __init__(
        self,
        *,
        initialize_delay_sec: float = 0,
        block_tool_call: bool = False,
    ) -> None:
        self.initialize_delay_sec = initialize_delay_sec
        self.block_tool_call = block_tool_call
        self.session: FakeSession | None = None

    def __call__(self, read_stream: Any, write_stream: Any) -> FakeSession:
        self.session = FakeSession(
            read_stream=read_stream,
            write_stream=write_stream,
            initialize_delay_sec=self.initialize_delay_sec,
            block_tool_call=self.block_tool_call,
        )
        return self.session


class FakeSession:
    def __init__(
        self,
        *,
        read_stream: Any,
        write_stream: Any,
        initialize_delay_sec: float,
        block_tool_call: bool,
    ) -> None:
        self.read_stream = read_stream
        self.write_stream = write_stream
        self.initialize_delay_sec = initialize_delay_sec
        self.block_tool_call = block_tool_call
        self.call_started = asyncio.Event()
        self.exited = False

    async def __aenter__(self) -> FakeSession:
        return self

    async def __aexit__(self, *_args: Any) -> None:
        self.exited = True

    async def initialize(self) -> SimpleNamespace:
        if self.initialize_delay_sec:
            await asyncio.sleep(self.initialize_delay_sec)
        return SimpleNamespace(
            protocolVersion="2025-06-18",
            serverInfo=SimpleNamespace(name="fake-server"),
            capabilities=SimpleNamespace(tools={}, prompts={}),
        )

    async def list_tools(self) -> SimpleNamespace:
        return SimpleNamespace(
            tools=[
                SimpleNamespace(
                    name="echo",
                    description="Echo text",
                    inputSchema={"type": "object"},
                    annotations=SimpleNamespace(readOnlyHint=True),
                )
            ]
        )

    async def list_prompts(self) -> SimpleNamespace:
        return SimpleNamespace(
            prompts=[
                SimpleNamespace(
                    name="summarize",
                    description="Summarize topic",
                    arguments=[SimpleNamespace(name="topic", required=True)],
                )
            ]
        )

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> SimpleNamespace:
        self.call_started.set()
        if self.block_tool_call:
            await asyncio.sleep(60)
        return SimpleNamespace(
            content=[{"type": "text", "text": arguments["text"]}],
            structuredContent={"ok": True},
            isError=False,
            meta={"name": name},
        )

    async def get_prompt(self, name: str, arguments: dict[str, str] | None) -> SimpleNamespace:
        return SimpleNamespace(
            description=f"Prompt {name}",
            messages=[{"role": "user", "content": f"Summarize {arguments['topic']}"}],
            meta={},
        )
