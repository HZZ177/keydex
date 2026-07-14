from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator

CommandShell = Literal["git_bash", "powershell", "cmd"]
CommandTimeoutSource = Literal["default", "model"]
DEFAULT_COMMAND_TIMEOUT_SECONDS = 5 * 60
MAX_COMMAND_TIMEOUT_SECONDS = 60 * 60
LEGACY_DEFAULT_COMMAND_TIMEOUT_SECONDS = 2 * 60
LEGACY_MAX_COMMAND_TIMEOUT_SECONDS = 10 * 60
FileAccessMode = Literal[
    "no_file_access",
    "workspace_read_only",
    "workspace_trusted",
    "full_access",
]
CommandStatus = Literal[
    "running",
    "completed",
    "timed_out",
    "cancelled",
    "failed_to_start",
    "shell_not_available",
    "output_limit_exceeded",
    "rejected",
]


class CommandShellConfig(BaseModel):
    shell_path: str = ""
    shell_label: str = ""
    shell_edition: str | None = None
    shell_version: str | None = None

    @field_validator("shell_path", "shell_label", "shell_edition", "shell_version", mode="before")
    @classmethod
    def _strip_optional_text(cls, value: Any) -> Any:
        if value is None:
            return None
        if isinstance(value, str):
            return value.strip()
        return value

    @property
    def configured(self) -> bool:
        return bool(self.shell_path.strip() and self.shell_label.strip())


TOOL_BY_SHELL: dict[CommandShell, str] = {
    "git_bash": "run_git_bash",
    "powershell": "run_powershell",
    "cmd": "run_cmd",
}
SHELL_BY_TOOL: dict[str, CommandShell] = {tool: shell for shell, tool in TOOL_BY_SHELL.items()}


class CommandSettings(BaseModel):
    command_enabled: bool = False
    selected_shell: CommandShell = "git_bash"
    shell_path: str = ""
    shell_label: str = ""
    shell_edition: str | None = None
    shell_version: str | None = None
    shells: dict[CommandShell, CommandShellConfig] = Field(default_factory=dict)
    require_approval_for_untrusted: bool = True
    allow_persistent_trust: bool = True
    file_access_mode: FileAccessMode = "workspace_trusted"
    default_timeout_seconds: float = Field(
        default=DEFAULT_COMMAND_TIMEOUT_SECONDS,
        ge=0.1,
        le=MAX_COMMAND_TIMEOUT_SECONDS,
    )
    max_timeout_seconds: float = Field(
        default=MAX_COMMAND_TIMEOUT_SECONDS,
        ge=0.1,
        le=MAX_COMMAND_TIMEOUT_SECONDS,
    )
    inline_output_max_chars: int = Field(default=12000, ge=256, le=512 * 1024)
    tail_max_chars: int = Field(default=12000, ge=256, le=256 * 1024)
    output_file_max_bytes: int = Field(default=8 * 1024 * 1024, ge=64 * 1024, le=256 * 1024 * 1024)
    progress_interval_ms: int = Field(default=500, ge=100, le=5000)

    @model_validator(mode="before")
    @classmethod
    def _migrate_legacy_command_settings(cls, value: Any) -> Any:
        if not isinstance(value, dict):
            return value
        data = dict(value)
        if (
            data.get("default_timeout_seconds") == LEGACY_DEFAULT_COMMAND_TIMEOUT_SECONDS
            and data.get("max_timeout_seconds") == LEGACY_MAX_COMMAND_TIMEOUT_SECONDS
        ):
            data["default_timeout_seconds"] = DEFAULT_COMMAND_TIMEOUT_SECONDS
            data["max_timeout_seconds"] = MAX_COMMAND_TIMEOUT_SECONDS
        legacy_selected_shell = data.get("selected_shell")
        if legacy_selected_shell == "bash":
            data["selected_shell"] = "git_bash"
        elif legacy_selected_shell is None and "selected_shell" not in data:
            inferred_shell = _infer_legacy_selected_shell(
                str(data.get("shell_path") or ""),
                str(data.get("shell_label") or ""),
            )
            if inferred_shell is not None:
                data["selected_shell"] = inferred_shell

        shells = data.get("shells")
        if isinstance(shells, dict) and "bash" in shells and "git_bash" not in shells:
            migrated_shells = dict(shells)
            migrated_shells["git_bash"] = migrated_shells.pop("bash")
            data["shells"] = migrated_shells

        if "command_enabled" not in data:
            data["command_enabled"] = bool(
                str(data.get("shell_path") or "").strip()
                and str(data.get("shell_label") or "").strip()
            )

        if legacy_selected_shell == "bash":
            path = str(data.get("shell_path") or "")
            label = str(data.get("shell_label") or "")
            if path and not _looks_like_git_bash_path(path):
                data["shell_path"] = ""
                data["shell_label"] = ""
                data["shell_edition"] = None
                data["shell_version"] = None
            elif label.lower() == "bash":
                data["shell_label"] = "Git Bash"
                if data.get("shell_edition") == "bash":
                    data["shell_edition"] = "git-bash"
        return data

    @field_validator("shell_path", "shell_label", "shell_edition", "shell_version", mode="before")
    @classmethod
    def _strip_optional_text(cls, value: Any) -> Any:
        if value is None:
            return None
        if isinstance(value, str):
            return value.strip()
        return value

    @model_validator(mode="after")
    def _max_timeout_must_cover_default(self) -> CommandSettings:
        if self.max_timeout_seconds < self.default_timeout_seconds:
            raise ValueError("最大超时时间不能小于默认超时时间")
        if self.selected_shell not in self.shells and self.shell_path and self.shell_label:
            self.shells[self.selected_shell] = CommandShellConfig(
                shell_path=self.shell_path,
                shell_label=self.shell_label,
                shell_edition=self.shell_edition,
                shell_version=self.shell_version,
            )
        return self

    @property
    def configured(self) -> bool:
        return self.command_enabled and self.config_for_shell(self.selected_shell).configured

    @property
    def tool_name(self) -> str:
        return TOOL_BY_SHELL[self.selected_shell]

    def config_for_shell(self, shell: CommandShell) -> CommandShellConfig:
        config = self.shells.get(shell)
        if config is not None and config.configured:
            return config
        if shell == self.selected_shell:
            return CommandShellConfig(
                shell_path=self.shell_path,
                shell_label=self.shell_label,
                shell_edition=self.shell_edition,
                shell_version=self.shell_version,
            )
        return CommandShellConfig()


