from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from backend.app.core.config import AppSettings
from backend.app.main import create_app
from backend.app.web_annotations.models import WebAnnotationCreateRequest, WebAnnotationScope
from backend.app.web_annotations.url_identity import normalize_web_url


def _client(tmp_path) -> TestClient:
    return TestClient(create_app(AppSettings(data_dir=tmp_path / "data")))


def _state(panel_id: str = "files-1") -> dict:
    return {
        "version": 2,
        "activePanelId": panel_id,
        "panelOrder": [panel_id],
        "panels": {
            panel_id: {"id": panel_id, "kind": "files", "schemaVersion": 1},
        },
        "nextPanelSeq": 2,
    }


def _put_payload(expected_revision: int, panel_id: str = "files-1") -> dict:
    return {
        "schema_version": 2,
        "state": _state(panel_id),
        "expected_revision": expected_revision,
    }


def _web_request(scope: WebAnnotationScope, url: str, label: str) -> WebAnnotationCreateRequest:
    return WebAnnotationCreateRequest.model_validate(
        {
            "scope": scope.model_dump(mode="json"),
            "source": {"url": url, "title": label, "profile_mode": "persistent"},
            "target": {
                "type": "text",
                "quote": {"exact": label, "prefix": "", "suffix": ""},
                "position": {
                    "start": 0,
                    "end": len(label),
                    "text_model_version": 1,
                },
                "context": {"heading_path": []},
                "rects": [{"x": 1.0, "y": 1.0, "width": 20.0, "height": 10.0}],
                "frame": {"url": url.split("#", 1)[0], "index_path": []},
            },
            "body_markdown": label,
            "tags": [],
            "properties": [],
            "staged_asset_ids": [],
        }
    )


def test_global_scope_crud_uses_revision_compare_and_swap(tmp_path) -> None:
    with _client(tmp_path) as client:
        missing = client.get("/api/ui/right-sidebar/scopes/global")
        created = client.put(
            "/api/ui/right-sidebar/scopes/global",
            json=_put_payload(0),
            headers={"If-Match": "0"},
        )
        loaded = client.get("/api/ui/right-sidebar/scopes/global")
        updated = client.put(
            "/api/ui/right-sidebar/scopes/global",
            json=_put_payload(1, "files-2"),
            headers={"If-Match": '"1"'},
        )
        conflict = client.put(
            "/api/ui/right-sidebar/scopes/global",
            json=_put_payload(1, "files-3"),
        )
        deleted = client.delete("/api/ui/right-sidebar/scopes/global")
        missing_after_delete = client.get("/api/ui/right-sidebar/scopes/global")

    assert missing.status_code == 200
    assert missing.json() is None
    assert created.status_code == 200
    assert created.json()["revision"] == 1
    assert loaded.json()["state"]["activePanelId"] == "files-1"
    assert updated.json()["revision"] == 2
    assert updated.json()["state"]["activePanelId"] == "files-2"
    assert conflict.status_code == 409
    assert conflict.json()["detail"]["details"]["current"]["revision"] == 2
    assert deleted.status_code == 204
    assert missing_after_delete.status_code == 200
    assert missing_after_delete.json() is None


def test_scope_api_validates_parent_scope_if_match_and_strict_payload(tmp_path) -> None:
    project = tmp_path / "project"
    project.mkdir()
    with _client(tmp_path) as client:
        workspace = client.post(
            "/api/workspaces",
            json={"root_path": str(project), "name": "Project"},
        ).json()["workspace"]
        session = client.post(
            "/api/sessions",
            json={
                "title": "Session",
                "session_type": "workspace",
                "workspace_id": workspace["id"],
            },
        ).json()["session"]
        workspace_saved = client.put(
            f"/api/ui/right-sidebar/scopes/workspace/{workspace['id']}",
            json=_put_payload(0),
        )
        session_saved = client.put(
            f"/api/ui/right-sidebar/scopes/session/{session['id']}",
            json=_put_payload(0),
        )
        missing_parent = client.put(
            "/api/ui/right-sidebar/scopes/session/missing",
            json=_put_payload(0),
        )
        mismatched_header = client.put(
            "/api/ui/right-sidebar/scopes/global",
            json=_put_payload(0),
            headers={"If-Match": "1"},
        )
        strict_payload = client.put(
            "/api/ui/right-sidebar/scopes/global",
            json=_put_payload(0) | {"unexpected": True},
        )

    assert workspace_saved.status_code == 200
    assert session_saved.status_code == 200
    assert missing_parent.status_code == 404
    assert mismatched_header.status_code == 400
    assert strict_payload.status_code == 422


