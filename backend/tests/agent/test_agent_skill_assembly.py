from __future__ import annotations

from pathlib import Path
from typing import Any

from deepagents.middleware.patch_tool_calls import PatchToolCallsMiddleware

from backend.app.agent import AgentRunner
from backend.app.agent.factory import AgentFactory
from backend.app.agent.middleware.builder import build_default_middleware
from backend.app.agent.middleware.context_compression import ContextCompressionMiddleware
from backend.app.agent.middleware.duplicate_tool_call_guard import (
    DuplicateToolCallGuardMiddleware,
)
from backend.app.agent.middleware.invalid_tool_call_recovery import (
    InvalidToolCallRecoveryMiddleware,
)
from backend.app.agent.middleware.pending_inputs import PendingUserInputInjectionMiddleware
from backend.app.agent.middleware.tool_error_handling import ToolErrorHandlingMiddleware
from backend.app.agent.runtime_settings import AgentRuntimeSettings
from backend.app.agent.skill_activation_middleware import SkillActivationInjectionMiddleware
from backend.app.agent.state import KeydexAgentState
from backend.app.agent.tool_call_preset_middleware import ToolCallPresetMiddleware
from backend.app.events import EventDispatcher
from backend.app.keydex import KeydexWorkspaceRuntimeCache
from backend.app.mcp.tools import mcp_local_tools_from_snapshot
from backend.app.model import ModelSettings
from backend.app.storage import McpRuntimeSnapshotRecord, StorageRepositories, init_database
from backend.app.tools import FunctionTool, ToolExecutionContext, ToolRegistry


class RecordingAgentFactory(AgentFactory):
    def __init__(self) -> None:
        super().__init__()
        self.created_tools: list[list[Any]] = []
        self.created_middleware: list[tuple[Any, ...]] = []
        self.created_state_schema: list[type[Any] | None] = []

    def get_or_create_llm(self, settings: ModelSettings, *, model: str, **kwargs: Any) -> Any:
        return object()

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
        self.created_tools.append(list(tools))
        self.created_middleware.append(middleware)
        self.created_state_schema.append(state_schema)
        return {"tools": tools, "middleware": middleware, "state_schema": state_schema}


def _registry() -> ToolRegistry:
    registry = ToolRegistry()
    registry.register(
        FunctionTool(
            name="read_file",
            description="Read a file.",
            parameters={
                "type": "object",
                "properties": {"path": {"type": "string"}},
                "required": ["path"],
            },
            handler=lambda args, context: {"content": "ok"},
        )
    )
    return registry


class FakeMcpExecutor:
    async def execute_tool(self, **_kwargs: Any) -> dict[str, str]:
        return {"content": "ok"}


def _runner(
    factory: RecordingAgentFactory,
    *,
    registry: ToolRegistry | None = None,
) -> AgentRunner:
    return AgentRunner(
        model_settings_provider=lambda: ModelSettings(
            base_url="http://model.test/v1",
            api_key="test-key",
            model="fake-default",
        ),
        checkpointer=object(),
        tool_registry=registry or _registry(),
        default_system_prompt="base prompt",
        factory=factory,
    )


def _write_skill(workspace: Path) -> None:
    skill_dir = workspace / ".keydex" / "skills" / "dev-plan"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        """---
name: dev-plan
description: Build a structured development plan.
---

# Dev Plan
""",
        encoding="utf-8",
    )


def _mcp_runtime_tool():
    snapshot = McpRuntimeSnapshotRecord(
        id="snap_agent",
        session_id="ses-1",
        turn_id="turn-1",
        tool_inventory_revision=1,
        visible_tools=[
            {
                "server_id": "srv_agent_mcp",
                "server_name": "Agent MCP",
                "raw_name": "search",
                "model_name": "mcp__srv_agent_mcp__search",
                "description": "Search MCP data",
                "input_schema": {
                    "type": "object",
                    "properties": {"query": {"type": "string"}},
                    "required": ["query"],
                },
                "approval_mode": "auto",
                "exposure": "direct",
            }
        ],
        server_status={},
        policy_summary={},
        created_at="2026-07-06T00:00:00Z",
    )
    return mcp_local_tools_from_snapshot(snapshot, FakeMcpExecutor())[0]


