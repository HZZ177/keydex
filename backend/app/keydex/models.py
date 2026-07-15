from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

KeydexScope = Literal["builtin", "system", "workspace"]
KeydexRuntimeMode = Literal["system_only", "workspace_effective"]


def resolve_system_keydex_root() -> Path:
    """Return the only production root for the user-level Keydex layer."""

    return (Path.home() / ".keydex").resolve()


@dataclass(frozen=True)
class KeydexDiagnostic:
    code: str
    reason: str
    path: str | None = None
    severity: Literal["warning", "error"] = "warning"
    details: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "code": self.code,
            "reason": self.reason,
            "path": self.path,
            "severity": self.severity,
            "details": self.details,
        }


@dataclass(frozen=True)
class KeydexLayerProfile:
    scope: KeydexScope
    root: Path
    enabled: bool
    available: bool = True
    inherit_system: bool = True
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
    inherit_system: bool = True
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
