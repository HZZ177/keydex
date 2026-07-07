from __future__ import annotations

import json

import pytest
from pydantic import ValidationError

from backend.app.mcp.errors import McpRuntimeError
from backend.app.mcp.types import (
    McpApprovalMode,
    McpAuthType,
    McpErrorCode,
    McpRuntimeSnapshotSummary,
    McpServerCreateRequest,
    McpServerDetailResponse,
    McpServerStatus,
    McpServerSummary,
    McpToolSummary,
    McpTransport,
)


def test_server_create_request_rejects_invalid_transport() -> None:
    with pytest.raises(ValidationError):
        McpServerCreateRequest(name="files", transport="websocket")


def test_server_summary_rejects_invalid_status() -> None:
    with pytest.raises(ValidationError):
        McpServerSummary(
            id="srv_1",
            name="files",
            enabled=True,
            required=False,
            transport=McpTransport.STDIO,
            status="waiting",
        )


def test_tool_summary_rejects_invalid_approval_mode() -> None:
    with pytest.raises(ValidationError):
        McpToolSummary(
            id="tool_1",
            server_id="srv_1",
            server_name="files",
            raw_name="read_file",
            model_name="mcp__files__read_file",
            enabled=True,
            hidden=False,
            effective_state="enabled",
            approval_mode="always",
        )


def test_server_default_approval_mode_rejects_session_only_modes() -> None:
    with pytest.raises(ValidationError):
        McpServerCreateRequest(
            name="files",
            transport=McpTransport.STDIO,
            command="mcp-files",
            default_tool_approval_mode=McpApprovalMode.INHERIT,
        )

    with pytest.raises(ValidationError):
        McpServerCreateRequest(
            name="files",
            transport=McpTransport.STDIO,
            command="mcp-files",
            default_tool_approval_mode=McpApprovalMode.DENY,
        )


def test_public_server_detail_does_not_dump_raw_secret_values() -> None:
    request = McpServerCreateRequest(
        name=" secure files ",
        description="Local file MCP",
        transport=McpTransport.STREAMABLE_HTTP,
        url="https://mcp.example.test/messages",
        headers={"Authorization": "Bearer raw-header-token"},
        env_headers={"X-Api-Key": "MCP_API_KEY"},
        auth_type=McpAuthType.OAUTH,
        secret_refs={"api_key": "secret:raw-value"},
        oauth_config={
            "client_id": "client-id",
            "client_secret": "raw-oauth-secret",
            "authorization_url": "https://mcp.example.test/oauth/authorize",
        },
        oauth_resource="https://mcp.example.test",
        oauth_scopes=["tools:read"],
    )

    response = McpServerDetailResponse.from_create_request(
        server_id="srv_1",
        request=request,
        status=McpServerStatus.AUTH_REQUIRED,
    )
    dumped = response.model_dump(mode="json")
    serialized = json.dumps(dumped, ensure_ascii=False)

    assert response.name == "secure files"
    assert dumped["auth"]["headers_configured"] is True
    assert dumped["auth"]["env_headers_configured"] is True
    assert dumped["auth"]["oauth_configured"] is True
    assert dumped["auth"]["secret_ref_keys"] == ["api_key"]
    assert "raw-header-token" not in serialized
    assert "raw-oauth-secret" not in serialized
    assert "secret:raw-value" not in serialized


def test_runtime_snapshot_summary_dump_protocol_values() -> None:
    snapshot = McpRuntimeSnapshotSummary(
        snapshot_id="snap_1",
        session_id="ses_1",
        turn_id="turn_1",
        servers_total=2,
        servers_online=1,
        tools_visible=5,
        tools_disabled_for_session=1,
        pending_approvals=0,
        created_at="2026-07-06T00:00:00Z",
    )

    assert snapshot.model_dump(mode="json")["snapshot_id"] == "snap_1"


def test_mcp_error_code_is_json_serializable() -> None:
    error = McpRuntimeError(
        McpErrorCode.SERVER_OFFLINE,
        detail={"server_id": "srv_1"},
    )

    payload = error.to_payload().model_dump(mode="json")

    assert payload == {
        "code": "server_offline",
        "message": "MCP 服务器当前不可用，请检查连接配置或服务状态。",
        "detail": {"server_id": "srv_1"},
    }
    json.dumps(payload)


def test_mcp_error_payload_redacts_sensitive_detail_fields() -> None:
    error = McpRuntimeError(
        McpErrorCode.AUTH_REQUIRED,
        detail={
            "server_id": "srv_1",
            "Authorization": "Bearer sk-secret",
            "nested": {
                "api_key": "sk-nested",
                "token_value": "token-nested",
                "safe": "visible",
            },
            "headers": [
                {"X-Secret-Token": "secret-header"},
                {"X-Request-Id": "request-1"},
            ],
        },
    )

    payload = error.to_payload().model_dump(mode="json")

    assert payload["message"] == "MCP 服务器需要认证，请完成登录或补充凭据。"
    assert payload["detail"] == {
        "server_id": "srv_1",
        "Authorization": "***REDACTED***",
        "nested": {
            "api_key": "***REDACTED***",
            "token_value": "***REDACTED***",
            "safe": "visible",
        },
        "headers": [
            {"X-Secret-Token": "***REDACTED***"},
            {"X-Request-Id": "request-1"},
        ],
    }
