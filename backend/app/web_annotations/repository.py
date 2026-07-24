from __future__ import annotations

import json
import sqlite3
from contextlib import nullcontext
from typing import Literal, cast

from pydantic import TypeAdapter

from backend.app.core.ids import new_id
from backend.app.core.time import to_iso_z, utc_now
from backend.app.storage.db import Database
from backend.app.web_annotations.models import (
    TypedProperty,
    WebAnnotationAssetRecord,
    WebAnnotationAttachmentCloneRecord,
    WebAnnotationRecord,
    WebAnnotationResourceRecord,
    WebAnnotationScope,
    WebAnnotationTarget,
    WebAnnotationTargetHistoryRecord,
)
from backend.app.web_annotations.url_identity import WebUrlIdentity

_TARGET_ADAPTER = TypeAdapter(WebAnnotationTarget)
_PROPERTIES_ADAPTER = TypeAdapter(list[TypedProperty])
_TAGS_ADAPTER = TypeAdapter(list[str])
TargetHistoryReason = Literal["user_retarget", "migration"]
AssetMimeType = Literal["image/png", "image/jpeg", "image/webp"]


class WebAnnotationRevisionConflict(Exception):
    def __init__(self, current: WebAnnotationRecord) -> None:
        super().__init__("Web annotation revision conflict")
        self.current = current


