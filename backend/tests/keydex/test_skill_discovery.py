from pathlib import Path

from backend.app.keydex import KeydexLayerProfile, load_keydex_workspace_profile
from backend.app.keydex.skills import (
    SkillDefinition,
    discover_layer_skills,
    discover_workspace_skills,
)
from backend.app.keydex.skills.discovery import _register_layer_skill


def _write_skill(skill_dir: Path, *, name: str, description: str = "Use this skill.") -> None:
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        f"""---
name: {name}
description: {description}
---

# {name}
""",
        encoding="utf-8",
    )


def test_discovery_returns_empty_catalog_when_skills_dir_is_missing(tmp_path: Path) -> None:
    workspace_root = tmp_path / "repo"
    (workspace_root / ".keydex").mkdir(parents=True)
    profile = load_keydex_workspace_profile(workspace_root)

    catalog = discover_workspace_skills(profile)

    assert catalog.skills == {}
    assert catalog.diagnostics == []


def test_discovery_ignores_legacy_skills_disabled_manifest_flag(tmp_path: Path) -> None:
    workspace_root = tmp_path / "repo"
    keydex_root = workspace_root / ".keydex"
    keydex_root.mkdir(parents=True)
    (keydex_root / "keydex.md").write_text(
        '{"schema_version": 1, "skills": {"enabled": false}}',
        encoding="utf-8",
    )
    _write_skill(keydex_root / "skills" / "dev-plan", name="dev-plan")
    profile = load_keydex_workspace_profile(workspace_root)

    catalog = discover_workspace_skills(profile)

    assert list(catalog.skills) == ["dev-plan"]
    assert catalog.skills["dev-plan"].source == "workspace"
    assert catalog.diagnostics == []


def test_discovery_scans_only_first_level_skill_dirs(tmp_path: Path) -> None:
    workspace_root = tmp_path / "repo"
    skills_root = workspace_root / ".keydex" / "skills"
    _write_skill(skills_root / "dev-plan", name="dev-plan")
    _write_skill(skills_root / "dev-plan" / "nested", name="nested")
    (skills_root / "SKILL.md").write_text(
        "---\nname: top\nsummary: ignored\n---\n",
        encoding="utf-8",
    )
    profile = load_keydex_workspace_profile(workspace_root)

    catalog = discover_workspace_skills(profile)

    assert list(catalog.skills) == ["dev-plan"]
    skill = catalog.skills["dev-plan"]
    assert skill.relative_entry == ".keydex/skills/dev-plan/SKILL.md"
    assert skill.source == "workspace"
    assert catalog.diagnostics == []


def test_discovery_lists_skill_resources_except_entry_file(tmp_path: Path) -> None:
    workspace_root = tmp_path / "repo"
    skill_dir = workspace_root / ".keydex" / "skills" / "dev-plan"
    _write_skill(skill_dir, name="dev-plan")
    (skill_dir / "references").mkdir()
    (skill_dir / "references" / "guide.md").write_text("guide", encoding="utf-8")
    (skill_dir / "scripts").mkdir()
    (skill_dir / "scripts" / "run.ps1").write_text("Write-Output ok", encoding="utf-8")
    profile = load_keydex_workspace_profile(workspace_root)

    catalog = discover_workspace_skills(profile)

    assert catalog.skills["dev-plan"].resources == [
        "references/guide.md",
        "scripts/run.ps1",
    ]


def test_discovery_returns_stable_name_sorted_catalog(tmp_path: Path) -> None:
    workspace_root = tmp_path / "repo"
    skills_root = workspace_root / ".keydex" / "skills"
    _write_skill(skills_root / "zeta", name="zeta")
    _write_skill(skills_root / "alpha", name="alpha")
    profile = load_keydex_workspace_profile(workspace_root)

    catalog = discover_workspace_skills(profile)

    assert list(catalog.skills) == ["alpha", "zeta"]
    assert [skill.name for skill in catalog.sorted_skills()] == ["alpha", "zeta"]


def test_discovery_marks_name_directory_mismatch_invalid(tmp_path: Path) -> None:
    workspace_root = tmp_path / "repo"
    skills_root = workspace_root / ".keydex" / "skills"
    _write_skill(skills_root / "dev-plan", name="other")
    profile = load_keydex_workspace_profile(workspace_root)

    catalog = discover_workspace_skills(profile)

    assert catalog.skills == {}
    assert len(catalog.diagnostics) == 1
    assert catalog.diagnostics[0].code == "skill_name_mismatch"
    assert catalog.diagnostics[0].path == ".keydex/skills/dev-plan/SKILL.md"
    assert catalog.blocked_names == frozenset({"dev-plan"})


def test_discovery_keeps_invalid_frontmatter_as_diagnostic(tmp_path: Path) -> None:
    workspace_root = tmp_path / "repo"
    skill_dir = workspace_root / ".keydex" / "skills" / "broken"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text("---\nname: broken\n---\n", encoding="utf-8")
    profile = load_keydex_workspace_profile(workspace_root)

    catalog = discover_workspace_skills(profile)

    assert catalog.skills == {}
    assert catalog.diagnostics[0].code == "skill_frontmatter_missing_description"
    assert catalog.blocked_names == frozenset({"broken"})


