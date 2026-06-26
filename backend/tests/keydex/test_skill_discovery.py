from pathlib import Path

from backend.app.keydex import load_keydex_workspace_profile
from backend.app.keydex.skills import discover_workspace_skills


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


def test_discovery_respects_skills_disabled_manifest_flag(tmp_path: Path) -> None:
    workspace_root = tmp_path / "repo"
    keydex_root = workspace_root / ".keydex"
    keydex_root.mkdir(parents=True)
    (keydex_root / "keydex.json").write_text(
        '{"schema_version": 1, "skills": {"enabled": false}}',
        encoding="utf-8",
    )
    _write_skill(keydex_root / "skills" / "dev-plan", name="dev-plan")
    profile = load_keydex_workspace_profile(workspace_root)

    catalog = discover_workspace_skills(profile)

    assert catalog.skills == {}
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


def test_discovery_keeps_invalid_frontmatter_as_diagnostic(tmp_path: Path) -> None:
    workspace_root = tmp_path / "repo"
    skill_dir = workspace_root / ".keydex" / "skills" / "broken"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text("---\nname: broken\n---\n", encoding="utf-8")
    profile = load_keydex_workspace_profile(workspace_root)

    catalog = discover_workspace_skills(profile)

    assert catalog.skills == {}
    assert catalog.diagnostics[0].code == "skill_frontmatter_missing_description"
