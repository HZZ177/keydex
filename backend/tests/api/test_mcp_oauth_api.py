from __future__ import annotations

from fastapi.testclient import TestClient

from backend.app.core.config import AppSettings
from backend.app.main import create_app
from backend.app.mcp.oauth import (
    InMemoryMcpOAuthSecretStore,
    McpOAuthProviderConfig,
    McpOAuthService,
    McpOAuthTokenResponse,
)


def _app_with_fake_oauth(tmp_path, *, raise_error: bool = False):
    app = create_app(AppSettings(data_dir=tmp_path / "data"))
    secret_store = InMemoryMcpOAuthSecretStore()
    app.state.mcp_oauth_secret_store = secret_store
    app.state.mcp_oauth_service = McpOAuthService(
        app.state.repositories,
        secret_store=secret_store,
        token_exchanger=FakeTokenExchanger(raise_error=raise_error),
    )
    return app, secret_store


def _create_oauth_server(app) -> None:
    app.state.repositories.mcp_servers.create(
        server_id="srv_oauth_api",
        name="OAuth API MCP",
        transport="streamable_http",
        url="https://mcp.example.test/mcp",
        auth_type="oauth",
        oauth_config={
            "authorization_url": "https://mcp.example.test/oauth/authorize",
            "token_url": "https://mcp.example.test/oauth/token",
            "client_id": "client-id",
            "client_secret": "client-secret",
            "redirect_uri": "http://127.0.0.1:8765/api/mcp/oauth/callback",
        },
        oauth_resource="https://mcp.example.test",
        oauth_scopes=["tools:read"],
    )


def test_mcp_oauth_api_completes_flow_without_returning_token_values(tmp_path) -> None:
    app, secret_store = _app_with_fake_oauth(tmp_path)
    _create_oauth_server(app)

    with TestClient(app) as client:
        started = client.post(
            "/api/mcp/servers/srv_oauth_api/oauth/start",
            json={"redirect_uri": "http://127.0.0.1:8765/custom/callback"},
        )
        assert started.status_code == 200
        start_payload = started.json()
        assert start_payload["server_id"] == "srv_oauth_api"
        assert "client_id=client-id" in start_payload["auth_url"]
        assert "redirect_uri=http%3A%2F%2F127.0.0.1%3A8765%2Fcustom%2Fcallback" in (
            start_payload["auth_url"]
        )

        completed = client.post(
            "/api/mcp/servers/srv_oauth_api/oauth/callback",
            json={"state": start_payload["state"], "code": "callback-code"},
        )
        status_response = client.get("/api/mcp/servers/srv_oauth_api/oauth/status")

    completed_payload = completed.json()
    status_payload = status_response.json()
    active = app.state.repositories.mcp_oauth_tokens.get_active_for_server("srv_oauth_api")

    assert completed.status_code == 200
    assert completed_payload["status"] == "active"
    assert completed_payload["token_configured"] is True
    assert "raw-access-token" not in str(completed_payload)
    assert "raw-refresh-token" not in str(completed_payload)
    assert status_response.status_code == 200
    assert status_payload["status"] == "active"
    assert active is not None
    assert secret_store.values[active.token_ref] == "raw-access-token"


def test_mcp_oauth_api_rejects_state_mismatch_and_marks_auth_required(tmp_path) -> None:
    app, _secret_store = _app_with_fake_oauth(tmp_path)
    _create_oauth_server(app)

    with TestClient(app) as client:
        response = client.post(
            "/api/mcp/servers/srv_oauth_api/oauth/callback",
            json={"state": "bad-state", "code": "callback-code"},
        )

    server_status = app.state.repositories.mcp_server_status.get("srv_oauth_api")

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "validation_error"
    assert server_status.status == "auth_required"


def test_mcp_oauth_api_reports_token_provider_error_without_token_values(tmp_path) -> None:
    app, secret_store = _app_with_fake_oauth(tmp_path, raise_error=True)
    _create_oauth_server(app)

    with TestClient(app) as client:
        started = client.post("/api/mcp/servers/srv_oauth_api/oauth/start", json={})
        response = client.post(
            "/api/mcp/servers/srv_oauth_api/oauth/callback",
            json={"state": started.json()["state"], "code": "callback-code"},
        )

    server_status = app.state.repositories.mcp_server_status.get("srv_oauth_api")
    payload_text = str(response.json())

    assert response.status_code == 401
    assert response.json()["detail"]["code"] == "auth_required"
    assert server_status.status == "auth_required"
    assert secret_store.values == {}
    assert "raw-access-token" not in payload_text
    assert "raw-refresh-token" not in payload_text


def test_mcp_oauth_api_clear_removes_active_token_and_keeps_values_private(tmp_path) -> None:
    app, secret_store = _app_with_fake_oauth(tmp_path)
    _create_oauth_server(app)

    with TestClient(app) as client:
        started = client.post("/api/mcp/servers/srv_oauth_api/oauth/start", json={})
        client.post(
            "/api/mcp/servers/srv_oauth_api/oauth/callback",
            json={"state": started.json()["state"], "code": "callback-code"},
        )
        cleared = client.delete("/api/mcp/servers/srv_oauth_api/oauth")

    active = app.state.repositories.mcp_oauth_tokens.get_active_for_server("srv_oauth_api")
    server_status = app.state.repositories.mcp_server_status.get("srv_oauth_api")

    assert cleared.status_code == 200
    assert cleared.json()["status"] == "revoked"
    assert cleared.json()["token_configured"] is False
    assert active is None
    assert secret_store.values == {}
    assert server_status.status == "auth_required"


def test_mcp_oauth_api_reports_invalid_server_config(tmp_path) -> None:
    app, _secret_store = _app_with_fake_oauth(tmp_path)
    app.state.repositories.mcp_servers.create(
        server_id="srv_invalid_oauth_api",
        name="Invalid OAuth MCP",
        transport="streamable_http",
        url="https://mcp.example.test/mcp",
        auth_type="oauth",
        oauth_config={"authorization_url": "https://mcp.example.test/oauth/authorize"},
    )

    with TestClient(app) as client:
        response = client.post("/api/mcp/servers/srv_invalid_oauth_api/oauth/start", json={})

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "mcp_oauth_config_invalid"


class FakeTokenExchanger:
    def __init__(self, *, raise_error: bool = False) -> None:
        self.raise_error = raise_error

    async def exchange_code(
        self,
        *,
        config: McpOAuthProviderConfig,
        code: str,
        state: str,
    ) -> McpOAuthTokenResponse:
        if self.raise_error:
            raise RuntimeError("exchange failed")
        return McpOAuthTokenResponse(
            access_token="raw-access-token",
            refresh_token="raw-refresh-token",
            expires_in=3600,
            scope="tools:read",
            account_label="test-account",
        )
