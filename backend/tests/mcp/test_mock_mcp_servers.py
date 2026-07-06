from __future__ import annotations

import pytest

from backend.app.mcp.types import McpErrorCode, McpServerStatus
from backend.tests.mcp.fixtures.mock_mcp_servers import (
    MockOAuthProvider,
    auth_failure_scenario,
    protocol_error_scenario,
    schema_changed_scenario,
    start_mock_mcp_server,
    timeout_scenario,
)


def test_mock_mcp_server_fixture_declares_required_variants() -> None:
    harness = start_mock_mcp_server()
    tools = {tool.name: tool for tool in harness.scenario.tools}

    assert tools["read_file"].annotations == {"readOnlyHint": True}
    assert tools["delete_ticket"].annotations == {"destructiveHint": True}
    assert tools["web_lookup"].annotations == {"openWorldHint": True}
    assert tools["unknown_risk"].annotations is None
    assert harness.scenario.prompts[0].name == "summarize_ticket"
    assert harness.scenario.elicitation_request.to_payload()["schema"]["required"] == ["summary"]
    assert harness.scenario.sampling_request.to_payload()["max_tokens"] == 2048


def test_mock_schema_changed_scenario_is_explicit_and_deterministic() -> None:
    baseline = start_mock_mcp_server()
    changed = start_mock_mcp_server(schema_changed_scenario())
    changed_again = start_mock_mcp_server(schema_changed_scenario())

    baseline_read = baseline.scenario.tools[0]
    changed_read = changed.scenario.tools[0]

    assert baseline_read.name == changed_read.name == "read_file"
    assert baseline_read.input_schema != changed_read.input_schema
    assert changed_read.input_schema["required"] == ["path", "checksum"]
    assert changed.scenario.prompts[0].arguments[1].name == "audience"
    assert changed_again.scenario.tools[0].input_schema == changed_read.input_schema


@pytest.mark.asyncio
async def test_mock_stdio_server_initializes_lists_tools_and_calls_tool() -> None:
    harness = start_mock_mcp_server()
    client = harness.create_stdio_client()

    initialized = await client.initialize()
    tools = await client.list_tools()
    prompt = await client.get_prompt("summarize_ticket", {"topic": "MCP"})
    result = await client.call_tool("read_file", {"path": "README.md"}, call_id="call_stdio")
    await client.shutdown()

    assert initialized.capabilities.tools is True
    assert initialized.capabilities.prompts is True
    assert initialized.capabilities.sampling is True
    assert initialized.capabilities.elicitation is True
    assert [tool.name for tool in tools] == [
        "read_file",
        "delete_ticket",
        "web_lookup",
        "unknown_risk",
    ]
    assert prompt.messages[0]["content"] == "Summarize MCP"
    assert result.call_id == "call_stdio"
    assert result.status == "success"
    assert result.content == [{"type": "text", "text": "mock:read_file"}]
    assert result.metadata["elicitation_request"]["id"] == "elicitation_mock"
    assert result.metadata["sampling_request"]["id"] == "sampling_mock"
    assert harness.stdio_client_factory.calls[0].args == ["-m", "keydex.mock_mcp_stdio"]
    assert harness.session_factory.sessions[0].tool_calls == [
        {"name": "read_file", "arguments": {"path": "README.md"}}
    ]
    assert client.status == McpServerStatus.OFFLINE


@pytest.mark.asyncio
async def test_mock_harness_instances_do_not_share_session_state() -> None:
    first = start_mock_mcp_server()
    first_client = first.create_streamable_http_client(server_id="first")
    await first_client.initialize()
    await first_client.call_tool("read_file", {"path": "first.md"})

    second = start_mock_mcp_server()
    second_client = second.create_streamable_http_client(server_id="second")
    await second_client.initialize()

    assert first.session_factory.sessions[0].tool_calls == [
        {"name": "read_file", "arguments": {"path": "first.md"}}
    ]
    assert second.session_factory.sessions[0].tool_calls == []
    assert first.session_factory.sessions is not second.session_factory.sessions


@pytest.mark.asyncio
async def test_mock_streamable_http_server_initializes_and_lists_tools() -> None:
    harness = start_mock_mcp_server()
    client = harness.create_streamable_http_client(url="https://mcp.example.test/mcp")

    initialized = await client.initialize()
    tools = await client.list_tools()
    await client.shutdown()

    assert initialized.server_info == {"name": "Mock MCP Server"}
    assert tools[0].annotations == {"readOnlyHint": True}
    assert harness.streamable_http_client_factory.calls[0]["url"] == "https://mcp.example.test/mcp"
    assert harness.streamable_http_client_factory.contexts[0].exited is True


@pytest.mark.asyncio
async def test_mock_sse_server_initializes_and_lists_tools() -> None:
    harness = start_mock_mcp_server()
    client = harness.create_sse_client(
        sse_url="https://mcp.example.test/sse",
        message_url="https://mcp.example.test/messages",
    )

    await client.initialize()
    tools = await client.list_tools()
    await client.shutdown()

    assert tools[1].name == "delete_ticket"
    assert harness.sse_client_factory.calls[0]["sse_url"] == "https://mcp.example.test/sse"
    assert harness.sse_client_factory.calls[0]["message_url"] == "https://mcp.example.test/messages"
    assert harness.sse_client_factory.contexts[0].exited is True


@pytest.mark.asyncio
async def test_mock_error_scenarios_trigger_client_error_codes() -> None:
    auth_client = start_mock_mcp_server(auth_failure_scenario()).create_streamable_http_client()
    with pytest.raises(Exception) as auth_error:
        await auth_client.initialize()
    assert getattr(auth_error.value, "code", None) == McpErrorCode.AUTH_REQUIRED

    timeout_client = start_mock_mcp_server(timeout_scenario()).create_streamable_http_client()
    await timeout_client.initialize()
    with pytest.raises(Exception) as timeout_error:
        await timeout_client.list_tools()
    assert getattr(timeout_error.value, "code", None) == McpErrorCode.TIMEOUT
    await timeout_client.shutdown()

    protocol_client = (
        start_mock_mcp_server(protocol_error_scenario()).create_streamable_http_client()
    )
    await protocol_client.initialize()
    with pytest.raises(Exception) as protocol_error:
        await protocol_client.list_tools()
    assert getattr(protocol_error.value, "code", None) == McpErrorCode.PROTOCOL_ERROR
    await protocol_client.shutdown()


@pytest.mark.asyncio
async def test_mock_oauth_provider_exchanges_tokens_and_can_fail() -> None:
    provider = MockOAuthProvider()
    token = await provider.exchange_code(config=provider.config(), code="code", state="state")

    assert token.access_token == "mock-access-token"
    assert token.refresh_token == "mock-refresh-token"
    assert provider.exchange_calls == [
        {"code": "code", "state": "state", "client_id": "mock-client"}
    ]

    failing_provider = MockOAuthProvider(raise_exchange_error=True)
    with pytest.raises(RuntimeError):
        await failing_provider.exchange_code(
            config=failing_provider.config(),
            code="code",
            state="state",
        )
