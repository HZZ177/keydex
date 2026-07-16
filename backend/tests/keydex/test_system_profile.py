from pathlib import Path

from backend.app.keydex import (
    KeydexLayerProfile,
    build_keydex_system_effective_snapshot,
    load_keydex_system_profile,
    resolve_system_keydex_root,
)


def _write_skill(root: Path, name: str) -> None:
    skill_root = root / "skills" / name
    skill_root.mkdir(parents=True, exist_ok=True)
    (skill_root / "SKILL.md").write_text(
        f"---\nname: {name}\ndescription: {name}\n---\n\n# {name}\n",
        encoding="utf-8",
    )


def test_t01_system_root_is_fixed_under_path_home(monkeypatch, tmp_path: Path) -> None:
    home = tmp_path / "user-home"
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: home))

    assert resolve_system_keydex_root() == (home / ".keydex").resolve()


def test_t02_environment_variable_cannot_override_system_root(
    monkeypatch,
    tmp_path: Path,
) -> None:
    home = tmp_path / "real-home"
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: home))
    monkeypatch.setenv("KEYDEX_SYSTEM_HOME", str(tmp_path / "override"))

    assert resolve_system_keydex_root() == (home / ".keydex").resolve()


def test_t03_system_layer_accepts_an_explicit_temporary_root_for_tests(
    tmp_path: Path,
) -> None:
    layer = KeydexLayerProfile(
        scope="system",
        root=tmp_path / "isolated-system-root",
        enabled=True,
    )

    assert layer.root == (tmp_path / "isolated-system-root").resolve()
    assert layer.root != resolve_system_keydex_root()


def test_kr04_missing_system_directory_is_a_valid_empty_layer(tmp_path: Path) -> None:
    profile = load_keydex_system_profile(tmp_path / "missing")

    assert profile.available is True
    assert profile.enabled is False
    assert profile.manifest == {}
    assert profile.diagnostics == ()


def test_kr05_existing_directory_is_loaded_by_convention(tmp_path: Path) -> None:
    system_root = tmp_path / "system"
    system_root.mkdir()

    profile = load_keydex_system_profile(system_root)

    assert profile.available is True
    assert profile.enabled is True
    assert profile.skills_root == (system_root / "skills").resolve()
    assert profile.manifest == {}


def test_kr06_damaged_keydex_json_is_ignored_by_system_runtime(tmp_path: Path) -> None:
    system_root = tmp_path / "system"
    _write_skill(system_root, "global")
    before = build_keydex_system_effective_snapshot(system_root)

    legacy = system_root / "keydex.md"
    legacy.write_text("{invalid", encoding="utf-8")
    damaged = build_keydex_system_effective_snapshot(system_root)
    legacy.unlink()
    legacy.mkdir()
    directory = build_keydex_system_effective_snapshot(system_root)

    assert damaged.fingerprint == before.fingerprint == directory.fingerprint
    assert damaged.skill_catalog.skills["global"].source == "system"
    assert directory.skill_catalog.skills["global"].source == "system"
    assert damaged.diagnostics == before.diagnostics == directory.diagnostics


def test_legacy_disabled_flag_cannot_disable_system_skills(tmp_path: Path) -> None:
    system_root = tmp_path / "system"
    _write_skill(system_root, "global")
    (system_root / "keydex.md").write_text(
        '{"skills": {"enabled": false}}',
        encoding="utf-8",
    )

    snapshot = build_keydex_system_effective_snapshot(system_root)

    assert snapshot.skill_catalog.skills["global"].source == "system"


def test_kr07_non_directory_system_root_is_an_isolated_layer_error(tmp_path: Path) -> None:
    broken = tmp_path / "broken-system"
    broken.write_text("not a directory", encoding="utf-8")
    other = tmp_path / "other-workspace" / ".keydex"
    other.mkdir(parents=True)

    profile = load_keydex_system_profile(broken)

    assert profile.available is False
    assert profile.enabled is False
    assert profile.diagnostics[0].code == "keydex_root_invalid"
    assert profile.diagnostics[0].scope == "system"
    assert other.is_dir()
