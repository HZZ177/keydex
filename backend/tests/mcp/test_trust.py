from __future__ import annotations

from datetime import timedelta

from backend.app.core.time import to_iso_z, utc_now
from backend.app.mcp.approval import McpToolApprovalRequest
from backend.app.mcp.trust import find_mcp_trust_rule_match, record_mcp_trust_hit
from backend.app.storage import StorageRepositories, init_database


def _repositories(tmp_path) -> StorageRepositories:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    repositories.mcp_servers.create(
        server_id="srv_trust",
        name="Trust MCP",
        transport="streamable_http",
        url="https://mcp.example.test/mcp",
    )
    return repositories


def _request(
    *,
    session_id: str = "session-a",
    arguments: dict | None = None,
    annotations: dict | None = None,
) -> McpToolApprovalRequest:
    return McpToolApprovalRequest(
        snapshot_id="snap-a",
        session_id=session_id,
        user_id="local-user",
        server_id="srv_trust",
        raw_tool_name="search",
        model_name="mcp__srv_trust__search",
        risk_level="high",
        approval_mode="auto",
        arguments=arguments or {"query": "hello"},
        annotations=annotations or {},
    )


def test_session_trust_matches_only_same_session_and_records_hit(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    rule = repositories.mcp_trust_rules.create(
        rule_id="trust-session",
        rule_kind="tool",
        scope="session",
        session_id="session-a",
        server_id="srv_trust",
        raw_tool_name="search",
        approval_mode="approve",
    )

    match = find_mcp_trust_rule_match(repositories, _request())
    other_session = find_mcp_trust_rule_match(
        repositories,
        _request(session_id="session-b"),
    )
    record_mcp_trust_hit(repositories, _request(), match)

    updated = repositories.mcp_trust_rules.get(rule.id)
    audits, total = repositories.mcp_audit_log.list(event_type="trust.hit")
    assert match.rule.id == rule.id
    assert match.approval_mode == "approve"
    assert other_session is None
    assert updated.hit_count == 1
    assert updated.last_hit_at is not None
    assert total == 1
    assert audits[0].detail["rule_id"] == rule.id


def test_global_tool_trust_matches_any_session(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    rule = repositories.mcp_trust_rules.create(
        rule_id="trust-global-tool",
        rule_kind="tool",
        scope="global",
        server_id="srv_trust",
        raw_tool_name="search",
        approval_mode="approve",
    )

    match = find_mcp_trust_rule_match(
        repositories,
        _request(session_id="other-session"),
    )

    assert match.rule.id == rule.id


def test_server_readonly_trust_requires_readonly_non_openworld_tool(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    rule = repositories.mcp_trust_rules.create(
        rule_id="trust-readonly",
        rule_kind="server_readonly",
        scope="global",
        server_id="srv_trust",
        approval_mode="approve",
    )

    readonly = find_mcp_trust_rule_match(
        repositories,
        _request(annotations={"readOnlyHint": True}),
    )
    open_world = find_mcp_trust_rule_match(
        repositories,
        _request(annotations={"readOnlyHint": True, "openWorldHint": True}),
    )

    assert readonly.rule.id == rule.id
    assert open_world is None


def test_tool_with_params_matches_argument_subset(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    rule = repositories.mcp_trust_rules.create(
        rule_id="trust-params",
        rule_kind="tool_with_params",
        scope="global",
        server_id="srv_trust",
        raw_tool_name="search",
        approval_mode="approve",
        condition={"arguments": {"query": "allowed"}},
    )

    allowed = find_mcp_trust_rule_match(
        repositories,
        _request(arguments={"query": "allowed", "page": 1}),
    )
    blocked = find_mcp_trust_rule_match(
        repositories,
        _request(arguments={"query": "blocked", "page": 1}),
    )

    assert allowed.rule.id == rule.id
    assert blocked is None


def test_deny_rule_has_priority_over_approve_rule(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    repositories.mcp_trust_rules.create(
        rule_id="trust-approve",
        rule_kind="tool",
        scope="global",
        server_id="srv_trust",
        raw_tool_name="search",
        approval_mode="approve",
    )
    deny = repositories.mcp_trust_rules.create(
        rule_id="trust-deny",
        rule_kind="deny_tool",
        scope="global",
        server_id="srv_trust",
        raw_tool_name="search",
        approval_mode="deny",
    )

    match = find_mcp_trust_rule_match(repositories, _request())

    assert match.rule.id == deny.id
    assert match.approval_mode == "deny"


def test_expired_rule_is_ignored(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    repositories.mcp_trust_rules.create(
        rule_id="trust-expired",
        rule_kind="tool",
        scope="global",
        server_id="srv_trust",
        raw_tool_name="search",
        approval_mode="approve",
        expires_at=to_iso_z(utc_now() - timedelta(days=1)),
    )

    match = find_mcp_trust_rule_match(repositories, _request())

    assert match is None
