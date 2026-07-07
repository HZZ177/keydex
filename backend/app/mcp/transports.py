from __future__ import annotations

import asyncio
import os
import shutil
import sys
from collections.abc import Awaitable, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, TextIO
from urllib.parse import urlparse

import anyio
import httpx
from anyio.streams.text import TextReceiveStream
from mcp import types as sdk_types
from mcp.client.session import ClientSession
from mcp.client.sse import SSEError, sse_client
from mcp.client.stdio import (
    PROCESS_TERMINATION_TIMEOUT,
    StdioServerParameters,
    _create_platform_compatible_process,
    _get_executable_command,
    _terminate_process_tree,
)
from mcp.client.streamable_http import streamable_http_client
from mcp.shared.exceptions import McpError
from mcp.shared.message import SessionMessage

from backend.app.core.ids import new_id
from backend.app.mcp.auth import McpHttpAuthConfig, compose_http_headers
from backend.app.mcp.client import (
    McpCancellationToken,
    McpClientBase,
    McpClientCapabilities,
    McpClientInitializeResult,
    McpClientToolResult,
    McpClientToolSpec,
    status_from_mcp_error_code,
)
from backend.app.mcp.errors import (
    McpClientConnectionError,
    McpClientValidationError,
    McpRuntimeError,
    map_mcp_exception_code,
)
from backend.app.mcp.types import McpErrorCode, McpServerStatus

StdioClientContextFactory = Callable[
    [StdioServerParameters, TextIO],
    AbstractAsyncContextManager[tuple[Any, Any]],
]
ClientSessionFactory = Callable[..., Any]
StreamableHttpContextFactory = Callable[..., AbstractAsyncContextManager[tuple[Any, Any, Any]]]
SseContextFactory = Callable[..., AbstractAsyncContextManager[tuple[Any, Any]]]


async def _await_with_timeout(awaitable: Awaitable[Any], timeout_sec: float | None) -> Any:
    if timeout_sec is None:
        return await awaitable
    async with asyncio.timeout(timeout_sec):
        return await awaitable


@dataclass(frozen=True)
class McpStdioTransportConfig:
    server_id: str
    command: str
    args: list[str] = field(default_factory=list)
    cwd: str | None = None
    env: dict[str, str] = field(default_factory=dict)
    inherit_environment: bool = True
    startup_timeout_sec: float = 30
    tool_timeout_sec: float = 60
    shutdown_timeout_sec: float = 10
    encoding: str = "utf-8"
    encoding_error_handler: str = "strict"
    validate_command: bool = True

    def __post_init__(self) -> None:
        command = self.command.strip()
        if not command:
            raise McpClientValidationError("stdio command must not be empty")
        if isinstance(self.args, str):
            raise McpClientValidationError("stdio args must be a list of strings")
        if any(not isinstance(arg, str) for arg in self.args):
            raise McpClientValidationError("stdio args must be a list of strings")
        if self.cwd is not None and not Path(self.cwd).exists():
            raise McpClientValidationError("stdio cwd does not exist")
        object.__setattr__(self, "command", command)
        object.__setattr__(self, "args", list(self.args))
        object.__setattr__(self, "env", {str(key): str(value) for key, value in self.env.items()})

    def build_environment(self) -> dict[str, str]:
        if not self.inherit_environment:
            return dict(self.env)
        return {**os.environ, **self.env}

    def to_sdk_parameters(self) -> StdioServerParameters:
        command = self.command
        if self.validate_command:
            command = _resolve_command(self.command)
        return StdioServerParameters(
            command=command,
            args=list(self.args),
            env=self.build_environment(),
            cwd=self.cwd,
            encoding=self.encoding,
            encoding_error_handler=self.encoding_error_handler,
        )


