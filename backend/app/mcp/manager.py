from __future__ import annotations

import asyncio
import time
from contextlib import suppress
from dataclasses import dataclass
from typing import Any

from backend.app.agent.tool_results.models import INTERNAL_ARTIFACT_SOURCE_KEY
from backend.app.core.config import AppSettings
from backend.app.core.ids import new_id
from backend.app.core.logger import logger
from backend.app.core.system_proxy import SystemProxySnapshot, SystemProxyState
from backend.app.core.time import to_iso_z, utc_now
from backend.app.mcp.approval import (
    McpApprovalService,
    McpToolApprovalDecider,
    McpToolApprovalRequest,
)
from backend.app.mcp.audit import McpAuditWriter
from backend.app.mcp.client import (
    McpCancellationToken,
    McpClient,
    McpClientInitializeResult,
    McpClientToolResult,
    status_from_mcp_error_code,
)
from backend.app.mcp.config import McpClientFactory, McpTransportClientFactory
from backend.app.mcp.discovery import McpDiscoveryService, McpRefreshReport
from backend.app.mcp.elicitation import McpElicitationService
from backend.app.mcp.errors import McpRuntimeError, to_mcp_runtime_error
from backend.app.mcp.resources import (
    McpResourcesReservedService,
    McpResourceSummary,
    McpResourceTemplateSummary,
)
from backend.app.mcp.runtime import McpAllowedToolExecution, McpLiveExecutionGuard
from backend.app.mcp.sampling import McpSamplingService
from backend.app.mcp.tools import (
    normalize_mcp_tool_result,
    normalize_mcp_tool_result_for_artifact,
)
from backend.app.mcp.trust import resolve_mcp_tool_approval_policy
from backend.app.mcp.types import McpErrorCode, McpServerStatus
from backend.app.storage import McpServerRecord, StorageRepositories
from backend.app.tools import ToolExecutionError, ToolExecutionResult


@dataclass(frozen=True)
class McpManagerStatus:
    enabled: bool
    runtime_status: str
    started: bool
    active_client_count: int

    def to_dict(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "runtime_status": self.runtime_status,
            "started": self.started,
            "active_client_count": self.active_client_count,
        }


@dataclass
class _CachedClient:
    client: McpClient
    server_updated_at: str
    proxy_fingerprint: str | None


@dataclass(frozen=True)
class _RunningToolCall:
    call_id: str
    session_id: str | None
    snapshot_id: str
    server_id: str
    server_name: str
    raw_tool_name: str
    model_name: str
    approval_mode: str
    started_at: str
    started_monotonic: float

    def to_dict(self) -> dict[str, Any]:
        return {
            "call_id": self.call_id,
            "session_id": self.session_id,
            "snapshot_id": self.snapshot_id,
            "server_id": self.server_id,
            "server_name": self.server_name,
            "raw_tool_name": self.raw_tool_name,
            "model_name": self.model_name,
            "approval_mode": self.approval_mode,
            "started_at": self.started_at,
            "elapsed_ms": _duration_ms(self.started_monotonic),
        }


@dataclass
class _ScheduledRefresh:
    task: asyncio.Task[None]
    interval_sec: int
    server_updated_at: str


