from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any

from backend.app.mcp.audit import REDACTED_VALUE
from backend.app.mcp.errors import McpClientAuthError
from backend.app.mcp.secrets import (
    McpSecretResolver,
    SecretValueInput,
    resolve_secret_value,
)


@dataclass(frozen=True)
class McpHttpAuthConfig:
    headers: dict[str, SecretValueInput] = field(default_factory=dict)
    env_headers: dict[str, str] = field(default_factory=dict)
    bearer_token_env_var: str | None = None
    bearer_token: SecretValueInput | None = None
    bearer_token_prefix: str = "Bearer "


def compose_http_headers(
    config: McpHttpAuthConfig,
    *,
    environ: Mapping[str, str] | None = None,
    secret_resolver: McpSecretResolver | None = None,
) -> dict[str, str]:
    source_env = environ or os.environ
    headers = {
        str(key): resolve_secret_value(
            value,
            environ=source_env,
            secret_resolver=secret_resolver,
        )
        for key, value in config.headers.items()
    }
    for header_name, env_var in config.env_headers.items():
        value = source_env.get(env_var)
        if not value:
            raise McpClientAuthError(f"Missing environment variable for MCP header: {env_var}")
        headers[str(header_name)] = value
    if config.bearer_token is not None:
        token = resolve_secret_value(
            config.bearer_token,
            environ=source_env,
            secret_resolver=secret_resolver,
        )
        headers["Authorization"] = _with_prefix(token, config.bearer_token_prefix)
    elif config.bearer_token_env_var:
        token = source_env.get(config.bearer_token_env_var)
        if not token:
            raise McpClientAuthError(
                f"Missing environment variable for MCP bearer token: {config.bearer_token_env_var}"
            )
        headers["Authorization"] = f"Bearer {token}"
    return headers


def redact_http_headers(headers: Mapping[str, str]) -> dict[str, str]:
    redacted: dict[str, str] = {}
    for key, value in headers.items():
        normalized = key.lower().replace("-", "").replace("_", "")
        if normalized in {"authorization", "xapikey", "apikey"} or "token" in normalized:
            redacted[str(key)] = REDACTED_VALUE
        else:
            redacted[str(key)] = str(value)
    return redacted


def public_auth_headers(headers: Mapping[str, SecretValueInput]) -> dict[str, dict[str, Any]]:
    from backend.app.mcp.secrets import public_secret_value

    return {str(key): public_secret_value(value).to_dict() for key, value in headers.items()}


def _with_prefix(value: str, prefix: str) -> str:
    if not prefix:
        return value
    if value.startswith(prefix):
        return value
    return f"{prefix}{value}"
