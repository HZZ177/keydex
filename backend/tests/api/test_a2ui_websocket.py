from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

from backend.app.a2ui.resume_service import A2UIResumeStartResult
from backend.app.core.config import AppSettings
from backend.app.main import create_app
from backend.app.storage import StorageRepositories


class FakeResumeService:
    def __init__(self, *, status: str = "started", started: bool = True) -> None:
        self.status = status
        self.started = started
        self.calls: list[dict[str, Any]] = []

    async def start_resume(
        self,
        interaction_id: str,
        *,
        background: bool = True,
        **_kwargs: Any,
    ) -> A2UIResumeStartResult:
        self.calls.append({"interaction_id": interaction_id, "background": background})
        return A2UIResumeStartResult(
            interaction_id=interaction_id,
            resume_status=self.status,
            started=self.started,
            resume_group_id="group-1",
            pending_count=0 if self.started else 1,
            reason="all_peer_interactions_closed" if self.started else "waiting_peer_interactions",
        )


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
    app = create_app(AppSettings(data_dir=tmp_path / "data", workspace_root=tmp_path))
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
