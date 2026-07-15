from __future__ import annotations

import json
import shutil
from pathlib import Path

from backend.app.core.config import AppSettings
from backend.app.keydex import KeydexRuntimeCache
from backend.app.keydex.builtin_skills import (
    BUILTIN_SKILLS_ROOT,
    load_and_validate_builtin_skill_catalog,
    load_builtin_skill_layer_profile,
)
from backend.app.keydex.runtime import build_keydex_layer_fingerprint
from backend.app.main import create_app

EXPECTED_KEYDEX_GUIDE_REFERENCES = {
    "a2ui-chart.md",
    "a2ui-choice.md",
    "a2ui-form.md",
    "a2ui-lifecycle-and-debug.md",
    "a2ui-table.md",
    "command-shell-approvals-and-trust.md",
    "composer-context-and-attachments.md",
    "document-annotations-and-chat-handoff.md",
    "extension-settings.md",
    "external-files-and-readonly-resources.md",
    "file-access-and-edit-tool-style.md",
    "file-and-directory-context-menus.md",
    "file-and-directory-references.md",
    "fork-export-file-review-and-reverse.md",
    "general-appearance-and-app-updates.md",
    "goals-plans-and-context-compression.md",
    "home-project-and-model-selection.md",
    "keydex-scope-priority-and-config.md",
    "mcp-approvals-trust-and-advanced-interactions.md",
    "mcp-import-export-audit-and-troubleshooting.md",
    "mcp-overview-and-session-runtime.md",
    "mcp-servers-transports-and-auth.md",
    "mcp-tools-exposure-and-policies.md",
    "messages-tools-approvals-and-errors.md",
    "outline-images-and-rich-previews.md",
    "preview-formats-and-view-modes.md",
    "providers-models-and-runtime-selection.md",
    "running-turn-steer-and-queue.md",
    "session-history-and-lifecycle.md",
    "shell-sidebars-and-state-continuity.md",
    "sidecar-and-right-sidebar.md",
    "skill-security-diagnostics-and-updates.md",
    "skill-selection-and-activation.md",
    "skill-structure-resources-and-authoring.md",
    "source-editing-auto-save-and-conflicts.md",
    "start-navigation-and-modes.md",
    "troubleshooting-and-version-boundaries.md",
    "usage-project-and-archive-management.md",
    "web-search-and-answer-sources.md",
    "workbench-assistant-capsule.md",
    "workbench-layout-and-preview-tabs.md",
    "workspace-tree-filter-and-locate.md",
}


def test_production_builtin_catalog_is_valid_and_contains_keydex_guide() -> None:
    catalog = load_and_validate_builtin_skill_catalog()

    assert [(item.id, item.skill_name, item.version) for item in catalog.skills] == [
        ("keydex-guide", "keydex-guide", 2)
    ]
    guide = catalog.skills[0]
    assert (guide.source_dir / "SKILL.md").is_file()
    assert (
        guide.source_dir / "references" / "start-navigation-and-modes.md"
    ).is_file()
    catalog_payload = json.loads(
        (BUILTIN_SKILLS_ROOT / "catalog.json").read_text(encoding="utf-8")
    )
    assert catalog_payload["schema_version"] == 2
    assert set(catalog_payload["skills"][0]) == {"id", "skill_name", "version"}


def test_builtin_keydex_guide_entry_and_references_are_chinese() -> None:
    guide_root = BUILTIN_SKILLS_ROOT / "skills" / "keydex-guide"
    skill_entry = guide_root / "SKILL.md"
    reference_pages = sorted((guide_root / "references").glob("*.md"))
    entry_content = skill_entry.read_text(encoding="utf-8")

    assert "Keydex 中文产品使用指南" in entry_content
    assert {page.name for page in reference_pages} == EXPECTED_KEYDEX_GUIDE_REFERENCES
    for page in [skill_entry, *reference_pages]:
        content = page.read_text(encoding="utf-8")
        assert any("\u4e00" <= character <= "\u9fff" for character in content), page
        assert len(content) >= 400, page
    for reference_name in EXPECTED_KEYDEX_GUIDE_REFERENCES:
        assert f"(references/{reference_name})" in entry_content


def test_builtin_catalog_accepts_release_content_changes_without_hash_contract(
    tmp_path: Path,
) -> None:
    bundle = _copy_production_bundle(tmp_path)
    entry = bundle / "skills" / "keydex-guide" / "SKILL.md"
    entry.write_text(entry.read_text(encoding="utf-8") + "\nmodified\n", encoding="utf-8")

    profile = load_builtin_skill_layer_profile(bundle)

    assert profile.available is True
    assert profile.enabled is True
    assert profile.diagnostics == ()


