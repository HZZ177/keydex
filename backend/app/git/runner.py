from __future__ import annotations

import asyncio
import locale
import os
import re
import subprocess
import time
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path

from backend.app.tools.command_runtime.process_tree import kill_process_tree


class GitRunnerValidationError(ValueError):
    pass


@dataclass(frozen=True)
class GitCommandResult:
    argv: tuple[str, ...]
    cwd: Path
    returncode: int
    stdout: str
    stderr: str
    duration_ms: int
    stdout_truncated: bool = False
    stderr_truncated: bool = False
    cancelled: bool = False
    timed_out: bool = False
    stdout_bytes: bytes = b""
    stderr_bytes: bytes = b""

    @property
    def succeeded(self) -> bool:
        return self.returncode == 0 and not self.cancelled and not self.timed_out

    @property
    def safe_stdout(self) -> str:
        return redact_git_output(self.stdout)

    @property
    def safe_stderr(self) -> str:
        return redact_git_output(self.stderr)


class GitCliRunner:
    def __init__(
        self,
        executable: str | Path = "git",
        *,
        max_concurrency: int | None = None,
    ) -> None:
        executable_text = str(executable).strip()
        if not executable_text or "\x00" in executable_text:
            raise GitRunnerValidationError("Git executable is invalid")
        if max_concurrency is not None and max_concurrency < 1:
            raise GitRunnerValidationError("Git concurrency limit must be positive")
        self.executable = executable_text
        self._semaphore = (
            asyncio.Semaphore(max_concurrency) if max_concurrency is not None else None
        )

    async def run(
        self,
        args: Sequence[str],
        *,
        cwd: str | Path,
        env: Mapping[str, str] | None = None,
        allow_credential_prompt: bool = False,
        input_text: str | None = None,
        timeout_seconds: float | None = None,
        cancel_event: asyncio.Event | None = None,
        max_output_bytes: int = 8 * 1024 * 1024,
    ) -> GitCommandResult:
        if self._semaphore is None:
            return await self._run_unbounded(
                args,
                cwd=cwd,
                env=env,
                allow_credential_prompt=allow_credential_prompt,
                input_text=input_text,
                timeout_seconds=timeout_seconds,
                cancel_event=cancel_event,
                max_output_bytes=max_output_bytes,
            )
        async with self._semaphore:
            return await self._run_unbounded(
                args,
                cwd=cwd,
                env=env,
                allow_credential_prompt=allow_credential_prompt,
                input_text=input_text,
                timeout_seconds=timeout_seconds,
                cancel_event=cancel_event,
                max_output_bytes=max_output_bytes,
            )

    async def _run_unbounded(
        self,
        args: Sequence[str],
        *,
        cwd: str | Path,
        env: Mapping[str, str] | None = None,
        allow_credential_prompt: bool = False,
        input_text: str | None = None,
        timeout_seconds: float | None = None,
        cancel_event: asyncio.Event | None = None,
        max_output_bytes: int = 8 * 1024 * 1024,
    ) -> GitCommandResult:
        argv = self._argv(args)
        resolved_cwd = Path(cwd).expanduser().resolve()
        if not resolved_cwd.is_dir():
            raise GitRunnerValidationError(f"Git cwd does not exist: {resolved_cwd}")
        if max_output_bytes < 1:
            raise GitRunnerValidationError("Git output limit must be positive")
        process_env = git_environment(
            env,
            allow_credential_prompt=allow_credential_prompt,
        )
        started = time.monotonic()
        if cancel_event is not None and cancel_event.is_set():
            return GitCommandResult(
                argv=argv,
                cwd=resolved_cwd,
                returncode=-1,
                stdout="",
                stderr="",
                duration_ms=max(0, round((time.monotonic() - started) * 1000)),
                cancelled=True,
            )

        creationflags = 0
        startupinfo: subprocess.STARTUPINFO | None = None
        if os.name == "nt":
            creationflags = subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP
            startupinfo = subprocess.STARTUPINFO()
            startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            startupinfo.wShowWindow = subprocess.SW_HIDE

        try:
            process: asyncio.subprocess.Process | _ThreadedProcess = (
                await asyncio.create_subprocess_exec(
                    *argv,
                    cwd=str(resolved_cwd),
                    env=process_env,
                    stdin=(
                        asyncio.subprocess.PIPE
                        if input_text is not None
                        else asyncio.subprocess.DEVNULL
                    ),
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    creationflags=creationflags,
                    startupinfo=startupinfo,
                    start_new_session=os.name != "nt",
                )
            )
        except NotImplementedError:
            # Windows SelectorEventLoop (used by some IDE/dev-server launch
            # paths) cannot create asyncio subprocess transports.  Fall back
            # to a hidden Popen hosted in worker threads while keeping the
            # same argv-only, timeout and process-tree cancellation contract.
            if os.name != "nt":
                raise
            process = await _create_threaded_windows_process(
                argv,
                cwd=resolved_cwd,
                env=process_env,
                input_enabled=input_text is not None,
                creationflags=creationflags,
                startupinfo=startupinfo,
            )
        communicate_task = asyncio.create_task(
            process.communicate(input_text.encode("utf-8") if input_text is not None else None)
        )
        cancel_task = asyncio.create_task(cancel_event.wait()) if cancel_event is not None else None
        cancelled = False
        timed_out = False
        try:
            wait_for = [communicate_task]
            if cancel_task is not None:
                wait_for.append(cancel_task)
            done, _pending = await asyncio.wait(
                wait_for,
                timeout=timeout_seconds,
                return_when=asyncio.FIRST_COMPLETED,
            )
            if cancel_task is not None and cancel_task in done:
                cancelled = True
                if communicate_task not in done:
                    await asyncio.to_thread(kill_process_tree, process.pid)
                stdout_bytes, stderr_bytes = await communicate_task
            elif communicate_task in done:
                stdout_bytes, stderr_bytes = communicate_task.result()
                cancelled = cancel_event is not None and cancel_event.is_set()
            else:
                timed_out = True
                await asyncio.to_thread(kill_process_tree, process.pid)
                stdout_bytes, stderr_bytes = await communicate_task
        except asyncio.CancelledError:
            await asyncio.to_thread(kill_process_tree, process.pid)
            await asyncio.shield(communicate_task)
            raise
        finally:
            if cancel_task is not None:
                cancel_task.cancel()
        stdout_bytes, stdout_truncated = _bounded_bytes(stdout_bytes, max_output_bytes)
        stderr_bytes, stderr_truncated = _bounded_bytes(stderr_bytes, max_output_bytes)
        return GitCommandResult(
            argv=argv,
            cwd=resolved_cwd,
            returncode=process.returncode,
            stdout=decode_git_output(stdout_bytes),
            stderr=decode_git_output(stderr_bytes),
            duration_ms=max(0, round((time.monotonic() - started) * 1000)),
            stdout_truncated=stdout_truncated,
            stderr_truncated=stderr_truncated,
            cancelled=cancelled,
            timed_out=timed_out,
            stdout_bytes=stdout_bytes,
            stderr_bytes=stderr_bytes,
        )

    def _argv(self, args: Sequence[str]) -> tuple[str, ...]:
        normalized: list[str] = [
            self.executable,
            "-c",
            "core.quotepath=false",
            "-c",
            "color.ui=false",
            "-c",
            "core.pager=cat",
        ]
        for index, argument in enumerate(args):
            if not isinstance(argument, str):
                raise GitRunnerValidationError(f"Git argument {index} must be a string")
            if "\x00" in argument:
                raise GitRunnerValidationError(f"Git argument {index} contains NUL")
            normalized.append(argument)
        return tuple(normalized)


