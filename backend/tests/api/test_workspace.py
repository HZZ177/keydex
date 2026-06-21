from fastapi.testclient import TestClient

from backend.app.core.config import AppSettings
from backend.app.main import create_app

PNG_BYTES = (
    b"\x89PNG\r\n\x1a\n"
    b"\x00\x00\x00\rIHDR"
    b"\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x06\x00\x00\x00\x1f\x15\xc4\x89"
    b"\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01"
    b"\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82"
)


def _client(tmp_path) -> TestClient:
    settings = AppSettings(data_dir=tmp_path / "data")
    return TestClient(create_app(settings))


def _create_workspace(client: TestClient, root) -> dict:
    return client.post(
        "/api/workspaces",
        json={"root_path": str(root), "name": root.name},
    ).json()["workspace"]


def _create_workspace_session(client: TestClient, workspace_id: str) -> dict:
    return client.post(
        "/api/sessions",
        json={"session_type": "workspace", "workspace_id": workspace_id},
    ).json()["session"]


def test_workspace_bound_tree_read_and_search(tmp_path) -> None:
    root = tmp_path / "workspace"
    src = root / "src"
    src.mkdir(parents=True)
    (src / "main.py").write_text("print('ok')\n", encoding="utf-8")
    (root / "README.md").write_text("# Hello\n", encoding="utf-8")

    with _client(tmp_path) as client:
        workspace = _create_workspace(client, root)
        tree_response = client.get(f"/api/workspaces/{workspace['id']}/tree")
        read_response = client.get(
            f"/api/workspaces/{workspace['id']}/read",
            params={"path": "README.md"},
        )
        search_response = client.get(
            f"/api/workspaces/{workspace['id']}/search",
            params={"q": "main"},
        )

    assert tree_response.status_code == 200
    assert [entry["path"] for entry in tree_response.json()["entries"]] == [
        "src",
        "README.md",
    ]
    assert read_response.status_code == 200
    assert read_response.json() == {
        "path": "README.md",
        "content": "# Hello\n",
        "encoding": "utf-8",
    }
    assert search_response.status_code == 200
    assert search_response.json()[0] == {
        "path": "src/main.py",
        "name": "main.py",
        "type": "file",
    }


def test_session_bound_workspace_tree_read_and_search(tmp_path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "note.md").write_text("session bound", encoding="utf-8")

    with _client(tmp_path) as client:
        workspace = _create_workspace(client, root)
        session = _create_workspace_session(client, workspace["id"])
        tree_response = client.get(f"/api/sessions/{session['id']}/workspace/tree")
        read_response = client.get(
            f"/api/sessions/{session['id']}/workspace/read",
            params={"path": "note.md"},
        )
        search_response = client.get(
            f"/api/sessions/{session['id']}/workspace/search",
            params={"q": "note"},
        )

    assert tree_response.status_code == 200
    assert tree_response.json()["entries"][0]["path"] == "note.md"
    assert read_response.status_code == 200
    assert read_response.json()["content"] == "session bound"
    assert search_response.status_code == 200
    assert search_response.json()[0]["path"] == "note.md"


def test_session_workspace_rejects_chat_session(tmp_path) -> None:
    with _client(tmp_path) as client:
        session = client.post("/api/sessions", json={"session_type": "chat"}).json()["session"]
        response = client.get(f"/api/sessions/{session['id']}/workspace/tree")

    assert response.status_code == 400
    assert response.json()["detail"]["code"] == "session_not_workspace"


def test_workspace_media_returns_image_data_url(tmp_path) -> None:
    root = tmp_path / "workspace"
    assets = root / "docs" / "assets"
    assets.mkdir(parents=True)
    (assets / "pixel.png").write_bytes(PNG_BYTES)

    with _client(tmp_path) as client:
        workspace = _create_workspace(client, root)
        response = client.get(
            f"/api/workspaces/{workspace['id']}/media",
            params={"path": "docs/assets/pixel.png"},
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["path"] == "docs/assets/pixel.png"
    assert payload["media_type"] == "image/png"
    assert payload["size"] == len(PNG_BYTES)
    assert payload["data_url"].startswith("data:image/png;base64,")


def test_workspace_media_rejects_non_images(tmp_path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "note.txt").write_text("not an image", encoding="utf-8")

    with _client(tmp_path) as client:
        workspace = _create_workspace(client, root)
        response = client.get(
            f"/api/workspaces/{workspace['id']}/media",
            params={"path": "note.txt"},
        )

    assert response.status_code == 415
    assert response.json()["detail"]["code"] == "workspace_unsupported_media"


def test_workspace_api_rejects_paths_outside_bound_root(tmp_path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    outside = tmp_path / "secret.txt"
    outside.write_text("secret", encoding="utf-8")

    with _client(tmp_path) as client:
        workspace = _create_workspace(client, root)
        response = client.get(
            f"/api/workspaces/{workspace['id']}/read",
            params={"path": "../secret.txt"},
        )

    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "workspace_path_forbidden"


def test_workspace_api_no_longer_accepts_arbitrary_root_parameter(tmp_path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()

    with _client(tmp_path) as client:
        response = client.get(
            "/api/workspace/read",
            params={"root": str(root), "path": "README.md"},
        )

    assert response.status_code == 404
