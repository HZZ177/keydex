from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, field_validator

from backend.app.core.ids import new_id
from backend.app.events import DomainEventType, EventDispatcher
from backend.app.security import normalize_workspace_root_for_storage
from backend.app.storage import (
    CommandApprovalAuditRecord,
    CommandApprovalRequestRecord,
    StorageRepositories,
    TrustedCommandRuleRecord,
)
from backend.app.tools.command_runtime.models import (
    CommandSettings,
)
from backend.app.tools.command_runtime.models import (
    FileAccessMode as FileAccessMode,
)

COMMAND_SETTINGS_KEY = "command_settings"
DEFAULT_APPROVAL_WAIT_SECONDS = 24 * 60 * 60
BROAD_PREFIX_COMMANDS = {"powershell", "pwsh", "cmd", "python", "node", "npm", "pnpm", "git"}


class CommandApprovalDecision(BaseModel):
    decision: Literal["approved", "rejected"]
    trust_scope: Literal[
        "once",
        "persistent",
        "session",
        "persistent_tool",
        "server_readonly",
    ] = "once"
    rule_match_type: Literal["exact", "prefix"] | None = None
    reject_message: str = ""

    @field_validator("reject_message")
    @classmethod
    def _trim_reject_message(cls, value: str) -> str:
        return value.strip()[:1000]


@dataclass(frozen=True)
class TrustedCommandMatch:
    rule: TrustedCommandRuleRecord
    reason: str = "trusted_rule"


class CommandApprovalError(ValueError):
    pass


def load_command_settings(repositories: StorageRepositories) -> CommandSettings:
    raw = repositories.settings.get(COMMAND_SETTINGS_KEY, default={})
    return CommandSettings(**(raw if isinstance(raw, dict) else {}))


def save_command_settings(
    repositories: StorageRepositories,
    settings: CommandSettings,
) -> CommandSettings:
    repositories.settings.set(COMMAND_SETTINGS_KEY, settings.model_dump(mode="json"))
    return settings


def normalize_command(command: str) -> str:
    return " ".join(command.strip().split())


def normalize_cwd(cwd: str | Path) -> str:
    text = str(cwd or ".").strip().replace("\\", "/").strip("/")
    return text or "."


def normalized_workspace_root(root: str | Path) -> str:
    return normalize_workspace_root_for_storage(root) if str(root).strip() else ""


def validate_persistent_rule(command_pattern: str, match_type: str) -> None:
    normalized = normalize_command(command_pattern)
    if match_type not in {"exact", "prefix"}:
        raise CommandApprovalError("命令信任规则仅支持 exact 或 prefix")
    if not normalized:
        raise CommandApprovalError("命令信任规则不能为空")
    if match_type != "prefix":
        return
    parts = normalized.lower().split()
    if len(normalized) < 8 or len(parts) < 2:
        raise CommandApprovalError("前缀信任规则过短，不能保存")
    if parts[0] in BROAD_PREFIX_COMMANDS and len(parts) == 1:
        raise CommandApprovalError("前缀信任规则过宽，不能保存")
    if normalized.lower() in BROAD_PREFIX_COMMANDS:
        raise CommandApprovalError("前缀信任规则过宽，不能保存")


def find_trusted_command_rule(
    repositories: StorageRepositories,
    *,
    command: str,
    cwd: str,
    shell: str,
    shell_path: str,
    tool_name: str,
    workspace_root: str,
) -> TrustedCommandMatch | None:
    normalized = normalize_command(command)
    normalized_cwd = normalize_cwd(cwd)
    normalized_root = normalized_workspace_root(workspace_root)
    normalized_shell_path = str(Path(shell_path).expanduser().resolve()) if shell_path else ""
    for rule in repositories.trusted_command_rules.list(include_disabled=False):
        if rule.tool_name != tool_name:
            continue
        if rule.shell != shell:
            continue
        if rule.shell_path != normalized_shell_path:
            continue
        if rule.workspace_root and rule.workspace_root != normalized_root:
            continue
        if normalize_cwd(rule.cwd_pattern) != normalized_cwd:
            continue
        if rule.match_type == "exact" and normalized == rule.normalized_command:
            repositories.trusted_command_rules.touch_last_used(rule.id)
            return TrustedCommandMatch(rule)
        if rule.match_type == "prefix" and normalized.startswith(rule.normalized_command):
            repositories.trusted_command_rules.touch_last_used(rule.id)
            return TrustedCommandMatch(rule)
    return None


