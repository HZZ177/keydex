from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Literal, Protocol

from backend.app.mcp.errors import McpClientAuthError

McpSecretValueKind = Literal["plain", "env", "secret"]


class McpSecretResolver(Protocol):
    def resolve(self, secret_ref: str) -> str | None: ...


@dataclass(frozen=True)
class McpSecretValueRef:
    kind: McpSecretValueKind
    value: str
    prefix: str = ""

    @classmethod
    def plain(cls, value: str, *, prefix: str = "") -> McpSecretValueRef:
        return cls(kind="plain", value=value, prefix=prefix)

    @classmethod
    def env(cls, name: str, *, prefix: str = "") -> McpSecretValueRef:
        return cls(kind="env", value=name, prefix=prefix)

    @classmethod
    def secret(cls, ref: str, *, prefix: str = "") -> McpSecretValueRef:
        return cls(kind="secret", value=ref, prefix=prefix)


SecretValueInput = str | Mapping[str, Any] | McpSecretValueRef


@dataclass(frozen=True)
class McpPublicSecretValue:
    kind: McpSecretValueKind
    configured: bool
    placeholder: str
    env_var: str | None = None
    secret_ref: str | None = None
    prefix_configured: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "configured": self.configured,
            "placeholder": self.placeholder,
            "env_var": self.env_var,
            "secret_ref": self.secret_ref,
            "prefix_configured": self.prefix_configured,
        }


class InMemoryMcpSecretResolver:
    def __init__(self, secrets: Mapping[str, str] | None = None) -> None:
        self._secrets = dict(secrets or {})

    def resolve(self, secret_ref: str) -> str | None:
        return self._secrets.get(secret_ref)


def parse_secret_value_ref(value: SecretValueInput) -> McpSecretValueRef:
    if isinstance(value, McpSecretValueRef):
        return value
    if isinstance(value, Mapping):
        kind = str(value.get("kind") or value.get("type") or "").strip()
        prefix = str(value.get("prefix") or "")
        if kind == "plain":
            return McpSecretValueRef.plain(str(value.get("value") or ""), prefix=prefix)
        if kind == "env":
            env_name = str(value.get("name") or value.get("value") or "")
            return McpSecretValueRef.env(env_name, prefix=prefix)
        if kind == "secret":
            return McpSecretValueRef.secret(
                str(value.get("ref") or value.get("value") or ""),
                prefix=prefix,
            )
        raise McpClientAuthError("Unsupported MCP secret value reference kind")
    if value.startswith("env:"):
        return McpSecretValueRef.env(value.removeprefix("env:"))
    if value.startswith("secret:"):
        return McpSecretValueRef.secret(value.removeprefix("secret:"))
    return McpSecretValueRef.plain(value)


def resolve_secret_value(
    value: SecretValueInput,
    *,
    environ: Mapping[str, str] | None = None,
    secret_resolver: McpSecretResolver | None = None,
) -> str:
    ref = parse_secret_value_ref(value)
    if not ref.value:
        raise McpClientAuthError("MCP secret value reference is empty")
    if ref.kind == "plain":
        resolved = ref.value
    elif ref.kind == "env":
        source_env = environ or os.environ
        resolved = source_env.get(ref.value)
        if not resolved:
            raise McpClientAuthError(f"Missing environment variable for MCP secret: {ref.value}")
    else:
        if secret_resolver is None:
            raise McpClientAuthError("MCP secret resolver is required")
        resolved = secret_resolver.resolve(ref.value)
        if not resolved:
            raise McpClientAuthError(f"MCP secret reference was not found: {ref.value}")
    return f"{ref.prefix}{resolved}"


def public_secret_value(value: SecretValueInput) -> McpPublicSecretValue:
    ref = parse_secret_value_ref(value)
    configured = bool(ref.value)
    if ref.kind == "env":
        return McpPublicSecretValue(
            kind=ref.kind,
            configured=configured,
            placeholder=f"env:{ref.value}" if configured else "env:missing",
            env_var=ref.value or None,
            prefix_configured=bool(ref.prefix),
        )
    if ref.kind == "secret":
        return McpPublicSecretValue(
            kind=ref.kind,
            configured=configured,
            placeholder="secret:configured" if configured else "secret:missing",
            secret_ref=ref.value or None,
            prefix_configured=bool(ref.prefix),
        )
    return McpPublicSecretValue(
        kind=ref.kind,
        configured=configured,
        placeholder="configured" if configured else "missing",
        prefix_configured=bool(ref.prefix),
    )
