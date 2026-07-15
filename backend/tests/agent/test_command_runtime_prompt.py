from __future__ import annotations

from types import SimpleNamespace

from backend.app.agent.runner import AgentRunner
from backend.app.storage import StorageRepositories, init_database
from backend.app.tools import ToolExecutionContext, ToolRegistry
from backend.app.tools.command_runtime.models import CommandSettings


class CapturingFactory:
    def __init__(self) -> None:
        self.tools = []
        self.system_prompt = ""

    def get_or_create_llm(self, *args, **kwargs):
        return object()

    def create_agent(self, *, tools, system_prompt, **kwargs):
        self.tools = tools
        self.system_prompt = getattr(system_prompt, "content", system_prompt)
        return SimpleNamespace()


def _runner(factory: CapturingFactory, repositories: StorageRepositories) -> AgentRunner:
    return AgentRunner(
        model_settings_provider=lambda: SimpleNamespace(model="fake"),
        checkpointer=object(),
        tool_registry=ToolRegistry(),
        factory=factory,
    )


def _context(tmp_path, repositories: StorageRepositories) -> ToolExecutionContext:
    return ToolExecutionContext(
        session_id="ses-agent",
        user_id="local-user",
        workspace_root=tmp_path,
        turn_index=1,
        metadata={"repositories": repositories},
    )


def test_agent_runner_registers_only_selected_command_tool_and_prompt(tmp_path) -> None:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    repositories.settings.set(
        "command_settings",
        CommandSettings(
            command_enabled=True,
            selected_shell="powershell",
            shell_path=r"C:\Program Files\PowerShell\7\pwsh.exe",
            shell_label="PowerShell 7+",
            shell_edition="Core",
        ).model_dump(mode="json"),
    )
    factory = CapturingFactory()

    _runner(factory, repositories).create_agent(
        model="fake",
        model_settings=SimpleNamespace(model="fake"),
        system_prompt="base",
        tool_context=_context(tmp_path, repositories),
        enable_tools=True,
    )

    tool_names = {tool.name for tool in factory.tools}
    assert "run_powershell" in tool_names
    assert "run_cmd" not in tool_names
    assert "run_git_bash" not in tool_names
    assert "run_command" not in factory.system_prompt
    assert "`run_powershell`" in factory.system_prompt
    assert "PowerShell 7+" in factory.system_prompt
    assert r"C:\Program Files\PowerShell\7\pwsh.exe" not in factory.system_prompt
    assert "未命中已信任规则的命令会在执行前等待用户确认" in factory.system_prompt


def test_agent_runner_omits_command_tool_when_runtime_not_configured(tmp_path) -> None:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    repositories.settings.set(
        "command_settings",
        CommandSettings(command_enabled=False).model_dump(mode="json"),
    )
    factory = CapturingFactory()

    _runner(factory, repositories).create_agent(
        model="fake",
        model_settings=SimpleNamespace(model="fake"),
        system_prompt="base",
        tool_context=_context(tmp_path, repositories),
        enable_tools=True,
    )

    assert {tool.name for tool in factory.tools} == set()
    assert "命令行工具已被用户关闭" in factory.system_prompt


def test_agent_runner_reports_enabled_command_tool_without_runtime(tmp_path) -> None:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    repositories.settings.set(
        "command_settings",
        CommandSettings(command_enabled=True, selected_shell="git_bash").model_dump(mode="json"),
    )
    factory = CapturingFactory()

    _runner(factory, repositories).create_agent(
        model="fake",
        model_settings=SimpleNamespace(model="fake"),
        system_prompt="base",
        tool_context=_context(tmp_path, repositories),
        enable_tools=True,
    )

    assert {tool.name for tool in factory.tools} == set()
    assert "命令行工具当前没有可用执行环境" in factory.system_prompt