@dataclass(frozen=True)
class McpStreamableHttpTransportConfig:
    server_id: str
    url: str
    headers: dict[str, str] = field(default_factory=dict)
    env_headers: dict[str, str] = field(default_factory=dict)
    bearer_token_env_var: str | None = None
    connect_timeout_sec: float = 30
    read_timeout_sec: float = 60
    tool_timeout_sec: float = 60
    terminate_on_close: bool = True

    def __post_init__(self) -> None:
        url = self.url.strip()
        parsed = urlparse(url)
        if not url or parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise McpClientValidationError("streamable_http url must be an absolute HTTP URL")
        object.__setattr__(self, "url", url)
        object.__setattr__(
            self,
            "headers",
            {str(key): str(value) for key, value in self.headers.items()},
        )
        object.__setattr__(
            self,
            "env_headers",
            {str(key): str(value) for key, value in self.env_headers.items()},
        )

    def build_headers(self) -> dict[str, str]:
        return compose_http_headers(
            McpHttpAuthConfig(
                headers=self.headers,
                env_headers=self.env_headers,
                bearer_token_env_var=self.bearer_token_env_var,
            )
        )

    def build_timeout(self) -> httpx.Timeout:
        return httpx.Timeout(
            timeout=self.read_timeout_sec,
            connect=self.connect_timeout_sec,
            read=self.read_timeout_sec,
        )


@dataclass(frozen=True)
class McpSseTransportConfig:
    server_id: str
    sse_url: str
    message_url: str
    headers: dict[str, str] = field(default_factory=dict)
    env_headers: dict[str, str] = field(default_factory=dict)
    connect_timeout_sec: float = 5
    read_timeout_sec: float = 60
    sse_read_timeout_sec: float = 300
    tool_timeout_sec: float = 60

    def __post_init__(self) -> None:
        sse_url = self.sse_url.strip()
        message_url = self.message_url.strip()
        sse_parsed = urlparse(sse_url)
        message_parsed = urlparse(message_url)
        if not sse_url or sse_parsed.scheme not in {"http", "https"} or not sse_parsed.netloc:
            raise McpClientValidationError("sse_url must be an absolute HTTP URL")
        if (
            not message_url
            or message_parsed.scheme not in {"http", "https"}
            or not message_parsed.netloc
        ):
            raise McpClientValidationError("message_url must be an absolute HTTP URL")
        if (sse_parsed.scheme, sse_parsed.netloc) != (
            message_parsed.scheme,
            message_parsed.netloc,
        ):
            raise McpClientValidationError("message_url must use the same origin as sse_url")
        object.__setattr__(self, "sse_url", sse_url)
        object.__setattr__(self, "message_url", message_url)
        object.__setattr__(
            self,
            "headers",
            {str(key): str(value) for key, value in self.headers.items()},
        )
        object.__setattr__(
            self,
            "env_headers",
            {str(key): str(value) for key, value in self.env_headers.items()},
        )

    def build_headers(self) -> dict[str, str]:
        return compose_http_headers(
            McpHttpAuthConfig(
                headers=self.headers,
                env_headers=self.env_headers,
            )
        )


