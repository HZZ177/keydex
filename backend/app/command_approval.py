from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator

from backend.app.core.ids import new_id
from backend.app.events import DomainEventType, EventDispatcher
from backend.app.security import normalize_workspace_root_for_storage
from backend.app.storage import (
    CommandApprovalAuditRecord,
    CommandApprovalRequestRecord,
    StorageRepositories,
    TrustedCommandRuleRecord,
)

COMMAND_SETTINGS_KEY = "command_settings"
DEFAULT_APPROVAL_WAIT_SECONDS = 24 * 60 * 60
BROAD_PREFIX_COMMANDS = {"powershell", "pwsh", "cmd", "python", "node", "npm", "pnpm", "git"}
FileAccessMode = Literal[
    "no_file_access",
    "workspace_read_only",
    "workspace_trusted",
    "full_access",
]


class CommandSettings(BaseModel):
    command_enabled: bool = True
    require_approval_for_untrusted: bool = True
    allow_persistent_trust: bool = True
    file_access_mode: FileAccessMode = "workspace_trusted"
    default_timeout_seconds: float = Field(default=120, ge=0.1, le=600)
    max_timeout_seconds: float = Field(default=600, ge=0.1, le=3600)
    max_output_chars: int = Field(default=65536, ge=1, le=1024 * 1024)

    @field_validator("max_timeout_seconds")
    @classmethod
    def _max_timeout_must_cover_default(cls, value: float, info: Any) -> float:
        default_timeout = float(info.data.get("default_timeout_seconds") or 0)
        if default_timeout and value < default_timeout:
            raise ValueError("最大超时时间不能小于默认超时时间")
        return value


class CommandApprovalDecision(BaseModel):
    decision: Literal["approved", "rejected"]
    trust_scope: Literal["once", "persistent"] = "once"
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
    workspace_root: str,
) -> TrustedCommandMatch | None:
    normalized = normalize_command(command)
    normalized_cwd = normalize_cwd(cwd)
    normalized_root = normalized_workspace_root(workspace_root)
    for rule in repositories.trusted_command_rules.list(include_disabled=False):
        if rule.shell != shell:
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
    return payload


def rule_to_payload(record: TrustedCommandRuleRecord) -> dict[str, Any]:
    return {
        "id": record.id,
        "command_pattern": record.command_pattern,
        "normalized_command": record.normalized_command,
        "match_type": record.match_type,
        "shell": record.shell,
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
            title="是否允许执行命令？",
            description="命令将在当前工作区执行。",
            details={
                "command": command,
                "cwd": normalized_current_dir,
                "shell": shell,
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

        command_settings = settings or load_command_settings(self.repositories)
        trusted_rule_id: str | None = None
        rule_match_type = decision.rule_match_type
        if decision.decision == "approved" and decision.trust_scope == "persistent":
            if not command_settings.allow_persistent_trust:
                raise CommandApprovalError("当前配置不允许保存已信任命令")
            resolved_match_type = rule_match_type or "exact"
            validate_persistent_rule(record.command, resolved_match_type)
            trusted_rule = self.repositories.trusted_command_rules.create(
                rule_id=new_id(),
                command_pattern=normalize_command(record.command),
                normalized_command=normalize_command(record.command),
                match_type=resolved_match_type,
                shell=record.shell,
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
            metadata={"source": "approval_api"},
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
