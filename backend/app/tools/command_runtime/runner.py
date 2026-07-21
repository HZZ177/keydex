from __future__ import annotations

import subprocess
import sys
import threading
import time
from pathlib import Path

from backend.app.core.logger import logger
from backend.app.tools.command_runtime.models import (
    CommandRequest,
    CommandRunResult,
    CommandRuntime,
    CommandStatus,
)
from backend.app.tools.command_runtime.output_store import CommandOutputStore
from backend.app.tools.command_runtime.process_manager import (
    ActiveCommand,
    CommandProcessManager,
    command_process_manager,
)
from backend.app.tools.command_runtime.providers import provider_for_runtime

_PROCESS_TREE_TERMINATION_GRACE_SECONDS = 2


class CommandRunner:
    def __init__(self, manager: CommandProcessManager | None = None) -> None:
        self.manager = manager or command_process_manager

    def run(
        self,
        *,
        request: CommandRequest,
        runtime: CommandRuntime,
        output_store: CommandOutputStore,
        approval: dict[str, object],
    ) -> CommandRunResult:
        started_at = time.perf_counter()
        output_store.open()
        process: subprocess.Popen | None = None
        cancel_event = threading.Event()
        try:
            spec = provider_for_runtime(runtime).build(runtime, request.command)
            process = subprocess.Popen(
                spec.argv,
                cwd=request.cwd,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                shell=False,
                creationflags=_creationflags(),
                startupinfo=_startupinfo(),
                start_new_session=sys.platform != "win32",
            )
            active = ActiveCommand(
                command_id=request.command_id,
                session_id=request.session_id,
                turn_index=request.turn_index,
                trace_id=request.trace_id,
                run_id=request.run_id,
                tool_call_id=request.tool_call_id,
                shell=runtime.shell,
                shell_path=runtime.shell_path,
                pid=process.pid,
                process=process,
                cancel_event=cancel_event,
            )
            self.manager.register(active)
            readers = [
                _reader_thread("stdout", process.stdout, output_store),
                _reader_thread("stderr", process.stderr, output_store),
            ]
            deadline = started_at + request.timeout_seconds
            status: CommandStatus = "completed"
            cancel_reason: str | None = None
            while process.poll() is None:
                manager_record = self.manager.get(request.command_id)
                if manager_record is not None and manager_record.cancel_event.is_set():
                    cancel_reason = manager_record.cancel_reason or "user"
                    status = "cancelled"
                    logger.info(
                        "[CommandRuntime] 检测到命令取消信号 | "
                        f"command_id={request.command_id} | reason={cancel_reason}"
                    )
                    break
                if time.perf_counter() >= deadline:
                    status = "timed_out"
                    cancel_reason = "timeout"
                    self.manager.terminate_command(request.command_id, reason="timeout")
                    break
                if output_store.output_limit_exceeded:
                    status = "output_limit_exceeded"
                    cancel_reason = "output_limit"
                    self.manager.terminate_command(request.command_id, reason="output_limit")
                    break
                time.sleep(0.05)

            manager_record = self.manager.get(request.command_id)
            if manager_record is not None and manager_record.cancel_event.is_set():
                cancel_reason = manager_record.cancel_reason or cancel_reason or "user"
                if status == "completed":
                    status = _status_for_cancel_reason(cancel_reason)

            forced_termination = status in {"cancelled", "timed_out", "output_limit_exceeded"}
            exit_code = _wait_for_process_exit(
                process,
                command_id=request.command_id,
                forced=forced_termination,
            )
            _join_reader_threads(readers, timeout=0.2 if forced_termination else 5)
            snapshot = output_store.snapshot()
            if status == "completed" and snapshot.output_limit_exceeded:
                status = "output_limit_exceeded"
            duration_ms = max(0, int((time.perf_counter() - started_at) * 1000))
            logger.info(
                "[CommandRuntime] 命令完成 | "
                f"command_id={request.command_id} | shell={runtime.shell} | "
                f"status={status} | exit_code={exit_code} | duration_ms={duration_ms} | "
                f"output_bytes={snapshot.output_bytes}"
            )
            return CommandRunResult(
                kind="command_result",
                command_id=request.command_id,
                tool=request.tool_name,
                shell=runtime.shell,
                shell_label=runtime.shell_label,
                shell_path=runtime.shell_path,
                command=request.command,
                description=request.description,
                cwd=request.cwd_label,
                status=status,
                exit_code=exit_code,
                duration_ms=duration_ms,
                timeout_seconds=request.timeout_seconds,
                timeout_source=request.timeout_source,
                output_path=snapshot.output_path,
                output_bytes=snapshot.output_bytes,
                output_truncated=snapshot.output_truncated,
                output_limit_exceeded=snapshot.output_limit_exceeded,
                stdout=snapshot.stdout,
                stderr=snapshot.stderr,
                stdout_tail=snapshot.stdout_tail,
                stderr_tail=snapshot.stderr_tail,
                combined_tail=snapshot.combined_tail,
                approval=dict(approval),
                cancel_reason=cancel_reason,
                run_id=request.run_id,
                tool_call_id=request.tool_call_id,
            )
        except Exception as exc:
            duration_ms = max(0, int((time.perf_counter() - started_at) * 1000))
            snapshot = output_store.snapshot()
            logger.opt(exception=True).error(
                "[CommandRuntime] 命令启动失败 | "
                f"command_id={request.command_id} | shell={runtime.shell} | error={exc}"
            )
            return CommandRunResult(
                kind="command_result",
                command_id=request.command_id,
                tool=request.tool_name,
                shell=runtime.shell,
                shell_label=runtime.shell_label,
                shell_path=runtime.shell_path,
                command=request.command,
                description=request.description,
                cwd=request.cwd_label,
                status="failed_to_start",
                exit_code=None,
                duration_ms=duration_ms,
                timeout_seconds=request.timeout_seconds,
                timeout_source=request.timeout_source,
                output_path=snapshot.output_path if Path(snapshot.output_path).exists() else None,
                output_bytes=snapshot.output_bytes,
                output_truncated=snapshot.output_truncated,
                output_limit_exceeded=snapshot.output_limit_exceeded,
                stdout=snapshot.stdout,
                stderr=snapshot.stderr,
                stdout_tail=snapshot.stdout_tail,
                stderr_tail=snapshot.stderr_tail,
                combined_tail=snapshot.combined_tail,
                approval=dict(approval),
                error={"type": type(exc).__name__, "message": str(exc)},
                run_id=request.run_id,
                tool_call_id=request.tool_call_id,
            )
        finally:
            if process is not None:
                self.manager.finish(request.command_id)
            output_store.close()


