from __future__ import annotations

from fastapi.testclient import TestClient

from backend.app.agent.checkpoint import SQLiteCheckpointSaver
from backend.app.core.config import AppSettings
from backend.app.main import create_app


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
            json={"trace_id": "trace_1", "title": "API 分支"},
        )

    assert response.status_code == 200
    body = response.json()
    assert body["session"]["id"] != "ses_source"
    assert body["session"]["title"] == "API 分支"
    assert body["session"]["parent_session_id"] == "ses_source"
    assert body["session"]["source_trace_id"] == "trace_1"
    assert body["session"]["source_checkpoint_id"] == "ckpt_1"
    assert body["source"]["checkpoint_id"] == "ckpt_1"


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
