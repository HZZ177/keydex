from __future__ import annotations

import subprocess
import threading
from dataclasses import dataclass
from typing import Literal

from backend.app.core.logger import logger
from backend.app.tools.command_runtime.process_tree import kill_process_tree

CancelReason = Literal["user", "turn_cancelled", "shutdown", "timeout", "output_limit"]


@dataclass
class ActiveCommand:
    command_id: str
    session_id: str
    turn_index: int
    trace_id: str | None
    run_id: str | None
    tool_call_id: str | None
    shell: str
    shell_path: str
    pid: int
    process: subprocess.Popen
    cancel_event: threading.Event
    cancel_reason: CancelReason | None = None


class CommandProcessManager:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._active: dict[str, ActiveCommand] = {}

    def register(self, command: ActiveCommand) -> None:
        with self._lock:
            self._active[command.command_id] = command
        logger.info(
            "[CommandRuntime] 注册运行中命令 | "
            f"command_id={command.command_id} | session_id={command.session_id} | "
            f"turn_index={command.turn_index} | pid={command.pid}"
        )

    def finish(self, command_id: str) -> None:
        with self._lock:
            self._active.pop(command_id, None)

    def get(self, command_id: str) -> ActiveCommand | None:
        with self._lock:
            return self._active.get(command_id)

    def terminate_command(self, command_id: str, *, reason: CancelReason = "user") -> bool:
        with self._lock:
            command = self._active.get(command_id)
            if command is not None and command.cancel_event.is_set():
                return False
        if command is None:
            return False
        self._terminate(command, reason=reason)
        return True

    def terminate_session(self, session_id: str, *, reason: CancelReason = "turn_cancelled") -> int:
        with self._lock:
            commands = [
                command for command in self._active.values() if command.session_id == session_id
            ]
        for command in commands:
            self._terminate(command, reason=reason)
        return len(commands)

    def terminate_turn(
        self,
        *,
        session_id: str,
        turn_index: int | None = None,
        trace_id: str | None = None,
        reason: CancelReason = "turn_cancelled",
    ) -> int:
        with self._lock:
            commands = [
                command
                for command in self._active.values()
                if command.session_id == session_id
                and (turn_index is None or command.turn_index == turn_index)
                and (trace_id is None or command.trace_id == trace_id)
            ]
        for command in commands:
            self._terminate(command, reason=reason)
        return len(commands)

    def shutdown(self) -> int:
        with self._lock:
            commands = list(self._active.values())
        for command in commands:
            self._terminate(command, reason="shutdown")
        return len(commands)

    def active_commands(self) -> list[ActiveCommand]:
        with self._lock:
            return list(self._active.values())

    def _terminate(self, command: ActiveCommand, *, reason: CancelReason) -> None:
        with self._lock:
            current = self._active.get(command.command_id)
            if current is None:
                return
            current.cancel_reason = reason
            current.cancel_event.set()
        logger.info(
            "[CommandRuntime] 终止命令进程树 | "
            f"command_id={command.command_id} | pid={command.pid} | reason={reason}"
        )
        kill_process_tree(command.pid)


command_process_manager = CommandProcessManager()
