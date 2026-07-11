from __future__ import annotations

import json
import sqlite3

from pydantic import TypeAdapter

from backend.app.annotations.models import (
    AnnotationRecord,
    AnnotationTarget,
    DocumentAnnotationTarget,
    TextAnnotationTarget,
)
from backend.app.core.ids import new_id
from backend.app.core.time import to_iso_z, utc_now
from backend.app.storage.db import Database

_TARGET_ADAPTER = TypeAdapter(AnnotationTarget)


class WorkspaceAnnotationsRepository:
    def __init__(self, db: Database) -> None:
        self.db = db

    def create(
        self,
        *,
        workspace_id: str,
        document_path: str,
        target: AnnotationTarget,
        body: str,
        annotation_id: str | None = None,
    ) -> AnnotationRecord:
        resolved_id = annotation_id or new_id()
        now = to_iso_z(utc_now())
        target_type, selector_json = _target_storage_values(target)
        with self.db.transaction() as conn:
            conn.execute(
                """
                insert into workspace_annotations (
                  id, workspace_id, document_path, target_type, selector_json, body,
                  created_at, updated_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    resolved_id,
                    workspace_id,
                    document_path,
                    target_type,
                    selector_json,
                    body,
                    now,
                    now,
                ),
            )
        record = self.get(resolved_id, workspace_id=workspace_id)
        if record is None:
            raise RuntimeError(f"Created annotation cannot be loaded: {resolved_id}")
        return record

    def get(self, annotation_id: str, *, workspace_id: str) -> AnnotationRecord | None:
        with self.db.connect() as conn:
            row = conn.execute(
                """
                select * from workspace_annotations
                where id = ? and workspace_id = ?
                """,
                (annotation_id, workspace_id),
            ).fetchone()
        return _record_from_row(row) if row else None

    def list(self, *, workspace_id: str, document_path: str) -> list[AnnotationRecord]:
        with self.db.connect() as conn:
            rows = conn.execute(
                """
                select * from workspace_annotations
                where workspace_id = ? and document_path = ?
                order by created_at asc, id asc
                """,
                (workspace_id, document_path),
            ).fetchall()
        return [_record_from_row(row) for row in rows]

    def update_body(
        self,
        annotation_id: str,
        *,
        workspace_id: str,
        body: str,
    ) -> AnnotationRecord | None:
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            cursor = conn.execute(
                """
                update workspace_annotations
                set body = ?, updated_at = ?
                where id = ? and workspace_id = ?
                """,
                (body, now, annotation_id, workspace_id),
            )
        if cursor.rowcount == 0:
            return None
        return self.get(annotation_id, workspace_id=workspace_id)

    def replace_target(
        self,
        annotation_id: str,
        *,
        workspace_id: str,
        target: TextAnnotationTarget,
    ) -> AnnotationRecord | None:
        target_type, selector_json = _target_storage_values(target)
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            cursor = conn.execute(
                """
                update workspace_annotations
                set target_type = ?, selector_json = ?, updated_at = ?
                where id = ? and workspace_id = ?
                """,
                (target_type, selector_json, now, annotation_id, workspace_id),
            )
        if cursor.rowcount == 0:
            return None
        return self.get(annotation_id, workspace_id=workspace_id)

    def delete(self, annotation_id: str, *, workspace_id: str) -> bool:
        with self.db.transaction() as conn:
            cursor = conn.execute(
                """
                delete from workspace_annotations
                where id = ? and workspace_id = ?
                """,
                (annotation_id, workspace_id),
            )
        return cursor.rowcount > 0


def _target_storage_values(target: AnnotationTarget) -> tuple[str, str | None]:
    if isinstance(target, DocumentAnnotationTarget):
        return "document", None
    return (
        "text",
        json.dumps(
            target.selector.model_dump(by_alias=True),
            ensure_ascii=False,
            separators=(",", ":"),
        ),
    )


def _record_from_row(row: sqlite3.Row) -> AnnotationRecord:
    target_payload: dict[str, object]
    if row["target_type"] == "document":
        target_payload = {"type": "document"}
    else:
        target_payload = {
            "type": "text",
            "selector": json.loads(row["selector_json"]),
        }
    return AnnotationRecord(
        id=row["id"],
        workspace_id=row["workspace_id"],
        document_path=row["document_path"],
        target=_TARGET_ADAPTER.validate_python(target_payload),
        body=row["body"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )
