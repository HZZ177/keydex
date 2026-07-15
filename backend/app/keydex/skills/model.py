from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from types import MappingProxyType
from typing import Any, Literal

from backend.app.keydex.models import (
    KeydexDiagnostic,
    KeydexLayerProfile,
    KeydexRuntimeMode,
    KeydexWorkspaceProfile,
)

SkillSource = Literal["builtin", "system", "workspace"]


def canonical_skill_name(name: str) -> str:
    return str(name).casefold()


class SkillDefinitionError(ValueError):
    def __init__(
        self,
        code: str,
        reason: str,
        *,
        path: str | None = None,
        details: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(reason)
        self.code = code
        self.reason = reason
        self.path = path
        self.details = details or {}

    def to_diagnostic(self, *, path: str | None = None) -> KeydexDiagnostic:
        return KeydexDiagnostic(
            code=self.code,
            reason=self.reason,
            path=path or self.path,
            severity="error",
            details=self.details,
        )


@dataclass(frozen=True)
class SkillDefinition:
    name: str
    description: str
    source: SkillSource
    root_dir: Path
    entry_file: Path
    relative_entry: str
    resources: list[str] = field(default_factory=list)

    def __post_init__(self) -> None:
        object.__setattr__(self, "root_dir", Path(self.root_dir).expanduser().resolve())
        object.__setattr__(self, "entry_file", Path(self.entry_file).expanduser().resolve())

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "source": self.source,
            "root_dir": str(self.root_dir),
            "entry_file": str(self.entry_file),
            "relative_entry": self.relative_entry,
            "resources": list(self.resources),
        }

    def to_index_item(self) -> dict[str, str]:
        return {
            "name": self.name,
            "description": self.description,
            "source": self.source,
            "locator": self.relative_entry,
        }


@dataclass(frozen=True)
class SkillCatalog:
    keydex_profile: KeydexWorkspaceProfile
    skills: dict[str, SkillDefinition] = field(default_factory=dict)
    diagnostics: list[KeydexDiagnostic] = field(default_factory=list)
    blocked_names: frozenset[str] = field(default_factory=frozenset)
    available: bool = True

    def sorted_skills(self) -> list[SkillDefinition]:
        return [self.skills[name] for name in sorted(self.skills, key=str.lower)]


@dataclass(frozen=True)
class SkillLayerCatalog:
    profile: KeydexLayerProfile
    skills: dict[str, SkillDefinition] = field(default_factory=dict)
    blocked_names: frozenset[str] = field(default_factory=frozenset)
    diagnostics: tuple[KeydexDiagnostic, ...] = field(default_factory=tuple)

    def __post_init__(self) -> None:
        object.__setattr__(self, "skills", MappingProxyType(dict(self.skills)))
        object.__setattr__(self, "blocked_names", frozenset(self.blocked_names))
        object.__setattr__(self, "diagnostics", tuple(self.diagnostics))

    @property
    def available(self) -> bool:
        return self.profile.available

    def sorted_skills(self) -> list[SkillDefinition]:
        return [self.skills[name] for name in sorted(self.skills, key=str.casefold)]


@dataclass(frozen=True)
class EffectiveSkillCatalog:
    mode: KeydexRuntimeMode
    skills: dict[str, SkillDefinition] = field(default_factory=dict)
    diagnostics: tuple[KeydexDiagnostic, ...] = field(default_factory=tuple)
    available: bool = True
    inherit_system: bool = True
    shadowed_names: frozenset[str] = field(default_factory=frozenset)

    def __post_init__(self) -> None:
        object.__setattr__(self, "skills", MappingProxyType(dict(self.skills)))
        object.__setattr__(self, "diagnostics", tuple(self.diagnostics))
        object.__setattr__(self, "shadowed_names", frozenset(self.shadowed_names))

    def sorted_skills(self) -> list[SkillDefinition]:
        return [
            self.skills[name]
            for name in sorted(self.skills, key=lambda value: (value.casefold(), value))
        ]
