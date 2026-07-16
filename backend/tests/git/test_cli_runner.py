from __future__ import annotations

import asyncio
import ctypes
import os
import subprocess
import sys
from pathlib import Path

import pytest

from backend.app.git.runner import (
    GitCliRunner,
    GitRunnerValidationError,
    decode_git_output,
    git_environment,
    redact_git_output,
)


@pytest.mark.asyncio
async def test_runner_executes_real_git_without_a_shell(tmp_path: Path) -> None:
    runner = GitCliRunner()
    version = await runner.run(["--version"], cwd=tmp_path)
    assert version.succeeded
    assert version.argv[-1:] == ("--version",)
    assert version.stdout.startswith("git version ")
    assert version.cwd == tmp_path.resolve()

    failure = await runner.run(["rev-parse", "--is-inside-work-tree"], cwd=tmp_path)
    assert failure.succeeded is False
    assert failure.returncode != 0
    assert failure.stderr


@pytest.mark.asyncio
async def test_runner_passes_each_argument_literally(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    captured: dict[str, object] = {}

    class FakeProcess:
        returncode = 0

        async def communicate(self, payload):
            captured["payload"] = payload
            return b"ok", b""

    async def fake_create(*argv, **kwargs):
        captured["argv"] = argv
        captured["kwargs"] = kwargs
        return FakeProcess()

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_create)
    result = await GitCliRunner("git").run(
        ["status", "--", "name;echo injected", "$(whoami)"],
        cwd=tmp_path,
        input_text="stdin",
    )

    assert result.succeeded
    assert captured["argv"][-4:] == ("status", "--", "name;echo injected", "$(whoami)")
    kwargs = captured["kwargs"]
    assert isinstance(kwargs, dict)
    assert kwargs["stdin"] == asyncio.subprocess.PIPE
    assert kwargs["stdout"] == asyncio.subprocess.PIPE
    assert captured["payload"] == b"stdin"
    if os.name == "nt":
        assert kwargs["creationflags"] & subprocess.CREATE_NO_WINDOW
        assert kwargs["creationflags"] & subprocess.CREATE_NEW_PROCESS_GROUP
        assert kwargs["startupinfo"].dwFlags & subprocess.STARTF_USESHOWWINDOW


@pytest.mark.asyncio
@pytest.mark.skipif(os.name != "nt", reason="Windows selector-loop fallback")
async def test_runner_falls_back_when_asyncio_subprocess_is_unavailable(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    async def unavailable(*_argv, **_kwargs):
        raise NotImplementedError

    monkeypatch.setattr(asyncio, "create_subprocess_exec", unavailable)
    result = await GitCliRunner().run(["--version"], cwd=tmp_path)

    assert result.succeeded
    assert result.stdout.startswith("git version ")
    assert result.argv[-1] == "--version"


@pytest.mark.skipif(os.name != "nt", reason="Windows selector-loop integration")
def test_runner_executes_real_git_under_windows_selector_loop(tmp_path: Path) -> None:
    loop = asyncio.SelectorEventLoop()
    try:
        result = loop.run_until_complete(GitCliRunner().run(["--version"], cwd=tmp_path))
    finally:
        loop.close()

    assert result.succeeded
    assert result.stdout.startswith("git version ")


@pytest.mark.asyncio
async def test_runner_rejects_invalid_input_before_spawning(tmp_path: Path) -> None:
    runner = GitCliRunner()
    with pytest.raises(GitRunnerValidationError, match="NUL"):
        await runner.run(["status", "bad\x00path"], cwd=tmp_path)
    with pytest.raises(GitRunnerValidationError, match="does not exist"):
        await runner.run(["status"], cwd=tmp_path / "missing")


def test_runner_configures_windows_process_hiding_contract() -> None:
    if hasattr(subprocess, "CREATE_NO_WINDOW"):
        assert subprocess.CREATE_NO_WINDOW > 0


def test_git_environment_forces_non_interactive_parseable_defaults() -> None:
    environment = git_environment(
        {
            "GIT_TERMINAL_PROMPT": "1",
            "GIT_ASKPASS": "slow-askpass.exe",
            "SSH_ASKPASS": "slow-ssh-askpass.exe",
            "CUSTOM": "kept",
        }
    )
    assert environment["LC_ALL"] == "C"
    assert environment["GIT_PAGER"] == "cat"
    assert environment["GIT_EDITOR"] == "true"
    assert environment["GIT_TERMINAL_PROMPT"] == "0"
    assert environment["GCM_INTERACTIVE"] == "Never"
    assert environment["SSH_ASKPASS_REQUIRE"] == "never"
    assert "GIT_ASKPASS" not in environment
    assert "SSH_ASKPASS" not in environment
    assert environment["CUSTOM"] == "kept"


def test_git_output_decoder_preserves_utf8_names_and_replaces_invalid_bytes() -> None:
    assert decode_git_output("中文 😀\n".encode()) == "中文 😀\n"
    assert decode_git_output(b"invalid:\xff").startswith("invalid:")


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["timeout", "cancel"])
async def test_runner_kills_process_tree_on_timeout_or_explicit_cancel(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    mode: str,
) -> None:
    killed = asyncio.Event()
    killed_pids: list[int] = []

    class FakeProcess:
        returncode = -1
        pid = 4242

        async def communicate(self, _payload):
            await killed.wait()
            return b"partial", b"stopped"

    async def fake_create(*_argv, **_kwargs):
        return FakeProcess()

    def fake_kill(pid: int) -> None:
        killed_pids.append(pid)
        killed.set()

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_create)
    monkeypatch.setattr("backend.app.git.runner.kill_process_tree", fake_kill)
    cancel_event = asyncio.Event() if mode == "cancel" else None
    if cancel_event is not None:
        cancel_event.set()

    result = await GitCliRunner().run(
        ["status"],
        cwd=tmp_path,
        timeout_seconds=0.01 if mode == "timeout" else 5,
        cancel_event=cancel_event,
    )

    assert killed_pids == ([4242] if mode == "timeout" else [])
    assert result.timed_out is (mode == "timeout")
    assert result.cancelled is (mode == "cancel")
    assert result.succeeded is False


