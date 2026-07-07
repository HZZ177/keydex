from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from backend.app.core.config import AppSettings
from backend.app.main import create_app
from backend.app.storage import StorageRepositories


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
            "schema_change_action": "disable",
        },
    )
    searched = client.get(f"/api/mcp/servers/{server_id}/tools", params={"search": "file"})
    disabled = client.get(f"/api/mcp/servers/{server_id}/tools", params={"enabled": False})

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
                "annotations": {},
            },
        ],
    )
    return {tool.raw_name: tool for tool in tools}


def _tool_by_name(tools: list[dict[str, Any]], raw_name: str) -> dict[str, Any]:
    return next(item for item in tools if item["raw_name"] == raw_name)