class WebAnnotationResourcesRepository:
    def __init__(self, db: Database) -> None:
        self.db = db

    def create(
        self,
        *,
        scope: WebAnnotationScope,
        identity: WebUrlIdentity,
        title: str = "",
        canonical_url: str | None = None,
        resource_id: str | None = None,
        connection: sqlite3.Connection | None = None,
    ) -> WebAnnotationResourceRecord:
        resolved_id = resource_id or new_id()
        now = to_iso_z(utc_now())
        candidate = WebAnnotationResourceRecord(
            id=resolved_id,
            scope=scope,
            source_kind=identity.source_kind,
            normalization_version=identity.normalization_version,
            url_key=identity.url_key,
            url_normalized=identity.url_normalized,
            document_url=identity.document_url,
            canonical_url=canonical_url,
            origin=identity.origin,
            title=title,
            created_at=now,
            updated_at=now,
        )
        session_id, workspace_id = _scope_storage_values(scope)
        transaction = (
            nullcontext(connection)
            if connection is not None
            else self.db.transaction(immediate=True)
        )
        with transaction as conn:
            conn.execute(
                """
                insert into web_annotation_resources (
                  id, scope_kind, session_id, workspace_id, source_kind,
                  normalization_version, url_key, url_normalized, document_url,
                  canonical_url, origin, title, created_at, updated_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    candidate.id,
                    candidate.scope.kind,
                    session_id,
                    workspace_id,
                    candidate.source_kind,
                    candidate.normalization_version,
                    candidate.url_key,
                    candidate.url_normalized,
                    candidate.document_url,
                    candidate.canonical_url,
                    candidate.origin,
                    candidate.title,
                    candidate.created_at,
                    candidate.updated_at,
                ),
            )
            row = conn.execute(
                "select * from web_annotation_resources where id = ?",
                (candidate.id,),
            ).fetchone()
        if row is None:
            raise RuntimeError("Created web annotation resource cannot be loaded")
        return _resource_from_row(row)

    def upsert(
        self,
        *,
        scope: WebAnnotationScope,
        identity: WebUrlIdentity,
        title: str = "",
        canonical_url: str | None = None,
        connection: sqlite3.Connection | None = None,
    ) -> WebAnnotationResourceRecord:
        transaction = (
            nullcontext(connection)
            if connection is not None
            else self.db.transaction(immediate=True)
        )
        with transaction as conn:
            current_row = _find_resource_row(
                conn,
                scope=scope,
                source_kind=identity.source_kind,
                url_key=identity.url_key,
            )
            if current_row is None:
                return self.create(
                    scope=scope,
                    identity=identity,
                    title=title,
                    canonical_url=canonical_url,
                    connection=conn,
                )
            current = _resource_from_row(current_row)
            candidate = WebAnnotationResourceRecord(
                id=current.id,
                scope=current.scope,
                source_kind=identity.source_kind,
                normalization_version=identity.normalization_version,
                url_key=identity.url_key,
                url_normalized=identity.url_normalized,
                document_url=identity.document_url,
                canonical_url=canonical_url or current.canonical_url,
                origin=identity.origin,
                title=title or current.title,
                created_at=current.created_at,
                updated_at=to_iso_z(utc_now()),
            )
            conn.execute(
                """
                update web_annotation_resources
                set source_kind = ?, normalization_version = ?, url_normalized = ?,
                    document_url = ?, canonical_url = ?, origin = ?, title = ?,
                    updated_at = ?
                where id = ?
                """,
                (
                    candidate.source_kind,
                    candidate.normalization_version,
                    candidate.url_normalized,
                    candidate.document_url,
                    candidate.canonical_url,
                    candidate.origin,
                    candidate.title,
                    candidate.updated_at,
                    candidate.id,
                ),
            )
            row = conn.execute(
                "select * from web_annotation_resources where id = ?",
                (candidate.id,),
            ).fetchone()
        if row is None:
            raise RuntimeError("Upserted web annotation resource cannot be loaded")
        return _resource_from_row(row)

    def get(
        self,
        resource_id: str,
        *,
        connection: sqlite3.Connection | None = None,
    ) -> WebAnnotationResourceRecord | None:
        transaction = nullcontext(connection) if connection is not None else self.db.connect()
        with transaction as conn:
            row = conn.execute(
                "select * from web_annotation_resources where id = ?",
                (resource_id,),
            ).fetchone()
        return _resource_from_row(row) if row is not None else None

    def find_by_identity(
        self,
        *,
        scope: WebAnnotationScope,
        url_key: str,
        source_kind: Literal["web", "local_file"] = "web",
    ) -> WebAnnotationResourceRecord | None:
        query, params = _scope_resource_query(
            scope,
            "source_kind = ? and url_key = ?",
            (source_kind, url_key),
        )
        with self.db.connect() as conn:
            row = conn.execute(query, params).fetchone()
        return _resource_from_row(row) if row is not None else None

    def list_by_document(
        self,
        *,
        scope: WebAnnotationScope,
        document_url: str,
        source_kind: Literal["web", "local_file"] = "web",
    ) -> list[WebAnnotationResourceRecord]:
        query, params = _scope_resource_query(
            scope,
            "source_kind = ? and document_url = ?",
            (source_kind, document_url),
            order_by="updated_at desc, id desc",
        )
        with self.db.connect() as conn:
            rows = conn.execute(query, params).fetchall()
        return [_resource_from_row(row) for row in rows]

    def delete(self, resource_id: str) -> bool:
        with self.db.transaction(immediate=True) as conn:
            cursor = conn.execute(
                "delete from web_annotation_resources where id = ?",
                (resource_id,),
            )
        return cursor.rowcount > 0


class WebAnnotationsRepository:
    def __init__(self, db: Database) -> None:
        self.db = db

    def create(
        self,
        *,
        resource_id: str,
        target: WebAnnotationTarget,
        body_markdown: str,
        tags: list[str],
        properties: list[TypedProperty],
        annotation_id: str | None = None,
        connection: sqlite3.Connection | None = None,
    ) -> WebAnnotationRecord:
        resolved_id = annotation_id or new_id()
        now = to_iso_z(utc_now())
        candidate = WebAnnotationRecord(
            id=resolved_id,
            resource_id=resource_id,
            target_schema_version=1,
            target=target,
            body_markdown=body_markdown,
            tags=tags,
            properties=properties,
            revision=1,
            created_at=now,
            updated_at=now,
        )
        transaction = (
            nullcontext(connection)
            if connection is not None
            else self.db.transaction(immediate=True)
        )
        with transaction as conn:
            conn.execute(
                """
                insert into web_annotations (
                  id, resource_id, target_type, target_schema_version, target_json,
                  body_markdown, tags_json, properties_json, revision, created_at, updated_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    candidate.id,
                    candidate.resource_id,
                    candidate.target.type,
                    candidate.target_schema_version,
                    _model_json(candidate.target),
                    candidate.body_markdown,
                    _json_dumps(candidate.tags),
                    _json_dumps([item.model_dump(mode="json") for item in candidate.properties]),
                    candidate.revision,
                    candidate.created_at,
                    candidate.updated_at,
                ),
            )
            row = conn.execute(
                "select * from web_annotations where id = ?",
                (candidate.id,),
            ).fetchone()
        if row is None:
            raise RuntimeError("Created web annotation cannot be loaded")
        return _annotation_from_row(row)

    def get(
        self,
        annotation_id: str,
        *,
        connection: sqlite3.Connection | None = None,
    ) -> WebAnnotationRecord | None:
        transaction = nullcontext(connection) if connection is not None else self.db.connect()
        with transaction as conn:
            row = conn.execute(
                "select * from web_annotations where id = ?",
                (annotation_id,),
            ).fetchone()
        return _annotation_from_row(row) if row is not None else None

    def list_by_resource(self, resource_id: str) -> list[WebAnnotationRecord]:
        with self.db.connect() as conn:
            rows = conn.execute(
                """
                select * from web_annotations
                where resource_id = ?
                order by created_at asc, id asc
                """,
                (resource_id,),
            ).fetchall()
        return [_annotation_from_row(row) for row in rows]

    def list_page(
        self,
        *,
        resource_ids: list[str],
        limit: int,
        before: tuple[str, str] | None = None,
    ) -> tuple[list[WebAnnotationRecord], bool]:
        if not resource_ids:
            return [], False
        if limit < 1 or limit > 100:
            raise ValueError("web annotation page limit must be between 1 and 100")
        placeholders = ",".join("?" for _ in resource_ids)
        query = f"select * from web_annotations where resource_id in ({placeholders})"
        params: list[object] = list(resource_ids)
        if before is not None:
            query += " and (updated_at < ? or (updated_at = ? and id < ?))"
            params.extend((before[0], before[0], before[1]))
        query += " order by updated_at desc, id desc limit ?"
        params.append(limit + 1)
        with self.db.connect() as conn:
            rows = conn.execute(query, params).fetchall()
        has_more = len(rows) > limit
        return [_annotation_from_row(row) for row in rows[:limit]], has_more

    def patch(
        self,
        annotation_id: str,
        *,
        expected_revision: int,
        body_markdown: str | None,
        tags: list[str] | None,
        properties: list[TypedProperty] | None,
    ) -> WebAnnotationRecord | None:
        with self.db.transaction(immediate=True) as conn:
            row = conn.execute(
                "select * from web_annotations where id = ?",
                (annotation_id,),
            ).fetchone()
            if row is None:
                return None
            current = _annotation_from_row(row)
            if current.revision != expected_revision:
                raise WebAnnotationRevisionConflict(current)
            candidate = WebAnnotationRecord(
                id=current.id,
                resource_id=current.resource_id,
                target_schema_version=current.target_schema_version,
                target=current.target,
                body_markdown=(
                    body_markdown if body_markdown is not None else current.body_markdown
                ),
                tags=tags if tags is not None else current.tags,
                properties=properties if properties is not None else current.properties,
                revision=current.revision + 1,
                created_at=current.created_at,
                updated_at=to_iso_z(utc_now()),
            )
            cursor = conn.execute(
                """
                update web_annotations
                set body_markdown = ?, tags_json = ?, properties_json = ?,
                    revision = ?, updated_at = ?
                where id = ? and revision = ?
                """,
                (
                    candidate.body_markdown,
                    _json_dumps(candidate.tags),
                    _json_dumps([item.model_dump(mode="json") for item in candidate.properties]),
                    candidate.revision,
                    candidate.updated_at,
                    annotation_id,
                    expected_revision,
                ),
            )
            if cursor.rowcount != 1:
                latest = conn.execute(
                    "select * from web_annotations where id = ?",
                    (annotation_id,),
                ).fetchone()
                if latest is None:
                    return None
                raise WebAnnotationRevisionConflict(_annotation_from_row(latest))
            saved = conn.execute(
                "select * from web_annotations where id = ?",
                (annotation_id,),
            ).fetchone()
        if saved is None:
            raise RuntimeError("Updated web annotation cannot be loaded")
        return _annotation_from_row(saved)

    def replace_target_with_history(
        self,
        annotation_id: str,
        *,
        expected_revision: int,
        target: WebAnnotationTarget,
        reason: TargetHistoryReason = "user_retarget",
        connection: sqlite3.Connection | None = None,
    ) -> WebAnnotationRecord | None:
        transaction = (
            nullcontext(connection)
            if connection is not None
            else self.db.transaction(immediate=True)
        )
        with transaction as conn:
            row = conn.execute(
                "select * from web_annotations where id = ?",
                (annotation_id,),
            ).fetchone()
            if row is None:
                return None
            current = _annotation_from_row(row)
            if current.revision != expected_revision:
                raise WebAnnotationRevisionConflict(current)
            history = WebAnnotationTargetHistoryRecord(
                id=new_id(),
                annotation_id=current.id,
                prior_revision=current.revision,
                target_schema_version=current.target_schema_version,
                target=current.target,
                reason=reason,
                created_at=to_iso_z(utc_now()),
            )
            conn.execute(
                """
                insert into web_annotation_target_history (
                  id, annotation_id, prior_revision, target_type,
                  target_schema_version, target_json, reason, created_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    history.id,
                    history.annotation_id,
                    history.prior_revision,
                    history.target.type,
                    history.target_schema_version,
                    _model_json(history.target),
                    history.reason,
                    history.created_at,
                ),
            )
            updated_at = to_iso_z(utc_now())
            cursor = conn.execute(
                """
                update web_annotations
                set target_type = ?, target_schema_version = 1, target_json = ?,
                    revision = revision + 1, updated_at = ?
                where id = ? and revision = ?
                """,
                (
                    target.type,
                    _model_json(target),
                    updated_at,
                    annotation_id,
                    expected_revision,
                ),
            )
            if cursor.rowcount != 1:
                latest = conn.execute(
                    "select * from web_annotations where id = ?",
                    (annotation_id,),
                ).fetchone()
                if latest is None:
                    return None
                raise WebAnnotationRevisionConflict(_annotation_from_row(latest))
            saved = conn.execute(
                "select * from web_annotations where id = ?",
                (annotation_id,),
            ).fetchone()
        if saved is None:
            raise RuntimeError("Retargeted web annotation cannot be loaded")
        return _annotation_from_row(saved)

    def delete(self, annotation_id: str) -> bool:
        with self.db.transaction(immediate=True) as conn:
            cursor = conn.execute(
                "delete from web_annotations where id = ?",
                (annotation_id,),
            )
        return cursor.rowcount > 0


class WebAnnotationTargetHistoryRepository:
    def __init__(self, db: Database) -> None:
        self.db = db

    def append(
        self,
        *,
        annotation_id: str,
        prior_revision: int,
        target: WebAnnotationTarget,
        reason: TargetHistoryReason,
        history_id: str | None = None,
        connection: sqlite3.Connection | None = None,
    ) -> WebAnnotationTargetHistoryRecord:
        resolved_id = history_id or new_id()
        candidate = WebAnnotationTargetHistoryRecord(
            id=resolved_id,
            annotation_id=annotation_id,
            prior_revision=prior_revision,
            target_schema_version=1,
            target=target,
            reason=reason,
            created_at=to_iso_z(utc_now()),
        )
        transaction = (
            nullcontext(connection)
            if connection is not None
            else self.db.transaction(immediate=True)
        )
        with transaction as conn:
            conn.execute(
                """
                insert into web_annotation_target_history (
                  id, annotation_id, prior_revision, target_type,
                  target_schema_version, target_json, reason, created_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    candidate.id,
                    candidate.annotation_id,
                    candidate.prior_revision,
                    candidate.target.type,
                    candidate.target_schema_version,
                    _model_json(candidate.target),
                    candidate.reason,
                    candidate.created_at,
                ),
            )
            row = conn.execute(
                "select * from web_annotation_target_history where id = ?",
                (candidate.id,),
            ).fetchone()
        if row is None:
            raise RuntimeError("Created web annotation target history cannot be loaded")
        return _target_history_from_row(row)

    def list_by_annotation(self, annotation_id: str) -> list[WebAnnotationTargetHistoryRecord]:
        with self.db.connect() as conn:
            rows = conn.execute(
                """
                select * from web_annotation_target_history
                where annotation_id = ?
                order by prior_revision asc, id asc
                """,
                (annotation_id,),
            ).fetchall()
        return [_target_history_from_row(row) for row in rows]


