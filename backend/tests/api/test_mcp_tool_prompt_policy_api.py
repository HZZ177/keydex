from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from backend.app.core.config import AppSettings
from backend.app.main import create_app
from backend.app.mcp.client import (
    McpCancellationToken,
    McpClientBase,
    McpClientCapabilities,
    McpClientInitializeResult,
    McpClientPromptResult,
    McpClientPromptSpec,
    McpClientToolResult,
    McpClientToolSpec,
)
from backend.app.mcp.errors import McpRuntimeError
from backend.app.mcp.runtime import McpRuntimeSnapshotBuilder, McpRuntimeSnapshotContext
from backend.app.mcp.types import McpErrorCode, McpServerStatus
from backend.app.storage import McpServerRecord, StorageRepositories


def test_tool_list_filters_and_single_policy_patch(tmp_path) -> None:
    client = TestClient(create_app(AppSettings(data_dir=tmp_path / "data")))
    server_id = _create_http_server(client, "Policy MCP")
    tools = _seed_tools(client.app.state.repositories, server_id)
    read_tool = tools["read_file"]
    write_tool = tools["write_file"]

    patched = client.patch(
        f"/api/mcp/servers/{server_id}/tools/{write_tool.id}/policy",
        json={
            "enabled": False,
            "hidden": True,
            "approval_mode": "prompt",
            "risk_override": "high",
            "schema_change_action": "disable",
        },
    )
    searched = client.get(f"/api/mcp/servers/{server_id}/tools", params={"search": "file"})
    disabled = client.get(f"/api/mcp/servers/{server_id}/tools", params={"enabled": False})
    high_risk = client.get(f"/api/mcp/servers/{server_id}/tools", params={"risk": "high"})

    assert patched.status_code == 200
    assert patched.json()["raw_name"] == "write_file"
    assert patched.json()["enabled"] is False
    assert patched.json()["hidden"] is True
    assert patched.json()["approval_mode"] == "prompt"
    assert patched.json()["schema_change_action"] == "disable"
    assert searched.status_code == 200
    assert {item["raw_name"] for item in searched.json()["list"]} == {
        "read_file",
        "write_file",
    }
    assert disabled.status_code == 200
    assert [item["raw_name"] for item in disabled.json()["list"]] == ["write_file"]
    assert high_risk.status_code == 200
    assert [item["raw_name"] for item in high_risk.json()["list"]] == ["write_file"]
    assert read_tool.raw_name == "read_file"
    audits, total = client.app.state.repositories.mcp_audit_log.list(
        event_type="tool.policy_updated"
    )
    assert total == 1
    assert audits[0].server_id == server_id
    assert audits[0].raw_tool_name == "write_file"
    assert audits[0].status == "ok"
    assert audits[0].detail["changes"]["enabled"] is False
    assert audits[0].detail["policy"]["approval_mode"] == "prompt"


def test_tool_bulk_policy_actions(tmp_path) -> None:
    client = TestClient(create_app(AppSettings(data_dir=tmp_path / "data")))
    server_id = _create_http_server(client, "Bulk MCP")
    tools = _seed_tools(client.app.state.repositories, server_id)

    disabled_selected = client.post(
        f"/api/mcp/servers/{server_id}/tools/bulk-policy",
        json={"action": "disable_selected", "raw_tool_names": ["search_docs"]},
    )
    keep_selected = client.post(
        f"/api/mcp/servers/{server_id}/tools/bulk-policy",
        json={"action": "keep_selected_only", "tool_ids": [tools["read_file"].id]},
    )
    enable_readonly = client.post(
        f"/api/mcp/servers/{server_id}/tools/bulk-policy",
        json={"action": "enable_read_only"},
    )
    prompt_all = client.post(
        f"/api/mcp/servers/{server_id}/tools/bulk-policy",
        json={"action": "prompt_all"},
    )
    disable_write = client.post(
        f"/api/mcp/servers/{server_id}/tools/bulk-policy",
        json={"action": "disable_write_tools"},
    )

    assert disabled_selected.status_code == 200
    assert _tool_by_name(disabled_selected.json()["tools"], "search_docs")["enabled"] is False
    assert keep_selected.status_code == 200
    assert _tool_by_name(keep_selected.json()["tools"], "read_file")["enabled"] is True
    assert _tool_by_name(keep_selected.json()["tools"], "write_file")["enabled"] is False
    assert _tool_by_name(keep_selected.json()["tools"], "search_docs")["enabled"] is False
    assert enable_readonly.status_code == 200
    assert _tool_by_name(enable_readonly.json()["tools"], "read_file")["enabled"] is True
    assert prompt_all.status_code == 200
    assert {
        item["approval_mode"] for item in prompt_all.json()["tools"]
    } == {"prompt"}
    assert disable_write.status_code == 200
    assert _tool_by_name(disable_write.json()["tools"], "read_file")["enabled"] is True
    assert _tool_by_name(disable_write.json()["tools"], "write_file")["enabled"] is False
    assert _tool_by_name(disable_write.json()["tools"], "search_docs")["enabled"] is False


