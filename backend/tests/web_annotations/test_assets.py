from __future__ import annotations

import hashlib
import json
import struct
import zlib
from datetime import timedelta
from pathlib import Path

from fastapi.testclient import TestClient

from backend.app.core.config import AppSettings
from backend.app.core.time import to_iso_z, utc_now
from backend.app.main import create_app
from backend.app.web_annotations.models import WebAnnotationScope
from backend.app.web_annotations.url_identity import normalize_web_url


def _client(tmp_path) -> TestClient:
    return TestClient(create_app(AppSettings(data_dir=tmp_path / "data")))


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


def _write_capture(
    data_dir: Path,
    *,
    suffix: str,
    created_delta: timedelta = timedelta(minutes=-1),
    expires_delta: timedelta = timedelta(hours=23, minutes=59),
    file_bytes: bytes | None = None,
) -> tuple[str, dict, Path, dict]:
    asset_id = f"web-capture-{suffix:0>32}"
    directory = data_dir / "browser" / "captures" / "staged" / asset_id
    directory.mkdir(parents=True)
    body = file_bytes if file_bytes is not None else _png()
    capture_path = directory / "capture.png"
    capture_path.write_bytes(body)
    now = utc_now()
    created_at = to_iso_z(now + created_delta)
    expires_at = to_iso_z(now + expires_delta)
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
    descriptor = {
        "asset_id": asset_id,
        "kind": "staged",
        "mime_type": "image/png",
        "width": 12,
        "height": 8,
        "byte_length": len(body),
        "sha256": digest,
        "expires_at": expires_at,
    }
    return asset_id, descriptor, directory, manifest


def _source(url: str = "https://example.com/docs?page=1#region") -> dict:
    return {
        "url": url,
        "title": "Example Docs",
        "canonical_url": "https://example.com/docs",
        "profile_mode": "persistent",
    }


def _register_payload(scope: dict, descriptor: dict, *, url: str | None = None) -> dict:
    return {
        "schema_version": 1,
        "scope": scope,
        "source": _source(url or "https://example.com/docs?page=1#region"),
        "asset": descriptor,
    }


def _region_target() -> dict:
    return {
        "type": "region",
        "rect": {"x": 10.0, "y": 20.0, "width": 120.0, "height": 80.0},
        "viewport": {"width": 1280.0, "height": 720.0},
        "scroll": {"x": 0.0, "y": 240.0},
        "frame": {"url": "https://example.com/docs?page=1", "index_path": []},
    }


def _create_payload(scope: dict, asset_id: str, *, url: str | None = None) -> dict:
    return {
        "schema_version": 1,
        "scope": scope,
        "source": _source(url or "https://example.com/docs?page=1#region"),
        "target": _region_target(),
        "body_markdown": "Region evidence",
        "tags": ["evidence"],
        "properties": [],
        "staged_asset_ids": [asset_id],
    }


def _code(response) -> str:
    return response.json()["detail"]["code"]


def test_managed_capture_register_attach_once_and_annotation_delete(tmp_path) -> None:
    data_dir = tmp_path / "data"
    scope = {"kind": "global", "id": None}
    asset_id, descriptor, directory, _manifest = _write_capture(data_dir, suffix="1")

    with _client(tmp_path) as client:
        registered = client.post(
            "/api/web-annotations/assets",
            json=_register_payload(scope, descriptor),
        )
        replayed = client.post(
            "/api/web-annotations/assets",
            json=_register_payload(scope, descriptor),
        )
        created = client.post(
            "/api/web-annotations",
            json=_create_payload(scope, asset_id),
        )
        consumed = client.post(
            "/api/web-annotations",
            json=_create_payload(scope, asset_id),
        )
        staged_delete = client.delete(f"/api/web-annotations/assets/{asset_id}")

        assert registered.status_code == 201
        assert registered.json()["state"] == "staged"
        assert replayed.status_code == 201
        assert replayed.json()["id"] == registered.json()["id"]
        assert created.status_code == 201
        annotation_id = created.json()["annotation"]["id"]
        assert created.json()["assets"] == [
            registered.json()
            | {
                "annotation_id": annotation_id,
                "state": "attached",
                "expires_at": None,
                "updated_at": created.json()["assets"][0]["updated_at"],
            }
        ]
        assert consumed.status_code == 409
        assert _code(consumed) == "web_annotation_asset_state_conflict"
        assert staged_delete.status_code == 409

        deleted = client.delete(f"/api/web-annotations/{annotation_id}")
        asset_after_delete = client.app.state.repositories.web_annotations.assets.get(asset_id)

    assert deleted.status_code == 204
    assert asset_after_delete is None
    assert not directory.exists()