class WebAnnotationAssetsRepository:
    def __init__(self, db: Database) -> None:
        self.db = db

    def stage(
        self,
        *,
        resource_id: str,
        storage_path: str,
        mime_type: AssetMimeType,
        size_bytes: int,
        sha256: str,
        width: int,
        height: int,
        expires_at: str,
        asset_id: str | None = None,
        connection: sqlite3.Connection | None = None,
    ) -> WebAnnotationAssetRecord:
        resolved_id = asset_id or new_id()
        now = to_iso_z(utc_now())
        candidate = WebAnnotationAssetRecord(
            id=resolved_id,
            resource_id=resource_id,
            annotation_id=None,
            asset_kind="region_screenshot",
            state="staged",
            storage_path=storage_path,
            mime_type=mime_type,
            size_bytes=size_bytes,
            sha256=sha256,
            width=width,
            height=height,
            expires_at=expires_at,
            created_at=now,
            updated_at=now,
        )
        transaction = (
            nullcontext(connection)
            if connection is not None
            else self.db.transaction(immediate=True)
        )
        with transaction as conn:
            conn.execute(
                """
                insert into web_annotation_assets (
                  id, resource_id, annotation_id, asset_kind, state, storage_path,
                  mime_type, size_bytes, sha256, width, height, expires_at,
                  created_at, updated_at
                ) values (?, ?, null, ?, 'staged', ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    candidate.id,
                    candidate.resource_id,
                    candidate.asset_kind,
                    candidate.storage_path,
                    candidate.mime_type,
                    candidate.size_bytes,
                    candidate.sha256,
                    candidate.width,
                    candidate.height,
                    candidate.expires_at,
                    candidate.created_at,
                    candidate.updated_at,
                ),
            )
            row = conn.execute(
                "select * from web_annotation_assets where id = ?",
                (candidate.id,),
            ).fetchone()
        if row is None:
            raise RuntimeError("Created web annotation asset cannot be loaded")
        return _asset_from_row(row)

    def get(
        self,
        asset_id: str,
        *,
        connection: sqlite3.Connection | None = None,
    ) -> WebAnnotationAssetRecord | None:
        transaction = nullcontext(connection) if connection is not None else self.db.connect()
        with transaction as conn:
            row = conn.execute(
                "select * from web_annotation_assets where id = ?",
                (asset_id,),
            ).fetchone()
        return _asset_from_row(row) if row is not None else None

    def list_by_annotation(self, annotation_id: str) -> list[WebAnnotationAssetRecord]:
        with self.db.connect() as conn:
            rows = conn.execute(
                """
                select * from web_annotation_assets
                where annotation_id = ?
                order by created_at asc, id asc
                """,
                (annotation_id,),
            ).fetchall()
        return [_asset_from_row(row) for row in rows]

    def list_expired_staged(
        self,
        *,
        expires_at_or_before: str,
        limit: int = 100,
    ) -> list[WebAnnotationAssetRecord]:
        if limit < 1 or limit > 1_000:
            raise ValueError("expired web annotation asset limit must be between 1 and 1000")
        with self.db.connect() as conn:
            rows = conn.execute(
                """
                select * from web_annotation_assets
                where state = 'staged' and expires_at <= ?
                order by expires_at asc, id asc
                limit ?
                """,
                (expires_at_or_before, limit),
            ).fetchall()
        return [_asset_from_row(row) for row in rows]

    def attach(
        self,
        *,
        asset_id: str,
        annotation_id: str,
        resource_id: str,
        connection: sqlite3.Connection | None = None,
    ) -> WebAnnotationAssetRecord | None:
        transaction = (
            nullcontext(connection)
            if connection is not None
            else self.db.transaction(immediate=True)
        )
        with transaction as conn:
            cursor = conn.execute(
                """
                update web_annotation_assets
                set annotation_id = ?, state = 'attached', expires_at = null, updated_at = ?
                where id = ? and resource_id = ? and state = 'staged'
                  and exists (
                    select 1 from web_annotations
                    where web_annotations.id = ?
                      and web_annotations.resource_id = web_annotation_assets.resource_id
                  )
                """,
                (
                    annotation_id,
                    to_iso_z(utc_now()),
                    asset_id,
                    resource_id,
                    annotation_id,
                ),
            )
            row = conn.execute(
                "select * from web_annotation_assets where id = ?",
                (asset_id,),
            ).fetchone()
        if cursor.rowcount != 1:
            return None
        if row is None:
            raise RuntimeError("Attached web annotation asset cannot be loaded")
        return _asset_from_row(row)

    def delete_staged(self, asset_id: str) -> bool:
        with self.db.transaction(immediate=True) as conn:
            cursor = conn.execute(
                "delete from web_annotation_assets where id = ? and state = 'staged'",
                (asset_id,),
            )
        return cursor.rowcount > 0


class WebAnnotationAttachmentClonesRepository:
    def __init__(self, db: Database) -> None:
        self.db = db

    def get(
        self,
        *,
        session_id: str,
        annotation_id: str,
        asset_id: str,
        context_digest: str,
        connection: sqlite3.Connection | None = None,
    ) -> WebAnnotationAttachmentCloneRecord | None:
        transaction = nullcontext(connection) if connection is not None else self.db.connect()
        with transaction as conn:
            row = conn.execute(
                """
                select * from web_annotation_attachment_clones
                where session_id = ? and annotation_id = ? and asset_id = ?
                  and context_digest = ?
                """,
                (session_id, annotation_id, asset_id, context_digest),
            ).fetchone()
        return _attachment_clone_from_row(row) if row is not None else None

    def create(
        self,
        *,
        session_id: str,
        annotation_id: str,
        asset_id: str,
        context_digest: str,
        attachment_id: str,
        connection: sqlite3.Connection,
    ) -> WebAnnotationAttachmentCloneRecord:
        record = WebAnnotationAttachmentCloneRecord(
            id=new_id(),
            session_id=session_id,
            annotation_id=annotation_id,
            asset_id=asset_id,
            context_digest=context_digest,
            attachment_id=attachment_id,
            created_at=to_iso_z(utc_now()),
        )
        connection.execute(
            """
            insert into web_annotation_attachment_clones (
              id, session_id, annotation_id, asset_id, context_digest,
              attachment_id, created_at
            ) values (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                record.id,
                record.session_id,
                record.annotation_id,
                record.asset_id,
                record.context_digest,
                record.attachment_id,
                record.created_at,
            ),
        )
        return record


