from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage

from backend.app.agent import AgentRunner
from backend.app.agent.checkpoint import SQLiteCheckpointSaver
from backend.app.agent.factory import AgentFactory
from backend.app.core.config import AppSettings
from backend.app.model import ModelSettings
from backend.app.services import ChatRequest, ChatService
from backend.app.storage import StorageRepositories, init_database
from backend.app.tools import FunctionTool, ToolRegistry


class RecordingChatAdapter:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send(self, *, session_id: str, action: str, data: dict[str, Any]) -> bool:
        self.sent.append({"session_id": session_id, "action": action, "data": data})
        return True


class ToolFriendlyFakeModel(FakeMessagesListChatModel):
    def bind_tools(self, tools: list[Any], *, tool_choice: Any = None, **kwargs: Any) -> Any:
        return self


class FakeAgentFactory(AgentFactory):
    def __init__(self, model: ToolFriendlyFakeModel) -> None:
        super().__init__()
        self.model = model
        self.requested_models: list[str] = []
        self.created_tool_counts: list[int] = []

    def get_or_create_llm(
        self,
        settings: ModelSettings,
        *,
        model: str,
        temperature: float | None = None,
        max_tokens: int | None = None,
        streaming: bool = True,
        **kwargs: Any,
    ) -> ToolFriendlyFakeModel:
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
        name: str = "desktop_agent",
    ) -> Any:
        self.created_tool_counts.append(len(tools))
        return super().create_agent(
            model=model,
            tools=tools,
            system_prompt=system_prompt,
            checkpointer=checkpointer,
            middleware=middleware,
            name=name,
        )


def _service(
    tmp_path: Path,
    model: ToolFriendlyFakeModel,
    registry: ToolRegistry | None = None,
) -> tuple[ChatService, StorageRepositories, SQLiteCheckpointSaver, FakeAgentFactory]:
    database = init_database(tmp_path / "app.db")
    repositories = StorageRepositories(database)
    settings = AppSettings(data_dir=tmp_path / "data", workspace_root=tmp_path)
    checkpointer = SQLiteCheckpointSaver(database)
    factory = FakeAgentFactory(model)
    runner = AgentRunner(
        model_settings_provider=lambda: ModelSettings(
            base_url="http://model.test/v1",
            api_key="test-key",
            model="fake-default",
        ),
        checkpointer=checkpointer,
        tool_registry=registry or ToolRegistry(),
        default_system_prompt="系统提示",
        factory=factory,
    )
    return (
        ChatService(settings=settings, repositories=repositories, agent_runner=runner),
        repositories,
        checkpointer,
        factory,
    )


@pytest.mark.asyncio
async def test_chat_service_uses_langchain_agent_and_persists_history(tmp_path) -> None:
    model = ToolFriendlyFakeModel(responses=[AIMessage(content="你好")])
    service, repositories, _checkpointer, factory = _service(tmp_path, model)
    chat_adapter = RecordingChatAdapter()

    result = await service.handle_chat(
        ChatRequest(message="你好", model="qwen-coder"),
        chat_adapter=chat_adapter,
    )

    assert result.status == "completed"
    assert result.final_content == "你好"
    assert factory.requested_models == ["qwen-coder"]
    assert [item["action"] for item in chat_adapter.sent] == ["stream", "completed"]
    history = service.message_event_service.get_display_messages(result.session_id)
    assert [message["role"] for message in history] == ["user", "assistant"]
    assert history[-1]["content"] == "你好"
    trace = repositories.trace_records.get(result.trace_id)
    assert trace.status == "completed"
    assert trace.output_checkpoint_id
    llm_logs, total = repositories.llm_request_logs.list()
    assert total == 1
    assert llm_logs[0].trace_id == result.trace_id
    assert llm_logs[0].session_id == result.session_id
    assert llm_logs[0].model == "qwen-coder"
    assert llm_logs[0].status == "completed"