class McpStdioClient(McpClientBase):
    def __init__(
        self,
        config: McpStdioTransportConfig,
        *,
        stdio_client_factory: StdioClientContextFactory | None = None,
        session_factory: ClientSessionFactory = ClientSession,
        errlog: TextIO = sys.stderr,
    ) -> None:
        super().__init__(server_id=config.server_id)
        self.config = config
        self._stdio_client_factory = stdio_client_factory or strict_stdio_client
        self._session_factory = session_factory
        self._errlog = errlog
        self._stdio_context: AbstractAsyncContextManager[tuple[Any, Any]] | None = None
        self._session_context: Any | None = None
        self._session: Any | None = None
        self._initialize_result: McpClientInitializeResult | None = None
        self._active_call_tasks: dict[str, asyncio.Task[Any]] = {}

    async def initialize(
        self,
        *,
        timeout_sec: float | None = None,
        cancellation: McpCancellationToken | None = None,
    ) -> McpClientInitializeResult:
        _raise_if_cancelled(cancellation)
        if self._session is not None and self._initialize_result is not None:
            return self._initialize_result
        self.transition_status(McpServerStatus.REFRESHING, reason="initialize")
        try:
            result = await _await_with_timeout(
                self._open_and_initialize(cancellation=cancellation),
                timeout_sec or self.config.startup_timeout_sec,
            )
        except BaseException as exc:
            await self._close_open_contexts()
            raise self._map_and_raise(exc) from exc
        self.transition_status(McpServerStatus.ONLINE, reason="initialized")
        self._initialize_result = result
        return result

    async def list_tools(
        self,
        *,
        timeout_sec: float | None = None,
        cancellation: McpCancellationToken | None = None,
    ) -> list[McpClientToolSpec]:
        session = self._require_session()
        result = await self._run_operation(
            session.list_tools(),
            timeout_sec=timeout_sec,
            cancellation=cancellation,
        )
        return [_to_tool_spec(tool) for tool in getattr(result, "tools", [])]

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
        session = self._require_session()
        resolved_call_id = call_id or new_id()
        task = asyncio.create_task(session.call_tool(raw_tool_name, arguments or {}))
        self._active_call_tasks[resolved_call_id] = task
        try:
            result = await self._run_operation(
                task,
                timeout_sec=timeout_sec or self.config.tool_timeout_sec,
                cancellation=cancellation,
            )
        finally:
            self._active_call_tasks.pop(resolved_call_id, None)
        return _to_tool_result(resolved_call_id, result)

    async def cancel_call(self, call_id: str) -> bool:
        task = self._active_call_tasks.get(call_id)
        if task is None:
            return False
        task.cancel()
        return True

    async def shutdown(self, *, timeout_sec: float | None = None) -> None:
        try:
            await _await_with_timeout(
                self._close_open_contexts(),
                timeout_sec or self.config.shutdown_timeout_sec,
            )
        except TimeoutError as exc:
            self.transition_status(McpServerStatus.ERROR, reason="shutdown_timeout")
            raise McpRuntimeError(McpErrorCode.TIMEOUT) from exc
        self.transition_status(McpServerStatus.OFFLINE, reason="shutdown")

    async def _open_and_initialize(
        self,
        *,
        cancellation: McpCancellationToken | None,
    ) -> McpClientInitializeResult:
        _raise_if_cancelled(cancellation)
        self._stdio_context = self._stdio_client_factory(
            self.config.to_sdk_parameters(),
            self._errlog,
        )
        read_stream, write_stream = await self._stdio_context.__aenter__()
        self._session_context = self._session_factory(read_stream, write_stream)
        self._session = await self._session_context.__aenter__()
        _raise_if_cancelled(cancellation)
        result = await self._session.initialize()
        return _to_initialize_result(result)

    def _require_session(self) -> Any:
        if self._session is None:
            raise McpRuntimeError(McpErrorCode.SERVER_OFFLINE)
        return self._session

    async def _run_operation(
        self,
        awaitable: Awaitable[Any],
        *,
        timeout_sec: float | None,
        cancellation: McpCancellationToken | None,
    ) -> Any:
        _raise_if_cancelled(cancellation)
        try:
            result = await _await_with_timeout(awaitable, timeout_sec)
        except asyncio.CancelledError as exc:
            raise McpRuntimeError(McpErrorCode.CANCELLED) from exc
        except BaseException as exc:
            raise self._map_and_raise(exc) from exc
        _raise_if_cancelled(cancellation)
        return result

    def _map_and_raise(self, error: BaseException) -> McpRuntimeError:
        code = map_mcp_exception_code(error)
        self.transition_status(status_from_mcp_error_code(code), reason=code.value)
        return McpRuntimeError(code, detail={"error_type": type(error).__name__})

    async def _close_open_contexts(self) -> None:
        self._initialize_result = None
        active_tasks = list(self._active_call_tasks.values())
        for call_id in list(self._active_call_tasks):
            await self.cancel_call(call_id)
        if active_tasks:
            await asyncio.gather(*active_tasks, return_exceptions=True)
            self._active_call_tasks.clear()
        if self._session_context is not None:
            await self._session_context.__aexit__(None, None, None)
            self._session_context = None
            self._session = None
        if self._stdio_context is not None:
            await self._stdio_context.__aexit__(None, None, None)
            self._stdio_context = None


