from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient
from langchain_core.language_models.fake_chat_models import (
    FakeListChatModel,
    FakeMessagesListChatModel,
)
from langchain_core.messages import AIMessage

from backend.app.agent import AgentRunner
from backend.app.agent.checkpoint import SQLiteCheckpointSaver
from backend.app.agent.factory import AgentFactory
from backend.app.core.config import AppSettings
from backend.app.main import create_app
from backend.app.model import ModelSettings
from backend.app.services import ChatService
from backend.app.tools import FunctionTool, ToolRegistry


class ToolFriendlyFakeModel(FakeMessagesListChatModel):
    def bind_tools(self, tools: list[Any], *, tool_choice: Any = None, **kwargs: Any) -> Any:
        return self


class FakeAgentFactory(AgentFactory):
    def __init__(self, model: Any) -> None:
        super().__init__()
        self.model = model

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
        return self.model


def _client(
    tmp_path,
    model: Any | None = None,
    registry: ToolRegistry | None = None,
) -> TestClient:
    app = create_app(AppSettings(data_dir=tmp_path / "data", workspace_root=tmp_path))
    if model is not None:
        runner = AgentRunner(
            model_settings_provider=lambda: ModelSettings(
                base_url="http://model.test/v1",
                api_key="test-key",
                model="fake-default",
            ),
            checkpointer=SQLiteCheckpointSaver(app.state.database),
            tool_registry=registry or ToolRegistry(),
            default_system_prompt="系统提示",
            factory=FakeAgentFactory(model),
        )
        chat_service = ChatService(
            settings=app.state.settings,
            repositories=app.state.repositories,
            agent_runner=runner,
        )
        app.state.chat_service = chat_service
        app.state.runtime.chat_service = chat_service
    return TestClient(app)


def test_websocket_create_bind_and_ping(tmp_path) -> None:
    client = _client(tmp_path)

    with client.websocket_connect("/agent-base/ws/chat") as ws:
        ws.send_json({"action": "create_session", "scene_id": "desktop-agent"})
        created = ws.receive_json()
        session_id = created["data"]["session_id"]

        ws.send_json({"action": "bind_session", "session_id": session_id})
        bound = ws.receive_json()

        ws.send_json({"action": "ping"})
        pong = ws.receive_json()

    assert created["action"] == "session_created"
    assert bound == {"action": "bind_ok", "data": {"session_id": session_id}}
    assert pong["action"] == "pong"
    assert isinstance(pong["data"]["timestamp"], int)


def test_websocket_chat_streams_projection_actions(tmp_path) -> None:
    client = _client(tmp_path, FakeListChatModel(responses=["你好"]))

    with client.websocket_connect("/agent-base/ws/chat") as ws:
        ws.send_json({"action": "create_session"})
        session_id = ws.receive_json()["data"]["session_id"]

        ws.send_json(
            {
                "action": "chat",
                "session_id": session_id,
                "message": "你好",
                "model": "qwen-coder",
            }
        )
        first = ws.receive_json()
        second = ws.receive_json()
        completed = ws.receive_json()

    assert [first["action"], second["action"], completed["action"]] == [
        "stream",
        "stream",
        "completed",
    ]
    assert first["data"]["content"] == "你"
    assert second["data"]["content"] == "好"
    assert completed["data"]["session_id"] == session_id
    assert completed["data"]["final_content"] == "你好"


def test_websocket_chat_streams_tool_actions_and_history(tmp_path) -> None:
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
            handler=lambda args, context: {"content": "文件内容"},
        )
    )
    client = _client(
        tmp_path,
        ToolFriendlyFakeModel(
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
        ),
        registry,
    )

    with client.websocket_connect("/agent-base/ws/chat") as ws:
        ws.send_json({"action": "create_session"})
        session_id = ws.receive_json()["data"]["session_id"]

        ws.send_json(
            {
                "action": "chat",
                "session_id": session_id,
                "message": "读文件",
                "model": "qwen-coder",
            }
        )
        events = [ws.receive_json() for _ in range(4)]

    assert [event["action"] for event in events] == [
        "tool_start",
        "tool_end",
        "stream",
        "completed",
    ]
    assert events[0]["data"]["tool"] == "read_file"
    assert events[1]["data"]["status"] == "completed"
    assert "文件内容" in events[1]["data"]["result"]
    assert events[2]["data"]["content"] == "已读取"
    history = client.get(f"/api/sessions/{session_id}/history")
    assert history.status_code == 200
    messages = history.json()["list"]
    assert [message["role"] for message in messages] == ["user", "tool", "assistant"]
    assert messages[1]["status"] == "completed"
    assert messages[2]["content"] == "已读取"


def test_websocket_chat_requires_runtime_model(tmp_path) -> None:
    client = _client(tmp_path)

    with client.websocket_connect("/agent-base/ws/chat") as ws:
        ws.send_json({"action": "create_session"})
        session_id = ws.receive_json()["data"]["session_id"]

        ws.send_json({"action": "chat", "session_id": session_id, "message": "缺少模型"})
        error = ws.receive_json()

    assert error["action"] == "error"
    assert error["data"]["session_id"] == session_id
    assert error["data"]["message"] == "模型不能为空"


def test_websocket_returns_structured_error_for_unknown_action(tmp_path) -> None:
    client = _client(tmp_path)

    with client.websocket_connect("/agent-base/ws/chat") as ws:
        ws.send_json({"action": "unknown"})
        response = ws.receive_json()

    assert response["action"] == "error"
    assert response["data"]["code"] == "unknown_action"
    assert "unknown" in response["data"]["message"]


def test_websocket_reconnect_can_bind_existing_session(tmp_path) -> None:
    client = _client(tmp_path)

    with client.websocket_connect("/agent-base/ws/chat") as ws:
        ws.send_json({"action": "create_session"})
        session_id = ws.receive_json()["data"]["session_id"]

    with client.websocket_connect(f"/agent-base/ws/chat?session_id={session_id}") as ws:
        ws.send_json({"action": "bind_session"})
        bound = ws.receive_json()

    assert bound == {"action": "bind_ok", "data": {"session_id": session_id}}
