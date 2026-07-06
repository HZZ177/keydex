from __future__ import annotations

import secrets as py_secrets
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any, Protocol
from urllib.parse import urlencode

import httpx

from backend.app.core.ids import new_id
from backend.app.core.time import to_iso_z, utc_now
from backend.app.mcp.audit import McpAuditWriter
from backend.app.mcp.errors import McpClientAuthError, McpRuntimeError
from backend.app.mcp.types import McpErrorCode
from backend.app.storage import McpOAuthTokenRecord, StorageRepositories


@dataclass(frozen=True)
class McpOAuthProviderConfig:
    authorization_url: str
    token_url: str
    client_id: str
    redirect_uri: str
    scopes: list[str] = field(default_factory=list)
    resource: str | None = None
    client_secret: str | None = None
    extra_authorization_params: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class McpOAuthStartResult:
    server_id: str
    auth_url: str
    state: str


@dataclass(frozen=True)
class McpOAuthTokenResponse:
    access_token: str
    refresh_token: str | None = None
    expires_in: int | None = None
    scope: str | None = None
    account_label: str | None = None


@dataclass(frozen=True)
class McpOAuthStatus:
    server_id: str
    status: str
    token_configured: bool
    account_label: str | None = None
    scopes: list[Any] | None = None
    expires_at: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "server_id": self.server_id,
            "status": self.status,
            "token_configured": self.token_configured,
            "account_label": self.account_label,
            "scopes": self.scopes or [],
            "expires_at": self.expires_at,
        }


@dataclass(frozen=True)
class _PendingOAuthState:
    server_id: str
    config: McpOAuthProviderConfig


class McpOAuthTokenExchanger(Protocol):
    async def exchange_code(
        self,
        *,
        config: McpOAuthProviderConfig,
        code: str,
        state: str,
    ) -> McpOAuthTokenResponse: ...


class McpOAuthSecretStore(Protocol):
    def store_token(self, *, server_id: str, token_kind: str, value: str) -> str: ...

    def delete(self, secret_ref: str) -> None: ...


class InMemoryMcpOAuthSecretStore:
    def __init__(self) -> None:
        self.values: dict[str, str] = {}

    def store_token(self, *, server_id: str, token_kind: str, value: str) -> str:
        secret_ref = f"secret:mcp/oauth/{server_id}/{token_kind}/{new_id()}"
        self.values[secret_ref] = value
        return secret_ref

    def delete(self, secret_ref: str) -> None:
        self.values.pop(secret_ref, None)


class HttpxMcpOAuthTokenExchanger:
    def __init__(self, *, timeout_sec: float = 30) -> None:
        self.timeout_sec = timeout_sec

    async def exchange_code(
        self,
        *,
        config: McpOAuthProviderConfig,
        code: str,
        state: str,
    ) -> McpOAuthTokenResponse:
        data: dict[str, str] = {
            "grant_type": "authorization_code",
            "code": code,
            "client_id": config.client_id,
            "redirect_uri": config.redirect_uri,
        }
        if config.client_secret:
            data["client_secret"] = config.client_secret
        async with httpx.AsyncClient(timeout=self.timeout_sec) as client:
            response = await client.post(config.token_url, data=data)
            response.raise_for_status()
            payload = response.json()
        access_token = str(payload.get("access_token") or "")
        if not access_token:
            raise McpClientAuthError("OAuth token response did not include access_token")
        return McpOAuthTokenResponse(
            access_token=access_token,
            refresh_token=payload.get("refresh_token"),
            expires_in=payload.get("expires_in"),
            scope=payload.get("scope"),
            account_label=payload.get("account_label"),
        )


