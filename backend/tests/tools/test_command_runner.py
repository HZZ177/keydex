from __future__ import annotations

import sys
import threading
import time
from pathlib import Path
from typing import Any

import pytest

from backend.app.tools.command_runtime.models import CommandRequest, CommandRuntime
from backend.app.tools.command_runtime.output_store import CommandOutputStore
from backend.app.tools.command_runtime.process_manager import CommandProcessManager
from backend.app.tools.command_runtime.providers import CommandSpawnSpec
from backend.app.tools.command_runtime.runner import CommandRunner


class PythonProvider:
    def build(self, runtime: CommandRuntime, command: str) -> CommandSpawnSpec:
        return CommandSpawnSpec(
            executable=sys.executable,
            argv=[sys.executable, "-c", command],
            shell_label="Python",
            shell_path=sys.executable,
        )


def _runtime() -> CommandRuntime:
    return CommandRuntime(
        shell="git_bash",
        tool_name="run_git_bash",
        shell_path=str(Path(sys.executable)),
        shell_label="Python Test Shell",
    )


def _request(tmp_path, command: str, *, timeout_seconds: float = 5) -> CommandRequest:
    return CommandRequest(
        command_id="cmd-test",
        tool_name="run_git_bash",
        command=command,
        description="test command",
        cwd=tmp_path,
        cwd_label=".",
        timeout_seconds=timeout_seconds,
        session_id="ses-command",
        user_id="local-user",
        turn_index=1,
        trace_id="trace-command",
        run_id="run-command",
        tool_call_id="tool-call-command",
    )


def _store(tmp_path, *, inline_chars: int = 12000, file_bytes: int = 1024 * 1024):
    return CommandOutputStore(
        output_path=tmp_path / "out.log",
        inline_output_max_chars=inline_chars,
        tail_max_chars=2048,
        output_file_max_bytes=file_bytes,
    )


def _git_bash_path() -> Path | None:
    for raw_path in (
        "C:/Program Files/Git/bin/bash.exe",
        "C:/Program Files/Git/usr/bin/bash.exe",
        "C:/Program Files (x86)/Git/bin/bash.exe",
        "C:/Program Files (x86)/Git/usr/bin/bash.exe",
    ):
        path = Path(raw_path)
        if path.exists():
            return path
    return None


