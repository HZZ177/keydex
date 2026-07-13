from __future__ import annotations

import asyncio
import hashlib
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi.testclient import TestClient

from backend.app.api.document_read import (
    DocumentReadRequest,
    DocumentReadSnapshot,
    DocumentReadSource,
    stream_document_read_messages,
)
from backend.app.api.workspace import _read_document_snapshot
from backend.app.core.config import AppSettings
from backend.app.main import create_app


def _client(tmp_path: Path) -> TestClient:
    return TestClient(create_app(AppSettings(data_dir=tmp_path / "data")))


def _create_workspace(client: TestClient, root: Path) -> dict[str, Any]:
    response = client.post(
        "/api/workspaces",
        json={"root_path": str(root), "name": root.name},
    )
    assert response.status_code == 200
    return response.json()["workspace"]


def _payload(path: str, **overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "request_id": "request-1",
        "document_id": f"workspace:{path}",
        "source": "workspace",
        "path": path,
        "chunk_size_bytes": 1024 * 1024,
    }
    payload.update(overrides)
    return payload


def _messages(response) -> list[dict[str, Any]]:
    assert response.headers["content-type"].startswith("application/x-ndjson")
    return [json.loads(line) for line in response.text.splitlines()]


def _reconstruct(messages: list[dict[str, Any]]) -> bytes:
    return "".join(
        message["content"] for message in messages if message["type"] == "chunk"
    ).encode("utf-8")


