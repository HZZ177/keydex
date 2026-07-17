from __future__ import annotations

from fastapi.testclient import TestClient

from backend.app.agent.checkpoint import SQLiteCheckpointSaver
from backend.app.api import sessions as sessions_api
from backend.app.core.config import AppSettings
from backend.app.main import create_app
from backend.app.services.manual_context_compression_service import ManualContextCompressionResult


def _checkpoint(checkpoint_id: str) -> dict:
    return {
        "v": 1,
        "id": checkpoint_id,
        "ts": f"2026-06-28T00:00:00+00:00:{checkpoint_id}",
        "channel_values": {"messages": [checkpoint_id]},
        "channel_versions": {},
        "versions_seen": {},
    }


def _prepare_source(app) -> None:
    repositories = app.state.repositories
    repositories.sessions.create(
        session_id="ses_source",
        user_id="local-user",
        scene_id="desktop-agent",
        title="源会话",
    )
    saver = SQLiteCheckpointSaver(app.state.database)
    saver.put(
        {"configurable": {"thread_id": "ses_source", "checkpoint_ns": ""}},
        _checkpoint("ckpt_1"),
        {"step": 1},
        {},
    )
    repositories.trace_records.create(
        trace_id="trace_1",
        session_id="ses_source",
        active_session_id="ses_source",
        scene_id="desktop-agent",
        user_id="local-user",
        turn_index=1,
        root_node_id="root_1",
    )
    repositories.trace_records.finish(
        "trace_1",
        status="completed",
        output_checkpoint_id="ckpt_1",
        output_checkpoint_ns="",
    )
    repositories.message_events.append(
        event_id="evt_user_1",
        session_id="ses_source",
        trace_record_id="trace_1",
        turn_index=1,
        action="user_message",
        data={"session_id": "ses_source", "content": "问题"},
    )
    repositories.message_events.append(
        event_id="evt_ai_1",
        session_id="ses_source",
        trace_record_id="trace_1",
        turn_index=1,
        action="ai_message",
        data={"session_id": "ses_source", "content": "回答"},
    )


def test_session_fork_api_returns_new_session_and_source_metadata(tmp_path) -> None:
    app = create_app(AppSettings(data_dir=tmp_path / "data"))
    _prepare_source(app)

    with TestClient(app) as client:
        response = client.post(
            "/api/sessions/ses_source/fork",
            json={"title": "API 分支"},
        )
        source_history_response = client.get("/api/sessions/ses_source/history?all_turns=true")
        forked_session_id = response.json()["session"]["id"]
        forked_history_response = client.get(
            f"/api/sessions/{forked_session_id}/history?all_turns=true"
        )

    assert response.status_code == 200
    body = response.json()
    assert body["session"]["id"] != "ses_source"
    assert body["session"]["title"] == "API 分支"
    assert body["session"]["parent_session_id"] is None
    assert body["session"]["child_session_id"] is None
    assert body["session"]["fork_source"]["source_session_id"] == "ses_source"
    assert body["session"]["fork_source"]["source_message_event_id"] == "evt_ai_1"
    assert body["session"]["fork_source"]["target_message_event_id"] != "evt_ai_1"
    assert body["session"]["fork_source"]["source_checkpoint_id"] == "ckpt_1"
    assert body["source"]["checkpoint_id"] == "ckpt_1"
    assert body["source"]["source_type"] == "latest_completed"
    source_messages = source_history_response.json()["list"]
    assert all("forkSource" not in item for item in source_messages)
    forked_messages = forked_history_response.json()["list"]
    marker_message = next(
        item
        for item in forked_messages
        if item["messageEventId"]
        == body["session"]["fork_source"]["target_message_event_id"]
    )
    assert marker_message["forkSource"]["source_session_id"] == "ses_source"


def test_session_context_compression_api_returns_manual_result(tmp_path, monkeypatch) -> None:
    app = create_app(AppSettings(data_dir=tmp_path / "data"))
    app.state.checkpointer = object()

    class FakeAgentRunner:
        def model_http_transport(self):
            return None

    app.state.agent_runner = FakeAgentRunner()

    async def fake_compress(self, *, session_id: str):
        return ManualContextCompressionResult(
            success=True,
            session_id=session_id,
            active_session_id="ses_source",
            notice_id="context-compression:manual:ses_source:test",
            context_compression_epoch=1,
            compression_message_count=4,
            total_message_count=4,
        )

    monkeypatch.setattr(sessions_api.ManualContextCompressionService, "compress", fake_compress)

    with TestClient(app) as client:
        response = client.post("/api/sessions/ses_source/context-compression", json={})

    assert response.status_code == 200
    assert response.json() == {
        "success": True,
        "session_id": "ses_source",
        "active_session_id": "ses_source",
        "notice_id": "context-compression:manual:ses_source:test",
        "reason": None,
        "context_compression_epoch": 1,
        "compression_message_count": 4,
        "total_message_count": 4,
    }


def test_session_fork_api_can_create_tagged_branch_outside_default_list(tmp_path) -> None:
    app = create_app(AppSettings(data_dir=tmp_path / "data"))
    _prepare_source(app)

    with TestClient(app) as client:
        response = client.post(
            "/api/sessions/ses_source/fork",
            json={"title": "临时分支", "session_tag": "btw"},
        )
        forked_session_id = response.json()["session"]["id"]
        forked_history = client.get(
            f"/api/sessions/{forked_session_id}/history?all_turns=true"
        )
        default_list = client.get("/api/sessions")
        tagged_list = client.get("/api/sessions", params={"session_tag": "btw"})

    assert response.status_code == 200
    forked_session = response.json()["session"]
    assert forked_session["session_tag"] == "btw"
    assert forked_session["fork_source"] is None
    assert response.json()["source"]["source_type"] == "latest_checkpoint"
    assert response.json()["source"]["message_event_id"] is None
    assert forked_history.json()["list"] == []
    assert [item["id"] for item in default_list.json()["list"]] == ["ses_source"]
    assert [item["id"] for item in tagged_list.json()["list"]] == [forked_session["id"]]


def test_session_reverse_api_rolls_back_same_session(tmp_path) -> None:
    app = create_app(AppSettings(data_dir=tmp_path / "data"))
    _prepare_source(app)

    with TestClient(app) as client:
        response = client.post(
            "/api/sessions/ses_source/reverse",
            json={"message_event_id": "evt_user_1"},
        )
        source_response = client.get("/api/sessions/ses_source")
        history_response = client.get("/api/sessions/ses_source/history?all_turns=true")

    assert response.status_code == 200
    body = response.json()
    assert body["session"]["id"] == "ses_source"
    assert body["source"]["checkpoint_id"] is None
    assert body["source"]["message_event_id"] == "evt_user_1"
    assert source_response.json()["session"]["active_session_id"] == "ses_source"
    assert history_response.json()["list"] == []


def test_session_fork_api_rejects_failed_trace(tmp_path) -> None:
    app = create_app(AppSettings(data_dir=tmp_path / "data"))
    _prepare_source(app)
    repositories = app.state.repositories
    repositories.trace_records.create(
        trace_id="trace_failed",
        session_id="ses_source",
        active_session_id="ses_source",
        scene_id="desktop-agent",
        user_id="local-user",
        turn_index=2,
        root_node_id="root_2",
    )
    repositories.trace_records.finish("trace_failed", status="failed")

    with TestClient(app) as client:
        response = client.post(
            "/api/sessions/ses_source/fork",
            json={"trace_id": "trace_failed"},
        )

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "trace_not_completed"