class McpStreamableHttpClient(McpClientBase):
    def __init__(
        self,
        config: McpStreamableHttpTransportConfig,
        *,
        streamable_http_client_factory: StreamableHttpContextFactory = streamable_http_client,
        session_factory: ClientSessionFactory = ClientSession,
    ) -> None:
        super().__init__(server_id=config.server_id)
        self.config = config
        self._streamable_http_client_factory = streamable_http_client_factory
        self._session_factory = session_factory
        self._http_client: httpx.AsyncClient | None = None
        self._transport_context: AbstractAsyncContextManager[tuple[Any, Any, Any]] | None = None
        self._session_context: Any | None = None
        self._session: Any | None = None
        self._initialize_result: McpClientInitializeResult | None = None
        self._active_call_tasks: dict[str, asyncio.Task[Any]] = {}

    async def initialize(
        self,
        *,
        timeout_sec: float | None = None,
        cancellation: McpCancellationToken | None = None,
    ) -> McpClientInitializeResult:
        _raise_if_cancelled(cancellation)
        if self._session is not None and self._initialize_result is not None:
            return self._initialize_result
        self.transition_status(McpServerStatus.REFRESHING, reason="initialize")
        try:
            result = await _await_with_timeout(
                self._open_and_initialize(cancellation=cancellation),
                timeout_sec or self.config.connect_timeout_sec,
            )
        except BaseException as exc:
            await self._close_open_contexts()
            raise self._map_and_raise(exc) from exc
        self.transition_status(McpServerStatus.ONLINE, reason="initialized")
        self._initialize_result = result
        return result

    async def list_tools(
        self,
        *,
        timeout_sec: float | None = None,
        cancellation: McpCancellationToken | None = None,
    ) -> list[McpClientToolSpec]:
        session = self._require_session()
        result = await self._run_operation(
            session.list_tools(),
            timeout_sec=timeout_sec or self.config.read_timeout_sec,
            cancellation=cancellation,
        )
        return [_to_tool_spec(tool) for tool in getattr(result, "tools", [])]

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
        session = self._require_session()
        resolved_call_id = call_id or new_id()
        task = asyncio.create_task(session.call_tool(raw_tool_name, arguments or {}))
        self._active_call_tasks[resolved_call_id] = task
        try:
            result = await self._run_operation(
                task,
                timeout_sec=timeout_sec or self.config.tool_timeout_sec,
                cancellation=cancellation,
            )
        finally:
            self._active_call_tasks.pop(resolved_call_id, None)
        return _to_tool_result(resolved_call_id, result)

    async def cancel_call(self, call_id: str) -> bool:
        task = self._active_call_tasks.get(call_id)
        if task is None:
            return False
        task.cancel()
        return True

    async def shutdown(self, *, timeout_sec: float | None = None) -> None:
        try:
            await _await_with_timeout(
                self._close_open_contexts(),
                timeout_sec or self.config.read_timeout_sec,
            )
        except TimeoutError as exc:
            self.transition_status(McpServerStatus.ERROR, reason="shutdown_timeout")
            raise McpRuntimeError(McpErrorCode.TIMEOUT) from exc
        self.transition_status(McpServerStatus.OFFLINE, reason="shutdown")

    async def _open_and_initialize(
        self,
        *,
        cancellation: McpCancellationToken | None,
    ) -> McpClientInitializeResult:
        _raise_if_cancelled(cancellation)
        self._http_client = httpx.AsyncClient(
            headers=self.config.build_headers(),
            timeout=self.config.build_timeout(),
        )
        self._transport_context = self._streamable_http_client_factory(
            self.config.url,
            http_client=self._http_client,
            terminate_on_close=self.config.terminate_on_close,
        )
        read_stream, write_stream, _session_id = await self._transport_context.__aenter__()
        self._session_context = self._session_factory(read_stream, write_stream)
        self._session = await self._session_context.__aenter__()
        _raise_if_cancelled(cancellation)
        result = await self._session.initialize()
        return _to_initialize_result(result)

    def _require_session(self) -> Any:
        if self._session is None:
            raise McpRuntimeError(McpErrorCode.SERVER_OFFLINE)
        return self._session

    async def _run_operation(
        self,
        awaitable: Awaitable[Any],
        *,
        timeout_sec: float | None,
        cancellation: McpCancellationToken | None,
    ) -> Any:
        _raise_if_cancelled(cancellation)
        try:
            result = await _await_with_timeout(awaitable, timeout_sec)
        except asyncio.CancelledError as exc:
            raise McpRuntimeError(McpErrorCode.CANCELLED) from exc
        except BaseException as exc:
            raise self._map_and_raise(exc) from exc
        _raise_if_cancelled(cancellation)
        return result

    def _map_and_raise(self, error: BaseException) -> McpRuntimeError:
        code = _http_exception_code(error) or map_mcp_exception_code(error)
        self.transition_status(status_from_mcp_error_code(code), reason=code.value)
        return McpRuntimeError(code, detail={"error_type": type(error).__name__})

    async def _close_open_contexts(self) -> None:
        self._initialize_result = None
        active_tasks = list(self._active_call_tasks.values())
        for call_id in list(self._active_call_tasks):
            await self.cancel_call(call_id)
        if active_tasks:
            await asyncio.gather(*active_tasks, return_exceptions=True)
            self._active_call_tasks.clear()
        if self._session_context is not None:
            await self._session_context.__aexit__(None, None, None)
            self._session_context = None
            self._session = None
        if self._transport_context is not None:
            await self._transport_context.__aexit__(None, None, None)
            self._transport_context = None
        if self._http_client is not None:
            await self._http_client.aclose()
            self._http_client = None


