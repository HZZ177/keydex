from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from types import MappingProxyType
from typing import TYPE_CHECKING, Any, Literal, TypeVar, cast

if TYPE_CHECKING:
    from backend.app.keydex.capabilities.base import CapabilityKey

KeydexScope = Literal["builtin", "system", "workspace"]
KeydexRuntimeMode = Literal["system_only", "workspace_effective"]
CapabilityPayloadT = TypeVar("CapabilityPayloadT")


class KeydexCapabilityLookupError(LookupError):
    pass


class KeydexCapabilityMissingError(KeydexCapabilityLookupError):
    pass


class KeydexCapabilityTypeError(KeydexCapabilityLookupError, TypeError):
    pass


def resolve_system_keydex_root() -> Path:
    """Return the only production root for the user-level Keydex layer."""

    return (Path.home() / ".keydex").resolve()


@dataclass(frozen=True)
class KeydexDiagnostic:
    code: str
    reason: str
    path: str | None = None
    severity: Literal["warning", "error"] = "warning"
    details: Mapping[str, Any] = field(default_factory=dict)
    capability_id: str | None = None
    scope: KeydexScope | None = None
    logical_path: str | None = None

    def __post_init__(self) -> None:
        logical_path = self.logical_path if self.logical_path is not None else self.path
        if logical_path is not None:
            logical_path = _normalize_logical_locator(logical_path)
        object.__setattr__(self, "path", logical_path)
        object.__setattr__(self, "logical_path", logical_path)
        object.__setattr__(self, "details", MappingProxyType(dict(self.details)))

    def to_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "reason": self.reason,
            "path": self.path,
            "severity": self.severity,
            "details": dict(self.details),
            "capability_id": self.capability_id,
            "scope": self.scope,
            "logical_path": self.logical_path,
        }


KeydexSourceKind = Literal["file", "directory", "link", "special", "missing"]
KeydexSourceState = Literal["present", "missing", "invalid"]


@dataclass(frozen=True)
class KeydexSourceEvidence:
    capability_id: str
    scope: KeydexScope
    locator: str
    kind: KeydexSourceKind
    state: KeydexSourceState
    byte_size: int | None = None
    content_hash: str | None = None

    def __post_init__(self) -> None:
        if not self.capability_id.strip():
            raise ValueError("source evidence capability_id must not be empty")
        object.__setattr__(self, "locator", _normalize_logical_locator(self.locator))
        if self.byte_size is not None and self.byte_size < 0:
            raise ValueError("source evidence byte_size must not be negative")

    def to_payload(self) -> dict[str, Any]:
        return {
            "capability_id": self.capability_id,
            "scope": self.scope,
            "locator": self.locator,
            "kind": self.kind,
            "state": self.state,
            "byte_size": self.byte_size,
            "content_hash": self.content_hash,
        }


@dataclass(frozen=True)
class KeydexLayerDescriptor:
    scope: KeydexScope
    root: Path
    logical_root: str

    def __post_init__(self) -> None:
        normalized = self.logical_root.replace("\\", "/").strip("/")
        if not normalized:
            raise ValueError("logical layer root must not be empty")
        object.__setattr__(self, "root", Path(self.root).expanduser().resolve())
        object.__setattr__(self, "logical_root", normalized)


@dataclass(frozen=True)
class CapabilityLayerSnapshot:
    capability_id: str
    scope: KeydexScope
    payload: Any
    fingerprint: str
    available: bool = True
    supported: bool = True
    state: Literal["loaded", "empty", "failed", "unsupported"] = "loaded"
    sources: tuple[str, ...] = field(default_factory=tuple)
    evidence: tuple[KeydexSourceEvidence, ...] = field(default_factory=tuple)
    diagnostics: tuple[KeydexDiagnostic, ...] = field(default_factory=tuple)

    def __post_init__(self) -> None:
        if not self.capability_id.strip():
            raise ValueError("capability_id must not be empty")
        object.__setattr__(self, "sources", tuple(self.sources))
        object.__setattr__(self, "evidence", tuple(self.evidence))
        object.__setattr__(self, "diagnostics", tuple(self.diagnostics))
        if self.state == "unsupported" and self.supported:
            raise ValueError("unsupported capability layer must set supported=False")
        if self.state == "failed" and self.available:
            raise ValueError("failed capability layer must set available=False")


@dataclass(frozen=True)
class KeydexLayerSnapshot:
    descriptor: KeydexLayerDescriptor
    capabilities: Mapping[str, CapabilityLayerSnapshot]
    fingerprint: str
    loaded_at: datetime
    diagnostics: tuple[KeydexDiagnostic, ...] = field(default_factory=tuple)

    def __post_init__(self) -> None:
        copied = dict(self.capabilities)
        for capability_id, snapshot in copied.items():
            if capability_id != snapshot.capability_id:
                raise ValueError("capability map key must match snapshot capability_id")
            if snapshot.scope != self.descriptor.scope:
                raise ValueError("capability layer scope must match its layer descriptor")
        object.__setattr__(self, "capabilities", MappingProxyType(copied))
        object.__setattr__(self, "diagnostics", tuple(self.diagnostics))

    @property
    def scope(self) -> KeydexScope:
        return self.descriptor.scope


@dataclass(frozen=True)
class EffectiveCapabilitySnapshot:
    capability_id: str
    key: CapabilityKey[Any]
    payload: Any
    fingerprint: str
    available: bool = True
    sources: tuple[str, ...] = field(default_factory=tuple)
    diagnostics: tuple[KeydexDiagnostic, ...] = field(default_factory=tuple)

    def __post_init__(self) -> None:
        if self.capability_id != self.key.name:
            raise ValueError("effective capability id must match its typed key")
        object.__setattr__(self, "sources", tuple(self.sources))
        object.__setattr__(self, "diagnostics", tuple(self.diagnostics))


