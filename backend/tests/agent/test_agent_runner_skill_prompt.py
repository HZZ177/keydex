from __future__ import annotations

from pathlib import Path
from typing import Any

from langchain_core.messages import SystemMessage

from backend.app.agent import AgentRunner
from backend.app.agent.factory import AgentFactory
from backend.app.core.config import AppSettings
from backend.app.keydex import KeydexRuntimeCache, KeydexWorkspaceRuntimeCache
from backend.app.model import ModelSettings
from backend.app.services import ChatRequest, ChatService
from backend.app.storage import StorageRepositories, init_database
from backend.app.tools import ToolExecutionContext, ToolRegistry


class RecordingAgentFactory(AgentFactory):
    def __init__(self) -> None:
        super().__init__()
        self.system_prompts: list[str] = []

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
        self.system_prompts.append(
            system_prompt.content
            if isinstance(system_prompt, SystemMessage)
            else str(system_prompt)
        )
        return {
            "model": model,
            "tools": tools,
            "system_prompt": system_prompt,
            "state_schema": state_schema,
        }


def test_agent_runner_appends_skill_index_from_tool_context_metadata(tmp_path: Path) -> None:
    _write_skill(tmp_path / "repo" / ".keydex" / "skills" / "dev-plan", name="dev-plan")
    snapshot = KeydexWorkspaceRuntimeCache().get_snapshot(tmp_path / "repo")
    runner, factory = _runner()

    runner.create_agent(
        model="qwen-coder",
        system_prompt="base prompt",
        tool_context=ToolExecutionContext(
            session_id="ses-1",
            user_id="user-1",
            workspace_root=tmp_path / "repo",
            turn_index=1,
            metadata={"skill_catalog": snapshot.skill_catalog},
        ),
    )

    prompt = factory.system_prompts[0]
    assert prompt.startswith("base prompt")
    assert "<keydex_skills>" in prompt
    assert "1. dev-plan" in prompt
    assert 'load_skill(skill_name="dev-plan")' in prompt


def test_agent_runner_does_not_append_empty_skill_index(tmp_path: Path) -> None:
    snapshot = KeydexWorkspaceRuntimeCache().get_snapshot(tmp_path / "repo")
    runner, factory = _runner()

    runner.create_agent(
        model="qwen-coder",
        system_prompt="base prompt",
        tool_context=ToolExecutionContext(
            session_id="ses-1",
            user_id="user-1",
            workspace_root=tmp_path / "repo",
            turn_index=1,
            metadata={"skill_catalog": snapshot.skill_catalog},
        ),
    )

    assert "<keydex_skills>" not in factory.system_prompts[0]


def test_agent_runner_ignores_chat_context_without_skill_catalog(tmp_path: Path) -> None:
    runner, factory = _runner()

    runner.create_agent(
        model="qwen-coder",
        system_prompt="base prompt",
        tool_context=ToolExecutionContext(
            session_id="ses-1",
            user_id="user-1",
            workspace_root=tmp_path,
            turn_index=1,
            metadata={"tools_enabled": False},
        ),
        enable_tools=False,
    )

    assert "<keydex_skills>" not in factory.system_prompts[0]


def test_t30_t32_t33_chat_system_index_and_only_safe_load_skill(tmp_path: Path) -> None:
    system_root = tmp_path / "system"
    _write_skill(system_root / "skills" / "global", name="global")
    snapshot = KeydexRuntimeCache(system_root=system_root).get_system_snapshot()
    runner, factory = _runner()

    agent = runner.create_agent(
        model="qwen-coder",
        system_prompt="base prompt",
        tool_context=ToolExecutionContext(
            session_id="ses-chat",
            user_id="user-1",
            workspace_root=tmp_path / "data",
            turn_index=1,
            metadata={
                "skill_catalog": snapshot.skill_catalog,
                "enable_workspace_tools": False,
                "enable_skill_tools": True,
            },
        ),
        enable_tools=False,
    )

    tool_names = [tool.name for tool in agent["tools"]]
    assert tool_names == ["load_skill"]
    assert {
        "read_file",
        "list_dir",
        "search_text",
        "search_files",
        "grep_files",
        "edit_file",
        "apply_patch",
        "run_command",
        "shell",
        "mcp__example__search",
    }.isdisjoint(tool_names)
    prompt = factory.system_prompts[0]
    assert "当前会话可用 Keydex Skills" in prompt
    assert "global" in prompt
    assert "source: system" in prompt


