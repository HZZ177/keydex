from __future__ import annotations

from backend.app.tools.command_runtime.descriptions import (
    command_system_prompt_section,
    command_tool_description,
)
from backend.app.tools.command_runtime.models import CommandRuntime, CommandSettings


def test_tool_description_hides_executable_path_and_describes_windows_cmd_style() -> None:
    runtime = CommandRuntime(
        shell="cmd",
        tool_name="run_cmd",
        shell_path=r"C:\Windows\System32\cmd.exe",
        shell_label="Windows CMD",
    )

    description = command_tool_description(runtime)

    assert r"C:\Windows\System32\cmd.exe" not in description
    assert "executable" not in description.lower()
    assert "用户本机 Windows 工作区" in description
    assert "Windows CMD 语法" in description
    assert "%VAR%" in description


def test_system_prompt_includes_approval_policy_and_omits_executable_path() -> None:
    runtime = CommandRuntime(
        shell="powershell",
        tool_name="run_powershell",
        shell_path=r"C:\Program Files\PowerShell\7\pwsh.exe",
        shell_label="PowerShell 7+",
        shell_edition="Core",
    )
    settings = CommandSettings(
        command_enabled=True,
        selected_shell="powershell",
        shell_path=runtime.shell_path,
        shell_label=runtime.shell_label,
        shell_edition=runtime.shell_edition,
        require_approval_for_untrusted=True,
        allow_persistent_trust=True,
    )

    prompt = command_system_prompt_section(runtime, settings)

    assert r"C:\Program Files\PowerShell\7\pwsh.exe" not in prompt
    assert "命令解释器为 PowerShell 7+" in prompt
    assert "未命中已信任规则的命令会在执行前等待用户确认" in prompt
    assert "保存信任规则" in prompt
    assert "优先使用对应的文件/搜索/编辑工具" in prompt


def test_system_prompt_describes_unconditional_trust_policy() -> None:
    runtime = CommandRuntime(
        shell="git_bash",
        tool_name="run_git_bash",
        shell_path=r"C:\Program Files\Git\bin\bash.exe",
        shell_label="Git Bash",
        shell_edition="git-bash",
    )
    settings = CommandSettings(
        command_enabled=True,
        selected_shell="git_bash",
        shell_path=runtime.shell_path,
        shell_label=runtime.shell_label,
        shell_edition=runtime.shell_edition,
        require_approval_for_untrusted=False,
        allow_persistent_trust=False,
    )

    prompt = command_system_prompt_section(runtime, settings)

    assert "Git for Windows 的 Git Bash" in prompt
    assert "不是 WSL/MSYS2/Cygwin" in prompt
    assert "不会在执行前请求用户审批" in prompt


def test_full_access_prompt_allows_external_cwd_without_promising_shell_history() -> None:
    runtime = CommandRuntime(
        shell="powershell",
        tool_name="run_powershell",
        shell_path=r"C:\Program Files\PowerShell\7\pwsh.exe",
        shell_label="PowerShell 7+",
    )
    settings = CommandSettings(
        selected_shell="powershell",
        shell_path=runtime.shell_path,
        shell_label=runtime.shell_label,
        file_access_mode="full_access",
    )

    prompt = command_system_prompt_section(runtime, settings)

    assert "任意本地目录" in prompt
    assert "命令行产生的文件或其他副作用不保证纳入统一文件历史" in prompt


def test_prompt_and_description_do_not_trust_path_like_shell_label() -> None:
    runtime = CommandRuntime(
        shell="powershell",
        tool_name="run_powershell",
        shell_path=r"C:\Program Files\PowerShell\7\pwsh.exe",
        shell_label=r"C:\Program Files\PowerShell\7\pwsh.exe",
        shell_edition=r"D:\unexpected\edition.exe",
    )
    settings = CommandSettings(
        command_enabled=True,
        selected_shell="powershell",
        shell_path=runtime.shell_path,
        shell_label=runtime.shell_label,
        shell_edition=runtime.shell_edition,
    )

    description = command_tool_description(runtime)
    prompt = command_system_prompt_section(runtime, settings)

    assert r"C:\Program Files\PowerShell\7\pwsh.exe" not in description
    assert r"C:\Program Files\PowerShell\7\pwsh.exe" not in prompt
    assert r"D:\unexpected\edition.exe" not in description
    assert r"D:\unexpected\edition.exe" not in prompt
    assert "PowerShell 7+" in description
    assert "PowerShell 7+" in prompt
