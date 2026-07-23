from urllib.parse import urljoin

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


def test_local_html_preview_serves_nested_pages_from_their_real_directory(tmp_path) -> None:
    workspace = tmp_path / "workspace"
    prototype = workspace / ".ktaicoding" / "prototype" / "A2UI"
    assets = workspace / ".ktaicoding" / "prototype" / "assets"
    prototype.mkdir(parents=True)
    assets.mkdir(parents=True)
    index = prototype / "index.html"
    child = prototype / "prototype-subpage.html"
    stylesheet = assets / "theme.css"
    index.write_text('<iframe src="prototype-subpage.html"></iframe>', encoding="utf-8")
    child.write_text('<link rel="stylesheet" href="../assets/theme.css">子页面', encoding="utf-8")
    stylesheet.write_text("body { color: red; }", encoding="utf-8")

    with _client(tmp_path) as client:
        registered = client.post(
            "/api/local-preview/html/register",
            json={"path": str(index), "scope_path": str(workspace)},
        )
        assert registered.status_code == 200
        preview_url = registered.json()["url"]
        index_response = client.get(preview_url)
        child_response = client.get(urljoin(preview_url, "prototype-subpage.html"))
        stylesheet_response = client.get(urljoin(preview_url, "../assets/theme.css"))

    assert registered.json()["path"] == str(index.resolve())
    assert index_response.status_code == 200
    assert index_response.headers["content-type"].startswith("text/html")
    assert index_response.text.startswith('<iframe src="prototype-subpage.html"></iframe>')
    assert "data-keydex-preview-viewport-bridge" in index_response.text
    assert "keydex:html-preview-viewport-state/v1" in index_response.text
    assert child_response.status_code == 200
    assert child_response.text.startswith('<link rel="stylesheet" href="../assets/theme.css">子页面')
    assert "data-keydex-preview-viewport-bridge" in child_response.text
    assert stylesheet_response.status_code == 200
    assert stylesheet_response.text == "body { color: red; }"
    assert index_response.headers["cache-control"] == "no-store"


def test_local_html_preview_rejects_files_outside_the_registered_scope(tmp_path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    outside = tmp_path / "outside.html"
    outside.write_text("<main>outside</main>", encoding="utf-8")

    with _client(tmp_path) as client:
        response = client.post(
            "/api/local-preview/html/register",
            json={"path": str(outside), "scope_path": str(workspace)},
        )

    assert response.status_code == 403
    assert response.json()["detail"]["code"] == "local_preview_outside_scope"


def test_local_html_content_preview_serves_executable_content_from_an_isolated_url(
    tmp_path,
) -> None:
    html = (
        "<main>HTML 内容预览</main>"
        "<script>document.body.dataset.ready = 'true'</script>"
    )

    with _client(tmp_path) as client:
        registered = client.post(
            "/api/local-preview/html/content/register",
            json={"content": html},
        )
        assert registered.status_code == 200
        preview = client.get(registered.json()["url"])

    assert preview.status_code == 200
    assert preview.headers["content-type"].startswith("text/html")
    assert preview.headers["cache-control"] == "no-store"
    assert preview.headers["referrer-policy"] == "no-referrer"
    assert preview.headers["x-content-type-options"] == "nosniff"
    assert html in preview.text
    assert "data-keydex-preview-viewport-bridge" in preview.text


def test_local_html_content_preview_rejects_oversized_content(tmp_path) -> None:
    with _client(tmp_path) as client:
        response = client.post(
            "/api/local-preview/html/content/register",
            json={"content": "界" * (512 * 1024)},
        )

    assert response.status_code == 413
    assert response.json()["detail"]["code"] == "local_preview_html_content_too_large"
