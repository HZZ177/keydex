from fastapi.testclient import TestClient

from backend.app.annotations.service import document_revision
from backend.app.core.config import AppSettings
from backend.app.main import create_app


def _client(tmp_path) -> TestClient:
    settings = AppSettings(data_dir=tmp_path / "data")
    return TestClient(create_app(settings))


def _create_workspace(client: TestClient, root) -> dict:
    return client.post(
        "/api/workspaces",
        json={"root_path": str(root), "name": root.name},
    ).json()["workspace"]


def _selector(path, **overrides) -> dict:
    selector = {
        "position": {"start": 0, "end": 5},
        "quote": {"exact": "hello", "prefix": "", "suffix": " world"},
        "context": {"containerType": "paragraph", "headingPath": []},
        "textRevision": "logical:1",
        "documentRevision": document_revision(path),
    }
    selector.update(overrides)
    return selector


def test_workspace_annotation_crud_uses_single_target_contract(tmp_path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    document = root / "README.md"
    document.write_text("hello world\n", encoding="utf-8")

    with _client(tmp_path) as client:
        workspace = _create_workspace(client, root)
        endpoint = f"/api/workspaces/{workspace['id']}/annotations"

        create_document = client.post(
            endpoint,
            json={
                "path": "README.md",
                "body": "Document note",
                "target": {"type": "document"},
            },
        )
        create_text = client.post(
            endpoint,
            json={
                "path": "README.md",
                "body": "Text note",
                "target": {"type": "text", "selector": _selector(document)},
            },
        )
        annotation_id = create_document.json()["id"]
        listed = client.get(endpoint, params={"path": "README.md"})
        patched = client.patch(
            f"{endpoint}/{annotation_id}",
            json={"body": "Updated document note"},
        )
        retargeted = client.put(
            f"{endpoint}/{annotation_id}/target",
            json={"target": {"type": "text", "selector": _selector(document)}},
        )
        deleted = client.delete(f"{endpoint}/{annotation_id}")
        listed_after_delete = client.get(endpoint, params={"path": "README.md"})

    assert create_document.status_code == 201
    assert create_document.json()["target"] == {"type": "document"}
    assert create_document.json()["document_path"] == "README.md"
    assert create_text.status_code == 201
    assert create_text.json()["target"]["selector"]["documentRevision"].startswith("sha256:")
    assert listed.status_code == 200
    assert [item["body"] for item in listed.json()] == ["Document note", "Text note"]
    assert patched.status_code == 200
    assert patched.json()["body"] == "Updated document note"
    assert patched.json()["target"] == {"type": "document"}
    assert retargeted.status_code == 200
    assert retargeted.json()["target"]["type"] == "text"
    assert deleted.status_code == 204
    assert [item["id"] for item in listed_after_delete.json()] == [create_text.json()["id"]]


def test_patch_cannot_modify_target_and_put_requires_complete_text_target(tmp_path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    document = root / "note.md"
    document.write_text("hello world", encoding="utf-8")

    with _client(tmp_path) as client:
        workspace = _create_workspace(client, root)
        endpoint = f"/api/workspaces/{workspace['id']}/annotations"
        created = client.post(
            endpoint,
            json={"path": "note.md", "body": "Note", "target": {"type": "document"}},
        ).json()
        patch_target = client.patch(
            f"{endpoint}/{created['id']}",
            json={"body": "Changed", "target": {"type": "document"}},
        )
        incomplete_target = client.put(
            f"{endpoint}/{created['id']}/target",
            json={"target": {"type": "text"}},
        )

    assert patch_target.status_code == 422
    assert incomplete_target.status_code == 422


def test_text_create_and_retarget_reject_stale_document_revision(tmp_path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    document = root / "note.md"
    document.write_text("hello world", encoding="utf-8")

    with _client(tmp_path) as client:
        workspace = _create_workspace(client, root)
        endpoint = f"/api/workspaces/{workspace['id']}/annotations"
        stale_selector = _selector(document, documentRevision="sha256:stale")
        stale_create = client.post(
            endpoint,
            json={
                "path": "note.md",
                "body": "Note",
                "target": {"type": "text", "selector": stale_selector},
            },
        )
        created = client.post(
            endpoint,
            json={"path": "note.md", "body": "Note", "target": {"type": "document"}},
        ).json()
        stale_retarget = client.put(
            f"{endpoint}/{created['id']}/target",
            json={"target": {"type": "text", "selector": stale_selector}},
        )

    assert stale_create.status_code == 409
    assert stale_create.json()["detail"]["code"] == "annotation_document_changed"
    assert stale_retarget.status_code == 409
    assert stale_retarget.json()["detail"]["code"] == "annotation_document_changed"


def test_annotation_api_returns_stable_not_found_and_path_errors(tmp_path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "note.md").write_text("hello", encoding="utf-8")

    with _client(tmp_path) as client:
        workspace = _create_workspace(client, root)
        endpoint = f"/api/workspaces/{workspace['id']}/annotations"
        missing_workspace = client.get(
            "/api/workspaces/missing/annotations",
            params={"path": "note.md"},
        )
        missing_path = client.get(endpoint, params={"path": "missing.md"})
        forbidden_path = client.get(endpoint, params={"path": "../secret.md"})
        missing_annotation = client.patch(
            f"{endpoint}/missing",
            json={"body": "Changed"},
        )

    assert missing_workspace.status_code == 404
    assert missing_workspace.json()["detail"]["code"] == "workspace_not_found"
    assert missing_path.status_code == 404
    assert missing_path.json()["detail"]["code"] == "annotation_path_not_found"
    assert forbidden_path.status_code == 403
    assert forbidden_path.json()["detail"]["code"] == "annotation_path_forbidden"
    assert missing_annotation.status_code == 404
    assert missing_annotation.json()["detail"]["code"] == "annotation_not_found"


def test_old_session_annotation_api_is_absent(tmp_path) -> None:
    with _client(tmp_path) as client:
        response = client.get(
            "/api/sessions/legacy/workspace/annotations",
            params={"path": "README.md"},
        )

    assert response.status_code == 404
