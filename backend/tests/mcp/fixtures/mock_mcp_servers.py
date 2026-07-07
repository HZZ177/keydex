from __future__ import annotations

import asyncio
import sys
from collections.abc import Callable
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any, TextIO

import httpx
from mcp.client.stdio import StdioServerParameters

from backend.app.mcp.errors import (
    McpClientAuthError,
    McpClientProtocolError,
)
from backend.app.mcp.oauth import (
    McpOAuthProviderConfig,
    McpOAuthTokenResponse,
)
from backend.app.mcp.transports import (
    McpSseClient,
    McpSseTransportConfig,
    McpStdioClient,
    McpStdioTransportConfig,
    McpStreamableHttpClient,
    McpStreamableHttpTransportConfig,
)


@dataclass(frozen=True)
class MockMcpTool:
    name: str
    description: str
    input_schema: dict[str, Any] = field(default_factory=lambda: {"type": "object"})
    annotations: dict[str, Any] | None = None
    result_text: str | None = None
    structured_content: dict[str, Any] = field(default_factory=dict)
    is_error: bool = False

    def to_sdk(self) -> SimpleNamespace:
        return SimpleNamespace(
            name=self.name,
            description=self.description,
            inputSchema=dict(self.input_schema),
            annotations=dict(self.annotations or {}),
        )


@dataclass(frozen=True)
class MockMcpElicitationRequest:
    request_id: str = "elicitation_mock"
    title: str = "Need additional input"
    description: str = "Collect a required field from the user."
    schema: dict[str, Any] = field(
        default_factory=lambda: {
            "type": "object",
            "required": ["summary"],
            "properties": {
                "summary": {
                    "type": "string",
                    "title": "Summary",
                    "description": "Short user-provided summary.",
                },
                "confirmed": {
                    "type": "boolean",
                    "title": "Confirmed",
                },
            },
        }
    )

    def to_payload(self) -> dict[str, Any]:
        return {
            "id": self.request_id,
            "title": self.title,
            "description": self.description,
            "schema": dict(self.schema),
        }


@dataclass(frozen=True)
class MockMcpSamplingRequest:
    request_id: str = "sampling_mock"
    messages: list[dict[str, Any]] = field(
        default_factory=lambda: [
            {
                "role": "user",
                "content": "Summarize the current ticket status.",
            }
        ]
    )
    model_policy: str = "current_default"
    max_tokens: int = 2048
    temperature: float = 0.2

    def to_payload(self) -> dict[str, Any]:
        return {
            "id": self.request_id,
            "messages": [dict(message) for message in self.messages],
            "model_policy": self.model_policy,
            "max_tokens": self.max_tokens,
            "temperature": self.temperature,
        }


@dataclass(frozen=True)
class MockMcpServerScenario:
    name: str = "Mock MCP Server"
    protocol_version: str = "2025-06-18"
    tools: list[MockMcpTool] = field(default_factory=lambda: list(DEFAULT_MCP_TOOLS))
    elicitation_request: MockMcpElicitationRequest = field(
        default_factory=MockMcpElicitationRequest
    )
    sampling_request: MockMcpSamplingRequest = field(default_factory=MockMcpSamplingRequest)
    initialize_error: BaseException | None = None
    list_tools_error: BaseException | None = None
    call_tool_error: BaseException | None = None
    initialize_delay_sec: float = 0
    list_tools_delay_sec: float = 0
    call_tool_delay_sec: float = 0


DEFAULT_MCP_TOOLS: tuple[MockMcpTool, ...] = (
    MockMcpTool(
        name="read_file",
        description="Read a workspace file",
        input_schema={
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
        },
        annotations={"readOnlyHint": True},
    ),
    MockMcpTool(
        name="delete_ticket",
        description="Delete a ticket",
        input_schema={
            "type": "object",
            "properties": {"ticket_id": {"type": "string"}},
            "required": ["ticket_id"],
        },
        annotations={"destructiveHint": True},
    ),
    MockMcpTool(
        name="web_lookup",
        description="Query an external system",
        input_schema={"type": "object", "properties": {"query": {"type": "string"}}},
        annotations={"openWorldHint": True},
    ),
    MockMcpTool(
        name="plain_tool",
        description="Tool with no annotations",
        input_schema={"type": "object", "properties": {"value": {"type": "string"}}},
        annotations=None,
    ),
)