class _ThreadedProcess:
    def __init__(self, process: subprocess.Popen[bytes]) -> None:
        self._process = process

    @property
    def pid(self) -> int:
        return self._process.pid

    @property
    def returncode(self) -> int | None:
        return self._process.returncode

    async def communicate(self, payload: bytes | None) -> tuple[bytes, bytes]:
        return await asyncio.to_thread(self._process.communicate, payload)


async def _create_threaded_windows_process(
    argv: tuple[str, ...],
    *,
    cwd: Path,
    env: Mapping[str, str],
    input_enabled: bool,
    creationflags: int,
    startupinfo: subprocess.STARTUPINFO | None,
) -> _ThreadedProcess:
    process = await asyncio.to_thread(
        subprocess.Popen,
        argv,
        cwd=str(cwd),
        env=dict(env),
        stdin=subprocess.PIPE if input_enabled else subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        creationflags=creationflags,
        startupinfo=startupinfo,
        shell=False,
    )
    return _ThreadedProcess(process)


def git_environment(
    overrides: Mapping[str, str] | None = None,
    *,
    allow_credential_prompt: bool = False,
) -> dict[str, str]:
    environment = os.environ.copy()
    if overrides:
        environment.update({str(key): str(value) for key, value in overrides.items()})
    environment.pop("GIT_ASKPASS", None)
    environment.pop("SSH_ASKPASS", None)
    environment.update(
        {
            "LC_ALL": "C",
            "LANG": "C",
            "GIT_PAGER": "cat",
            "PAGER": "cat",
            "GIT_EDITOR": "true",
            "GIT_SEQUENCE_EDITOR": "true",
            "GIT_TERMINAL_PROMPT": "0",
            "GCM_INTERACTIVE": "true" if allow_credential_prompt else "Never",
            "GCM_GUI_PROMPT": "true" if allow_credential_prompt else "false",
            "SSH_ASKPASS_REQUIRE": "never",
        }
    )
    if overrides:
        for key in (
            "GIT_EDITOR",
            "GIT_SEQUENCE_EDITOR",
            "KEYDEX_REBASE_TODO",
            "KEYDEX_REBASE_MESSAGES",
        ):
            if key in overrides:
                environment[key] = str(overrides[key])
    return environment


def decode_git_output(payload: bytes) -> str:
    if not payload:
        return ""
    try:
        return payload.decode("utf-8-sig", errors="strict")
    except UnicodeDecodeError:
        preferred = locale.getpreferredencoding(False) or "utf-8"
        return payload.decode(preferred, errors="replace")


def _bounded_bytes(payload: bytes, limit: int) -> tuple[bytes, bool]:
    if len(payload) <= limit:
        return payload, False
    return payload[:limit], True


_REDACTION_PATTERNS: tuple[tuple[re.Pattern[str], str], ...] = (
    (re.compile(r"(?i)(https?://)([^\s/@:]+):([^\s/@]+)@"), r"\1***:***@"),
    (
        re.compile(r"(?i)([?&](?:access_token|token|password|passwd|secret)=)[^\s&#]+"),
        r"\1***",
    ),
    (re.compile(r"(?i)(authorization\s*:\s*(?:bearer|basic)\s+)[^\s]+"), r"\1***"),
    (re.compile(r"(?i)\b((?:access_)?token|password|passwd|secret)=([^\s;]+)"), r"\1=***"),
)


def redact_git_output(value: str) -> str:
    redacted = value
    for pattern, replacement in _REDACTION_PATTERNS:
        redacted = pattern.sub(replacement, redacted)
    return redacted
