from __future__ import annotations

from types import SimpleNamespace
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


class RecordingKeydexWatcher:
    def __init__(self) -> None:
        self.registered: list[tuple[str, str | None]] = []
        self.unregistered: list[str] = []

    async def register_session(self, session_id: str, workspace_root=None) -> None:
        self.registered.append(
            (session_id, str(workspace_root) if workspace_root is not None else None)
        )

    async def unregister_session(self, session_id: str) -> None:
        self.unregistered.append(session_id)

    async def close(self) -> None:
        return None


class RecordingGitQueryService:
    def __init__(self) -> None:
        self.requests: list[Any] = []

    def repository(self, request: Any) -> Any:
        self.requests.append(request)
        return SimpleNamespace(id=request.repository_id)


class RecordingGitMetadataEvents:
    def __init__(self) -> None:
        self.subscribed: list[tuple[str, Any]] = []
        self.unsubscribed: list[tuple[str, Any]] = []

    async def subscribe(self, repository: Any, subscriber: Any) -> int:
        self.subscribed.append((repository.id, subscriber))
        return 7

    async def unsubscribe(self, repository_id: str, subscriber: Any) -> None:
        self.unsubscribed.append((repository_id, subscriber))

    async def close(self) -> None:
        return None


def _receive_until_action(
    websocket: Any,
    terminal_action: str,
    *,
    limit: int = 32,
) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for _ in range(limit):
        event = websocket.receive_json()
        events.append(event)
        if event.get("action") == terminal_action:
            return events
    raise AssertionError(f"未在 {limit} 个 WebSocket 事件内收到 {terminal_action}")


def _client(
    tmp_path,
    model: Any | None = None,
    registry: ToolRegistry | None = None,
) -> TestClient:
    app = create_app(
        AppSettings(data_dir=tmp_path / "data", workspace_root=tmp_path),
        keydex_system_root_for_testing=tmp_path / "system-keydex",
    )
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


def test_websocket_binds_exact_git_repository_watch_and_unbinds(tmp_path) -> None:
    client = _client(tmp_path)
    query_service = RecordingGitQueryService()
    metadata_events = RecordingGitMetadataEvents()
    client.app.state.git_query_service = query_service
    client.app.state.git_metadata_event_service = metadata_events

    with client.websocket_connect("/agent-base/ws/chat") as ws:
        ws.send_json(
            {
                "action": "bind_git_repository_watch",
                "data": {
                    "workspace_id": "workspace-1",
                    "project_root": str(tmp_path),
                    "repository_id": "repo-1",
                },
            }
        )
        assert ws.receive_json() == {
            "action": "gitRepositoryWatchBound",
            "data": {
                "repository_id": "repo-1",
                "sequence": 7,
                "resync_required": True,
            },
        }
        ws.send_json(
            {
                "action": "unbind_git_repository_watch",
                "data": {"repository_id": "repo-1"},
            }
        )
        assert ws.receive_json() == {
            "action": "gitRepositoryWatchUnbound",
            "data": {"repository_id": "repo-1"},
        }

    assert len(query_service.requests) == 1
    request = query_service.requests[0]
    assert request.workspace_id == "workspace-1"
    assert request.project_root == str(tmp_path)
    assert request.repository_id == "repo-1"
    assert [item[0] for item in metadata_events.subscribed] == ["repo-1"]
    assert [item[0] for item in metadata_events.unsubscribed] == ["repo-1"]


def test_websocket_git_watch_error_keeps_feature_scope_without_session(tmp_path) -> None:
    client = _client(tmp_path)
    assert client.app.state.git_query_service is not None
    client.app.state.git_query_service = None

    with client.websocket_connect("/agent-base/ws/chat") as ws:
        ws.send_json(
            {
                "action": "bind_git_repository_watch",
                "data": {
                    "workspace_id": "workspace-1",
                    "project_root": str(tmp_path),
                    "repository_id": "repo-1",
                },
            }
        )

        response = ws.receive_json()

    assert response["action"] == "error"
    assert response["data"]["error"] == {
        "schema_version": 1,
        "code": "git_unavailable",
        "message": "Git metadata watch is unavailable",
        "details": {},
        "retryable": False,
    }
    assert isinstance(response["data"]["trace_id"], str)
    assert response["data"]["source_action"] == "bind_git_repository_watch"
    assert response["data"]["workspace_id"] == "workspace-1"
    assert response["data"]["repository_id"] == "repo-1"
    assert "session_id" not in response["data"]


def test_websocket_cleans_git_repository_watch_on_disconnect(tmp_path) -> None:
    client = _client(tmp_path)
    client.app.state.git_query_service = RecordingGitQueryService()
    metadata_events = RecordingGitMetadataEvents()
    client.app.state.git_metadata_event_service = metadata_events

    with client.websocket_connect("/agent-base/ws/chat") as ws:
        ws.send_json(
            {
                "action": "bind_git_repository_watch",
                "data": {
                    "workspace_id": "workspace-1",
                    "project_root": str(tmp_path),
                    "repository_id": "repo-1",
                },
            }
        )
        assert ws.receive_json()["action"] == "gitRepositoryWatchBound"

    assert [item[0] for item in metadata_events.unsubscribed] == ["repo-1"]


