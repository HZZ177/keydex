from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from backend.app.agent.runner import AgentRunner
from backend.app.agent.system_prompt import SUBAGENT_ORCHESTRATION_PROMPT
from backend.app.agent.tool_capabilities import ToolCapability
from backend.app.model import ModelSettings
from backend.app.subagents.models import SubagentRole
from backend.app.subagents.roles import (
    EXPLORER_READ_ONLY_TOOL_NAMES,
    EXPLORER_SYSTEM_PROMPT,
    WORKER_SYSTEM_PROMPT_APPENDIX,
)
from backend.app.tools import FunctionTool, ToolExecutionContext
from backend.app.tools.factory import create_default_tool_registry


class RecordingFactory:
    def __init__(self) -> None:
        self.tools: list[Any] = []
        self.system_prompt: Any = None
        self.requested_models: list[str] = []

    def get_or_create_llm(self, *_args: Any, model: str, **_kwargs: Any) -> object:
        self.requested_models.append(model)
        return object()

    def create_agent(self, *, tools: list[Any], system_prompt: Any, **_kwargs: Any) -> Any:
        self.tools = list(tools)
        self.system_prompt = system_prompt
        return {"tools": tools, "system_prompt": system_prompt}


def _runtime_tool(name: str) -> FunctionTool:
    return FunctionTool(
        name=name,
        description=name,
        parameters={"type": "object", "properties": {}},
        handler=lambda _args, _context: None,
    )


def _runner(factory: RecordingFactory) -> AgentRunner:
    return AgentRunner(
        model_settings_provider=lambda: ModelSettings(
            base_url="http://model.test/v1",
            api_key="test-key",
            model="test-model",
        ),
        checkpointer=object(),
        tool_registry=create_default_tool_registry(),
        default_system_prompt="caller main prompt",
        factory=factory,  # type: ignore[arg-type]
    )


def _context(tmp_path: Path) -> ToolExecutionContext:
    return ToolExecutionContext(
        session_id="child-session",
        user_id="local-user",
        workspace_root=tmp_path,
        turn_index=1,
    )


def test_explorer_agent_assembly_exposes_only_exact_read_tools(tmp_path: Path) -> None:
    factory = RecordingFactory()
    _runner(factory).create_agent(
        model="test-model",
        system_prompt="caller attempted override",
        tool_context=_context(tmp_path),
        tool_capabilities={
            ToolCapability.WORKSPACE,
            ToolCapability.SKILL,
            ToolCapability.WEB,
        },
        runtime_tools=(
            _runtime_tool("web_search"),
            _runtime_tool("web_fetch"),
            _runtime_tool("mcp__dynamic__write"),
        ),
        subagent_role=SubagentRole.EXPLORER,
    )

    assert {tool.name for tool in factory.tools} == EXPLORER_READ_ONLY_TOOL_NAMES
    prompt = str(factory.system_prompt.content)
    assert EXPLORER_SYSTEM_PROMPT in prompt
    assert SUBAGENT_ORCHESTRATION_PROMPT not in prompt
    assert "caller attempted override" not in prompt
    assert "caller main prompt" not in prompt


def test_explorer_agent_assembly_omits_disabled_web_and_new_registry_tools(
    tmp_path: Path,
) -> None:
    registry = create_default_tool_registry()
    registry.register(_runtime_tool("future_registry_tool"))
    factory = RecordingFactory()
    runner = AgentRunner(
        model_settings_provider=lambda: ModelSettings(
            base_url="http://model.test/v1",
            api_key="test-key",
            model="test-model",
        ),
        checkpointer=object(),
        tool_registry=registry,
        default_system_prompt="main prompt",
        factory=factory,  # type: ignore[arg-type]
    )
    runner.create_agent(
        model="test-model",
        system_prompt=None,
        tool_context=_context(tmp_path),
        tool_capabilities={ToolCapability.WORKSPACE},
        runtime_tools=(_runtime_tool("web_search"),),
        subagent_role="explorer",
    )

    assert {tool.name for tool in factory.tools} == {
        "read_file",
        "list_dir",
        "search_text",
        "grep_files",
        "search_files",
        "read_tool_result",
    }


