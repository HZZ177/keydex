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


def test_workspace_tree_read_and_search(tmp_path) -> None:
    root = tmp_path / "workspace"
    src = root / "src"
    src.mkdir(parents=True)
    (src / "main.py").write_text("print('ok')\n", encoding="utf-8")
    (root / "README.md").write_text("# Hello\n", encoding="utf-8")

    with _client(tmp_path) as client:
        tree_response = client.get("/api/workspace/tree", params={"root": str(root), "path": ""})
        assert tree_response.status_code == 200
        entries = tree_response.json()["entries"]
        assert [entry["path"] for entry in entries] == ["src", "README.md"]

        read_response = client.get(
            "/api/workspace/read",
            params={"root": str(root), "path": "README.md"},
        )
        assert read_response.status_code == 200
        assert read_response.json() == {
            "path": "README.md",
            "content": "# Hello\n",
            "encoding": "utf-8",
        }

        search_response = client.get(
            "/api/workspace/search",
            params={"root": str(root), "q": "main"},
        )
        assert search_response.status_code == 200
        assert search_response.json()[0] == {
            "path": "src/main.py",
            "name": "main.py",
            "type": "file",
        }


def test_workspace_media_returns_image_data_url(tmp_path) -> None:
    root = tmp_path / "workspace"
    assets = root / "docs" / "assets"
    assets.mkdir(parents=True)
    (assets / "pixel.png").write_bytes(PNG_BYTES)

    with _client(tmp_path) as client:
        response = client.get(
            "/api/workspace/media",
            params={"root": str(root), "path": "docs/assets/pixel.png"},
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
        response = client.get(
            "/api/workspace/media",
            params={"root": str(root), "path": "note.txt"},
        )

    assert response.status_code == 415
    assert response.json()["detail"]["code"] == "workspace_unsupported_media"


def test_workspace_api_rejects_paths_outside_root(tmp_path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    outside = tmp_path / "secret.txt"
    outside.write_text("secret", encoding="utf-8")

    with _client(tmp_path) as client:
        response = client.get(
            "/api/workspace/read",
            params={"root": str(root), "path": "../secret.txt"},
        )

    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "workspace_path_forbidden"


def test_workspace_media_rejects_paths_outside_root(tmp_path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    outside = tmp_path / "secret.png"
    outside.write_bytes(PNG_BYTES)

    with _client(tmp_path) as client:
        response = client.get(
            "/api/workspace/media",
            params={"root": str(root), "path": "../secret.png"},
        )

    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "workspace_path_forbidden"
