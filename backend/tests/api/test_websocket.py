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
from backend.app.core.time import to_iso_z, utc_now
from backend.app.main import create_app
from backend.app.model import ModelSettings
from backend.app.services import ChatService, ChatStreamManager
from backend.app.storage import MODEL_DEFAULT_CHAT, ModelProviderRecord, StorageRepositories
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
        _configure_model_default(app.state.repositories)
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
        app.state.chat_stream_manager = ChatStreamManager(chat_service)
        app.state.runtime.chat_stream_manager = app.state.chat_stream_manager
    return TestClient(app)


def _configure_model_default(repositories: StorageRepositories) -> None:
    now = to_iso_z(utc_now())
    provider = ModelProviderRecord(
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
    repositories.model_providers.upsert(provider)
    repositories.model_providers.set_model_default(
        scope=MODEL_DEFAULT_CHAT,
        provider_id=provider.id,
        model="fake-default",
    )


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


def test_websocket_create_workspace_session(tmp_path) -> None:
    client = _client(tmp_path)
    project = tmp_path / "project"
    project.mkdir()
    workspace = client.post(
        "/api/workspaces",
        json={"root_path": str(project), "name": "项目"},
    ).json()["workspace"]

    with client.websocket_connect("/agent-base/ws/chat") as ws:
        ws.send_json(
            {
                "action": "create_session",
                "session_type": "workspace",
                "workspace_id": workspace["id"],
                "scene_id": "desktop-agent",
            }
        )
        created = ws.receive_json()

    assert created["action"] == "session_created"
    session = created["data"]["session"]
    assert session["session_type"] == "workspace"
    assert session["workspace_id"] == workspace["id"]
    assert session["cwd"] == str(project.resolve())
    assert session["workspace"]["id"] == workspace["id"]


def test_websocket_rejects_invalid_workspace_session_contract(tmp_path) -> None:
    client = _client(tmp_path)

    with client.websocket_connect("/agent-base/ws/chat") as ws:
        ws.send_json({"action": "create_session", "session_type": "workspace"})
        error = ws.receive_json()

    assert error["action"] == "error"
    assert error["data"]["code"] == "invalid_session"
    assert "必须选择工作区" in error["data"]["message"]


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
                "provider_id": "provider-1",
                "model": "qwen-coder",
            }
        )
        events = [ws.receive_json() for _ in range(4)]

    assert [event["action"] for event in events] == [
        "turn_started",
        "stream",
        "stream",
        "completed",
    ]
    assert events[1]["data"]["content"] == "你"
    assert events[2]["data"]["content"] == "好"
    assert events[3]["data"]["session_id"] == session_id
    assert events[3]["data"]["final_content"] == "你好"


def test_websocket_chat_streams_tool_actions_and_history(tmp_path) -> None:
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
    workspace = client.post(
        "/api/workspaces",
        json={"root_path": str(project), "name": "项目"},
    ).json()["workspace"]

    with client.websocket_connect("/agent-base/ws/chat") as ws:
        ws.send_json(
            {
                "action": "create_session",
                "session_type": "workspace",
                "workspace_id": workspace["id"],
            }
        )
        session_id = ws.receive_json()["data"]["session_id"]

        ws.send_json(
            {
                "action": "chat",
                "session_id": session_id,
                "message": "读文件",
                "provider_id": "provider-1",
                "model": "qwen-coder",
            }
        )
        events = [ws.receive_json() for _ in range(5)]

    assert [event["action"] for event in events] == [
        "turn_started",
        "tool_start",
        "tool_end",
        "stream",
        "completed",
    ]
    assert events[1]["data"]["tool"] == "read_file"
    assert events[2]["data"]["status"] == "completed"
    assert "文件内容" in events[2]["data"]["result"]
    assert events[3]["data"]["content"] == "已读取"
    history = client.get(f"/api/sessions/{session_id}/history")
    assert history.status_code == 200
    messages = [
        message for message in history.json()["list"] if message["role"] != "turn"
    ]
    assert [message["role"] for message in messages] == ["user", "tool", "assistant"]
    assert messages[1]["status"] == "completed"
    assert messages[2]["content"] == "已读取"


