from __future__ import annotations

from backend.app.tools.command_runtime.models import CommandRuntime, CommandSettings


def command_tool_description(runtime: CommandRuntime) -> str:
    shell_name = _public_shell_name(runtime)
    base = (
        f"在用户本机 Windows 工作区以前台、阻塞、非交互方式执行一次 {shell_name} 命令。"
        "参数包含 command、description、cwd、timeout_seconds；不支持后台任务、stdin、PTY、"
        "持久会话或交互式程序。输出会写入命令结果文件；短输出会 inline 返回，"
        "长输出只返回尾部和 output_path。如果用户终止该命令，本次工具调用会返回 "
        "status=cancelled，agent 应继续处理而不是视为整轮取消。"
    )
    if runtime.shell == "cmd":
        return (
            "run_cmd: "
            + base
            + " command 必须使用 Windows CMD 语法，例如 dir、type、where、&&、%VAR%。"
            "不要混用 PowerShell 或 Git Bash 语法。"
        )
    if runtime.shell == "powershell":
        edition = _public_powershell_edition(runtime)
        edition_text = f"（{edition}）" if edition else ""
        return (
            "run_powershell: "
            + base
            + f" command 必须使用 PowerShell 语法{edition_text}，例如 "
            "Get-ChildItem、Select-String、$env:VAR。"
            "不要混用 CMD 或 Git Bash 语法。"
        )
    return (
        "run_git_bash: "
        + base
        + " command 必须使用 Git for Windows 的 Git Bash 语法，例如 ls、cat、grep、$VAR、管道。"
        "该环境不是 WSL/MSYS2/Cygwin；不要使用 WSL 路径或混用 CMD、PowerShell 语法。"
    )


def command_system_prompt_section(
    runtime: CommandRuntime | None,
    settings: CommandSettings | None = None,
) -> str:
    if settings is not None and not settings.command_enabled:
        return (
            "## 命令工具\n\n"
            "命令行工具已被用户关闭。不要声称可以运行 shell 命令，也不要要求用户审批命令执行。"
        )
    if runtime is None:
        return (
            "## 命令工具\n\n"
            "命令行工具当前没有可用执行环境。不要声称可以运行 shell 命令；如确需命令能力，"
            "请提示用户到设置页启用命令行工具，并选择可用的 Git Bash、CMD 或 PowerShell。"
        )
    syntax = {
        "cmd": "Windows CMD 语法，例如 dir、type、where、&&、%VAR%。",
        "powershell": "PowerShell 语法，例如 Get-ChildItem、Select-String、$env:VAR、管道对象。",
        "git_bash": (
            "Git for Windows 的 Git Bash 语法，例如 ls、cat、grep、$VAR、管道和重定向语义。"
        ),
    }[runtime.shell]
    environment = _public_shell_environment(runtime)
    approval = _approval_policy_text(settings)
    cwd_policy = _cwd_policy_text(settings)
    return (
        "## 命令工具\n\n"
        f"当前仅有一个命令工具 `{runtime.tool_name}`，运行在用户本机 Windows 工作区，"
        f"命令解释器为 {environment}。命令必须使用{syntax}\n"
        f"{approval}\n"
        f"{cwd_policy}\n"
        "执行形态：命令以前台阻塞、非交互方式运行；不支持后台任务、stdin、PTY、持久 shell state、"
        "交互式程序，也不会在运行时降级或切换到其他 shell。\n"
        "使用边界：读取文件、搜索文本、列目录、创建或修改文件、应用补丁时，优先使用对应的文件/搜索/编辑工具。"
        "命令工具主要用于运行项目脚本、测试、构建、环境诊断，或处理必须依赖 shell 的任务；"
        "不要为了普通文件操作绕过专用工具。\n"
        "输出会写入文件。短输出会直接返回；长输出只返回 tail、output_bytes 和 output_path，"
        "不要要求工具把完整大输出回灌到对话。\n"
        "如果命令工具返回 status=cancelled 且 cancel_reason=user，表示用户只终止了这一次工具调用，"
        "不是取消整轮对话。不要自动重跑同一命令；应基于已有输出继续推理，或说明为什么需要用户确认后重试。"
    )


def _cwd_policy_text(settings: CommandSettings | None) -> str:
    if settings is not None and settings.file_access_mode == "full_access":
        return (
            "目录边界：完全访问允许 cwd 指向当前用户有权限访问的任意本地目录；"
            "命令行产生的文件或其他副作用不保证纳入统一文件历史，也不保证可回溯。"
        )
    return "目录边界：cwd 只能位于当前工作区内。"


def _approval_policy_text(settings: CommandSettings | None) -> str:
    if settings is None:
        return "审批策略：当前运行上下文没有提供审批配置；以工具返回的审批结果为准。"
    if not settings.require_approval_for_untrusted:
        return (
            "审批策略：当前配置为无条件信任，调用命令工具通常不会在执行前请求用户审批；"
            "仍要填写清晰的 description，让用户能从记录中理解运行目的。"
        )
    if settings.allow_persistent_trust:
        return (
            "审批策略：未命中已信任规则的命令会在执行前等待用户确认；"
            "用户可以只允许本次，也可以保存信任规则。命中已信任规则的命令不会再次打断用户。"
        )
    return (
        "审批策略：未命中已信任规则的命令会在执行前等待用户确认；"
        "当前不允许保存新的持久信任规则，审批只对本次命令生效。"
    )


def _public_shell_name(runtime: CommandRuntime) -> str:
    if runtime.shell == "cmd":
        return "Windows CMD"
    if runtime.shell == "git_bash":
        return "Git Bash"
    return _public_powershell_name(runtime)


def _public_shell_environment(runtime: CommandRuntime) -> str:
    if runtime.shell == "cmd":
        return "Windows 本机 CMD"
    if runtime.shell == "git_bash":
        return "Git for Windows 的 Git Bash（不是 WSL/MSYS2/Cygwin）"
    return _public_powershell_name(runtime)


def _public_powershell_name(runtime: CommandRuntime) -> str:
    edition = (runtime.shell_edition or "").strip().lower()
    label = (runtime.shell_label or "").strip().lower()
    if edition == "core" or "7" in label:
        return "PowerShell 7+"
    if edition == "desktop" or "5.1" in label:
        return "Windows PowerShell 5.1"
    return "PowerShell"


def _public_powershell_edition(runtime: CommandRuntime) -> str:
    edition = (runtime.shell_edition or "").strip().lower()
    if edition == "core":
        return "Core"
    if edition == "desktop":
        return "Desktop"
    return ""
