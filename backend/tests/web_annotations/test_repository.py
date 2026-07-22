from __future__ import annotations

import sqlite3

import pytest
from pydantic import ValidationError

from backend.app.storage import StorageRepositories, init_database
from backend.app.web_annotations.models import WebAnnotationCreateRequest, WebAnnotationScope
from backend.app.web_annotations.url_identity import normalize_web_url


def _insert_session(db, session_id: str) -> None:
    with db.transaction() as conn:
        conn.execute(
            """
            insert into sessions (
              id, user_id, scene_id, status, created_at, updated_at
            ) values (?, 'user-1', 'scene-1', 'idle', ?, ?)
            """,
            (session_id, "2026-07-22T00:00:00Z", "2026-07-22T00:00:00Z"),
        )


def _request() -> WebAnnotationCreateRequest:
    return WebAnnotationCreateRequest.model_validate(
        {
            "scope": {"kind": "session", "id": "session-1"},
            "source": {
                "url": "https://example.com/docs?page=1&token=secret#api",
                "title": "Example Docs",
                "canonical_url": "https://example.com/docs",
            },
            "target": {
                "type": "text",
                "quote": {
                    "exact": "Selected text",
                    "prefix": "Before ",
                    "suffix": " after",
                },
                "position": {"start": 10, "end": 23, "text_model_version": 1},
                "context": {"heading_path": ["API"]},
                "rects": [{"x": 10, "y": 20, "width": 120, "height": 18}],
                "frame": {
                    "url": "https://example.com/docs?page=1&token=secret",
                    "index_path": [],
                },
            },
            "body_markdown": "这里需要确认。",
            "tags": ["P1", " p1 ", "待确认"],
            "properties": [
                {"key": "priority", "type": "text", "value": "high"},
                {"key": "verified", "type": "boolean", "value": False},
            ],
            "staged_asset_ids": [],
        }
    )


def test_schema_is_idempotent_and_keeps_file_annotation_table_unchanged(tmp_path) -> None:
    db_path = tmp_path / "app.db"
    init_database(db_path)
    db = init_database(db_path)

    with db.connect() as conn:
        tables = {
            str(row["name"])
            for row in conn.execute("select name from sqlite_master where type = 'table'")
        }
        indexes = {
            str(row["name"])
            for row in conn.execute("select name from sqlite_master where type = 'index'")
        }
        file_annotation_columns = {
            str(row["name"])
            for row in conn.execute("pragma table_info(workspace_annotations)").fetchall()
        }

    assert {
        "web_annotation_resources",
        "web_annotations",
        "web_annotation_target_history",
        "web_annotation_assets",
    }.issubset(tables)
    assert {
        "idx_web_resources_session_url",
        "idx_web_resources_workspace_url",
        "idx_web_resources_global_url",
        "idx_web_resources_document",
        "idx_web_annotations_resource_created",
        "idx_web_annotations_resource_updated",
        "idx_web_target_history_revision",
        "idx_web_annotation_assets_path",
        "idx_web_annotation_assets_staged_expiry",
        "idx_web_annotation_assets_annotation",
    }.issubset(indexes)
    assert file_annotation_columns == {
        "id",
        "workspace_id",
        "document_path",
        "target_type",
        "selector_json",
        "body",
        "created_at",
        "updated_at",
    }


def test_schema_enforces_scope_target_asset_and_unique_identity_checks(tmp_path) -> None:
    db = init_database(tmp_path / "app.db")
    _insert_session(db, "session-1")
    _insert_session(db, "session-2")
    identity = normalize_web_url("https://example.com/docs")
    repositories = StorageRepositories(db).web_annotations
    scope_one = WebAnnotationScope(kind="session", id="session-1")
    scope_two = WebAnnotationScope(kind="session", id="session-2")

    first = repositories.resources.create(
        scope=scope_one,
        identity=identity,
        resource_id="resource-1",
    )
    with pytest.raises(sqlite3.IntegrityError):
        repositories.resources.create(
            scope=scope_one,
            identity=identity,
            resource_id="resource-duplicate",
        )
    repositories.resources.create(
        scope=scope_two,
        identity=identity,
        resource_id="resource-other-scope",
    )

    with db.transaction() as conn:
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                """
                insert into web_annotation_resources (
                  id, scope_kind, normalization_version, url_key, url_normalized,
                  document_url, origin, title, created_at, updated_at
                ) values (
                  'invalid-scope', 'session', 1, ?, ?, ?, ?, '', ?, ?
                )
                """,
                (
                    "0" * 64,
                    "https://example.com/invalid",
                    "https://example.com/invalid",
                    "https://example.com",
                    "2026-07-22T00:00:00Z",
                    "2026-07-22T00:00:00Z",
                ),
            )
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                """
                insert into web_annotations (
                  id, resource_id, target_type, target_schema_version, target_json,
                  body_markdown, tags_json, properties_json, revision, created_at, updated_at
                ) values (
                  'invalid-target', ?, 'document', 1, '{}', '', '[]', '[]', 1, ?, ?
                )
                """,
                (
                    first.id,
                    "2026-07-22T00:00:00Z",
                    "2026-07-22T00:00:00Z",
                ),
            )
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                """
                insert into web_annotation_assets (
                  id, resource_id, asset_kind, state, storage_path, mime_type,
                  size_bytes, sha256, width, height, expires_at, created_at, updated_at
                ) values (
                  'invalid-asset', ?, 'region_screenshot', 'staged', 'invalid.png',
                  'image/png', 1, ?, 1, 1, null, ?, ?
                )
                """,
                (
                    first.id,
                    "a" * 64,
                    "2026-07-22T00:00:00Z",
                    "2026-07-22T00:00:00Z",
                ),
            )


