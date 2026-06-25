from backend.packaging import build_agent_server


def test_build_with_pyinstaller_embeds_system_prompt_in_code(monkeypatch, tmp_path) -> None:
    calls: list[tuple[list[str], bool]] = []

    def fake_run(command: list[str], check: bool) -> None:
        calls.append((command, check))

    monkeypatch.setattr(build_agent_server.subprocess, "run", fake_run)
    monkeypatch.setattr(build_agent_server, "copy_with_retry", lambda source, target: None)

    binary = build_agent_server.build_with_pyinstaller(tmp_path)

    assert binary.name.startswith("agent-server")
    assert calls
    command, check = calls[0]
    assert check is True
    assert "--clean" not in command
    assert "--add-data" not in command
    assert str(build_agent_server.ENTRY_POINT) in command


def test_build_with_pyinstaller_can_clean(monkeypatch, tmp_path) -> None:
    calls: list[tuple[list[str], bool]] = []

    def fake_run(command: list[str], check: bool) -> None:
        calls.append((command, check))

    monkeypatch.setattr(build_agent_server.subprocess, "run", fake_run)
    monkeypatch.setattr(build_agent_server, "copy_with_retry", lambda source, target: None)

    build_agent_server.build_with_pyinstaller(tmp_path, clean=True)

    command, _ = calls[0]
    assert "--clean" in command


def test_build_with_pyinstaller_reuses_current_sidecar(monkeypatch, tmp_path) -> None:
    calls: list[list[str]] = []
    binary = build_agent_server.expected_binary(tmp_path)
    binary.write_bytes(b"existing sidecar")
    fingerprint, inputs = build_agent_server.sidecar_fingerprint()
    build_agent_server.write_manifest(tmp_path, binary, fingerprint, inputs)

    def fake_run(command: list[str], check: bool) -> None:
        calls.append(command)

    monkeypatch.setattr(build_agent_server.subprocess, "run", fake_run)

    result = build_agent_server.build_with_pyinstaller(tmp_path, reuse_if_current=True)

    assert result == binary
    assert calls == []
