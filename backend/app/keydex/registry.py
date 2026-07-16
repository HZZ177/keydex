from __future__ import annotations

from collections.abc import Iterable, Iterator
from types import MappingProxyType
from typing import Any

from backend.app.keydex.capabilities.base import CapabilityKey, KeydexCapability
from backend.app.keydex.capabilities.keydex_markdown import KeydexMarkdownCapability
from backend.app.keydex.capabilities.skills import SkillsCapability
from backend.app.keydex.models import KeydexScope

KEYDEX_RUNTIME_REVISION = "2"


class KeydexCapabilityRegistry:
    """Immutable, code-versioned registry for all Keydex capabilities."""

    def __init__(self, capabilities: Iterable[KeydexCapability[Any, Any]]) -> None:
        ordered = tuple(capabilities)
        by_id: dict[str, KeydexCapability[Any, Any]] = {}
        by_key: dict[str, KeydexCapability[Any, Any]] = {}
        for capability in ordered:
            capability_id = capability.id.strip()
            if not capability_id:
                raise ValueError("capability id must not be empty")
            if capability_id in by_id:
                raise ValueError(f"duplicate capability id: {capability_id}")
            if capability.effective_key.name in by_key:
                raise ValueError(
                    f"duplicate capability typed key: {capability.effective_key.name}"
                )
            if not capability.format_revision.strip():
                raise ValueError(f"capability format revision must not be empty: {capability_id}")
            by_id[capability_id] = capability
            by_key[capability.effective_key.name] = capability
        self._ordered = ordered
        self._by_id = MappingProxyType(by_id)
        self._by_key = MappingProxyType(by_key)

    def __iter__(self) -> Iterator[KeydexCapability[Any, Any]]:
        return iter(self._ordered)

    def __len__(self) -> int:
        return len(self._ordered)

    @property
    def capabilities(self) -> tuple[KeydexCapability[Any, Any], ...]:
        return self._ordered

    def get(self, capability_id: str) -> KeydexCapability[Any, Any]:
        return self._by_id[capability_id]

    def get_by_key(
        self,
        key: CapabilityKey[Any],
    ) -> KeydexCapability[Any, Any]:
        return self._by_key[key.name]

    def watch_specs(self, scope: KeydexScope) -> tuple[tuple[str, Any], ...]:
        return tuple(
            (capability.id, spec)
            for capability in self._ordered
            if scope in capability.supported_scopes
            for spec in capability.watch_specs
            if scope in spec.supported_scopes
        )


DEFAULT_KEYDEX_CAPABILITY_REGISTRY = KeydexCapabilityRegistry(
    (SkillsCapability(), KeydexMarkdownCapability())
)