@pytest.mark.parametrize("size", [1024 * 1024, 5 * 1024 * 1024, 10 * 1024 * 1024])
def test_workspace_document_endpoint_reads_large_markdown(tmp_path: Path, size: int) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    data = (b"# block\n" * ((size // 8) + 1))[:size]
    (root / "large.md").write_bytes(data)

    with _client(tmp_path) as client:
        workspace = _create_workspace(client, root)
        response = client.post(
            f"/api/workspaces/{workspace['id']}/read/document",
            json=_payload("large.md"),
        )

    assert response.status_code == 200
    messages = _messages(response)
    assert [messages[0]["type"], messages[-1]["type"]] == ["start", "complete"]
    assert messages[0]["total_bytes"] == size
    assert _reconstruct(messages) == data
    revision = "sha256:" + hashlib.sha256(data).hexdigest()
    assert response.headers["x-document-revision"] == revision
    assert {message["revision"] for message in messages} == {revision}


@pytest.mark.parametrize("size", [512 * 1024 - 1, 512 * 1024 + 1])
def test_workspace_document_endpoint_crosses_legacy_boundary(
    tmp_path: Path, size: int
) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    data = b"x" * size
    (root / "boundary.md").write_bytes(data)

    with _client(tmp_path) as client:
        workspace = _create_workspace(client, root)
        response = client.post(
            f"/api/workspaces/{workspace['id']}/read/document",
            json=_payload("boundary.md"),
        )

    assert response.status_code == 200
    assert _reconstruct(_messages(response)) == data


def test_workspace_document_preserves_bom_crlf_and_chinese_path(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    folder = root / "中文目录"
    folder.mkdir(parents=True)
    data = b"\xef\xbb\xbf# title\r\n\r\nannotation \xe6\x89\xb9\xe6\xb3\xa8\r\n"
    relative_path = "中文目录/预览.md"
    (folder / "预览.md").write_bytes(data)

    with _client(tmp_path) as client:
        workspace = _create_workspace(client, root)
        response = client.post(
            f"/api/workspaces/{workspace['id']}/read/document",
            json=_payload(relative_path, chunk_size_bytes=7),
        )

    assert response.status_code == 200
    messages = _messages(response)
    assert messages[0]["path"] == relative_path
    assert _reconstruct(messages) == data


def test_workspace_document_rejects_stale_revision_and_invalid_source(
    tmp_path: Path,
) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "note.md").write_text("current", encoding="utf-8")

    with _client(tmp_path) as client:
        workspace = _create_workspace(client, root)
        endpoint = f"/api/workspaces/{workspace['id']}/read/document"
        stale = client.post(
            endpoint,
            json=_payload("note.md", expected_revision="sha256:stale"),
        )
        wrong_source = client.post(
            endpoint,
            json=_payload("note.md", source="tauri"),
        )

    assert stale.status_code == 409
    assert stale.json()["detail"]["code"] == "revision_conflict"
    assert stale.json()["detail"]["details"]["retryable"] is True
    assert wrong_source.status_code == 400
    assert wrong_source.json()["detail"]["code"] == "invalid_request"


def test_workspace_document_enforces_server_and_request_limits(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "server-limit.md").write_bytes(b"x" * (20 * 1024 * 1024 + 1))
    (root / "request-limit.md").write_bytes(b"x" * 1025)

    with _client(tmp_path) as client:
        workspace = _create_workspace(client, root)
        endpoint = f"/api/workspaces/{workspace['id']}/read/document"
        server_limit = client.post(
            endpoint,
            json=_payload("server-limit.md", max_bytes=100 * 1024 * 1024),
        )
        request_limit = client.post(
            endpoint,
            json=_payload("request-limit.md", max_bytes=1024),
        )

    assert server_limit.status_code == 413
    assert server_limit.json()["detail"]["code"] == "too_large"
    assert server_limit.json()["detail"]["details"]["server_max_bytes"] == 20 * 1024 * 1024
    assert request_limit.status_code == 413
    assert request_limit.json()["detail"]["details"]["max_bytes"] == 1024


def test_workspace_document_rejects_non_utf8(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    (root / "binary.md").write_bytes(b"prefix\xffsuffix")

    with _client(tmp_path) as client:
        workspace = _create_workspace(client, root)
        response = client.post(
            f"/api/workspaces/{workspace['id']}/read/document",
            json=_payload("binary.md"),
        )

    assert response.status_code == 415
    assert response.json()["detail"]["code"] == "unsupported_encoding"


def test_session_workspace_document_uses_same_contract(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    data = "# session\n批注\n".encode()
    (root / "note.md").write_bytes(data)

    with _client(tmp_path) as client:
        workspace = _create_workspace(client, root)
        session_response = client.post(
            "/api/sessions",
            json={"session_type": "workspace", "workspace_id": workspace["id"]},
        )
        assert session_response.status_code == 200
        session = session_response.json()["session"]
        response = client.post(
            f"/api/sessions/{session['id']}/workspace/read/document",
            json=_payload("note.md"),
        )

    assert response.status_code == 200
    assert _reconstruct(_messages(response)) == data


def test_workspace_document_stable_errors_for_missing_renamed_and_permission(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    original = root / "note.md"
    original.write_text("text", encoding="utf-8")

    with _client(tmp_path) as client:
        workspace = _create_workspace(client, root)
        endpoint = f"/api/workspaces/{workspace['id']}/read/document"
        original.rename(root / "renamed.md")
        renamed = client.post(endpoint, json=_payload("note.md"))

        def denied(_target: Path):
            raise PermissionError(13, "denied")

        monkeypatch.setattr("backend.app.api.workspace._open_document_file", denied)
        denied_response = client.post(endpoint, json=_payload("renamed.md"))

    assert renamed.status_code == 404
    assert renamed.json()["detail"]["code"] == "not_found"
    assert denied_response.status_code == 403
    assert denied_response.json()["detail"]["code"] == "io_error"


def test_workspace_document_rejects_traversal_and_symlink_escape(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    outside = tmp_path / "secret.md"
    outside.write_text("secret", encoding="utf-8")
    link = root / "escape.md"
    try:
        link.symlink_to(outside)
    except OSError:
        link = None

    with _client(tmp_path) as client:
        workspace = _create_workspace(client, root)
        endpoint = f"/api/workspaces/{workspace['id']}/read/document"
        traversal = client.post(endpoint, json=_payload("../secret.md"))
        symlink = client.post(endpoint, json=_payload("escape.md")) if link else None

    assert traversal.status_code == 403
    assert traversal.json()["detail"]["code"] == "workspace_path_forbidden"
    if symlink is not None:
        assert symlink.status_code == 403
        assert symlink.json()["detail"]["code"] == "workspace_path_forbidden"


def test_workspace_document_detects_change_before_publishing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    document = root / "note.md"
    document.write_text("before", encoding="utf-8")
    from backend.app.api import workspace as workspace_api

    original_read = workspace_api._read_open_document

    def mutate_after_read(handle, limit: int) -> bytes:
        data = original_read(handle, limit)
        document.write_text("after-change", encoding="utf-8")
        return data

    monkeypatch.setattr(workspace_api, "_read_open_document", mutate_after_read)
    with _client(tmp_path) as client:
        workspace = _create_workspace(client, root)
        response = client.post(
            f"/api/workspaces/{workspace['id']}/read/document",
            json=_payload("note.md"),
        )

    assert response.status_code == 409
    assert response.json()["detail"]["code"] == "changed_during_read"
    assert response.json()["detail"]["details"]["retryable"] is True


def test_workspace_document_stream_stops_when_client_disconnects() -> None:
    class DisconnectAfterStart:
        def __init__(self) -> None:
            self.calls = 0

        async def is_disconnected(self) -> bool:
            self.calls += 1
            return self.calls > 1

    payload = DocumentReadRequest(
        request_id="cancel-1",
        document_id="workspace:note.md",
        source=DocumentReadSource.WORKSPACE,
        path="note.md",
        chunk_size_bytes=4,
    )
    snapshot = DocumentReadSnapshot(path="note.md", revision="r1", data=b"abcdefgh")

    async def collect() -> list[str]:
        return [
            item
            async for item in stream_document_read_messages(
                payload,
                snapshot,
                "chunked",
                [(0, 4), (4, 8)],
                DisconnectAfterStart().is_disconnected,
            )
        ]

    messages = asyncio.run(collect())
    assert len(messages) == 1
    assert json.loads(messages[0])["type"] == "start"


def test_workspace_document_snapshot_supports_concurrent_reads(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    data = ("# 并发\n" * 1000).encode()
    (root / "note.md").write_bytes(data)
    scope = SimpleNamespace(
        workspace_id="workspace-1",
        cwd=root,
        workspace_roots=[root],
    )

    with ThreadPoolExecutor(max_workers=8) as pool:
        snapshots = list(
            pool.map(
                lambda _: _read_document_snapshot(scope, "note.md", 20 * 1024 * 1024),
                range(24),
            )
        )

    assert {snapshot.revision for snapshot in snapshots} == {
        "sha256:" + hashlib.sha256(data).hexdigest()
    }
    assert all(snapshot.data == data for snapshot in snapshots)
