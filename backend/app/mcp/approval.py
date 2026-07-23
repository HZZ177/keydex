from __future__ import annotations

import asyncio
import hashlib
import json
from dataclasses import dataclass, field
from typing import Any, Protocol

from backend.app.command_approval import approval_to_payload
from backend.app.core.ids import new_id
from backend.app.events import DomainEventType, EventDispatcher
from backend.app.mcp.audit import McpAuditWriter, redact_sensitive_data
from backend.app.mcp.types import McpErrorCode
from backend.app.storage import StorageRepositories

DEFAULT_MCP_APPROVAL_WAIT_SECONDS = 24 * 60 * 60


@dataclass(frozen=True)
class McpToolApprovalRequest:
    snapshot_id: str
    session_id: str
    user_id: str
    server_id: str
    raw_tool_name: str
    model_name: str
    approval_mode: str
    arguments: dict[str, Any]
    annotations: dict[str, Any] = field(default_factory=dict)
    trace_id: str | None = None
    turn_index: int | None = None
    run_id: str | None = None
    tool_call_id: str | None = None
    dispatcher: EventDispatcher | None = None
    wait_seconds: float = DEFAULT_MCP_APPROVAL_WAIT_SECONDS
    approval_kind: str = "mcp_tool_call"
    approval_title: str | None = None
    approval_description: str | None = None
    approval_details: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class McpToolApprovalDecision:
    approved: bool
    reason: str
    error_code: McpErrorCode | None = None


class McpToolApprovalDecider(Protocol):
    async def decide(
        self,
        request: McpToolApprovalRequest,
    ) -> McpToolApprovalDecision: ...


class DefaultMcpToolApprovalDecider:
    async def decide(
        self,
        request: McpToolApprovalRequest,
    ) -> McpToolApprovalDecision:
        mode = request.approval_mode
        if mode == "deny":
            return McpToolApprovalDecision(
                approved=False,
                reason="policy_denied",
                error_code=McpErrorCode.POLICY_DENIED,
            )
        if mode == "prompt":
            return McpToolApprovalDecision(
                approved=False,
                reason="approval_required",
                error_code=McpErrorCode.APPROVAL_REQUIRED,
            )
        if mode == "approve":
            return McpToolApprovalDecision(approved=True, reason="explicit_approve")
        if mode == "auto":
            return McpToolApprovalDecision(approved=True, reason="auto_approved")
        return McpToolApprovalDecision(
            approved=False,
            reason="unknown_approval_mode",
            error_code=McpErrorCode.POLICY_DENIED,
        )


class McpApprovalService:
    def __init__(
        self,
        repositories: StorageRepositories,
        *,
        base_decider: McpToolApprovalDecider | None = None,
    ) -> None:
        self.repositories = repositories
        self.base_decider = base_decider or DefaultMcpToolApprovalDecider()

    async def decide(
        self,
        request: McpToolApprovalRequest,
    ) -> McpToolApprovalDecision:
        from backend.app.mcp.trust import find_mcp_trust_rule_match, record_mcp_trust_hit

        trust_match = find_mcp_trust_rule_match(self.repositories, request)
        if trust_match is not None:
            record_mcp_trust_hit(self.repositories, request, trust_match)
            if trust_match.approval_mode == "deny":
                return McpToolApprovalDecision(
                    approved=False,
                    reason=trust_match.reason,
                    error_code=McpErrorCode.POLICY_DENIED,
                )
            return McpToolApprovalDecision(approved=True, reason=trust_match.reason)
        base_decision = await self.base_decider.decide(request)
        if base_decision.approved:
            return base_decision
        if base_decision.error_code != McpErrorCode.APPROVAL_REQUIRED:
            return base_decision

        record = self.repositories.command_approvals.create(
            approval_id=new_id(),
            session_id=request.session_id,
            trace_id=request.trace_id,
            turn_index=request.turn_index,
            run_id=request.run_id or request.tool_call_id,
            command=request.model_name,
            cwd=".",
            shell="mcp",
            workspace_root="",
            tool_name=request.model_name,
            kind=_approval_kind(request),
            title=request.approval_title or _approval_title(self.repositories, request),
            description=request.approval_description or _approval_description(request),
            details=_approval_details(self.repositories, request),
        )
        _append_approval_audit(
            self.repositories,
            "approval.requested",
            record,
            request,
            actor="system",
            status="pending",
        )
        self.repositories.sessions.update(request.session_id, status="waiting_approval")
        await self._emit(DomainEventType.APPROVAL_REQUESTED, record, request)
        resolved = await self._wait_for_decision(record.id, request)
        _append_approval_audit(
            self.repositories,
            "approval.resolved",
            resolved,
            request,
            actor="user",
            status=resolved.status,
        )
        await self._emit(DomainEventType.APPROVAL_RESOLVED, resolved, request)
        if resolved.status == "approved" and resolved.decision == "approved":
            return McpToolApprovalDecision(
                approved=True,
                reason=f"approval:{resolved.trust_scope or 'once'}",
            )
        return McpToolApprovalDecision(
            approved=False,
            reason=resolved.reject_message or resolved.status or "approval_rejected",
            error_code=McpErrorCode.APPROVAL_REJECTED,
        )

    async def _wait_for_decision(
        self,
        approval_id: str,
        request: McpToolApprovalRequest,
    ):
        started_at = asyncio.get_running_loop().time()
        while True:
            record = self.repositories.command_approvals.get(approval_id)
            if record is None:
                return _decision_missing()
            if record.status != "pending":
                self.repositories.sessions.update(record.session_id, status="running")
                return record
            if asyncio.get_running_loop().time() - started_at > request.wait_seconds:
                resolved, transitioned = self.repositories.command_approvals.resolve_pending(
                    approval_id,
                    status="expired",
                    decision="rejected",
                    reject_message="MCP 审批等待超时",
                )
                if resolved is None:
                    return _decision_missing()
                if transitioned:
                    self.repositories.command_approval_audit.create(
                        audit_id=new_id(),
                        approval_id=resolved.id,
                        session_id=resolved.session_id,
                        command=resolved.command,
                        cwd=resolved.cwd,
                        decision="rejected",
                        trust_scope="once",
                        reject_message="MCP 审批等待超时",
                        metadata={
                            "source": "mcp_approval_timeout",
                            "mcp": _mcp_metadata(resolved),
                        },
                    )
                self.repositories.sessions.update(resolved.session_id, status="running")
                return resolved
            await asyncio.sleep(0.15)

    async def _emit(
        self,
        event_type: DomainEventType,
        record: Any,
        request: McpToolApprovalRequest,
    ) -> None:
        if request.dispatcher is None:
            return
        await request.dispatcher.emit_event(
            event_type=event_type.value,
            source="mcp_approval",
            payload={
                "id": record.id,
                "approval_id": record.id,
                "approval": approval_to_payload(record),
                "session_id": record.session_id,
            },
            trace_id=record.trace_id,
            user_id=request.user_id,
            original_session_id=record.session_id,
            active_session_id=record.session_id,
            run_id=record.run_id,
            turn_index=record.turn_index,
        )


def _decision_missing():
    raise RuntimeError("MCP approval request disappeared")


def _approval_title(
    repositories: StorageRepositories,
    request: McpToolApprovalRequest,
) -> str:
    server = repositories.mcp_servers.get(request.server_id)
    server_name = server.name if server is not None else request.server_id
    if _approval_kind(request) == "mcp_sampling":
        return f"是否允许 {server_name} MCP Sampling？"
    return f"允许 {server_name} MCP 执行 {request.raw_tool_name}？"


def _approval_description(request: McpToolApprovalRequest) -> str:
    if _approval_kind(request) == "mcp_sampling":
        return "MCP server 请求 Keydex 使用当前默认模型生成内容，需要你确认后继续。"
    return "MCP 工具请求执行，需要你确认后继续。"