def test_repository_roundtrip_transaction_and_foreign_key_cascade(tmp_path) -> None:
    db = init_database(tmp_path / "app.db")
    _insert_session(db, "session-1")
    repositories = StorageRepositories(db).web_annotations
    request = _request()

    resource = repositories.resources.create(
        scope=request.scope,
        identity=request.source.identity(),
        title=request.source.title,
        canonical_url=request.source.canonical_url,
        resource_id="resource-1",
    )
    annotation = repositories.annotations.create(
        resource_id=resource.id,
        target=request.target,
        body_markdown=request.body_markdown,
        tags=request.tags,
        properties=request.properties,
        annotation_id="annotation-1",
    )
    history = repositories.target_history.append(
        annotation_id=annotation.id,
        prior_revision=annotation.revision,
        target=annotation.target,
        reason="migration",
        history_id="history-1",
    )
    staged = repositories.assets.stage(
        resource_id=resource.id,
        storage_path="web-annotations/e2e-region.png",
        mime_type="image/png",
        size_bytes=128,
        sha256="a" * 64,
        width=20,
        height=10,
        expires_at="2026-07-23T00:00:00Z",
        asset_id="asset-1",
    )
    attached = repositories.assets.attach(
        asset_id=staged.id,
        annotation_id=annotation.id,
        resource_id=resource.id,
    )

    assert (
        repositories.resources.find_by_identity(
            scope=request.scope,
            url_key=resource.url_key,
        )
        == resource
    )
    assert repositories.resources.list_by_document(
        scope=request.scope,
        document_url=resource.document_url,
    ) == [resource]
    assert repositories.annotations.get(annotation.id) == annotation
    assert repositories.annotations.list_by_resource(resource.id) == [annotation]
    assert repositories.target_history.list_by_annotation(annotation.id) == [history]
    assert attached is not None
    assert attached.state == "attached"
    assert attached.annotation_id == annotation.id
    assert attached.expires_at is None
    assert repositories.assets.list_by_annotation(annotation.id) == [attached]

    with db.transaction() as conn:
        conn.execute("delete from sessions where id = 'session-1'")
    with db.connect() as conn:
        counts = {
            table: int(conn.execute(f"select count(*) from {table}").fetchone()[0])
            for table in (
                "web_annotation_resources",
                "web_annotations",
                "web_annotation_target_history",
                "web_annotation_assets",
            )
        }
    assert counts == {
        "web_annotation_resources": 0,
        "web_annotations": 0,
        "web_annotation_target_history": 0,
        "web_annotation_assets": 0,
    }


def test_repository_uses_caller_transaction_and_rolls_back_as_one_unit(tmp_path) -> None:
    db = init_database(tmp_path / "app.db")
    _insert_session(db, "session-1")
    repositories = StorageRepositories(db).web_annotations
    request = _request()

    with pytest.raises(RuntimeError, match="force rollback"):
        with db.transaction(immediate=True) as conn:
            resource = repositories.resources.create(
                scope=request.scope,
                identity=request.source.identity(),
                resource_id="resource-rollback",
                connection=conn,
            )
            repositories.annotations.create(
                resource_id=resource.id,
                target=request.target,
                body_markdown=request.body_markdown,
                tags=request.tags,
                properties=request.properties,
                annotation_id="annotation-rollback",
                connection=conn,
            )
            raise RuntimeError("force rollback")

    assert repositories.resources.get("resource-rollback") is None
    assert repositories.annotations.get("annotation-rollback") is None


def test_repository_revalidates_json_rows_and_rejects_shape_drift(tmp_path) -> None:
    db = init_database(tmp_path / "app.db")
    _insert_session(db, "session-1")
    repositories = StorageRepositories(db).web_annotations
    request = _request()
    resource = repositories.resources.create(
        scope=request.scope,
        identity=request.source.identity(),
        resource_id="resource-1",
    )
    annotation = repositories.annotations.create(
        resource_id=resource.id,
        target=request.target,
        body_markdown=request.body_markdown,
        tags=request.tags,
        properties=request.properties,
        annotation_id="annotation-1",
    )
    with db.transaction() as conn:
        conn.execute(
            """
            update web_annotations
            set target_json = json_set(target_json, '$.outer_html', '<secret>')
            where id = ?
            """,
            (annotation.id,),
        )

    with pytest.raises(ValidationError):
        repositories.annotations.get(annotation.id)
