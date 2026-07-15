from pathlib import Path

from backend.app.keydex import (
    KeydexLayerProfile,
    load_keydex_system_profile,
    resolve_system_keydex_root,
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


def test_t29_system_layer_preserves_source_and_logical_skills_root(tmp_path: Path) -> None:
    layer = KeydexLayerProfile(
        scope="system",
        root=tmp_path / "system-root",
        enabled=True,
    )

    assert layer.scope == "system"
    assert layer.skills_root == (tmp_path / "system-root" / "skills").resolve()


def test_t04_missing_system_directory_is_a_valid_empty_layer(tmp_path: Path) -> None:
    profile = load_keydex_system_profile(tmp_path / "missing")

    assert profile.available is True
    assert profile.enabled is False
    assert profile.diagnostics == ()


def test_t05_empty_system_directory_uses_default_manifest(tmp_path: Path) -> None:
    system_root = tmp_path / "system"
    system_root.mkdir()

    profile = load_keydex_system_profile(system_root)

    assert profile.available is True
    assert profile.enabled is True
    assert profile.manifest == {"schema_version": 1, "skills": {"enabled": True}}


def test_t06_valid_system_manifest_enables_system_layer(tmp_path: Path) -> None:
    system_root = tmp_path / "system"
    system_root.mkdir()
    (system_root / "keydex.json").write_text(
        '{"schema_version": 1, "skills": {"enabled": true}}',
        encoding="utf-8",
    )

    profile = load_keydex_system_profile(system_root)

    assert profile.enabled is True
    assert profile.available is True


def test_t07_system_disabled_is_layer_local(tmp_path: Path) -> None:
    system_root = tmp_path / "system"
    system_root.mkdir()
    (system_root / "keydex.json").write_text(
        '{"schema_version": 1, "skills": {"enabled": false}}',
        encoding="utf-8",
    )

    profile = load_keydex_system_profile(system_root)

    assert profile.enabled is False
    assert profile.available is True
    assert profile.inherit_system is True


def test_t08_invalid_system_manifest_fails_closed_without_raising(tmp_path: Path) -> None:
    system_root = tmp_path / "system"
    system_root.mkdir()
    (system_root / "keydex.json").write_text("{invalid", encoding="utf-8")

    profile = load_keydex_system_profile(system_root)

    assert profile.enabled is False
    assert profile.available is False
    assert profile.diagnostics[0].code == "keydex_manifest_invalid"


def test_t17_system_disabled_does_not_change_workspace_profile_contract(
    tmp_path: Path,
) -> None:
    system_root = tmp_path / "system"
    system_root.mkdir()
    (system_root / "keydex.json").write_text(
        '{"skills": {"enabled": false}}',
        encoding="utf-8",
    )
    workspace_root = tmp_path / "workspace" / ".keydex"
    workspace_root.mkdir(parents=True)

    system = load_keydex_system_profile(system_root)
    workspace = KeydexLayerProfile(
        scope="workspace",
        root=workspace_root,
        enabled=True,
    )

    assert system.enabled is False
    assert workspace.enabled is True


def test_t19_invalid_system_profile_does_not_raise_or_touch_other_roots(
    tmp_path: Path,
) -> None:
    broken = tmp_path / "broken-system"
    broken.mkdir()
    (broken / "keydex.json").mkdir()
    other = tmp_path / "other-workspace" / ".keydex"
    other.mkdir(parents=True)

    profile = load_keydex_system_profile(broken)

    assert profile.available is False
    assert other.is_dir()