def test_region_retarget_attaches_new_evidence_atomically_and_preserves_content(tmp_path) -> None:
    data_dir = tmp_path / "data"
    scope = {"kind": "global", "id": None}
    first_id, first_descriptor, _first_directory, _ = _write_capture(data_dir, suffix="21")
    second_id, second_descriptor, _second_directory, _ = _write_capture(data_dir, suffix="22")
    stale_id, stale_descriptor, _stale_directory, _ = _write_capture(data_dir, suffix="23")

    with _client(tmp_path) as client:
        for descriptor in (first_descriptor, second_descriptor, stale_descriptor):
            registered = client.post(
                "/api/web-annotations/assets",
                json=_register_payload(scope, descriptor),
            )
            assert registered.status_code == 201

        created = client.post(
            "/api/web-annotations",
            json=_create_payload(scope, first_id),
        )
        assert created.status_code == 201
        annotation_id = created.json()["annotation"]["id"]
        replacement = _region_target() | {
            "rect": {"x": 42.0, "y": 64.0, "width": 240.0, "height": 120.0},
        }
        retargeted = client.put(
            f"/api/web-annotations/{annotation_id}/target",
            headers={"If-Match": "1"},
            json={
                "schema_version": 1,
                "expected_revision": 1,
                "target": replacement,
                "reason": "user_retarget",
                "staged_asset_ids": [second_id],
            },
        )

        assert retargeted.status_code == 200
        detail = retargeted.json()
        assert detail["annotation"]["revision"] == 2
        assert detail["annotation"]["target"]["type"] == "region"
        assert detail["annotation"]["target"]["rect"] == replacement["rect"]
        assert detail["annotation"]["target"]["viewport"] == replacement["viewport"]
        assert detail["annotation"]["body_markdown"] == "Region evidence"
        assert detail["annotation"]["tags"] == ["evidence"]
        assert len(detail["target_history"]) == 1
        assert detail["target_history"][0]["target"] == created.json()["annotation"]["target"]
        assert {asset["id"] for asset in detail["assets"]} == {first_id, second_id}
        assert all(asset["state"] == "attached" for asset in detail["assets"])

        stale = client.put(
            f"/api/web-annotations/{annotation_id}/target",
            headers={"If-Match": "1"},
            json={
                "schema_version": 1,
                "expected_revision": 1,
                "target": _region_target(),
                "staged_asset_ids": [stale_id],
            },
        )
        loaded = client.get(f"/api/web-annotations/{annotation_id}")
        stale_asset = client.app.state.repositories.web_annotations.assets.get(stale_id)

    assert stale.status_code == 409
    assert loaded.json()["annotation"]["revision"] == 2
    assert len(loaded.json()["target_history"]) == 1
    assert stale_asset is not None and stale_asset.state == "staged"


def test_asset_scope_file_integrity_failure_preserves_retryable_staged_state(tmp_path) -> None:
    data_dir = tmp_path / "data"
    scope = {"kind": "global", "id": None}
    asset_id, descriptor, directory, manifest = _write_capture(data_dir, suffix="2")
    capture_path = directory / "capture.png"
    original_body = capture_path.read_bytes()

    with _client(tmp_path) as client:
        registered = client.post(
            "/api/web-annotations/assets",
            json=_register_payload(scope, descriptor),
        )
        capture_path.write_bytes(original_body + b"tampered")
        corrupt = client.post(
            "/api/web-annotations",
            json=_create_payload(scope, asset_id),
        )
        after_corrupt = client.app.state.repositories.web_annotations.assets.get(asset_id)

        capture_path.write_bytes(original_body)
        restored = client.post(
            "/api/web-annotations",
            json=_create_payload(scope, asset_id),
        )

        assert registered.status_code == 201
        assert corrupt.status_code == 409
        assert corrupt.json()["detail"]["details"]["state"] == "file_mismatch"
        assert after_corrupt is not None and after_corrupt.state == "staged"
        assert restored.status_code == 201

        other_id, other_descriptor, _other_directory, _ = _write_capture(
            data_dir,
            suffix="3",
        )
        other_registered = client.post(
            "/api/web-annotations/assets",
            json=_register_payload(scope, other_descriptor),
        )
        scope_mismatch = client.post(
            "/api/web-annotations",
            json=_create_payload(
                scope,
                other_id,
                url="https://example.com/other#region",
            ),
        )

    assert manifest["sha256"] == descriptor["sha256"]
    assert other_registered.status_code == 201
    assert scope_mismatch.status_code == 409
    assert scope_mismatch.json()["detail"]["details"]["state"] == "staged"