class McpSseClient(McpClientBase):
    def __init__(
        self,
        config: McpSseTransportConfig,
        *,
        sse_client_factory: SseContextFactory | None = None,
        session_factory: ClientSessionFactory = ClientSession,
    ) -> None:
        super().__init__(server_id=config.server_id)
        self.config = config
        self._sse_client_factory = sse_client_factory or sdk_sse_client
        self._session_factory = session_factory
        self._transport_context: AbstractAsyncContextManager[tuple[Any, Any]] | None = None
        self._session_context: Any | None = None
        self._session: Any | None = None
        self._initialize_result: McpClientInitializeResult | None = None
        self._active_call_tasks: dict[str, asyncio.Task[Any]] = {}

    async def initialize(
        self,
        *,
        timeout_sec: float | None = None,
        cancellation: McpCancellationToken | None = None,
    ) -> McpClientInitializeResult:
        _raise_if_cancelled(cancellation)
        if self._session is not None and self._initialize_result is not None:
            return self._initialize_result
        self.transition_status(McpServerStatus.REFRESHING, reason="initialize")
        try:
            result = await _await_with_timeout(
                self._open_and_initialize(cancellation=cancellation),
                timeout_sec or self.config.connect_timeout_sec,
            )
        except BaseException as exc:
            await self._close_open_contexts()
            raise self._map_and_raise(exc) from exc
        self.transition_status(McpServerStatus.ONLINE, reason="initialized")
        self._initialize_result = result
        return result

    async def list_tools(
        self,
        *,
        timeout_sec: float | None = None,
        cancellation: McpCancellationToken | None = None,
    ) -> list[McpClientToolSpec]:
        session = self._require_session()
        result = await self._run_operation(
            session.list_tools(),
            timeout_sec=timeout_sec or self.config.sse_read_timeout_sec,
            cancellation=cancellation,
        )
        return [_to_tool_spec(tool) for tool in getattr(result, "tools", [])]

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
        session = self._require_session()
        resolved_call_id = call_id or new_id()
        task = asyncio.create_task(session.call_tool(raw_tool_name, arguments or {}))
        self._active_call_tasks[resolved_call_id] = task
        try:
            result = await self._run_operation(
                task,
                timeout_sec=timeout_sec or self.config.tool_timeout_sec,
                cancellation=cancellation,
            )
        finally:
            self._active_call_tasks.pop(resolved_call_id, None)
        return _to_tool_result(resolved_call_id, result)

    async def cancel_call(self, call_id: str) -> bool:
        task = self._active_call_tasks.get(call_id)
        if task is None:
            return False
        task.cancel()
        return True

    async def shutdown(self, *, timeout_sec: float | None = None) -> None:
        try:
            await _await_with_timeout(
                self._close_open_contexts(),
                timeout_sec or self.config.read_timeout_sec,
            )
        except TimeoutError as exc:
            self.transition_status(McpServerStatus.ERROR, reason="shutdown_timeout")
            raise McpRuntimeError(McpErrorCode.TIMEOUT) from exc
        self.transition_status(McpServerStatus.OFFLINE, reason="shutdown")

    async def _open_and_initialize(
        self,
        *,
        cancellation: McpCancellationToken | None,
    ) -> McpClientInitializeResult:
        _raise_if_cancelled(cancellation)
        self._transport_context = self._sse_client_factory(
            self.config.sse_url,
            message_url=self.config.message_url,
            headers=self.config.build_headers(),
            timeout=self.config.read_timeout_sec,
            sse_read_timeout=self.config.sse_read_timeout_sec,
        )
        read_stream, write_stream = await self._transport_context.__aenter__()
        self._session_context = self._session_factory(read_stream, write_stream)
        self._session = await self._session_context.__aenter__()
        _raise_if_cancelled(cancellation)
        result = await self._session.initialize()
        return _to_initialize_result(result)

    def _require_session(self) -> Any:
        if self._session is None:
            raise McpRuntimeError(McpErrorCode.SERVER_OFFLINE)
        return self._session

    async def _run_operation(
        self,
        awaitable: Awaitable[Any],
        *,
        timeout_sec: float | None,
        cancellation: McpCancellationToken | None,
    ) -> Any:
        _raise_if_cancelled(cancellation)
        try:
            result = await _await_with_timeout(awaitable, timeout_sec)
        except asyncio.CancelledError as exc:
            raise McpRuntimeError(McpErrorCode.CANCELLED) from exc
        except BaseException as exc:
            raise self._map_and_raise(exc) from exc
        _raise_if_cancelled(cancellation)
        return result

    def _map_and_raise(self, error: BaseException) -> McpRuntimeError:
        code = _http_exception_code(error) or map_mcp_exception_code(error)
        self.transition_status(status_from_mcp_error_code(code), reason=code.value)
        return McpRuntimeError(code, detail={"error_type": type(error).__name__})

    async def _close_open_contexts(self) -> None:
        self._initialize_result = None
        active_tasks = list(self._active_call_tasks.values())
        for call_id in list(self._active_call_tasks):
            await self.cancel_call(call_id)
        if active_tasks:
            await asyncio.gather(*active_tasks, return_exceptions=True)
            self._active_call_tasks.clear()
        if self._session_context is not None:
            await self._session_context.__aexit__(None, None, None)
            self._session_context = None
            self._session = None
        if self._transport_context is not None:
            await self._transport_context.__aexit__(None, None, None)
            self._transport_context = None