class McpManager:
    def __init__(
        self,
        *,
        settings: AppSettings,
        repositories: StorageRepositories,
        client_factory: McpClientFactory | None = None,
        approval_decider: McpToolApprovalDecider | None = None,
        elicitation_service: McpElicitationService | None = None,
        sampling_service: McpSamplingService | None = None,
        system_proxy_state: SystemProxyState | None = None,
    ) -> None:
        self.settings = settings
        self.repositories = repositories
        self.client_factory = client_factory or McpTransportClientFactory(settings)
        self.approval_decider = approval_decider or McpApprovalService(repositories)
        self.elicitation_service = elicitation_service
        self.sampling_service = sampling_service
        self.system_proxy_state = system_proxy_state or SystemProxyState()
        self.audit_writer = McpAuditWriter.from_repositories(repositories)
        self.discovery_service = McpDiscoveryService(repositories)
        self.resources_service = McpResourcesReservedService(repositories)
        self._clients: dict[str, _CachedClient] = {}
        self._running_calls: dict[str, _RunningToolCall] = {}
        self._refresh_tasks: dict[str, _ScheduledRefresh] = {}
        self._refresh_locks: dict[str, asyncio.Lock] = {}
        self._connect_locks: dict[str, asyncio.Lock] = {}
        self._lock = asyncio.Lock()
        self._scheduler_lock = asyncio.Lock()
        self._started = False
        self._runtime_status = "disabled" if not settings.mcp_enabled else "enabled"

    @property
    def enabled(self) -> bool:
        return bool(self.settings.mcp_enabled)

    @property
    def started(self) -> bool:
        return self._started

    @property
    def active_client_count(self) -> int:
        return len(self._clients)

    @property
    def auto_refresh_task_count(self) -> int:
        return len(self._refresh_tasks)

    def status(self) -> McpManagerStatus:
        return McpManagerStatus(
            enabled=self.enabled,
            runtime_status=self._runtime_status,
            started=self._started,
            active_client_count=self.active_client_count,
        )

    async def start(self) -> None:
        self._started = True
        if not self.enabled:
            self._runtime_status = "disabled"
            return
        self._runtime_status = "enabled"
        servers, _total = self.repositories.mcp_servers.list(enabled=True, limit=500)
        for server in servers:
            if server.connect_mode != "on_startup":
                continue
            try:
                await self.get_or_connect_client(server.id)
            except Exception as exc:
                self._record_client_error(server.id, exc)
        await self.sync_auto_refresh_tasks()

    async def sync_auto_refresh_tasks(self) -> None:
        if not self.enabled:
            await self.cancel_auto_refresh_tasks()
            return
        servers, _total = self.repositories.mcp_servers.list(enabled=True, limit=500)
        desired_ids: set[str] = set()
        async with self._scheduler_lock:
            for server in servers:
                if not server.auto_refresh:
                    continue
                desired_ids.add(server.id)
                interval_sec = max(1, int(server.refresh_interval_sec))
                scheduled = self._refresh_tasks.get(server.id)
                if (
                    scheduled is not None
                    and scheduled.interval_sec == interval_sec
                    and scheduled.server_updated_at == server.updated_at
                ):
                    continue
                await self._cancel_auto_refresh_task_locked(server.id)
                task = asyncio.create_task(
                    self._auto_refresh_loop(server.id, interval_sec),
                    name=f"mcp-auto-refresh-{server.id}",
                )
                self._refresh_tasks[server.id] = _ScheduledRefresh(
                    task=task,
                    interval_sec=interval_sec,
                    server_updated_at=server.updated_at,
                )
            for server_id in list(set(self._refresh_tasks) - desired_ids):
                await self._cancel_auto_refresh_task_locked(server_id)

    async def cancel_auto_refresh_tasks(self) -> None:
        async with self._scheduler_lock:
            for server_id in list(self._refresh_tasks):
                await self._cancel_auto_refresh_task_locked(server_id)

    def scheduled_refresh_server_ids(self) -> list[str]:
        return sorted(self._refresh_tasks)

    def scheduled_refresh_intervals(self) -> dict[str, int]:
        return {
            server_id: scheduled.interval_sec
            for server_id, scheduled in sorted(self._refresh_tasks.items())
        }

    async def get_or_create_client(self, server_id: str) -> McpClient:
        if not self.enabled:
            raise McpRuntimeError(McpErrorCode.MCP_DISABLED)
        server = self._load_server(server_id)
        if not server.enabled:
            self.repositories.mcp_server_status.upsert(server.id, status="disabled")
            raise McpRuntimeError(McpErrorCode.SERVER_DISABLED)
        proxy_snapshot = self._proxy_snapshot_for_server(server)
        proxy_fingerprint = proxy_snapshot.fingerprint if proxy_snapshot is not None else None
        async with self._lock:
            cached = self._clients.get(server_id)
            if cached is not None and self._cached_client_matches(
                cached,
                server=server,
                proxy_fingerprint=proxy_fingerprint,
            ):
                return cached.client
            if cached is not None:
                route_changed = (
                    proxy_snapshot is not None
                    and cached.proxy_fingerprint != proxy_fingerprint
                )
                if route_changed:
                    summary = proxy_snapshot.safe_summary()
                    logger.info(
                        "[MCP Manager] rebuilding client for network route | "
                        "code=network_route_changed | server_id={} | transport={} | "
                        "mode={} | generation={} | schemes={} | fingerprint={}",
                        server.id,
                        server.transport,
                        summary["mode"],
                        summary["generation"],
                        ",".join(summary["schemes"]) or "-",
                        summary["fingerprint"],
                    )
                await self._shutdown_cached_client(
                    server_id,
                    cached,
                    record_error=route_changed,
                )
            client = self.client_factory.create_client(server)
            self._clients[server_id] = _CachedClient(
                client=client,
                server_updated_at=server.updated_at,
                proxy_fingerprint=proxy_fingerprint,
            )
            return client

    def _proxy_snapshot_for_server(
        self,
        server: McpServerRecord,
    ) -> SystemProxySnapshot | None:
        if server.transport not in {"streamable_http", "sse"}:
            return None
        return self.system_proxy_state.current()

    @staticmethod
    def _cached_client_matches(
        cached: _CachedClient,
        *,
        server: McpServerRecord,
        proxy_fingerprint: str | None,
    ) -> bool:
        return (
            cached.server_updated_at == server.updated_at
            and cached.proxy_fingerprint == proxy_fingerprint
        )

    async def get_or_connect_client(
        self,
        server_id: str,
        *,
        cancellation: McpCancellationToken | None = None,
    ) -> McpClient:
        async with self._connect_lock(server_id):
            server = self._load_server(server_id)
            client = await self.get_or_create_client(server_id)
            if client.status == McpServerStatus.ONLINE:
                return client
            try:
                init_result = await client.initialize(
                    timeout_sec=server.startup_timeout_sec,
                    cancellation=cancellation,
                )
            except Exception as exc:
                self._record_client_error(server_id, exc)
                await self.drop_client(server_id)
                raise
            self._record_client_online(server_id, init_result)
            return client

    async def drop_client(self, server_id: str) -> bool:
        async with self._lock:
            cached = self._clients.pop(server_id, None)
        if cached is None:
            return False
        await self._shutdown_cached_client(server_id, cached)
        return True

    def running_calls(self, *, session_id: str | None = None) -> list[dict[str, Any]]:
        calls = list(self._running_calls.values())
        if session_id is not None:
            calls = [call for call in calls if call.session_id == session_id]
        return [call.to_dict() for call in sorted(calls, key=lambda item: item.started_at)]

    async def cancel_call(self, call_id: str) -> dict[str, Any]:
        running = self._running_calls.get(call_id)
        if running is None:
            return {"call_id": call_id, "cancelled": False, "reason": "call_not_running"}
        async with self._lock:
            cached = self._clients.get(running.server_id)
        if cached is None:
            return {"call_id": call_id, "cancelled": False, "reason": "client_not_running"}
        cancelled = await cached.client.cancel_call(call_id)
        if cancelled:
            self.audit_writer.append_event(
                event_type="tool.cancelled",
                server_id=running.server_id,
                raw_tool_name=running.raw_tool_name,
                session_id=running.session_id,
                call_id=call_id,
                status="cancelled",
                duration_ms=_duration_ms(running.started_monotonic),
                summary=f"MCP tool call cancelled: {running.raw_tool_name}",
                detail=running.to_dict(),
            )
        return {
            "call_id": call_id,
            "cancelled": cancelled,
            "server_id": running.server_id,
            "raw_tool_name": running.raw_tool_name,
        }

    def list_resources_reserved(self, server_id: str) -> list[McpResourceSummary]:
        return self.resources_service.list_resources_reserved(server_id)

    def list_resource_templates_reserved(
        self,
        server_id: str,
    ) -> list[McpResourceTemplateSummary]:
        return self.resources_service.list_resource_templates_reserved(server_id)

    def read_resource_reserved(self, server_id: str, uri: str) -> None:
        self.resources_service.read_resource_reserved(server_id, uri)

    async def refresh_capabilities(
        self,
        server_id: str,
        *,
        cancellation: McpCancellationToken | None = None,
    ) -> McpRefreshReport:
        report = await self._refresh_capabilities_locked(
            server_id,
            cancellation=cancellation,
            skip_if_running=False,
        )
        if report is None:
            raise McpRuntimeError(McpErrorCode.CANCELLED, "MCP refresh was skipped.")
        return report

    async def _handle_tool_elicitation_if_requested(
        self,
        *,
        tool_result: Any,
        server: McpServerRecord,
        session_id: str | None,
        raw_tool_name: str,
    ) -> Any:
        request = _extract_elicitation_request(tool_result)
        if request is None:
            return tool_result
        if not server.elicitation_enabled:
            raise McpRuntimeError(
                McpErrorCode.POLICY_DENIED,
                detail={
                    "reason": "elicitation_disabled",
                    "server_id": server.id,
                    "raw_tool_name": raw_tool_name,
                },
            )
        if not session_id:
            raise McpRuntimeError(
                McpErrorCode.VALIDATION_ERROR,
                detail={
                    "reason": "elicitation_requires_session",
                    "server_id": server.id,
                    "raw_tool_name": raw_tool_name,
                },
            )
        if self.elicitation_service is None:
            raise McpRuntimeError(
                McpErrorCode.INTERNAL_ERROR,
                detail={
                    "reason": "elicitation_service_unavailable",
                    "server_id": server.id,
                    "raw_tool_name": raw_tool_name,
                },
            )
        result = await self.elicitation_service.request(
            session_id=session_id,
            server_id=server.id,
            raw_tool_name=raw_tool_name,
            title=_string_or_default(request.get("title"), "MCP 请求补充信息"),
            schema=_elicitation_schema(request),
            timeout_sec=float(server.tool_timeout_sec),
            elicitation_id=_optional_string(request.get("id") or request.get("elicitation_id")),
        )
        if result.status == "cancelled":
            raise McpRuntimeError(
                McpErrorCode.CANCELLED,
                detail={
                    "reason": "elicitation_cancelled",
                    "server_id": server.id,
                    "raw_tool_name": raw_tool_name,
                    "elicitation_id": result.elicitation_id,
                },
            )
        if result.status == "timeout":
            raise McpRuntimeError(
                McpErrorCode.TIMEOUT,
                detail={
                    "reason": "elicitation_timeout",
                    "server_id": server.id,
                    "raw_tool_name": raw_tool_name,
                    "elicitation_id": result.elicitation_id,
                },
            )
        return _tool_result_with_elicitation_values(tool_result, result.to_dict())

    async def _handle_tool_sampling_if_requested(
        self,
        *,
        tool_result: Any,
        server: McpServerRecord,
        session_id: str | None,
        raw_tool_name: str,
        snapshot_id: str,
        call_id: str,
        call_context: Any,
    ) -> Any:
        request = _extract_sampling_request(tool_result)
        if request is None:
            return tool_result
        if self.sampling_service is None:
            raise McpRuntimeError(
                McpErrorCode.INTERNAL_ERROR,
                detail={
                    "reason": "sampling_service_unavailable",
                    "server_id": server.id,
                    "raw_tool_name": raw_tool_name,
                },
            )

        async def approve_sampling(approval_payload: dict[str, Any]) -> bool:
            decision = await self.approval_decider.decide(
                McpToolApprovalRequest(
                    snapshot_id=snapshot_id,
                    session_id=session_id or "",
                    user_id=_call_context_text(call_context, "user_id") or "",
                    server_id=server.id,
                    raw_tool_name="sampling/createMessage",
                    model_name=_string_or_default(approval_payload.get("model"), "current_default"),
                    approval_mode=_string_or_default(
                        approval_payload.get("approval_mode"),
                        "prompt",
                    ),
                    arguments={
                        "model": approval_payload.get("model"),
                        "max_tokens": approval_payload.get("max_tokens"),
                        "message_count": approval_payload.get("message_count"),
                    },
                    trace_id=_call_context_text(call_context, "trace_id"),
                    turn_index=_call_context_int(call_context, "turn_index"),
                    run_id=_call_context_text(call_context, "run_id"),
                    tool_call_id=call_id,
                    dispatcher=_call_context_dispatcher(call_context),
                    wait_seconds=_call_context_float(
                        call_context,
                        "approval_wait_seconds",
                        default=float(server.tool_timeout_sec),
                    ),
                    approval_kind="mcp_sampling",
                    approval_details={
                        "model": approval_payload.get("model"),
                        "model_policy": request.get("model_policy") or "current_default",
                        "max_tokens": approval_payload.get("max_tokens"),
                        "audit_detail": approval_payload.get("audit_detail"),
                        "message_count": approval_payload.get("message_count"),
                        "arguments_preview": _sampling_messages_preview(request),
                    },
                )
            )
            return decision.approved

        result = await self.sampling_service.create_message(
            server_id=server.id,
            session_id=session_id,
            messages=_sampling_messages(request),
            requested_model=_optional_string(
                request.get("model") or request.get("requested_model"),
            ),
            max_tokens=_optional_int(request.get("max_tokens")),
            temperature=_optional_float(request.get("temperature")),
            approval_decider=approve_sampling,
            approval_context={"message_count": len(_sampling_messages(request))},
        )
        return _tool_result_with_sampling_result(tool_result, result)

    async def execute_tool(
        self,
        *,
        snapshot_id: str,
        server_id: str,
        raw_tool_name: str,
        arguments: dict[str, Any],
        call_context: Any,
    ) -> ToolExecutionResult:
        started_at = time.perf_counter()
        call_id = _call_context_text(call_context, "tool_call_id") or new_id()
        session_id = _call_context_text(call_context, "session_id")
        allowed: McpAllowedToolExecution | None = None
        try:
            parsed_arguments = _validate_arguments_object(arguments)
            allowed = McpLiveExecutionGuard(
                self.repositories,
                audit_writer=self.audit_writer,
            ).assert_allowed(
                session_id=session_id or "",
                server_id=server_id,
                raw_tool_name=raw_tool_name,
            )
            _validate_arguments_schema(allowed.tool.input_schema, parsed_arguments)
            approval_policy = resolve_mcp_tool_approval_policy(
                self.repositories,
                server_id=server_id,
                tool=allowed.tool,
            )
            approval_request = McpToolApprovalRequest(
                snapshot_id=snapshot_id,
                session_id=session_id or "",
                user_id=_call_context_text(call_context, "user_id") or "",
                server_id=server_id,
                raw_tool_name=raw_tool_name,
                model_name=allowed.model_name,
                approval_mode=approval_policy.approval_mode,
                arguments=parsed_arguments,
                annotations=allowed.tool.annotations or {},
                trace_id=_call_context_text(call_context, "trace_id"),
                turn_index=_call_context_int(call_context, "turn_index"),
                run_id=_call_context_text(call_context, "run_id"),
                tool_call_id=call_id,
                dispatcher=_call_context_dispatcher(call_context),
                wait_seconds=_call_context_float(
                    call_context,
                    "approval_wait_seconds",
                    default=float(self.settings.mcp_default_tool_timeout_sec),
                ),
            )
            decision = await self.approval_decider.decide(approval_request)
            if not decision.approved:
                raise McpRuntimeError(
                    decision.error_code or McpErrorCode.APPROVAL_REJECTED,
                    detail={
                        "approval_reason": decision.reason,
                        "server_id": server_id,
                        "raw_tool_name": raw_tool_name,
                        "call_id": call_id,
                    },
            )
            server = self._load_server(server_id)
            client = await self.get_or_connect_client(server_id)
            self._register_running_call(
                call_id=call_id,
                session_id=session_id,
                snapshot_id=snapshot_id,
                server_id=server_id,
                server_name=server.name,
                raw_tool_name=raw_tool_name,
                model_name=allowed.model_name,
                approval_mode=approval_policy.approval_mode,
            )
            try:
                tool_result = await client.call_tool(
                    raw_tool_name,
                    parsed_arguments,
                    call_id=call_id,
                    timeout_sec=server.tool_timeout_sec,
                )
                tool_result = await self._handle_tool_elicitation_if_requested(
                    tool_result=tool_result,
                    server=server,
                    session_id=session_id,
                    raw_tool_name=raw_tool_name,
                )
                tool_result = await self._handle_tool_sampling_if_requested(
                    tool_result=tool_result,
                    server=server,
                    session_id=session_id,
                    raw_tool_name=raw_tool_name,
                    snapshot_id=snapshot_id,
                    call_id=call_id,
                    call_context=call_context,
                )
            finally:
                self._unregister_running_call(call_id)
            if tool_result.is_error or tool_result.status != "success":
                raise McpRuntimeError(
                    McpErrorCode.PROTOCOL_ERROR,
                    detail={
                        "server_id": server_id,
                        "raw_tool_name": raw_tool_name,
                        "call_id": call_id,
                        "status": tool_result.status,
                        "is_error": tool_result.is_error,
                    },
                )
            artifact_source = normalize_mcp_tool_result_for_artifact(tool_result)
            result_payload = normalize_mcp_tool_result(
                tool_result,
                max_bytes=self.settings.mcp_max_tool_result_bytes,
            )
            duration_ms = _duration_ms(started_at)
            self.repositories.mcp_tools.record_call_result(
                server_id,
                raw_tool_name,
                success=True,
            )
            if session_id:
                self.repositories.mcp_session_tool_usage.record_success(
                    session_id=session_id,
                    server_id=server_id,
                    raw_tool_name=raw_tool_name,
                    model_name=allowed.model_name,
                )
            self._append_tool_audit(
                event_type="tool.called",
                server_id=server_id,
                raw_tool_name=raw_tool_name,
                session_id=session_id,
                call_id=call_id,
                status="completed",
                duration_ms=duration_ms,
                detail={
                    "snapshot_id": snapshot_id,
                    "model_name": allowed.model_name,
                    "approval_mode": approval_policy.approval_mode,
                    "argument_keys": sorted(str(key) for key in parsed_arguments),
                    "result_status": result_payload["status"],
                    "content_items": len(result_payload["content"]),
                    "result_truncated": result_payload["metadata"].get(
                        "result_truncated",
                        False,
                    ),
                    "result_size_bytes": result_payload["metadata"].get(
                        "result_size_bytes",
                    ),
                    "max_result_bytes": result_payload["metadata"].get(
                        "max_result_bytes",
                    ),
                },
            )
            return ToolExecutionResult.success(
                result_payload,
                metadata={
                    INTERNAL_ARTIFACT_SOURCE_KEY: artifact_source,
                    "mcp": {
                        "kind": "mcp_tool",
                        "snapshot_id": snapshot_id,
                        "server_id": server_id,
                        "server_name": server.name,
                        "raw_tool_name": raw_tool_name,
                        "model_name": allowed.model_name,
                        "model_tool_name": allowed.model_name,
                        "approval_mode": approval_policy.approval_mode,
                        "call_id": call_id,
                    }
                },
            )
        except Exception as exc:
            runtime_error = to_mcp_runtime_error(exc)
            duration_ms = _duration_ms(started_at)
            if allowed is not None:
                self.repositories.mcp_tools.record_call_result(
                    server_id,
                    raw_tool_name,
                    success=False,
                )
            self._append_tool_audit(
                event_type="tool.failed",
                server_id=server_id,
                raw_tool_name=raw_tool_name,
                session_id=session_id,
                call_id=call_id,
                status="failed",
                duration_ms=duration_ms,
                detail={
                    "snapshot_id": snapshot_id,
                    "error_code": runtime_error.code.value,
                    "error_detail": runtime_error.detail,
                },
            )
            return ToolExecutionResult.failed(
                ToolExecutionError(
                    runtime_error.message,
                    code=runtime_error.code.value,
                    details=runtime_error.detail,
                ),
                metadata={
                    "mcp": _tool_call_metadata(
                        repositories=self.repositories,
                        snapshot_id=snapshot_id,
                        server_id=server_id,
                        raw_tool_name=raw_tool_name,
                        call_id=call_id,
                        allowed=allowed,
                    )
                },
            )

    async def trigger_auto_refresh(self, server_id: str) -> McpRefreshReport | None:
        return await self._refresh_capabilities_locked(
            server_id,
            cancellation=None,
            skip_if_running=True,
        )

    async def _refresh_capabilities_locked(
        self,
        server_id: str,
        *,
        cancellation: McpCancellationToken | None,
        skip_if_running: bool,
    ) -> McpRefreshReport | None:
        lock = self._refresh_lock(server_id)
        if skip_if_running and lock.locked():
            return None
        async with lock:
            return await self._refresh_capabilities_unlocked(
                server_id,
                cancellation=cancellation,
            )

    async def _refresh_capabilities_unlocked(
        self,
        server_id: str,
        *,
        cancellation: McpCancellationToken | None = None,
    ) -> McpRefreshReport:
        if not self.enabled:
            raise McpRuntimeError(McpErrorCode.MCP_DISABLED)
        server = self._load_server(server_id)
        if not server.enabled:
            self.repositories.mcp_server_status.upsert(server.id, status="disabled")
            raise McpRuntimeError(McpErrorCode.SERVER_DISABLED)
        client = self.client_factory.create_client(server)
        try:
            return await self.discovery_service.refresh_server(
                server=server,
                client=client,
                cancellation=cancellation,
            )
        finally:
            await self._shutdown_client(server_id, client)

    async def shutdown(self) -> None:
        await self.cancel_auto_refresh_tasks()
        async with self._lock:
            cached_clients = list(self._clients.items())
            self._clients.clear()
        for server_id, cached in cached_clients:
            try:
                await cached.client.shutdown(timeout_sec=self._shutdown_timeout(server_id))
                self.repositories.mcp_server_status.upsert(server_id, status="offline")
            except Exception as exc:
                self._record_client_error(server_id, exc)
        self._started = False
        self._runtime_status = "disabled" if not self.enabled else "enabled"

    async def _auto_refresh_loop(self, server_id: str, interval_sec: int) -> None:
        while True:
            await asyncio.sleep(interval_sec)
            try:
                await self.trigger_auto_refresh(server_id)
            except asyncio.CancelledError:
                raise
            except Exception:
                continue

    async def _cancel_auto_refresh_task_locked(self, server_id: str) -> None:
        scheduled = self._refresh_tasks.pop(server_id, None)
        if scheduled is None:
            return
        scheduled.task.cancel()
        with suppress(asyncio.CancelledError):
            await scheduled.task

    def _refresh_lock(self, server_id: str) -> asyncio.Lock:
        lock = self._refresh_locks.get(server_id)
        if lock is None:
            lock = asyncio.Lock()
            self._refresh_locks[server_id] = lock
        return lock

    def _connect_lock(self, server_id: str) -> asyncio.Lock:
        lock = self._connect_locks.get(server_id)
        if lock is None:
            lock = asyncio.Lock()
            self._connect_locks[server_id] = lock
        return lock

    def _load_server(self, server_id: str) -> McpServerRecord:
        server = self.repositories.mcp_servers.get(server_id)
        if server is None:
            raise McpRuntimeError(
                McpErrorCode.SERVER_NOT_FOUND,
                detail={"server_id": server_id},
            )
        return server

    async def _shutdown_cached_client(
        self,
        server_id: str,
        cached: _CachedClient,
        *,
        record_error: bool = False,
    ) -> None:
        await self._shutdown_client(
            server_id,
            cached.client,
            record_error=record_error,
        )

    async def _shutdown_client(
        self,
        server_id: str,
        client: McpClient,
        *,
        record_error: bool = False,
    ) -> None:
        try:
            await client.shutdown(timeout_sec=self._shutdown_timeout(server_id))
        except Exception as exc:
            if record_error:
                self._record_client_error(server_id, exc)
            runtime_error = to_mcp_runtime_error(exc)
            logger.warning(
                "[MCP Manager] client shutdown failed | "
                "server_id={} | error_type={} | error_code={}",
                server_id,
                type(exc).__name__,
                runtime_error.code.value,
            )

    def _shutdown_timeout(self, server_id: str) -> float:
        server = self.repositories.mcp_servers.get(server_id)
        if server is None:
            return float(self.settings.mcp_default_startup_timeout_sec)
        return float(server.shutdown_timeout_sec)

    def _record_client_online(
        self,
        server_id: str,
        init_result: McpClientInitializeResult,
    ) -> None:
        capabilities = {
            "tools": init_result.capabilities.tools,
            "resources_reserved": init_result.capabilities.resources_reserved,
            "sampling": init_result.capabilities.sampling,
            "elicitation": init_result.capabilities.elicitation,
            "raw": init_result.capabilities.raw,
        }
        now = to_iso_z(utc_now())
        self.repositories.mcp_server_status.upsert(
            server_id,
            status="online",
            capabilities=capabilities,
            server_info=init_result.server_info,
            last_connected_at=now,
            last_refresh_at=now,
        )

    def _record_client_error(self, server_id: str, error: BaseException) -> None:
        runtime_error = to_mcp_runtime_error(error)
        status = status_from_mcp_error_code(runtime_error.code)
        detail = dict(runtime_error.detail)
        detail.setdefault("error_type", type(error).__name__)
        self.repositories.mcp_server_status.update_error(
            server_id,
            status=status.value,
            error_code=runtime_error.code.value,
            error_message=runtime_error.message,
            error_detail=detail,
        )

    def _register_running_call(
        self,
        *,
        call_id: str,
        session_id: str | None,
        snapshot_id: str,
        server_id: str,
        server_name: str,
        raw_tool_name: str,
        model_name: str,
        approval_mode: str,
    ) -> None:
        self._running_calls[call_id] = _RunningToolCall(
            call_id=call_id,
            session_id=session_id,
            snapshot_id=snapshot_id,
            server_id=server_id,
            server_name=server_name,
            raw_tool_name=raw_tool_name,
            model_name=model_name,
            approval_mode=approval_mode,
            started_at=to_iso_z(utc_now()),
            started_monotonic=time.perf_counter(),
        )

    def _unregister_running_call(self, call_id: str) -> None:
        self._running_calls.pop(call_id, None)

    def _append_tool_audit(
        self,
        *,
        event_type: str,
        server_id: str,
        raw_tool_name: str,
        session_id: str | None,
        call_id: str,
        status: str,
        duration_ms: int,
        detail: dict[str, Any],
    ) -> None:
        self.audit_writer.append_event(
            event_type=event_type,
            server_id=server_id,
            raw_tool_name=raw_tool_name,
            session_id=session_id,
            call_id=call_id,
            status=status,
            duration_ms=duration_ms,
            summary=f"MCP tool {status}: {raw_tool_name}",
            detail=detail,
        )