def approval_to_payload(record: CommandApprovalRequestRecord) -> dict[str, Any]:
    details = dict(record.details or {})
    details.setdefault("command", record.command)
    details.setdefault("cwd", record.cwd)
    details.setdefault("shell", record.shell)
    details.setdefault("workspace_root", record.workspace_root)
    payload: dict[str, Any] = {
        "id": record.id,
        "session_id": record.session_id,
        "thread_id": record.session_id,
        "turn_id": str(record.turn_index or ""),
        "item_id": record.run_id or record.id,
        "call_id": record.run_id or record.id,
        "run_id": record.run_id,
        "tool_name": record.tool_name,
        "kind": record.kind,
        "title": record.title,
        "description": record.description,
        "details": details,
        "status": record.status,
        "decision": record.decision,
        "trust_scope": record.trust_scope,
        "rule_match_type": record.rule_match_type,
        "reject_message": record.reject_message,
        "trusted_rule_id": record.trusted_rule_id,
        "created_at": record.created_at,
        "resolved_at": record.resolved_at,
    }
    if record.kind == "mcp_tool_call":
        mcp = _mcp_approval_metadata(record)
        payload.update(
            {
                "approval_kind": "mcp_tool_call",
                "display_title": record.title,
                "server_id": mcp.get("server_id"),
                "server_name": mcp.get("server_name"),
                "raw_tool_name": mcp.get("raw_tool_name"),
                "model_tool_name": mcp.get("model_tool_name"),
                "risk_level": mcp.get("risk_level"),
                "risk_reasons": details.get("risk_reasons") or [],
                "snapshot_id": mcp.get("snapshot_id"),
                "approval_mode": mcp.get("approval_mode"),
                "arguments_preview": details.get("arguments_preview"),
                "trust_options": details.get("trust_options") or [],
                "matched_rule": details.get("matched_rule"),
                "metadata": {"mcp": mcp},
            }
        )
    if record.kind == "mcp_sampling":
        mcp = _mcp_sampling_metadata(record)
        payload.update(
            {
                "approval_kind": "mcp_sampling",
                "display_title": record.title,
                "server_id": mcp.get("server_id"),
                "server_name": mcp.get("server_name"),
                "raw_tool_name": mcp.get("raw_tool_name"),
                "model": mcp.get("model"),
                "max_tokens": mcp.get("max_tokens"),
                "approval_mode": mcp.get("approval_mode"),
                "risk_level": details.get("risk_level"),
                "risk_reasons": details.get("risk_reasons") or [],
                "arguments_preview": details.get("arguments_preview"),
                "metadata": {"mcp": mcp},
            }
        )
    return payload


def rule_to_payload(record: TrustedCommandRuleRecord) -> dict[str, Any]:
    return {
        "id": record.id,
        "command_pattern": record.command_pattern,
        "normalized_command": record.normalized_command,
        "match_type": record.match_type,
        "tool_name": record.tool_name,
        "shell": record.shell,
        "shell_path": record.shell_path,
        "workspace_root": record.workspace_root,
        "cwd_pattern": record.cwd_pattern,
        "enabled": record.enabled,
        "created_from_approval_id": record.created_from_approval_id,
        "created_at": record.created_at,
        "updated_at": record.updated_at,
        "last_used_at": record.last_used_at,
    }


def audit_to_payload(record: CommandApprovalAuditRecord) -> dict[str, Any]:
    return {
        "id": record.id,
        "approval_id": record.approval_id,
        "session_id": record.session_id,
        "command": record.command,
        "cwd": record.cwd,
        "decision": record.decision,
        "trust_scope": record.trust_scope,
        "rule_match_type": record.rule_match_type,
        "trusted_rule_id": record.trusted_rule_id,
        "reject_message": record.reject_message,
        "metadata": record.metadata or {},
        "created_at": record.created_at,
    }


