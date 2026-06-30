from __future__ import annotations

import os
import subprocess

from backend.app.core import ripgrep


def test_open_ripgrep_process_centralizes_text_io_and_window_flags(
    monkeypatch,
    tmp_path,
) -> None:
    captured: dict[str, object] = {}

    class FakeProcess:
        pass

    def fake_popen(command, **kwargs):
        captured["command"] = command
        captured.update(kwargs)
        return FakeProcess()

    monkeypatch.setattr(ripgrep.subprocess, "Popen", fake_popen)

    process = ripgrep.open_ripgrep_process([tmp_path / "rg.exe", "--files"], cwd=tmp_path)

    assert isinstance(process, FakeProcess)
    assert captured["command"] == [os.fspath(tmp_path / "rg.exe"), "--files"]
    assert captured["cwd"] == str(tmp_path)
    assert captured["stdout"] is subprocess.PIPE
    assert captured["stderr"] is subprocess.PIPE
    assert captured["text"] is True
    assert captured["encoding"] == "utf-8"
    assert captured["errors"] == "replace"
    if os.name == "nt":
        assert captured["creationflags"] == subprocess.CREATE_NO_WINDOW
        startupinfo = captured["startupinfo"]
        assert isinstance(startupinfo, subprocess.STARTUPINFO)
        assert startupinfo.dwFlags & subprocess.STARTF_USESHOWWINDOW
        assert startupinfo.wShowWindow == subprocess.SW_HIDE
    else:
        assert "creationflags" not in captured
        assert "startupinfo" not in captured


def test_run_ripgrep_process_centralizes_capture_and_timeout(monkeypatch, tmp_path) -> None:
    captured: dict[str, object] = {}
    completed = subprocess.CompletedProcess(["rg"], 0, "ok", "")

    def fake_run(command, **kwargs):
        captured["command"] = command
        captured.update(kwargs)
        return completed

    monkeypatch.setattr(ripgrep.subprocess, "run", fake_run)

    result = ripgrep.run_ripgrep_process(
        [tmp_path / "rg.exe", "needle"],
        cwd=tmp_path,
        timeout_seconds=2,
    )

    assert result is completed
    assert captured["command"] == [os.fspath(tmp_path / "rg.exe"), "needle"]
    assert captured["cwd"] == str(tmp_path)
    assert captured["capture_output"] is True
    assert captured["text"] is True
    assert captured["encoding"] == "utf-8"
    assert captured["errors"] == "replace"
    assert captured["timeout"] == 2
    assert captured["check"] is False
