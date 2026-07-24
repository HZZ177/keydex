from __future__ import annotations

import hashlib
import json
import struct
import zlib
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from pathlib import Path

from fastapi.testclient import TestClient

from backend.app.agent.state import build_checkpoint_state_graph
from backend.app.core.config import AppSettings
from backend.app.core.data_path import resolve_data_path
from backend.app.core.time import to_iso_z, utc_now
from backend.app.main import create_app
from backend.app.services.session_fork_service import SessionForkService
from backend.app.web_annotations import assets as assets_module
from backend.app.web_annotations.assets import WebAnnotationAttachmentCloneService
from backend.app.web_annotations.models import WebAnnotationMessageAttachmentCloneRequest


def _png(width: int = 12, height: int = 8) -> bytes:
    def chunk(kind: bytes, value: bytes) -> bytes:
        checksum = zlib.crc32(kind + value) & 0xFFFFFFFF
        return struct.pack(">I", len(value)) + kind + value + struct.pack(">I", checksum)

    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    rows = b"".join(b"\x00" + b"\x33\x66\x99\xff" * width for _ in range(height))
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(rows))
        + chunk(b"IEND", b"")
    )


def _write_capture(data_dir: Path, suffix: str) -> tuple[str, dict, Path, bytes]:
    asset_id = f"web-capture-{suffix:0>32}"
    directory = data_dir / "browser" / "captures" / "staged" / asset_id
    directory.mkdir(parents=True)
    body = _png()
    capture_path = directory / "capture.png"
    capture_path.write_bytes(body)
    now = utc_now()
    created_at = to_iso_z(now - timedelta(minutes=1))
    expires_at = to_iso_z(now + timedelta(hours=23))
    digest = hashlib.sha256(body).hexdigest()
    manifest = {
        "schemaVersion": 1,
        "kind": "staged",
        "assetId": asset_id,
        "captureRequestId": f"capture:{suffix}",
        "surface": {"panelId": "browser-1", "surfaceId": "surface-1", "generation": 1},
        "fileName": "capture.png",
        "mimeType": "image/png",
        "width": 12,
        "height": 8,
        "byteLength": len(body),
        "sha256": digest,
        "createdAt": created_at,
        "expiresAt": expires_at,
    }
    (directory / ".keydex-browser-capture.json").write_text(
        json.dumps(manifest, separators=(",", ":")),
        encoding="utf-8",
    )
    return (
        asset_id,
        {
            "asset_id": asset_id,
            "kind": "staged",
            "mime_type": "image/png",
            "width": 12,
            "height": 8,
            "byte_length": len(body),
            "sha256": digest,
            "expires_at": expires_at,
        },
        directory,
        body,
    )


def _create_session(client: TestClient, title: str) -> dict:
    response = client.post("/api/sessions", json={"title": title})
    assert response.status_code == 200
    return response.json()["session"]


def _create_region_annotation(
    client: TestClient,
    *,
    data_dir: Path,
    session_id: str,
    suffix: str,
    local_file: bool = False,
    scope: dict | None = None,
) -> tuple[str, str, Path, bytes]:
    asset_id, descriptor, source_directory, body = _write_capture(data_dir, suffix)
    annotation_scope = scope or {"kind": "session", "id": session_id}
    if local_file:
        page_url = f"file:///D:/wbf-missing-file/index.html#{suffix}"
        source = {
            "source_kind": "local_file",
            "url": page_url,
            "title": "Local fixture",
            "canonical_url": "file:///D:/wbf-missing-file/index.html",
            "profile_mode": "persistent",
        }
        frame_url = page_url
    else:
        source = {
            "url": f"https://example.com/docs#{suffix}",
            "title": "Example Docs",
            "canonical_url": "https://example.com/docs",
            "profile_mode": "persistent",
        }
        frame_url = "https://example.com/docs"
    registered = client.post(
        "/api/web-annotations/assets",
        json={
            "schema_version": 1,
            "scope": annotation_scope,
            "source": source,
            "asset": descriptor,
        },
    )
    assert registered.status_code == 201
    created = client.post(
        "/api/web-annotations",
        json={
            "schema_version": 1,
            "scope": annotation_scope,
            "source": source,
            "target": {
                "type": "region",
                "rect": {"x": 10.0, "y": 20.0, "width": 120.0, "height": 80.0},
                "viewport": {"width": 1280.0, "height": 720.0},
                "scroll": {"x": 0.0, "y": 240.0},
                "frame": {"url": frame_url, "index_path": []},
            },
            "body_markdown": "Region evidence",
            "tags": ["evidence"],
            "properties": [],
            "staged_asset_ids": [asset_id],
        },
    )
    assert created.status_code == 201
    return created.json()["annotation"]["id"], asset_id, source_directory, body