def sdk_sse_client(
    sse_url: str,
    *,
    message_url: str,
    headers: dict[str, str] | None,
    timeout: float,
    sse_read_timeout: float,
) -> AbstractAsyncContextManager[tuple[Any, Any]]:
    _validate_same_origin(sse_url, message_url)
    return sse_client(
        sse_url,
        headers=headers,
        timeout=timeout,
        sse_read_timeout=sse_read_timeout,
    )


@asynccontextmanager
async def strict_stdio_client(
    server: StdioServerParameters,
    errlog: TextIO = sys.stderr,
) -> Any:
    read_stream_writer, read_stream = anyio.create_memory_object_stream(0)
    write_stream, write_stream_reader = anyio.create_memory_object_stream(0)
    try:
        process = await _create_platform_compatible_process(
            command=_get_executable_command(server.command),
            args=server.args,
            env=server.env,
            errlog=errlog,
            cwd=server.cwd,
        )
    except OSError:
        await read_stream.aclose()
        await write_stream.aclose()
        await read_stream_writer.aclose()
        await write_stream_reader.aclose()
        raise

    async def stdout_reader() -> None:
        assert process.stdout, "Opened process is missing stdout"
        try:
            async with read_stream_writer:
                buffer = ""
                async for chunk in TextReceiveStream(
                    process.stdout,
                    encoding=server.encoding,
                    errors=server.encoding_error_handler,
                ):
                    lines = (buffer + chunk).split("\n")
                    buffer = lines.pop()
                    for line in lines:
                        try:
                            message = sdk_types.JSONRPCMessage.model_validate_json(line)
                        except Exception as exc:
                            await read_stream_writer.send(exc)
                            continue
                        await read_stream_writer.send(SessionMessage(message))
        except anyio.ClosedResourceError:
            await anyio.lowlevel.checkpoint()

    async def stdin_writer() -> None:
        assert process.stdin, "Opened process is missing stdin"
        try:
            async with write_stream_reader:
                async for session_message in write_stream_reader:
                    payload = session_message.message.model_dump_json(
                        by_alias=True,
                        exclude_none=True,
                    )
                    await process.stdin.send(
                        (payload + "\n").encode(
                            encoding=server.encoding,
                            errors=server.encoding_error_handler,
                        )
                    )
        except anyio.ClosedResourceError:
            await anyio.lowlevel.checkpoint()

    async with anyio.create_task_group() as task_group, process:
        task_group.start_soon(stdout_reader)
        task_group.start_soon(stdin_writer)
        try:
            yield read_stream, write_stream
        finally:
            if process.stdin:
                try:
                    await process.stdin.aclose()
                except Exception:
                    pass
            try:
                with anyio.fail_after(PROCESS_TERMINATION_TIMEOUT):
                    await process.wait()
            except TimeoutError:
                await _terminate_process_tree(process)
            except ProcessLookupError:
                pass
            await read_stream.aclose()
            await write_stream.aclose()
            await read_stream_writer.aclose()
            await write_stream_reader.aclose()


