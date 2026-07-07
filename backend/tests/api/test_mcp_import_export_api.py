from __future__ import annotations

import json

from fastapi.testclient import TestClient

from backend.app.core.config import AppSettings
from backend.app.main import create_app


def test_keydex_import_preview_and_confirm_writes_audit(tmp_path) -> None:
    client = TestClient(create_app(AppSettings(data_dir=tmp_path / "data")))
    config = {
        "format": "keydex.mcp.v1",
        "servers": [
            {
                "name": "Remote Search",
                "transport": "streamable_http",
                "url": "https://mcp.example.test/mcp",
                "headers": {"Authorization": "env:MCP_TOKEN"},
                "tool_timeout_sec": 15,
            }
        ],
    }

    preview = client.post(
        "/api/mcp/import",
        json={"source_type": "keydex", "config": config},
    )
    applied = client.post(
        "/api/mcp/import",
        json={"source_type": "keydex", "config": config, "confirm": True},
    )

    assert preview.status_code == 200
    assert preview.json()["server_count"] == 1
    assert preview.json()["servers"][0]["transport"] == "streamable_http"
    assert preview.json()["missing_secrets"] == []
    assert applied.status_code == 200
    assert applied.json()["created_count"] == 1
    repositories = client.app.state.repositories
    server = repositories.mcp_servers.get(applied.json()["created"][0]["id"])
    assert server is not None
    assert server.url == "https://mcp.example.test/mcp"
    assert server.env_headers == {"Authorization": "MCP_TOKEN"}
    audits, total = repositories.mcp_audit_log.list(event_type="import.applied")
    assert total == 1
    assert audits[0].detail["created_count"] == 1


def test_keydex_import_strips_sensitive_env_values(tmp_path) -> None:
    client = TestClient(create_app(AppSettings(data_dir=tmp_path / "data")))
    config = {
        "format": "keydex.mcp.v1",
        "servers": [
            {
                "name": "Local Files",
                "transport": "stdio",
                "command": "npx",
                "args": ["@example/mcp-files"],
                "env": {
                    "NODE_ENV": "production",
                    "API_KEY": "raw-secret-value-0123456789012345",
                },
            }
        ],
    }

    preview = client.post(
        "/api/mcp/import",
        json={"source_type": "keydex", "config": config},
    )
    applied = client.post(
        "/api/mcp/import",
        json={"source_type": "keydex", "config": config, "confirm": True},
    )

    assert preview.status_code == 200
    assert preview.json()["servers"][0]["transport"] == "stdio"
    assert preview.json()["missing_secrets"] == ["Local Files.env.API_KEY"]
    assert applied.status_code == 200
    server = client.app.state.repositories.mcp_servers.get(applied.json()["created"][0]["id"])
    assert server is not None
    assert server.command == "npx"
    assert server.args == ["@example/mcp-files"]
    assert server.env == {"NODE_ENV": "production"}


def test_import_rejects_non_keydex_sources(tmp_path) -> None:
    client = TestClient(create_app(AppSettings(data_dir=tmp_path / "data")))

    response = client.post(
        "/api/mcp/import",
        json={"source_type": "codex", "config": {}},
    )

    assert response.status_code == 422


def test_keydex_import_applies_valid_json_and_preview_unknown_fields_does_not_write(
    tmp_path,
) -> None:
    client = TestClient(create_app(AppSettings(data_dir=tmp_path / "data")))
    valid_config = {
        "servers": [
            {
                "name": "Keydex Remote",
                "transport": "streamable_http",
                "url": "https://mcp.example.test/mcp",
                "env": {
                    "SAFE_ENV": "safe-value",
                    "API_TOKEN": "raw-secret-value-0123456789012345",
                },
                "headers": {"Authorization": "env:MCP_TOKEN"},
                "default_tool_approval_mode": "prompt",
            }
        ]
    }
    invalid_config = {
        "servers": [
            {
                "name": "Invalid Keydex Remote",
                "transport": "streamable_http",
                "url": "https://mcp.example.test/mcp",
                "unexpected_field": True,
            }
        ]
    }

    preview = client.post(
        "/api/mcp/import",
        json={"source_type": "keydex", "config": valid_config},
    )
    applied = client.post(
        "/api/mcp/import",
        json={"source_type": "keydex", "config": valid_config, "confirm": True},
    )
    invalid_preview = client.post(
        "/api/mcp/import",
        json={"source_type": "keydex", "config": invalid_config},
    )
    rejected = client.post(
        "/api/mcp/import",
        json={"source_type": "keydex", "config": invalid_config, "confirm": True},
    )

    assert preview.status_code == 200
    assert preview.json()["source_type"] == "keydex"
    assert preview.json()["server_count"] == 1
    assert preview.json()["missing_secrets"] == ["Keydex Remote.env.API_TOKEN"]
    assert applied.status_code == 200
    server = client.app.state.repositories.mcp_servers.get(applied.json()["created"][0]["id"])
    assert server is not None
    assert server.name == "Keydex Remote"
    assert server.env == {"SAFE_ENV": "safe-value"}
    assert server.env_headers == {"Authorization": "MCP_TOKEN"}
    assert server.default_tool_approval_mode == "prompt"
    assert invalid_preview.status_code == 200
    assert invalid_preview.json()["valid"] is False
    assert invalid_preview.json()["unknown_fields"] == [
        "Invalid Keydex Remote.unexpected_field"
    ]
    assert rejected.status_code == 400
    assert rejected.json()["detail"]["code"] == "unknown_fields"
    servers, total = client.app.state.repositories.mcp_servers.list(limit=20)
    assert total == 1
    assert [item.name for item in servers] == ["Keydex Remote"]