def _reader_thread(
    stream_name: str,
    pipe,
    output_store: CommandOutputStore,
) -> threading.Thread:
    def read_loop() -> None:
        if pipe is None:
            return
        try:
            while True:
                try:
                    chunk = pipe.read(4096)
                except Exception:
                    break
                if not chunk:
                    break
                output_store.write(stream_name, chunk)
        finally:
            try:
                pipe.close()
            except Exception:
                pass

    thread = threading.Thread(target=read_loop, name=f"command-{stream_name}-reader", daemon=True)
    thread.start()
    return thread


def _wait_for_process_exit(
    process: subprocess.Popen,
    *,
    command_id: str,
    forced: bool,
) -> int | None:
    if forced:
        try:
            return process.wait(timeout=_PROCESS_TREE_TERMINATION_GRACE_SECONDS)
        except subprocess.TimeoutExpired:
            logger.warning(
                "[CommandRuntime] 进程树终止等待超时，直接终止根进程 | "
                f"command_id={command_id} | pid={process.pid}"
            )
            try:
                process.kill()
            except Exception:
                pass
            try:
                return process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                logger.warning(
                    "[CommandRuntime] 命令进程仍未退出，返回已取消结果 | "
                    f"command_id={command_id} | pid={process.pid}"
                )
                return None

    try:
        return process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        logger.warning(
            "[CommandRuntime] 等待命令进程退出超时，继续强制终止 | "
            f"command_id={command_id} | pid={process.pid}"
        )
        try:
            process.kill()
        except Exception:
            pass
        try:
            return process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            logger.warning(
                "[CommandRuntime] 命令进程仍未退出，返回已取消结果 | "
                f"command_id={command_id} | pid={process.pid}"
            )
            return None


def _join_reader_threads(readers: list[threading.Thread], *, timeout: float) -> None:
    for reader in readers:
        reader.join(timeout=timeout)


def _status_for_cancel_reason(reason: str | None) -> CommandStatus:
    if reason == "timeout":
        return "timed_out"
    if reason == "output_limit":
        return "output_limit_exceeded"
    return "cancelled"


def _creationflags() -> int:
    if sys.platform != "win32":
        return 0
    return getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(
        subprocess, "CREATE_NEW_PROCESS_GROUP", 0
    )


def _startupinfo() -> subprocess.STARTUPINFO | None:
    if sys.platform != "win32":
        return None
    startupinfo = subprocess.STARTUPINFO()
    startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    startupinfo.wShowWindow = subprocess.SW_HIDE
    return startupinfo