@pytest.mark.asyncio
async def test_runner_prefers_a_ready_cancel_signal_over_a_fast_command_result(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    class FakeProcess:
        returncode = 0
        pid = 4243

        async def communicate(self, _payload):
            return b"completed", b""

    async def fake_create(*_argv, **_kwargs):
        return FakeProcess()

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_create)
    cancel_event = asyncio.Event()
    cancel_event.set()

    result = await GitCliRunner().run(
        ["status"],
        cwd=tmp_path,
        timeout_seconds=5,
        cancel_event=cancel_event,
    )

    assert result.cancelled is True
    assert result.succeeded is False


@pytest.mark.asyncio
@pytest.mark.skipif(os.name != "nt", reason="Windows taskkill process-tree integration")
async def test_runner_really_kills_a_spawned_windows_child_on_cancel(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    async def unavailable(*_argv, **_kwargs):
        raise NotImplementedError

    monkeypatch.setattr(asyncio, "create_subprocess_exec", unavailable)
    child_pid_file = tmp_path / "child.pid"
    spawn_script = tmp_path / "spawn-child.py"
    spawn_script.write_text(
        "import subprocess, sys, time\n"
        "from pathlib import Path\n"
        "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\n"
        f"Path({str(child_pid_file)!r}).write_text(str(child.pid), encoding='utf-8')\n"
        "time.sleep(60)\n",
        encoding="utf-8",
    )
    python_executable = Path(sys.executable).as_posix()
    alias = f"alias.keydex-spawn=!'{python_executable}' '{spawn_script.as_posix()}'"
    cancel_event = asyncio.Event()

    async def cancel_after_child_starts() -> None:
        for _ in range(100):
            if child_pid_file.exists():
                cancel_event.set()
                return
            await asyncio.sleep(0.02)
        raise AssertionError("child process did not start")

    canceller = asyncio.create_task(cancel_after_child_starts())
    result = await GitCliRunner().run(
        ["-c", alias, "keydex-spawn"],
        cwd=tmp_path,
        timeout_seconds=10,
        cancel_event=cancel_event,
    )
    await canceller
    child_pid = int(child_pid_file.read_text(encoding="utf-8"))
    for _ in range(100):
        if not _windows_process_exists(child_pid):
            break
        await asyncio.sleep(0.02)

    assert result.cancelled is True
    assert _windows_process_exists(child_pid) is False


@pytest.mark.asyncio
async def test_runner_caps_output_and_marks_truncation(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    class FakeProcess:
        returncode = 0

        async def communicate(self, _payload):
            return b"0123456789", b"abcdefghij"

    async def fake_create(*_argv, **_kwargs):
        return FakeProcess()

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_create)
    result = await GitCliRunner().run(["status"], cwd=tmp_path, max_output_bytes=5)
    assert result.stdout == "01234"
    assert result.stderr == "abcde"
    assert result.stdout_truncated is True
    assert result.stderr_truncated is True


@pytest.mark.asyncio
async def test_runner_bounds_concurrent_git_processes(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    release = asyncio.Event()
    active = 0
    maximum_active = 0

    class FakeProcess:
        returncode = 0
        pid = 4300

        async def communicate(self, _payload):
            nonlocal active
            await release.wait()
            active -= 1
            return b"ok", b""

    async def fake_create(*_argv, **_kwargs):
        nonlocal active, maximum_active
        active += 1
        maximum_active = max(maximum_active, active)
        return FakeProcess()

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_create)
    runner = GitCliRunner(max_concurrency=2)
    tasks = [asyncio.create_task(runner.run(["status"], cwd=tmp_path)) for _ in range(8)]
    for _ in range(100):
        if active == 2:
            break
        await asyncio.sleep(0)

    assert active == 2
    assert maximum_active == 2
    release.set()
    results = await asyncio.gather(*tasks)

    assert all(result.succeeded for result in results)
    assert maximum_active == 2


def test_git_diagnostics_redact_credentials_tokens_and_authorization_headers() -> None:
    raw = (
        "https://user:password@example.test/repo?access_token=abc123&ok=1\n"
        "Authorization: Bearer top-secret\n"
        "token=plain password=hunter2"
    )
    redacted = redact_git_output(raw)
    assert "user:password" not in redacted
    assert "abc123" not in redacted
    assert "top-secret" not in redacted
    assert "hunter2" not in redacted
    assert redacted.count("***") >= 4


def _windows_process_exists(pid: int) -> bool:
    if os.name != "nt":
        return False
    process = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)
    if not process:
        return False
    ctypes.windll.kernel32.CloseHandle(process)
    return True