@dataclass(frozen=True)
class KeydexEffectiveSnapshot:
    mode: KeydexRuntimeMode
    layers: tuple[KeydexLayerSnapshot, ...]
    capabilities: Mapping[str, EffectiveCapabilitySnapshot]
    fingerprint: str
    loaded_at: datetime
    diagnostics: tuple[KeydexDiagnostic, ...] = field(default_factory=tuple)
    workspace_root: Path | None = None

    def __post_init__(self) -> None:
        layers = tuple(self.layers)
        scopes = tuple(layer.scope for layer in layers)
        if len(scopes) != len(set(scopes)):
            raise ValueError("effective snapshot layer scopes must be unique")
        if self.mode == "system_only" and "workspace" in scopes:
            raise ValueError("system_only snapshot must not include a workspace layer")
        if self.mode == "workspace_effective" and "workspace" not in scopes:
            raise ValueError("workspace_effective snapshot requires a workspace layer")
        copied = dict(self.capabilities)
        for capability_id, snapshot in copied.items():
            if capability_id != snapshot.capability_id:
                raise ValueError("effective capability map key must match snapshot id")
        workspace_root = (
            Path(self.workspace_root).expanduser().resolve()
            if self.workspace_root is not None
            else None
        )
        object.__setattr__(self, "layers", layers)
        object.__setattr__(self, "capabilities", MappingProxyType(copied))
        object.__setattr__(self, "diagnostics", tuple(self.diagnostics))
        object.__setattr__(self, "workspace_root", workspace_root)

    def get(self, key: CapabilityKey[CapabilityPayloadT]) -> CapabilityPayloadT | None:
        snapshot = self.capabilities.get(key.name)
        if snapshot is None:
            return None
        if snapshot.key.name != key.name:
            raise KeydexCapabilityTypeError(f"typed key mismatch for capability: {key.name}")
        if key.payload_type is not object and not isinstance(snapshot.payload, key.payload_type):
            raise KeydexCapabilityTypeError(
                f"capability payload type mismatch for {key.name}: "
                f"expected {key.payload_type!r}, got {type(snapshot.payload)!r}"
            )
        return cast(CapabilityPayloadT, snapshot.payload)

    def require(self, key: CapabilityKey[CapabilityPayloadT]) -> CapabilityPayloadT:
        payload = self.get(key)
        if payload is None:
            raise KeydexCapabilityMissingError(f"capability is not available: {key.name}")
        return payload

    def layer(self, scope: KeydexScope) -> KeydexLayerSnapshot | None:
        return next((layer for layer in self.layers if layer.scope == scope), None)


@dataclass(frozen=True)
class KeydexLayerProfile:
    scope: KeydexScope
    root: Path
    enabled: bool
    available: bool = True
    manifest: dict[str, Any] = field(default_factory=dict)
    diagnostics: tuple[KeydexDiagnostic, ...] = field(default_factory=tuple)

    def __post_init__(self) -> None:
        object.__setattr__(self, "root", Path(self.root).expanduser().resolve())
        object.__setattr__(self, "manifest", dict(self.manifest))
        object.__setattr__(self, "diagnostics", tuple(self.diagnostics))

    @property
    def skills_root(self) -> Path | None:
        if not self.available or not self.enabled:
            return None
        return (self.root / "skills").resolve()


# Transitional compatibility name. Product code migrates to the semantic name
# issue-by-issue without breaking the existing workspace runtime in between.
KeydexLayer = KeydexLayerProfile


@dataclass(frozen=True)
class KeydexEffectiveProfile:
    mode: KeydexRuntimeMode
    system: KeydexLayerProfile
    workspace: KeydexLayerProfile | None = None
    diagnostics: tuple[KeydexDiagnostic, ...] = field(default_factory=tuple)
    builtin: KeydexLayerProfile | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "diagnostics", tuple(self.diagnostics))
        if self.mode == "system_only" and self.workspace is not None:
            raise ValueError("system_only profile must not include a workspace layer")
        if self.mode == "workspace_effective" and self.workspace is None:
            raise ValueError("workspace_effective profile requires a workspace layer")


@dataclass(frozen=True)
class KeydexWorkspaceProfile:
    workspace_root: Path
    keydex_root: Path
    active_layers: list[KeydexLayer] = field(default_factory=list)
    skills_root: Path | None = None
    skills_enabled: bool = True
    available: bool = True
    diagnostics: list[KeydexDiagnostic] = field(default_factory=list)

    def __post_init__(self) -> None:
        workspace_root = Path(self.workspace_root).expanduser().resolve()
        keydex_root = Path(self.keydex_root).expanduser().resolve()
        skills_root = (
            Path(self.skills_root).expanduser().resolve() if self.skills_root is not None else None
        )
        object.__setattr__(self, "workspace_root", workspace_root)
        object.__setattr__(self, "keydex_root", keydex_root)
        object.__setattr__(self, "skills_root", skills_root)


def _normalize_logical_locator(value: str) -> str:
    raw = str(value).replace("\\", "/").strip()
    if not raw:
        raise ValueError("logical locator must not be empty")
    path = Path(raw)
    if path.is_absolute() or (len(raw) >= 2 and raw[1] == ":"):
        raise ValueError("logical locator must not be an absolute path")
    normalized = raw.strip("/")
    if normalized == ".." or normalized.startswith("../") or "/../" in f"/{normalized}/":
        raise ValueError("logical locator must stay inside its logical layer")
    return normalized
