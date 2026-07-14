from __future__ import annotations

import hashlib
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

import backend.app.api.workspace as workspace_api
from backend.app.api.document_write import DocumentWriteError, write_utf8_document
from backend.app.core.config import AppSettings
from backend.app.main import create_app
from backend.app.services.file_change_hub import FileChangeHub


def _client(tmp_path: Path) -> TestClient:
    return TestClient(create_app(AppSettings(data_dir=tmp_path / "data")))


def _create_workspace(client: TestClient, root: Path) -> dict[str, Any]:
    response = client.post(
        "/api/workspaces",
        json={"root_path": str(root), "name": root.name},
    )
    assert response.status_code == 200
    return response.json()["workspace"]


def _revision(data: bytes) -> str:
    return "sha256:" + hashlib.sha256(data).hexdigest()


def _payload(path: str, content: str, revision: str) -> dict[str, str]:
    return {
        "protocol_version": "document-write/v1",
        "write_id": f"test-write:{path}",
        "path": path,
        "content": content,
        "expected_revision": revision,
    }


def test_workspace_document_write_preserves_utf8_bom_crlf_and_returns_revision(
    tmp_path: Path,
) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    target = root / "说明.md"
    before = b"\xef\xbb\xbf# Before\r\n\r\ntext\r\n"
    after_text = "\ufeff# After\r\n\r\n新内容\r\n"
    after = after_text.encode("utf-8")
    target.write_bytes(before)

    with _client(tmp_path) as client:
        workspace = _create_workspace(client, root)
        response = client.post(
            f"/api/workspaces/{workspace['id']}/write/document",
            json=_payload("说明.md", after_text, _revision(before)),
        )

    assert response.status_code == 200
    assert response.json() == {
        "protocol_version": "document-write/v1",
        "path": "说明.md",
        "revision": _revision(after),
        "encoding": "utf-8",
        "total_bytes": len(after),
    }
    assert target.read_bytes() == after


def test_workspace_document_write_registers_echo_before_atomic_write(
    tmp_path: Path,
    monkeypatch: Any,
) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    target = root / "note.md"
    target.write_text("before", encoding="utf-8")
    steps: list[str] = []
    original_register = FileChangeHub.register_document_write_echo
    original_write = workspace_api.write_utf8_document

    async def record_register(self: FileChangeHub, *args: Any, **kwargs: Any) -> None:
        steps.append("register")
        await original_register(self, *args, **kwargs)

    def record_write(*args: Any, **kwargs: Any):
        steps.append("write")
        return original_write(*args, **kwargs)

    monkeypatch.setattr(FileChangeHub, "register_document_write_echo", record_register)
    monkeypatch.setattr(workspace_api, "write_utf8_document", record_write)

    with _client(tmp_path) as client:
        workspace = _create_workspace(client, root)
        response = client.post(
            f"/api/workspaces/{workspace['id']}/write/document",
            json=_payload("note.md", "after", _revision(b"before")),
        )

    assert response.status_code == 200
    assert steps == ["register", "write"]


def test_workspace_document_write_rejects_stale_revision_without_overwriting(
    tmp_path: Path,
) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    target = root / "note.md"
    target.write_text("external", encoding="utf-8")

    with _client(tmp_path) as client:
        workspace = _create_workspace(client, root)
        response = client.post(
            f"/api/workspaces/{workspace['id']}/write/document",
            json=_payload("note.md", "draft", _revision(b"old")),
        )

    assert response.status_code == 409
    assert response.json()["detail"] == {
        "code": "revision_conflict",
        "message": "Document revision no longer matches the edited revision",
        "details": {
            "retryable": True,
            "expected_revision": _revision(b"old"),
            "actual_revision": _revision(b"external"),
        },
    }
    assert target.read_text(encoding="utf-8") == "external"


def test_session_workspace_write_uses_same_contract_and_blocks_escape(tmp_path: Path) -> None:
    root = tmp_path / "workspace"
    root.mkdir()
    target = root / "note.md"
    target.write_text("before", encoding="utf-8")
    outside = tmp_path / "outside.md"
    outside.write_text("outside", encoding="utf-8")

    with _client(tmp_path) as client:
        workspace = _create_workspace(client, root)
        session_response = client.post(
            "/api/sessions",
            json={"session_type": "workspace", "workspace_id": workspace["id"]},
        )
        session = session_response.json()["session"]
        saved = client.post(
            f"/api/sessions/{session['id']}/workspace/write/document",
            json=_payload("note.md", "after", _revision(b"before")),
        )
        escaped = client.post(
            f"/api/sessions/{session['id']}/workspace/write/document",
            json=_payload("../outside.md", "bad", _revision(b"outside")),
        )

    assert saved.status_code == 200
    assert target.read_text(encoding="utf-8") == "after"
    assert escaped.status_code == 403
    assert escaped.json()["detail"]["code"] == "workspace_path_forbidden"
    assert outside.read_text(encoding="utf-8") == "outside"


def test_local_preview_document_write_uses_revision_guard(tmp_path: Path) -> None:
    target = tmp_path / "local.md"
    target.write_text("before", encoding="utf-8")

    with _client(tmp_path) as client:
        saved = client.post(
            "/api/local-preview/write/document",
            json=_payload(str(target), "after", _revision(b"before")),
        )
        stale = client.post(
            "/api/local-preview/write/document",
            json=_payload(str(target), "stale", _revision(b"before")),
        )

    assert saved.status_code == 200
    assert saved.json()["revision"] == _revision(b"after")
    assert stale.status_code == 409
    assert target.read_text(encoding="utf-8") == "after"


def test_concurrent_writes_with_one_base_revision_allow_only_one_winner(tmp_path: Path) -> None:
    target = tmp_path / "race.md"
    target.write_text("before", encoding="utf-8")
    expected_revision = _revision(b"before")

    def write(content: str):
        try:
            return write_utf8_document(
                target,
                public_path="race.md",
                content=content,
                expected_revision=expected_revision,
                max_bytes=1024,
            )
        except DocumentWriteError as exc:
            return exc

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(write, ["first", "second"]))

    assert sum(not isinstance(result, DocumentWriteError) for result in results) == 1
    conflicts = [result for result in results if isinstance(result, DocumentWriteError)]
    assert len(conflicts) == 1
    assert conflicts[0].code.value == "revision_conflict"
    assert target.read_text(encoding="utf-8") in {"first", "second"}