def _validate_arguments_object(arguments: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(arguments, dict):
        raise McpRuntimeError(
            McpErrorCode.VALIDATION_ERROR,
            detail={"reason": "arguments_must_be_object"},
        )
    return dict(arguments)


def _validate_arguments_schema(schema: dict[str, Any], arguments: dict[str, Any]) -> None:
    required = schema.get("required")
    if isinstance(required, list):
        missing = [str(key) for key in required if str(key) not in arguments]
        if missing:
            raise McpRuntimeError(
                McpErrorCode.VALIDATION_ERROR,
                detail={"reason": "required_arguments_missing", "missing": missing},
            )
    properties = schema.get("properties")
    if not isinstance(properties, dict):
        return
    for key, value in arguments.items():
        property_schema = properties.get(key)
        if isinstance(property_schema, dict):
            _validate_json_schema_type(key, value, property_schema.get("type"))


def _validate_json_schema_type(key: str, value: Any, schema_type: Any) -> None:
    if schema_type is None:
        return
    expected_types = schema_type if isinstance(schema_type, list) else [schema_type]
    if "null" in expected_types and value is None:
        return
    type_checks = {
        "string": lambda item: isinstance(item, str),
        "number": lambda item: isinstance(item, int | float) and not isinstance(item, bool),
        "integer": lambda item: isinstance(item, int) and not isinstance(item, bool),
        "boolean": lambda item: isinstance(item, bool),
        "object": lambda item: isinstance(item, dict),
        "array": lambda item: isinstance(item, list),
    }
    for expected_type in expected_types:
        checker = type_checks.get(str(expected_type))
        if checker is not None and checker(value):
            return
    raise McpRuntimeError(
        McpErrorCode.VALIDATION_ERROR,
        detail={
            "reason": "argument_type_mismatch",
            "argument": key,
            "expected": [str(item) for item in expected_types],
        },
    )


def _approval_mode_for_tool(
    repositories: StorageRepositories,
    server_id: str,
    raw_tool_name: str,
) -> str:
    policy = repositories.mcp_tool_policies.get(server_id, raw_tool_name)
    if policy is not None and policy.approval_mode != "inherit":
        return policy.approval_mode
    server = repositories.mcp_servers.get(server_id)
    return server.default_tool_approval_mode if server is not None else "auto"


def _tool_call_metadata(
    *,
    repositories: StorageRepositories,
    snapshot_id: str,
    server_id: str,
    raw_tool_name: str,
    call_id: str,
    allowed: McpAllowedToolExecution | None,
) -> dict[str, Any]:
    server = repositories.mcp_servers.get(server_id)
    metadata: dict[str, Any] = {
        "kind": "mcp_tool",
        "snapshot_id": snapshot_id,
        "server_id": server_id,
        "raw_tool_name": raw_tool_name,
        "call_id": call_id,
    }
    if server is not None:
        metadata["server_name"] = server.name
    if allowed is not None:
        approval_policy = resolve_mcp_tool_approval_policy(
            repositories,
            server_id=server_id,
            tool=allowed.tool,
        )
        metadata["model_name"] = allowed.model_name
        metadata["model_tool_name"] = allowed.model_name
        metadata["approval_mode"] = approval_policy.approval_mode
    return metadata


def _extract_elicitation_request(tool_result: Any) -> dict[str, Any] | None:
    for source in (
        getattr(tool_result, "metadata", None),
        getattr(tool_result, "structured_content", None),
    ):
        if not isinstance(source, dict):
            continue
        request = source.get("_keydex_elicitation_request") or source.get("elicitation_request")
        if isinstance(request, dict) and request.get("trigger") is True:
            return dict(request)
    return None


def _extract_sampling_request(tool_result: Any) -> dict[str, Any] | None:
    for source in (
        getattr(tool_result, "metadata", None),
        getattr(tool_result, "structured_content", None),
    ):
        if not isinstance(source, dict):
            continue
        request = source.get("_keydex_sampling_request") or source.get("sampling_request")
        if isinstance(request, dict) and request.get("trigger") is True:
            return dict(request)
    return None


def _elicitation_schema(request: dict[str, Any]) -> dict[str, Any]:
    schema = request.get("schema")
    resolved = dict(schema) if isinstance(schema, dict) else {"type": "object"}
    description = _optional_string(request.get("description"))
    if description and "description" not in resolved:
        resolved["description"] = description
    return resolved


def _tool_result_with_elicitation_values(
    tool_result: Any,
    elicitation_result: dict[str, Any],
) -> McpClientToolResult:
    values = elicitation_result.get("values")
    safe_values = dict(values) if isinstance(values, dict) else {}
    structured_content = getattr(tool_result, "structured_content", None)
    next_structured = dict(structured_content) if isinstance(structured_content, dict) else {}
    next_structured["elicitation"] = {
        "status": elicitation_result.get("status"),
        "elicitation_id": elicitation_result.get("elicitation_id"),
        "values": safe_values,
    }
    metadata = dict(getattr(tool_result, "metadata", {}) or {})
    metadata["elicitation"] = {
        "status": elicitation_result.get("status"),
        "elicitation_id": elicitation_result.get("elicitation_id"),
        "value_keys": sorted(str(key) for key in safe_values),
    }
    content = list(getattr(tool_result, "content", []) or [])
    content.append(
        {
            "type": "text",
            "text": "MCP elicitation submitted; fields: "
            + (", ".join(sorted(str(key) for key in safe_values)) or "none"),
        }
    )
    return McpClientToolResult(
        call_id=str(getattr(tool_result, "call_id", "")),
        status="success",
        content=content,
        structured_content=next_structured,
        is_error=False,
        metadata=metadata,
    )


def _sampling_messages(request: dict[str, Any]) -> list[dict[str, Any]]:
    messages = request.get("messages")
    if not isinstance(messages, list):
        return []
    return [dict(message) for message in messages if isinstance(message, dict)]


def _sampling_messages_preview(request: dict[str, Any]) -> dict[str, Any]:
    messages = _sampling_messages(request)
    return {
        "message_count": len(messages),
        "roles": [str(message.get("role") or "") for message in messages[:5]],
        "preview": [
            str(message.get("content") or "")[:300]
            for message in messages[:3]
            if message.get("content") is not None
        ],
    }


def _tool_result_with_sampling_result(
    tool_result: Any,
    sampling_result: dict[str, Any],
) -> McpClientToolResult:
    result = sampling_result.get("result")
    safe_result = dict(result) if isinstance(result, dict) else {}
    structured_content = getattr(tool_result, "structured_content", None)
    next_structured = dict(structured_content) if isinstance(structured_content, dict) else {}
    next_structured["sampling"] = {
        "server_id": sampling_result.get("server_id"),
        "provider_id": sampling_result.get("provider_id"),
        "model": sampling_result.get("model"),
        "max_tokens": sampling_result.get("max_tokens"),
        "result": safe_result,
    }
    metadata = dict(getattr(tool_result, "metadata", {}) or {})
    metadata["sampling"] = {
        "server_id": sampling_result.get("server_id"),
        "model": sampling_result.get("model"),
        "max_tokens": sampling_result.get("max_tokens"),
        "result_keys": sorted(str(key) for key in safe_result),
    }
    content_text = str(safe_result.get("content") or "").strip()
    content = list(getattr(tool_result, "content", []) or [])
    content.append(
        {
            "type": "text",
            "text": "MCP sampling completed; model: "
            + str(sampling_result.get("model") or "")
            + (f"; content: {content_text}" if content_text else ""),
        }
    )
    return McpClientToolResult(
        call_id=str(getattr(tool_result, "call_id", "")),
        status="success",
        content=content,
        structured_content=next_structured,
        is_error=False,
        metadata=metadata,
    )


def _string_or_default(value: Any, default: str) -> str:
    return value if isinstance(value, str) and value.strip() else default


def _optional_string(value: Any) -> str | None:
    return value if isinstance(value, str) and value.strip() else None


def _optional_int(value: Any) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _optional_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _call_context_text(call_context: Any, key: str) -> str | None:
    value = getattr(call_context, key, None)
    if value is None:
        return None
    normalized = str(value).strip()
    return normalized or None


def _call_context_int(call_context: Any, key: str) -> int | None:
    value = getattr(call_context, key, None)
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _call_context_float(call_context: Any, key: str, *, default: float) -> float:
    metadata = getattr(call_context, "metadata", None)
    value = metadata.get(key) if isinstance(metadata, dict) else None
    if value is None:
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _call_context_dispatcher(call_context: Any) -> Any:
    metadata = getattr(call_context, "metadata", None)
    return metadata.get("dispatcher") if isinstance(metadata, dict) else None


def _duration_ms(started_at: float) -> int:
    return max(0, int((time.perf_counter() - started_at) * 1000))
