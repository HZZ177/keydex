from __future__ import annotations

import sqlite3

import pytest

from backend.app.storage import Database, init_database


NOW = "2026-07-23T00:00:00Z"
URL_KEY = "a" * 64


def _downgrade_resource_table_to_v1(db: Database) -> None:
    with db.connect() as conn:
        conn.commit()
        conn.execute("pragma foreign_keys = off")
        conn.execute("pragma legacy_alter_table = on")
        conn.executescript(
            """
            begin immediate;
            drop index if exists idx_web_resources_session_url;
            drop index if exists idx_web_resources_workspace_url;
            drop index if exists idx_web_resources_global_url;
            drop index if exists idx_web_resources_document;

            alter table web_annotation_resources
              rename to web_annotation_resources_v2;

            create table web_annotation_resources (
              id text primary key,
              scope_kind text not null
                check (scope_kind in ('session', 'workspace', 'global')),
              session_id text,
              workspace_id text,
              normalization_version integer not null default 1
                check (normalization_version = 1),
              url_key text not null
                check (length(url_key) = 64 and lower(url_key) = url_key),
              url_normalized text not null check (length(url_normalized) > 0),
              document_url text not null check (length(document_url) > 0),
              canonical_url text,
              origin text not null check (length(origin) > 0),
              title text not null default '',
              page_fingerprint_json text,
              created_at text not null,
              updated_at text not null,
              check (
                (scope_kind = 'session' and session_id is not null and workspace_id is null)
                or (
                  scope_kind = 'workspace'
                  and session_id is null
                  and workspace_id is not null
                )
                or (
                  scope_kind = 'global'
                  and session_id is null
                  and workspace_id is null
                )
              ),
              foreign key(session_id) references sessions(id) on delete cascade,
              foreign key(workspace_id) references workspaces(id) on delete cascade
            );

            insert into web_annotation_resources (
              id, scope_kind, session_id, workspace_id, normalization_version,
              url_key, url_normalized, document_url, canonical_url, origin,
              title, page_fingerprint_json, created_at, updated_at
            )
            select
              id, scope_kind, session_id, workspace_id, normalization_version,
              url_key, url_normalized, document_url, canonical_url, origin,
              title, page_fingerprint_json, created_at, updated_at
            from web_annotation_resources_v2;

            drop table web_annotation_resources_v2;

            create unique index idx_web_resources_session_url
              on web_annotation_resources(session_id, url_key)
              where scope_kind = 'session';
            create unique index idx_web_resources_workspace_url
              on web_annotation_resources(workspace_id, url_key)
              where scope_kind = 'workspace';
            create unique index idx_web_resources_global_url
              on web_annotation_resources(scope_kind, url_key)
              where scope_kind = 'global';
            create index idx_web_resources_document
              on web_annotation_resources(scope_kind, document_url, updated_at desc);
            commit;
            """
        )
        conn.execute("pragma legacy_alter_table = off")
        conn.execute("pragma foreign_keys = on")


def _seed_complete_annotation_graph(db: Database) -> None:
    with db.transaction() as conn:
        conn.execute(
            """
            insert into sessions (
              id, user_id, scene_id, status, created_at, updated_at
            ) values ('session-1', 'user-1', 'scene-1', 'idle', ?, ?)
            """,
            (NOW, NOW),
        )
        conn.execute(
            """
            insert into web_annotation_resources (
              id, scope_kind, session_id, source_kind, normalization_version,
              url_key, url_normalized, document_url, canonical_url, origin,
              title, created_at, updated_at
            ) values (
              'resource-1', 'session', 'session-1', 'web', 1,
              ?, 'https://example.com/docs#api', 'https://example.com/docs',
              'https://example.com/docs', 'https://example.com', 'Docs', ?, ?
            )
            """,
            (URL_KEY, NOW, NOW),
        )
        conn.execute(
            """
            insert into web_annotations (
              id, resource_id, target_type, target_schema_version, target_json,
              body_markdown, tags_json, properties_json, revision, created_at, updated_at
            ) values (
              'annotation-1', 'resource-1', 'text', 1, '{"type":"text"}',
              'Keep me', '[]', '[]', 2, ?, ?
            )
            """,
            (NOW, NOW),
        )
        conn.execute(
            """
            insert into web_annotation_target_history (
              id, annotation_id, prior_revision, target_type,
              target_schema_version, target_json, reason, created_at
            ) values (
              'history-1', 'annotation-1', 1, 'text', 1,
              '{"type":"text"}', 'user_retarget', ?
            )
            """,
            (NOW,),
        )
        conn.execute(
            """
            insert into web_annotation_assets (
              id, resource_id, annotation_id, asset_kind, state, storage_path,
              mime_type, size_bytes, sha256, width, height, expires_at,
              created_at, updated_at
            ) values (
              'asset-1', 'resource-1', 'annotation-1', 'region_screenshot',
              'attached', 'web-annotations/asset-1.png', 'image/png', 10,
              ?, 2, 2, null, ?, ?
            )
            """,
            ("b" * 64, NOW, NOW),
        )


