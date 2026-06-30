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
    main_path = src / "main.py"
    readme_path = root / "README.md"
    main_path.write_text("print('ok')\n", encoding="utf-8")
    readme_path.write_text("# Hello\n", encoding="utf-8")

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
        default_search_response = client.get(
            f"/api/workspaces/{workspace['id']}/search",
            params={"q": ""},
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
        "size": main_path.stat().st_size,
    }
    assert default_search_response.status_code == 200
    assert [entry["path"] for entry in default_search_response.json()[:2]] == [
        "src",
        "README.md",
    ]
    assert "size" not in default_search_response.json()[0]
    assert default_search_response.json()[1]["size"] == readme_path.stat().st_size


def test_workspace_subtree_returns_entries_map(tmp_path) -> None:
    root = tmp_path / "workspace"
    ui = root / "src" / "components" / "ui"
    ui.mkdir(parents=True)
    (root / "src" / "index.ts").write_text("export {}\n", encoding="utf-8")
    (ui / "Button.tsx").write_text("export const Button = () => null;\n", encoding="utf-8")

    with _client(tmp_path) as client:
        workspace = _create_workspace(client, root)
        response = client.get(
            f"/api/workspaces/{workspace['id']}/tree/subtree",
            params={"path": "src", "max_depth": 5, "max_dirs": 20, "max_entries": 50},
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["path"] == "src"
    assert payload["truncated"] is False
    assert payload["expanded_paths"] == [
        "src",
        "src/components",
        "src/components/ui",
    ]
    assert [entry["path"] for entry in payload["entries_by_path"]["src"]] == [
        "src/components",
        "src/index.ts",
    ]
    assert [entry["path"] for entry in payload["entries_by_path"]["src/components/ui"]] == [
        "src/components/ui/Button.tsx",
    ]


def test_workspace_subtree_respects_budget(tmp_path) -> None:
    root = tmp_path / "workspace"
    for name in ["alpha", "beta"]:
        directory = root / "src" / name
        directory.mkdir(parents=True)
        (directory / "note.txt").write_text("ok\n", encoding="utf-8")

    with _client(tmp_path) as client:
        workspace = _create_workspace(client, root)
        response = client.get(
            f"/api/workspaces/{workspace['id']}/tree/subtree",
            params={"path": "src", "max_depth": 5, "max_dirs": 1, "max_entries": 50},
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["truncated"] is True
    assert payload["truncated_reason"] == "max_dirs"
    assert payload["visited_dirs"] == 1
    assert payload["expanded_paths"] == ["src"]
    assert set(payload["entries_by_path"]) == {"src"}


def test_workspace_subtree_keeps_ignored_dirs_without_descending(tmp_path) -> None:
    root = tmp_path / "workspace"
    package = root / "src" / "node_modules" / "pkg"
    package.mkdir(parents=True)
    (package / "index.js").write_text("module.exports = {}\n", encoding="utf-8")
    (root / "src" / "app.ts").write_text("export {}\n", encoding="utf-8")

    with _client(tmp_path) as client:
        workspace = _create_workspace(client, root)
        response = client.get(
            f"/api/workspaces/{workspace['id']}/tree/subtree",
            params={"path": "src", "max_depth": 5, "max_dirs": 20, "max_entries": 50},
        )

    assert response.status_code == 200
    payload = response.json()
    assert "src/node_modules" in [entry["path"] for entry in payload["entries_by_path"]["src"]]
    assert "src/node_modules" not in payload["entries_by_path"]
    assert payload["truncated"] is False


def test_workspace_search_skips_generated_paths_but_includes_env_files(tmp_path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "src").mkdir()
    (root / "src" / "env_reader.py").write_text("print('safe')\n", encoding="utf-8")
    (root / "node_modules").mkdir()
    (root / "node_modules" / "env-package.js").write_text("ignored", encoding="utf-8")
    (root / ".venv").mkdir()
    (root / ".venv" / "env_tool.py").write_text("ignored", encoding="utf-8")
    (root / ".env").write_text("SECRET=ignored\n", encoding="utf-8")
    (root / ".env.local").write_text("SECRET=ignored\n", encoding="utf-8")

    with _client(tmp_path) as client:
        workspace = _create_workspace(client, root)
        response = client.get(
            f"/api/workspaces/{workspace['id']}/search",
            params={"q": "env", "limit": 20},
        )

    assert response.status_code == 200
    paths = [entry["path"] for entry in response.json()]
    assert "src/env_reader.py" in paths
    assert "node_modules/env-package.js" not in paths
    assert ".venv/env_tool.py" not in paths
    assert ".env" in paths
    assert ".env.local" in paths


def test_workspace_search_still_skips_remaining_sensitive_file_names(tmp_path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / ".npmrc").write_text("//registry.example/:_authToken=ignored\n", encoding="utf-8")
    (root / "id_rsa").write_text("PRIVATE KEY", encoding="utf-8")

    with _client(tmp_path) as client:
        workspace = _create_workspace(client, root)
        npmrc_response = client.get(
            f"/api/workspaces/{workspace['id']}/search",
            params={"q": "npmrc", "limit": 20},
        )
        key_response = client.get(
            f"/api/workspaces/{workspace['id']}/search",
            params={"q": "id_rsa", "limit": 20},
        )

    assert npmrc_response.status_code == 200
    assert key_response.status_code == 200
    assert ".npmrc" not in [entry["path"] for entry in npmrc_response.json()]
    assert "id_rsa" not in [entry["path"] for entry in key_response.json()]


def test_workspace_search_matches_only_entry_names_not_parent_paths(tmp_path) -> None:
    root = tmp_path / "workspace"
    (root / "backend" / "app" / "core").mkdir(parents=True)
    (root / "backend" / "app" / "core" / "config.py").write_text("VALUE = 1\n", encoding="utf-8")
    (root / "frontend").mkdir(parents=True)
    (root / "frontend" / "backend_notes.md").write_text("notes\n", encoding="utf-8")

    with _client(tmp_path) as client:
        workspace = _create_workspace(client, root)
        response = client.get(
            f"/api/workspaces/{workspace['id']}/search",
            params={"q": "backend", "limit": 20},
        )

    assert response.status_code == 200
    paths = [entry["path"] for entry in response.json()]
    assert "backend" in paths
    assert "frontend/backend_notes.md" in paths
    assert "backend/app" not in paths
    assert "backend/app/core/config.py" not in paths


def test_workspace_search_includes_image_file_suffixes(tmp_path) -> None:
    root = tmp_path / "workspace"
    assets = root / "docs" / "assets"
    assets.mkdir(parents=True)
    (assets / "pixel.png").write_bytes(PNG_BYTES)
    (assets / "cover.jpg").write_bytes(b"jpg")

    with _client(tmp_path) as client:
        workspace = _create_workspace(client, root)
        png_response = client.get(
            f"/api/workspaces/{workspace['id']}/search",
            params={"q": "png", "limit": 20},
        )
        dotted_response = client.get(
            f"/api/workspaces/{workspace['id']}/search",
            params={"q": ".png", "limit": 20},
        )
        jpg_response = client.get(
            f"/api/workspaces/{workspace['id']}/search",
            params={"q": "jpg", "limit": 20},
        )

    assert png_response.status_code == 200
    assert dotted_response.status_code == 200
    assert jpg_response.status_code == 200
    assert "docs/assets/pixel.png" in [entry["path"] for entry in png_response.json()]
    assert "docs/assets/pixel.png" in [entry["path"] for entry in dotted_response.json()]
    assert "docs/assets/cover.jpg" in [entry["path"] for entry in jpg_response.json()]


def test_workspace_search_includes_requested_binary_archive_and_pdf_suffixes(tmp_path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    expected_by_query = {
        "exe": "tool.exe",
        "jar": "plugin.jar",
        "zip": "bundle.zip",
        "tar": "source.tar",
        "gz": "dump.gz",
        "7z": "dataset.7z",
        "rar": "photos.rar",
        "pdf": "manual.pdf",
    }
    for path in expected_by_query.values():
        (root / path).write_bytes(b"binary")

    with _client(tmp_path) as client:
        workspace = _create_workspace(client, root)
        responses = {
            query: client.get(
                f"/api/workspaces/{workspace['id']}/search",
                params={"q": query, "limit": 20},
            )
            for query in expected_by_query
        }

    for query, response in responses.items():
        assert response.status_code == 200
        assert expected_by_query[query] in [entry["path"] for entry in response.json()]


def test_workspace_search_default_limit_returns_one_hundred_results(tmp_path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    for index in range(105):
        (root / f"match-{index:02d}.txt").write_text("x", encoding="utf-8")

    with _client(tmp_path) as client:
        workspace = _create_workspace(client, root)
        response = client.get(
            f"/api/workspaces/{workspace['id']}/search",
            params={"q": "match"},
        )

    assert response.status_code == 200
    assert len(response.json()) == 100


def test_workspace_search_uses_bundled_ripgrep_without_system_path(tmp_path, monkeypatch) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "note.md").write_text("ok", encoding="utf-8")
    monkeypatch.setenv("PATH", "")

    with _client(tmp_path) as client:
        workspace = _create_workspace(client, root)
        response = client.get(
            f"/api/workspaces/{workspace['id']}/search",
            params={"q": "note"},
        )

    assert response.status_code == 200
    assert response.json()[0]["path"] == "note.md"


def test_workspace_search_fails_fast_when_ripgrep_is_missing(tmp_path, monkeypatch) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "note.md").write_text("ok", encoding="utf-8")
    monkeypatch.setattr("backend.app.api.workspace.resolve_ripgrep_binary", lambda: None)

    with _client(tmp_path) as client:
        workspace = _create_workspace(client, root)
        response = client.get(
            f"/api/workspaces/{workspace['id']}/search",
            params={"q": "note"},
        )

    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "workspace_search_engine_unavailable"


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
