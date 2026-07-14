from __future__ import annotations

from fastapi.testclient import TestClient

from backend.app.core.config import AppSettings
from backend.app.main import create_app


class _EventPublisher:
    def __init__(self) -> None:
        self.events: list[dict] = []

    def publish(self, event: dict) -> None:
        self.events.append(event)


def _app(tmp_path):
    app = create_app(AppSettings(data_dir=tmp_path / "data"))
    app.state.lifecycle_event_publisher = _EventPublisher()
    return app


def test_session_archive_restore_and_catalog_api_contract(tmp_path) -> None:
    app = _app(tmp_path)
    with TestClient(app) as client:
        created = client.post("/api/sessions", json={"title": "归档会话"}).json()["session"]
        archived = client.post(
            f"/api/sessions/{created['id']}/archive",
            json={"request_id": "req-api-archive"},
        )
        replay = client.post(
            f"/api/sessions/{created['id']}/archive",
            json={"request_id": "req-api-archive"},
        )
        catalog = client.get("/api/archive/sessions")
        restored = client.post(
            f"/api/sessions/{created['id']}/restore",
            json={"request_id": "req-api-restore"},
        )
        catalog_after = client.get("/api/archive/sessions")

    assert archived.status_code == 200
    assert archived.json()["changed"] is True
    assert archived.json()["archive_origin"] == "manual"
    assert "is_deleted" not in archived.text
    assert replay.status_code == 200
    assert replay.json()["replayed"] is True
    assert replay.json()["event"] is None
    assert [item["id"] for item in catalog.json()["items"]] == [created["id"]]
    assert restored.status_code == 200
    assert restored.json()["changed"] is True
    assert catalog_after.json()["items"] == []
    assert [event["type"] for event in app.state.lifecycle_event_publisher.events] == [
        "session_archived",
        "session_restored",
    ]


def test_session_archive_blocker_response_is_safe_and_confirmation_stops(tmp_path) -> None:
    app = _app(tmp_path)
    repositories = app.state.repositories
    session = repositories.sessions.create(
        session_id="ses-api-running",
        user_id="local-user",
        scene_id="desktop-agent",
        title="Running",
        status="running",
    )
    repositories.pending_inputs.create_or_get(
        session_id=session.id,
        message="secret pending content",
        mode="queue",
    )

    with TestClient(app) as client:
        blocked = client.post(
            f"/api/sessions/{session.id}/archive",
            json={"request_id": "req-api-blocked"},
        )
        confirmed = client.post(
            f"/api/sessions/{session.id}/archive",
            json={"request_id": "req-api-confirmed", "stop_if_active": True},
        )

    assert blocked.status_code == 409
    assert blocked.json()["detail"]["code"] == "archive_requires_stop_confirmation"
    assert blocked.json()["detail"]["details"]["blocker_count"] >= 1
    assert {
        item["type"] for item in blocked.json()["detail"]["details"]["blockers"]
    } >= {"pending_input"}
    assert "secret pending content" not in blocked.text
    assert confirmed.status_code == 200
    assert confirmed.json()["changed"] is True


def test_session_restore_conflict_contains_workspace_navigation_schema(tmp_path) -> None:
    project = tmp_path / "project-conflict"
    project.mkdir()
    app = _app(tmp_path)
    with TestClient(app) as client:
        workspace = client.post(
            "/api/workspaces",
            json={"root_path": str(project), "name": "冲突项目"},
        ).json()["workspace"]
        session = client.post(
            "/api/sessions",
            json={"session_type": "workspace", "workspace_id": workspace["id"]},
        ).json()["session"]
        client.post(
            f"/api/workspaces/{workspace['id']}/archive",
            json={"request_id": "req-api-workspace-archive"},
        )
        restored = client.post(
            f"/api/sessions/{session['id']}/restore",
            json={"request_id": "req-api-session-conflict"},
        )

    assert restored.status_code == 409
    detail = restored.json()["detail"]
    assert detail["code"] == "workspace_archived"
    assert detail["details"] == {
        "workspace_id": workspace["id"],
        "workspace_name": "冲突项目",
        "archived_at": detail["details"]["archived_at"],
        "session_id": session["id"],
        "archive_origin": "project",
    }
    assert str(project.resolve()) not in restored.text


