import tomllib

from backend.packaging import build_agent_server


def test_t117_build_with_pyinstaller_embeds_bundled_preset_data(monkeypatch, tmp_path) -> None:
    calls: list[tuple[list[str], bool]] = []

    def fake_run(command: list[str], check: bool) -> None:
        calls.append((command, check))
        create_fake_sidecar(tmp_path)

    monkeypatch.setattr(build_agent_server.subprocess, "run", fake_run)

    binary = build_agent_server.build_with_pyinstaller(tmp_path)

    assert binary == build_agent_server.expected_binary(tmp_path)
    assert calls
    command, check = calls[0]
    assert check is True
    assert "--clean" not in command
    assert "--add-data" in command
    assert "--add-binary" in command
    assert "--onedir" in command
    assert "--onefile" not in command
    add_binary_index = command.index("--add-binary")
    assert command[add_binary_index + 1].startswith(str(build_agent_server.BUNDLED_RIPGREP_BINARY))
    add_data_values = [
        command[index + 1]
        for index, value in enumerate(command)
        if value == "--add-data"
    ]
    assert (
        f"{build_agent_server.BUNDLED_PRESETS_ROOT}"
        f"{build_agent_server.os.pathsep}"
        f"{build_agent_server.BUNDLED_PRESETS_DESTINATION}"
    ) in add_data_values
    assert (
        f"{build_agent_server.BUILTIN_SKILLS_ROOT}"
        f"{build_agent_server.os.pathsep}"
        f"{build_agent_server.BUILTIN_SKILLS_DESTINATION}"
    ) in add_data_values
    for package_name in build_agent_server.PYINSTALLER_COLLECT_SUBMODULES:
        assert_collect_submodules(command, package_name)
    assert str(build_agent_server.ENTRY_POINT) in command


def test_t116_sidecar_fingerprint_includes_all_bundled_preset_resources(
    monkeypatch,
    tmp_path,
) -> None:
    bundle_root = tmp_path / "bundled_presets"
    resource = bundle_root / "skills" / "future" / "assets" / "opaque.bin"
    resource.parent.mkdir(parents=True)
    resource.write_bytes(b"preset-resource")
    catalog = bundle_root / "catalog.json"
    catalog.write_text('{"schema_version":1,"presets":[]}', encoding="utf-8")
    monkeypatch.setattr(build_agent_server, "BUNDLED_PRESETS_ROOT", bundle_root)

    inputs = build_agent_server.iter_sidecar_inputs()
    monkeypatch.setattr(build_agent_server, "ROOT", tmp_path)
    monkeypatch.setattr(
        build_agent_server,
        "iter_sidecar_inputs",
        lambda: sorted([catalog, resource]),
    )
    before, fingerprint_inputs = build_agent_server.sidecar_fingerprint()
    resource.write_bytes(b"preset-resource-updated")
    after, _ = build_agent_server.sidecar_fingerprint()

    assert catalog in inputs
    assert resource in inputs
    assert "bundled_presets/catalog.json" in fingerprint_inputs
    assert "bundled_presets/skills/future/assets/opaque.bin" in fingerprint_inputs
    assert before != after


def test_sidecar_fingerprint_includes_builtin_catalog_and_nested_resources(
    monkeypatch,
    tmp_path,
) -> None:
    bundle_root = tmp_path / "builtin_skills"
    resource = bundle_root / "skills" / "guide" / "references" / "manual.md"
    resource.parent.mkdir(parents=True)
    resource.write_bytes(b"builtin-resource")
    catalog = bundle_root / "catalog.json"
    catalog.write_text('{"schema_version":1,"skills":[]}', encoding="utf-8")
    monkeypatch.setattr(build_agent_server, "BUILTIN_SKILLS_ROOT", bundle_root)

    inputs = build_agent_server.iter_sidecar_inputs()
    monkeypatch.setattr(build_agent_server, "ROOT", tmp_path)
    monkeypatch.setattr(
        build_agent_server,
        "iter_sidecar_inputs",
        lambda: sorted([catalog, resource]),
    )
    before, fingerprint_inputs = build_agent_server.sidecar_fingerprint()
    resource.write_bytes(b"builtin-resource-updated")
    after, _ = build_agent_server.sidecar_fingerprint()

    assert catalog in inputs
    assert resource in inputs
    assert "builtin_skills/catalog.json" in fingerprint_inputs
    assert "builtin_skills/skills/guide/references/manual.md" in fingerprint_inputs
    assert before != after


def test_t117_setuptools_package_data_includes_catalog_and_future_skill_resources() -> None:
    pyproject = tomllib.loads(
        (build_agent_server.ROOT / "pyproject.toml").read_text(encoding="utf-8")
    )

    package_data = pyproject["tool"]["setuptools"]["package-data"]
    assert package_data["backend.app.keydex.bundled_presets"] == [
        "catalog.json",
        "skills/**/*",
    ]
    assert package_data["backend.app.keydex.builtin_skills"] == [
        "catalog.json",
        "skills/**/*",
    ]


def test_build_with_pyinstaller_can_clean(monkeypatch, tmp_path) -> None:
    calls: list[tuple[list[str], bool]] = []

    def fake_run(command: list[str], check: bool) -> None:
        calls.append((command, check))
        create_fake_sidecar(tmp_path)

    monkeypatch.setattr(build_agent_server.subprocess, "run", fake_run)

    build_agent_server.build_with_pyinstaller(tmp_path, clean=True)

    command, _ = calls[0]
    assert "--clean" in command


def test_build_with_pyinstaller_reuses_current_sidecar(monkeypatch, tmp_path) -> None:
    calls: list[list[str]] = []
    binary = build_agent_server.expected_binary(tmp_path)
    binary.parent.mkdir(parents=True, exist_ok=True)
    binary.write_bytes(b"existing sidecar")
    fingerprint, inputs = build_agent_server.sidecar_fingerprint()
    build_agent_server.write_manifest(tmp_path, binary, fingerprint, inputs)

    def fake_run(command: list[str], check: bool) -> None:
        calls.append(command)

    monkeypatch.setattr(build_agent_server.subprocess, "run", fake_run)

    result = build_agent_server.build_with_pyinstaller(tmp_path, reuse_if_current=True)

    assert result == binary
    assert calls == []


def create_fake_sidecar(output_dir) -> None:
    binary = build_agent_server.expected_binary(output_dir)
    binary.parent.mkdir(parents=True, exist_ok=True)
    binary.write_bytes(b"fake sidecar")


def assert_collect_submodules(command: list[str], package_name: str) -> None:
    assert "--collect-submodules" in command
    option_index = command.index("--collect-submodules")
    while option_index < len(command):
        if command[option_index : option_index + 2] == ["--collect-submodules", package_name]:
            return
        try:
            option_index = command.index("--collect-submodules", option_index + 1)
        except ValueError:
            break
    raise AssertionError(f"missing --collect-submodules {package_name}")
