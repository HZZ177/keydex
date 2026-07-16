from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Any, Generic, Literal, Protocol, TypeVar, runtime_checkable

from backend.app.keydex.models import (
    CapabilityLayerSnapshot,
    KeydexDiagnostic,
    KeydexRuntimeMode,
    KeydexScope,
)

LayerPayloadT = TypeVar("LayerPayloadT")
EffectivePayloadT = TypeVar("EffectivePayloadT")


@dataclass(frozen=True)
class CapabilityKey(Generic[EffectivePayloadT]):
    """A typed lookup key for one effective capability payload."""

    name: str
    payload_type: type[Any] | tuple[type[Any], ...] = object

    def __post_init__(self) -> None:
        if not self.name.strip():
            raise ValueError("capability key name must not be empty")


@dataclass(frozen=True)
class KeydexWatchSpec:
    """A logical source watched by a capability.

    ``relative_path`` is always relative to the physical Keydex layer root.
    Runtime code deliberately does not infer watch targets from capability ids.
    """

    relative_path: str
    kind: Literal["exact", "subtree"] = "exact"
    supported_scopes: frozenset[KeydexScope] = frozenset({"system", "workspace"})

    def __post_init__(self) -> None:
        normalized = self.relative_path.replace("\\", "/").strip("/")
        if not normalized or normalized in {".", ".."}:
            raise ValueError("watch relative_path must not be empty")
        if normalized.startswith("../") or "/../" in f"/{normalized}/":
            raise ValueError("watch relative_path must stay inside the layer root")
        object.__setattr__(self, "relative_path", normalized)
        object.__setattr__(self, "supported_scopes", frozenset(self.supported_scopes))

    @property
    def recursive(self) -> bool:
        return self.kind == "subtree"

    def match(
        self,
        *,
        scope: KeydexScope,
        layer_root: Path,
        changed_path: str | Path,
    ) -> str | None:
        if scope not in self.supported_scopes:
            return None
        root = Path(layer_root).expanduser().resolve(strict=False)
        raw = Path(changed_path).expanduser()
        target = (root / raw if not raw.is_absolute() else raw).resolve(strict=False)
        try:
            logical = target.relative_to(root).as_posix()
        except ValueError:
            return None
        if logical == self.relative_path:
            return logical
        if self.kind == "subtree" and logical.startswith(f"{self.relative_path}/"):
            return logical
        return None


# Compatibility import name used by the first registry issue.
CapabilityWatchSpec = KeydexWatchSpec


@dataclass(frozen=True)
class UnsupportedCapabilityLayer:
    """Neutral result returned before a loader is called for an unsupported scope."""

    capability_id: str
    scope: KeydexScope
    supported: bool = False
    available: bool = True
    payload: None = None


@dataclass(frozen=True)
class CapabilityLoadResult(Generic[LayerPayloadT]):
    payload: LayerPayloadT
    state: Literal["loaded", "empty"] = "loaded"
    diagnostics: tuple[KeydexDiagnostic, ...] = ()

    def __post_init__(self) -> None:
        object.__setattr__(self, "diagnostics", tuple(self.diagnostics))


class KeydexCapabilityLoadError(RuntimeError):
    def __init__(
        self,
        code: str,
        reason: str,
        *,
        logical_path: str | None = None,
        details: Mapping[str, Any] | None = None,
    ) -> None:
        super().__init__(reason)
        self.code = code
        self.reason = reason
        self.logical_path = logical_path
        self.details = MappingProxyType(dict(details or {}))


@dataclass(frozen=True)
class CapabilityComposeResult(Generic[EffectivePayloadT]):
    payload: EffectivePayloadT
    available: bool = True
    sources: tuple[str, ...] = ()
    diagnostics: tuple[KeydexDiagnostic, ...] = ()

    def __post_init__(self) -> None:
        object.__setattr__(self, "sources", tuple(self.sources))
        object.__setattr__(self, "diagnostics", tuple(self.diagnostics))


class KeydexCapabilityComposeError(RuntimeError):
    def __init__(
        self,
        code: str,
        reason: str,
        *,
        logical_path: str | None = None,
        details: Mapping[str, Any] | None = None,
    ) -> None:
        super().__init__(reason)
        self.code = code
        self.reason = reason
        self.logical_path = logical_path
        self.details = MappingProxyType(dict(details or {}))


@runtime_checkable
class KeydexCapability(Protocol[LayerPayloadT, EffectivePayloadT]):
    """Static extension contract for one code-shipped Keydex capability."""

    id: str
    effective_key: CapabilityKey[EffectivePayloadT]
    format_revision: str
    supported_scopes: frozenset[KeydexScope]
    watch_specs: tuple[KeydexWatchSpec, ...]

    def load_layer(
        self,
        *,
        scope: KeydexScope,
        root: Path,
    ) -> CapabilityLoadResult[LayerPayloadT]:
        """Capture one supported physical layer without composing inheritance."""

    def compose(
        self,
        *,
        mode: KeydexRuntimeMode,
        layers: tuple[CapabilityLayerSnapshot, ...],
    ) -> CapabilityComposeResult[EffectivePayloadT]:
        """Compose already captured layer payloads into the effective payload."""


def load_capability_layer(
    capability: KeydexCapability[Any, Any],
    *,
    scope: KeydexScope,
    root: Path,
) -> Any:
    """Apply scope gating before invoking a capability-specific loader."""

    if scope not in capability.supported_scopes:
        return UnsupportedCapabilityLayer(capability_id=capability.id, scope=scope)
    return capability.load_layer(scope=scope, root=root)
