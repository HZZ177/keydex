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
from backend.app.keydex.capabilities.skills import capture_skills_layer_resources
from backend.app.keydex.models import (
    KeydexDiagnostic,
    KeydexLayerProfile,
    KeydexRuntimeMode,
    KeydexScope,
    KeydexSourceEvidence,
    KeydexWorkspaceProfile,
)
from backend.app.keydex.profile import (
    load_keydex_layer_profile,
    load_keydex_system_profile,
    load_keydex_workspace_profile,
)
from backend.app.keydex.registry import (
    DEFAULT_KEYDEX_CAPABILITY_REGISTRY,
    KEYDEX_RUNTIME_REVISION,
    KeydexCapabilityRegistry,
)
from backend.app.keydex.skills import (
    EffectiveSkillCatalog,
    SkillCatalog,
    SkillDefinition,
    SkillLayerCatalog,
    SkillResourcePathError,
    SkillTextResource,
    discover_layer_skills,
    discover_workspace_skills,
    normalize_skill_resource_path,
    resolve_effective_skill_catalog,
)

FileFingerprint = tuple[str, str, int | None, int | None, str | None]


class KeydexSnapshotUnstableError(RuntimeError):
    code = "keydex_snapshot_unstable"

    def __init__(self, reason: str, *, scope: KeydexScope | None = None) -> None:
        super().__init__(reason)
        self.reason = reason
        self.scope = scope


@dataclass(frozen=True)
class KeydexCapabilityFingerprint:
    capability_id: str
    format_revision: str
    evidence: tuple[KeydexSourceEvidence, ...]

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "evidence",
            tuple(sorted(self.evidence, key=lambda item: item.locator)),
        )

    def to_payload(self) -> dict[str, Any]:
        return {
            "capability_id": self.capability_id,
            "format_revision": self.format_revision,
            "evidence": tuple(item.to_payload() for item in self.evidence),
        }

    def digest(self) -> str:
        return _payload_digest(self.to_payload())


