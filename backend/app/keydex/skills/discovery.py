from __future__ import annotations

from pathlib import Path

from backend.app.keydex.models import KeydexWorkspaceProfile
from backend.app.keydex.skills.frontmatter import parse_skill_frontmatter
from backend.app.keydex.skills.model import SkillCatalog, SkillDefinition, SkillDefinitionError
from backend.app.security.workspace import is_relative_to


def discover_workspace_skills(profile: KeydexWorkspaceProfile) -> SkillCatalog:
    diagnostics = list(profile.diagnostics)
    skills_root = profile.skills_root
    if not profile.skills_enabled or skills_root is None or not skills_root.is_dir():
        return SkillCatalog(keydex_profile=profile, skills={}, diagnostics=diagnostics)

    resolved_skills_root = skills_root.resolve()
    skills: dict[str, SkillDefinition] = {}
    for entry in sorted(skills_root.iterdir(), key=lambda path: path.name.lower()):
        if not entry.is_dir():
            continue
        skill_md = entry / "SKILL.md"
        if not skill_md.is_file():
            continue

        relative_entry = _relative_to_workspace(profile, skill_md)
        try:
            resolved_entry = entry.resolve()
            if not is_relative_to(resolved_entry, resolved_skills_root):
                raise SkillDefinitionError(
                    "skill_path_forbidden",
                    "resolved skill directory must stay under workspace skills root",
                    path=relative_entry,
                )
            metadata = parse_skill_frontmatter(skill_md)
            name = metadata["name"]
            description = metadata["description"]
            if name != entry.name:
                raise SkillDefinitionError(
                    "skill_name_mismatch",
                    "frontmatter name must match skill directory name",
                    path=relative_entry,
                    details={"name": name, "directory": entry.name},
                )
            if name in skills:
                raise SkillDefinitionError(
                    "skill_name_duplicate",
                    "duplicate skill name in workspace source",
                    path=relative_entry,
                    details={"name": name},
                )
            skills[name] = SkillDefinition(
                name=name,
                description=description,
                source="workspace",
                root_dir=entry,
                entry_file=skill_md,
                relative_entry=relative_entry,
                resources=_list_skill_resources(entry),
            )
        except SkillDefinitionError as exc:
            diagnostics.append(exc.to_diagnostic(path=relative_entry))

    ordered = {name: skills[name] for name in sorted(skills, key=str.lower)}
    return SkillCatalog(keydex_profile=profile, skills=ordered, diagnostics=diagnostics)


def _relative_to_workspace(profile: KeydexWorkspaceProfile, path: Path) -> str:
    resolved = path.resolve()
    try:
        return resolved.relative_to(profile.workspace_root).as_posix()
    except ValueError:
        return resolved.name


def _list_skill_resources(skill_root: Path) -> list[str]:
    resources: list[str] = []
    for path in sorted(skill_root.rglob("*"), key=lambda item: item.as_posix().lower()):
        if not path.is_file() or path.name == "SKILL.md":
            continue
        try:
            resources.append(path.relative_to(skill_root).as_posix())
        except ValueError:
            continue
    return resources
