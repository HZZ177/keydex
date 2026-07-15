from __future__ import annotations

import hashlib
import json
import os
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from types import MappingProxyType
from typing import Any

from backend.app.core.time import utc_now
from backend.app.keydex.builtin_skills import (
    BUILTIN_SKILLS_ROOT,
    load_builtin_skill_layer_profile,
)
from backend.app.keydex.models import (
    KeydexDiagnostic,
    KeydexLayerProfile,
    KeydexRuntimeMode,
    KeydexScope,
    KeydexWorkspaceProfile,
)
from backend.app.keydex.profile import (
    load_keydex_layer_profile,
    load_keydex_system_profile,
    load_keydex_workspace_profile,
)
from backend.app.keydex.skills import (
    KEYDEX_SKILL_MAX_ENTRY_BYTES,
    KEYDEX_SKILL_MAX_RESOURCE_BYTES,
    EffectiveSkillCatalog,
    SkillCatalog,
    SkillDefinition,
    SkillLayerCatalog,
    SkillResourcePathError,
    SkillTextResource,
    discover_layer_skills,
    discover_workspace_skills,
    normalize_skill_resource_path,
    read_skill_text_resource,
    resolve_effective_skill_catalog,
)

FileFingerprint = tuple[str, str, int | None, int | None, str | None]


class KeydexSnapshotUnstableError(RuntimeError):
    pass


@dataclass(frozen=True)
class KeydexLayerFingerprint:
    scope: KeydexScope
    root: Path
    root_digest: str
    entries: tuple[FileFingerprint, ...]

    def __post_init__(self) -> None:
        object.__setattr__(self, "root", Path(self.root).expanduser().resolve())
        object.__setattr__(self, "entries", tuple(self.entries))

    def to_payload(self) -> dict[str, Any]:
        return {
            "scope": self.scope,
            "root_digest": self.root_digest,
            "entries": self.entries,
        }

    def digest(self) -> str:
        return _payload_digest(self.to_payload())


# Transitional name retained while workspace-only consumers are migrated.
KeydexWorkspaceFingerprint = KeydexLayerFingerprint


@dataclass(frozen=True)
class KeydexLayerRuntimeSnapshot:
    profile: KeydexLayerProfile
    skill_catalog: SkillLayerCatalog
    fingerprint: str
    loaded_at: datetime
    diagnostics: tuple[KeydexDiagnostic, ...]
    skill_resources: Mapping[tuple[str, str], SkillTextResource]
    skill_resource_errors: Mapping[tuple[str, str], tuple[str, str]]

    def __post_init__(self) -> None:
        object.__setattr__(self, "skill_resources", MappingProxyType(dict(self.skill_resources)))
        object.__setattr__(
            self,
            "skill_resource_errors",
            MappingProxyType(dict(self.skill_resource_errors)),
        )

    @property
    def scope(self) -> KeydexScope:
        return self.profile.scope


@dataclass(frozen=True)
class KeydexEffectiveRuntimeSnapshot:
    mode: KeydexRuntimeMode
    system_layer: KeydexLayerRuntimeSnapshot
    workspace_layer: KeydexLayerRuntimeSnapshot | None
    skill_catalog: EffectiveSkillCatalog
    fingerprint: str
    loaded_at: datetime
    diagnostics: tuple[KeydexDiagnostic, ...]
    workspace_root: Path | None = None
    builtin_layer: KeydexLayerRuntimeSnapshot | None = None

    def __post_init__(self) -> None:
        workspace_root = (
            Path(self.workspace_root).expanduser().resolve()
            if self.workspace_root is not None
            else None
        )
        object.__setattr__(self, "workspace_root", workspace_root)
        object.__setattr__(self, "diagnostics", tuple(self.diagnostics))
        if self.mode == "system_only" and self.workspace_layer is not None:
            raise ValueError("system_only snapshot must not include a workspace layer")
        if self.mode == "workspace_effective" and self.workspace_layer is None:
            raise ValueError("workspace_effective snapshot requires a workspace layer")

    @property
    def system_fingerprint(self) -> str:
        return self.system_layer.fingerprint

    @property
    def workspace_fingerprint(self) -> str | None:
        return self.workspace_layer.fingerprint if self.workspace_layer is not None else None

    @property
    def builtin_fingerprint(self) -> str | None:
        return self.builtin_layer.fingerprint if self.builtin_layer is not None else None

    def read_skill_text_resource(
        self,
        skill: SkillDefinition,
        resource_path: str | Path,
    ) -> SkillTextResource:
        logical_path = normalize_skill_resource_path(resource_path)
        layer = self._layer_for_source(skill.source)
        key = (skill.name, logical_path)
        error = layer.skill_resource_errors.get(key)
        if error is not None:
            raise SkillResourcePathError(error[0], error[1])
        resource = layer.skill_resources.get(key)
        if resource is None:
            raise SkillResourcePathError(
                "skill_resource_not_found",
                "Skill resource file was not found in the turn snapshot.",
            )
        return resource

    def _layer_for_source(self, source: KeydexScope) -> KeydexLayerRuntimeSnapshot:
        if source == "builtin" and self.builtin_layer is not None:
            return self.builtin_layer
        if source == "system":
            return self.system_layer
        if source == "workspace" and self.workspace_layer is not None:
            return self.workspace_layer
        raise SkillResourcePathError(
            "skill_source_stale",
            "Skill source is not present in the turn snapshot.",
        )


