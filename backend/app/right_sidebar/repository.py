from __future__ import annotations

import json
import sqlite3
from typing import cast

from backend.app.core.ids import new_id
from backend.app.core.time import to_iso_z, utc_now
from backend.app.right_sidebar.models import (
    RIGHT_SIDEBAR_STATE_SCHEMA_VERSION,
    PromotionSourceScopeKind,
    RightSidebarPromotionResponse,
    RightSidebarScopeRecord,
    RightSidebarScopeStateDocument,
    ScopeKind,
)
from backend.app.storage.db import Database


class RightSidebarRevisionConflict(Exception):
    def __init__(self, current: RightSidebarScopeRecord | None) -> None:
        super().__init__("Right sidebar scope revision conflict")
        self.current = current


class RightSidebarScopeRepository:
    def __init__(self, db: Database) -> None:
        self.db = db

    def get(self, *, scope_kind: ScopeKind, scope_id: str | None) -> RightSidebarScopeRecord | None:
        column, value = _scope_column_value(scope_kind, scope_id)
        query = "select * from right_sidebar_scope_states where scope_kind = ?"
        params: tuple[object, ...] = (scope_kind,)
        if column:
            query += f" and {column} = ?"
            params = (scope_kind, value)
        with self.db.connect() as conn:
            row = conn.execute(query, params).fetchone()
        return _record_from_row(row) if row else None

    def put(
        self,
        *,
        scope_kind: ScopeKind,
        scope_id: str | None,
        state: RightSidebarScopeStateDocument,
        expected_revision: int,
    ) -> RightSidebarScopeRecord:
        session_id = scope_id if scope_kind == "session" else None
        workspace_id = scope_id if scope_kind == "workspace" else None
        state_json = json.dumps(
            state.model_dump(by_alias=True),
            ensure_ascii=False,
            separators=(",", ":"),
        )
        now = to_iso_z(utc_now())
        with self.db.transaction(immediate=True) as conn:
            current_row = _select_scope(conn, scope_kind, scope_id)
            if current_row is None:
                if expected_revision != 0:
                    raise RightSidebarRevisionConflict(None)
                record_id = new_id()
                conn.execute(
                    """
                    insert into right_sidebar_scope_states (
                      id, scope_kind, session_id, workspace_id, schema_version,
                      state_json, revision, created_at, updated_at
                    ) values (?, ?, ?, ?, ?, ?, 1, ?, ?)
                    """,
                    (
                        record_id,
                        scope_kind,
                        session_id,
                        workspace_id,
                        RIGHT_SIDEBAR_STATE_SCHEMA_VERSION,
                        state_json,
                        now,
                        now,
                    ),
                )
            else:
                current_revision = int(current_row["revision"])
                if current_revision != expected_revision:
                    raise RightSidebarRevisionConflict(_record_from_row(current_row))
                cursor = conn.execute(
                    """
                    update right_sidebar_scope_states
                    set state_json = ?, revision = revision + 1, updated_at = ?
                    where id = ? and revision = ?
                    """,
                    (state_json, now, str(current_row["id"]), expected_revision),
                )
                if cursor.rowcount != 1:
                    latest = _select_scope(conn, scope_kind, scope_id)
                    raise RightSidebarRevisionConflict(_record_from_row(latest) if latest else None)
            row = _select_scope(conn, scope_kind, scope_id)
        if row is None:
            raise RuntimeError("Saved right sidebar scope cannot be loaded")
        return _record_from_row(row)

    def delete(self, *, scope_kind: ScopeKind, scope_id: str | None) -> bool:
        column, value = _scope_column_value(scope_kind, scope_id)
        query = "delete from right_sidebar_scope_states where scope_kind = ?"
        params: tuple[object, ...] = (scope_kind,)
        if column:
            query += f" and {column} = ?"
            params = (scope_kind, value)
        with self.db.transaction(immediate=True) as conn:
            cursor = conn.execute(query, params)
        return cursor.rowcount > 0

    def promote(
        self,
        *,
        source_scope_kind: PromotionSourceScopeKind,
        source_scope_id: str | None,
        source_revision: int,
        target_session_id: str,
    ) -> RightSidebarPromotionResponse:
        source_scope_key = source_scope_id or "global"
        with self.db.transaction(immediate=True) as conn:
            replay_row = conn.execute(
                """
                select response_json from right_sidebar_scope_promotions
                where source_scope_kind = ? and source_scope_key = ?
                  and source_revision = ? and target_session_id = ?
                """,
                (
                    source_scope_kind,
                    source_scope_key,
                    source_revision,
                    target_session_id,
                ),
            ).fetchone()
            if replay_row is not None:
                replay = RightSidebarPromotionResponse.model_validate_json(
                    str(replay_row["response_json"]),
                )
                return replay.model_copy(update={"idempotent_replay": True})

            source_row = _select_scope(conn, source_scope_kind, source_scope_id)
            if source_row is None or int(source_row["revision"]) != source_revision:
                current = _record_from_row(source_row) if source_row is not None else None
                raise RightSidebarRevisionConflict(current)

            target_row = _select_scope(conn, "session", target_session_id)
            source = _record_from_row(source_row)
            target = _record_from_row(target_row) if target_row is not None else None
            merged_state, panel_id_mapping = _merge_promoted_scope_state(
                source.state,
                target.state if target else None,
            )
            target_record = _write_promoted_target(
                conn,
                target_session_id=target_session_id,
                target_row=target_row,
                state=merged_state,
            )
            _promote_web_annotation_resources(
                conn,
                source_scope_kind=source_scope_kind,
                source_scope_id=source_scope_id,
                target_session_id=target_session_id,
            )
            conn.execute(
                "delete from right_sidebar_scope_states where id = ?",
                (source.id,),
            )
            response = RightSidebarPromotionResponse(
                source_scope_kind=source_scope_kind,
                source_scope_id=source_scope_id,
                source_revision=source_revision,
                target_session_id=target_session_id,
                target=target_record,
                panel_id_mapping=panel_id_mapping,
            )
            conn.execute(
                """
                insert into right_sidebar_scope_promotions (
                  id, source_scope_kind, source_scope_key, source_revision,
                  target_session_id, response_json, created_at
                ) values (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    new_id(),
                    source_scope_kind,
                    source_scope_key,
                    source_revision,
                    target_session_id,
                    response.model_dump_json(by_alias=True),
                    to_iso_z(utc_now()),
                ),
            )
        return response


def _select_scope(
    conn: sqlite3.Connection,
    scope_kind: ScopeKind,
    scope_id: str | None,
) -> sqlite3.Row | None:
    column, value = _scope_column_value(scope_kind, scope_id)
    query = "select * from right_sidebar_scope_states where scope_kind = ?"
    params: tuple[object, ...] = (scope_kind,)
    if column:
        query += f" and {column} = ?"
        params = (scope_kind, value)
    return conn.execute(query, params).fetchone()


def _scope_column_value(
    scope_kind: ScopeKind,
    scope_id: str | None,
) -> tuple[str | None, str | None]:
    if scope_kind == "global":
        return None, None
    return ("session_id" if scope_kind == "session" else "workspace_id"), scope_id


def _record_from_row(row: sqlite3.Row) -> RightSidebarScopeRecord:
    scope_kind = cast(ScopeKind, str(row["scope_kind"]))
    scope_id = row["session_id"] if scope_kind == "session" else row["workspace_id"]
    return RightSidebarScopeRecord(
        id=str(row["id"]),
        scope_kind=scope_kind,
        scope_id=str(scope_id) if scope_id is not None else None,
        schema_version=int(row["schema_version"]),
        state=RightSidebarScopeStateDocument.model_validate_json(str(row["state_json"])),
        revision=int(row["revision"]),
        created_at=str(row["created_at"]),
        updated_at=str(row["updated_at"]),
    )


def _merge_promoted_scope_state(
    source: RightSidebarScopeStateDocument,
    target: RightSidebarScopeStateDocument | None,
) -> tuple[RightSidebarScopeStateDocument, dict[str, str]]:
    target_document = target or RightSidebarScopeStateDocument.model_validate(
        {
            "version": RIGHT_SIDEBAR_STATE_SCHEMA_VERSION,
            "activePanelId": None,
            "panelOrder": [],
            "panels": {},
            "nextPanelSeq": 0,
        }
    )
    panels = {panel_id: dict(panel) for panel_id, panel in target_document.panels.items()}
    panel_order = list(target_document.panel_order)
    mapping: dict[str, str] = {}
    for source_panel_id in source.panel_order:
        source_panel = dict(source.panels[source_panel_id])
        target_panel_id = source_panel_id
        if target_panel_id in panels:
            suffix = 1
            while f"{source_panel_id}:promoted:{suffix}" in panels:
                suffix += 1
            target_panel_id = f"{source_panel_id}:promoted:{suffix}"
            source_panel["id"] = target_panel_id
        mapping[source_panel_id] = target_panel_id
        panels[target_panel_id] = source_panel
        panel_order.append(target_panel_id)

    source_active = mapping.get(source.active_panel_id or "")
    active_panel_id = target_document.active_panel_id or source_active
    merged = RightSidebarScopeStateDocument.model_validate(
        {
            "version": RIGHT_SIDEBAR_STATE_SCHEMA_VERSION,
            "activePanelId": active_panel_id,
            "panelOrder": panel_order,
            "panels": panels,
            "nextPanelSeq": max(
                target_document.next_panel_seq,
                source.next_panel_seq,
            ),
        }
    )
    return merged, mapping


def _write_promoted_target(
    conn: sqlite3.Connection,
    *,
    target_session_id: str,
    target_row: sqlite3.Row | None,
    state: RightSidebarScopeStateDocument,
) -> RightSidebarScopeRecord:
    state_json = json.dumps(
        state.model_dump(by_alias=True),
        ensure_ascii=False,
        separators=(",", ":"),
    )
    now = to_iso_z(utc_now())
    if target_row is None:
        conn.execute(
            """
            insert into right_sidebar_scope_states (
              id, scope_kind, session_id, workspace_id, schema_version,
              state_json, revision, created_at, updated_at
            ) values (?, 'session', ?, null, ?, ?, 1, ?, ?)
            """,
            (
                new_id(),
                target_session_id,
                RIGHT_SIDEBAR_STATE_SCHEMA_VERSION,
                state_json,
                now,
                now,
            ),
        )
    else:
        conn.execute(
            """
            update right_sidebar_scope_states
            set state_json = ?, revision = revision + 1, updated_at = ?
            where id = ?
            """,
            (state_json, now, str(target_row["id"])),
        )
    saved = _select_scope(conn, "session", target_session_id)
    if saved is None:
        raise RuntimeError("Promoted right sidebar scope cannot be loaded")
    return _record_from_row(saved)


def _promote_web_annotation_resources(
    conn: sqlite3.Connection,
    *,
    source_scope_kind: PromotionSourceScopeKind,
    source_scope_id: str | None,
    target_session_id: str,
) -> None:
    source_query = "select * from web_annotation_resources where scope_kind = ?"
    source_params: tuple[object, ...] = (source_scope_kind,)
    if source_scope_kind == "workspace":
        source_query += " and workspace_id = ?"
        source_params += (source_scope_id,)
    source_query += " order by created_at asc, id asc"
    source_rows = conn.execute(source_query, source_params).fetchall()
    if not source_rows:
        return

    # Attached assets use a composite FK to (annotation_id, resource_id). A URL
    # collision therefore has to move annotation and asset ownership together.
    conn.execute("pragma defer_foreign_keys = on")
    now = to_iso_z(utc_now())
    for source_row in source_rows:
        target_row = conn.execute(
            """
            select * from web_annotation_resources
            where scope_kind = 'session' and session_id = ? and url_key = ?
            """,
            (target_session_id, str(source_row["url_key"])),
        ).fetchone()
        source_resource_id = str(source_row["id"])
        if target_row is None:
            conn.execute(
                """
                update web_annotation_resources
                set scope_kind = 'session', session_id = ?, workspace_id = null,
                    updated_at = ?
                where id = ?
                """,
                (target_session_id, now, source_resource_id),
            )
            continue

        target_resource_id = str(target_row["id"])
        conn.execute(
            """
            update web_annotation_resources
            set title = case when title = '' then ? else title end,
                canonical_url = coalesce(canonical_url, ?),
                updated_at = ?
            where id = ?
            """,
            (
                str(source_row["title"]),
                source_row["canonical_url"],
                now,
                target_resource_id,
            ),
        )
        conn.execute(
            "update web_annotations set resource_id = ? where resource_id = ?",
            (target_resource_id, source_resource_id),
        )
        conn.execute(
            "update web_annotation_assets set resource_id = ? where resource_id = ?",
            (target_resource_id, source_resource_id),
        )
        conn.execute(
            "delete from web_annotation_resources where id = ?",
            (source_resource_id,),
        )
