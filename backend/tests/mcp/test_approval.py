from __future__ import annotations

import pytest

from backend.app.mcp.approval import (
    DefaultMcpToolApprovalDecider,
    McpToolApprovalRequest,
    evaluate_mcp_tool_risk,
    stable_schema_hash,
)
from backend.app.mcp.trust import resolve_mcp_tool_approval_policy
from backend.app.mcp.types import McpErrorCode
from backend.app.storage import StorageRepositories, init_database


def test_schema_hash_is_stable_for_json_key_order() -> None:
    first = {"type": "object", "properties": {"token": {"type": "string"}}}
    second = {"properties": {"token": {"type": "string"}}, "type": "object"}

    assert stable_schema_hash(first) == stable_schema_hash(second)


def test_risk_uses_annotations() -> None:
    readonly = evaluate_mcp_tool_risk(
        raw_tool_name="list_issues",
        input_schema={"type": "object"},
        annotations={"readOnlyHint": True},
    )
    destructive = evaluate_mcp_tool_risk(
        raw_tool_name="delete_issue",
        input_schema={"type": "object"},
        annotations={"destructiveHint": True},
    )
    open_world = evaluate_mcp_tool_risk(
        raw_tool_name="fetch_url",
        input_schema={"type": "object"},
        annotations={"readOnlyHint": True, "openWorldHint": True},
    )

    assert readonly.risk_level == "low"
    assert readonly.reasons == ["readOnlyHint=true"]
    assert destructive.risk_level == "high"
    assert "destructiveHint=true" in destructive.reasons
    assert open_world.risk_level == "high"
    assert "openWorldHint=true" in open_world.reasons


def test_sensitive_schema_and_tool_name_raise_risk() -> None:
    by_schema = evaluate_mcp_tool_risk(
        raw_tool_name="send_request",
        input_schema={
            "type": "object",
            "properties": {
                "api_token": {"type": "string"},
                "callback_url": {"type": "string"},
            },
        },
        annotations={},
    )
    by_name = evaluate_mcp_tool_risk(
        raw_tool_name="delete_file",
        input_schema={"type": "object"},
        annotations={},
    )

    assert by_schema.risk_level == "high"
    assert by_schema.reasons[0].startswith("sensitive_schema=")
    assert by_name.risk_level == "high"
    assert by_name.reasons[0].startswith("sensitive_schema=")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("approval_mode", "risk_level", "approved", "error_code"),
    [
        ("auto", "low", True, None),
        ("auto", "high", False, McpErrorCode.APPROVAL_REQUIRED),
        ("auto", "unknown", False, McpErrorCode.APPROVAL_REQUIRED),
        ("prompt", "low", False, McpErrorCode.APPROVAL_REQUIRED),
        ("approve", "high", True, None),
        ("deny", "low", False, McpErrorCode.POLICY_DENIED),
    ],
)
async def test_default_approval_decider_applies_auto_prompt_approve_deny(
    approval_mode: str,
    risk_level: str,
    approved: bool,
    error_code: McpErrorCode | None,
) -> None:
    decision = await DefaultMcpToolApprovalDecider().decide(
        _approval_request(approval_mode=approval_mode, risk_level=risk_level)
    )

    assert decision.approved is approved
    assert decision.error_code == error_code


def test_effective_approval_policy_uses_readonly_auto_and_risk_reasons(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories, default_tool_approval_mode="auto")
    tool = _create_tool(
        repositories,
        annotations={"readOnlyHint": True},
        meta={"risk_reasons": ["readOnlyHint=true"]},
        risk_level="low",
    )

    policy = resolve_mcp_tool_approval_policy(
        repositories,
        server_id="srv_policy",
        tool=tool,
    )

    assert policy.approval_mode == "auto"
    assert policy.risk_level == "low"
    assert policy.risk_reasons == ["readOnlyHint=true"]


def test_effective_approval_policy_lets_tool_policy_override_server_default(
    tmp_path,
) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories, default_tool_approval_mode="approve")
    tool = _create_tool(repositories, risk_level="low")
    repositories.mcp_tool_policies.upsert(
        server_id="srv_policy",
        raw_tool_name="search",
        approval_mode="prompt",
        risk_override="high",
    )

    policy = resolve_mcp_tool_approval_policy(
        repositories,
        server_id="srv_policy",
        tool=tool,
    )

    assert policy.approval_mode == "prompt"
    assert policy.risk_level == "high"
    assert policy.risk_reasons[0] == "risk_override=high"


def _approval_request(
    *,
    approval_mode: str,
    risk_level: str,
) -> McpToolApprovalRequest:
    return McpToolApprovalRequest(
        snapshot_id="snap-a",
        session_id="session-a",
        user_id="local-user",
        server_id="srv_policy",
        raw_tool_name="search",
        model_name="mcp__srv_policy__search",
        risk_level=risk_level,
        approval_mode=approval_mode,
        arguments={"query": "hello"},
    )


def _repositories(tmp_path) -> StorageRepositories:
    return StorageRepositories(init_database(tmp_path / "app.db"))


def _create_server(
    repositories: StorageRepositories,
    *,
    default_tool_approval_mode: str,
) -> None:
    repositories.mcp_servers.create(
        server_id="srv_policy",
        name="Policy MCP",
        transport="streamable_http",
        url="https://mcp.example.test/mcp",
        default_tool_approval_mode=default_tool_approval_mode,
    )


def _create_tool(
    repositories: StorageRepositories,
    *,
    risk_level: str = "unknown",
    annotations: dict | None = None,
    meta: dict | None = None,
):
    repositories.mcp_tools.upsert_many(
        "srv_policy",
        [
            {
                "raw_name": "search",
                "model_name": "mcp__srv_policy__search",
                "callable_namespace": "mcp__srv_policy",
                "callable_name": "search",
                "description": "Search",
                "input_schema": {"type": "object"},
                "annotations": annotations,
                "meta": meta,
                "schema_hash": "hash-search",
                "risk_level": risk_level,
            }
        ],
    )
    return repositories.mcp_tools.get_by_raw_name("srv_policy", "search")
