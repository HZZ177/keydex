from __future__ import annotations

import json

import pytest

from backend.app.mcp.audit import REDACTED_VALUE
from backend.app.mcp.auth import (
    McpHttpAuthConfig,
    compose_http_headers,
    public_auth_headers,
    redact_http_headers,
)
from backend.app.mcp.errors import McpClientAuthError
from backend.app.mcp.secrets import (
    InMemoryMcpSecretResolver,
    McpSecretValueRef,
    public_secret_value,
    resolve_secret_value,
)


def test_env_reference_resolves_with_prefix(monkeypatch) -> None:
    monkeypatch.setenv("MCP_TOKEN", "raw-env-token")

    resolved = resolve_secret_value(
        {"type": "env", "name": "MCP_TOKEN", "prefix": "Bearer "},
    )

    assert resolved == "Bearer raw-env-token"


def test_missing_env_reference_raises_auth_error() -> None:
    with pytest.raises(McpClientAuthError, match="Missing environment variable"):
        resolve_secret_value("env:MISSING_MCP_TOKEN", environ={})


def test_secret_reference_resolves_through_resolver_without_public_leak() -> None:
    resolver = InMemoryMcpSecretResolver({"mcp/header-token": "raw-secret-token"})

    resolved = resolve_secret_value(
        McpSecretValueRef.secret("mcp/header-token", prefix="Bearer "),
        secret_resolver=resolver,
    )
    public = public_secret_value(McpSecretValueRef.secret("mcp/header-token")).to_dict()
    serialized = json.dumps(public, ensure_ascii=False)

    assert resolved == "Bearer raw-secret-token"
    assert public["configured"] is True
    assert public["placeholder"] == "secret:configured"
    assert "raw-secret-token" not in serialized


def test_compose_headers_supports_secret_ref_and_bearer_prefix() -> None:
    resolver = InMemoryMcpSecretResolver(
        {
            "mcp/header-token": "raw-header-secret",
            "mcp/bearer-token": "raw-bearer-secret",
        }
    )

    headers = compose_http_headers(
        McpHttpAuthConfig(
            headers={
                "X-Api-Key": {"type": "secret", "ref": "mcp/header-token"},
                "X-Plain": "plain-header",
            },
            bearer_token=McpSecretValueRef.secret("mcp/bearer-token"),
        ),
        secret_resolver=resolver,
    )

    assert headers["X-Api-Key"] == "raw-header-secret"
    assert headers["X-Plain"] == "plain-header"
    assert headers["Authorization"] == "Bearer raw-bearer-secret"
    assert redact_http_headers(headers)["Authorization"] == REDACTED_VALUE
    assert redact_http_headers(headers)["X-Api-Key"] == REDACTED_VALUE


def test_missing_secret_reference_raises_auth_error() -> None:
    with pytest.raises(McpClientAuthError, match="secret reference was not found"):
        compose_http_headers(
            McpHttpAuthConfig(
                headers={"X-Api-Key": {"type": "secret", "ref": "mcp/missing"}},
            ),
            secret_resolver=InMemoryMcpSecretResolver({}),
        )


def test_public_auth_headers_and_plain_public_dump_do_not_include_secret_values() -> None:
    public_headers = public_auth_headers(
        {
            "Authorization": {"type": "secret", "ref": "mcp/bearer-token", "prefix": "Bearer "},
            "X-Plain": "raw-plain-secret",
            "X-Env": "env:MCP_TOKEN",
        }
    )
    serialized = json.dumps(public_headers, ensure_ascii=False)
    public_plain = public_secret_value(McpSecretValueRef.plain("raw-plain-secret")).to_dict()

    assert public_headers["Authorization"]["placeholder"] == "secret:configured"
    assert public_headers["X-Env"]["placeholder"] == "env:MCP_TOKEN"
    assert public_plain["placeholder"] == "configured"
    assert "raw-plain-secret" not in serialized
    assert "raw-plain-secret" not in json.dumps(public_plain, ensure_ascii=False)
