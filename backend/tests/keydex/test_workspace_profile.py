from pathlib import Path

from backend.app.keydex import (
    build_keydex_workspace_effective_snapshot,
    load_keydex_workspace_profile,
)


def _write_skill(root: Path, name: str, description: str) -> None:
    skill_root = root / "skills" / name
    skill_root.mkdir(parents=True, exist_ok=True)
    (skill_root / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: {description}\n---\n\n# {name}\n",
        encoding="utf-8",
    )


def test_kr04_missing_keydex_directory_is_a_valid_empty_workspace_layer(
    tmp_path: Path,
) -> None:
    workspace_root = tmp_path / "repo"
    workspace_root.mkdir()

    profile = load_keydex_workspace_profile(workspace_root)

    assert profile.workspace_root == workspace_root.resolve()
    assert profile.keydex_root == (workspace_root / ".keydex").resolve()
    assert profile.active_layers[0].enabled is False
    assert profile.active_layers[0].manifest == {}
    assert profile.skills_enabled is False
    assert profile.skills_root is None
    assert profile.diagnostics == []


def test_kr05_workspace_directory_is_loaded_without_a_manifest(tmp_path: Path) -> None:
    workspace_root = tmp_path / "repo"
    keydex_root = workspace_root / ".keydex"
    keydex_root.mkdir(parents=True)

    profile = load_keydex_workspace_profile(workspace_root)

    assert profile.active_layers[0].enabled is True
    assert profile.active_layers[0].manifest == {}
    assert profile.skills_enabled is True
    assert profile.skills_root == (keydex_root / "skills").resolve()


def test_kr06_keydex_json_content_type_and_lifecycle_are_ignored(tmp_path: Path) -> None:
    system_root = tmp_path / "system"
    workspace_root = tmp_path / "repo"
    workspace_keydex = workspace_root / ".keydex"
    _write_skill(system_root, "shared", "system")
    _write_skill(workspace_keydex, "shared", "workspace")
    before = build_keydex_workspace_effective_snapshot(
        workspace_root,
        system_root=system_root,
    )

    legacy = workspace_keydex / "keydex.md"
    legacy.write_text('{"skills": {"enabled": false, "inherit_system": false}}')
    configured = build_keydex_workspace_effective_snapshot(
        workspace_root,
        system_root=system_root,
    )
    legacy.write_text("{invalid", encoding="utf-8")
    damaged = build_keydex_workspace_effective_snapshot(
        workspace_root,
        system_root=system_root,
    )
    legacy.unlink()
    removed = build_keydex_workspace_effective_snapshot(
        workspace_root,
        system_root=system_root,
    )

    assert (
        before.fingerprint
        == configured.fingerprint
        == damaged.fingerprint
        == removed.fingerprint
    )
    assert configured.skill_catalog.skills["shared"].source == "workspace"
    assert damaged.skill_catalog.skills["shared"].source == "workspace"


def test_ks07_workspace_always_inherits_system_and_builtin(tmp_path: Path) -> None:
    system_root = tmp_path / "system"
    workspace_root = tmp_path / "repo"
    _write_skill(system_root, "global", "system")
    _write_skill(workspace_root / ".keydex", "local", "workspace")
    (workspace_root / ".keydex" / "keydex.md").write_text(
        '{"skills": {"inherit_system": false}}',
        encoding="utf-8",
    )

    snapshot = build_keydex_workspace_effective_snapshot(
        workspace_root,
        system_root=system_root,
    )

    assert snapshot.skill_catalog.skills["global"].source == "system"
    assert snapshot.skill_catalog.skills["local"].source == "workspace"
    assert snapshot.skill_catalog.skills["keydex-guide"].source == "builtin"


def test_kr07_non_directory_workspace_keydex_preserves_parent_layers(tmp_path: Path) -> None:
    system_root = tmp_path / "system"
    workspace_root = tmp_path / "repo"
    workspace_root.mkdir()
    (workspace_root / ".keydex").write_text("not a directory", encoding="utf-8")
    _write_skill(system_root, "global", "system")

    snapshot = build_keydex_workspace_effective_snapshot(
        workspace_root,
        system_root=system_root,
    )

    assert snapshot.workspace_layer is not None
    assert snapshot.workspace_layer.profile.available is False
    assert snapshot.skill_catalog.skills["global"].source == "system"
    assert snapshot.skill_catalog.skills["keydex-guide"].source == "builtin"
    assert any(item.code == "keydex_root_invalid" for item in snapshot.diagnostics)
