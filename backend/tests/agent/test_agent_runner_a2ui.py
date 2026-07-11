from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

from langchain_core.language_models.fake_chat_models import FakeListChatModel

from backend.app.agent import AgentRunner
from backend.app.agent.checkpoint import SQLiteCheckpointSaver
from backend.app.agent.factory import AgentFactory
from backend.app.agent.runtime_settings import AgentRuntimeSettings
from backend.app.events import EventDispatcher
from backend.app.model import ModelSettings
from backend.app.storage import StorageRepositories, init_database
from backend.app.tools import ToolExecutionContext, ToolRegistry


class RecordingFactory(AgentFactory):
    def __init__(self) -> None:
        super().__init__()
        self.created_tool_names: list[list[str]] = []
        self.system_prompts: list[str] = []

    def get_or_create_llm(self, settings: ModelSettings, **_: Any) -> Any:
        return FakeListChatModel(responses=["ok"])

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
        self.created_tool_names.append([str(getattr(tool, "name", "")) for tool in tools])
        self.system_prompts.append(str(getattr(system_prompt, "content", system_prompt) or ""))
        return SimpleNamespace(model=model, tools=tools, checkpointer=checkpointer)


def test_agent_runner_injects_builtin_a2ui_tools_and_prompt_when_enabled(tmp_path) -> None:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    runner, factory = _runner(tmp_path, repositories=repositories)

    runner.create_agent(
        model="qwen-coder",
        system_prompt=None,
        tool_context=_tool_context(tmp_path, repositories=repositories),
        enable_tools=True,
    )

    created_names = set(factory.created_tool_names[-1])
    assert {"chart", "choice", "form", "table"}.issubset(created_names)
    assert "A2UI 交互式界面工具" in factory.system_prompts[-1]
    assert "`table`" in factory.system_prompts[-1]


def test_agent_runner_skips_a2ui_tools_and_prompt_when_disabled(tmp_path) -> None:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    runner, factory = _runner(
        tmp_path,
        repositories=repositories,
        runtime_settings_provider=lambda: AgentRuntimeSettings(a2ui={"enabled": False}),
    )

    runner.create_agent(
        model="qwen-coder",
        system_prompt=None,
        tool_context=_tool_context(tmp_path, repositories=repositories),
        enable_tools=True,
    )

    created_names = set(factory.created_tool_names[-1])
    assert {"chart", "choice", "form", "table"}.isdisjoint(created_names)
    assert "A2UI 交互式界面工具" not in factory.system_prompts[-1]


def _runner(
    tmp_path: Path,
    *,
    repositories: StorageRepositories,
    runtime_settings_provider: Any | None = None,
) -> tuple[AgentRunner, RecordingFactory]:
    factory = RecordingFactory()
    runner = AgentRunner(
        model_settings_provider=lambda: ModelSettings(
            base_url="http://model.test/v1",
            api_key="test-key",
            model="fake-default",
        ),
        runtime_settings_provider=runtime_settings_provider,
        checkpointer=SQLiteCheckpointSaver(repositories.db),
        tool_registry=ToolRegistry(),
        default_system_prompt="系统提示",
        factory=factory,
    )
    return runner, factory


def _tool_context(
    tmp_path: Path,
    *,
    repositories: StorageRepositories,
) -> ToolExecutionContext:
    return ToolExecutionContext(
        session_id="session-1",
        user_id="local-user",
        workspace_root=tmp_path,
        turn_index=1,
        trace_id="trace-1",
        metadata={
            "repositories": repositories,
            "dispatcher": EventDispatcher(),
            "active_session_id": "session-1",
            "thread_id": "session-1",
            "checkpoint_ns": "",
        },
    )
