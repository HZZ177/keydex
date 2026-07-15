from __future__ import annotations

import json
import stat
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from backend.app.keydex.models import KeydexDiagnostic, KeydexLayerProfile
from backend.app.keydex.skills.frontmatter import parse_skill_frontmatter, validate_skill_name
from backend.app.keydex.skills.model import SkillDefinitionError, canonical_skill_name

BUILTIN_SKILL_CATALOG_SCHEMA_VERSION = 2
BUILTIN_SKILLS_ROOT = Path(__file__).resolve().parent


@dataclass(frozen=True)
class BuiltinSkill:
    id: str
    skill_name: str
    version: int
    source_dir: Path


@dataclass(frozen=True)
class BuiltinSkillCatalog:
    skills: tuple[BuiltinSkill, ...] = field(default_factory=tuple)


class BuiltinSkillValidationError(ValueError):
    def __init__(self, code: str, reason: str, *, path: str | None = None) -> None:
        super().__init__(reason)
        self.code = code
        self.reason = reason
        self.path = path

    def to_diagnostic(self) -> KeydexDiagnostic:
        return KeydexDiagnostic(
            code=self.code,
            reason=self.reason,
            path=self.path,
            severity="error",
        )


def load_builtin_skill_layer_profile(
    bundle_root: str | Path | None = None,
) -> KeydexLayerProfile:
    root = (
        BUILTIN_SKILLS_ROOT
        if bundle_root is None
        else Path(bundle_root).expanduser().resolve()
    )
    try:
        catalog = load_and_validate_builtin_skill_catalog(root)
    except BuiltinSkillValidationError as exc:
        return KeydexLayerProfile(
            scope="builtin",
            root=root,
            enabled=False,
            available=False,
            manifest={"schema_version": BUILTIN_SKILL_CATALOG_SCHEMA_VERSION},
            diagnostics=(exc.to_diagnostic(),),
        )
    return KeydexLayerProfile(
        scope="builtin",
        root=root,
        enabled=True,
        available=True,
        manifest={
            "schema_version": BUILTIN_SKILL_CATALOG_SCHEMA_VERSION,
            "skills": [skill.skill_name for skill in catalog.skills],
        },
    )