@dataclass(frozen=True)
class KeydexWorkspaceRuntimeSnapshot:
    """Legacy workspace-only view kept until Chat/API consumers migrate."""

    workspace_root: Path
    keydex_profile: KeydexWorkspaceProfile
    skill_catalog: SkillCatalog
    fingerprint: str
    loaded_at: datetime
    diagnostics: list[KeydexDiagnostic]

    def __post_init__(self) -> None:
        object.__setattr__(self, "workspace_root", Path(self.workspace_root).expanduser().resolve())


def build_keydex_layer_fingerprint(
    scope: KeydexScope,
    keydex_root: str | Path,
    *,
    attempts: int = 3,
) -> KeydexLayerFingerprint:
    root = Path(keydex_root).expanduser().resolve()
    last_error: OSError | None = None
    for _ in range(max(1, attempts)):
        try:
            return _sample_layer_fingerprint(scope, root)
        except OSError as exc:
            last_error = exc
    raise KeydexSnapshotUnstableError(
        f"unable to sample a stable {scope} .keydex tree"
    ) from last_error


def build_keydex_workspace_fingerprint(
    workspace_root: str | Path,
) -> KeydexWorkspaceFingerprint:
    root = Path(workspace_root).expanduser().resolve()
    return build_keydex_layer_fingerprint("workspace", root / ".keydex")


def build_keydex_layer_runtime_snapshot(
    scope: KeydexScope,
    keydex_root: str | Path,
    *,
    attempts: int = 3,
) -> KeydexLayerRuntimeSnapshot:
    root = Path(keydex_root).expanduser().resolve()
    for _ in range(max(1, attempts)):
        before = build_keydex_layer_fingerprint(scope, root)
        profile = (
            load_builtin_skill_layer_profile(root)
            if scope == "builtin"
            else load_keydex_layer_profile(scope, root)
        )
        catalog = discover_layer_skills(profile)
        skill_resources, skill_resource_errors = _capture_layer_skill_resources(catalog)
        after = build_keydex_layer_fingerprint(scope, root)
        if before.digest() == after.digest():
            return KeydexLayerRuntimeSnapshot(
                profile=profile,
                skill_catalog=catalog,
                fingerprint=after.digest(),
                loaded_at=utc_now(),
                diagnostics=tuple(catalog.diagnostics),
                skill_resources=skill_resources,
                skill_resource_errors=skill_resource_errors,
            )
    raise KeydexSnapshotUnstableError(f"{scope} .keydex changed while building its snapshot")


def build_keydex_system_layer_runtime_snapshot(
    system_root: str | Path | None = None,
) -> KeydexLayerRuntimeSnapshot:
    profile = load_keydex_system_profile(system_root)
    return build_keydex_layer_runtime_snapshot("system", profile.root)


def build_keydex_builtin_layer_runtime_snapshot(
    builtin_root: str | Path | None = None,
) -> KeydexLayerRuntimeSnapshot:
    root = (
        BUILTIN_SKILLS_ROOT
        if builtin_root is None
        else Path(builtin_root).expanduser().resolve()
    )
    return build_keydex_layer_runtime_snapshot("builtin", root)


