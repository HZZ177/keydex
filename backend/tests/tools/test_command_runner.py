from __future__ import annotations

import asyncio
import sys
import threading
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from backend.app.events import DomainEvent, EventDispatcher
from backend.app.tools.base import ToolExecutionContext
from backend.app.tools.command_runtime import process_manager as process_manager_module
from backend.app.tools.command_runtime import process_tree
from backend.app.tools.command_runtime import tools as command_runtime_tools
from backend.app.tools.command_runtime.models import (
    CommandRequest,
    CommandRuntime,
    CommandSettings,
)
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
        timeout_source="model",
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


def test_process_tree_kill_request_does_not_block_caller(monkeypatch) -> None:
    started = threading.Event()
    release = threading.Event()

    def blocking_kill(pid: int) -> None:
        assert pid == 123
        started.set()
        release.wait(timeout=2)

    monkeypatch.setattr(process_tree, "kill_process_tree", blocking_kill)

    started_at = time.perf_counter()
    process_tree.request_kill_process_tree(123)
    elapsed = time.perf_counter() - started_at

    try:
        assert elapsed < 0.5
        assert started.wait(timeout=1)
    finally:
        release.set()


def test_process_tree_termination_order_is_children_first() -> None:
    assert process_tree._process_tree_termination_order(
        10,
        [
            (10, 1),
            (11, 10),
            (12, 10),
            (13, 11),
            (20, 99),
        ],
    ) == [13, 12, 11, 10]


def test_process_manager_requests_tree_kill_only_once(monkeypatch) -> None:
    requested_pids: list[int] = []
    manager = CommandProcessManager()
    cancel_event = threading.Event()
    command = process_manager_module.ActiveCommand(
        command_id="cmd-test",
        session_id="ses-command",
        turn_index=1,
        trace_id="trace-command",
        run_id="run-command",
        tool_call_id="tool-call-command",
        shell="git_bash",
        shell_path=str(Path(sys.executable)),
        pid=321,
        process=SimpleNamespace(),
        cancel_event=cancel_event,
    )
    monkeypatch.setattr(
        process_manager_module,
        "request_kill_process_tree",
        requested_pids.append,
    )
    manager.register(command)

    assert manager.terminate_command("cmd-test", reason="user") is True
    assert manager.terminate_session("ses-command", reason="turn_cancelled") == 0
    assert manager.terminate_turn(session_id="ses-command", turn_index=1) == 0

    assert requested_pids == [321]
    assert cancel_event.is_set()
    assert command.cancel_reason == "user"


@pytest.mark.asyncio
async def test_command_progress_is_emitted_as_soon_as_process_is_registered(
    tmp_path,
    monkeypatch,
) -> None:
    received: list[DomainEvent] = []
    progress_received = asyncio.Event()

    async def capture(event: DomainEvent) -> None:
        received.append(event)
        progress_received.set()

    dispatcher = EventDispatcher([capture])
    context = ToolExecutionContext(
        session_id="ses-command",
        user_id="local-user",
        workspace_root=tmp_path,
        turn_index=1,
        trace_id="trace-command",
        metadata={"dispatcher": dispatcher},
    )
    cancel_event = threading.Event()
    active = SimpleNamespace(cancel_reason=None, cancel_event=cancel_event)
    get_calls = 0

    def get_after_registration(command_id: str):
        nonlocal get_calls
        assert command_id == "cmd-test"
        get_calls += 1
        return None if get_calls < 3 else active

    monkeypatch.setattr(
        command_runtime_tools.command_process_manager,
        "get",
        get_after_registration,
    )
    progress_task = asyncio.create_task(
        command_runtime_tools._emit_progress_until_done(
            request=_request(tmp_path, "print('ok')"),
            runtime=_runtime(),
            output_store=_store(tmp_path),
            context=context,
            settings=CommandSettings(progress_interval_ms=500),
        )
    )

    try:
        await asyncio.wait_for(progress_received.wait(), timeout=0.25)
    finally:
        progress_task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await progress_task

    assert get_calls >= 3
    assert len(received) == 1
    assert received[0].payload["kind"] == "command_progress"
    assert received[0].payload["command_id"] == "cmd-test"
    assert received[0].payload["status"] == "running"
    assert received[0].payload["can_terminate"] is True


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
    output_store = _store(tmp_path)

    def run_command() -> None:
        result_holder.append(
            CommandRunner(manager=manager).run(
                request=_request(
                    tmp_path,
                    "import time; print('before-cancel' + 'x' * 5000, flush=True); time.sleep(10)",
                ),
                runtime=_runtime(),
                output_store=output_store,
                approval={"required": False},
            )
        )

    thread = threading.Thread(target=run_command, daemon=True)
    thread.start()
    for _ in range(100):
        if manager.get("cmd-test") is not None:
            break
        time.sleep(0.01)
    for _ in range(100):
        if "before-cancel" in output_store.snapshot().stdout_tail:
            break
        time.sleep(0.01)
    else:
        pytest.fail("Command did not emit its initial output before cancellation")

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
    thread.join(timeout=3)

    elapsed = time.perf_counter() - started_at
    assert not thread.is_alive()
    assert elapsed < 3
    assert result_holder
    result = result_holder[0]
    assert result.status == "cancelled"
    assert result.cancel_reason == "user"
    assert "done" not in result.stdout_tail