def test_workspace_archive_and_two_explicit_restore_modes(tmp_path) -> None:
    project = tmp_path / "project-modes"
    project.mkdir()
    app = _app(tmp_path)
    with TestClient(app) as client:
        workspace = client.post(
            "/api/workspaces",
            json={"root_path": str(project), "name": "恢复项目"},
        ).json()["workspace"]
        session = client.post(
            "/api/sessions",
            json={"session_type": "workspace", "workspace_id": workspace["id"], "title": "目标归档会话"},
        ).json()["session"]
        archived = client.post(
            f"/api/workspaces/{workspace['id']}/archive",
            json={"request_id": "req-api-project-archive"},
        )
        project_only = client.post(
            f"/api/workspaces/{workspace['id']}/restore",
            json={"request_id": "req-api-project-only", "mode": "project_only"},
        )
        with_sessions = client.post(
            f"/api/workspaces/{workspace['id']}/restore",
            json={
                "request_id": "req-api-project-sessions",
                "mode": "with_project_sessions",
            },
        )
        invalid = client.post(
            f"/api/workspaces/{workspace['id']}/restore",
            json={"request_id": "req-api-mode-missing"},
        )

    assert archived.status_code == 200
    assert archived.json()["newly_archived"] == 1
    assert project_only.status_code == 200
    assert project_only.json()["remaining_project"] == 1
    assert with_sessions.status_code == 200
    assert with_sessions.json()["restored_project_sessions"] == 1
    assert app.state.repositories.sessions.get(session["id"]) is not None
    assert invalid.status_code == 422


def test_archive_catalog_cursor_validation_and_single_page_project_grouping(tmp_path) -> None:
    project = tmp_path / "project-catalog"
    project.mkdir()
    app = _app(tmp_path)
    with TestClient(app) as client:
        workspace = client.post(
            "/api/workspaces",
            json={"root_path": str(project), "name": "目录项目"},
        ).json()["workspace"]
        session = client.post(
            "/api/sessions",
            json={"session_type": "workspace", "workspace_id": workspace["id"], "title": "目标归档会话"},
        ).json()["session"]
        client.post(
            f"/api/workspaces/{workspace['id']}/archive",
            json={"request_id": "req-catalog-project"},
        )
        projects = client.get("/api/archive/workspaces")
        sessions = client.get("/api/archive/sessions")
        title_search = client.get("/api/archive/sessions", params={"query": "目标归档会话"})
        project_name_search = client.get("/api/archive/sessions", params={"query": "目录项目"})
        selected_projects = client.get(
            "/api/archive/sessions",
            params=[("workspace_id", workspace["id"]), ("workspace_id", "missing-workspace")],
        )
        expanded = client.get(f"/api/archive/workspaces/{workspace['id']}/sessions")
        invalid = client.get("/api/archive/sessions", params={"cursor": "bad-cursor"})

    assert projects.json()["items"][0]["id"] == workspace["id"]
    assert sessions.json()["items"][0]["id"] == session["id"]
    assert title_search.json()["items"][0]["id"] == session["id"]
    assert project_name_search.json()["items"] == []
    assert selected_projects.json()["items"][0]["id"] == session["id"]
    assert sessions.json()["items"][0]["workspace"] == {
        "id": workspace["id"],
        "name": "目录项目",
        "archived_at": projects.json()["items"][0]["archived_at"],
    }
    assert expanded.json()["items"][0]["id"] == session["id"]
    assert invalid.status_code == 422
    assert invalid.json()["detail"]["code"] == "archive_cursor_invalid"


def test_purge_api_confirmation_success_and_replay(tmp_path) -> None:
    app = _app(tmp_path)
    with TestClient(app) as client:
        session = client.post("/api/sessions", json={"title": "彻底删除"}).json()["session"]
        client.post(
            f"/api/sessions/{session['id']}/archive",
            json={"request_id": "req-before-purge"},
        )
        unconfirmed = client.post(
            f"/api/archive/sessions/{session['id']}/purge",
            json={"request_id": "req-purge-api", "confirmed": False},
        )
        purged = client.post(
            f"/api/archive/sessions/{session['id']}/purge",
            json={"request_id": "req-purge-api", "confirmed": True},
        )
        replay = client.post(
            f"/api/archive/sessions/{session['id']}/purge",
            json={"request_id": "req-purge-api", "confirmed": True},
        )

    assert unconfirmed.status_code == 422
    assert unconfirmed.json()["detail"]["code"] == "purge_confirmation_required"
    assert purged.status_code == 200
    assert purged.json()["state"] == "completed"
    assert replay.status_code == 200
    assert replay.json()["replayed"] is True