def test_keydex_import_accepts_export_metadata_without_unknown_fields(tmp_path) -> None:
    client = TestClient(create_app(AppSettings(data_dir=tmp_path / "data")))
    config = {
        "format": "keydex.mcp.v1",
        "servers": [
            {
                "name": "Exported Keydex Remote",
                "transport": "streamable_http",
                "url": "https://mcp.example.test/mcp",
                "headers": {"Authorization": "secret:configured"},
                "auth_type": "oauth",
                "secret_ref_keys": ["api_key"],
                "oauth_configured": True,
                "oauth_scopes": ["read"],
            }
        ],
        "tool_policies": [],
    }

    preview = client.post(
        "/api/mcp/import",
        json={"source_type": "keydex", "config": config},
    )
    applied = client.post(
        "/api/mcp/import",
        json={"source_type": "keydex", "config": config, "confirm": True},
    )

    assert preview.status_code == 200
    assert preview.json()["valid"] is True
    assert preview.json()["unknown_fields"] == []
    assert preview.json()["missing_secrets"] == [
        "Exported Keydex Remote.secret_refs.api_key",
        "Exported Keydex Remote.oauth_config",
        "Exported Keydex Remote.headers.Authorization",
    ]
    assert applied.status_code == 200
    server = client.app.state.repositories.mcp_servers.get(applied.json()["created"][0]["id"])
    assert server is not None
    assert server.name == "Exported Keydex Remote"
    assert server.auth_type == "oauth"
    assert server.headers == {}
    assert server.oauth_config is None


def test_import_name_conflict_requires_strategy(tmp_path) -> None:
    client = TestClient(create_app(AppSettings(data_dir=tmp_path / "data")))
    create = client.post(
        "/api/mcp/servers",
        json={
            "name": "Duplicate",
            "transport": "stdio",
            "command": "existing-mcp",
        },
    )
    assert create.status_code == 200
    config = {
        "format": "keydex.mcp.v1",
        "servers": [
            {
                "name": "Duplicate",
                "transport": "stdio",
                "command": "new-mcp",
            }
        ],
    }

    preview = client.post(
        "/api/mcp/import",
        json={"source_type": "keydex", "config": config},
    )
    rejected = client.post(
        "/api/mcp/import",
        json={
            "source_type": "keydex",
            "config": config,
            "confirm": True,
            "conflict_strategy": "error",
        },
    )
    renamed = client.post(
        "/api/mcp/import",
        json={
            "source_type": "keydex",
            "config": config,
            "confirm": True,
            "conflict_strategy": "rename",
        },
    )

    assert preview.status_code == 200
    assert preview.json()["conflicts"] == ["Duplicate"]
    assert preview.json()["servers"][0]["action"] == "skip"
    assert rejected.status_code == 400
    assert rejected.json()["detail"]["code"] == "name_conflict"
    assert renamed.status_code == 200
    assert renamed.json()["created"][0]["name"] == "Duplicate (imported)"


def test_export_strips_secret_plaintext_and_oauth_token_material(tmp_path) -> None:
    client = TestClient(create_app(AppSettings(data_dir=tmp_path / "data")))
    repositories = client.app.state.repositories
    server = repositories.mcp_servers.create(
        server_id="srv_export",
        name="Export MCP",
        transport="streamable_http",
        url="https://mcp.example.test/mcp",
        env={"SAFE_ENV": "safe-value", "API_TOKEN": "raw-env-secret-value"},
        headers={"Authorization": "Bearer raw-header-secret"},
        secret_refs={"api_key": "secret:raw-secret-ref"},
        oauth_config={"client_id": "client-id", "client_secret": "raw-oauth-secret"},
        oauth_scopes=["read"],
    )
    repositories.mcp_oauth_tokens.upsert_for_server(
        server_id=server.id,
        token_ref="secret:mcp/oauth/access/raw-token-ref",
        refresh_token_ref="secret:mcp/oauth/refresh/raw-refresh-ref",
    )

    response = client.post("/api/mcp/export", json={"include_trust_rules": False})
    serialized = json.dumps(response.json(), ensure_ascii=False)

    assert response.status_code == 200
    assert response.json()["format"] == "keydex.mcp.v1"
    assert "raw-env-secret-value" not in serialized
    assert "raw-header-secret" not in serialized
    assert "raw-secret-ref" not in serialized
    assert "raw-oauth-secret" not in serialized
    assert "raw-token-ref" not in serialized
    assert response.json()["servers"][0]["env"] == {
        "API_TOKEN": "env:API_TOKEN",
        "SAFE_ENV": "env:SAFE_ENV",
    }
    assert response.json()["servers"][0]["secret_ref_keys"] == ["api_key"]


def test_export_filters_selected_servers_policies_and_trust_rules(tmp_path) -> None:
    client = TestClient(create_app(AppSettings(data_dir=tmp_path / "data")))
    repositories = client.app.state.repositories
    selected = repositories.mcp_servers.create(
        server_id="srv_selected_export",
        name="Selected Export MCP",
        transport="streamable_http",
        url="https://selected.example.test/mcp",
    )
    other = repositories.mcp_servers.create(
        server_id="srv_other_export",
        name="Other Export MCP",
        transport="streamable_http",
        url="https://other.example.test/mcp",
    )
    repositories.mcp_tool_policies.bulk_update(
        selected.id,
        [{"raw_tool_name": "selected_tool", "approval_mode": "approve"}],
    )
    repositories.mcp_tool_policies.bulk_update(
        other.id,
        [{"raw_tool_name": "other_tool", "approval_mode": "approve"}],
    )
    repositories.mcp_trust_rules.create(
        rule_id="trust_selected_export",
        rule_kind="tool",
        scope="global",
        approval_mode="approve",
        server_id=selected.id,
        raw_tool_name="selected_tool",
    )
    repositories.mcp_trust_rules.create(
        rule_id="trust_other_export",
        rule_kind="tool",
        scope="global",
        approval_mode="approve",
        server_id=other.id,
        raw_tool_name="other_tool",
    )

    response = client.post(
        "/api/mcp/export",
        json={"include_trust_rules": True, "server_ids": [selected.id]},
    )
    missing = client.post(
        "/api/mcp/export",
        json={"include_trust_rules": True, "server_ids": ["missing-server"]},
    )

    assert response.status_code == 200
    assert [server["name"] for server in response.json()["servers"]] == ["Selected Export MCP"]
    assert [policy["server_id"] for policy in response.json()["tool_policies"]] == [selected.id]
    assert [rule["server_id"] for rule in response.json()["trust_rules"]] == [selected.id]
    assert missing.status_code == 400
    assert missing.json()["detail"]["code"] == "server_not_found"


def test_export_includes_sanitized_trust_rules_when_requested(tmp_path) -> None:
    client = TestClient(create_app(AppSettings(data_dir=tmp_path / "data")))
    repositories = client.app.state.repositories
    server = repositories.mcp_servers.create(
        server_id="srv_trust_export",
        name="Trust Export MCP",
        transport="streamable_http",
        url="https://mcp.example.test/mcp",
    )
    repositories.mcp_trust_rules.create(
        rule_id="trust_export",
        rule_kind="tool",
        scope="global",
        approval_mode="approve",
        server_id=server.id,
        raw_tool_name="write_ticket",
        condition={"arguments": {"api_token": "raw-trust-token"}},
    )

    response = client.post("/api/mcp/export", json={"include_trust_rules": True})
    serialized = json.dumps(response.json(), ensure_ascii=False)

    assert response.status_code == 200
    assert response.json()["trust_rules"] == [
        {
            "scope": "global",
            "server_id": server.id,
            "raw_tool_name": "write_ticket",
            "rule_kind": "tool",
            "approval_mode": "approve",
            "condition": {"arguments": {"api_token": "***REDACTED***"}},
            "created_from_approval_id": None,
            "expires_at": None,
        }
    ]
    assert "raw-trust-token" not in serialized