def build_keydex_workspace_layer_runtime_snapshot(
    workspace_root: str | Path,
) -> KeydexLayerRuntimeSnapshot:
    root = Path(workspace_root).expanduser().resolve()
    return build_keydex_layer_runtime_snapshot("workspace", root / ".keydex")


def _capture_layer_skill_resources(
    catalog: SkillLayerCatalog,
) -> tuple[
    dict[tuple[str, str], SkillTextResource],
    dict[tuple[str, str], tuple[str, str]],
]:
    resources: dict[tuple[str, str], SkillTextResource] = {}
    errors: dict[tuple[str, str], tuple[str, str]] = {}
    for skill in catalog.sorted_skills():
        for directory in sorted(
            (path for path in skill.root_dir.rglob("*") if path.is_dir()),
            key=lambda path: path.as_posix().casefold(),
        ):
            logical_directory = directory.relative_to(skill.root_dir).as_posix()
            errors[(skill.name, logical_directory)] = (
                "skill_resource_not_file",
                "Skill resource path must point to a regular file.",
            )
        for logical_path in ("SKILL.md", *skill.resources):
            key = (skill.name, logical_path)
            try:
                resources[key] = read_skill_text_resource(
                    skill,
                    logical_path,
                    max_bytes=(
                        KEYDEX_SKILL_MAX_ENTRY_BYTES
                        if logical_path == "SKILL.md"
                        else KEYDEX_SKILL_MAX_RESOURCE_BYTES
                    ),
                )
            except SkillResourcePathError as exc:
                errors[key] = (exc.code, exc.reason)
    return resources, errors


def build_keydex_system_effective_snapshot(
    system_root: str | Path | None = None,
    *,
    builtin_root: str | Path | None = None,
) -> KeydexEffectiveRuntimeSnapshot:
    builtin_layer = build_keydex_builtin_layer_runtime_snapshot(builtin_root)
    system_layer = build_keydex_system_layer_runtime_snapshot(system_root)
    return compose_keydex_effective_runtime_snapshot(
        system_layer,
        builtin_layer=builtin_layer,
    )


def build_keydex_workspace_effective_snapshot(
    workspace_root: str | Path,
    *,
    system_root: str | Path | None = None,
    builtin_root: str | Path | None = None,
) -> KeydexEffectiveRuntimeSnapshot:
    resolved_workspace_root = Path(workspace_root).expanduser().resolve()
    builtin_layer = build_keydex_builtin_layer_runtime_snapshot(builtin_root)
    system_layer = build_keydex_system_layer_runtime_snapshot(system_root)
    workspace_layer = build_keydex_workspace_layer_runtime_snapshot(resolved_workspace_root)
    return compose_keydex_effective_runtime_snapshot(
        system_layer,
        workspace_layer,
        workspace_root=resolved_workspace_root,
        builtin_layer=builtin_layer,
    )


def compose_keydex_effective_runtime_snapshot(
    system_layer: KeydexLayerRuntimeSnapshot,
    workspace_layer: KeydexLayerRuntimeSnapshot | None = None,
    *,
    workspace_root: str | Path | None = None,
    builtin_layer: KeydexLayerRuntimeSnapshot | None = None,
) -> KeydexEffectiveRuntimeSnapshot:
    mode: KeydexRuntimeMode = (
        "system_only" if workspace_layer is None else "workspace_effective"
    )
    catalog = resolve_effective_skill_catalog(
        system_layer.skill_catalog,
        workspace_layer.skill_catalog if workspace_layer is not None else None,
        builtin=builtin_layer.skill_catalog if builtin_layer is not None else None,
    )
    inherit_system = (
        workspace_layer.profile.inherit_system if workspace_layer is not None else True
    )
    effective_system_fingerprint = (
        system_layer.fingerprint if workspace_layer is None or inherit_system else None
    )
    resolved_workspace_root = (
        Path(workspace_root).expanduser().resolve()
        if workspace_root is not None
        else workspace_layer.profile.root.parent.resolve()
        if workspace_layer is not None
        else None
    )
    fingerprint = _effective_digest(
        mode=mode,
        builtin_fingerprint=(
            builtin_layer.fingerprint if builtin_layer is not None else None
        ),
        system_fingerprint=effective_system_fingerprint,
        workspace_fingerprint=(
            workspace_layer.fingerprint if workspace_layer is not None else None
        ),
        inherit_system=inherit_system,
        available=catalog.available,
    )
    return KeydexEffectiveRuntimeSnapshot(
        mode=mode,
        system_layer=system_layer,
        workspace_layer=workspace_layer,
        skill_catalog=catalog,
        fingerprint=fingerprint,
        loaded_at=utc_now(),
        diagnostics=tuple(catalog.diagnostics),
        workspace_root=resolved_workspace_root,
        builtin_layer=builtin_layer,
    )