class ApprovalService:
    def __init__(
        self,
        *,
        repositories: StorageRepositories,
        dispatcher: EventDispatcher | None = None,
    ) -> None:
        self.repositories = repositories
        self.dispatcher = dispatcher

    async def create_request(
        self,
        *,
        session_id: str,
        user_id: str,
        command: str,
        cwd: str,
        shell: str,
        workspace_root: str,
        trace_id: str | None,
        turn_index: int,
        shell_path: str = "",
        tool_name: str = "",
        run_id: str | None = None,
        details: dict[str, Any] | None = None,
    ) -> CommandApprovalRequestRecord:
        approval_id = new_id()
        normalized_root = normalized_workspace_root(workspace_root)
        normalized_current_dir = normalize_cwd(cwd)
        record = self.repositories.command_approvals.create(
            approval_id=approval_id,
            session_id=session_id,
            trace_id=trace_id,
            turn_index=turn_index,
            run_id=run_id,
            command=command,
            cwd=normalized_current_dir,
            shell=shell,
            workspace_root=normalized_root,
            tool_name=tool_name or "command",
            title="是否允许执行命令？",
            description="命令将在当前工作区的已配置命令环境中执行。",
            details={
                "command": command,
                "cwd": normalized_current_dir,
                "shell": shell,
                "shell_path": shell_path,
                "tool": tool_name,
                "tool_name": tool_name,
                "workspace_root": str(workspace_root),
                "suggested_exact_rule": normalize_command(command),
                "suggested_prefix_rule": normalize_command(command),
                **(details or {}),
            },
        )
        self.repositories.sessions.update(session_id, status="waiting_approval")
        await self._emit(
            DomainEventType.APPROVAL_REQUESTED,
            record=record,
            user_id=user_id,
        )
        return record

    async def wait_for_decision(
        self,
        approval_id: str,
        *,
        user_id: str,
        wait_seconds: float = DEFAULT_APPROVAL_WAIT_SECONDS,
        poll_interval_seconds: float = 0.15,
    ) -> CommandApprovalRequestRecord:
        started_at = time.perf_counter()
        while True:
            record = self.repositories.command_approvals.get(approval_id)
            if record is None:
                raise CommandApprovalError("审批请求不存在")
            if record.status != "pending":
                self.repositories.sessions.update(record.session_id, status="running")
                await self._emit(DomainEventType.APPROVAL_RESOLVED, record=record, user_id=user_id)
                return record
            if time.perf_counter() - started_at > wait_seconds:
                resolved = self.repositories.command_approvals.resolve(
                    approval_id,
                    status="expired",
                    decision="rejected",
                    reject_message="审批等待超时",
                )
                if resolved is None:
                    raise CommandApprovalError("审批请求不存在")
                self.repositories.command_approval_audit.create(
                    audit_id=new_id(),
                    approval_id=resolved.id,
                    session_id=resolved.session_id,
                    command=resolved.command,
                    cwd=resolved.cwd,
                    decision="rejected",
                    reject_message="审批等待超时",
                )
                self.repositories.sessions.update(resolved.session_id, status="running")
                await self._emit(
                    DomainEventType.APPROVAL_RESOLVED,
                    record=resolved,
                    user_id=user_id,
                )
                return resolved
            await asyncio.sleep(poll_interval_seconds)

    async def resolve(
        self,
        approval_id: str,
        decision: CommandApprovalDecision,
        *,
        settings: CommandSettings | None = None,
        user_id: str | None = None,
    ) -> CommandApprovalRequestRecord:
        record = self.repositories.command_approvals.get(approval_id)
        if record is None:
            raise CommandApprovalError("审批请求不存在")
        if record.status != "pending":
            raise CommandApprovalError("审批请求已经处理")
        _validate_decision_scope(record, decision)
        mcp_trust_rule_plan = _mcp_trust_rule_plan(self.repositories, record, decision)

        command_settings = settings or load_command_settings(self.repositories)
        trusted_rule_id: str | None = None
        rule_match_type = decision.rule_match_type
        if (
            record.kind != "mcp_tool_call"
            and decision.decision == "approved"
            and decision.trust_scope == "persistent"
        ):
            if not command_settings.allow_persistent_trust:
                raise CommandApprovalError("当前配置不允许保存已信任命令")
            resolved_match_type = rule_match_type or "exact"
            validate_persistent_rule(record.command, resolved_match_type)
            trusted_rule = self.repositories.trusted_command_rules.create(
                rule_id=new_id(),
                command_pattern=normalize_command(record.command),
                normalized_command=normalize_command(record.command),
                match_type=resolved_match_type,
                tool_name=record.tool_name,
                shell=record.shell,
                shell_path=str(
                    Path(str(record.details.get("shell_path") or "")).expanduser().resolve()
                )
                if str(record.details.get("shell_path") or "").strip()
                else "",
                workspace_root=record.workspace_root,
                cwd_pattern=record.cwd,
                created_from_approval_id=record.id,
            )
            trusted_rule_id = trusted_rule.id
            rule_match_type = resolved_match_type

        status = "approved" if decision.decision == "approved" else "rejected"
        resolved = self.repositories.command_approvals.resolve(
            approval_id,
            status=status,
            decision=decision.decision,
            trust_scope=decision.trust_scope,
            rule_match_type=rule_match_type,
            reject_message=decision.reject_message if decision.decision == "rejected" else "",
            trusted_rule_id=trusted_rule_id,
        )
        if resolved is None:
            raise CommandApprovalError("审批请求不存在")
        mcp_trust_rule_id = _create_mcp_trust_rule(
            self.repositories,
            resolved,
            mcp_trust_rule_plan,
        )
        self.repositories.command_approval_audit.create(
            audit_id=new_id(),
            approval_id=resolved.id,
            session_id=resolved.session_id,
            command=resolved.command,
            cwd=resolved.cwd,
            decision=decision.decision,
            trust_scope=decision.trust_scope,
            rule_match_type=rule_match_type,
            trusted_rule_id=trusted_rule_id,
            reject_message=resolved.reject_message,
            metadata=_approval_audit_metadata(record, mcp_trust_rule_id=mcp_trust_rule_id),
        )
        self.repositories.sessions.update(resolved.session_id, status="running")
        await self._emit(
            DomainEventType.APPROVAL_RESOLVED,
            record=resolved,
            user_id=user_id or "",
        )
        return resolved

    async def cancel_pending_for_session(self, session_id: str, *, user_id: str) -> int:
        pending = self.repositories.command_approvals.list_pending(session_id=session_id)
        count = self.repositories.command_approvals.cancel_pending_for_session(session_id)
        if not count:
            return 0
        self.repositories.sessions.update(session_id, status="running")
        for approval in pending:
            resolved = self.repositories.command_approvals.get(approval.id)
            if resolved is not None:
                await self._emit(
                    DomainEventType.APPROVAL_RESOLVED,
                    record=resolved,
                    user_id=user_id,
                )
        return count

    async def _emit(
        self,
        event_type: DomainEventType,
        *,
        record: CommandApprovalRequestRecord,
        user_id: str,
    ) -> None:
        if self.dispatcher is None:
            return
        await self.dispatcher.emit_event(
            event_type=event_type.value,
            source="command_approval",
            payload={
                "id": record.id,
                "approval_id": record.id,
                "approval": approval_to_payload(record),
                "session_id": record.session_id,
            },
            trace_id=record.trace_id,
            user_id=user_id,
            original_session_id=record.session_id,
            active_session_id=record.session_id,
            run_id=record.run_id,
            turn_index=record.turn_index,
        )


