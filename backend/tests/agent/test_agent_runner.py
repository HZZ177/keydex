from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from langchain_core.language_models.fake_chat_models import FakeListChatModel

from backend.app.agent import AgentRunner
from backend.app.agent.factory import AgentFactory
from backend.app.agent.middleware.duplicate_tool_call_guard import DuplicateToolCallGuardMiddleware
from backend.app.agent.runtime_settings import AgentRuntimeSettings
from backend.app.model import ModelSettings
from backend.app.storage import init_database
from backend.app.tools import FunctionTool, ToolExecutionContext, ToolRegistry
from backend.app.tools.factory import create_default_tool_registry
from backend.tests.async_checkpoint import TestAsyncCheckpointStore


class RecordingAgentFactory(AgentFactory):
    def __init__(self, model: Any) -> None:
        super().__init__()
        self.model = model
        self.requested_models: list[str] = []
        self.created_tool_counts: list[int] = []
        self.created_tool_names: list[list[str]] = []
        self.created_middleware: list[tuple[Any, ...]] = []
        self.created_system_prompts: list[str] = []

    def get_or_create_llm(
        self,
        settings: ModelSettings,
        *,
        model: str,
        temperature: float | None = None,
        max_tokens: int | None = None,
        streaming: bool = True,
        **kwargs: Any,
    ) -> Any:
        self.requested_models.append(model)
        return self.model

    def create_agent(
        self,
        *,
        model: Any,
        tools: list[Any],
        system_prompt: Any,
        checkpointer: Any,
        middleware: tuple[Any, ...] = (),
        state_schema: type[Any] | None = None,
        name: str = "desktop_agent",
    ) -> Any:
        self.created_tool_counts.append(len(tools))
        self.created_tool_names.append([str(getattr(tool, "name", "")) for tool in tools])
        self.created_middleware.append(middleware)
        self.created_system_prompts.append(
            str(getattr(system_prompt, "content", system_prompt) or "")
        )
        return super().create_agent(
            model=model,
            tools=tools,
            system_prompt=system_prompt,
            checkpointer=checkpointer,
            middleware=middleware,
            state_schema=state_schema,
            name=name,
        )