def _looks_like_git_bash_path(path: str) -> bool:
    normalized = path.replace("/", "\\").lower()
    return "\\git\\bin\\bash.exe" in normalized or "\\git\\usr\\bin\\bash.exe" in normalized


def _infer_legacy_selected_shell(path: str, label: str) -> CommandShell | None:
    if not path.strip() and not label.strip():
        return None
    normalized_label = label.strip().lower()
    executable = path.replace("\\", "/").rstrip("/").rsplit("/", 1)[-1].lower()
    if _looks_like_git_bash_path(path) or "git bash" in normalized_label:
        return "git_bash"
    if executable in {"pwsh.exe", "pwsh", "powershell.exe", "powershell"}:
        return "powershell"
    if "powershell" in normalized_label or "pwsh" in normalized_label:
        return "powershell"
    if executable in {"cmd.exe", "cmd"} or "cmd" in normalized_label:
        return "cmd"
    return "cmd"


class CommandRuntime(BaseModel):
    shell: CommandShell
    tool_name: str
    shell_path: str
    shell_label: str
    shell_edition: str | None = None

    @classmethod
    def from_settings(cls, settings: CommandSettings) -> CommandRuntime | None:
        if not settings.configured:
            return None
        config = settings.config_for_shell(settings.selected_shell)
        return cls(
            shell=settings.selected_shell,
            tool_name=settings.tool_name,
            shell_path=config.shell_path,
            shell_label=config.shell_label,
            shell_edition=config.shell_edition,
        )


class CommandToolArgs(BaseModel):
    command: str = Field(min_length=1)
    description: str = ""
    cwd: str = "."
    timeout_seconds: float | None = None

    @field_validator("command", "description", "cwd", mode="before")
    @classmethod
    def _strip_text(cls, value: Any) -> Any:
        if isinstance(value, str):
            return value.strip()
        return value

    @field_validator("command")
    @classmethod
    def _command_required(cls, value: str) -> str:
        if not value:
            raise ValueError("command 必须是非空字符串")
        return value

    @field_validator("cwd")
    @classmethod
    def _cwd_required(cls, value: str) -> str:
        return value or "."