def _clone_path(annotation_id: str, asset_id: str) -> str:
    return f"/api/web-annotations/{annotation_id}/evidence/{asset_id}/message-attachment"


def _clone_payload(session_id: str, digest_character: str = "a") -> dict:
    return {
        "schema_version": 1,
        "session_id": session_id,
        "context_digest": f"sha256:{digest_character * 64}",
    }


def test_clone_is_idempotent_and_concurrent_with_independent_attachment_file(tmp_path) -> None:
    data_dir = tmp_path / "data"
    app = create_app(AppSettings(data_dir=data_dir))
    with TestClient(app) as client:
        session = _create_session(client, "Clone evidence")
        annotation_id, asset_id, _source_directory, source_body = _create_region_annotation(
            client,
            data_dir=data_dir,
            session_id=session["id"],
            suffix="101",
        )
        first = client.post(
            _clone_path(annotation_id, asset_id),
            json=_clone_payload(session["id"]),
        )
        replay = client.post(
            _clone_path(annotation_id, asset_id),
            json=_clone_payload(session["id"]),
        )

        assert first.status_code == 200
        assert replay.status_code == 200
        assert first.json()["reused"] is False
        assert replay.json()["reused"] is True
        assert replay.json()["attachment"]["id"] == first.json()["attachment"]["id"]
        attachment = first.json()["attachment"]
        assert attachment["source"] == "web_annotation"
        assert attachment["session_id"] == session["id"]
        cloned_path = resolve_data_path(data_dir, attachment["path"])
        assert cloned_path.read_bytes() == source_body
        assert cloned_path.is_relative_to(data_dir / "attachments")

        service = WebAnnotationAttachmentCloneService(app.state.repositories, data_dir=data_dir)
        concurrent_payload = WebAnnotationMessageAttachmentCloneRequest.model_validate(
            _clone_payload(session["id"], "b")
        )
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(
                pool.map(
                    lambda _index: service.clone(
                        annotation_id=annotation_id,
                        asset_id=asset_id,
                        payload=concurrent_payload,
                    ),
                    range(2),
                )
            )

        assert {item.attachment.id for item in results}.__len__() == 1
        assert sorted(item.reused for item in results) == [False, True]
        with app.state.repositories.db.connect() as conn:
            attachment_count = conn.execute("select count(*) from attachments").fetchone()[0]
            clone_count = conn.execute(
                "select count(*) from web_annotation_attachment_clones"
            ).fetchone()[0]
        assert attachment_count == 2
        assert clone_count == 2


def test_local_file_region_evidence_clones_with_identical_digest_and_dimensions(
    tmp_path,
) -> None:
    data_dir = tmp_path / "data"
    app = create_app(AppSettings(data_dir=data_dir))
    with TestClient(app) as client:
        session = _create_session(client, "Local region clone")
        annotation_id, asset_id, source_directory, source_body = (
            _create_region_annotation(
                client,
                data_dir=data_dir,
                session_id=session["id"],
                suffix="10a",
                local_file=True,
            )
        )
        detail = client.get(f"/api/web-annotations/{annotation_id}")
        cloned = client.post(
            _clone_path(annotation_id, asset_id),
            json=_clone_payload(session["id"], "c"),
        )

    assert detail.status_code == 200
    assert detail.json()["resource"]["source_kind"] == "local_file"
    assert detail.json()["assets"][0]["width"] == 12
    assert detail.json()["assets"][0]["height"] == 8
    assert detail.json()["assets"][0]["sha256"] == hashlib.sha256(source_body).hexdigest()
    assert cloned.status_code == 200
    attachment = cloned.json()["attachment"]
    cloned_path = resolve_data_path(data_dir, attachment["path"])
    assert cloned_path.read_bytes() == source_body
    assert source_directory.exists()