def _validate_decision_scope(
    record: CommandApprovalRequestRecord,
    decision: CommandApprovalDecision,
) -> None:
    if record.kind == "mcp_tool_call":
        if decision.trust_scope not in {
            "once",
            "session",
            "persistent_tool",
            "server_readonly",
        }:
            raise CommandApprovalError("MCP 审批不支持该 trust_scope")
        return
    if record.kind == "mcp_sampling":
        if decision.trust_scope != "once":
            raise CommandApprovalError("MCP Sampling 审批仅支持本次允许或拒绝")
        return
    if decision.trust_scope not in {"once", "persistent"}:
        raise CommandApprovalError("命令审批仅支持 once 或 persistent trust_scope")


def _mcp_approval_metadata(record: CommandApprovalRequestRecord) -> dict[str, Any]:
    details = dict(record.details or {})
    metadata = {
        "kind": "mcp_tool",
        "snapshot_id": details.get("snapshot_id"),
        "server_id": details.get("server_id"),
        "server_name": details.get("server_name"),
        "raw_tool_name": details.get("raw_tool_name"),
        "model_tool_name": details.get("model_tool_name") or record.tool_name,
        "model_name": details.get("model_tool_name") or record.tool_name,
        "risk_level": details.get("risk_level"),
        "approval_mode": details.get("approval_mode"),
        "call_id": details.get("call_id") or record.run_id,
    }
    return {key: value for key, value in metadata.items() if value not in {None, ""}}