@dataclass(frozen=True)
class CommandRequest:
    command_id: str
    tool_name: str
    command: str
    description: str
    cwd: Path
    cwd_label: str
    timeout_seconds: float
    timeout_source: CommandTimeoutSource
    session_id: str
    user_id: str
    turn_index: int
    trace_id: str | None
    run_id: str | None
    tool_call_id: str | None


@dataclass(frozen=True)
class CommandProgress:
    kind: str
    command_id: str
    tool: str
    run_id: str | None
    tool_call_id: str | None
    status: CommandStatus
    elapsed_ms: int
    output_bytes: int
    combined_tail: str
    stdout_tail: str
    stderr_tail: str
    can_terminate: bool
    output_path: str | None = None


@dataclass(frozen=True)
class CommandRunResult:
    kind: str
    command_id: str
    tool: str
    shell: CommandShell
    shell_label: str
    shell_path: str
    command: str
    description: str
    cwd: str
    status: CommandStatus
    exit_code: int | None
    duration_ms: int
    timeout_seconds: float
    timeout_source: CommandTimeoutSource
    output_path: str | None
    output_bytes: int
    output_truncated: bool
    output_limit_exceeded: bool
    stdout: str
    stderr: str
    stdout_tail: str
    stderr_tail: str
    combined_tail: str
    approval: dict[str, Any]
    cancel_reason: str | None = None
    error: dict[str, Any] | None = None
    run_id: str | None = None
    tool_call_id: str | None = None

    def to_payload(self) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "kind": self.kind,
            "command_id": self.command_id,
            "tool": self.tool,
            "shell": self.shell,
            "shell_label": self.shell_label,
            "shell_path": self.shell_path,
            "command": self.command,
            "description": self.description,
            "cwd": self.cwd,
            "status": self.status,
            "exit_code": self.exit_code,
            "duration_ms": self.duration_ms,
            "timeout_seconds": self.timeout_seconds,
            "timeout_source": self.timeout_source,
            "output_path": self.output_path,
            "output_bytes": self.output_bytes,
            "output_truncated": self.output_truncated,
            "output_limit_exceeded": self.output_limit_exceeded,
            "stdout": self.stdout,
            "stderr": self.stderr,
            "stdout_tail": self.stdout_tail,
            "stderr_tail": self.stderr_tail,
            "combined_tail": self.combined_tail,
            "approval": self.approval,
            "cancel_reason": self.cancel_reason,
            "can_terminate": False,
            "run_id": self.run_id,
            "tool_call_id": self.tool_call_id,
            "tool_summary": command_tool_summary(self),
        }
        if self.error is not None:
            payload["error"] = self.error
        return payload


def command_tool_summary(result: CommandRunResult) -> str:
    if result.status == "completed":
        if result.exit_code == 0:
            outcome = "命令执行完成，退出码 0。"
        else:
            outcome = f"命令执行完成，退出码 {result.exit_code}。"
    elif result.status == "timed_out":
        outcome = "命令超过超时时间，已终止。"
    elif result.status == "cancelled":
        duration = _format_duration_ms(result.duration_ms)
        if result.cancel_reason == "user":
            outcome = f"命令运行 {duration} 后被用户终止，本次工具调用已取消。"
        else:
            outcome = f"命令运行 {duration} 后被终止，本次工具调用已取消。"
    elif result.status == "rejected":
        outcome = "命令未执行，因为审批被拒绝。"
    elif result.status == "output_limit_exceeded":
        outcome = "命令输出超过文件上限，已终止。"
    elif result.status == "shell_not_available":
        outcome = "命令未执行，因为当前命令环境不可用。"
    else:
        outcome = "命令启动或执行失败。"
    if result.output_truncated and result.output_path:
        outcome += f" 输出较长，仅返回尾部，完整输出见 {result.output_path}。"
    return outcome


def _format_duration_ms(duration_ms: int) -> str:
    if duration_ms < 1000:
        return f"{duration_ms}ms"
    seconds = duration_ms / 1000
    if seconds < 10:
        return f"{seconds:.1f}秒"
    return f"{round(seconds)}秒"