def test_new_schema_supports_web_v1_and_local_file_v2_only(tmp_path) -> None:
    db = init_database(tmp_path / "new.db")

    with db.connect() as conn:
        columns = {
            str(row["name"]): row
            for row in conn.execute("pragma table_info(web_annotation_resources)").fetchall()
        }
        index_sql = str(
            conn.execute(
                """
                select sql from sqlite_master
                where type = 'index' and name = 'idx_web_resources_document'
                """
            ).fetchone()["sql"]
        )
        conn.execute(
            """
            insert into web_annotation_resources (
              id, scope_kind, source_kind, normalization_version, url_key,
              url_normalized, document_url, origin, created_at, updated_at
            ) values (
              'local-1', 'global', 'local_file', 2, ?,
              'file:///D:/docs/index.html', 'file:///D:/docs/index.html',
              'file://', ?, ?
            )
            """,
            (URL_KEY, NOW, NOW),
        )
        with pytest.raises(sqlite3.IntegrityError):
            conn.execute(
                """
                insert into web_annotation_resources (
                  id, scope_kind, source_kind, normalization_version, url_key,
                  url_normalized, document_url, origin, created_at, updated_at
                ) values (
                  'invalid-local-v1', 'global', 'local_file', 1, ?,
                  'file:///D:/docs/index.html', 'file:///D:/docs/index.html',
                  'file://', ?, ?
                )
                """,
                ("c" * 64, NOW, NOW),
            )

    assert columns["source_kind"]["dflt_value"] == "'web'"
    assert columns["normalization_version"]["dflt_value"] == "1"
    assert "source_kind" in index_sql


def test_v1_resource_migration_preserves_graph_foreign_keys_and_is_idempotent(tmp_path) -> None:
    db = init_database(tmp_path / "legacy.db")
    _seed_complete_annotation_graph(db)
    _downgrade_resource_table_to_v1(db)

    db.init_schema()
    db.init_schema()

    with db.connect() as conn:
        resource = conn.execute(
            """
            select source_kind, normalization_version, url_key, title
            from web_annotation_resources where id = 'resource-1'
            """
        ).fetchone()
        graph_counts = {
            table: int(conn.execute(f"select count(*) from {table}").fetchone()[0])
            for table in (
                "web_annotation_resources",
                "web_annotations",
                "web_annotation_target_history",
                "web_annotation_assets",
            )
        }
        annotation = conn.execute(
            """
            select id, resource_id, target_json, body_markdown, revision,
                   created_at, updated_at
            from web_annotations where id = 'annotation-1'
            """
        ).fetchone()
        history = conn.execute(
            """
            select id, annotation_id, prior_revision, target_json, reason, created_at
            from web_annotation_target_history where id = 'history-1'
            """
        ).fetchone()
        asset = conn.execute(
            """
            select id, resource_id, annotation_id, storage_path, sha256,
                   created_at, updated_at
            from web_annotation_assets where id = 'asset-1'
            """
        ).fetchone()
        foreign_key_errors = conn.execute("pragma foreign_key_check").fetchall()
        child_targets = {
            str(row["table"])
            for table in ("web_annotations", "web_annotation_assets")
            for row in conn.execute(f"pragma foreign_key_list({table})").fetchall()
            if str(row["from"]) == "resource_id"
        }

    assert dict(resource) == {
        "source_kind": "web",
        "normalization_version": 1,
        "url_key": URL_KEY,
        "title": "Docs",
    }
    assert graph_counts == {
        "web_annotation_resources": 1,
        "web_annotations": 1,
        "web_annotation_target_history": 1,
        "web_annotation_assets": 1,
    }
    assert dict(annotation) == {
        "id": "annotation-1",
        "resource_id": "resource-1",
        "target_json": '{"type":"text"}',
        "body_markdown": "Keep me",
        "revision": 2,
        "created_at": NOW,
        "updated_at": NOW,
    }
    assert dict(history) == {
        "id": "history-1",
        "annotation_id": "annotation-1",
        "prior_revision": 1,
        "target_json": '{"type":"text"}',
        "reason": "user_retarget",
        "created_at": NOW,
    }
    assert dict(asset) == {
        "id": "asset-1",
        "resource_id": "resource-1",
        "annotation_id": "annotation-1",
        "storage_path": "web-annotations/asset-1.png",
        "sha256": "b" * 64,
        "created_at": NOW,
        "updated_at": NOW,
    }
    assert foreign_key_errors == []
    assert child_targets == {"web_annotation_resources", "web_annotations"}
    assert all("legacy" not in target for target in child_targets)


def test_v1_resource_migration_rolls_back_when_legacy_row_is_invalid(tmp_path) -> None:
    db = Database(tmp_path / "invalid-legacy.db")
    with db.connect() as conn:
        conn.execute(
            """
            create table web_annotation_resources (
              id text primary key,
              scope_kind text not null,
              session_id text,
              workspace_id text,
              normalization_version integer not null,
              url_key text not null,
              url_normalized text not null,
              document_url text not null,
              canonical_url text,
              origin text not null,
              title text not null default '',
              page_fingerprint_json text,
              created_at text not null,
              updated_at text not null
            )
            """
        )
        conn.execute(
            """
            insert into web_annotation_resources (
              id, scope_kind, normalization_version, url_key, url_normalized,
              document_url, origin, created_at, updated_at
            ) values (
              'invalid-v2', 'global', 2, ?, 'https://example.com',
              'https://example.com', 'https://example.com', ?, ?
            )
            """,
            (URL_KEY, NOW, NOW),
        )

        with pytest.raises(sqlite3.IntegrityError):
            Database._migrate_web_annotation_resource_identity_schema(conn)

        columns = {
            str(row["name"])
            for row in conn.execute("pragma table_info(web_annotation_resources)").fetchall()
        }
        preserved = conn.execute(
            "select id, normalization_version from web_annotation_resources"
        ).fetchone()
        legacy_tables = conn.execute(
            """
            select name from sqlite_master
            where type = 'table' and name like 'web_annotation_resources_legacy%'
            """
        ).fetchall()

    assert "source_kind" not in columns
    assert dict(preserved) == {"id": "invalid-v2", "normalization_version": 2}
    assert legacy_tables == []
