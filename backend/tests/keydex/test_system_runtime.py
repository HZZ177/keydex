from dataclasses import FrozenInstanceError
from pathlib import Path

import pytest

from backend.app.keydex import (
    build_keydex_layer_fingerprint,
    build_keydex_system_effective_snapshot,
    build_keydex_workspace_effective_snapshot,
)


def _write_skill(root: Path, name: str, description: str) -> Path:
    skill_root = root / "skills" / name
    skill_root.mkdir(parents=True, exist_ok=True)
    (skill_root / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: {description}\n---\n\n# {name}\n",
        encoding="utf-8",
    )
    return skill_root


def test_t47_system_only_snapshot_contains_system_winners(tmp_path: Path) -> None:
    system_root = tmp_path / "system"
    _write_skill(system_root, "global", "system")

    snapshot = build_keydex_system_effective_snapshot(system_root)

    assert snapshot.mode == "system_only"
    assert snapshot.workspace_root is None
    assert snapshot.skill_catalog.skills["global"].source == "system"
    assert snapshot.skill_catalog.skills["keydex-guide"].source == "builtin"


def test_t35_workspace_effective_snapshot_contains_only_winners(tmp_path: Path) -> None:
    system_root = tmp_path / "system"
    workspace_root = tmp_path / "workspace"
    _write_skill(system_root, "shared", "system")
    _write_skill(workspace_root / ".keydex", "shared", "workspace")

    snapshot = build_keydex_workspace_effective_snapshot(
        workspace_root,
        system_root=system_root,
    )

    assert list(snapshot.skill_catalog.skills) == ["keydex-guide", "shared"]
    assert snapshot.skill_catalog.skills["shared"].source == "workspace"


def test_t53_layer_fingerprint_covers_all_regular_resources(tmp_path: Path) -> None:
    system_root = tmp_path / "system"
    skill_root = _write_skill(system_root, "global", "system")
    resource = skill_root / "references" / "guide.md"
    resource.parent.mkdir()
    resource.write_text("first", encoding="utf-8")
    before = build_keydex_layer_fingerprint("system", system_root).digest()

    resource.write_text("second", encoding="utf-8")
    after = build_keydex_layer_fingerprint("system", system_root).digest()

    assert before != after


def test_t28_effective_fingerprint_is_stable_for_same_tree(tmp_path: Path) -> None:
    system_root = tmp_path / "system"
    _write_skill(system_root, "global", "system")

    first = build_keydex_system_effective_snapshot(system_root)
    second = build_keydex_system_effective_snapshot(system_root)

    assert first.fingerprint == second.fingerprint


def test_t43_effective_snapshot_is_frozen_for_the_turn(tmp_path: Path) -> None:
    snapshot = build_keydex_system_effective_snapshot(tmp_path / "missing-system")

    with pytest.raises(FrozenInstanceError):
        snapshot.fingerprint = "changed"  # type: ignore[misc]


def test_layer_fingerprint_payload_does_not_expose_absolute_root(tmp_path: Path) -> None:
    system_root = tmp_path / "private-user" / ".keydex"
    fingerprint = build_keydex_layer_fingerprint("system", system_root)

    assert system_root.as_posix() not in str(fingerprint.to_payload())


def test_legacy_inherit_false_is_ignored_and_system_changes_effective_snapshot(
    tmp_path: Path,
) -> None:
    system_root = tmp_path / "system"
    workspace_root = tmp_path / "workspace"
    _write_skill(system_root, "global", "one")
    workspace_keydex = workspace_root / ".keydex"
    workspace_keydex.mkdir(parents=True)
    (workspace_keydex / "keydex.md").write_text(
        '{"skills": {"inherit_system": false}}',
        encoding="utf-8",
    )
    first = build_keydex_workspace_effective_snapshot(
        workspace_root,
        system_root=system_root,
    )

    _write_skill(system_root, "global", "two")
    second = build_keydex_workspace_effective_snapshot(
        workspace_root,
        system_root=system_root,
    )

    assert first.fingerprint != second.fingerprint
    assert second.skill_catalog.skills["global"].description == "two"
