from __future__ import annotations

from fastapi.testclient import TestClient

from backend.app.core.config import AppSettings
from backend.app.main import create_app


def test_file_history_settings_update_live_service_and_health_capability(tmp_path) -> None:
    client = TestClient(create_app(AppSettings(data_dir=tmp_path / "data")))

    initial = client.get("/api/settings")
    assert initial.status_code == 200
    assert initial.json()["general"]["file_history_enabled"] is True

    response = client.put(
        "/api/settings",
        json={
            "general": {
                "close_window_behavior": None,
                "conversation_send_default_mode": "steer",
                "file_history_enabled": False,
                "file_history_max_storage_bytes": 4096,
                "file_history_max_versions_per_file": 12,
                "file_history_max_rewind_points": 40,
                "file_history_retention_days": 45,
            }
        },
    )

    assert response.status_code == 200
    service = client.app.state.file_history_service
    assert service.enabled is False
    assert service.max_storage_bytes == 4096
    assert service.max_versions_per_file == 12
    assert service.max_rewind_points == 40
    assert service.retention_days == 45
    health = client.get("/api/health").json()
    assert health["file_history_enabled"] is False
    assert "file_history_rewind" in health["capabilities"]


def test_disabled_file_history_fails_preview_explicitly_without_fallback(tmp_path) -> None:
    project = tmp_path / "project"
    project.mkdir()
    client = TestClient(
        create_app(
            AppSettings(
                data_dir=tmp_path / "data",
                file_history_enabled=False,
            )
        )
    )
    workspace = client.post(
        "/api/workspaces",
        json={"root_path": str(project), "name": "project"},
    ).json()["workspace"]
    session = client.post(
        "/api/sessions",
        json={"session_type": "workspace", "workspace_id": workspace["id"]},
    ).json()["session"]
    repositories = client.app.state.repositories
    repositories.trace_records.create(
        trace_id="trace-1",
        session_id=session["id"],
        active_session_id=session["id"],
        scene_id="desktop-agent",
        user_id="local-user",
        turn_index=1,
        root_node_id="trace-root",
        input_checkpoint_id=None,
        input_checkpoint_ns="",
        status="completed",
    )
    repositories.message_events.append(
        event_id="message-1",
        session_id=session["id"],
        trace_record_id="trace-1",
        turn_index=1,
        action="user_message",
        data={"content": "rewind"},
    )

    response = client.post(
        f"/api/sessions/{session['id']}/reverse/preview",
        json={"message_event_id": "message-1"},
    )

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "file_history_disabled"