def test_builtin_catalog_accepts_crlf_packaged_skill_content(tmp_path: Path) -> None:
    bundle = _copy_production_bundle(tmp_path)
    guide_root = bundle / "skills" / "keydex-guide"
    for path in guide_root.rglob("*.md"):
        content = path.read_bytes().replace(b"\r\n", b"\n")
        path.write_bytes(content.replace(b"\n", b"\r\n"))

    profile = load_builtin_skill_layer_profile(bundle)

    assert profile.available is True
    assert profile.enabled is True
    assert profile.diagnostics == ()


def test_builtin_catalog_rejects_unlisted_skill_directory(tmp_path: Path) -> None:
    bundle = _copy_production_bundle(tmp_path)
    _write_skill(bundle / "skills", "unlisted", "unlisted")

    profile = load_builtin_skill_layer_profile(bundle)

    assert profile.available is False
    assert profile.diagnostics[0].code == "builtin_skill_catalog_mismatch"


def test_builtin_catalog_fingerprint_includes_catalog_and_all_resources(tmp_path: Path) -> None:
    bundle = _copy_production_bundle(tmp_path)
    before = build_keydex_layer_fingerprint("builtin", bundle)

    catalog_path = bundle / "catalog.json"
    payload = json.loads(catalog_path.read_text(encoding="utf-8"))
    payload["skills"][0]["version"] += 1
    catalog_path.write_text(json.dumps(payload), encoding="utf-8")
    after = build_keydex_layer_fingerprint("builtin", bundle)

    assert before.digest() != after.digest()
    assert any(entry[0] == "builtin/catalog.json" for entry in after.entries)
    assert any(
        entry[0]
        == "builtin/skills/keydex-guide/references/skill-selection-and-activation.md"
        for entry in after.entries
    )


def test_structurally_invalid_builtin_fails_closed_without_disabling_system_layer(
    tmp_path: Path,
) -> None:
    bundle = _copy_production_bundle(tmp_path)
    entry = bundle / "skills" / "keydex-guide" / "SKILL.md"
    entry.unlink()
    system_root = tmp_path / "system"
    _write_skill(system_root / "skills", "global", "system")

    snapshot = KeydexRuntimeCache(
        system_root=system_root,
        builtin_root=bundle,
    ).get_system_snapshot()

    assert list(snapshot.skill_catalog.skills) == ["global"]
    assert snapshot.skill_catalog.skills["global"].source == "system"
    assert any(
        diagnostic.code == "skill_frontmatter_unreadable"
        for diagnostic in snapshot.diagnostics
    )


def test_override_deletion_reveals_next_lower_layer_without_mutating_it(
    tmp_path: Path,
) -> None:
    system_root = tmp_path / "system"
    workspace_root = tmp_path / "workspace"
    _write_skill(system_root / "skills", "keydex-guide", "system override")
    _write_skill(
        workspace_root / ".keydex" / "skills",
        "keydex-guide",
        "workspace override",
    )
    cache = KeydexRuntimeCache(system_root=system_root)

    workspace = cache.get_workspace_snapshot(workspace_root)
    assert workspace.skill_catalog.skills["keydex-guide"].source == "workspace"

    shutil.rmtree(workspace_root / ".keydex" / "skills" / "keydex-guide")
    cache.invalidate_workspace(workspace_root)
    system = cache.get_workspace_snapshot(workspace_root)
    assert system.skill_catalog.skills["keydex-guide"].source == "system"

    shutil.rmtree(system_root / "skills" / "keydex-guide")
    cache.invalidate_system()
    builtin = cache.get_workspace_snapshot(workspace_root)
    assert builtin.skill_catalog.skills["keydex-guide"].source == "builtin"
    assert (BUILTIN_SKILLS_ROOT / "skills" / "keydex-guide" / "SKILL.md").is_file()


def test_builtin_startup_does_not_create_user_system_keydex_root(tmp_path: Path) -> None:
    system_root = tmp_path / "user-home" / ".keydex"
    app = create_app(
        AppSettings(data_dir=tmp_path / "data", workspace_root=tmp_path),
        keydex_system_root_for_testing=system_root,
    )

    snapshot = app.state.keydex_runtime_cache.get_system_snapshot()

    assert snapshot.skill_catalog.skills["keydex-guide"].source == "builtin"
    assert not system_root.exists()


def _copy_production_bundle(tmp_path: Path) -> Path:
    bundle = tmp_path / "builtin_skills"
    shutil.copytree(BUILTIN_SKILLS_ROOT, bundle, ignore=shutil.ignore_patterns("__pycache__"))
    return bundle


def _write_skill(skills_root: Path, name: str, description: str) -> Path:
    skill_root = skills_root / name
    skill_root.mkdir(parents=True, exist_ok=True)
    (skill_root / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: {description}\n---\n\n# {name}\n",
        encoding="utf-8",
    )
    return skill_root