def _tool_registry() -> ToolRegistry:
    registry = ToolRegistry()
    registry.register(
        FunctionTool(
            name="read_file",
            description="读取文件",
            parameters={
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
            handler=lambda args, context: {"content": f"content:{args['path']}"},
        )
    )
    return registry


def _file_tool_registry() -> ToolRegistry:
    registry = _tool_registry()
    registry.register(
        FunctionTool(
            name="create_file",
            description="创建文件",
            parameters={
                "type": "object",
                "properties": {
                    "path": {"type": "string"},
                    "content": {"type": "string"},
                },
                "required": ["path", "content"],
            },
            handler=lambda args, context: {"path": args["path"]},
        )
    )
    return registry


def _runner(
    tmp_path: Path,
    *,
    registry: ToolRegistry | None = None,
    model: Any | None = None,
    runtime_settings_provider: Any | None = None,
) -> tuple[AgentRunner, RecordingAgentFactory]:
    factory = RecordingAgentFactory(model or FakeListChatModel(responses=["ok"]))
    runner = AgentRunner(
        model_settings_provider=lambda: ModelSettings(
            base_url="http://model.test/v1",
            api_key="test-key",
            model="fake-default",
        ),
        runtime_settings_provider=runtime_settings_provider,
        checkpointer=TestAsyncCheckpointStore(
            init_database(tmp_path / "app.db").path
        ),
        tool_registry=registry or ToolRegistry(),
        default_system_prompt="系统提示",
        factory=factory,
    )
    return runner, factory


class AsyncOnlyCheckpointStore:
    async def aget_tuple(self, config: dict[str, Any]) -> Any:
        return SimpleNamespace(
            config={
                "configurable": {
                    **config["configurable"],
                    "checkpoint_id": "checkpoint-async-only",
                }
            }
        )

    def get_tuple(self, _config: dict[str, Any]) -> None:
        raise AssertionError("sync checkpoint access is forbidden")


@pytest.mark.asyncio
async def test_agent_runner_latest_checkpoint_uses_async_store_only() -> None:
    runner = AgentRunner(
        model_settings_provider=lambda: ModelSettings(
            base_url="http://model.test/v1",
            api_key="test-key",
            model="fake-default",
        ),
        checkpointer=AsyncOnlyCheckpointStore(),
        tool_registry=ToolRegistry(),
    )

    config = await runner.get_latest_checkpoint_config(thread_id="session-async")

    assert config == {
        "checkpoint_id": "checkpoint-async-only",
        "checkpoint_ns": "",
    }


def test_agent_runner_caches_checkpoint_state_graph_on_shared_store(tmp_path) -> None:
    runner, _factory = _runner(tmp_path)

    first = runner.checkpoint_state_graph()
    second = runner.checkpoint_state_graph()

    assert first is second
    assert first.checkpointer is runner.checkpointer


def test_agent_runner_requests_runtime_model(tmp_path) -> None:
    runner, factory = _runner(tmp_path)

    agent = runner.create_agent(
        model="qwen-coder",
        system_prompt=None,
        tool_context=ToolExecutionContext(
            session_id="ses_1",
            user_id="user_1",
            workspace_root=tmp_path,
            turn_index=1,
            trace_id="trace_1",
        ),
    )

    assert agent is not None
    assert factory.requested_models == ["qwen-coder"]


def test_agent_runner_uses_runtime_middleware_settings(tmp_path) -> None:
    runner, factory = _runner(
        tmp_path,
        runtime_settings_provider=lambda: AgentRuntimeSettings(
            duplicate_tool_call_guard={"enabled": True, "max_repeats": 6}
        ),
    )

    runner.create_agent(
        model="qwen-coder",
        system_prompt=None,
        tool_context=ToolExecutionContext(
            session_id="ses_1",
            user_id="user_1",
            workspace_root=tmp_path,
            turn_index=1,
            trace_id="trace_1",
        ),
    )

    duplicate_guard = next(
        item
        for item in factory.created_middleware[-1]
        if isinstance(item, DuplicateToolCallGuardMiddleware)
    )
    assert duplicate_guard.max_repeats == 6


def test_agent_runner_applies_runtime_duplicate_guard_changes_on_next_agent(tmp_path) -> None:
    current_settings = AgentRuntimeSettings(
        duplicate_tool_call_guard={"enabled": True, "max_repeats": 2}
    )
    runner, factory = _runner(
        tmp_path,
        runtime_settings_provider=lambda: current_settings,
    )
    tool_context = ToolExecutionContext(
        session_id="ses_1",
        user_id="user_1",
        workspace_root=tmp_path,
        turn_index=1,
        trace_id="trace_1",
    )

    runner.create_agent(model="qwen-coder", system_prompt=None, tool_context=tool_context)
    current_settings = AgentRuntimeSettings(
        duplicate_tool_call_guard={"enabled": True, "max_repeats": 5}
    )
    runner.create_agent(model="qwen-coder", system_prompt=None, tool_context=tool_context)

    limits = [
        next(
            item for item in middleware if isinstance(item, DuplicateToolCallGuardMiddleware)
        ).max_repeats
        for middleware in factory.created_middleware
    ]
    assert limits == [2, 5]


@pytest.mark.asyncio
async def test_agent_runner_checkpoint_records_messages(tmp_path) -> None:
    runner, _factory = _runner(tmp_path)
    agent = runner.create_agent(
        model="qwen-coder",
        system_prompt=None,
        tool_context=ToolExecutionContext(
            session_id="ses_1",
            user_id="user_1",
            workspace_root=tmp_path,
            turn_index=1,
            trace_id="trace_1",
        ),
    )

    await agent.ainvoke(
        {"messages": [{"role": "user", "content": "你好"}]},
        config={"configurable": {"thread_id": "ses_1", "checkpoint_ns": ""}},
    )

    checkpoint = await agent.aget_state(
        {"configurable": {"thread_id": "ses_1", "checkpoint_ns": ""}}
    )
    messages = checkpoint.values["messages"]
    assert [message.type for message in messages] == ["human", "ai"]
    assert [message.content for message in messages] == ["你好", "ok"]


def test_agent_runner_exports_registered_tools_to_langchain_agent(tmp_path) -> None:
    runner, factory = _runner(tmp_path, registry=_tool_registry())

    agent = runner.create_agent(
        model="qwen-coder",
        system_prompt="自定义提示",
        tool_context=ToolExecutionContext(
            session_id="ses_1",
            user_id="user_1",
            workspace_root=tmp_path,
            turn_index=1,
            trace_id="trace_1",
        ),
    )

    graph = agent.get_graph()
    assert graph is not None
    assert runner.tool_registry.names() == ["read_file"]
    assert factory.created_tool_counts == [1]


def test_agent_runner_merges_runtime_tools_with_registered_tools(tmp_path) -> None:
    runner, factory = _runner(tmp_path, registry=_tool_registry())
    runtime_tool = FunctionTool(
        name="mcp__srv__search",
        description="MCP search",
        parameters={
            "type": "object",
            "properties": {"query": {"type": "string"}},
            "required": ["query"],
        },
        handler=lambda args, context: {"query": args["query"]},
    )

    runner.create_agent(
        model="qwen-coder",
        system_prompt="自定义提示",
        tool_context=ToolExecutionContext(
            session_id="ses_1",
            user_id="user_1",
            workspace_root=tmp_path,
            turn_index=1,
            trace_id="trace_1",
        ),
        runtime_tools=[runtime_tool],
    )

    assert runner.tool_registry.names() == ["read_file"]
    assert factory.created_tool_names == [["read_file", "mcp__srv__search"]]


def test_agent_runner_can_disable_registered_tools(tmp_path) -> None:
    runner, factory = _runner(tmp_path, registry=_tool_registry())

    agent = runner.create_agent(
        model="qwen-coder",
        system_prompt="自定义提示",
        tool_context=ToolExecutionContext(
            session_id="ses_1",
            user_id="user_1",
            workspace_root=tmp_path,
            turn_index=1,
            trace_id="trace_1",
        ),
        enable_tools=False,
    )

    assert agent is not None
    assert runner.tool_registry.names() == ["read_file"]
    assert factory.created_tool_counts == [0]


def test_agent_runner_appends_plan_prompt_when_update_plan_is_available(tmp_path) -> None:
    runner, factory = _runner(tmp_path, registry=create_default_tool_registry())

    runner.create_agent(
        model="qwen-coder",
        system_prompt="自定义提示",
        tool_context=ToolExecutionContext(
            session_id="ses_1",
            user_id="user_1",
            workspace_root=tmp_path,
            turn_index=1,
            trace_id="trace_1",
        ),
    )

    prompt = factory.created_system_prompts[-1]
    assert prompt.startswith("自定义提示")
    assert "## 计划与进度" in prompt
    assert "最终回复前检查计划" in prompt


def test_agent_runner_omits_plan_prompt_when_tools_are_disabled(tmp_path) -> None:
    runner, factory = _runner(tmp_path, registry=create_default_tool_registry())

    runner.create_agent(
        model="qwen-coder",
        system_prompt="自定义提示",
        tool_context=ToolExecutionContext(
            session_id="ses_1",
            user_id="user_1",
            workspace_root=tmp_path,
            turn_index=1,
            trace_id="trace_1",
        ),
        enable_tools=False,
    )

    prompt = factory.created_system_prompts[-1]
    assert prompt.startswith("自定义提示")
    assert "## 计划与进度" not in prompt
    assert "## 当前项目上下文" not in prompt


def test_agent_runner_injects_readable_workspace_context_without_full_access_guidance(
    tmp_path,
) -> None:
    runner, factory = _runner(tmp_path, registry=_tool_registry())
    project_root = tmp_path / "keydex"
    cwd = project_root / "backend"
    additional_root = tmp_path / "shared-docs"

    runner.create_agent(
        model="qwen-coder",
        system_prompt="自定义提示",
        tool_context=ToolExecutionContext(
            session_id="ses_1",
            user_id="user_1",
            workspace_root=cwd,
            turn_index=1,
            trace_id="trace_1",
            metadata={
                "workspace_name": "Keydex",
                "workspace_primary_root": str(project_root),
                "workspace_roots": [str(project_root), str(additional_root)],
                "file_access_mode": "workspace_trusted",
            },
        ),
    )

    prompt = factory.created_system_prompts[-1]
    assert "## 当前项目上下文" in prompt
    assert "项目名称：`Keydex`" in prompt
    assert f"项目根目录：`{project_root}`" in prompt
    assert f"当前工作目录：`{cwd}`" in prompt
    assert f"  - `{additional_root}`" in prompt
    assert "本项目" in prompt
    assert "### 完全访问下的范围约定" not in prompt
    assert "当前已开启完全访问权限" not in prompt


def test_agent_runner_appends_scope_guidance_only_for_full_access(tmp_path) -> None:
    runner, factory = _runner(tmp_path, registry=_tool_registry())
    project_root = tmp_path / "keydex"

    runner.create_agent(
        model="qwen-coder",
        system_prompt="自定义提示",
        tool_context=ToolExecutionContext(
            session_id="ses_1",
            user_id="user_1",
            workspace_root=project_root,
            turn_index=1,
            trace_id="trace_1",
            metadata={
                "workspace_name": "Keydex",
                "workspace_primary_root": str(project_root),
                "workspace_roots": [str(project_root)],
                "file_access_mode": "full_access",
            },
        ),
    )

    prompt = factory.created_system_prompts[-1]
    assert "## 当前项目上下文" in prompt
    assert "### 完全访问下的范围约定" in prompt
    assert "该权限只扩大工具可以访问的最大范围" in prompt
    assert "不会改变“当前项目”的含义" in prompt
    assert "不要因为拥有完全访问权限" in prompt
    assert f"当前运行用户主目录：`{Path.home().resolve(strict=False)}`" in prompt
    assert f"桌面目录：`{Path.home().resolve(strict=False) / 'Desktop'}`" in prompt
    assert "不得猜测 Windows 用户名" in prompt


def test_agent_runner_keeps_file_tools_visible_when_file_access_disabled(tmp_path) -> None:
    runner, factory = _runner(tmp_path, registry=_file_tool_registry())

    runner.create_agent(
        model="qwen-coder",
        system_prompt="自定义提示",
        tool_context=ToolExecutionContext(
            session_id="ses_1",
            user_id="user_1",
            workspace_root=tmp_path,
            turn_index=1,
            trace_id="trace_1",
            metadata={"file_access_mode": "no_file_access"},
        ),
    )

    assert runner.tool_registry.names() == ["create_file", "read_file"]
    assert factory.created_tool_counts == [2]


def test_agent_runner_keeps_write_file_tools_visible_in_read_only_mode(tmp_path) -> None:
    runner, factory = _runner(tmp_path, registry=_file_tool_registry())

    runner.create_agent(
        model="qwen-coder",
        system_prompt="自定义提示",
        tool_context=ToolExecutionContext(
            session_id="ses_1",
            user_id="user_1",
            workspace_root=tmp_path,
            turn_index=1,
            trace_id="trace_1",
            metadata={"file_access_mode": "workspace_read_only"},
        ),
    )

    assert runner.tool_registry.names() == ["create_file", "read_file"]
    assert factory.created_tool_counts == [2]


def test_agent_runner_exposes_claude_file_tools_by_default(tmp_path) -> None:
    runner, factory = _runner(tmp_path, registry=create_default_tool_registry())

    runner.create_agent(
        model="qwen-coder",
        system_prompt=None,
        tool_context=ToolExecutionContext(
            session_id="ses_1",
            user_id="user_1",
            workspace_root=tmp_path,
            turn_index=1,
            trace_id="trace_1",
        ),
    )

    names = set(factory.created_tool_names[-1])
    assert {"create_file", "edit_file", "delete_file", "move_file"}.issubset(names)
    assert "apply_patch" not in names
    assert "Claude Code 风格" in factory.created_system_prompts[-1]
    assert "Codex 风格" not in factory.created_system_prompts[-1]


def test_agent_runner_exposes_codex_apply_patch_when_configured(tmp_path) -> None:
    runner, factory = _runner(
        tmp_path,
        registry=create_default_tool_registry(),
        runtime_settings_provider=lambda: AgentRuntimeSettings(file_edit_tool_style="codex"),
    )

    runner.create_agent(
        model="qwen-coder",
        system_prompt=None,
        tool_context=ToolExecutionContext(
            session_id="ses_1",
            user_id="user_1",
            workspace_root=tmp_path,
            turn_index=1,
            trace_id="trace_1",
        ),
    )

    names = set(factory.created_tool_names[-1])
    assert "apply_patch" in names
    assert {"create_file", "edit_file", "delete_file", "move_file"}.isdisjoint(names)
    assert "Codex 风格" in factory.created_system_prompts[-1]
    assert "Claude Code 风格" not in factory.created_system_prompts[-1]