def test_registration_rejects_missing_tampered_and_incognito_capture(tmp_path) -> None:
    data_dir = tmp_path / "data"
    scope = {"kind": "global", "id": None}
    _missing_id, missing_descriptor, _missing_directory, _ = _write_capture(
        data_dir,
        suffix="4",
    )
    missing_path = (
        data_dir
        / "browser"
        / "captures"
        / "staged"
        / missing_descriptor["asset_id"]
        / "capture.png"
    )
    missing_path.unlink()
    _tampered_id, tampered_descriptor, _tampered_directory, _ = _write_capture(
        data_dir,
        suffix="5",
    )
    tampered_descriptor["sha256"] = "0" * 64
    _incognito_id, incognito_descriptor, _incognito_directory, _ = _write_capture(
        data_dir,
        suffix="6",
    )
    incognito_payload = _register_payload(scope, incognito_descriptor)
    incognito_payload["source"]["profile_mode"] = "incognito"

    with _client(tmp_path) as client:
        missing = client.post(
            "/api/web-annotations/assets",
            json=_register_payload(scope, missing_descriptor),
        )
        tampered = client.post(
            "/api/web-annotations/assets",
            json=_register_payload(scope, tampered_descriptor),
        )
        incognito = client.post("/api/web-annotations/assets", json=incognito_payload)

    assert missing.status_code == 409
    assert missing.json()["detail"]["details"]["state"] == "file_missing"
    assert tampered.status_code == 409
    assert tampered.json()["detail"]["details"]["state"] == "metadata_mismatch"
    assert incognito.status_code == 409
    assert _code(incognito) == "web_annotation_incognito_persistence_forbidden"


def test_expired_cleanup_and_path_traversal_refusal_only_touch_managed_root(tmp_path) -> None:
    data_dir = tmp_path / "data"
    asset_id, descriptor, directory, _manifest = _write_capture(
        data_dir,
        suffix="7",
        created_delta=timedelta(hours=-25),
        expires_delta=timedelta(hours=-1),
    )
    outside = tmp_path / "outside-do-not-delete.png"
    outside.write_bytes(_png())

    app = create_app(AppSettings(data_dir=data_dir))
    repositories = app.state.repositories
    scope = WebAnnotationScope(kind="global", id=None)
    resource = repositories.web_annotations.resources.create(
        scope=scope,
        identity=normalize_web_url("https://example.com/expired#region"),
    )
    repositories.web_annotations.assets.stage(
        resource_id=resource.id,
        storage_path=f"browser/captures/staged/{asset_id}/capture.png",
        mime_type="image/png",
        size_bytes=descriptor["byte_length"],
        sha256=descriptor["sha256"],
        width=descriptor["width"],
        height=descriptor["height"],
        expires_at=descriptor["expires_at"],
        asset_id=asset_id,
    )
    traversal_id = "web-capture-00000000000000000000000000000008"
    repositories.web_annotations.assets.stage(
        resource_id=resource.id,
        storage_path="../../outside-do-not-delete.png",
        mime_type="image/png",
        size_bytes=outside.stat().st_size,
        sha256=hashlib.sha256(outside.read_bytes()).hexdigest(),
        width=12,
        height=8,
        expires_at=to_iso_z(utc_now() + timedelta(hours=1)),
        asset_id=traversal_id,
    )
    with TestClient(app) as client:
        expired_after_startup = repositories.web_annotations.assets.get(asset_id)
        traversal = client.delete(f"/api/web-annotations/assets/{traversal_id}")

    assert expired_after_startup is None
    assert not directory.exists()
    assert traversal.status_code == 409
    assert traversal.json()["detail"]["details"]["state"] == "unmanaged_path"
    assert repositories.web_annotations.assets.get(traversal_id) is not None
    assert outside.exists()
