from __future__ import annotations

import json

import pytest

from backend.app.mcp.oauth import (
    InMemoryMcpOAuthSecretStore,
    McpOAuthProviderConfig,
    McpOAuthService,
    McpOAuthTokenResponse,
)
from backend.app.mcp.types import McpErrorCode
from backend.app.storage import StorageRepositories, init_database


def _repositories(tmp_path) -> StorageRepositories:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    repositories.mcp_servers.create(
        server_id="srv_oauth",
        name="OAuth MCP",
        transport="streamable_http",
        url="https://mcp.example.test/mcp",
        auth_type="oauth",
    )
    return repositories


def _provider_config() -> McpOAuthProviderConfig:
    return McpOAuthProviderConfig(
        authorization_url="https://mcp.example.test/oauth/authorize",
        token_url="https://mcp.example.test/oauth/token",
        client_id="client-id",
        redirect_uri="http://127.0.0.1:8765/api/mcp/oauth/callback",
        scopes=["tools:read"],
        resource="https://mcp.example.test",
    )


def test_oauth_start_returns_auth_url_and_writes_audit(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    service = McpOAuthService(
        repositories,
        secret_store=InMemoryMcpOAuthSecretStore(),
        token_exchanger=FakeTokenExchanger(),
    )

    started = service.start_authorization(server_id="srv_oauth", config=_provider_config())
    audits, total = repositories.mcp_audit_log.list(event_type="oauth.started")

    assert started.server_id == "srv_oauth"
    assert "state=" in started.auth_url
    assert "client_id=client-id" in started.auth_url
    assert total == 1
    assert audits[0].status == "pending"


@pytest.mark.asyncio
async def test_oauth_callback_state_mismatch_is_rejected_and_audited(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    service = McpOAuthService(
        repositories,
        secret_store=InMemoryMcpOAuthSecretStore(),
        token_exchanger=FakeTokenExchanger(),
    )

    with pytest.raises(Exception) as exc_info:
        await service.handle_callback(server_id="srv_oauth", state="bad-state", code="code")

    audits, total = repositories.mcp_audit_log.list(event_type="oauth.failed")
    status = repositories.mcp_server_status.get("srv_oauth")

    assert getattr(exc_info.value, "code", None) == McpErrorCode.VALIDATION_ERROR
    assert total == 1
    assert audits[0].detail == {"reason": "oauth_state_invalid"}
    assert status.status == "auth_required"


@pytest.mark.asyncio
async def test_oauth_callback_exchanges_token_and_stores_only_refs(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    secret_store = InMemoryMcpOAuthSecretStore()
    service = McpOAuthService(
        repositories,
        secret_store=secret_store,
        token_exchanger=FakeTokenExchanger(),
    )
    started = service.start_authorization(server_id="srv_oauth", config=_provider_config())

    status = await service.handle_callback(
        server_id="srv_oauth",
        state=started.state,
        code="code",
    )
    active = repositories.mcp_oauth_tokens.get_active_for_server("srv_oauth")
    audits, _total = repositories.mcp_audit_log.list(server_id="srv_oauth")
    serialized_audits = json.dumps([audit.detail for audit in audits], ensure_ascii=False)

    assert status.status == "active"
    assert status.token_configured is True
    assert active is not None
    assert active.token_ref.startswith("secret:mcp/oauth/srv_oauth/access_token/")
    assert active.refresh_token_ref.startswith("secret:mcp/oauth/srv_oauth/refresh_token/")
    assert secret_store.values[active.token_ref] == "raw-access-token"
    assert secret_store.values[active.refresh_token_ref] == "raw-refresh-token"
    assert active.scopes == ["tools:read"]
    assert "raw-access-token" not in serialized_audits
    assert "raw-refresh-token" not in serialized_audits


@pytest.mark.asyncio
async def test_oauth_clear_revokes_token_refs_and_marks_auth_required(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    secret_store = InMemoryMcpOAuthSecretStore()
    service = McpOAuthService(
        repositories,
        secret_store=secret_store,
        token_exchanger=FakeTokenExchanger(),
    )
    started = service.start_authorization(server_id="srv_oauth", config=_provider_config())
    await service.handle_callback(server_id="srv_oauth", state=started.state, code="code")

    cleared = service.clear_authorization("srv_oauth")
    active = repositories.mcp_oauth_tokens.get_active_for_server("srv_oauth")
    server_status = repositories.mcp_server_status.get("srv_oauth")

    assert cleared.status == "revoked"
    assert cleared.token_configured is False
    assert active is None
    assert secret_store.values == {}
    assert server_status.status == "auth_required"


@pytest.mark.asyncio
async def test_oauth_token_exchange_error_writes_failed_audit(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    service = McpOAuthService(
        repositories,
        secret_store=InMemoryMcpOAuthSecretStore(),
        token_exchanger=FakeTokenExchanger(raise_error=True),
    )
    started = service.start_authorization(server_id="srv_oauth", config=_provider_config())

    with pytest.raises(Exception) as exc_info:
        await service.handle_callback(server_id="srv_oauth", state=started.state, code="code")

    audits, total = repositories.mcp_audit_log.list(event_type="oauth.failed")
    server_status = repositories.mcp_server_status.get("srv_oauth")

    assert getattr(exc_info.value, "code", None) == McpErrorCode.AUTH_REQUIRED
    assert total == 1
    assert audits[0].detail == {"reason": "RuntimeError"}
    assert server_status.status == "auth_required"


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
