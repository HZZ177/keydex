from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi.testclient import TestClient

from backend.app.a2ui.resume_service import A2UIResumeStartResult
from backend.app.api.websocket import _build_a2ui_resume_service, _start_a2ui_resume
from backend.app.core.config import AppSettings
from backend.app.main import create_app
from backend.app.services import ChatStreamManager
from backend.app.storage import StorageRepositories, init_database


class FakeResumeService:
    def __init__(self, *, status: str = "started", started: bool = True) -> None:
        self.status = status
        self.started = started
        self.calls: list[dict[str, Any]] = []
        self.cancellation: Any | None = None
        self.background_task_starter: Any | None = None

    async def start_resume(
        self,
        interaction_id: str,
        *,
        background: bool = True,
        **kwargs: Any,
    ) -> A2UIResumeStartResult:
        self.calls.append({"interaction_id": interaction_id, "background": background})
        self.cancellation = kwargs.get("cancellation")
        self.background_task_starter = kwargs.get("background_task_starter")
        return A2UIResumeStartResult(
            interaction_id=interaction_id,
            resume_status=self.status,
            started=self.started,
            resume_group_id="group-1",
            pending_count=0 if self.started else 1,
            reason="all_peer_interactions_closed" if self.started else "waiting_peer_interactions",
        )


class ManagedFakeResumeService(FakeResumeService):
    def __init__(self) -> None:
        super().__init__()
        self.task: asyncio.Task[Any] | None = None
        self.task_started = asyncio.Event()
        self.task_cancelled = asyncio.Event()

    async def start_resume(
        self,
        interaction_id: str,
        *,
        background: bool = True,
        **kwargs: Any,
    ) -> A2UIResumeStartResult:
        result = await super().start_resume(
            interaction_id,
            background=background,
            **kwargs,
        )

        async def run_resume() -> None:
            self.task_started.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                self.task_cancelled.set()

        self.task = await kwargs["background_task_starter"](run_resume())
        return result


class RecordingResumeAgentRunner:
    def __init__(self) -> None:
        self.create_kwargs: dict[str, Any] | None = None

    def create_agent(self, **kwargs: Any) -> object:
        self.create_kwargs = kwargs
        return object()


class RecordingResumeChatService:
    def __init__(self, data_dir: Any) -> None:
        self.file_history_service = SimpleNamespace(enabled=True)
        self.thread_task_service = None
        self.settings = SimpleNamespace(data_dir=data_dir)
        self.agent_runner = RecordingResumeAgentRunner()
        self.tool_context_kwargs: dict[str, Any] | None = None
        self.tool_context = SimpleNamespace(metadata={})

    def _resolve_session_keydex_snapshot(self, _session: Any) -> object:
        return object()

    def _build_tool_context(self, **kwargs: Any) -> tuple[Any, bool]:
        self.tool_context_kwargs = kwargs
        return self.tool_context, True

    def _build_mcp_runtime_tools(self, **_kwargs: Any) -> list[Any]:
        return []


def test_websocket_a2ui_submit_returns_ack_and_triggers_resume(tmp_path) -> None:
    client = _client(tmp_path)
    repositories = client.app.state.repositories
    fake_resume = FakeResumeService()
    client.app.state.a2ui_resume_service = fake_resume
    _create_session(repositories, "ses-a2ui")
    _create_interaction(repositories, "a2ui-1")

    with client.websocket_connect("/agent-base/ws/chat?session_id=ses-a2ui") as ws:
        ws.send_json(
            {
                "action": "a2ui_submit",
                "interaction_id": "a2ui-1",
                "request_id": "submit-1",
                "submit_result": {"confirmed": True},
            }
        )
        ack = ws.receive_json()

    assert ack["action"] == "a2ui_submit_ack"
    assert ack["data"]["session_id"] == "ses-a2ui"
    assert ack["data"]["interaction_id"] == "a2ui-1"
    assert ack["data"]["status"] == "submitted"
    assert ack["data"]["interaction"]["can_submit"] is False
    assert ack["data"]["resume"]["status"] == "started"
    assert ack["data"]["resume"]["started"] is True
    assert fake_resume.calls == [{"interaction_id": "a2ui-1", "background": True}]
    assert fake_resume.cancellation is not None
    assert callable(fake_resume.background_task_starter)


