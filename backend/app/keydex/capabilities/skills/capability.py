from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Any

from backend.app.keydex.builtin_skills import load_builtin_skill_layer_profile
from backend.app.keydex.capabilities.base import (
    CapabilityComposeResult,
    CapabilityKey,
    CapabilityLoadResult,
    CapabilityWatchSpec,
)
from backend.app.keydex.models import KeydexLayerProfile, KeydexRuntimeMode, KeydexScope
from backend.app.keydex.skills import (
    KEYDEX_SKILL_MAX_ENTRY_BYTES,
    KEYDEX_SKILL_MAX_RESOURCE_BYTES,
    EffectiveSkillCatalog,
    SkillDefinition,
    SkillLayerCatalog,
    SkillResourcePathError,
    SkillTextResource,
    discover_layer_skills,
    normalize_skill_resource_path,
    read_skill_text_resource,
    resolve_effective_skill_catalog,
)


@dataclass(frozen=True)
class SkillsLayerPayload:
    catalog: SkillLayerCatalog
    resources: Mapping[tuple[str, str], SkillTextResource]
    resource_errors: Mapping[tuple[str, str], tuple[str, str]]

    def __post_init__(self) -> None:
        object.__setattr__(self, "resources", MappingProxyType(dict(self.resources)))
        object.__setattr__(
            self,
            "resource_errors",
            MappingProxyType(dict(self.resource_errors)),
        )


@dataclass(frozen=True)
class EffectiveSkillsPayload:
    catalog: EffectiveSkillCatalog
    layers: Mapping[KeydexScope, SkillsLayerPayload]

    def __post_init__(self) -> None:
        object.__setattr__(self, "layers", MappingProxyType(dict(self.layers)))

    def read_skill_text_resource(
        self,
        skill: SkillDefinition,
        resource_path: str | Path,
    ) -> SkillTextResource:
        logical_path = normalize_skill_resource_path(resource_path)
        layer = self.layers.get(skill.source)
        if layer is None:
            raise SkillResourcePathError(
                "skill_source_stale",
                "Skill source is not present in the turn snapshot.",
            )
        key = (skill.name, logical_path)
        error = layer.resource_errors.get(key)
        if error is not None:
            raise SkillResourcePathError(error[0], error[1])
        resource = layer.resources.get(key)
        if resource is None:
            raise SkillResourcePathError(
                "skill_resource_not_found",
                "Skill resource file was not found in the turn snapshot.",
            )
        return resource


SKILLS_CAPABILITY_KEY: CapabilityKey[EffectiveSkillsPayload] = CapabilityKey(
    "skills",
    EffectiveSkillsPayload,
)


class SkillsCapability:
    id = "skills"
    effective_key = SKILLS_CAPABILITY_KEY
    format_revision = "2"
    supported_scopes: frozenset[KeydexScope] = frozenset(
        {"builtin", "system", "workspace"}
    )
    watch_specs = (
        CapabilityWatchSpec(
            "catalog.json",
            supported_scopes=frozenset({"builtin"}),
        ),
        CapabilityWatchSpec(
            "skills",
            kind="subtree",
            supported_scopes=frozenset({"builtin", "system", "workspace"}),
        ),
    )

    def load_layer(
        self,
        *,
        scope: KeydexScope,
        root: Path,
    ) -> CapabilityLoadResult[SkillsLayerPayload]:
        profile = (
            load_builtin_skill_layer_profile(root)
            if scope == "builtin"
            else KeydexLayerProfile(
                scope=scope,
                root=root,
                enabled=root.is_dir(),
                available=True,
                manifest={},
            )
        )
        catalog = discover_layer_skills(profile)
        resources, resource_errors = capture_skills_layer_resources(catalog)
        payload = SkillsLayerPayload(
            catalog=catalog,
            resources=resources,
            resource_errors=resource_errors,
        )
        state = (
            "empty"
            if not catalog.skills and not catalog.blocked_names and not catalog.diagnostics
            else "loaded"
        )
        return CapabilityLoadResult(
            payload=payload,
            state=state,
            diagnostics=tuple(catalog.diagnostics),
        )

    def compose(
        self,
        *,
        mode: KeydexRuntimeMode,
        layers: tuple[Any, ...],
    ) -> CapabilityComposeResult[EffectiveSkillsPayload]:
        payloads = {
            layer.scope: layer.payload
            for layer in layers
            if layer.available and isinstance(layer.payload, SkillsLayerPayload)
        }
        catalogs = {
            layer.scope: (
                layer.payload.catalog
                if layer.available and isinstance(layer.payload, SkillsLayerPayload)
                else _unavailable_catalog(layer.scope, layer.diagnostics)
            )
            for layer in layers
        }
        builtin = catalogs.get("builtin")
        system = catalogs.get("system") or _unavailable_catalog("system", ())
        workspace = catalogs.get("workspace") if mode == "workspace_effective" else None
        catalog = resolve_effective_skill_catalog(
            system,
            workspace,
            builtin=builtin,
        )
        effective = EffectiveSkillsPayload(catalog=catalog, layers=payloads)
        return CapabilityComposeResult(
            payload=effective,
            available=catalog.available,
            sources=tuple(skill.relative_entry for skill in catalog.sorted_skills()),
            diagnostics=tuple(catalog.diagnostics),
        )


def capture_skills_layer_resources(
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


def _unavailable_catalog(
    scope: KeydexScope,
    diagnostics: tuple[Any, ...],
) -> SkillLayerCatalog:
    profile = KeydexLayerProfile(
        scope=scope,
        root=Path(f".keydex-unavailable-{scope}"),
        enabled=False,
        available=False,
        manifest={},
        diagnostics=diagnostics,
    )
    return SkillLayerCatalog(profile=profile, diagnostics=diagnostics)