def test_prompt_policy_and_materialization_success_and_error(tmp_path) -> None:
    app = create_app(AppSettings(data_dir=tmp_path / "data"))
    app.state.mcp_manager.client_factory = PromptClientFactory(fail_names={"Fail Prompt MCP"})
    client = TestClient(app)
    server_id = _create_http_server(client, "Prompt MCP")
    fail_server_id = _create_http_server(client, "Fail Prompt MCP")
    prompt = _seed_prompts(app.state.repositories, server_id)["summarize"]
    fail_prompt = _seed_prompts(app.state.repositories, fail_server_id)["summarize"]

    listed = client.get(
        f"/api/mcp/servers/{server_id}/prompts",
        params={"search": "summary"},
    )
    patched = client.patch(
        f"/api/mcp/servers/{server_id}/prompts/{prompt.id}/policy",
        json={"enabled": True, "exposure_mode": "slash_command"},
    )
    materialized = client.post(
        f"/api/mcp/servers/{server_id}/prompts/{prompt.id}/get",
        json={"arguments": {"topic": "MCP"}},
    )
    validation_error = client.post(
        f"/api/mcp/servers/{server_id}/prompts/{prompt.id}/get",
        json={"arguments": {}},
    )
    type_error = client.post(
        f"/api/mcp/servers/{server_id}/prompts/{prompt.id}/get",
        json={"arguments": {"topic": 123}},
    )
    server_error = client.post(
        f"/api/mcp/servers/{fail_server_id}/prompts/{fail_prompt.id}/get",
        json={"arguments": {"topic": "MCP"}},
    )

    assert listed.status_code == 200
    assert listed.json()["total"] == 1
    assert listed.json()["list"][0]["raw_name"] == "summarize"
    assert listed.json()["list"][0]["exposure_mode"] == "manual"
    assert patched.status_code == 200
    assert patched.json()["exposure_mode"] == "slash_command"
    assert materialized.status_code == 200
    assert materialized.json()["raw_name"] == "summarize"
    assert materialized.json()["arguments"] == {"topic": "MCP"}
    assert materialized.json()["messages"][0]["content"]["text"] == "Summarize MCP"
    assert validation_error.status_code == 400
    assert validation_error.json()["detail"]["code"] == "validation_error"
    assert type_error.status_code == 400
    assert type_error.json()["detail"]["code"] == "validation_error"
    assert type_error.json()["detail"]["detail"]["reason"] == "argument_type_mismatch"
    assert server_error.status_code == 400
    assert server_error.json()["detail"]["code"] == "timeout"
    policy_audits, policy_total = app.state.repositories.mcp_audit_log.list(
        event_type="prompt.policy_updated"
    )
    prompt_audits, prompt_total = app.state.repositories.mcp_audit_log.list(
        event_type="prompt.get"
    )
    failed_audits, failed_total = app.state.repositories.mcp_audit_log.list(
        event_type="prompt.failed"
    )
    assert policy_total == 1
    assert policy_audits[0].prompt_name == "summarize"
    assert policy_audits[0].detail["changes"]["exposure_mode"] == "slash_command"
    assert prompt_total == 1
    assert prompt_audits[0].prompt_name == "summarize"
    assert prompt_audits[0].detail["message_count"] == 1
    assert failed_total == 3
    assert {audit.detail["error_code"] for audit in failed_audits} == {
        "validation_error",
        "timeout",
    }