def start_mock_mcp_server(
    scenario: MockMcpServerScenario | None = None,
) -> MockMcpServerHarness:
    return MockMcpServerHarness(scenario or MockMcpServerScenario())


def auth_failure_scenario() -> MockMcpServerScenario:
    return MockMcpServerScenario(initialize_error=McpClientAuthError("mock auth required"))


def timeout_scenario() -> MockMcpServerScenario:
    return MockMcpServerScenario(list_tools_error=TimeoutError("mock timeout"))


def protocol_error_scenario() -> MockMcpServerScenario:
    return MockMcpServerScenario(list_tools_error=McpClientProtocolError("mock protocol error"))


def schema_changed_scenario() -> MockMcpServerScenario:
    return MockMcpServerScenario(
        tools=[
            MockMcpTool(
                name="read_file",
                description="Read a workspace file with checksum validation",
                input_schema={
                    "type": "object",
                    "properties": {
                        "path": {"type": "string"},
                        "checksum": {"type": "string"},
                    },
                    "required": ["path", "checksum"],
                },
                annotations={"readOnlyHint": True},
            ),
            *DEFAULT_MCP_TOOLS[1:],
        ],
    )


class MockMcpServerHarness:
    def __init__(self, scenario: MockMcpServerScenario) -> None:
        self.scenario = scenario
        self.stdio_client_factory = MockStdioContextFactory()
        self.streamable_http_client_factory = MockStreamableHttpContextFactory()
        self.sse_client_factory = MockSseContextFactory()
        self.session_factory = MockMcpSessionFactory(scenario)
        self.oauth_provider = MockOAuthProvider()

    def create_stdio_client(self, *, server_id: str = "mock_stdio") -> McpStdioClient:
        return McpStdioClient(
            McpStdioTransportConfig(
                server_id=server_id,
                command=sys.executable,
                args=["-m", "keydex.mock_mcp_stdio"],
                validate_command=False,
            ),
            stdio_client_factory=self.stdio_client_factory,
            session_factory=self.session_factory,
        )

    def create_streamable_http_client(
        self,
        *,
        server_id: str = "mock_http",
        url: str = "https://mcp.example.test/mcp",
    ) -> McpStreamableHttpClient:
        return McpStreamableHttpClient(
            McpStreamableHttpTransportConfig(server_id=server_id, url=url),
            streamable_http_client_factory=self.streamable_http_client_factory,
            session_factory=self.session_factory,
        )

    def create_sse_client(
        self,
        *,
        server_id: str = "mock_sse",
        sse_url: str = "https://mcp.example.test/sse",
        message_url: str = "https://mcp.example.test/messages",
    ) -> McpSseClient:
        return McpSseClient(
            McpSseTransportConfig(
                server_id=server_id,
                sse_url=sse_url,
                message_url=message_url,
            ),
            sse_client_factory=self.sse_client_factory,
            session_factory=self.session_factory,
        )


class MockStdioContextFactory:
    def __init__(self) -> None:
        self.calls: list[StdioServerParameters] = []
        self.contexts: list[MockTransportContext] = []

    def __call__(self, server: StdioServerParameters, errlog: TextIO) -> MockTransportContext:
        self.calls.append(server)
        context = MockTransportContext(transport="stdio")
        self.contexts.append(context)
        return context


class MockStreamableHttpContextFactory:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.contexts: list[MockTransportContext] = []

    def __call__(
        self,
        url: str,
        *,
        http_client: httpx.AsyncClient,
        terminate_on_close: bool,
    ) -> MockTransportContext:
        self.calls.append(
            {
                "url": url,
                "http_client": http_client,
                "terminate_on_close": terminate_on_close,
            }
        )
        context = MockTransportContext(transport="streamable_http")
        self.contexts.append(context)
        return context


class MockSseContextFactory:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        self.contexts: list[MockTransportContext] = []

    def __call__(
        self,
        sse_url: str,
        *,
        message_url: str,
        headers: dict[str, str],
        timeout: float,
        sse_read_timeout: float,
    ) -> MockTransportContext:
        self.calls.append(
            {
                "sse_url": sse_url,
                "message_url": message_url,
                "headers": dict(headers),
                "timeout": timeout,
                "sse_read_timeout": sse_read_timeout,
            }
        )
        context = MockTransportContext(transport="sse")
        self.contexts.append(context)
        return context


