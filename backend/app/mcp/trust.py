from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from backend.app.mcp.audit import McpAuditWriter
from backend.app.storage import McpToolRecord, McpTrustRuleRecord, StorageRepositories


@dataclass(frozen=True)
class McpEffectiveApprovalPolicy:
    approval_mode: str


@dataclass(frozen=True)
class McpTrustRuleMatch:
    rule: McpTrustRuleRecord
    approval_mode: str
    reason: str


def resolve_mcp_tool_approval_policy(
    repositories: StorageRepositories,
    *,
    server_id: str,
    tool: McpToolRecord,
) -> McpEffectiveApprovalPolicy:
    policy = repositories.mcp_tool_policies.get(server_id, tool.raw_name)
    server = repositories.mcp_servers.get(server_id)
    approval_mode = (
        policy.approval_mode
        if policy is not None and policy.approval_mode != "inherit"
        else server.default_tool_approval_mode
        if server is not None
        else "auto"
    )
    return McpEffectiveApprovalPolicy(approval_mode=approval_mode)


def find_mcp_trust_rule_match(
    repositories: StorageRepositories,
    request: Any,
) -> McpTrustRuleMatch | None:
    candidates = _candidate_rules(repositories, request)
    matches = [rule for rule in candidates if _rule_matches(rule, request)]
    if not matches:
        return None
    deny = next(
        (rule for rule in matches if rule.approval_mode == "deny" or rule.rule_kind == "deny_tool"),
        None,
    )
    if deny is not None:
        return McpTrustRuleMatch(
            rule=deny,
            approval_mode="deny",
            reason=f"trust_rule_denied:{deny.id}",
        )
    approve = next((rule for rule in matches if rule.approval_mode == "approve"), None)
    if approve is None:
        return None
    return McpTrustRuleMatch(
        rule=approve,
        approval_mode="approve",
        reason=f"trust_rule_approved:{approve.id}",
    )


def record_mcp_trust_hit(
    repositories: StorageRepositories,
    request: Any,
    match: McpTrustRuleMatch,
) -> None:
    repositories.mcp_trust_rules.touch_hit(match.rule.id)
    McpAuditWriter.from_repositories(repositories).append_event(
        event_type="trust.hit",
        server_id=request.server_id,
        raw_tool_name=request.raw_tool_name,
        session_id=request.session_id,
        call_id=getattr(request, "tool_call_id", None),
        actor="system",
        status=match.approval_mode,
        summary=f"MCP trust rule matched: {match.rule.rule_kind}",
        detail={
            "rule_id": match.rule.id,
            "rule_kind": match.rule.rule_kind,
            "scope": match.rule.scope,
            "approval_mode": match.approval_mode,
            "reason": match.reason,
        },
    )


def _candidate_rules(
    repositories: StorageRepositories,
    request: Any,
) -> list[McpTrustRuleRecord]:
    rules: dict[str, McpTrustRuleRecord] = {}
    for rule in repositories.mcp_trust_rules.list(server_id=request.server_id):
        rules[rule.id] = rule
    for rule in repositories.mcp_trust_rules.list(scope="session", session_id=request.session_id):
        rules[rule.id] = rule
    return list(rules.values())


def _rule_matches(rule: McpTrustRuleRecord, request: Any) -> bool:
    if _is_expired(rule):
        return False
    if rule.server_id != request.server_id:
        return False
    if rule.scope == "session" and rule.session_id != request.session_id:
        return False
    if rule.rule_kind == "server_readonly":
        return _is_readonly_request(request)
    if rule.rule_kind in {"tool", "deny_tool"}:
        return rule.raw_tool_name == request.raw_tool_name
    if rule.rule_kind == "tool_with_params":
        return rule.raw_tool_name == request.raw_tool_name and _condition_matches(
            rule.condition,
            request.arguments,
        )
    return False


def _is_expired(rule: McpTrustRuleRecord) -> bool:
    if not rule.expires_at:
        return False
    try:
        expires_at = datetime.fromisoformat(rule.expires_at.replace("Z", "+00:00"))
    except ValueError:
        return True
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=UTC)
    return expires_at <= datetime.now(UTC)


def _is_readonly_request(request: Any) -> bool:
    tool = getattr(request, "tool", None)
    annotations = getattr(tool, "annotations", None) or getattr(request, "annotations", None) or {}
    return annotations.get("readOnlyHint") is True and annotations.get("openWorldHint") is not True


def _condition_matches(
    condition: dict[str, Any] | None,
    arguments: dict[str, Any],
) -> bool:
    if not condition:
        return True
    expected = condition.get("arguments")
    if expected is None:
        expected = condition.get("arguments_subset")
    if expected is None:
        return True
    if not isinstance(expected, dict):
        return False
    return all(arguments.get(key) == value for key, value in expected.items())
