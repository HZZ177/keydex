from __future__ import annotations

import pytest
from pydantic import ValidationError

from backend.app.tools.command_runtime.models import CommandRuntime, CommandSettings
from backend.app.tools.command_runtime.tools import _effective_timeout


def test_command_settings_defaults_are_single_runtime_shape() -> None:
    settings = CommandSettings()

    assert settings.command_enabled is True
    assert settings.selected_shell == "git_bash"
    assert settings.configured is False
    assert settings.tool_name == "run_git_bash"
    assert settings.default_timeout_seconds == 300
    assert settings.max_timeout_seconds == 3600


def test_command_settings_preserves_disabled_legacy_runtime_without_executable() -> None:
    settings = CommandSettings(selected_shell="cmd", shell_path="", shell_label="")

    assert settings.command_enabled is False


def test_command_settings_migrates_previous_timeout_defaults() -> None:
    settings = CommandSettings(
        default_timeout_seconds=120,
        max_timeout_seconds=600,
    )

    assert settings.default_timeout_seconds == 300
    assert settings.max_timeout_seconds == 3600


def test_effective_timeout_uses_five_minute_default_and_one_hour_cap() -> None:
    settings = CommandSettings()

    assert _effective_timeout(None, settings) == 300
    assert _effective_timeout(30, settings) == 30
    assert _effective_timeout(7200, settings) == 3600


def test_command_settings_rejects_invalid_shell() -> None:
    with pytest.raises(ValidationError):
        CommandSettings(selected_shell="fish")


def test_command_settings_migrates_legacy_bash_to_git_bash() -> None:
    settings = CommandSettings(
        selected_shell="bash",
        shell_path=r"C:\Program Files\Git\bin\bash.exe",
        shell_label="Bash",
        shell_edition="bash",
    )

    assert settings.command_enabled is True
    assert settings.selected_shell == "git_bash"
    assert settings.shell_path == r"C:\Program Files\Git\bin\bash.exe"
    assert settings.shell_label == "Git Bash"
    assert settings.shell_edition == "git-bash"
    assert settings.tool_name == "run_git_bash"


def test_command_settings_migrates_legacy_wsl_bash_as_missing_git_bash() -> None:
    settings = CommandSettings(
        selected_shell="bash",
        shell_path=r"C:\Windows\System32\bash.exe",
        shell_label="Bash",
    )

    assert settings.command_enabled is True
    assert settings.selected_shell == "git_bash"
    assert settings.shell_path == ""
    assert settings.shell_label == ""
    assert settings.configured is False


def test_command_settings_preserves_legacy_single_cmd_runtime_shape() -> None:
    settings = CommandSettings(
        command_enabled=True,
        shell_path=r"C:\Windows\System32\cmd.exe",
        shell_label="Windows CMD",
    )

    assert settings.selected_shell == "cmd"
    assert settings.tool_name == "run_cmd"
    assert settings.configured is True
    assert settings.shells["cmd"].shell_path == r"C:\Windows\System32\cmd.exe"


def test_command_settings_rejects_timeout_inversion() -> None:
    with pytest.raises(ValidationError):
        CommandSettings(default_timeout_seconds=10, max_timeout_seconds=3)


def test_command_runtime_from_settings_requires_saved_path_and_label() -> None:
    assert (
        CommandRuntime.from_settings(
            CommandSettings(command_enabled=True, shell_path="", shell_label="")
        )
        is None
    )
    assert (
        CommandRuntime.from_settings(
            CommandSettings(
                command_enabled=False,
                shell_path=r"C:\Windows\System32\cmd.exe",
                shell_label="Windows CMD",
            )
        )
        is None
    )

    runtime = CommandRuntime.from_settings(
        CommandSettings(
            command_enabled=True,
            shell_path=r"C:\Windows\System32\cmd.exe",
            shell_label="Windows CMD",
        )
    )

    assert runtime is not None
    assert runtime.tool_name == "run_cmd"