def test_scope_promotion_api_blocks_stale_source_and_replays_success(tmp_path) -> None:
    project = tmp_path / "project"
    project.mkdir()
    with _client(tmp_path) as client:
        workspace = client.post(
            "/api/workspaces",
            json={"root_path": str(project), "name": "Project"},
        ).json()["workspace"]
        session = client.post(
            "/api/sessions",
            json={
                "title": "Session",
                "session_type": "workspace",
                "workspace_id": workspace["id"],
            },
        ).json()["session"]
        saved = client.put(
            f"/api/ui/right-sidebar/scopes/workspace/{workspace['id']}",
            json=_put_payload(0),
        )
        stale = client.post(
            "/api/ui/right-sidebar/promotions",
            json={
                "source_scope_kind": "workspace",
                "source_scope_id": workspace["id"],
                "source_revision": 2,
                "target_session_id": session["id"],
            },
        )
        promoted = client.post(
            "/api/ui/right-sidebar/promotions",
            json={
                "source_scope_kind": "workspace",
                "source_scope_id": workspace["id"],
                "source_revision": saved.json()["revision"],
                "target_session_id": session["id"],
            },
        )
        replayed = client.post(
            "/api/ui/right-sidebar/promotions",
            json={
                "source_scope_kind": "workspace",
                "source_scope_id": workspace["id"],
                "source_revision": saved.json()["revision"],
                "target_session_id": session["id"],
            },
        )

    assert stale.status_code == 409
    assert stale.json()["detail"]["code"] == "right_sidebar_promotion_source_conflict"
    assert promoted.status_code == 200
    assert promoted.json()["target"]["scope_kind"] == "session"
    assert replayed.status_code == 200
    assert replayed.json()["idempotent_replay"] is True