def _resolve_command(command: str) -> str:
    path = Path(command)
    if path.is_absolute() or any(separator in command for separator in ("/", "\\")):
        if path.exists():
            return command
        raise McpClientConnectionError("stdio command path does not exist")
    if shutil.which(command) is None:
        raise McpClientConnectionError("stdio command was not found on PATH")
    return command


def _http_exception_code(error: BaseException) -> McpErrorCode | None:
    if isinstance(error, httpx.HTTPStatusError):
        status_code = error.response.status_code
        if status_code in {401, 403}:
            return McpErrorCode.AUTH_REQUIRED
        return McpErrorCode.SERVER_OFFLINE
    if isinstance(error, httpx.TimeoutException):
        return McpErrorCode.TIMEOUT
    if isinstance(error, httpx.TransportError):
        return McpErrorCode.SERVER_OFFLINE
    if isinstance(error, SSEError):
        return McpErrorCode.SERVER_OFFLINE
    if isinstance(error, McpError):
        message = str(error).lower()
        if "oauth" in message or "auth" in message or "unauthorized" in message:
            return McpErrorCode.AUTH_REQUIRED
        return McpErrorCode.PROTOCOL_ERROR
    return None


def _validate_same_origin(left: str, right: str) -> None:
    left_parsed = urlparse(left)
    right_parsed = urlparse(right)
    if (left_parsed.scheme, left_parsed.netloc) != (right_parsed.scheme, right_parsed.netloc):
        raise McpClientValidationError("SSE message_url origin must match sse_url")


def _raise_if_cancelled(cancellation: McpCancellationToken | None) -> None:
    if cancellation is not None:
        cancellation.raise_if_cancelled()


def _to_initialize_result(result: Any) -> McpClientInitializeResult:
    capabilities = getattr(result, "capabilities", None)
    return McpClientInitializeResult(
        protocol_version=str(getattr(result, "protocolVersion", "") or ""),
        server_info=_dump_jsonable(getattr(result, "serverInfo", {})),
        capabilities=McpClientCapabilities(
            tools=getattr(capabilities, "tools", None) is not None,
            resources_reserved=True,
            sampling=getattr(capabilities, "sampling", None) is not None,
            elicitation=getattr(capabilities, "elicitation", None) is not None,
            raw=_dump_jsonable(capabilities),
        ),
    )


def _to_tool_spec(tool: Any) -> McpClientToolSpec:
    annotations = getattr(tool, "annotations", None)
    return McpClientToolSpec(
        name=str(tool.name),
        description=getattr(tool, "description", None),
        input_schema=dict(getattr(tool, "inputSchema", {}) or {}),
        annotations=_dump_jsonable(annotations),
        raw=_dump_jsonable(tool),
    )


def _to_tool_result(call_id: str, result: Any) -> McpClientToolResult:
    return McpClientToolResult(
        call_id=call_id,
        status="error" if bool(getattr(result, "isError", False)) else "success",
        content=[_dump_jsonable(item) for item in getattr(result, "content", [])],
        structured_content=getattr(result, "structuredContent", None),
        is_error=bool(getattr(result, "isError", False)),
        metadata=_dump_jsonable(getattr(result, "meta", None)),
    )


def _dump_jsonable(value: Any) -> dict[str, Any]:
    if value is None:
        return {}
    if isinstance(value, dict):
        return dict(value)
    if hasattr(value, "model_dump"):
        return value.model_dump(mode="json", by_alias=True, exclude_none=True)
    if hasattr(value, "__dict__"):
        return dict(value.__dict__)
    return {"value": value}
