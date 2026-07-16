from __future__ import annotations

from pathlib import Path

from backend.app.keydex.models import KeydexDiagnostic, KeydexLayerProfile, KeydexWorkspaceProfile
from backend.app.keydex.skills.frontmatter import parse_skill_frontmatter, validate_skill_name
from backend.app.keydex.skills.model import (
    SkillCatalog,
    SkillDefinition,
    SkillDefinitionError,
    SkillLayerCatalog,
    canonical_skill_name,
)
from backend.app.security.workspace import is_relative_to


def discover_workspace_skills(profile: KeydexWorkspaceProfile) -> SkillCatalog:
    layer = (
        profile.active_layers[0]
        if profile.active_layers
        else KeydexLayerProfile(
            scope="workspace",
            root=profile.keydex_root,
            enabled=profile.skills_enabled,
            available=profile.available,
            diagnostics=tuple(profile.diagnostics),
        )
    )
    layer_catalog = discover_layer_skills(layer)
    return SkillCatalog(
        keydex_profile=profile,
        skills=dict(layer_catalog.skills),
        diagnostics=list(layer_catalog.diagnostics),
        blocked_names=layer_catalog.blocked_names,
        available=layer_catalog.available,
    )


def discover_layer_skills(profile: KeydexLayerProfile) -> SkillLayerCatalog:
    diagnostics = list(profile.diagnostics)
    skills_root = profile.skills_root
    if not profile.available or not profile.enabled or skills_root is None:
        return SkillLayerCatalog(profile=profile, diagnostics=tuple(diagnostics))
    if not skills_root.is_dir():
        return SkillLayerCatalog(profile=profile, diagnostics=tuple(diagnostics))

    resolved_skills_root = skills_root.resolve()
    skills: dict[str, SkillDefinition] = {}
    names_by_canonical: dict[str, str] = {}
    blocked_names: set[str] = set()
    for entry in sorted(skills_root.iterdir(), key=lambda path: path.name.lower()):
        if not entry.is_dir():
            continue
        logical_root = "builtin" if profile.scope == "builtin" else ".keydex"
        logical_entry = f"{logical_root}/skills/{entry.name}/SKILL.md"
        try:
            directory_name = validate_skill_name(entry.name, path=logical_entry)
        except SkillDefinitionError as exc:
            diagnostics.append(
                KeydexDiagnostic(
                    code="skill_directory_name_invalid",
                    reason=exc.reason,
                    path=logical_entry,
                    severity="error",
                    details=exc.details,
                )
            )
            continue
        canonical_name = canonical_skill_name(directory_name)

        if _is_link_like(entry):
            blocked_names.add(canonical_name)
            diagnostics.append(
                KeydexDiagnostic(
                    code="skill_directory_invalid",
                    reason="skill candidate must be a real directory under the layer skills root",
                    path=logical_entry,
                    severity="error",
                )
            )
            continue
        skill_md = entry / "SKILL.md"
        if not skill_md.is_file() or _is_link_like(skill_md):
            blocked_names.add(canonical_name)
            diagnostics.append(
                KeydexDiagnostic(
                    code="skill_entry_missing",
                    reason="skill candidate must contain a regular SKILL.md entry file",
                    path=logical_entry,
                    severity="error",
                )
            )
            continue

        try:
            resolved_entry = entry.resolve()
            if not is_relative_to(resolved_entry, resolved_skills_root):
                raise SkillDefinitionError(
                    "skill_path_forbidden",
                    "resolved skill directory must stay under the layer skills root",
                    path=logical_entry,
                )
            metadata = parse_skill_frontmatter(skill_md)
            name = metadata["name"]
            description = metadata["description"]
            if name != entry.name:
                raise SkillDefinitionError(
                    "skill_name_mismatch",
                    "frontmatter name must match skill directory name",
                    path=logical_entry,
                    details={"name": name, "directory": entry.name},
                )
            resources = _list_skill_resources(entry)
            candidate = SkillDefinition(
                name=name,
                description=description,
                source=profile.scope,
                root_dir=entry,
                entry_file=skill_md,
                relative_entry=logical_entry,
                resources=resources,
            )
            existing_name = _register_layer_skill(
                candidate,
                skills=skills,
                names_by_canonical=names_by_canonical,
                blocked_names=blocked_names,
            )
            if existing_name is not None:
                diagnostics.append(
                    KeydexDiagnostic(
                        code="skill_name_duplicate",
                        reason=f"duplicate skill name in {profile.scope} source",
                        path=logical_entry,
                        severity="error",
                        details={"name": name, "conflicts_with": existing_name},
                    )
                )
                continue
        except SkillDefinitionError as exc:
            skills.pop(names_by_canonical.pop(canonical_name, ""), None)
            blocked_names.add(canonical_name)
            diagnostics.append(exc.to_diagnostic(path=logical_entry))

    ordered = {name: skills[name] for name in sorted(skills, key=str.lower)}
    return SkillLayerCatalog(
        profile=profile,
        skills=ordered,
        blocked_names=frozenset(blocked_names),
        diagnostics=tuple(diagnostics),
    )


def _list_skill_resources(skill_root: Path) -> list[str]:
    resources: list[str] = []
    for path in sorted(skill_root.rglob("*"), key=lambda item: item.as_posix().lower()):
        if _is_link_like(path):
            raise SkillDefinitionError(
                "skill_resource_invalid",
                "skill resources must not contain symlinks or junctions",
            )
        if path.is_dir():
            continue
        if not path.is_file():
            raise SkillDefinitionError(
                "skill_resource_invalid",
                "skill resources must contain regular files only",
            )
        if path.name == "SKILL.md" and path.parent == skill_root:
            continue
        if not is_relative_to(path.resolve(), skill_root.resolve()):
            raise SkillDefinitionError(
                "skill_resource_forbidden",
                "resolved resource must stay under the skill root",
            )
        try:
            resources.append(path.relative_to(skill_root).as_posix())
        except ValueError:
            raise SkillDefinitionError(
                "skill_resource_forbidden",
                "resource path must stay under the skill root",
            ) from None
    return resources


def _is_link_like(path: Path) -> bool:
    if path.is_symlink():
        return True
    is_junction = getattr(path, "is_junction", None)
    return bool(callable(is_junction) and is_junction())


def _register_layer_skill(
    skill: SkillDefinition,
    *,
    skills: dict[str, SkillDefinition],
    names_by_canonical: dict[str, str],
    blocked_names: set[str],
) -> str | None:
    canonical_name = canonical_skill_name(skill.name)
    if canonical_name in blocked_names:
        return names_by_canonical.get(canonical_name, skill.name)
    existing_name = names_by_canonical.get(canonical_name)
    if existing_name is not None:
        skills.pop(existing_name, None)
        names_by_canonical.pop(canonical_name, None)
        blocked_names.add(canonical_name)
        return existing_name
    skills[skill.name] = skill
    names_by_canonical[canonical_name] = skill.name
    return None
