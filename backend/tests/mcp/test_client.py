from __future__ import annotations

import asyncio
from typing import Any

import pytest

from backend.app.mcp.client import (
    McpCancellationToken,
    McpClient,
    McpClientBase,
    McpClientCapabilities,
    McpClientInitializeResult,
    McpClientPromptArgument,
    McpClientPromptResult,
    McpClientPromptSpec,
    McpClientToolResult,
    McpClientToolSpec,
    McpConnectionStateMachine,
    McpInvalidStateTransition,
    status_from_mcp_error_code,
)
from backend.app.mcp.errors import (
    McpClientAuthError,
    McpClientConnectionError,
    McpClientProtocolError,
    McpRuntimeError,
    map_mcp_exception_code,
    to_mcp_runtime_error,
)
from backend.app.mcp.types import McpErrorCode, McpServerStatus


@pytest.mark.asyncio
async def test_fake_client_implements_transport_neutral_contract() -> None:
    client = FakeMcpClient(server_id="srv_1")

    assert isinstance(client, McpClient)

    result = await _manager_like_round_trip(client)

    assert result == "echo: hello"
    assert client.status == McpServerStatus.OFFLINE
    assert [transition.current for transition in client.state_history] == [
        McpServerStatus.UNKNOWN,
        McpServerStatus.REFRESHING,
        McpServerStatus.ONLINE,
        McpServerStatus.OFFLINE,
    ]


def test_connection_state_machine_allows_designed_lifecycle_and_blocks_invalid_jump() -> None:
    state = McpConnectionStateMachine()

    refreshing = state.transition_to(McpServerStatus.REFRESHING, reason="refresh")
    online = state.transition_to(McpServerStatus.ONLINE, reason="initialized")
    offline = state.transition_to(McpServerStatus.OFFLINE, reason="process exit")

    assert refreshing.previous == McpServerStatus.UNKNOWN
    assert online.previous == McpServerStatus.REFRESHING
    assert offline.previous == McpServerStatus.ONLINE
    with pytest.raises(McpInvalidStateTransition):
        state.transition_to(McpServerStatus.UNKNOWN)


def test_mcp_client_errors_map_to_unified_error_codes_and_statuses() -> None:
    assert map_mcp_exception_code(McpClientAuthError()) == McpErrorCode.AUTH_REQUIRED
    assert map_mcp_exception_code(McpClientConnectionError()) == McpErrorCode.SERVER_OFFLINE
    assert map_mcp_exception_code(McpClientProtocolError()) == McpErrorCode.PROTOCOL_ERROR
    assert map_mcp_exception_code(TimeoutError()) == McpErrorCode.TIMEOUT
    assert map_mcp_exception_code(asyncio.CancelledError()) == McpErrorCode.CANCELLED

    runtime_error = to_mcp_runtime_error(McpClientProtocolError("bad response"))

    assert runtime_error.code == McpErrorCode.PROTOCOL_ERROR
    assert status_from_mcp_error_code(McpErrorCode.AUTH_REQUIRED) == McpServerStatus.AUTH_REQUIRED
    assert status_from_mcp_error_code(McpErrorCode.TIMEOUT) == McpServerStatus.OFFLINE
    assert status_from_mcp_error_code(McpErrorCode.PROTOCOL_ERROR) == McpServerStatus.ERROR


def test_mcp_runtime_error_payload_redacts_sensitive_detail() -> None:
    error = McpRuntimeError(
        McpErrorCode.PROTOCOL_ERROR,
        detail={
            "safe": "visible",
            "headers": {"Authorization": "Bearer raw-token"},
            "nested": [{"api_key": "raw-api-key"}],
        },
    )

    payload = error.to_payload()

    assert payload.detail == {
        "safe": "visible",
        "headers": {"Authorization": "***REDACTED***"},
        "nested": [{"api_key": "***REDACTED***"}],
    }


@pytest.mark.asyncio
async def test_cancellation_token_and_reserved_resource_methods() -> None:
    client = FakeMcpClient(server_id="srv_1")
    token = McpCancellationToken()
    token.cancel()

    with pytest.raises(McpRuntimeError) as cancelled:
        await client.initialize(cancellation=token)
    with pytest.raises(McpRuntimeError) as resources:
        await client.list_resources()

    assert cancelled.value.code == McpErrorCode.CANCELLED
    assert resources.value.code == McpErrorCode.RESOURCE_RESERVED


async def _manager_like_round_trip(client: McpClient) -> str:
    await client.initialize()
    tools = await client.list_tools()
    prompts = await client.list_prompts()
    prompt_result = await client.get_prompt(prompts[0].name, {"topic": "MCP"})
    tool_result = await client.call_tool(
        tools[0].name,
        {"text": "hello", "prompt": prompt_result.messages[0]["content"]},
        call_id="call_1",
    )
    await client.cancel_call(tool_result.call_id)
    await client.shutdown()
    return str(tool_result.content[0]["text"])


class FakeMcpClient(McpClientBase):
    async def initialize(
        self,
        *,
        timeout_sec: float | None = None,
        cancellation: McpCancellationToken | None = None,
    ) -> McpClientInitializeResult:
        _raise_if_cancelled(cancellation)
        self.transition_status(McpServerStatus.REFRESHING, reason="initialize")
        self.transition_status(McpServerStatus.ONLINE, reason="initialized")
        return McpClientInitializeResult(
            protocol_version="2025-06-18",
            server_info={"name": "fake"},
            capabilities=McpClientCapabilities(tools=True, prompts=True),
        )

    async def list_tools(
        self,
        *,
        timeout_sec: float | None = None,
        cancellation: McpCancellationToken | None = None,
    ) -> list[McpClientToolSpec]:
        _raise_if_cancelled(cancellation)
        return [
            McpClientToolSpec(
                name="echo",
                description="Echo text",
                input_schema={"type": "object"},
                annotations={"readOnlyHint": True},
            )
        ]

    async def list_prompts(
        self,
        *,
        timeout_sec: float | None = None,
        cancellation: McpCancellationToken | None = None,
    ) -> list[McpClientPromptSpec]:
        _raise_if_cancelled(cancellation)
        return [
            McpClientPromptSpec(
                name="summarize",
                description="Summarize a topic",
                arguments=[McpClientPromptArgument(name="topic", required=True)],
            )
        ]

    async def call_tool(
        self,
        raw_tool_name: str,
        arguments: dict[str, Any] | None = None,
        *,
        call_id: str | None = None,
        timeout_sec: float | None = None,
        cancellation: McpCancellationToken | None = None,
    ) -> McpClientToolResult:
        _raise_if_cancelled(cancellation)
        return McpClientToolResult(
            call_id=call_id or "call_fake",
            status="success",
            content=[{"type": "text", "text": f"echo: {arguments['text']}"}],
        )

    async def get_prompt(
        self,
        raw_prompt_name: str,
        arguments: dict[str, Any] | None = None,
        *,
        timeout_sec: float | None = None,
        cancellation: McpCancellationToken | None = None,
    ) -> McpClientPromptResult:
        _raise_if_cancelled(cancellation)
        topic = str((arguments or {}).get("topic") or "")
        return McpClientPromptResult(messages=[{"role": "user", "content": f"Summarize {topic}"}])

    async def cancel_call(self, call_id: str) -> bool:
        return call_id == "call_1"

    async def shutdown(self, *, timeout_sec: float | None = None) -> None:
        self.transition_status(McpServerStatus.OFFLINE, reason="shutdown")


def _raise_if_cancelled(cancellation: McpCancellationToken | None) -> None:
    if cancellation is not None:
        cancellation.raise_if_cancelled()