class WebAnnotationRepositories:
    def __init__(self, db: Database) -> None:
        self.resources = WebAnnotationResourcesRepository(db)
        self.annotations = WebAnnotationsRepository(db)
        self.target_history = WebAnnotationTargetHistoryRepository(db)
        self.assets = WebAnnotationAssetsRepository(db)
        self.attachment_clones = WebAnnotationAttachmentClonesRepository(db)


def _resource_from_row(row: sqlite3.Row) -> WebAnnotationResourceRecord:
    scope_kind = cast(Literal["session", "workspace", "global"], str(row["scope_kind"]))
    scope_id = row["session_id"] if scope_kind == "session" else row["workspace_id"]
    return WebAnnotationResourceRecord(
        id=str(row["id"]),
        scope=WebAnnotationScope(
            kind=scope_kind,
            id=str(scope_id) if scope_id is not None else None,
        ),
        source_kind=cast(Literal["web", "local_file"], str(row["source_kind"])),
        normalization_version=int(row["normalization_version"]),
        url_key=str(row["url_key"]),
        url_normalized=str(row["url_normalized"]),
        document_url=str(row["document_url"]),
        canonical_url=str(row["canonical_url"]) if row["canonical_url"] is not None else None,
        origin=str(row["origin"]),
        title=str(row["title"]),
        created_at=str(row["created_at"]),
        updated_at=str(row["updated_at"]),
    )