def test_prompt_policy_agent_selectable_does_not_enter_runtime_tool_snapshot(tmp_path) -> None:
    app = create_app(AppSettings(data_dir=tmp_path / "data"))
    client = TestClient(app)
    server_id = _create_http_server(client, "Prompt Only MCP")
    prompt = _seed_prompts(app.state.repositories, server_id)["summarize"]
    app.state.repositories.mcp_server_status.update_refresh_counts(
        server_id,
        status="online",
        prompts_count=1,
    )

    patched = client.patch(
        f"/api/mcp/servers/{server_id}/prompts/{prompt.id}/policy",
        json={"enabled": True, "exposure_mode": "agent_selectable"},
    )
    snapshot = McpRuntimeSnapshotBuilder(
        app.state.repositories,
        deferred_threshold=40,
    ).build_snapshot(
        McpRuntimeSnapshotContext(session_id="session-prompt")
    )

    assert patched.status_code == 200
    assert patched.json()["enabled"] is True
    assert patched.json()["exposure_mode"] == "agent_selectable"
    assert snapshot.visible_tools == []
    assert app.state.repositories.mcp_tools.list_by_server(server_id) == []


def test_trust_rules_and_audit_api(tmp_path) -> None:
    app = create_app(AppSettings(data_dir=tmp_path / "data"))
    client = TestClient(app)
    server_id = _create_http_server(client, "Trust MCP")

    invalid_global = client.post(
        "/api/mcp/trust-rules",
        json={"rule_kind": "server_readonly", "scope": "global", "approval_mode": "approve"},
    )
    created = client.post(
        "/api/mcp/trust-rules",
        json={
            "rule_kind": "tool",
            "scope": "global",
            "approval_mode": "approve",
            "server_id": server_id,
            "raw_tool_name": "read_file",
            "condition": {"path_prefix": "/docs"},
        },
    )
    rule_id = created.json()["id"]
    listed = client.get("/api/mcp/trust-rules", params={"server_id": server_id})
    deleted = client.delete(f"/api/mcp/trust-rules/{rule_id}")
    missing_delete = client.delete(f"/api/mcp/trust-rules/{rule_id}")
    app.state.repositories.mcp_audit_log.append(
        audit_id="audit_server_updated",
        event_type="server.updated",
        server_id=server_id,
        status="ok",
        duration_ms=12,
        summary="Server config updated",
        detail={"field": "auto_refresh"},
    )
    audit = client.get(
        "/api/mcp/audit",
        params={"server_id": server_id, "event_type": "server.updated"},
    )

    assert invalid_global.status_code == 400
    assert invalid_global.json()["detail"]["code"] == "invalid_trust_rule"
    assert created.status_code == 200
    assert created.json()["rule_kind"] == "tool"
    assert created.json()["server_id"] == server_id
    assert created.json()["raw_tool_name"] == "read_file"
    assert created.json()["condition"] == {"path_prefix": "/docs"}
    assert listed.status_code == 200
    assert [item["id"] for item in listed.json()["list"]] == [rule_id]
    assert deleted.status_code == 200
    assert deleted.json() == {"deleted": True, "rule_id": rule_id}
    assert missing_delete.status_code == 404
    assert audit.status_code == 200
    assert audit.json()["total"] == 1
    assert audit.json()["list"][0]["event_type"] == "server.updated"
    assert audit.json()["list"][0]["duration_ms"] == 12
    assert audit.json()["list"][0]["detail"] == {"field": "auto_refresh"}


def _create_http_server(client: TestClient, name: str) -> str:
    response = client.post(
        "/api/mcp/servers",
        json={
            "name": name,
            "transport": "streamable_http",
            "url": "https://mcp.example.test/mcp",
        },
    )
    assert response.status_code == 200
    return response.json()["id"]