def test_worker_agent_assembly_inherits_main_model_context_and_tools(
    tmp_path: Path,
) -> None:
    factory = RecordingFactory()
    registry = create_default_tool_registry()
    registry.register(_runtime_tool("delegate_subagent"))
    registry.register(_runtime_tool("continue_subagent"))
    main_visible_names = {
        tool.name
        for tool in registry.list()
        if tool.name not in {"apply_patch", "delegate_subagent", "continue_subagent"}
    }
    runner = AgentRunner(
        model_settings_provider=lambda: ModelSettings(
            base_url="http://model.test/v1",
            api_key="test-key",
            model="default-model",
        ),
        checkpointer=object(),
        tool_registry=registry,
        default_system_prompt="default main prompt",
        factory=factory,  # type: ignore[arg-type]
    )
    runner.create_agent(
        model="inherited-parent-model",
        system_prompt="inherited main system prompt",
        tool_context=ToolExecutionContext(
            session_id="worker-child-session",
            user_id="local-user",
            workspace_root=tmp_path,
            turn_index=1,
            metadata={
                "workspace_name": "Worker Fixture",
                "workspace_primary_root": str(tmp_path),
                "workspace_roots": [str(tmp_path)],
            },
        ),
        tool_capabilities={ToolCapability.WORKSPACE},
        runtime_tools=(
            _runtime_tool("mcp__fixture__inspect"),
            _runtime_tool("delegate_subagent"),
            _runtime_tool("continue_subagent"),
        ),
        subagent_role=SubagentRole.WORKER,
    )

    assert factory.requested_models == ["inherited-parent-model"]
    assert {tool.name for tool in factory.tools} == {
        *main_visible_names,
        "mcp__fixture__inspect",
    }
    prompt = str(factory.system_prompt.content)
    assert prompt.startswith("inherited main system prompt")
    assert WORKER_SYSTEM_PROMPT_APPENDIX in prompt
    assert SUBAGENT_ORCHESTRATION_PROMPT not in prompt
    assert "Worker Fixture" in prompt
    assert str(tmp_path) in prompt
    assert "delegate_subagent" not in {tool.name for tool in factory.tools}
    assert "continue_subagent" not in {tool.name for tool in factory.tools}


def test_main_agent_assembly_adds_subagent_orchestration_only_with_both_tools(
    tmp_path: Path,
) -> None:
    factory = RecordingFactory()
    runner = _runner(factory)

    runner.create_agent(
        model="test-model",
        system_prompt="main prompt",
        tool_context=_context(tmp_path),
        tool_capabilities={ToolCapability.WORKSPACE},
        runtime_tools=(
            _runtime_tool("delegate_subagent"),
            _runtime_tool("continue_subagent"),
        ),
    )

    prompt = str(factory.system_prompt.content)
    assert SUBAGENT_ORCHESTRATION_PROMPT in prompt
    assert "默认优先使用 `explorer`" in prompt
    assert "并行或加速不是使用 Sub-Agent 的前提" in prompt
    assert "仅当本轮提供 `delegate_subagent`" not in prompt
    assert "必须使用 `continue_subagent`" in prompt

    runner.create_agent(
        model="test-model",
        system_prompt="main prompt",
        tool_context=_context(tmp_path),
        tool_capabilities={ToolCapability.WORKSPACE},
        runtime_tools=(_runtime_tool("delegate_subagent"),),
    )

    prompt = str(factory.system_prompt.content)
    assert SUBAGENT_ORCHESTRATION_PROMPT not in prompt


async def test_ft_role_024_worker_assembled_write_tool_changes_only_temp_workspace(
    tmp_path: Path,
) -> None:
    factory = RecordingFactory()
    runner = _runner(factory)
    context = _context(tmp_path)
    runner.create_agent(
        model="test-model",
        system_prompt="inherited main prompt",
        tool_context=context,
        tool_capabilities={ToolCapability.WORKSPACE},
        subagent_role=SubagentRole.WORKER,
    )

    create_file = next(tool for tool in factory.tools if tool.name == "create_file")
    result = await create_file.ainvoke(
        {"path": "worker-output.txt", "content": "worker result\n"}
    )

    payload = json.loads(result)
    assert payload["files"][0]["operation"] == "add"
    assert (tmp_path / "worker-output.txt").read_text(encoding="utf-8") == "worker result\n"
    assert "delegate_subagent" not in {tool.name for tool in factory.tools}
    assert "continue_subagent" not in {tool.name for tool in factory.tools}
