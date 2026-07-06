from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol, TypeAlias, runtime_checkable

from backend.app.core.config import AppSettings
from backend.app.mcp.client import McpClient
from backend.app.mcp.errors import McpClientValidationError
from backend.app.mcp.transports import (
    McpSseClient,
    McpSseTransportConfig,
    McpStdioClient,
    McpStdioTransportConfig,
    McpStreamableHttpClient,
    McpStreamableHttpTransportConfig,
)
from backend.app.storage import McpServerRecord

McpTransportConfig: TypeAlias = (
    McpStdioTransportConfig | McpStreamableHttpTransportConfig | McpSseTransportConfig
)


@runtime_checkable
class McpClientFactory(Protocol):
    def create_client(self, server: McpServerRecord) -> McpClient: ...


@dataclass(frozen=True)
class McpTransportDefaults:
    startup_timeout_sec: float
    tool_timeout_sec: float

    @classmethod
    def from_settings(cls, settings: AppSettings) -> McpTransportDefaults:
        return cls(
            startup_timeout_sec=float(settings.mcp_default_startup_timeout_sec),
            tool_timeout_sec=float(settings.mcp_default_tool_timeout_sec),
        )


class McpTransportClientFactory:
    def __init__(self, settings: AppSettings) -> None:
        self.defaults = McpTransportDefaults.from_settings(settings)

    def create_client(self, server: McpServerRecord) -> McpClient:
        config = self.build_transport_config(server)
        if isinstance(config, McpStdioTransportConfig):
            return McpStdioClient(config)
        if isinstance(config, McpStreamableHttpTransportConfig):
            return McpStreamableHttpClient(config)
        if isinstance(config, McpSseTransportConfig):
            return McpSseClient(config)
        raise McpClientValidationError(f"unsupported MCP transport: {server.transport}")

    def build_transport_config(self, server: McpServerRecord) -> McpTransportConfig:
        if server.transport == "stdio":
            return self._build_stdio_config(server)
        if server.transport == "streamable_http":
            return self._build_streamable_http_config(server)
        if server.transport == "sse":
            return self._build_sse_config(server)
        raise McpClientValidationError(f"unsupported MCP transport: {server.transport}")

    def _build_stdio_config(self, server: McpServerRecord) -> McpStdioTransportConfig:
        _reject_fields(
            server,
            transport="stdio",
            field_names=("url", "sse_url", "message_url"),
        )
        _require_text(server.command, "stdio command is required")
        return McpStdioTransportConfig(
            server_id=server.id,
            command=server.command or "",
            args=[str(arg) for arg in server.args or []],
            cwd=server.cwd,
            env=_string_map(server.env),
            inherit_environment=server.inherit_environment,
            startup_timeout_sec=_positive_or_default(
                server.startup_timeout_sec,
                self.defaults.startup_timeout_sec,
            ),
            tool_timeout_sec=_positive_or_default(
                server.tool_timeout_sec,
                self.defaults.tool_timeout_sec,
            ),
            shutdown_timeout_sec=float(server.shutdown_timeout_sec),
        )

    def _build_streamable_http_config(
        self,
        server: McpServerRecord,
    ) -> McpStreamableHttpTransportConfig:
        _reject_fields(
            server,
            transport="streamable_http",
            field_names=("command", "args", "cwd", "sse_url", "message_url"),
        )
        _require_text(server.url, "streamable_http url is required")
        return McpStreamableHttpTransportConfig(
            server_id=server.id,
            url=server.url or "",
            headers=_string_map(server.headers),
            env_headers=_string_map(server.env_headers),
            bearer_token_env_var=server.bearer_token_env_var,
            connect_timeout_sec=_positive_or_default(
                server.startup_timeout_sec,
                self.defaults.startup_timeout_sec,
            ),
            read_timeout_sec=float(server.read_timeout_sec),
            tool_timeout_sec=_positive_or_default(
                server.tool_timeout_sec,
                self.defaults.tool_timeout_sec,
            ),
        )

    def _build_sse_config(self, server: McpServerRecord) -> McpSseTransportConfig:
        _reject_fields(
            server,
            transport="sse",
            field_names=("command", "args", "cwd", "url", "bearer_token_env_var"),
        )
        _require_text(server.sse_url, "sse_url is required")
        _require_text(server.message_url, "message_url is required")
        return McpSseTransportConfig(
            server_id=server.id,
            sse_url=server.sse_url or "",
            message_url=server.message_url or "",
            headers=_string_map(server.headers),
            env_headers=_string_map(server.env_headers),
            connect_timeout_sec=_positive_or_default(
                server.startup_timeout_sec,
                self.defaults.startup_timeout_sec,
            ),
            read_timeout_sec=float(server.read_timeout_sec),
            sse_read_timeout_sec=float(server.sse_read_timeout_sec),
            tool_timeout_sec=_positive_or_default(
                server.tool_timeout_sec,
                self.defaults.tool_timeout_sec,
            ),
        )


def _reject_fields(
    server: McpServerRecord,
    *,
    transport: str,
    field_names: tuple[str, ...],
) -> None:
    present = [
        field_name
        for field_name in field_names
        if _field_has_value(getattr(server, field_name))
    ]
    if present:
        raise McpClientValidationError(
            f"{transport} transport does not accept fields: {', '.join(present)}"
        )


def _field_has_value(value: Any) -> bool:
    if value is None:
        return False
    if value == "":
        return False
    if value == []:
        return False
    if value == {}:
        return False
    return True


def _require_text(value: str | None, message: str) -> None:
    if not str(value or "").strip():
        raise McpClientValidationError(message)


def _positive_or_default(value: int | float | None, default: float) -> float:
    if value is None or float(value) <= 0:
        return default
    return float(value)


def _string_map(value: dict[str, Any] | None) -> dict[str, str]:
    return {str(key): str(item) for key, item in (value or {}).items()}
