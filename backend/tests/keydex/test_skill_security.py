from pathlib import Path

import pytest

from backend.app.keydex.skills import (
    SkillDefinition,
    SkillResourcePathError,
    read_skill_text_resource,
    resolve_skill_resource_path,
)


def _skill(root_dir: Path) -> SkillDefinition:
    return SkillDefinition(
        name="dev-plan",
        description="Use this skill.",
        source="workspace",
        root_dir=root_dir,
        entry_file=root_dir / "SKILL.md",
        relative_entry=".keydex/skills/dev-plan/SKILL.md",
    )


def test_resolve_skill_resource_path_allows_paths_inside_skill_root(tmp_path: Path) -> None:
    skill_root = tmp_path / "repo" / ".keydex" / "skills" / "dev-plan"
    resource = skill_root / "references" / "guide.md"
    resource.parent.mkdir(parents=True)
    resource.write_text("guide", encoding="utf-8")

    resolved = resolve_skill_resource_path(_skill(skill_root), "references/guide.md")

    assert resolved == resource.resolve()


def test_resolve_skill_resource_path_rejects_parent_escape(tmp_path: Path) -> None:
    skill_root = tmp_path / "repo" / ".keydex" / "skills" / "dev-plan"
    skill_root.mkdir(parents=True)

    with pytest.raises(SkillResourcePathError) as exc_info:
        resolve_skill_resource_path(_skill(skill_root), "../secret.md")

    assert exc_info.value.code == "skill_resource_forbidden"


def test_resolve_skill_resource_path_rejects_absolute_paths(tmp_path: Path) -> None:
    skill_root = tmp_path / "repo" / ".keydex" / "skills" / "dev-plan"
    skill_root.mkdir(parents=True)

    with pytest.raises(SkillResourcePathError) as exc_info:
        resolve_skill_resource_path(_skill(skill_root), tmp_path / "outside.md")

    assert exc_info.value.code == "skill_resource_forbidden"


def test_read_skill_text_resource_returns_revision_and_rejects_binary(tmp_path: Path) -> None:
    skill_root = tmp_path / "repo" / ".keydex" / "skills" / "dev-plan"
    skill_root.mkdir(parents=True)
    text = skill_root / "guide.md"
    text.write_text("guide", encoding="utf-8")

    resource = read_skill_text_resource(_skill(skill_root), "guide.md")

    assert resource.content == "guide"
    assert resource.encoding == "utf-8"
    assert len(resource.revision) == 64

    (skill_root / "binary.bin").write_bytes(b"a\0b")
    with pytest.raises(SkillResourcePathError) as exc_info:
        read_skill_text_resource(_skill(skill_root), "binary.bin")
    assert exc_info.value.code == "skill_resource_not_text"


def test_read_skill_text_resource_rejects_link_like_component(monkeypatch, tmp_path: Path) -> None:
    from backend.app.keydex.skills import security

    skill_root = tmp_path / "repo" / ".keydex" / "skills" / "dev-plan"
    resource = skill_root / "references" / "guide.md"
    resource.parent.mkdir(parents=True)
    resource.write_text("guide", encoding="utf-8")
    original = security._is_link_like
    monkeypatch.setattr(
        security,
        "_is_link_like",
        lambda path: path == resource.parent or original(path),
    )

    with pytest.raises(SkillResourcePathError) as exc_info:
        read_skill_text_resource(_skill(skill_root), "references/guide.md")

    assert exc_info.value.code == "skill_resource_forbidden"