@pytest.mark.asyncio
async def test_chat_service_uses_checkpoint_as_model_context(tmp_path) -> None:
    model = ToolFriendlyFakeModel(
        responses=[
            AIMessage(content="第一轮回答"),
            AIMessage(content="第二轮回答"),
        ]
    )
    service, _repositories, checkpointer, _factory = _service(tmp_path, model)

    first = await service.handle_chat(ChatRequest(message="第一轮", model="qwen-coder"))
    second = await service.handle_chat(
        ChatRequest(session_id=first.session_id, message="第二轮", model="qwen-coder")
    )

    assert first.turn_index == 1
    assert second.turn_index == 2
    checkpoint = await checkpointer.aget_tuple(
        {"configurable": {"thread_id": first.session_id, "checkpoint_ns": ""}}
    )
    messages = checkpoint.checkpoint["channel_values"]["messages"]
    assert [message.type for message in messages] == ["human", "ai", "human", "ai"]
    assert [message.content for message in messages] == [
        "第一轮",
        "第一轮回答",
        "第二轮",
        "第二轮回答",
    ]


@pytest.mark.asyncio
async def test_chat_service_routes_langchain_tool_events(tmp_path) -> None:
    project = tmp_path / "project"
    project.mkdir()
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
            handler=lambda args, context: {
                "content": f"文件内容:{args['path']}",
                "root": str(context.workspace_root),
            },
        )
    )
    model = ToolFriendlyFakeModel(
        responses=[
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "read_file",
                        "args": {"path": "a.txt"},
                        "id": "call_read",
                    }
                ],
            ),
            AIMessage(content="已读取"),
        ]
    )
    service, repositories, _checkpointer, _factory = _service(tmp_path, model, registry)
    workspace = repositories.workspaces.create(workspace_id="ws_project", root_path=project)
    session = repositories.sessions.create(
        session_id="ses_project",
        user_id="local-user",
        scene_id="desktop-agent",
        session_type="workspace",
        workspace_id=workspace.id,
        cwd=str(project),
        workspace_roots=[str(project)],
    )
    chat_adapter = RecordingChatAdapter()

    result = await service.handle_chat(
        ChatRequest(session_id=session.id, message="读文件", model="qwen-coder"),
        chat_adapter=chat_adapter,
    )

    assert result.status == "completed"
    assert [item["action"] for item in chat_adapter.sent] == [
        "tool_start",
        "tool_end",
        "stream",
        "completed",
    ]
    assert chat_adapter.sent[0]["data"]["tool"] == "read_file"
    assert chat_adapter.sent[1]["data"]["status"] == "completed"
    assert "文件内容:a.txt" in chat_adapter.sent[1]["data"]["result"]
    tool_result = json.loads(chat_adapter.sent[1]["data"]["result"])
    assert tool_result["root"] == str(project.resolve())
    history = service.message_event_service.get_display_messages(result.session_id)
    assert [message["role"] for message in history] == ["user", "tool", "assistant"]
    assert history[1]["toolName"] == "read_file"
    assert history[2]["content"] == "已读取"


@pytest.mark.asyncio
async def test_chat_service_disables_project_tools_for_chat_session(tmp_path) -> None:
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
            handler=lambda args, context: {"content": "不应执行"},
        )
    )
    model = ToolFriendlyFakeModel(responses=[AIMessage(content="普通回复")])
    service, _repositories, _checkpointer, factory = _service(tmp_path, model, registry)
    chat_adapter = RecordingChatAdapter()

    result = await service.handle_chat(
        ChatRequest(message="只聊天", model="qwen-coder"),
        chat_adapter=chat_adapter,
    )

    assert result.status == "completed"
    assert factory.created_tool_counts == [0]
    assert [item["action"] for item in chat_adapter.sent] == ["stream", "completed"]


@pytest.mark.asyncio
async def test_chat_service_requires_runtime_model_parameter(tmp_path) -> None:
    model = ToolFriendlyFakeModel(responses=[AIMessage(content="不应调用")])
    service, repositories, _checkpointer, factory = _service(tmp_path, model)
    chat_adapter = RecordingChatAdapter()

    result = await service.handle_chat(
        ChatRequest(message="你好"),
        chat_adapter=chat_adapter,
    )

    assert result.status == "failed"
    assert result.error == "模型不能为空"
    assert factory.requested_models == []
    assert chat_adapter.sent[-1]["action"] == "error"
    assert chat_adapter.sent[-1]["data"]["message"] == "模型不能为空"
    assert repositories.sessions.get(result.session_id).status == "failed"
