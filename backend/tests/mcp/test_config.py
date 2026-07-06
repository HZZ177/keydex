from __future__ import annotations

import pytest

from backend.app.core.config import AppSettings
from backend.app.mcp.config import McpTransportClientFactory
from backend.app.mcp.errors import McpClientValidationError
from backend.app.mcp.transports import (
    McpSseClient,
    McpSseTransportConfig,
    McpStdioClient,
    McpStdioTransportConfig,
    McpStreamableHttpClient,
    McpStreamableHttpTransportConfig,
)
from backend.app.storage import McpServerRecord, StorageRepositories, init_database


def _repositories(tmp_path) -> StorageRepositories:
    return StorageRepositories(init_database(tmp_path / "app.db"))


def _factory(tmp_path, **settings_overrides) -> McpTransportClientFactory:
    return McpTransportClientFactory(
        AppSettings(data_dir=tmp_path / "data", **settings_overrides)
    )


def _create_server(
    repositories: StorageRepositories,
    *,
    server_id: str,
    transport: str,
    **overrides,
) -> McpServerRecord:
    defaults = {
        "stdio": {
            "command": "node",
            "args": ["server.js", "--name=Keydex MCP"],
        },
        "streamable_http": {"url": "https://mcp.example.test/mcp"},
        "sse": {
            "sse_url": "https://mcp.example.test/sse",
            "message_url": "https://mcp.example.test/messages",
        },
    }[transport]
    defaults.update(overrides)
    return repositories.mcp_servers.create(
        server_id=server_id,
        name=f"Transport {server_id}",
        transport=transport,
        **defaults,
    )


def test_transport_factory_builds_valid_configs_and_clients(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    factory = _factory(tmp_path)
    stdio_server = _create_server(repositories, server_id="srv_stdio", transport="stdio")
    http_server = _create_server(
        repositories,
        server_id="srv_http",
        transport="streamable_http",
    )
    sse_server = _create_server(repositories, server_id="srv_sse", transport="sse")

    stdio_config = factory.build_transport_config(stdio_server)
    http_config = factory.build_transport_config(http_server)
    sse_config = factory.build_transport_config(sse_server)

    assert isinstance(stdio_config, McpStdioTransportConfig)
    assert stdio_config.command == "node"
    assert stdio_config.args == ["server.js", "--name=Keydex MCP"]
    assert isinstance(factory.create_client(stdio_server), McpStdioClient)
    assert isinstance(http_config, McpStreamableHttpTransportConfig)
    assert http_config.url == "https://mcp.example.test/mcp"
    assert isinstance(factory.create_client(http_server), McpStreamableHttpClient)
    assert isinstance(sse_config, McpSseTransportConfig)
    assert sse_config.sse_url == "https://mcp.example.test/sse"
    assert sse_config.message_url == "https://mcp.example.test/messages"
    assert isinstance(factory.create_client(sse_server), McpSseClient)


@pytest.mark.parametrize(
    ("server_id", "transport", "overrides", "message"),
    [
        ("srv_stdio_bad", "stdio", {"url": "https://mcp.example.test/mcp"}, "url"),
        ("srv_http_bad", "streamable_http", {"command": "node"}, "command"),
        ("srv_sse_bad", "sse", {"url": "https://mcp.example.test/mcp"}, "url"),
    ],
)
def test_transport_factory_rejects_mutually_exclusive_fields(
    tmp_path,
    server_id: str,
    transport: str,
    overrides: dict,
    message: str,
) -> None:
    repositories = _repositories(tmp_path)
    server = _create_server(
        repositories,
        server_id=server_id,
        transport=transport,
        **overrides,
    )

    with pytest.raises(McpClientValidationError, match=message):
        _factory(tmp_path).build_transport_config(server)


@pytest.mark.parametrize(
    ("server_id", "transport", "overrides", "message"),
    [
        ("srv_stdio_missing", "stdio", {"command": None}, "command"),
        ("srv_http_missing", "streamable_http", {"url": None}, "url"),
        ("srv_sse_missing", "sse", {"message_url": None}, "message_url"),
    ],
)
def test_transport_factory_rejects_missing_required_fields(
    tmp_path,
    server_id: str,
    transport: str,
    overrides: dict,
    message: str,
) -> None:
    repositories = _repositories(tmp_path)
    server = _create_server(
        repositories,
        server_id=server_id,
        transport=transport,
        **overrides,
    )

    with pytest.raises(McpClientValidationError, match=message):
        _factory(tmp_path).build_transport_config(server)


def test_transport_factory_injects_app_settings_timeout_defaults(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    factory = _factory(
        tmp_path,
        mcp_default_startup_timeout_sec=7,
        mcp_default_tool_timeout_sec=13,
    )
    server = _create_server(
        repositories,
        server_id="srv_defaults",
        transport="streamable_http",
        startup_timeout_sec=0,
        tool_timeout_sec=0,
    )

    config = factory.build_transport_config(server)

    assert isinstance(config, McpStreamableHttpTransportConfig)
    assert config.connect_timeout_sec == 7
    assert config.tool_timeout_sec == 13


def test_stdio_factory_keeps_command_and_args_separate(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    server = _create_server(
        repositories,
        server_id="srv_stdio_args",
        transport="stdio",
        command="python",
        args=["-m", "mock_server", "--title=hello world"],
    )

    config = _factory(tmp_path).build_transport_config(server)

    assert isinstance(config, McpStdioTransportConfig)
    assert config.command == "python"
    assert config.args == ["-m", "mock_server", "--title=hello world"]