@dataclass(frozen=True)
class KeydexLayerFingerprint:
    scope: KeydexScope
    root: Path
    runtime_revision: str
    root_evidence: KeydexSourceEvidence
    capabilities: tuple[KeydexCapabilityFingerprint, ...]

    def __post_init__(self) -> None:
        object.__setattr__(self, "root", Path(self.root).expanduser().resolve())
        object.__setattr__(self, "capabilities", tuple(self.capabilities))

    @property
    def root_digest(self) -> str:
        return hashlib.sha256(self.scope.encode("utf-8")).hexdigest()

    @property
    def entries(self) -> tuple[FileFingerprint, ...]:
        evidence = (
            self.root_evidence,
            *(item for capability in self.capabilities for item in capability.evidence),
        )
        return tuple(
            (
                item.locator,
                item.kind,
                None,
                item.byte_size,
                item.content_hash,
            )
            for item in evidence
        )

    @property
    def capability_fingerprints(self) -> Mapping[str, str]:
        return MappingProxyType(
            {capability.capability_id: capability.digest() for capability in self.capabilities}
        )

    def to_payload(self) -> dict[str, Any]:
        return {
            "scope": self.scope,
            "runtime_revision": self.runtime_revision,
            "root": self.root_evidence.to_payload(),
            "capabilities": tuple(item.to_payload() for item in self.capabilities),
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
    registry: KeydexCapabilityRegistry = DEFAULT_KEYDEX_CAPABILITY_REGISTRY,
    runtime_revision: str = KEYDEX_RUNTIME_REVISION,
) -> KeydexLayerFingerprint:
    root = Path(keydex_root).expanduser().resolve()
    last_error: OSError | None = None
    for _ in range(max(1, attempts)):
        try:
            return _sample_layer_fingerprint(
                scope,
                root,
                registry=registry,
                runtime_revision=runtime_revision,
            )
        except OSError as exc:
            last_error = exc
    raise KeydexSnapshotUnstableError(
        f"unable to sample a stable {scope} Keydex layer",
        scope=scope,
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
    raise KeydexSnapshotUnstableError(
        f"{scope} Keydex layer changed while building its snapshot",
        scope=scope,
    )


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
    return capture_skills_layer_resources(catalog)


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
        system_fingerprint=system_layer.fingerprint,
        workspace_fingerprint=(
            workspace_layer.fingerprint if workspace_layer is not None else None
        ),
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


def _sample_layer_fingerprint(
    scope: KeydexScope,
    root: Path,
    *,
    registry: KeydexCapabilityRegistry,
    runtime_revision: str,
) -> KeydexLayerFingerprint:
    logical_root = "builtin" if scope == "builtin" else ".keydex"
    root_evidence = _path_evidence(
        capability_id="__layer__",
        scope=scope,
        path=root,
        logical_path=logical_root,
    )
    capability_fingerprints: list[KeydexCapabilityFingerprint] = []
    for capability in registry:
        if scope not in capability.supported_scopes:
            continue
        evidence: list[KeydexSourceEvidence] = []
        for spec in capability.watch_specs:
            if scope not in spec.supported_scopes:
                continue
            source = root / spec.relative_path
            logical_source = f"{logical_root}/{spec.relative_path}"
            evidence.append(
                _path_evidence(
                    capability_id=capability.id,
                    scope=scope,
                    path=source,
                    logical_path=logical_source,
                )
            )
            if spec.recursive and _is_real_directory(source):
                for path in sorted(
                    source.rglob("*"),
                    key=lambda item: (item.as_posix().casefold(), item.as_posix()),
                ):
                    relative = path.relative_to(root).as_posix()
                    evidence.append(
                        _path_evidence(
                            capability_id=capability.id,
                            scope=scope,
                            path=path,
                            logical_path=f"{logical_root}/{relative}",
                        )
                    )
        capability_fingerprints.append(
            KeydexCapabilityFingerprint(
                capability_id=capability.id,
                format_revision=capability.format_revision,
                evidence=tuple(evidence),
            )
        )
    return KeydexLayerFingerprint(
        scope=scope,
        root=root,
        runtime_revision=runtime_revision,
        root_evidence=root_evidence,
        capabilities=tuple(capability_fingerprints),
    )


def _path_evidence(
    *,
    capability_id: str,
    scope: KeydexScope,
    path: Path,
    logical_path: str,
) -> KeydexSourceEvidence:
    if path.is_symlink():
        stat = path.lstat()
        target_hash = hashlib.sha256(os.readlink(path).encode("utf-8")).hexdigest()
        return KeydexSourceEvidence(
            capability_id=capability_id,
            scope=scope,
            locator=logical_path,
            kind="link",
            state="invalid",
            byte_size=stat.st_size,
            content_hash=target_hash,
        )
    is_junction = getattr(path, "is_junction", None)
    if callable(is_junction) and is_junction():
        stat = path.lstat()
        return KeydexSourceEvidence(
            capability_id=capability_id,
            scope=scope,
            locator=logical_path,
            kind="link",
            state="invalid",
            byte_size=stat.st_size,
        )
    if path.is_dir():
        return KeydexSourceEvidence(
            capability_id=capability_id,
            scope=scope,
            locator=logical_path,
            kind="directory",
            state="present",
            byte_size=0,
        )
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
        return KeydexSourceEvidence(
            capability_id=capability_id,
            scope=scope,
            locator=logical_path,
            kind="file",
            state="present",
            byte_size=after.st_size,
            content_hash=hashlib.sha256(content).hexdigest(),
        )
    if not path.exists():
        return KeydexSourceEvidence(
            capability_id=capability_id,
            scope=scope,
            locator=logical_path,
            kind="missing",
            state="missing",
        )
    stat = path.lstat()
    return KeydexSourceEvidence(
        capability_id=capability_id,
        scope=scope,
        locator=logical_path,
        kind="special",
        state="invalid",
        byte_size=stat.st_size,
    )


def _is_real_directory(path: Path) -> bool:
    if path.is_symlink():
        return False
    is_junction = getattr(path, "is_junction", None)
    return path.is_dir() and not (callable(is_junction) and is_junction())


def _effective_digest(
    *,
    mode: KeydexRuntimeMode,
    builtin_fingerprint: str | None,
    system_fingerprint: str | None,
    workspace_fingerprint: str | None,
    available: bool,
) -> str:
    return _payload_digest(
        {
            "mode": mode,
            "builtin_fingerprint": builtin_fingerprint,
            "system_fingerprint": system_fingerprint,
            "workspace_fingerprint": workspace_fingerprint,
            "available": available,
        }
    )


def _payload_digest(payload: dict[str, Any]) -> str:
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, default=str)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()
