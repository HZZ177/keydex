from __future__ import annotations

import pytest

from backend.app.mcp.approval import (
    DefaultMcpToolApprovalDecider,
    McpToolApprovalRequest,
    stable_schema_hash,
)
from backend.app.mcp.trust import resolve_mcp_tool_approval_policy
from backend.app.mcp.types import McpErrorCode
from backend.app.storage import StorageRepositories, init_database


def test_schema_hash_is_stable_for_json_key_order() -> None:
    first = {"type": "object", "properties": {"token": {"type": "string"}}}
    second = {"properties": {"token": {"type": "string"}}, "type": "object"}

    assert stable_schema_hash(first) == stable_schema_hash(second)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("approval_mode", "approved", "error_code"),
    [
        ("auto", True, None),
        ("prompt", False, McpErrorCode.APPROVAL_REQUIRED),
        ("approve", True, None),
        ("deny", False, McpErrorCode.POLICY_DENIED),
    ],
)
async def test_default_approval_decider_applies_auto_prompt_approve_deny(
    approval_mode: str,
    approved: bool,
    error_code: McpErrorCode | None,
) -> None:
    decision = await DefaultMcpToolApprovalDecider().decide(
        _approval_request(approval_mode=approval_mode)
    )

    assert decision.approved is approved
    assert decision.error_code == error_code


def test_effective_approval_policy_uses_server_default(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories, default_tool_approval_mode="auto")
    tool = _create_tool(
        repositories,
        annotations={"readOnlyHint": True},
    )

    policy = resolve_mcp_tool_approval_policy(
        repositories,
        server_id="srv_policy",
        tool=tool,
    )

    assert policy.approval_mode == "auto"


def test_effective_approval_policy_lets_tool_policy_override_server_default(
    tmp_path,
) -> None:
    repositories = _repositories(tmp_path)
    _create_server(repositories, default_tool_approval_mode="approve")
    tool = _create_tool(repositories)
    repositories.mcp_tool_policies.upsert(
        server_id="srv_policy",
        raw_tool_name="search",
        approval_mode="prompt",
    )

    policy = resolve_mcp_tool_approval_policy(
        repositories,
        server_id="srv_policy",
        tool=tool,
    )

    assert policy.approval_mode == "prompt"


def _approval_request(
    *,
    approval_mode: str,
) -> McpToolApprovalRequest:
    return McpToolApprovalRequest(
        snapshot_id="snap-a",
        session_id="session-a",
        user_id="local-user",
        server_id="srv_policy",
        raw_tool_name="search",
        model_name="mcp__srv_policy__search",
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
            }
        ],
    )
    return repositories.mcp_tools.get_by_raw_name("srv_policy", "search")