def test_websocket_registers_chat_scope_and_cleans_last_connection_only(tmp_path) -> None:
    client = _client(tmp_path)
    watcher = RecordingKeydexWatcher()
    client.app.state.keydex_workspace_watcher = watcher
    created = client.post("/api/sessions", json={}).json()["session"]
    session_id = created["id"]

    with client.websocket_connect(f"/agent-base/ws/chat?session_id={session_id}"):
        with client.websocket_connect(f"/agent-base/ws/chat?session_id={session_id}"):
            assert watcher.unregistered == []
        assert watcher.unregistered == []

    assert watcher.registered == [(session_id, None), (session_id, None)]
    assert watcher.unregistered == [session_id]


def test_websocket_registers_workspace_scope_and_unbinds_dependency(tmp_path) -> None:
    client = _client(tmp_path)
    watcher = RecordingKeydexWatcher()
    client.app.state.keydex_workspace_watcher = watcher
    project = tmp_path / "watch-project"
    project.mkdir()
    workspace = client.post(
        "/api/workspaces", json={"root_path": str(project), "name": "Watcher"}
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
        ws.send_json({"action": "unbind_session", "session_id": session_id})
        assert ws.receive_json()["action"] == "unbind_ok"

    assert watcher.registered == [(session_id, str(project.resolve()))]
    assert watcher.unregistered == [session_id]


def test_t60_t61_websocket_delivers_exact_system_and_workspace_skill_refresh(
    tmp_path,
) -> None:
    system_root = tmp_path / "system-keydex"
    system_entry = system_root / "skills" / "global" / "SKILL.md"
    system_entry.parent.mkdir(parents=True)
    system_entry.write_text(
        "---\nname: global\ndescription: Global\n---\n\nv1\n",
        encoding="utf-8",
    )
    project = tmp_path / "project"
    project.mkdir()

    with _client(tmp_path) as client:
        workspace = client.post(
            "/api/workspaces", json={"root_path": str(project), "name": "Project"}
        ).json()["workspace"]
        chat = client.post("/api/sessions", json={}).json()["session"]
        project_session = client.post(
            "/api/sessions",
            json={"session_type": "workspace", "workspace_id": workspace["id"]},
        ).json()["session"]

        with client.websocket_connect(
            f"/agent-base/ws/chat?session_id={chat['id']}"
        ) as chat_ws, client.websocket_connect(
            f"/agent-base/ws/chat?session_id={project_session['id']}"
        ) as project_ws:
            system_entry.write_text(
                "---\nname: global\ndescription: Global\n---\n\nv2\n",
                encoding="utf-8",
            )
            assert client.portal is not None
            assert client.portal.call(
                client.app.state.keydex_workspace_watcher.handle_system_path_change,
                system_entry,
            ) is True
            chat_event = chat_ws.receive_json()
            project_system_event = project_ws.receive_json()

            workspace_entry = project / ".keydex" / "skills" / "local" / "SKILL.md"
            workspace_entry.parent.mkdir(parents=True)
            workspace_entry.write_text(
                "---\nname: local\ndescription: Local\n---\n\nbody\n",
                encoding="utf-8",
            )
            assert client.portal.call(
                client.app.state.keydex_workspace_watcher.handle_workspace_path_change,
                project,
                workspace_entry,
            ) is True
            project_workspace_event = project_ws.receive_json()

    assert chat_event["action"] == "keydexWorkspaceChanged"
    chat_data = chat_event["data"]
    assert chat_data == {
        "session_id": chat["id"],
        "sessionId": chat["id"],
        "session_scope": "system",
        "sessionScope": "system",
        "workspace_root": None,
        "workspaceRoot": None,
        "changed_scope": "system",
        "changedScope": "system",
        "changed_path": "skills/global/SKILL.md",
        "changedPath": "skills/global/SKILL.md",
        "changed_paths": ["skills/global/SKILL.md"],
        "changedPaths": ["skills/global/SKILL.md"],
        "changed_capabilities": ["skills"],
        "changedCapabilities": ["skills"],
        "capability_fingerprints": chat_data["capability_fingerprints"],
        "capabilityFingerprints": chat_data["capability_fingerprints"],
        "effective_fingerprint": chat_data["effective_fingerprint"],
        "effectiveFingerprint": chat_data["effective_fingerprint"],
        "fingerprint": chat_data["effective_fingerprint"],
    }
    assert len(chat_data["effective_fingerprint"]) == 64
    assert set(chat_data["capability_fingerprints"]) == {"skills", "keydex_markdown"}
    assert all(len(value) == 64 for value in chat_data["capability_fingerprints"].values())
    assert project_system_event["action"] == "keydexWorkspaceChanged"
    assert project_system_event["data"]["changed_scope"] == "system"
    assert project_system_event["data"]["session_id"] == project_session["id"]
    assert project_workspace_event["action"] == "keydexWorkspaceChanged"
    workspace_data = project_workspace_event["data"]
    assert workspace_data == {
        "session_id": project_session["id"],
        "sessionId": project_session["id"],
        "session_scope": "workspace",
        "sessionScope": "workspace",
        "workspace_root": project.resolve().as_posix(),
        "workspaceRoot": project.resolve().as_posix(),
        "changed_scope": "workspace",
        "changedScope": "workspace",
        "changed_path": ".keydex/skills/local/SKILL.md",
        "changedPath": ".keydex/skills/local/SKILL.md",
        "changed_paths": [".keydex/skills/local/SKILL.md"],
        "changedPaths": [".keydex/skills/local/SKILL.md"],
        "changed_capabilities": ["skills"],
        "changedCapabilities": ["skills"],
        "capability_fingerprints": workspace_data["capability_fingerprints"],
        "capabilityFingerprints": workspace_data["capability_fingerprints"],
        "effective_fingerprint": workspace_data["effective_fingerprint"],
        "effectiveFingerprint": workspace_data["effective_fingerprint"],
        "fingerprint": workspace_data["effective_fingerprint"],
    }
    assert str(system_root.resolve()) not in str(
        [chat_event, project_system_event, project_workspace_event]
    )


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
    assert error["data"]["error"]["code"] == "invalid_session"
    assert "必须选择工作区" in error["data"]["error"]["message"]


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
        received_events = _receive_until_action(ws, "completed")

    events = [
        event
        for event in received_events
        if event["action"] in {"turn_started", "stream", "completed"}
    ]

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
        received_events = _receive_until_action(ws, "completed")

    events = [
        event
        for event in received_events
        if event["action"]
        in {"turn_started", "tool_start", "tool_end", "stream", "completed"}
    ]

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


def test_websocket_cancel_reconciles_missing_run_after_backend_restart(tmp_path) -> None:
    client = _client(tmp_path)

    with client.websocket_connect("/agent-base/ws/chat") as ws:
        ws.send_json({"action": "create_session"})
        session_id = ws.receive_json()["data"]["session_id"]
        client.app.state.repositories.sessions.update(session_id, status="running")

        ws.send_json({"action": "cancel", "session_id": session_id})
        status = ws.receive_json()

    assert status["action"] == "status"
    assert status["data"]["session_id"] == session_id
    assert status["data"]["status"] == "idle"
    assert client.app.state.repositories.sessions.get(session_id).status == "active"


def test_app_startup_recovers_running_session_left_by_previous_process(tmp_path) -> None:
    app = create_app(AppSettings(data_dir=tmp_path / "data", workspace_root=tmp_path))
    app.state.repositories.sessions.create(
        session_id="ses-restart",
        user_id="local-user",
        scene_id="desktop-agent",
        status="running",
    )

    with TestClient(app):
        assert app.state.repositories.sessions.get("ses-restart").status == "active"


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
            "approval_mode": "auto",
            "arguments_preview": {"query": "hello"},
            "trust_options": ["once", "session", "persistent_tool", "persistent_server"],
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
    assert error["data"]["error"]["message"] == "对话模型必须显式指定供应商和模型"
    assert error["data"]["error"]["code"] == "chat_model_required"


def test_websocket_returns_structured_error_for_unknown_action(tmp_path) -> None:
    client = _client(tmp_path)

    with client.websocket_connect("/agent-base/ws/chat") as ws:
        ws.send_json({"action": "unknown"})
        response = ws.receive_json()

    assert response["action"] == "error"
    assert response["data"]["error"]["code"] == "unknown_action"
    assert "unknown" in response["data"]["error"]["message"]
    assert response["data"]["error"]["schema_version"] == 1
    assert response["data"]["source_action"] == "unknown"


def test_websocket_returns_canonical_error_for_invalid_json(tmp_path) -> None:
    client = _client(tmp_path)

    with client.websocket_connect("/agent-base/ws/chat") as ws:
        ws.send_text("{invalid-json")
        response = ws.receive_json()

    assert response["action"] == "error"
    assert response["data"]["error"]["schema_version"] == 1
    assert response["data"]["error"]["code"] == "parse_error"
    assert response["data"]["error"]["details"] == {}
    assert isinstance(response["data"]["trace_id"], str)
    assert "source_action" not in response["data"]


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
    assert response["data"]["error"]["code"] == "invalid_elicitation_resolution"


def test_websocket_reconnect_can_bind_existing_session(tmp_path) -> None:
    client = _client(tmp_path)

    with client.websocket_connect("/agent-base/ws/chat") as ws:
        ws.send_json({"action": "create_session"})
        session_id = ws.receive_json()["data"]["session_id"]

    with client.websocket_connect(f"/agent-base/ws/chat?session_id={session_id}") as ws:
        ws.send_json({"action": "bind_session"})
        bound = ws.receive_json()

    assert bound == {"action": "bind_ok", "data": {"session_id": session_id}}