def build_keydex_workspace_runtime_snapshot(
    workspace_root: str | Path,
) -> KeydexWorkspaceRuntimeSnapshot:
    """Build the legacy workspace-only snapshot with the new complete fingerprint."""

    profile = load_keydex_workspace_profile(workspace_root)
    catalog = discover_workspace_skills(profile)
    fingerprint = build_keydex_workspace_fingerprint(profile.workspace_root).digest()
    return KeydexWorkspaceRuntimeSnapshot(
        workspace_root=profile.workspace_root,
        keydex_profile=profile,
        skill_catalog=catalog,
        fingerprint=fingerprint,
        loaded_at=utc_now(),
        diagnostics=list(catalog.diagnostics),
    )


def _sample_layer_fingerprint(scope: KeydexScope, root: Path) -> KeydexLayerFingerprint:
    entries: list[FileFingerprint] = []
    logical_root = "builtin" if scope == "builtin" else ".keydex"
    if root.exists():
        entries.append(_path_fingerprint(root, root, logical_path=logical_root))
    manifest_path = root / ("catalog.json" if scope == "builtin" else "keydex.json")
    if manifest_path.exists():
        entries.append(
            _path_fingerprint(
                root,
                manifest_path,
                logical_path=f"{logical_root}/{manifest_path.name}",
            )
        )
    skills_root = root / "skills"
    if skills_root.exists():
        entries.append(
            _path_fingerprint(root, skills_root, logical_path=f"{logical_root}/skills")
        )
        for path in sorted(
            skills_root.rglob("*"),
            key=lambda item: (item.as_posix().casefold(), item.as_posix()),
        ):
            relative = path.relative_to(root).as_posix()
            entries.append(
                _path_fingerprint(root, path, logical_path=f"{logical_root}/{relative}")
            )
    root_text = root.as_posix()
    if os.name == "nt":
        root_text = root_text.casefold()
    return KeydexLayerFingerprint(
        scope=scope,
        root=root,
        root_digest=hashlib.sha256(root_text.encode("utf-8")).hexdigest(),
        entries=tuple(entries),
    )


def _path_fingerprint(root: Path, path: Path, *, logical_path: str) -> FileFingerprint:
    if path.is_symlink():
        stat = path.lstat()
        return (logical_path, "link", stat.st_mtime_ns, stat.st_size, None)
    is_junction = getattr(path, "is_junction", None)
    if callable(is_junction) and is_junction():
        stat = path.lstat()
        return (logical_path, "junction", stat.st_mtime_ns, stat.st_size, None)
    if path.is_dir():
        stat = path.stat()
        return (logical_path, "directory", stat.st_mtime_ns, 0, None)
    if path.is_file():
        before = path.stat()
        content = path.read_bytes()
        after = path.stat()
        if (
            before.st_mtime_ns != after.st_mtime_ns
            or before.st_size != after.st_size
            or len(content) != after.st_size
        ):
            raise OSError(f"file changed while fingerprinting: {logical_path}")
        return (
            logical_path,
            "file",
            after.st_mtime_ns,
            after.st_size,
            hashlib.sha256(content).hexdigest(),
        )
    stat = path.lstat()
    return (logical_path, "special", stat.st_mtime_ns, stat.st_size, None)


def _effective_digest(
    *,
    mode: KeydexRuntimeMode,
    builtin_fingerprint: str | None,
    system_fingerprint: str | None,
    workspace_fingerprint: str | None,
    inherit_system: bool,
    available: bool,
) -> str:
    return _payload_digest(
        {
            "mode": mode,
            "builtin_fingerprint": builtin_fingerprint,
            "system_fingerprint": system_fingerprint,
            "workspace_fingerprint": workspace_fingerprint,
            "inherit_system": inherit_system,
            "available": available,
        }
    )


def _payload_digest(payload: dict[str, Any]) -> str:
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()