def test_workspace_sessions_purge_api_keeps_project_and_active_sessions(tmp_path) -> None:
    app = _app(tmp_path)
    project = tmp_path / "workspace-session-purge"
    project.mkdir()
    with TestClient(app) as client:
        workspace = client.post(
            "/api/workspaces",
            json={"root_path": str(project), "name": "批量清理项目"},
        ).json()["workspace"]
        active = client.post(
            "/api/sessions",
            json={
                "session_type": "workspace",
                "workspace_id": workspace["id"],
                "title": "活动会话",
            },
        ).json()["session"]
        archived = client.post(
            "/api/sessions",
            json={
                "session_type": "workspace",
                "workspace_id": workspace["id"],
                "title": "归档会话",
            },
        ).json()["session"]
        client.post(
            f"/api/sessions/{archived['id']}/archive",
            json={"request_id": "req-archive-before-workspace-session-purge"},
        )
        mismatch = client.post(
            f"/api/archive/workspaces/{workspace['id']}/sessions/purge",
            json={
                "request_id": "req-workspace-session-purge-mismatch",
                "confirmation_name": "错误名称",
            },
        )
        purged = client.post(
            f"/api/archive/workspaces/{workspace['id']}/sessions/purge",
            json={"request_id": "req-workspace-session-purge", "confirmation_name": "批量清理项目"},
        )

    assert mismatch.status_code == 422
    assert mismatch.json()["detail"]["code"] == "confirmation_mismatch"
    assert purged.status_code == 200
    assert purged.json()["entity_type"] == "workspace_sessions"
    assert purged.json()["counts"]["sessions"] == 1
    assert purged.json()["event"]["type"] == "workspace_sessions_purged"
    assert app.state.repositories.workspaces.get(workspace["id"]) is not None
    assert app.state.repositories.sessions.get(active["id"]) is not None
    assert app.state.repositories.sessions.get_archived(archived["id"]) is None


def test_legacy_delete_and_patch_archived_contracts_are_absent(tmp_path) -> None:
    app = _app(tmp_path)
    project = tmp_path / "legacy-project"
    project.mkdir()
    with TestClient(app) as client:
        session = client.post("/api/sessions", json={"title": "Legacy"}).json()["session"]
        workspace = client.post(
            "/api/workspaces",
            json={"root_path": str(project), "name": "Legacy project"},
        ).json()["workspace"]
        delete = client.delete(f"/api/sessions/{session['id']}")
        delete_workspace = client.delete(f"/api/workspaces/{workspace['id']}")
        patch_true = client.patch(
            f"/api/sessions/{session['id']}",
            json={"archived": True},
        )
        patch_false = client.patch(
            f"/api/sessions/{session['id']}",
            json={"archived": False},
        )
        schema = client.get("/openapi.json").json()

    assert delete.status_code == 405
    assert delete_workspace.status_code == 405
    assert patch_true.status_code == 422
    assert patch_false.status_code == 422
    assert app.state.repositories.sessions.get(session["id"]) is not None
    assert app.state.repositories.workspaces.get(workspace["id"]) is not None
    assert "delete" not in schema["paths"]["/api/sessions/{session_id}"]
    assert "delete" not in schema["paths"]["/api/workspaces/{workspace_id}"]
    update_schema = schema["components"]["schemas"]["UpdateSessionRequest"]
    assert "archived" not in update_schema["properties"]
    assert "/api/sessions/{session_id}/archive" in schema["paths"]
    assert "/api/workspaces/{workspace_id}/restore" in schema["paths"]


def test_lifecycle_openapi_declares_typed_dtos_errors_and_enums(tmp_path) -> None:
    app = _app(tmp_path)
    schema = app.openapi()

    restore = schema["paths"]["/api/workspaces/{workspace_id}/restore"]["post"]
    assert set(restore["responses"]) >= {"200", "404", "409", "422"}
    request_schema = schema["components"]["schemas"]["RestoreWorkspaceRequest"]
    mode_ref = request_schema["properties"]["mode"]["$ref"]
    mode_schema = schema["components"]["schemas"][mode_ref.rsplit("/", 1)[-1]]
    assert mode_schema["enum"] == ["project_only", "with_project_sessions"]

    error_response = restore["responses"]["409"]["content"]["application/json"]["schema"]
    error_name = error_response["$ref"].rsplit("/", 1)[-1]
    detail_ref = schema["components"]["schemas"][error_name]["properties"]["detail"]["$ref"]
    detail_name = detail_ref.rsplit("/", 1)[-1]
    assert set(schema["components"]["schemas"][detail_name]["required"]) == {
        "code",
        "message",
        "details",
        "retryable",
    }
    assert "delete" not in schema["paths"]["/api/workspaces/{workspace_id}"]