def test_t31_chat_empty_or_invalid_system_layer_uses_builtin_but_keeps_workspace_tools_closed(
    tmp_path: Path,
) -> None:
    for case, manifest in (("empty", None), ("invalid", "{invalid")):
        system_root = tmp_path / case
        if manifest is not None:
            system_root.mkdir()
            (system_root / "keydex.json").write_text(manifest, encoding="utf-8")
        snapshot = KeydexRuntimeCache(system_root=system_root).get_system_snapshot()
        runner, factory = _runner()

        agent = runner.create_agent(
            model="qwen-coder",
            system_prompt="base prompt",
            tool_context=ToolExecutionContext(
                session_id=f"ses-{case}",
                user_id="user-1",
                workspace_root=tmp_path / "data",
                turn_index=1,
                metadata={
                    "skill_catalog": snapshot.skill_catalog,
                    "enable_workspace_tools": False,
                    "enable_skill_tools": snapshot.skill_catalog.available,
                },
            ),
            enable_tools=False,
        )

        tool_names = [tool.name for tool in agent["tools"]]
        assert set(tool_names) <= {"load_skill"}
        assert "read_file" not in tool_names
        assert "run_command" not in tool_names
        assert not any(name.startswith("mcp__") for name in tool_names)
        prompt = factory.system_prompts[0]
        assert "<keydex_skills>" in prompt
        assert "keydex-guide" in prompt
        assert "source: builtin" in prompt


def test_chat_service_tool_context_uses_same_keydex_snapshot_for_metadata(
    tmp_path: Path,
) -> None:
    workspace_root = tmp_path / "repo"
    _write_skill(workspace_root / ".keydex" / "skills" / "dev-plan", name="dev-plan")
    database = init_database(tmp_path / "app.db")
    repositories = StorageRepositories(database)
    workspace = repositories.workspaces.create(workspace_id="ws-project", root_path=workspace_root)
    session = repositories.sessions.create(
        session_id="ses-project",
        user_id="local-user",
        scene_id="desktop-agent",
        session_type="workspace",
        workspace_id=workspace.id,
        cwd=str(workspace_root),
        workspace_roots=[str(workspace_root)],
    )
    cache = KeydexRuntimeCache(system_root=tmp_path / "system")
    service = ChatService(
        settings=AppSettings(data_dir=tmp_path / "data", workspace_root=tmp_path),
        repositories=repositories,
        agent_runner=_runner()[0],
        keydex_runtime_cache=cache,
    )

    tool_context, enable_tools = service._build_tool_context(
        request=ChatRequest(session_id=session.id, message="use skill", model="qwen-coder"),
        session=session,
        trace_id="trace-1",
        turn_index=1,
    )

    snapshot = tool_context.metadata["keydex_snapshot"]
    assert enable_tools is True
    assert tool_context.metadata["skill_catalog"] is snapshot.skill_catalog
    assert tool_context.metadata["keydex_profile"] is snapshot.workspace_layer.profile
    assert tool_context.metadata["keydex_fingerprint"] == snapshot.fingerprint
    assert cache.get_workspace_snapshot(workspace_root) is snapshot


def test_t34_t36_workspace_override_prompt_uses_only_effective_winner(
    tmp_path: Path,
) -> None:
    system_root = tmp_path / "system"
    workspace_root = tmp_path / "workspace"
    _write_skill(
        system_root / "skills" / "shared",
        name="shared",
        description="SYSTEM HIDDEN DESCRIPTION",
    )
    _write_skill(
        workspace_root / ".keydex" / "skills" / "shared",
        name="shared",
        description="WORKSPACE WINNER DESCRIPTION",
    )
    snapshot = KeydexRuntimeCache(system_root=system_root).get_workspace_snapshot(
        workspace_root
    )
    runner, factory = _runner()

    agent = runner.create_agent(
        model="qwen-coder",
        system_prompt="base prompt",
        tool_context=ToolExecutionContext(
            session_id="ses-project",
            user_id="user-1",
            workspace_root=workspace_root,
            turn_index=1,
            metadata={
                "keydex_snapshot": snapshot,
                "skill_catalog": snapshot.skill_catalog,
                "enable_workspace_tools": False,
                "enable_skill_tools": True,
            },
        ),
        enable_tools=False,
    )

    assert [tool.name for tool in agent["tools"]] == ["load_skill"]
    prompt = factory.system_prompts[0]
    assert "WORKSPACE WINNER DESCRIPTION" in prompt
    assert "source: workspace" in prompt
    assert "SYSTEM HIDDEN DESCRIPTION" not in prompt


def _runner() -> tuple[AgentRunner, RecordingAgentFactory]:
    factory = RecordingAgentFactory()
    return (
        AgentRunner(
            model_settings_provider=lambda: ModelSettings(
                base_url="http://model.test/v1",
                api_key="test-key",
                model="fake-default",
            ),
            checkpointer=object(),
            tool_registry=ToolRegistry(),
            default_system_prompt="default prompt",
            factory=factory,
        ),
        factory,
    )


def _write_skill(skill_dir: Path, *, name: str, description: str = "Use this skill.") -> None:
    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / "SKILL.md").write_text(
        f"""---
name: {name}
description: {description}
---

# {name}
""",
        encoding="utf-8",
    )