def test_websocket_terminate_command_does_not_cancel_turn(tmp_path) -> None:
    client = _client(tmp_path)

    async def fail_if_cancel_called(_session_id: str | None = None) -> bool:
        raise AssertionError("terminate_command must not cancel the running turn")

    client.app.state.chat_stream_manager.cancel = fail_if_cancel_called

    with client.websocket_connect("/agent-base/ws/chat") as ws:
        ws.send_json({"action": "create_session"})
        session_id = ws.receive_json()["data"]["session_id"]

        ws.send_json(
            {
                "action": "terminate_command",
                "session_id": session_id,
                "command_id": "missing-command",
            }
        )
        terminated = ws.receive_json()

    assert terminated == {
        "action": "command_terminated",
        "data": {
            "session_id": session_id,
            "command_id": "missing-command",
            "terminated": False,
            "cancelled": False,
        },
    }


def test_websocket_approval_decision_resolves_mcp_tool_call(tmp_path) -> None:
    client = _client(tmp_path)
    repositories = client.app.state.repositories
    repositories.sessions.create(
        session_id="ses-mcp-ws",
        user_id="local-user",
        scene_id="desktop-agent",
        title="MCP WebSocket 审批",
    )
    repositories.mcp_servers.create(
        server_id="srv_exec",
        name="Execution MCP",
        transport="streamable_http",
        url="https://mcp.example.test/mcp",
    )
    repositories.command_approvals.create(
        approval_id="approval-mcp-ws",
        session_id="ses-mcp-ws",
        command="mcp__srv_exec__search",
        cwd=".",
        title="允许 Execution MCP MCP 执行 search？",
        tool_name="mcp__srv_exec__search",
        shell="mcp",
        kind="mcp_tool_call",
        details={
            "approval_kind": "mcp_tool_call",
            "snapshot_id": "snap-ws",
            "server_id": "srv_exec",
            "server_name": "Execution MCP",
            "raw_tool_name": "search",
            "model_tool_name": "mcp__srv_exec__search",
            "risk_level": "high",
            "approval_mode": "auto",
            "arguments_preview": {"query": "hello"},
            "trust_options": ["once", "session", "persistent_tool", "server_readonly"],
            "matched_rule": None,
        },
    )

    with client.websocket_connect("/agent-base/ws/chat?session_id=ses-mcp-ws") as ws:
        ws.send_json(
            {
                "action": "approval_decision",
                "approval_id": "approval-mcp-ws",
                "decision": "approved",
                "trust_scope": "session",
            }
        )
        resolved = ws.receive_json()

    assert resolved["action"] == "approval_resolved"
    approval = resolved["data"]["approval"]
    assert approval["kind"] == "mcp_tool_call"
    assert approval["status"] == "approved"
    assert approval["trust_scope"] == "session"
    assert approval["metadata"]["mcp"]["server_id"] == "srv_exec"
    assert repositories.command_approvals.get("approval-mcp-ws").status == "approved"


def test_websocket_chat_requires_explicit_model_selection(tmp_path) -> None:
    client = _client(tmp_path)

    with client.websocket_connect("/agent-base/ws/chat") as ws:
        ws.send_json({"action": "create_session"})
        session_id = ws.receive_json()["data"]["session_id"]

        ws.send_json({"action": "chat", "session_id": session_id, "message": "缺少模型选择"})
        error = ws.receive_json()

    assert error["action"] == "error"
    assert error["data"]["session_id"] == session_id
    assert error["data"]["message"] == "对话模型必须显式指定供应商和模型"
    assert error["data"]["code"] == "chat_model_required"


def test_websocket_returns_structured_error_for_unknown_action(tmp_path) -> None:
    client = _client(tmp_path)

    with client.websocket_connect("/agent-base/ws/chat") as ws:
        ws.send_json({"action": "unknown"})
        response = ws.receive_json()

    assert response["action"] == "error"
    assert response["data"]["code"] == "unknown_action"
    assert "unknown" in response["data"]["message"]


def test_websocket_elicitation_resolve_action_is_not_unknown(tmp_path) -> None:
    client = _client(tmp_path)

    with client.websocket_connect("/agent-base/ws/chat") as ws:
        ws.send_json(
            {
                "action": "mcp_elicitation_resolved",
                "elicitation_id": "missing",
                "values": {"name": "value"},
            }
        )
        response = ws.receive_json()

    assert response["action"] == "error"
    assert response["data"]["code"] == "invalid_elicitation_resolution"


def test_websocket_reconnect_can_bind_existing_session(tmp_path) -> None:
    client = _client(tmp_path)

    with client.websocket_connect("/agent-base/ws/chat") as ws:
        ws.send_json({"action": "create_session"})
        session_id = ws.receive_json()["data"]["session_id"]

    with client.websocket_connect(f"/agent-base/ws/chat?session_id={session_id}") as ws:
        ws.send_json({"action": "bind_session"})
        bound = ws.receive_json()

    assert bound == {"action": "bind_ok", "data": {"session_id": session_id}}