def _seed_tools(
    repositories: StorageRepositories,
    server_id: str,
) -> dict[str, Any]:
    tools = repositories.mcp_tools.upsert_many(
        server_id,
        [
            {
                "raw_name": "read_file",
                "model_name": f"mcp__{server_id}__read_file",
                "callable_namespace": f"mcp__{server_id}",
                "callable_name": "read_file",
                "display_name": "Read file",
                "description": "Read a file",
                "input_schema": {"type": "object"},
                "schema_hash": "hash-read",
                "risk_level": "low",
                "annotations": {"readOnlyHint": True},
            },
            {
                "raw_name": "write_file",
                "model_name": f"mcp__{server_id}__write_file",
                "callable_namespace": f"mcp__{server_id}",
                "callable_name": "write_file",
                "display_name": "Write file",
                "description": "Write a file",
                "input_schema": {"type": "object"},
                "schema_hash": "hash-write",
                "risk_level": "high",
                "annotations": {"destructiveHint": True},
            },
            {
                "raw_name": "search_docs",
                "model_name": f"mcp__{server_id}__search_docs",
                "callable_namespace": f"mcp__{server_id}",
                "callable_name": "search_docs",
                "display_name": "Search docs",
                "description": "Search documentation",
                "input_schema": {"type": "object"},
                "schema_hash": "hash-search",
                "risk_level": "unknown",
                "annotations": {},
            },
        ],
    )
    return {tool.raw_name: tool for tool in tools}


def _seed_prompts(
    repositories: StorageRepositories,
    server_id: str,
) -> dict[str, Any]:
    prompts = repositories.mcp_prompts.upsert_many(
        server_id,
        [
            {
                "raw_name": "summarize",
                "display_name": "Summarize",
                "description": "Create a summary",
                "arguments_schema": {
                    "type": "object",
                    "properties": {"topic": {"type": "string"}},
                    "required": ["topic"],
                },
            }
        ],
    )
    return {prompt.raw_name: prompt for prompt in prompts}


def _tool_by_name(tools: list[dict[str, Any]], raw_name: str) -> dict[str, Any]:
    return next(item for item in tools if item["raw_name"] == raw_name)


class PromptClientFactory:
    def __init__(self, *, fail_names: set[str]) -> None:
        self.fail_names = fail_names

    def create_client(self, server: McpServerRecord) -> PromptFakeMcpClient:
        return PromptFakeMcpClient(
            server.id,
            error=McpRuntimeError(McpErrorCode.TIMEOUT)
            if server.name in self.fail_names
            else None,
        )


class PromptFakeMcpClient(McpClientBase):
    def __init__(
        self,
        server_id: str,
        *,
        error: BaseException | None = None,
    ) -> None:
        super().__init__(server_id=server_id)
        self.error = error

    async def initialize(
        self,
        *,
        timeout_sec: float | None = None,
        cancellation: McpCancellationToken | None = None,
    ) -> McpClientInitializeResult:
        self.transition_status(McpServerStatus.ONLINE, reason="test")
        return McpClientInitializeResult(
            protocol_version="2026-03-26",
            server_info={"name": "fake"},
            capabilities=McpClientCapabilities(),
        )

    async def list_tools(
        self,
        *,
        timeout_sec: float | None = None,
        cancellation: McpCancellationToken | None = None,
    ) -> list[McpClientToolSpec]:
        return []

    async def list_prompts(
        self,
        *,
        timeout_sec: float | None = None,
        cancellation: McpCancellationToken | None = None,
    ) -> list[McpClientPromptSpec]:
        return []

    async def call_tool(
        self,
        raw_tool_name: str,
        arguments: dict[str, Any] | None = None,
        *,
        call_id: str | None = None,
        timeout_sec: float | None = None,
        cancellation: McpCancellationToken | None = None,
    ) -> McpClientToolResult:
        raise NotImplementedError

    async def get_prompt(
        self,
        raw_prompt_name: str,
        arguments: dict[str, Any] | None = None,
        *,
        timeout_sec: float | None = None,
        cancellation: McpCancellationToken | None = None,
    ) -> McpClientPromptResult:
        if self.error is not None:
            raise self.error
        topic = (arguments or {}).get("topic", "")
        return McpClientPromptResult(
            description="Ready prompt",
            messages=[
                {
                    "role": "user",
                    "content": {"type": "text", "text": f"Summarize {topic}"},
                }
            ],
            metadata={"source": "fake"},
        )

    async def cancel_call(self, call_id: str) -> bool:
        return False

    async def shutdown(self, *, timeout_sec: float | None = None) -> None:
        self.transition_status(McpServerStatus.OFFLINE, reason="shutdown")