def test_agent_runner_appends_native_load_skill_for_workspace_skill_catalog(
    tmp_path: Path,
) -> None:
    workspace = tmp_path / "repo"
    _write_skill(workspace)
    snapshot = KeydexWorkspaceRuntimeCache().get_snapshot(workspace)
    factory = RecordingAgentFactory()
    runner = _runner(factory)

    runner.create_agent(
        model="qwen-coder",
        system_prompt="base prompt",
        tool_context=ToolExecutionContext(
            session_id="ses-1",
            user_id="user-1",
            workspace_root=workspace,
            turn_index=1,
            metadata={"skill_catalog": snapshot.skill_catalog},
        ),
    )

    tool_names = [tool.name for tool in factory.created_tools[0]]
    assert tool_names == ["read_file", "load_skill"]
    assert factory.created_state_schema == [KeydexAgentState]


def test_agent_runner_does_not_append_load_skill_when_tools_disabled(tmp_path: Path) -> None:
    workspace = tmp_path / "repo"
    _write_skill(workspace)
    snapshot = KeydexWorkspaceRuntimeCache().get_snapshot(workspace)
    factory = RecordingAgentFactory()
    runner = _runner(factory)

    runner.create_agent(
        model="qwen-coder",
        system_prompt="base prompt",
        tool_context=ToolExecutionContext(
            session_id="ses-1",
            user_id="user-1",
            workspace_root=workspace,
            turn_index=1,
            metadata={"skill_catalog": snapshot.skill_catalog},
        ),
        enable_tools=False,
    )

    assert factory.created_tools == [[]]
    assert factory.created_state_schema == [KeydexAgentState]


def test_agent_runner_merges_local_registry_and_runtime_mcp_tools_without_registry_mutation(
    tmp_path: Path,
) -> None:
    registry = _registry()
    factory = RecordingAgentFactory()
    runner = _runner(factory, registry=registry)
    mcp_tool = _mcp_runtime_tool()

    runner.create_agent(
        model="qwen-coder",
        system_prompt="base prompt",
        tool_context=ToolExecutionContext(
            session_id="ses-1",
            user_id="user-1",
            workspace_root=tmp_path,
            turn_index=1,
        ),
        runtime_tools=[mcp_tool],
    )

    tool_names = [tool.name for tool in factory.created_tools[0]]
    mcp_langchain_tool = next(
        tool for tool in factory.created_tools[0] if tool.name == "mcp__srv_agent_mcp__search"
    )
    assert tool_names == ["read_file", "mcp__srv_agent_mcp__search"]
    assert mcp_langchain_tool.description == "Search MCP data"
    assert mcp_langchain_tool.args_schema == mcp_tool.parameters
    assert registry.get("mcp__srv_agent_mcp__search", include_disabled=True) is None


def test_default_middleware_order_matches_skill_design() -> None:
    middleware = build_default_middleware()

    assert [type(item) for item in middleware] == [
        PatchToolCallsMiddleware,
        ToolCallPresetMiddleware,
        SkillActivationInjectionMiddleware,
        ToolErrorHandlingMiddleware,
        DuplicateToolCallGuardMiddleware,
        InvalidToolCallRecoveryMiddleware,
    ]


def test_default_middleware_includes_context_compression_when_enabled(tmp_path) -> None:
    middleware = build_default_middleware(
        AgentRuntimeSettings(context_compression={"enabled": True}),
        repositories=StorageRepositories(init_database(tmp_path / "app.db")),
        dispatcher=EventDispatcher(),
        checkpointer=object(),
    )

    assert [type(item) for item in middleware] == [
        PatchToolCallsMiddleware,
        ToolCallPresetMiddleware,
        SkillActivationInjectionMiddleware,
        PendingUserInputInjectionMiddleware,
        ContextCompressionMiddleware,
        ToolErrorHandlingMiddleware,
        DuplicateToolCallGuardMiddleware,
        InvalidToolCallRecoveryMiddleware,
    ]


def test_default_middleware_omits_duplicate_guard_when_disabled() -> None:
    middleware = build_default_middleware(
        AgentRuntimeSettings(duplicate_tool_call_guard={"enabled": False, "max_repeats": 3})
    )

    assert not any(isinstance(item, DuplicateToolCallGuardMiddleware) for item in middleware)


def test_default_middleware_uses_configured_duplicate_guard_limit() -> None:
    middleware = build_default_middleware(
        AgentRuntimeSettings(duplicate_tool_call_guard={"enabled": True, "max_repeats": 6})
    )
    duplicate_guard = next(
        item for item in middleware if isinstance(item, DuplicateToolCallGuardMiddleware)
    )

    assert duplicate_guard.max_repeats == 6