def _approval_details(
    repositories: StorageRepositories,
    request: McpToolApprovalRequest,
) -> dict[str, Any]:
    server = repositories.mcp_servers.get(request.server_id)
    if _approval_kind(request) == "mcp_sampling":
        details = dict(request.approval_details)
        return {
            **details,
            "approval_kind": "mcp_sampling",
            "server_id": request.server_id,
            "server_name": server.name if server is not None else request.server_id,
            "raw_tool_name": request.raw_tool_name,
            "model": details.get("model") or request.model_name,
            "model_policy": details.get("model_policy") or "current_default",
            "max_tokens": details.get("max_tokens"),
            "approval_mode": request.approval_mode,
            "audit_detail": details.get("audit_detail"),
            "message_count": details.get("message_count"),
            "arguments_preview": details.get("arguments_preview"),
            "call_id": request.tool_call_id,
            "run_id": request.run_id,
        }
    return {
        "approval_kind": "mcp_tool_call",
        "snapshot_id": request.snapshot_id,
        "server_id": request.server_id,
        "server_name": server.name if server is not None else request.server_id,
        "raw_tool_name": request.raw_tool_name,
        "tool_name": request.raw_tool_name,
        "model_tool_name": request.model_name,
        "approval_mode": request.approval_mode,
        "display_title": _approval_title(repositories, request),
        "call_id": request.tool_call_id,
        "run_id": request.run_id,
        "arguments_preview": _arguments_preview(request.arguments),
        "trust_options": ["once", "session", "persistent_tool", "persistent_server"],
        "matched_rule": None,
    }


def _arguments_preview(arguments: dict[str, Any]) -> dict[str, Any]:
    redacted = redact_sensitive_data(arguments)
    payload = json.dumps(redacted, ensure_ascii=False, sort_keys=True, default=repr)
    if len(payload) <= 2_000:
        return redacted
    return {
        "truncated": True,
        "preview": payload[:2_000],
        "keys": sorted(str(key) for key in arguments),
    }


def _mcp_metadata(record: Any) -> dict[str, Any]:
    details = dict(getattr(record, "details", {}) or {})
    if details.get("approval_kind") == "mcp_sampling":
        return {
            key: value
            for key, value in {
                "kind": "mcp_sampling",
                "server_id": details.get("server_id"),
                "server_name": details.get("server_name"),
                "raw_tool_name": details.get("raw_tool_name"),
                "model": details.get("model"),
                "max_tokens": details.get("max_tokens"),
                "approval_mode": details.get("approval_mode"),
                "call_id": details.get("call_id"),
            }.items()
            if value not in {None, ""}
        }
    return {
        key: value
        for key, value in {
            "kind": "mcp_tool",
            "snapshot_id": details.get("snapshot_id"),
            "server_id": details.get("server_id"),
            "server_name": details.get("server_name"),
            "raw_tool_name": details.get("raw_tool_name"),
            "model_tool_name": details.get("model_tool_name"),
            "model_name": details.get("model_tool_name"),
            "approval_mode": details.get("approval_mode"),
            "call_id": details.get("call_id"),
        }.items()
        if value not in {None, ""}
    }


def _append_approval_audit(
    repositories: StorageRepositories,
    event_type: str,
    record: Any,
    request: McpToolApprovalRequest,
    *,
    actor: str,
    status: str,
) -> None:
    details = dict(getattr(record, "details", {}) or {})
    McpAuditWriter.from_repositories(repositories).append_event(
        event_type=event_type,
        server_id=details.get("server_id") or request.server_id,
        raw_tool_name=details.get("raw_tool_name") or request.raw_tool_name,
        session_id=record.session_id,
        call_id=details.get("call_id") or request.tool_call_id,
        approval_id=record.id,
        actor=actor,
        status=status,
        summary=f"MCP approval {event_type.rsplit('.', 1)[-1]}: {request.raw_tool_name}",
        detail={
            "approval_kind": details.get("approval_kind") or request.approval_kind,
            "approval_id": record.id,
            "decision": getattr(record, "decision", None),
            "trust_scope": getattr(record, "trust_scope", None),
            "reject_message": getattr(record, "reject_message", None),
            "approval_mode": details.get("approval_mode") or request.approval_mode,
        },
    )


def stable_schema_hash(schema: dict[str, Any]) -> str:
    payload = json.dumps(
        schema,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        default=repr,
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _approval_kind(request: McpToolApprovalRequest) -> str:
    return "mcp_sampling" if request.approval_kind == "mcp_sampling" else "mcp_tool_call"