@pytest.mark.parametrize("source_kind", ["workspace", "global"])
def test_scope_promotion_atomically_merges_web_annotation_resources(
    tmp_path,
    source_kind: str,
) -> None:
    project = tmp_path / f"project-{source_kind}"
    project.mkdir()
    with _client(tmp_path) as client:
        workspace = client.post(
            "/api/workspaces",
            json={"root_path": str(project), "name": "Project"},
        ).json()["workspace"]
        session = client.post(
            "/api/sessions",
            json={"title": "Target session"},
        ).json()["session"]
        source_id = workspace["id"] if source_kind == "workspace" else None
        source_scope = WebAnnotationScope(kind=source_kind, id=source_id)
        target_scope = WebAnnotationScope(kind="session", id=session["id"])
        source_path = (
            f"/api/ui/right-sidebar/scopes/workspace/{source_id}"
            if source_kind == "workspace"
            else "/api/ui/right-sidebar/scopes/global"
        )
        assert client.put(source_path, json=_put_payload(0)).status_code == 200
        assert (
            client.put(
                f"/api/ui/right-sidebar/scopes/session/{session['id']}",
                json=_put_payload(0),
            ).status_code
            == 200
        )

        web = client.app.state.repositories.web_annotations
        collision_url = "https://example.com/docs#collision"
        unique_url = "https://example.com/docs#source-only"
        target_request = _web_request(target_scope, collision_url, "target")
        source_request = _web_request(source_scope, collision_url, "source")
        unique_request = _web_request(source_scope, unique_url, "unique")
        target_resource = web.resources.create(
            scope=target_scope,
            identity=target_request.source.identity(),
            title="target",
            resource_id=f"target-resource-{source_kind}",
        )
        source_resource = web.resources.create(
            scope=source_scope,
            identity=source_request.source.identity(),
            title="source",
            canonical_url="https://example.com/docs",
            resource_id=f"source-resource-{source_kind}",
        )
        unique_resource = web.resources.create(
            scope=source_scope,
            identity=unique_request.source.identity(),
            title="unique",
            resource_id=f"unique-resource-{source_kind}",
        )
        target_annotation = web.annotations.create(
            resource_id=target_resource.id,
            target=target_request.target,
            body_markdown="target",
            tags=[],
            properties=[],
            annotation_id=f"target-annotation-{source_kind}",
        )
        source_annotation = web.annotations.create(
            resource_id=source_resource.id,
            target=source_request.target,
            body_markdown="source",
            tags=[],
            properties=[],
            annotation_id=f"source-annotation-{source_kind}",
        )
        unique_annotation = web.annotations.create(
            resource_id=unique_resource.id,
            target=unique_request.target,
            body_markdown="unique",
            tags=[],
            properties=[],
            annotation_id=f"unique-annotation-{source_kind}",
        )
        history = web.target_history.append(
            annotation_id=source_annotation.id,
            prior_revision=1,
            target=source_annotation.target,
            reason="migration",
            history_id=f"source-history-{source_kind}",
        )
        staged = web.assets.stage(
            resource_id=source_resource.id,
            storage_path=f"browser/captures/staged/source-{source_kind}/capture.png",
            mime_type="image/png",
            size_bytes=1,
            sha256="a" * 64,
            width=1,
            height=1,
            expires_at="2026-07-23T00:00:00Z",
            asset_id=f"source-asset-{source_kind}",
        )
        attached = web.assets.attach(
            asset_id=staged.id,
            annotation_id=source_annotation.id,
            resource_id=source_resource.id,
        )
        assert attached is not None

        promotion_payload = {
            "source_scope_kind": source_kind,
            "source_scope_id": source_id,
            "source_revision": 1,
            "target_session_id": session["id"],
        }
        promoted = client.post(
            "/api/ui/right-sidebar/promotions",
            json=promotion_payload,
        )
        replayed = client.post(
            "/api/ui/right-sidebar/promotions",
            json=promotion_payload,
        )

        assert promoted.status_code == 200
        assert promoted.json()["panel_id_mapping"]["files-1"] != "files-1"
        assert replayed.status_code == 200
        assert replayed.json()["idempotent_replay"] is True
        missing_source = client.get(source_path)
        assert missing_source.status_code == 200
        assert missing_source.json() is None
        assert web.resources.get(source_resource.id) is None
        collision = web.resources.find_by_identity(
            scope=target_scope,
            url_key=normalize_web_url(collision_url).url_key,
        )
        promoted_unique = web.resources.find_by_identity(
            scope=target_scope,
            url_key=normalize_web_url(unique_url).url_key,
        )
        assert collision is not None and collision.id == target_resource.id
        assert promoted_unique is not None and promoted_unique.id == unique_resource.id
        assert {item.id for item in web.annotations.list_by_resource(collision.id)} == {
            target_annotation.id,
            source_annotation.id,
        }
        assert web.annotations.list_by_resource(promoted_unique.id) == [unique_annotation]
        moved_asset = web.assets.get(staged.id)
        assert moved_asset is not None
        assert moved_asset.resource_id == target_resource.id
        assert moved_asset.annotation_id == source_annotation.id
        assert web.target_history.list_by_annotation(source_annotation.id) == [history]
        with client.app.state.repositories.db.connect() as conn:
            assert conn.execute("pragma foreign_key_check").fetchall() == []
    assert replayed.json()["panel_id_mapping"] == promoted.json()["panel_id_mapping"]
