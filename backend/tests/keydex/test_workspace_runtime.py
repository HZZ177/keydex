from datetime import UTC
from pathlib import Path

from backend.app.keydex import (
    build_keydex_workspace_fingerprint,
    build_keydex_workspace_runtime_snapshot,
)


def _write_skill(skill_dir: Path, *, name: str, description: str = "Use this skill.") -> None:
    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / "SKILL.md").write_text(
        f"""---
name: {name}
description: {description}
---

# {name}
""",
        encoding="utf-8",
    )


def _digest(workspace_root: Path) -> str:
    return build_keydex_workspace_fingerprint(workspace_root).digest()


def test_runtime_snapshot_contains_profile_catalog_fingerprint_loaded_at_and_diagnostics(
    tmp_path: Path,
) -> None:
    workspace_root = tmp_path / "repo"
    _write_skill(workspace_root / ".keydex" / "skills" / "dev-plan", name="dev-plan")

    snapshot = build_keydex_workspace_runtime_snapshot(workspace_root)

    assert snapshot.workspace_root == workspace_root.resolve()
    assert snapshot.keydex_profile.workspace_root == workspace_root.resolve()
    assert list(snapshot.skill_catalog.skills) == ["dev-plan"]
    assert len(snapshot.fingerprint) == 64
    assert snapshot.loaded_at.tzinfo == UTC
    assert snapshot.diagnostics == []


def test_fingerprint_changes_for_manifest_and_skill_entry_changes(tmp_path: Path) -> None:
    workspace_root = tmp_path / "repo"
    keydex_root = workspace_root / ".keydex"
    keydex_root.mkdir(parents=True)
    first = _digest(workspace_root)

    (keydex_root / "keydex.json").write_text(
        '{"schema_version": 1, "skills": {"enabled": true}}',
        encoding="utf-8",
    )
    second = _digest(workspace_root)
    assert second != first

    skill_dir = keydex_root / "skills" / "dev-plan"
    _write_skill(skill_dir, name="dev-plan")
    third = _digest(workspace_root)
    assert third != second

    _write_skill(skill_dir, name="dev-plan", description="Use this updated skill.")
    fourth = _digest(workspace_root)
    assert fourth != third

    (skill_dir / "SKILL.md").unlink()
    fifth = _digest(workspace_root)
    assert fifth != fourth


def test_fingerprint_changes_for_same_size_skill_entry_content_change(tmp_path: Path) -> None:
    workspace_root = tmp_path / "repo"
    skill_dir = workspace_root / ".keydex" / "skills" / "dev-plan"
    _write_skill(skill_dir, name="dev-plan", description="Use skill A.")
    first = _digest(workspace_root)

    _write_skill(skill_dir, name="dev-plan", description="Use skill B.")
    second = _digest(workspace_root)

    assert second != first


def test_t53_fingerprint_changes_for_skill_resource_changes(tmp_path: Path) -> None:
    workspace_root = tmp_path / "repo"
    skill_dir = workspace_root / ".keydex" / "skills" / "dev-plan"
    _write_skill(skill_dir, name="dev-plan")
    before = _digest(workspace_root)

    resource = skill_dir / "references" / "guide.md"
    resource.parent.mkdir(parents=True)
    resource.write_text("guide", encoding="utf-8")
    after = _digest(workspace_root)

    assert after != before
