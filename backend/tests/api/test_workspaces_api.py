from __future__ import annotations

from fastapi.testclient import TestClient

from backend.app.core.config import AppSettings
from backend.app.main import create_app


def _client(tmp_path) -> TestClient:
    return TestClient(create_app(AppSettings(data_dir=tmp_path / "data")))


def test_workspaces_api_creates_lists_updates_and_archives(tmp_path) -> None:
    project = tmp_path / "project"
    project.mkdir()

    with _client(tmp_path) as client:
        created = client.post(
            "/api/workspaces",
            json={"root_path": str(project), "name": "项目"},
        )
        workspace = created.json()["workspace"]
        duplicated = client.post(
            "/api/workspaces",
            json={"root_path": str(project / "."), "name": "重复"},
        )
        listed = client.get("/api/workspaces")
        renamed = client.patch(f"/api/workspaces/{workspace['id']}", json={"name": "新项目"})
        touched = client.patch(f"/api/workspaces/{workspace['id']}", json={"touch": True})
        archived = client.post(
            f"/api/workspaces/{workspace['id']}/archive",
            json={"request_id": "req-workspace-api-archive", "stop_active_sessions": False},
        )
        listed_after_archive = client.get("/api/workspaces")
        detail_after_archive = client.get(f"/api/workspaces/{workspace['id']}")

    assert created.status_code == 200
    assert workspace["name"] == "项目"
    assert workspace["root_path"] == str(project.resolve())
    assert duplicated.status_code == 200
    assert duplicated.json()["workspace"]["id"] == workspace["id"]
    assert listed.status_code == 200
    assert listed.json()["total"] == 1
    assert renamed.status_code == 200
    assert renamed.json()["workspace"]["name"] == "新项目"
    assert touched.status_code == 200
    assert touched.json()["workspace"]["last_opened_at"] is not None
    assert archived.status_code == 200
    assert archived.json()["workspace_id"] == workspace["id"]
    assert listed_after_archive.json()["total"] == 0
    assert detail_after_archive.status_code == 409
    assert detail_after_archive.json()["detail"]["code"] == "workspace_archived"


def test_workspaces_api_returns_clear_errors_for_invalid_paths(tmp_path) -> None:
    file_path = tmp_path / "file.txt"
    file_path.write_text("x", encoding="utf-8")

    with _client(tmp_path) as client:
        missing = client.post(
            "/api/workspaces",
            json={"root_path": str(tmp_path / "missing")},
        )
        not_directory = client.post(
            "/api/workspaces",
            json={"root_path": str(file_path)},
        )
        empty_name = client.patch("/api/workspaces/missing", json={"name": " "})

    assert missing.status_code == 404
    assert missing.json()["detail"]["code"] == "workspace_path_not_found"
    assert not_directory.status_code == 400
    assert not_directory.json()["detail"]["code"] == "workspace_not_directory"
    assert empty_name.status_code == 400
    assert empty_name.json()["detail"]["code"] == "workspace_name_empty"


def test_workspaces_api_returns_404_for_missing_workspace(tmp_path) -> None:
    with _client(tmp_path) as client:
        detail = client.get("/api/workspaces/missing")
        rename = client.patch("/api/workspaces/missing", json={"name": "新名称"})
        legacy_delete = client.delete("/api/workspaces/missing")

    assert detail.status_code == 404
    assert detail.json()["detail"]["code"] == "workspace_not_found"
    assert rename.status_code == 404
    assert legacy_delete.status_code == 405