def _annotation_from_row(row: sqlite3.Row) -> WebAnnotationRecord:
    target = _TARGET_ADAPTER.validate_json(str(row["target_json"]))
    if target.type != str(row["target_type"]):
        raise ValueError("Stored web annotation target_type does not match target_json")
    properties = _PROPERTIES_ADAPTER.validate_json(str(row["properties_json"]))
    tags = _TAGS_ADAPTER.validate_json(str(row["tags_json"]))
    return WebAnnotationRecord(
        id=str(row["id"]),
        resource_id=str(row["resource_id"]),
        target_schema_version=int(row["target_schema_version"]),
        target=target,
        body_markdown=str(row["body_markdown"]),
        tags=tags,
        properties=properties,
        revision=int(row["revision"]),
        created_at=str(row["created_at"]),
        updated_at=str(row["updated_at"]),
    )


def _target_history_from_row(row: sqlite3.Row) -> WebAnnotationTargetHistoryRecord:
    target = _TARGET_ADAPTER.validate_json(str(row["target_json"]))
    if target.type != str(row["target_type"]):
        raise ValueError("Stored history target_type does not match target_json")
    return WebAnnotationTargetHistoryRecord(
        id=str(row["id"]),
        annotation_id=str(row["annotation_id"]),
        prior_revision=int(row["prior_revision"]),
        target_schema_version=int(row["target_schema_version"]),
        target=target,
        reason=cast(TargetHistoryReason, str(row["reason"])),
        created_at=str(row["created_at"]),
    )