def test_command_runner_runs_successful_foreground_command(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(
        "backend.app.tools.command_runtime.runner.provider_for_runtime",
        lambda runtime: PythonProvider(),
    )

    result = CommandRunner().run(
        request=_request(tmp_path, "print('ok')"),
        runtime=_runtime(),
        output_store=_store(tmp_path),
        approval={"required": False},
    )

    assert result.status == "completed"
    assert result.exit_code == 0
    assert result.stdout.strip() == "ok"
    assert result.cwd == "."
    assert Path(result.output_path or "").exists()


def test_command_runner_returns_nonzero_as_completed(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(
        "backend.app.tools.command_runtime.runner.provider_for_runtime",
        lambda runtime: PythonProvider(),
    )

    result = CommandRunner().run(
        request=_request(tmp_path, "import sys; print('bad', file=sys.stderr); sys.exit(3)"),
        runtime=_runtime(),
        output_store=_store(tmp_path),
        approval={"required": False},
    )

    assert result.status == "completed"
    assert result.exit_code == 3
    assert "bad" in result.stderr


def test_command_runner_times_out_and_preserves_tail(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(
        "backend.app.tools.command_runtime.runner.provider_for_runtime",
        lambda runtime: PythonProvider(),
    )

    result = CommandRunner().run(
        request=_request(
            tmp_path,
            "import time; print('before-timeout', flush=True); time.sleep(2)",
            timeout_seconds=0.2,
        ),
        runtime=_runtime(),
        output_store=_store(tmp_path),
        approval={"required": False},
    )

    assert result.status == "timed_out"
    assert "before-timeout" in result.stdout_tail


def test_command_runner_uses_cwd(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(
        "backend.app.tools.command_runtime.runner.provider_for_runtime",
        lambda runtime: PythonProvider(),
    )

    result = CommandRunner().run(
        request=_request(
            tmp_path,
            "from pathlib import Path; print(Path.cwd().name)",
        ),
        runtime=_runtime(),
        output_store=_store(tmp_path),
        approval={"required": False},
    )

    assert result.status == "completed"
    assert tmp_path.name in result.stdout


def test_command_runner_limits_output_file_and_returns_tail(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(
        "backend.app.tools.command_runtime.runner.provider_for_runtime",
        lambda runtime: PythonProvider(),
    )

    result = CommandRunner().run(
        request=_request(
            tmp_path,
            "for index in range(200): print('line-' + str(index))",
        ),
        runtime=_runtime(),
        output_store=_store(tmp_path, inline_chars=256, file_bytes=512),
        approval={"required": False},
    )

    assert result.status == "output_limit_exceeded"
    assert result.output_limit_exceeded is True
    assert result.output_truncated is True
    assert "line-" in result.combined_tail


def test_command_runner_returns_cancelled_result_when_user_terminates_command(
    tmp_path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        "backend.app.tools.command_runtime.runner.provider_for_runtime",
        lambda runtime: PythonProvider(),
    )
    manager = CommandProcessManager()
    result_holder: list[Any] = []

    def run_command() -> None:
        result_holder.append(
            CommandRunner(manager=manager).run(
                request=_request(
                    tmp_path,
                    "import time; print('before-cancel', flush=True); time.sleep(10)",
                ),
                runtime=_runtime(),
                output_store=_store(tmp_path),
                approval={"required": False},
            )
        )

    thread = threading.Thread(target=run_command, daemon=True)
    thread.start()
    for _ in range(100):
        if manager.get("cmd-test") is not None:
            break
        time.sleep(0.01)

    assert manager.terminate_command("cmd-test", reason="user") is True
    assert manager.terminate_command("cmd-test", reason="user") is False
    thread.join(timeout=5)

    assert not thread.is_alive()
    assert result_holder
    result = result_holder[0]
    assert result.status == "cancelled"
    assert result.cancel_reason == "user"
    assert "before-cancel" in result.stdout_tail
    assert "用户终止" in result.to_payload()["tool_summary"]


def test_command_runner_terminates_git_bash_sleep_without_waiting_for_exit(
    tmp_path,
) -> None:
    if sys.platform != "win32":
        pytest.skip("Git Bash cancellation behavior is Windows-specific")
    bash = _git_bash_path()
    if bash is None:
        pytest.skip("Git Bash is not installed")

    manager = CommandProcessManager()
    runtime = CommandRuntime(
        shell="git_bash",
        tool_name="run_git_bash",
        shell_path=str(bash),
        shell_label="Git Bash",
    )
    request = _request(
        tmp_path,
        "sleep 20 && echo done",
        timeout_seconds=60,
    )
    result_holder: list[Any] = []

    def run_command() -> None:
        result_holder.append(
            CommandRunner(manager=manager).run(
                request=request,
                runtime=runtime,
                output_store=_store(tmp_path),
                approval={"required": False},
            )
        )

    started_at = time.perf_counter()
    thread = threading.Thread(target=run_command, daemon=True)
    thread.start()
    for _ in range(100):
        if manager.get("cmd-test") is not None:
            break
        time.sleep(0.01)
    else:
        pytest.fail("Git Bash command did not register as active")

    time.sleep(0.2)
    assert manager.terminate_command("cmd-test", reason="user") is True
    thread.join(timeout=8)

    elapsed = time.perf_counter() - started_at
    assert not thread.is_alive()
    assert elapsed < 8
    assert result_holder
    result = result_holder[0]
    assert result.status == "cancelled"
    assert result.cancel_reason == "user"
    assert "done" not in result.stdout_tail
