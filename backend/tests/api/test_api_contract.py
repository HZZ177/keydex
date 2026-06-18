from __future__ import annotations

from fastapi.testclient import TestClient

from backend.app.core.config import AppSettings
from backend.app.main import create_app


def test_create_app_exposes_desktop_session_ws_and_model_contract(tmp_path) -> None:
    client = TestClient(create_app(AppSettings(data_dir=tmp_path / "data")))

    assert client.get("/api/health").status_code == 200
    assert client.get("/api/settings").status_code == 200
    assert client.get("/api/models").status_code == 200
    assert client.get("/api/model-providers").status_code == 200
    created = client.post("/api/sessions", json={"title": "合同测试"})
    session_id = created.json()["session"]["id"]
    assert created.status_code == 200
    assert client.get(f"/api/sessions/{session_id}/history").status_code == 200

    with client.websocket_connect("/agent-base/ws/chat") as ws:
        ws.send_json({"action": "ping"})
        assert ws.receive_json()["action"] == "pong"


def test_legacy_thread_turn_api_paths_are_not_exposed(tmp_path) -> None:
    client = TestClient(create_app(AppSettings(data_dir=tmp_path / "data")))

    threads = client.get("/api/threads")
    turns = client.post("/api/turns", json={})

    assert threads.status_code == 404
    assert turns.status_code == 404