def _asset_from_row(row: sqlite3.Row) -> WebAnnotationAssetRecord:
    return WebAnnotationAssetRecord(
        id=str(row["id"]),
        resource_id=str(row["resource_id"]),
        annotation_id=str(row["annotation_id"]) if row["annotation_id"] is not None else None,
        asset_kind=str(row["asset_kind"]),
        state=str(row["state"]),
        storage_path=str(row["storage_path"]),
        mime_type=str(row["mime_type"]),
        size_bytes=int(row["size_bytes"]),
        sha256=str(row["sha256"]),
        width=int(row["width"]),
        height=int(row["height"]),
        expires_at=str(row["expires_at"]) if row["expires_at"] is not None else None,
        created_at=str(row["created_at"]),
        updated_at=str(row["updated_at"]),
    )


def _attachment_clone_from_row(row: sqlite3.Row) -> WebAnnotationAttachmentCloneRecord:
    return WebAnnotationAttachmentCloneRecord(
        id=str(row["id"]),
        session_id=str(row["session_id"]),
        annotation_id=str(row["annotation_id"]),
        asset_id=str(row["asset_id"]),
        context_digest=str(row["context_digest"]),
        attachment_id=str(row["attachment_id"]),
        created_at=str(row["created_at"]),
    )


def _scope_storage_values(scope: WebAnnotationScope) -> tuple[str | None, str | None]:
    return (
        scope.id if scope.kind == "session" else None,
        scope.id if scope.kind == "workspace" else None,
    )