def test_websocket_a2ui_submit_idempotent_replay_does_not_restart_resume(tmp_path) -> None:
    client = _client(tmp_path)
    repositories = client.app.state.repositories
    fake_resume = FakeResumeService()
    client.app.state.a2ui_resume_service = fake_resume
    _create_session(repositories, "ses-a2ui")
    _create_interaction(repositories, "a2ui-1")

    with client.websocket_connect("/agent-base/ws/chat?session_id=ses-a2ui") as ws:
        for _ in range(2):
            ws.send_json(
                {
                    "action": "a2ui_submit",
                    "interaction_id": "a2ui-1",
                    "request_id": "submit-1",
                    "submit_result": {"confirmed": True},
                }
            )
        first = ws.receive_json()
        second = ws.receive_json()

    assert first["action"] == "a2ui_submit_ack"
    assert second["action"] == "a2ui_submit_ack"
    assert second["data"]["idempotent"] is True
    assert fake_resume.calls == [{"interaction_id": "a2ui-1", "background": True}]


def test_websocket_a2ui_cancel_returns_ack_and_triggers_resume(tmp_path) -> None:
    client = _client(tmp_path)
    repositories = client.app.state.repositories
    fake_resume = FakeResumeService()
    client.app.state.a2ui_resume_service = fake_resume
    _create_session(repositories, "ses-a2ui")
    _create_interaction(repositories, "a2ui-1")

    with client.websocket_connect("/agent-base/ws/chat?session_id=ses-a2ui") as ws:
        ws.send_json(
            {
                "action": "a2ui_cancel",
                "interaction_id": "a2ui-1",
                "request_id": "cancel-1",
                "cancel_reason": "user_cancelled",
            }
        )
        ack = ws.receive_json()

    assert ack["action"] == "a2ui_cancel_ack"
    assert ack["data"]["session_id"] == "ses-a2ui"
    assert ack["data"]["interaction_id"] == "a2ui-1"
    assert ack["data"]["status"] == "cancelled"
    assert ack["data"]["cancel_reason"] == "user_cancelled"
    assert ack["data"]["interaction"]["can_submit"] is False
    assert fake_resume.calls == [{"interaction_id": "a2ui-1", "background": True}]


@pytest.mark.asyncio
async def test_a2ui_resume_is_owned_by_session_cancel_task(tmp_path) -> None:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    _create_session(repositories, "ses-a2ui")
    _create_interaction(repositories, "a2ui-1")
    fake_resume = ManagedFakeResumeService()
    manager = ChatStreamManager(SimpleNamespace(repositories=repositories))
    runtime = SimpleNamespace(chat_stream_manager=manager)
    websocket = SimpleNamespace(
        app=SimpleNamespace(state=SimpleNamespace(a2ui_resume_service=fake_resume))
    )

    result = await _start_a2ui_resume(
        websocket=websocket,
        runtime=runtime,
        repositories=repositories,
        adapter=SimpleNamespace(),
        interaction_id="a2ui-1",
        turn_index=1,
        should_resume=True,
    )
    await asyncio.wait_for(fake_resume.task_started.wait(), timeout=1)

    assert result is not None
    assert (await manager.status("ses-a2ui"))["status"] == "running"
    assert await manager.cancel("ses-a2ui") is True
    await asyncio.wait_for(fake_resume.task_cancelled.wait(), timeout=1)
    assert fake_resume.cancellation.is_cancelled() is True


