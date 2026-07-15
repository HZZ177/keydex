from __future__ import annotations

from datetime import date
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from backend.app.agent.factory import AgentFactory
from backend.app.agent.runner import AgentRunner
from backend.app.agent.tool_capabilities import ToolCapability
from backend.app.model import ModelSettings
from backend.app.tools import FunctionTool, ToolExecutionContext, ToolRegistry


class RecordingFactory(AgentFactory):
    def __init__(self) -> None:
        super().__init__()
        self.tool_names: list[list[str]] = []
        self.system_prompts: list[str] = []

    def get_or_create_llm(self, settings: ModelSettings, **_: Any) -> object:
        return object()

    def create_agent(self, *, tools: list[Any], system_prompt: Any, **_: Any) -> Any:
        self.tool_names.append([str(tool.name) for tool in tools])
        self.system_prompts.append(
            str(getattr(system_prompt, "content", system_prompt) or "")
        )
        return SimpleNamespace(tools=tools)


def _tool(name: str) -> FunctionTool:
    return FunctionTool(
        name=name,
        description=name,
        parameters={"type": "object", "properties": {}},
        handler=lambda args, context: {},
    )


def _runner(tmp_path: Path) -> tuple[AgentRunner, RecordingFactory]:
    registry = ToolRegistry()
    registry.register(_tool("read_file"))
    factory = RecordingFactory()
    return (
        AgentRunner(
            model_settings_provider=lambda: ModelSettings(
                base_url="http://model.test/v1",
                api_key="test-key",
                model="fake",
            ),
            checkpointer=object(),
            tool_registry=registry,
            factory=factory,
        ),
        factory,
    )


def _context(tmp_path: Path, **metadata: Any) -> ToolExecutionContext:
    return ToolExecutionContext(
        session_id="ses-1",
        user_id="user-1",
        workspace_root=tmp_path,
        turn_index=1,
        metadata=metadata,
    )


def test_empty_capabilities_create_no_tools(tmp_path: Path) -> None:
    runner, factory = _runner(tmp_path)

    runner.create_agent(
        model="fake",
        system_prompt=None,
        tool_context=_context(tmp_path),
        tool_capabilities=frozenset(),
        runtime_tools=[_tool("web_search"), _tool("mcp__server__lookup")],
    )

    assert factory.tool_names == [[]]


def test_web_capability_only_exposes_native_web_tools(tmp_path: Path) -> None:
    runner, factory = _runner(tmp_path)

    runner.create_agent(
        model="fake",
        system_prompt=None,
        tool_context=_context(tmp_path),
        tool_capabilities={ToolCapability.WEB},
        runtime_tools=[
            _tool("web_search"),
            _tool("web_fetch"),
            _tool("mcp__server__lookup"),
        ],
    )

    assert factory.tool_names == [["web_search", "web_fetch"]]


def test_workspace_and_web_capabilities_merge_without_registry_mutation(
    tmp_path: Path,
) -> None:
    runner, factory = _runner(tmp_path)

    runner.create_agent(
        model="fake",
        system_prompt=None,
        tool_context=_context(tmp_path),
        tool_capabilities={ToolCapability.WORKSPACE, ToolCapability.WEB},
        runtime_tools=[_tool("web_search"), _tool("mcp__server__lookup")],
    )

    assert factory.tool_names == [["read_file", "web_search", "mcp__server__lookup"]]
    assert runner.tool_registry.names() == ["read_file"]


def test_explicit_capabilities_override_legacy_booleans(tmp_path: Path) -> None:
    runner, factory = _runner(tmp_path)

    runner.create_agent(
        model="fake",
        system_prompt=None,
        tool_context=_context(tmp_path, enable_workspace_tools=True),
        enable_tools=True,
        enable_skill_tools=True,
        tool_capabilities={ToolCapability.WEB},
        runtime_tools=[_tool("web_search")],
    )

    assert factory.tool_names == [["web_search"]]


def test_metadata_capabilities_are_snapshotted_for_each_agent(tmp_path: Path) -> None:
    runner, factory = _runner(tmp_path)
    capabilities = ["web"]
    context = _context(tmp_path, tool_capabilities=capabilities)

    runner.create_agent(
        model="fake",
        system_prompt=None,
        tool_context=context,
        runtime_tools=[_tool("web_search")],
    )
    capabilities.clear()

    assert factory.tool_names == [["web_search"]]


def test_legacy_enable_tools_semantics_remain_workspace_only(tmp_path: Path) -> None:
    runner, factory = _runner(tmp_path)

    runner.create_agent(
        model="fake",
        system_prompt=None,
        tool_context=_context(tmp_path),
        enable_tools=True,
        runtime_tools=[_tool("web_search"), _tool("mcp__server__lookup")],
    )

    assert factory.tool_names == [["read_file", "mcp__server__lookup"]]


def test_web_prompt_is_injected_only_when_search_is_visible(tmp_path: Path) -> None:
    runner, factory = _runner(tmp_path)

    runner.create_agent(
        model="fake",
        system_prompt="base",
        tool_context=_context(tmp_path),
        tool_capabilities={ToolCapability.WEB},
        runtime_tools=[_tool("web_search"), _tool("web_fetch")],
    )
    runner.create_agent(
        model="fake",
        system_prompt="base",
        tool_context=_context(tmp_path),
        tool_capabilities=frozenset(),
        runtime_tools=[_tool("web_search")],
    )

    assert "[[source:source_id]]" in factory.system_prompts[0]
    assert "逐字使用" in factory.system_prompts[0]
    assert "web_fetch" in factory.system_prompts[0]
    assert "网络来源协议" not in factory.system_prompts[1]


def test_search_only_prompt_does_not_claim_fetch_access(tmp_path: Path) -> None:
    runner, factory = _runner(tmp_path)

    runner.create_agent(
        model="fake",
        system_prompt="base",
        tool_context=_context(tmp_path),
        tool_capabilities={ToolCapability.WEB},
        runtime_tools=[_tool("web_search")],
    )

    assert "当前只提供网络搜索" in factory.system_prompts[0]
    assert "Tavily" not in factory.system_prompts[0]


def test_current_date_is_the_final_system_prompt_line(tmp_path: Path) -> None:
    runner, factory = _runner(tmp_path)
    expected_dates = {date.today().isoformat()}

    runner.create_agent(
        model="fake",
        system_prompt="base",
        tool_context=_context(tmp_path),
        tool_capabilities={ToolCapability.WORKSPACE, ToolCapability.WEB},
        runtime_tools=[_tool("web_search"), _tool("web_fetch")],
    )
    expected_dates.add(date.today().isoformat())

    prompt = factory.system_prompts[0]
    assert prompt.splitlines()[-1] in {
        f"当前时间：{current_date}" for current_date in expected_dates
    }
    assert prompt.count("当前时间：") == 1