def test_workspace_region_evidence_clones_only_to_a_session_in_the_same_workspace(
    tmp_path,
) -> None:
    data_dir = tmp_path / "data"
    app = create_app(AppSettings(data_dir=data_dir))
    first_root = tmp_path / "first-workspace"
    second_root = tmp_path / "second-workspace"
    first_root.mkdir()
    second_root.mkdir()
    with TestClient(app) as client:
        first_workspace = client.post(
            "/api/workspaces",
            json={"root_path": str(first_root), "name": "First"},
        ).json()["workspace"]
        second_workspace = client.post(
            "/api/workspaces",
            json={"root_path": str(second_root), "name": "Second"},
        ).json()["workspace"]
        first_session = client.post(
            "/api/sessions",
            json={
                "session_type": "workspace",
                "workspace_id": first_workspace["id"],
                "title": "First session",
            },
        ).json()["session"]
        second_session = client.post(
            "/api/sessions",
            json={
                "session_type": "workspace",
                "workspace_id": second_workspace["id"],
                "title": "Second session",
            },
        ).json()["session"]
        annotation_id, asset_id, _source_directory, _source_body = _create_region_annotation(
            client,
            data_dir=data_dir,
            session_id=first_session["id"],
            suffix="10b",
            local_file=True,
            scope={"kind": "workspace", "id": first_workspace["id"]},
        )

        same_workspace = client.post(
            _clone_path(annotation_id, asset_id),
            json=_clone_payload(first_session["id"], "d"),
        )
        other_workspace = client.post(
            _clone_path(annotation_id, asset_id),
            json=_clone_payload(second_session["id"], "e"),
        )

    assert same_workspace.status_code == 200
    assert same_workspace.json()["attachment"]["session_id"] == first_session["id"]
    assert other_workspace.status_code == 403
    assert other_workspace.json()["detail"]["code"] == "web_annotation_scope_forbidden"


def test_clone_rejects_wrong_scope_and_missing_asset(tmp_path) -> None:
    data_dir = tmp_path / "data"
    with TestClient(create_app(AppSettings(data_dir=data_dir))) as client:
        source_session = _create_session(client, "Source session")
        other_session = _create_session(client, "Other session")
        annotation_id, asset_id, _source_directory, _body = _create_region_annotation(
            client,
            data_dir=data_dir,
            session_id=source_session["id"],
            suffix="102",
        )
        wrong_scope = client.post(
            _clone_path(annotation_id, asset_id),
            json=_clone_payload(other_session["id"]),
        )
        missing_asset = client.post(
            _clone_path(annotation_id, "web-capture-ffffffffffffffffffffffffffffffff"),
            json=_clone_payload(source_session["id"]),
        )

    assert wrong_scope.status_code == 403
    assert wrong_scope.json()["detail"]["code"] == "web_annotation_scope_forbidden"
    assert missing_asset.status_code == 404
    assert missing_asset.json()["detail"]["code"] == "web_annotation_asset_not_found"