def load_and_validate_builtin_skill_catalog(
    bundle_root: str | Path = BUILTIN_SKILLS_ROOT,
) -> BuiltinSkillCatalog:
    root = Path(bundle_root).expanduser().resolve()
    catalog_path = root / "catalog.json"
    try:
        payload = json.loads(catalog_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise BuiltinSkillValidationError(
            "builtin_skill_catalog_invalid",
            "builtin Skill catalog is unreadable or invalid JSON",
            path="catalog.json",
        ) from exc
    if not isinstance(payload, dict) or set(payload) != {"schema_version", "skills"}:
        raise BuiltinSkillValidationError(
            "builtin_skill_catalog_invalid",
            "builtin Skill catalog fields must be schema_version and skills",
            path="catalog.json",
        )
    if payload["schema_version"] != BUILTIN_SKILL_CATALOG_SCHEMA_VERSION:
        raise BuiltinSkillValidationError(
            "builtin_skill_catalog_version_unsupported",
            "builtin Skill catalog schema_version is unsupported",
            path="catalog.json",
        )
    items = payload["skills"]
    if not isinstance(items, list):
        raise BuiltinSkillValidationError(
            "builtin_skill_catalog_invalid",
            "builtin Skill catalog skills must be an array",
            path="catalog.json",
        )

    skills: list[BuiltinSkill] = []
    ids: set[str] = set()
    names: set[str] = set()
    for index, item in enumerate(items):
        logical_path = f"catalog.json#skills/{index}"
        skill = _parse_builtin_skill(root, item, logical_path=logical_path)
        if skill.id in ids:
            raise BuiltinSkillValidationError(
                "builtin_skill_id_duplicate",
                "builtin Skill ids must be unique",
                path=logical_path,
            )
        canonical_name = canonical_skill_name(skill.skill_name)
        if canonical_name in names:
            raise BuiltinSkillValidationError(
                "builtin_skill_name_duplicate",
                "builtin Skill names must be unique ignoring case",
                path=logical_path,
            )
        ids.add(skill.id)
        names.add(canonical_name)
        skills.append(skill)

    _validate_skills_directory(
        root / "skills",
        {skill.skill_name for skill in skills},
    )
    return BuiltinSkillCatalog(skills=tuple(skills))


def _parse_builtin_skill(
    root: Path,
    item: Any,
    *,
    logical_path: str,
) -> BuiltinSkill:
    if not isinstance(item, dict) or set(item) != {
        "id",
        "skill_name",
        "version",
    }:
        raise BuiltinSkillValidationError(
            "builtin_skill_catalog_item_invalid",
            "builtin Skill item fields must be id, skill_name, and version",
            path=logical_path,
        )
    skill_id = item["id"]
    if not isinstance(skill_id, str) or not skill_id.strip() or len(skill_id) > 128:
        raise BuiltinSkillValidationError(
            "builtin_skill_id_invalid",
            "builtin Skill id must be a non-empty string up to 128 characters",
            path=logical_path,
        )
    try:
        skill_name = validate_skill_name(item["skill_name"], path=logical_path)
    except SkillDefinitionError as exc:
        raise BuiltinSkillValidationError(exc.code, exc.reason, path=logical_path) from exc
    version = item["version"]
    if isinstance(version, bool) or not isinstance(version, int) or version < 1:
        raise BuiltinSkillValidationError(
            "builtin_skill_version_invalid",
            "builtin Skill version must be a positive integer",
            path=logical_path,
        )
    source_dir = root / "skills" / skill_name
    _validate_skill_tree(source_dir, skill_name=skill_name)
    entry_file = source_dir / "SKILL.md"
    try:
        metadata = parse_skill_frontmatter(entry_file)
    except SkillDefinitionError as exc:
        raise BuiltinSkillValidationError(
            exc.code,
            exc.reason,
            path=f"skills/{skill_name}/SKILL.md",
        ) from exc
    if metadata["name"] != skill_name or source_dir.name != skill_name:
        raise BuiltinSkillValidationError(
            "builtin_skill_name_mismatch",
            "catalog, directory, and SKILL.md names must match exactly",
            path=f"skills/{skill_name}/SKILL.md",
        )
    return BuiltinSkill(
        id=skill_id.strip(),
        skill_name=skill_name,
        version=version,
        source_dir=source_dir,
    )


def _validate_skill_tree(source_dir: Path, *, skill_name: str) -> None:
    try:
        if source_dir.is_symlink() or _is_junction(source_dir):
            raise OSError("symbolic links and junctions are not allowed")
        if not source_dir.is_dir():
            raise OSError("Skill tree root must be a directory")
        _validate_skill_tree_directory(source_dir)
    except OSError as exc:
        raise BuiltinSkillValidationError(
            "builtin_skill_tree_invalid",
            "builtin Skill tree must contain only readable regular files and directories",
            path=f"skills/{skill_name}",
        ) from exc


def _validate_skill_tree_directory(directory: Path) -> None:
    for path in sorted(directory.iterdir(), key=lambda item: item.name):
        if path.is_symlink() or _is_junction(path):
            raise OSError("symbolic links and junctions are not allowed")
        mode = path.stat(follow_symlinks=False).st_mode
        if stat.S_ISDIR(mode):
            _validate_skill_tree_directory(path)
            continue
        if not stat.S_ISREG(mode):
            raise OSError("Skill tree contains a non-regular entry")
        with path.open("rb") as stream:
            stream.read(1)


def _validate_skills_directory(skills_root: Path, catalog_names: set[str]) -> None:
    if (
        not skills_root.is_dir()
        or skills_root.is_symlink()
        or _is_junction(skills_root)
    ):
        raise BuiltinSkillValidationError(
            "builtin_skills_root_invalid",
            "builtin Skill root must be a directory",
            path="skills",
        )
    actual_names: set[str] = set()
    actual_canonical_names: set[str] = set()
    try:
        entries = sorted(skills_root.iterdir(), key=lambda path: path.name.casefold())
    except OSError as exc:
        raise BuiltinSkillValidationError(
            "builtin_skills_root_invalid",
            "builtin Skill root is unreadable",
            path="skills",
        ) from exc
    for entry in entries:
        if not entry.is_dir() or entry.is_symlink() or _is_junction(entry):
            raise BuiltinSkillValidationError(
                "builtin_skill_unlisted_entry",
                "builtin Skill root may contain only cataloged Skill directories",
                path=f"skills/{entry.name}",
            )
        canonical_name = canonical_skill_name(entry.name)
        if canonical_name in actual_canonical_names:
            raise BuiltinSkillValidationError(
                "builtin_skill_directory_duplicate",
                "builtin Skill directory names must be unique ignoring case",
                path=f"skills/{entry.name}",
            )
        actual_names.add(entry.name)
        actual_canonical_names.add(canonical_name)
    if actual_names != catalog_names:
        raise BuiltinSkillValidationError(
            "builtin_skill_catalog_mismatch",
            "builtin Skill catalog must list every and only bundled Skill directory",
            path="skills",
        )


def _is_junction(path: Path) -> bool:
    is_junction = getattr(path, "is_junction", None)
    return bool(callable(is_junction) and is_junction())


__all__ = [
    "BUILTIN_SKILL_CATALOG_SCHEMA_VERSION",
    "BUILTIN_SKILLS_ROOT",
    "BuiltinSkill",
    "BuiltinSkillCatalog",
    "BuiltinSkillValidationError",
    "load_and_validate_builtin_skill_catalog",
    "load_builtin_skill_layer_profile",
]
