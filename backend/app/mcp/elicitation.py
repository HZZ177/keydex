from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any

from backend.app.core.ids import new_id
from backend.app.core.time import to_iso_z, utc_now
from backend.app.mcp.audit import McpAuditWriter, redact_sensitive_data
from backend.app.storage import StorageRepositories

McpElicitationBroadcaster = Callable[[str, str, dict[str, Any]], Awaitable[bool]]


class McpElicitationError(ValueError):
    pass


@dataclass(frozen=True)
class McpElicitationResult:
    elicitation_id: str
    status: str
    values: dict[str, Any] | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "elicitation_id": self.elicitation_id,
            "status": self.status,
            "values": redact_sensitive_data(self.values or {}),
        }


@dataclass
class _PendingElicitation:
    id: str
    session_id: str
    server_id: str
    server_name: str | None
    raw_tool_name: str | None
    title: str
    schema: dict[str, Any]
    created_at: str
    future: asyncio.Future[McpElicitationResult]

    def payload(self) -> dict[str, Any]:
        return {
            "elicitation_id": self.id,
            "id": self.id,
            "session_id": self.session_id,
            "server_id": self.server_id,
            "server_name": self.server_name,
            "raw_tool_name": self.raw_tool_name,
            "title": self.title,
            "schema": self.schema,
            "created_at": self.created_at,
        }


class McpElicitationService:
    def __init__(
        self,
        repositories: StorageRepositories,
        *,
        broadcaster: McpElicitationBroadcaster | None = None,
    ) -> None:
        self.repositories = repositories
        self.audit_writer = McpAuditWriter.from_repositories(repositories)
        self.broadcaster = broadcaster
        self._pending: dict[str, _PendingElicitation] = {}

    async def request(
        self,
        *,
        session_id: str,
        server_id: str,
        raw_tool_name: str | None,
        title: str,
        schema: dict[str, Any],
        timeout_sec: float = 300,
        elicitation_id: str | None = None,
    ) -> McpElicitationResult:
        pending = self._create_pending(
            session_id=session_id,
            server_id=server_id,
            raw_tool_name=raw_tool_name,
            title=title,
            schema=schema,
            elicitation_id=elicitation_id,
        )
        await self._broadcast(
            session_id,
            "mcp_elicitation_requested",
            {"elicitation": pending.payload()},
        )
        self.audit_writer.append_event(
            event_type="elicitation.requested",
            server_id=server_id,
            raw_tool_name=raw_tool_name,
            session_id=session_id,
            status="pending",
            summary=f"MCP elicitation requested: {title}",
            detail={"elicitation_id": pending.id, "schema": schema},
        )
        try:
            return await asyncio.wait_for(pending.future, timeout=timeout_sec)
        except TimeoutError:
            return await self.timeout(pending.id)

    async def resolve(
        self,
        elicitation_id: str,
        *,
        values: dict[str, Any] | None = None,
        cancelled: bool = False,
        user_id: str | None = None,
    ) -> McpElicitationResult:
        pending = self._require_pending(elicitation_id)
        result = McpElicitationResult(
            elicitation_id=elicitation_id,
            status="cancelled" if cancelled else "submitted",
            values=None if cancelled else dict(values or {}),
        )
        self._complete(pending, result)
        await self._broadcast_resolved(pending, result)
        self.audit_writer.append_event(
            event_type="elicitation.resolved",
            server_id=pending.server_id,
            raw_tool_name=pending.raw_tool_name,
            session_id=pending.session_id,
            actor=user_id,
            status=result.status,
            summary=f"MCP elicitation {result.status}: {pending.title}",
            detail={
                "elicitation_id": pending.id,
                "value_keys": sorted((values or {}).keys()),
            },
        )
        return result

    async def timeout(self, elicitation_id: str) -> McpElicitationResult:
        pending = self._require_pending(elicitation_id)
        result = McpElicitationResult(elicitation_id=elicitation_id, status="timeout")
        self._complete(pending, result)
        await self._broadcast_resolved(pending, result)
        self.audit_writer.append_event(
            event_type="elicitation.timeout",
            server_id=pending.server_id,
            raw_tool_name=pending.raw_tool_name,
            session_id=pending.session_id,
            status="timeout",
            summary=f"MCP elicitation timed out: {pending.title}",
            detail={"elicitation_id": pending.id},
        )
        return result

    def pending_payload(self, elicitation_id: str) -> dict[str, Any]:
        return self._require_pending(elicitation_id).payload()

    def _create_pending(
        self,
        *,
        session_id: str,
        server_id: str,
        raw_tool_name: str | None,
        title: str,
        schema: dict[str, Any],
        elicitation_id: str | None,
    ) -> _PendingElicitation:
        server = self.repositories.mcp_servers.get(server_id)
        pending_id = elicitation_id or new_id()
        if pending_id in self._pending:
            raise McpElicitationError("MCP elicitation id 已存在")
        loop = asyncio.get_running_loop()
        pending = _PendingElicitation(
            id=pending_id,
            session_id=session_id,
            server_id=server_id,
            server_name=server.name if server is not None else None,
            raw_tool_name=raw_tool_name,
            title=title,
            schema=dict(schema),
            created_at=to_iso_z(utc_now()),
            future=loop.create_future(),
        )
        self._pending[pending_id] = pending
        return pending

    def _require_pending(self, elicitation_id: str) -> _PendingElicitation:
        pending = self._pending.get(elicitation_id)
        if pending is None:
            raise McpElicitationError("MCP elicitation 不存在或已结束")
        return pending

    def _complete(
        self,
        pending: _PendingElicitation,
        result: McpElicitationResult,
    ) -> None:
        self._pending.pop(pending.id, None)
        if not pending.future.done():
            pending.future.set_result(result)

    async def _broadcast_resolved(
        self,
        pending: _PendingElicitation,
        result: McpElicitationResult,
    ) -> None:
        await self._broadcast(
            pending.session_id,
            "mcp_elicitation_resolved",
            {"elicitation": {**pending.payload(), **result.to_dict()}},
        )

    async def _broadcast(
        self,
        session_id: str,
        action: str,
        data: dict[str, Any],
    ) -> None:
        if self.broadcaster is not None:
            await self.broadcaster(session_id, action, data)