def test_annotation_delete_keeps_history_attachment_and_idempotent_retry(tmp_path) -> None:
    data_dir = tmp_path / "data"
    app = create_app(AppSettings(data_dir=data_dir))
    with TestClient(app) as client:
        session = _create_session(client, "Immutable history")
        annotation_id, asset_id, source_directory, source_body = _create_region_annotation(
            client,
            data_dir=data_dir,
            session_id=session["id"],
            suffix="103",
        )
        cloned = client.post(
            _clone_path(annotation_id, asset_id),
            json=_clone_payload(session["id"]),
        )
        attachment_id = cloned.json()["attachment"]["id"]
        repositories = app.state.repositories
        saver = app.state.checkpoint_runtime.require_store()
        graph = build_checkpoint_state_graph(saver)
        checkpoint_config = {
            "configurable": {
                "thread_id": session["id"],
                "checkpoint_ns": "",
            }
        }

        async def seed_checkpoint() -> str:
            await graph.ainvoke({"messages": []}, config=checkpoint_config)
            snapshot = await graph.aget_state(checkpoint_config)
            return str(snapshot.config["configurable"]["checkpoint_id"])

        checkpoint_id = client.portal.call(seed_checkpoint)
        repositories.trace_records.create(
            trace_id="trace-web-annotation",
            session_id=session["id"],
            active_session_id=session["id"],
            scene_id=session["scene_id"],
            user_id=session["user_id"],
            turn_index=1,
            root_node_id="root-web-annotation",
        )
        repositories.trace_records.finish(
            "trace-web-annotation",
            status="completed",
            output_checkpoint_id=checkpoint_id,
            output_checkpoint_ns="",
        )
        context_snapshot = {
            "schemaVersion": 1,
            "type": "web_annotation",
            "annotationId": annotation_id,
            "annotationRevision": 1,
            "capturedAt": "2026-07-22T08:00:00Z",
            "source": {
                "title": "Fork evidence",
                "url": "https://example.test/region/103",
                "urlKey": "f" * 64,
                "origin": "https://example.test",
            },
            "target": {
                "type": "region",
                "summary": "Captured region",
                "resolution": "orphaned",
                "freshness": "last-known",
            },
            "evidence": {"attachmentId": attachment_id},
            "annotation": {
                "bodyMarkdown": "Immutable history note",
                "tags": ["history"],
                "properties": [],
            },
            "digest": "fork-history-digest",
        }
        context_item = {
            "id": f"web-annotation:{annotation_id}:fork-history-digest",
            "type": "web_annotation",
            "label": "网页批注 · Fork evidence",
            "content": "Immutable context body",
            "metadata": {
                "annotation_id": annotation_id,
                "snapshot_digest": "fork-history-digest",
                "snapshot": context_snapshot,
            },
        }
        repositories.message_events.append(
            event_id="evt-web-annotation-user",
            session_id=session["id"],
            trace_record_id="trace-web-annotation",
            turn_index=1,
            action="user_message",
            data={
                "session_id": session["id"],
                "content": "Review region evidence",
                "attachments": [cloned.json()["attachment"]],
                "contextItems": [context_item],
                "context_items": [context_item],
            },
        )
        repositories.message_events.append(
            event_id="evt-web-annotation-ai",
            session_id=session["id"],
            trace_record_id="trace-web-annotation",
            turn_index=1,
            action="ai_message",
            data={"session_id": session["id"], "content": "Reviewed"},
        )
        async def fork_session():
            return await SessionForkService(
                repositories,
                checkpointer=saver,
            ).fork_session(
                session_id=session["id"],
                user_id=session["user_id"],
                message_event_id="evt-web-annotation-ai",
                title="Forked evidence",
            )

        forked = client.portal.call(fork_session)
        forked_user_event = next(
            event
            for event in repositories.message_events.list_by_session(forked.session.id)
            if event.action == "user_message"
        )
        deleted = client.delete(f"/api/web-annotations/{annotation_id}")
        media = client.get(f"/api/attachments/{attachment_id}/media")
        replay = client.post(
            _clone_path(annotation_id, asset_id),
            json=_clone_payload(session["id"]),
        )

    assert deleted.status_code == 204
    assert not source_directory.exists()
    assert media.status_code == 200
    assert media.json()["attachment_id"] == attachment_id
    assert media.json()["size"] == len(source_body)
    assert forked_user_event.data["attachments"][0]["attachment_id"] == attachment_id
    assert forked_user_event.data["contextItems"] == [context_item]
    assert forked_user_event.data["contextItems"][0]["metadata"]["snapshot"] == context_snapshot
    assert replay.status_code == 200
    assert replay.json()["reused"] is True
    assert replay.json()["attachment"]["id"] == attachment_id


def test_clone_file_failure_rolls_back_database_and_partial_target(tmp_path, monkeypatch) -> None:
    data_dir = tmp_path / "data"
    app = create_app(AppSettings(data_dir=data_dir))
    with TestClient(app) as client:
        session = _create_session(client, "Clone rollback")
        annotation_id, asset_id, _source_directory, _body = _create_region_annotation(
            client,
            data_dir=data_dir,
            session_id=session["id"],
            suffix="104",
        )

        def fail_copy(source: Path, target: Path) -> None:
            Path(target).write_bytes(b"partial")
            raise OSError("simulated copy failure")

        monkeypatch.setattr(assets_module.shutil, "copyfile", fail_copy)
        failed = client.post(
            _clone_path(annotation_id, asset_id),
            json=_clone_payload(session["id"]),
        )

        with app.state.repositories.db.connect() as conn:
            attachment_count = conn.execute("select count(*) from attachments").fetchone()[0]
            clone_count = conn.execute(
                "select count(*) from web_annotation_attachment_clones"
            ).fetchone()[0]

    assert failed.status_code == 503
    assert failed.json()["detail"]["code"] == "web_annotation_asset_unavailable"
    assert attachment_count == 0
    assert clone_count == 0
    attachments_root = data_dir / "attachments"
    assert not attachments_root.exists() or list(attachments_root.iterdir()) == []