def _mcp_sampling_metadata(record: CommandApprovalRequestRecord) -> dict[str, Any]:
    details = dict(record.details or {})
    metadata = {
        "kind": "mcp_sampling",
        "server_id": details.get("server_id"),
        "server_name": details.get("server_name"),
        "raw_tool_name": details.get("raw_tool_name"),
        "model": details.get("model"),
        "model_policy": details.get("model_policy"),
        "max_tokens": details.get("max_tokens"),
        "approval_mode": details.get("approval_mode"),
        "audit_detail": details.get("audit_detail"),
        "call_id": details.get("call_id") or record.run_id,
    }
    return {key: value for key, value in metadata.items() if value not in {None, ""}}


def _mcp_trust_rule_plan(
    repositories: StorageRepositories,
    record: CommandApprovalRequestRecord,
    decision: CommandApprovalDecision,
) -> dict[str, Any] | None:
    if (
        record.kind != "mcp_tool_call"
        or decision.decision != "approved"
        or decision.trust_scope == "once"
    ):
        return None
    details = dict(record.details or {})
    server_id = str(details.get("server_id") or "").strip()
    raw_tool_name = str(details.get("raw_tool_name") or "").strip()
    if not server_id:
        raise CommandApprovalError("MCP trust rule 缺少 server_id")
    if repositories.mcp_servers.get(server_id) is None:
        raise CommandApprovalError("MCP trust rule 对应 server 不存在")
    if decision.trust_scope in {"session", "persistent_tool"} and not raw_tool_name:
        raise CommandApprovalError("MCP trust rule 缺少 raw_tool_name")
    if decision.trust_scope == "session":
        return {
            "rule_kind": "tool",
            "scope": "session",
            "server_id": server_id,
            "raw_tool_name": raw_tool_name,
            "session_id": record.session_id,
        }
    if decision.trust_scope == "persistent_tool":
        return {
            "rule_kind": "tool",
            "scope": "global",
            "server_id": server_id,
            "raw_tool_name": raw_tool_name,
            "session_id": None,
        }
    if decision.trust_scope == "server_readonly":
        return {
            "rule_kind": "server_readonly",
            "scope": "global",
            "server_id": server_id,
            "raw_tool_name": None,
            "session_id": None,
        }
    return None


def _create_mcp_trust_rule(
    repositories: StorageRepositories,
    record: CommandApprovalRequestRecord,
    plan: dict[str, Any] | None,
) -> str | None:
    if plan is None:
        return None
    from backend.app.mcp.audit import McpAuditWriter

    rule = repositories.mcp_trust_rules.create(
        rule_id=new_id(),
        approval_mode="approve",
        created_from_approval_id=record.id,
        **plan,
    )
    McpAuditWriter.from_repositories(repositories).append_event(
        event_type="trust.created",
        server_id=rule.server_id,
        raw_tool_name=rule.raw_tool_name,
        session_id=record.session_id,
        call_id=record.run_id,
        approval_id=record.id,
        actor="user",
        status="created",
        summary=f"MCP trust rule created: {rule.rule_kind}",
        detail={
            "rule_id": rule.id,
            "rule_kind": rule.rule_kind,
            "scope": rule.scope,
            "approval_mode": rule.approval_mode,
            "created_from_approval_id": record.id,
        },
    )
    return rule.id


def _approval_audit_metadata(
    record: CommandApprovalRequestRecord,
    *,
    mcp_trust_rule_id: str | None = None,
) -> dict[str, Any]:
    metadata: dict[str, Any] = {"source": "approval_api", "kind": record.kind}
    if record.kind == "mcp_tool_call":
        metadata["mcp"] = _mcp_approval_metadata(record)
        if mcp_trust_rule_id:
            metadata["mcp"]["trust_rule_id"] = mcp_trust_rule_id
    if record.kind == "mcp_sampling":
        metadata["mcp"] = _mcp_sampling_metadata(record)
    return metadata
