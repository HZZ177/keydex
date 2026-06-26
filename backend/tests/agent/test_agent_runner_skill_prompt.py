from __future__ import annotations

from pathlib import Path
from typing import Any

from langchain_core.messages import SystemMessage

from backend.app.agent import AgentRunner
from backend.app.agent.factory import AgentFactory
from backend.app.core.config import AppSettings
from backend.app.keydex import KeydexWorkspaceRuntimeCache
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

    assert factory.system_prompts == ["base prompt"]


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

    assert factory.system_prompts == ["base prompt"]


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
    cache = KeydexWorkspaceRuntimeCache()
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
    assert tool_context.metadata["keydex_profile"] is snapshot.keydex_profile
    assert tool_context.metadata["keydex_fingerprint"] == snapshot.fingerprint
    assert cache.get_snapshot(workspace_root) is snapshot


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
