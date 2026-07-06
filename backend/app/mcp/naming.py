from __future__ import annotations

import hashlib
import re
from collections.abc import Iterable
from dataclasses import dataclass

MAX_MODEL_NAME_LENGTH = 64
MAX_SERVER_SLUG_LENGTH = 24
MAX_TOOL_SLUG_LENGTH = 32


@dataclass(frozen=True)
class McpToolName:
    server_slug: str
    tool_slug: str
    callable_namespace: str
    callable_name: str
    model_name: str


@dataclass(frozen=True)
class ExistingMcpToolName:
    raw_name: str
    callable_namespace: str
    callable_name: str
    model_name: str


class McpToolNameAllocator:
    def __init__(self, used_model_names: Iterable[str] = ()) -> None:
        self._used_model_names = set(used_model_names)

    def allocate(
        self,
        *,
        server_id: str,
        raw_tool_name: str,
        existing: ExistingMcpToolName | None = None,
    ) -> McpToolName:
        if existing is not None:
            self._used_model_names.add(existing.model_name)
            return McpToolName(
                server_slug=_server_slug_from_namespace(existing.callable_namespace),
                tool_slug=existing.callable_name,
                callable_namespace=existing.callable_namespace,
                callable_name=existing.callable_name,
                model_name=existing.model_name,
            )

        server_slug = slug_identifier(
            server_id,
            fallback_prefix="server",
            max_length=MAX_SERVER_SLUG_LENGTH,
        )
        base_tool_slug = slug_identifier(
            raw_tool_name,
            fallback_prefix="tool",
            max_length=MAX_TOOL_SLUG_LENGTH,
        )
        namespace = f"mcp__{server_slug}"
        tool_slug = base_tool_slug
        model_name = _model_name(namespace, tool_slug)
        attempt = 0
        while model_name in self._used_model_names:
            attempt += 1
            tool_slug = _append_hash_suffix(
                base_tool_slug,
                f"{server_id}:{raw_tool_name}:{attempt}",
                max_length=MAX_TOOL_SLUG_LENGTH,
            )
            model_name = _model_name(namespace, tool_slug)
        self._used_model_names.add(model_name)
        return McpToolName(
            server_slug=server_slug,
            tool_slug=tool_slug,
            callable_namespace=namespace,
            callable_name=tool_slug,
            model_name=model_name,
        )


def slug_identifier(
    value: str,
    *,
    fallback_prefix: str,
    max_length: int,
) -> str:
    normalized = re.sub(r"[^a-zA-Z0-9_-]+", "_", value.strip()).strip("_").lower()
    normalized = re.sub(r"_+", "_", normalized)
    if not normalized:
        normalized = f"{fallback_prefix}_{_short_hash(value or fallback_prefix)}"
    if len(normalized) <= max_length:
        return normalized
    return _append_hash_suffix(normalized, value, max_length=max_length)


def _model_name(namespace: str, tool_slug: str) -> str:
    model_name = f"{namespace}__{tool_slug}"
    if len(model_name) <= MAX_MODEL_NAME_LENGTH:
        return model_name
    overflow = len(model_name) - MAX_MODEL_NAME_LENGTH
    max_tool_length = max(8, len(tool_slug) - overflow)
    truncated_tool = _append_hash_suffix(
        tool_slug,
        model_name,
        max_length=max_tool_length,
    )
    return f"{namespace}__{truncated_tool}"


def _append_hash_suffix(value: str, identity: str, *, max_length: int) -> str:
    suffix = f"_{_short_hash(identity)}"
    prefix_length = max(1, max_length - len(suffix))
    return f"{value[:prefix_length].rstrip('_')}{suffix}"


def _short_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:8]


def _server_slug_from_namespace(namespace: str) -> str:
    prefix = "mcp__"
    if namespace.startswith(prefix):
        return namespace[len(prefix) :]
    return namespace