class MockTransportContext:
    def __init__(self, *, transport: str) -> None:
        self.transport = transport
        self.entered = False
        self.exited = False

    async def __aenter__(self) -> tuple[Any, ...]:
        self.entered = True
        read_stream = f"{self.transport}:read"
        write_stream = f"{self.transport}:write"
        if self.transport == "streamable_http":
            return read_stream, write_stream, lambda: f"{self.transport}:session"
        return read_stream, write_stream

    async def __aexit__(self, *_args: Any) -> None:
        self.exited = True


class MockMcpSessionFactory:
    def __init__(self, scenario: MockMcpServerScenario) -> None:
        self.scenario = scenario
        self.sessions: list[MockMcpSession] = []

    def __call__(self, read_stream: Any, write_stream: Any) -> MockMcpSession:
        session = MockMcpSession(
            scenario=self.scenario,
            read_stream=read_stream,
            write_stream=write_stream,
        )
        self.sessions.append(session)
        return session


class MockMcpSession:
    def __init__(
        self,
        *,
        scenario: MockMcpServerScenario,
        read_stream: Any,
        write_stream: Any,
    ) -> None:
        self.scenario = scenario
        self.read_stream = read_stream
        self.write_stream = write_stream
        self.entered = False
        self.exited = False
        self.tool_calls: list[dict[str, Any]] = []

    async def __aenter__(self) -> MockMcpSession:
        self.entered = True
        return self

    async def __aexit__(self, *_args: Any) -> None:
        self.exited = True

    async def initialize(self) -> SimpleNamespace:
        if self.scenario.initialize_delay_sec:
            await asyncio.sleep(self.scenario.initialize_delay_sec)
        if self.scenario.initialize_error is not None:
            raise self.scenario.initialize_error
        return SimpleNamespace(
            protocolVersion=self.scenario.protocol_version,
            serverInfo={"name": self.scenario.name},
            capabilities=SimpleNamespace(
                tools={},
                sampling={},
                elicitation={},
            ),
        )

    async def list_tools(self) -> SimpleNamespace:
        if self.scenario.list_tools_delay_sec:
            await asyncio.sleep(self.scenario.list_tools_delay_sec)
        if self.scenario.list_tools_error is not None:
            raise self.scenario.list_tools_error
        return SimpleNamespace(tools=[tool.to_sdk() for tool in self.scenario.tools])

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> SimpleNamespace:
        if self.scenario.call_tool_delay_sec:
            await asyncio.sleep(self.scenario.call_tool_delay_sec)
        if self.scenario.call_tool_error is not None:
            raise self.scenario.call_tool_error
        self.tool_calls.append({"name": name, "arguments": dict(arguments)})
        tool = _find_by_name(self.scenario.tools, name)
        text = tool.result_text if tool.result_text is not None else f"mock:{name}"
        return SimpleNamespace(
            content=[{"type": "text", "text": text}],
            structuredContent={
                "tool": name,
                "arguments": dict(arguments),
                **tool.structured_content,
            },
            isError=tool.is_error,
            meta={
                "elicitation_request": self.scenario.elicitation_request.to_payload(),
                "sampling_request": self.scenario.sampling_request.to_payload(),
            },
        )

class MockOAuthProvider:
    def __init__(self, *, raise_exchange_error: bool = False) -> None:
        self.raise_exchange_error = raise_exchange_error
        self.exchange_calls: list[dict[str, str]] = []

    def config(self) -> McpOAuthProviderConfig:
        return McpOAuthProviderConfig(
            authorization_url="https://mcp.example.test/oauth/authorize",
            token_url="https://mcp.example.test/oauth/token",
            client_id="mock-client",
            redirect_uri="http://127.0.0.1:8765/api/mcp/oauth/callback",
            scopes=["tools:read"],
            resource="https://mcp.example.test",
        )

    async def exchange_code(
        self,
        *,
        config: McpOAuthProviderConfig,
        code: str,
        state: str,
    ) -> McpOAuthTokenResponse:
        self.exchange_calls.append({"code": code, "state": state, "client_id": config.client_id})
        if self.raise_exchange_error:
            raise RuntimeError("mock oauth exchange failed")
        return McpOAuthTokenResponse(
            access_token="mock-access-token",
            refresh_token="mock-refresh-token",
            expires_in=3600,
            scope="tools:read",
            account_label="mock-account",
        )


def _find_by_name(items: list[Any], name: str) -> Any:
    for item in items:
        if item.name == name:
            return item
    raise McpClientProtocolError(f"mock item not found: {name}")


MockErrorScenarioFactory = Callable[[], MockMcpServerScenario]
