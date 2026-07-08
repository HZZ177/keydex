from __future__ import annotations

from typing import Any

import pytest
from langchain_core.messages import AIMessage

from backend.app.agent.event_processor import AgentEventResult
from backend.app.core.config import AppSettings
from backend.app.core.time import to_iso_z, utc_now
from backend.app.model import ModelSettings
from backend.app.services import ChatRequest, ChatService
from backend.app.storage import (
    MODEL_DEFAULT_CHAT,
    ModelProviderRecord,
    StorageRepositories,
    init_database,
)


class SingleResponseAgent:
    async def astream_events(self, *_args: Any, **_kwargs: Any):
        yield {
            "event": "on_chat_model_end",
            "run_id": "run_single_response",
            "data": {"output": AIMessage(content="完成")},
        }


class CapturingRunner:
    def __init__(self) -> None:
        self.create_agent_kwargs: list[dict[str, Any]] = []

    def create_agent(self, **kwargs: Any) -> SingleResponseAgent:
        self.create_agent_kwargs.append(kwargs)
        return SingleResponseAgent()

    async def get_latest_checkpoint_config(
        self,
        *,
        thread_id: str,
        checkpoint_ns: str = "",
    ) -> dict[str, str | None]:
        return {"checkpoint_id": None, "checkpoint_ns": checkpoint_ns}


@pytest.mark.asyncio
async def test_chat_service_passes_a2ui_runtime_context_to_agent_runner(tmp_path) -> None:
    repositories = _repositories(tmp_path)
    project = tmp_path / "project"
    project.mkdir()
    workspace = repositories.workspaces.create(workspace_id="ws_project", root_path=project)
    session = repositories.sessions.create(
        session_id="session-1",
        user_id="local-user",
        scene_id="desktop-agent",
        session_type="workspace",
        workspace_id=workspace.id,
        cwd=str(project),
        workspace_roots=[str(project)],
    )
    runner = CapturingRunner()
    service = ChatService(
        settings=AppSettings(data_dir=tmp_path / "data", workspace_root=tmp_path),
        repositories=repositories,
        agent_runner=runner,
    )

    result = await service.handle_chat(
        ChatRequest(
            session_id=session.id,
            message="继续",
            provider_id="provider-1",
            model="qwen-coder",
        )
    )

    assert result.status == "completed"
    assert runner.create_agent_kwargs
    kwargs = runner.create_agent_kwargs[0]
    assert kwargs["enable_tools"] is True
    metadata = kwargs["tool_context"].metadata
    assert metadata["repositories"] is repositories
    assert metadata["dispatcher"] is not None
    assert metadata["active_session_id"] == session.id
    assert metadata["thread_id"] == session.id
    assert metadata["checkpoint_ns"] == ""


def _repositories(tmp_path) -> StorageRepositories:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    now = to_iso_z(utc_now())
    repositories.model_providers.upsert(
        ModelProviderRecord(
            id="provider-1",
            name="测试模型服务",
            base_url="http://model.test/v1",
            api_key="test-key",
            enabled=True,
            models=["qwen-coder", "fake-default"],
            model_enabled={},
            health={},
            created_at=now,
            updated_at=now,
        )
    )
    repositories.model_providers.set_model_default(
        scope=MODEL_DEFAULT_CHAT,
        provider_id="provider-1",
        model="fake-default",
    )
    return repositories