def _find_resource_row(
    conn: sqlite3.Connection,
    *,
    scope: WebAnnotationScope,
    source_kind: Literal["web", "local_file"],
    url_key: str,
) -> sqlite3.Row | None:
    query, params = _scope_resource_query(
        scope,
        "source_kind = ? and url_key = ?",
        (source_kind, url_key),
    )
    return conn.execute(query, params).fetchone()


def _scope_resource_query(
    scope: WebAnnotationScope,
    predicate: str,
    predicate_params: tuple[object, ...],
    *,
    order_by: str | None = None,
) -> tuple[str, tuple[object, ...]]:
    query = "select * from web_annotation_resources where scope_kind = ?"
    params: tuple[object, ...] = (scope.kind,)
    if scope.kind == "session":
        query += " and session_id = ?"
        params += (scope.id,)
    elif scope.kind == "workspace":
        query += " and workspace_id = ?"
        params += (scope.id,)
    query += f" and {predicate}"
    params += predicate_params
    if order_by:
        query += f" order by {order_by}"
    return query, params


def _model_json(model) -> str:
    return _json_dumps(model.model_dump(mode="json"))


def _json_dumps(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


__all__ = [
    "WebAnnotationAssetsRepository",
    "WebAnnotationRepositories",
    "WebAnnotationResourcesRepository",
    "WebAnnotationRevisionConflict",
    "WebAnnotationTargetHistoryRepository",
    "WebAnnotationsRepository",
]