class McpOAuthService:
    def __init__(
        self,
        repositories: StorageRepositories,
        *,
        secret_store: McpOAuthSecretStore,
        token_exchanger: McpOAuthTokenExchanger | None = None,
        audit_writer: McpAuditWriter | None = None,
    ) -> None:
        self.repositories = repositories
        self.secret_store = secret_store
        self.token_exchanger = token_exchanger or HttpxMcpOAuthTokenExchanger()
        self.audit_writer = audit_writer or McpAuditWriter.from_repositories(repositories)
        self._pending_states: dict[str, _PendingOAuthState] = {}

    def start_authorization(
        self,
        *,
        server_id: str,
        config: McpOAuthProviderConfig,
    ) -> McpOAuthStartResult:
        state = py_secrets.token_urlsafe(32)
        self._pending_states[state] = _PendingOAuthState(server_id=server_id, config=config)
        query = {
            "response_type": "code",
            "client_id": config.client_id,
            "redirect_uri": config.redirect_uri,
            "state": state,
        }
        if config.scopes:
            query["scope"] = " ".join(config.scopes)
        if config.resource:
            query["resource"] = config.resource
        query.update(config.extra_authorization_params)
        auth_url = f"{config.authorization_url}?{urlencode(query)}"
        self.audit_writer.append_event(
            event_type="oauth.started",
            server_id=server_id,
            status="pending",
            summary="OAuth authorization started",
            detail={"scopes": config.scopes, "resource": config.resource},
        )
        return McpOAuthStartResult(server_id=server_id, auth_url=auth_url, state=state)

    async def handle_callback(
        self,
        *,
        server_id: str,
        state: str,
        code: str,
    ) -> McpOAuthStatus:
        pending = self._pending_states.pop(state, None)
        if pending is None or pending.server_id != server_id:
            self._mark_auth_required(server_id, "oauth_state_invalid")
            self._audit_failed(server_id, "oauth_state_invalid")
            raise McpRuntimeError(McpErrorCode.VALIDATION_ERROR, "OAuth state mismatch.")
        try:
            token = await self.token_exchanger.exchange_code(
                config=pending.config,
                code=code,
                state=state,
            )
        except Exception as exc:
            self._mark_auth_required(server_id, "oauth_token_exchange_failed")
            self._audit_failed(server_id, type(exc).__name__)
            raise McpRuntimeError(
                McpErrorCode.AUTH_REQUIRED,
                "OAuth token exchange failed.",
            ) from exc

        token_ref = self.secret_store.store_token(
            server_id=server_id,
            token_kind="access_token",
            value=token.access_token,
        )
        refresh_ref = (
            self.secret_store.store_token(
                server_id=server_id,
                token_kind="refresh_token",
                value=token.refresh_token,
            )
            if token.refresh_token
            else None
        )
        expires_at = _expires_at(token.expires_in)
        scopes = token.scope.split() if token.scope else list(pending.config.scopes)
        record = self.repositories.mcp_oauth_tokens.upsert_for_server(
            server_id=server_id,
            token_ref=token_ref,
            refresh_token_ref=refresh_ref,
            account_label=token.account_label,
            scopes=scopes,
            expires_at=expires_at,
            status="active",
        )
        self.repositories.mcp_server_status.upsert(server_id, status="unknown")
        self.audit_writer.append_event(
            event_type="oauth.completed",
            server_id=server_id,
            status="success",
            summary="OAuth authorization completed",
            detail={"token_id": record.id, "scopes": scopes, "expires_at": expires_at},
        )
        return _status_from_record(record)

    def get_status(self, server_id: str) -> McpOAuthStatus:
        active = self.repositories.mcp_oauth_tokens.get_active_for_server(server_id)
        if active is not None:
            return _status_from_record(active)
        records, _total = self.repositories.mcp_oauth_tokens.list(server_id=server_id, limit=1)
        if records:
            return _status_from_record(records[0], token_configured=False)
        return McpOAuthStatus(server_id=server_id, status="revoked", token_configured=False)

    def clear_authorization(self, server_id: str) -> McpOAuthStatus:
        records, _total = self.repositories.mcp_oauth_tokens.list(server_id=server_id, limit=500)
        for record in records:
            self.secret_store.delete(record.token_ref)
            if record.refresh_token_ref:
                self.secret_store.delete(record.refresh_token_ref)
        self.repositories.mcp_oauth_tokens.clear_for_server(server_id, status="revoked")
        self._mark_auth_required(server_id, "oauth_cleared")
        self.audit_writer.append_event(
            event_type="oauth.failed" if not records else "oauth.completed",
            server_id=server_id,
            status="revoked",
            summary="OAuth credentials cleared",
        )
        return McpOAuthStatus(server_id=server_id, status="revoked", token_configured=False)

    def _mark_auth_required(self, server_id: str, reason: str) -> None:
        self.repositories.mcp_server_status.update_error(
            server_id,
            status="auth_required",
            error_code=reason,
            error_message="MCP server requires OAuth authorization.",
        )

    def _audit_failed(self, server_id: str, reason: str) -> None:
        self.audit_writer.append_event(
            event_type="oauth.failed",
            server_id=server_id,
            status="error",
            summary="OAuth authorization failed",
            detail={"reason": reason},
        )


def config_from_server_oauth(
    oauth_config: Mapping[str, Any],
    *,
    resource: str | None = None,
    scopes: list[str] | None = None,
) -> McpOAuthProviderConfig:
    authorization_url = str(
        oauth_config.get("authorization_url") or oauth_config.get("auth_url") or ""
    ).strip()
    token_url = str(oauth_config.get("token_url") or "").strip()
    client_id = str(oauth_config.get("client_id") or "").strip()
    redirect_uri = str(oauth_config.get("redirect_uri") or "").strip()
    if not authorization_url or not token_url or not client_id or not redirect_uri:
        raise McpClientAuthError(
            "OAuth config requires authorization_url, token_url, client_id, redirect_uri"
        )
    return McpOAuthProviderConfig(
        authorization_url=authorization_url,
        token_url=token_url,
        client_id=client_id,
        client_secret=oauth_config.get("client_secret"),
        redirect_uri=redirect_uri,
        scopes=scopes or list(oauth_config.get("scopes") or []),
        resource=resource or oauth_config.get("resource"),
        extra_authorization_params=dict(oauth_config.get("extra_authorization_params") or {}),
    )


def _expires_at(expires_in: int | None) -> str | None:
    if not expires_in:
        return None
    return to_iso_z(utc_now() + timedelta(seconds=int(expires_in)))


def _status_from_record(
    record: McpOAuthTokenRecord,
    *,
    token_configured: bool = True,
) -> McpOAuthStatus:
    return McpOAuthStatus(
        server_id=record.server_id,
        status=record.status,
        token_configured=token_configured and record.status == "active",
        account_label=record.account_label,
        scopes=record.scopes,
        expires_at=record.expires_at,
    )