@pytest.mark.asyncio
async def test_a2ui_resume_reuses_original_input_file_snapshot(
    tmp_path,
    monkeypatch,
) -> None:
    repositories = StorageRepositories(init_database(tmp_path / "app.db"))
    _create_session(repositories, "ses-a2ui")
    _create_interaction(repositories, "a2ui-1")
    repositories.trace_records.create(
        trace_id="trace-1",
        session_id="ses-a2ui",
        active_session_id="ses-a2ui",
        scene_id="desktop-agent",
        user_id="local-user",
        turn_index=1,
        root_node_id="trace-1-root",
        status="waiting_input",
    )
    repositories.trace_records.set_input_file_snapshot(
        "trace-1",
        snapshot_id="input-snapshot-1",
        status="ready",
    )
    chat_service = RecordingResumeChatService(tmp_path / "data")
    runtime = SimpleNamespace(chat_service=chat_service)
    monkeypatch.setattr(
        "backend.app.api.websocket.resolve_model_selection",
        lambda *_args, **_kwargs: SimpleNamespace(settings=object()),
    )
    service = await _build_a2ui_resume_service(
        runtime=runtime,
        repositories=repositories,
        adapter=SimpleNamespace(),
        session_id="ses-a2ui",
        turn_index=1,
    )
    interaction = repositories.a2ui_interactions.get("a2ui-1")
    assert interaction is not None
    snapshot = service._build_snapshot(interaction, interaction.resume_group_id, [])

    await service.agent_factory(snapshot)

    assert chat_service.tool_context_kwargs is not None
    assert chat_service.tool_context_kwargs["input_file_snapshot_id"] == "input-snapshot-1"
    assert chat_service.agent_runner.create_kwargs is not None
    assert chat_service.agent_runner.create_kwargs["tool_context"] is chat_service.tool_context


def test_websocket_a2ui_submit_requires_interaction_id(tmp_path) -> None:
    client = _client(tmp_path)
    _create_session(client.app.state.repositories, "ses-a2ui")

    with client.websocket_connect("/agent-base/ws/chat?session_id=ses-a2ui") as ws:
        ws.send_json(
            {
                "action": "a2ui_submit",
                "request_id": "submit-1",
                "submit_result": {"confirmed": True},
            }
        )
        error = ws.receive_json()

    assert error["action"] == "error"
    assert error["data"]["code"] == "missing_interaction"
    assert error["data"]["message"] == "interaction_id 必填"


def test_websocket_chat_is_blocked_while_a2ui_is_waiting(tmp_path) -> None:
    client = _client(tmp_path)
    repositories = client.app.state.repositories
    _create_session(repositories, "ses-a2ui")
    _create_interaction(repositories, "a2ui-1")

    async def fail_if_started(_request):
        raise AssertionError("chat must not start while A2UI is waiting")

    client.app.state.runtime.chat_stream_manager.start_chat = fail_if_started

    with client.websocket_connect("/agent-base/ws/chat?session_id=ses-a2ui") as ws:
        ws.send_json(
            {
                "action": "chat",
                "session_id": "ses-a2ui",
                "message": "should block",
            }
        )
        blocked = ws.receive_json()

    assert blocked["action"] == "a2ui_waiting_input"
    assert blocked["data"]["session_id"] == "ses-a2ui"
    assert blocked["data"]["pending_interactions"][0]["interaction_id"] == "a2ui-1"
    assert blocked["data"]["pending_interactions"][0]["can_submit"] is True


def _client(tmp_path) -> TestClient:
    app = create_app(
        AppSettings(data_dir=tmp_path / "data", workspace_root=tmp_path),
        keydex_system_root_for_testing=tmp_path / "system-keydex",
    )
    return TestClient(app)


def _create_session(repositories: StorageRepositories, session_id: str) -> None:
    repositories.sessions.create(
        session_id=session_id,
        user_id="local-user",
        scene_id="desktop-agent",
    )


def _create_interaction(repositories: StorageRepositories, interaction_id: str) -> None:
    repositories.a2ui_interactions.create(
        interaction_id=interaction_id,
        session_id="ses-a2ui",
        trace_id="trace-1",
        active_session_id="ses-a2ui",
        turn_index=1,
        tool_call_id="tool-1",
        stream_id="stream-1",
        render_key="confirm",
        mode="interactive",
        payload={"title": "Confirm"},
        input_schema={"type": "object"},
        submit_schema_snapshot={
            "type": "object",
            "properties": {"confirmed": {"type": "boolean"}},
            "required": ["confirmed"],
            "additionalProperties": False,
        },
        langgraph_thread_id="ses-a2ui",
        checkpoint_ns="",
        checkpoint_id="checkpoint-1",
        interrupt_id="interrupt-1",
        resume_group_id="group-1",
    )
