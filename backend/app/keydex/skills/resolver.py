from __future__ import annotations

from backend.app.keydex.models import KeydexDiagnostic
from backend.app.keydex.skills.model import (
    EffectiveSkillCatalog,
    SkillDefinition,
    SkillLayerCatalog,
    canonical_skill_name,
)


def resolve_system_skill_catalog(
    system: SkillLayerCatalog,
    *,
    builtin: SkillLayerCatalog | None = None,
) -> EffectiveSkillCatalog:
    diagnostics = [*(builtin.diagnostics if builtin is not None else ()), *system.diagnostics]
    skills: dict[str, SkillDefinition] = {}
    if builtin is not None and builtin.available:
        skills.update(builtin.skills)
    shadowed_names = _overlay_layer(
        skills,
        system,
        diagnostics=diagnostics,
        inherited_sources=("builtin",),
    )
    return EffectiveSkillCatalog(
        mode="system_only",
        skills=_sorted_skill_map(skills),
        diagnostics=tuple(diagnostics),
        available=system.available or bool(builtin is not None and builtin.available),
        shadowed_names=frozenset(shadowed_names),
    )


def resolve_workspace_skill_catalog(
    system: SkillLayerCatalog,
    workspace: SkillLayerCatalog,
    *,
    builtin: SkillLayerCatalog | None = None,
) -> EffectiveSkillCatalog:
    diagnostics = [
        *(builtin.diagnostics if builtin is not None else ()),
        *system.diagnostics,
        *workspace.diagnostics,
    ]

    result: dict[str, SkillDefinition] = {}
    if builtin is not None and builtin.available:
        result.update(builtin.skills)

    shadowed_names: set[str] = set()
    shadowed_names.update(
        _overlay_layer(
            result,
            system,
            diagnostics=diagnostics,
            inherited_sources=("builtin",),
        )
    )
    shadowed_names.update(
        _overlay_layer(
            result,
            workspace,
            diagnostics=diagnostics,
            inherited_sources=("system", "builtin"),
        )
    )

    return EffectiveSkillCatalog(
        mode="workspace_effective",
        skills=_sorted_skill_map(result),
        diagnostics=tuple(diagnostics),
        available=bool(
            workspace.available
            or system.available
            or (builtin is not None and builtin.available)
        ),
        shadowed_names=frozenset(shadowed_names),
    )


def resolve_effective_skill_catalog(
    system: SkillLayerCatalog,
    workspace: SkillLayerCatalog | None = None,
    *,
    builtin: SkillLayerCatalog | None = None,
) -> EffectiveSkillCatalog:
    if workspace is None:
        return resolve_system_skill_catalog(system, builtin=builtin)
    return resolve_workspace_skill_catalog(system, workspace, builtin=builtin)


def _overlay_layer(
    skills: dict[str, SkillDefinition],
    layer: SkillLayerCatalog,
    *,
    diagnostics: list[KeydexDiagnostic],
    inherited_sources: tuple[str, ...],
) -> set[str]:
    if not layer.available:
        return set()
    shadowed_names: set[str] = set()
    logical_root = "builtin" if layer.profile.scope == "builtin" else ".keydex"
    for blocked_name in sorted(layer.blocked_names):
        removed_sources = _remove_canonical_sources(skills, blocked_name)
        if not removed_sources:
            continue
        shadowed_names.add(blocked_name)
        diagnostics.append(
            KeydexDiagnostic(
                code="skill_shadow_barrier",
                reason=(
                    f"invalid {layer.profile.scope} Skill blocks the inherited lower-priority Skill"
                ),
                path=f"{logical_root}/skills/{blocked_name}/SKILL.md",
                severity="error",
                details={
                    "name": blocked_name,
                    "blocked_sources": sorted(set(removed_sources) & set(inherited_sources)),
                    "blocking_source": layer.profile.scope,
                },
            )
        )
    for skill in layer.sorted_skills():
        _remove_canonical(skills, canonical_skill_name(skill.name))
        skills[skill.name] = skill
    return shadowed_names


def _remove_canonical(skills: dict[str, SkillDefinition], canonical_name: str) -> bool:
    matching = [
        name for name in skills if canonical_skill_name(name) == canonical_name
    ]
    for name in matching:
        skills.pop(name, None)
    return bool(matching)


def _remove_canonical_sources(
    skills: dict[str, SkillDefinition],
    canonical_name: str,
) -> list[str]:
    matching = [
        name for name in skills if canonical_skill_name(name) == canonical_name
    ]
    sources = [skills[name].source for name in matching]
    for name in matching:
        skills.pop(name, None)
    return sources


def _sorted_skill_map(skills: dict[str, SkillDefinition]) -> dict[str, SkillDefinition]:
    return {
        name: skills[name]
        for name in sorted(skills, key=lambda value: (value.casefold(), value))
    }
