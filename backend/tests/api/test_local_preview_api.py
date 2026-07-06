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
    return TestClient(create_app(AppSettings(data_dir=tmp_path / "data")))


def test_read_local_preview_file_from_outside_workspace(tmp_path) -> None:
    target = tmp_path / "outside" / "notes.md"
    target.parent.mkdir()
    target.write_text("# Local notes\n\nPreview me.\n", encoding="utf-8")

    with _client(tmp_path) as client:
        response = client.get("/api/local-preview/read", params={"path": str(target)})

    assert response.status_code == 200
    assert response.json() == {
        "path": str(target.resolve()),
        "content": "# Local notes\n\nPreview me.\n",
        "encoding": "utf-8",
    }


def test_read_local_preview_missing_file_returns_structured_error(tmp_path) -> None:
    target = tmp_path / "missing.md"

    with _client(tmp_path) as client:
        response = client.get("/api/local-preview/read", params={"path": str(target)})

    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "local_preview_path_not_found"


def test_read_local_preview_text_rejects_large_files(tmp_path) -> None:
    target = tmp_path / "large.md"
    target.write_bytes(b"x" * (512 * 1024 + 1))

    with _client(tmp_path) as client:
        response = client.get("/api/local-preview/read", params={"path": str(target)})

    assert response.status_code == 413
    assert response.json()["detail"]["code"] == "local_preview_file_too_large"


def test_read_local_preview_media_returns_data_url(tmp_path) -> None:
    target = tmp_path / "pixel.png"
    target.write_bytes(PNG_BYTES)

    with _client(tmp_path) as client:
        response = client.get("/api/local-preview/media", params={"path": str(target)})

    assert response.status_code == 200
    body = response.json()
    assert body["path"] == str(target.resolve())
    assert body["media_type"] == "image/png"
    assert body["size"] == len(PNG_BYTES)
    assert body["data_url"].startswith("data:image/png;base64,")
