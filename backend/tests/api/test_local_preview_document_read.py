from __future__ import annotations

import asyncio
import hashlib
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from backend.app.api.document_read import (
    DocumentReadRequest,
    DocumentReadSnapshot,
    DocumentReadSource,
    DocumentReadTransport,
    stream_document_read_messages,
)
from backend.app.api.local_preview import _read_local_document_snapshot
from backend.app.core.config import AppSettings
from backend.app.main import create_app


def _client(tmp_path: Path) -> TestClient:
    return TestClient(create_app(AppSettings(data_dir=tmp_path / "data")))


def _payload(path: Path, **overrides: Any) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "request_id": "local-request-1",
        "document_id": f"local-preview:{path}",
        "source": "local-preview",
        "path": str(path),
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
def test_local_preview_document_reads_large_file_outside_workspace(
    tmp_path: Path, size: int
) -> None:
    target = tmp_path / "outside" / "large.md"
    target.parent.mkdir()
    data = (b"## block\n" * ((size // 9) + 1))[:size]
    target.write_bytes(data)

    with _client(tmp_path) as client:
        response = client.post("/api/local-preview/read/document", json=_payload(target))

    assert response.status_code == 200
    messages = _messages(response)
    assert messages[0]["path"] == str(target.resolve())
    assert messages[0]["total_bytes"] == size
    assert _reconstruct(messages) == data
    expected_revision = "sha256:" + hashlib.sha256(data).hexdigest()
    assert response.headers["x-document-revision"] == expected_revision
    assert {message["revision"] for message in messages} == {expected_revision}


@pytest.mark.parametrize("size", [512 * 1024 - 1, 512 * 1024 + 1])
def test_local_preview_document_crosses_legacy_boundary(tmp_path: Path, size: int) -> None:
    target = tmp_path / "boundary.md"
    data = b"x" * size
    target.write_bytes(data)

    with _client(tmp_path) as client:
        response = client.post("/api/local-preview/read/document", json=_payload(target))

    assert response.status_code == 200
    assert _reconstruct(_messages(response)) == data


def test_local_preview_document_preserves_unicode_path_bom_and_crlf(tmp_path: Path) -> None:
    target = tmp_path / "中文 目录" / "预览 文档.md"
    target.parent.mkdir()
    data = b"\xef\xbb\xbf# title\r\nannotation \xe6\x89\xb9\xe6\xb3\xa8\r\n"
    target.write_bytes(data)

    with _client(tmp_path) as client:
        response = client.post(
            "/api/local-preview/read/document",
            json=_payload(target, chunk_size_bytes=7),
        )

    assert response.status_code == 200
    assert _reconstruct(_messages(response)) == data


def test_local_preview_document_external_change_and_stale_revision(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    target = tmp_path / "note.md"
    target.write_text("before", encoding="utf-8")
    from backend.app.api import local_preview as local_preview_api

    original_read = local_preview_api._read_open_local_document

    def mutate_after_read(handle, limit: int) -> bytes:
        data = original_read(handle, limit)
        target.write_text("after-change", encoding="utf-8")
        return data

    monkeypatch.setattr(local_preview_api, "_read_open_local_document", mutate_after_read)
    with _client(tmp_path) as client:
        changed = client.post("/api/local-preview/read/document", json=_payload(target))

    assert changed.status_code == 409
    assert changed.json()["detail"]["code"] == "changed_during_read"
    monkeypatch.setattr(local_preview_api, "_read_open_local_document", original_read)

    with _client(tmp_path) as client:
        stale = client.post(
            "/api/local-preview/read/document",
            json=_payload(target, expected_revision="sha256:stale"),
        )
    assert stale.status_code == 409
    assert stale.json()["detail"]["code"] == "revision_conflict"


def test_local_preview_document_missing_invalid_encoding_and_wrong_source(
    tmp_path: Path,
) -> None:
    missing = tmp_path / "missing.md"
    binary = tmp_path / "binary.md"
    binary.write_bytes(b"prefix\xffsuffix")

    with _client(tmp_path) as client:
        missing_response = client.post(
            "/api/local-preview/read/document", json=_payload(missing)
        )
        binary_response = client.post(
            "/api/local-preview/read/document", json=_payload(binary)
        )
        wrong_source = client.post(
            "/api/local-preview/read/document",
            json=_payload(binary, source="workspace"),
        )

    assert missing_response.status_code == 404
    assert missing_response.json()["detail"]["code"] == "not_found"
    assert binary_response.status_code == 415
    assert binary_response.json()["detail"]["code"] == "unsupported_encoding"
    assert wrong_source.status_code == 400
    assert wrong_source.json()["detail"]["code"] == "invalid_request"


def test_local_preview_document_enforces_server_limit(tmp_path: Path) -> None:
    target = tmp_path / "too-large.md"
    target.write_bytes(b"x" * (20 * 1024 * 1024 + 1))

    with _client(tmp_path) as client:
        response = client.post(
            "/api/local-preview/read/document",
            json=_payload(target, max_bytes=100 * 1024 * 1024),
        )

    assert response.status_code == 413
    assert response.json()["detail"]["code"] == "too_large"
    assert response.json()["detail"]["details"]["server_max_bytes"] == 20 * 1024 * 1024


def test_local_preview_document_cancel_stops_before_next_chunk(tmp_path: Path) -> None:
    target = tmp_path / "cancel.md"
    target.write_text("abcdefgh", encoding="utf-8")
    request = DocumentReadRequest(
        request_id="cancel-local",
        document_id=f"local-preview:{target}",
        source=DocumentReadSource.LOCAL_PREVIEW,
        path=str(target),
        chunk_size_bytes=4,
    )
    snapshot = DocumentReadSnapshot(path=str(target), revision="r1", data=b"abcdefgh")
    checks = 0

    async def should_cancel() -> bool:
        nonlocal checks
        checks += 1
        return checks > 1

    async def collect() -> list[str]:
        return [
            message
            async for message in stream_document_read_messages(
                request,
                snapshot,
                DocumentReadTransport.CHUNKED,
                [(0, 4), (4, 8)],
                should_cancel,
            )
        ]

    messages = asyncio.run(collect())
    assert len(messages) == 1
    assert json.loads(messages[0])["type"] == "start"


def test_local_preview_document_supports_concurrent_open(tmp_path: Path) -> None:
    target = tmp_path / "concurrent.md"
    data = ("# 并发\n" * 1000).encode()
    target.write_bytes(data)

    with ThreadPoolExecutor(max_workers=8) as pool:
        snapshots = list(
            pool.map(
                lambda _: _read_local_document_snapshot(target, 20 * 1024 * 1024),
                range(24),
            )
        )

    assert all(snapshot.data == data for snapshot in snapshots)
    assert len({snapshot.revision for snapshot in snapshots}) == 1