def test_t09_system_layer_discovery_preserves_real_source(tmp_path: Path) -> None:
    system_root = tmp_path / "system"
    _write_skill(system_root / "skills" / "global-skill", name="global-skill")
    profile = KeydexLayerProfile(scope="system", root=system_root, enabled=True)

    catalog = discover_layer_skills(profile)

    assert catalog.skills["global-skill"].source == "system"
    assert catalog.skills["global-skill"].relative_entry == (
        ".keydex/skills/global-skill/SKILL.md"
    )


def test_t10_invalid_system_candidate_does_not_hide_other_system_skills(
    tmp_path: Path,
) -> None:
    system_root = tmp_path / "system"
    _write_skill(system_root / "skills" / "valid", name="valid")
    broken = system_root / "skills" / "broken"
    broken.mkdir(parents=True)
    profile = KeydexLayerProfile(scope="system", root=system_root, enabled=True)

    catalog = discover_layer_skills(profile)

    assert list(catalog.skills) == ["valid"]
    assert catalog.blocked_names == frozenset({"broken"})


def test_t11_casefold_duplicate_fails_closed_for_the_whole_name(tmp_path: Path) -> None:
    root = tmp_path / "system" / "skills"
    skills: dict[str, SkillDefinition] = {}
    names_by_canonical: dict[str, str] = {}
    blocked_names: set[str] = set()
    first = SkillDefinition(
        name="Alpha",
        description="first",
        source="system",
        root_dir=root / "Alpha",
        entry_file=root / "Alpha" / "SKILL.md",
        relative_entry=".keydex/skills/Alpha/SKILL.md",
    )
    second = SkillDefinition(
        name="alpha",
        description="second",
        source="system",
        root_dir=root / "alpha",
        entry_file=root / "alpha" / "SKILL.md",
        relative_entry=".keydex/skills/alpha/SKILL.md",
    )

    assert _register_layer_skill(
        first,
        skills=skills,
        names_by_canonical=names_by_canonical,
        blocked_names=blocked_names,
    ) is None
    assert _register_layer_skill(
        second,
        skills=skills,
        names_by_canonical=names_by_canonical,
        blocked_names=blocked_names,
    ) == "Alpha"
    assert skills == {}
    assert blocked_names == {"alpha"}


def test_t12_resource_inventory_is_stable_and_contains_only_regular_files(
    tmp_path: Path,
) -> None:
    system_root = tmp_path / "system"
    skill_root = system_root / "skills" / "global"
    _write_skill(skill_root, name="global")
    (skill_root / "references").mkdir()
    (skill_root / "references" / "z.md").write_text("z", encoding="utf-8")
    (skill_root / "references" / "a.md").write_text("a", encoding="utf-8")
    profile = KeydexLayerProfile(scope="system", root=system_root, enabled=True)

    catalog = discover_layer_skills(profile)

    assert catalog.skills["global"].resources == [
        "references/a.md",
        "references/z.md",
    ]


def test_t13_invalid_directory_name_reports_only_a_diagnostic(tmp_path: Path) -> None:
    system_root = tmp_path / "system"
    invalid = system_root / "skills" / "bad name"
    _write_skill(invalid, name="bad-name")
    profile = KeydexLayerProfile(scope="system", root=system_root, enabled=True)

    catalog = discover_layer_skills(profile)

    assert catalog.skills == {}
    assert catalog.blocked_names == frozenset()
    assert catalog.diagnostics[0].code == "skill_directory_name_invalid"


def test_t22_missing_workspace_entry_creates_shadow_barrier(tmp_path: Path) -> None:
    workspace_root = tmp_path / "repo"
    (workspace_root / ".keydex" / "skills" / "global").mkdir(parents=True)
    profile = load_keydex_workspace_profile(workspace_root)

    catalog = discover_workspace_skills(profile)

    assert catalog.blocked_names == frozenset({"global"})
    assert catalog.diagnostics[0].code == "skill_entry_missing"


def test_t23_invalid_directory_name_does_not_create_unrelated_barrier(
    tmp_path: Path,
) -> None:
    workspace_root = tmp_path / "repo"
    skills_root = workspace_root / ".keydex" / "skills"
    (skills_root / "safe").mkdir(parents=True)
    invalid = skills_root / "not valid"
    invalid.mkdir(parents=True)
    profile = load_keydex_workspace_profile(workspace_root)

    catalog = discover_workspace_skills(profile)

    assert "safe" in catalog.blocked_names
    assert "not valid" not in catalog.blocked_names


def test_t27_canonical_barriers_use_casefolded_names(tmp_path: Path) -> None:
    workspace_root = tmp_path / "repo"
    (workspace_root / ".keydex" / "skills" / "MixedCase").mkdir(parents=True)
    profile = load_keydex_workspace_profile(workspace_root)

    catalog = discover_workspace_skills(profile)

    assert catalog.blocked_names == frozenset({"mixedcase"})
