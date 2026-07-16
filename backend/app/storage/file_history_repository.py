from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any

from backend.app.core.time import to_iso_z, utc_now
from backend.app.storage.db import Database


def _json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _json_loads(value: str | None) -> dict[str, Any]:
    if not value:
        return {}
    loaded = json.loads(value)
    return loaded if isinstance(loaded, dict) else {}


@dataclass(frozen=True, slots=True)
class FileHistorySessionStateRecord:
    session_id: str
    active_snapshot_id: str | None
    next_sequence: int
    state: str
    blocked_reason: str | None
    revision: int
    created_at: str
    updated_at: str


@dataclass(frozen=True, slots=True)
class FileHistorySnapshotRecord:
    id: str
    session_id: str
    active_session_id: str | None
    trace_id: str | None
    user_message_event_id: str | None
    parent_snapshot_id: str | None
    kind: str
    sequence: int
    workspace_root: str
    workspace_identity: str
    status: str
    error_code: str | None
    created_at: str
    updated_at: str


@dataclass(frozen=True, slots=True)
class FileHistorySnapshotEntryRecord:
    snapshot_id: str
    canonical_path: str
    display_path: str
    state: str
    backup_file_name: str | None
    version: int
    backup_time: str
    size: int | None
    mode: int | None
    content_hash: str | None
    scope_kind: str = "workspace"
    scope_identity: str = ""
    scope_root: str = ""
    scope_label: str = ""


@dataclass(frozen=True, slots=True)
class FileHistoryTrackedFileRecord:
    session_id: str
    canonical_path: str
    display_path: str
    latest_version: int
    first_snapshot_id: str | None
    last_snapshot_id: str | None
    last_observed_state: str | None
    last_observed_hash: str | None
    last_observed_size: int | None
    last_observed_mtime_ns: int | None
    last_observed_mode: int | None
    created_at: str
    updated_at: str
    scope_kind: str = "workspace"
    scope_identity: str = ""
    scope_root: str = ""
    scope_label: str = ""


@dataclass(frozen=True, slots=True)
class FileHistoryMutationRecord:
    id: str
    session_id: str
    active_session_id: str | None
    trace_id: str | None
    turn_index: int | None
    snapshot_id: str | None
    workspace_identity: str
    canonical_path: str
    display_path: str
    tool_name: str | None
    tool_call_id: str | None
    batch_id: str | None
    mutation_kind: str
    before_state: str
    before_hash: str | None
    after_state: str | None
    after_hash: str | None
    status: str
    error_code: str | None
    created_at: str
    updated_at: str
    scope_kind: str = "workspace"
    scope_identity: str = ""
    scope_root: str = ""
    scope_label: str = ""


@dataclass(frozen=True, slots=True)
class FileHistoryPathHeadRecord:
    workspace_identity: str
    canonical_path: str
    display_path: str
    session_id: str
    trace_id: str | None
    mutation_id: str | None
    state: str
    content_hash: str | None
    revision: int
    updated_at: str
    scope_kind: str = "workspace"
    scope_identity: str = ""
    scope_root: str = ""
    scope_label: str = ""


@dataclass(frozen=True, slots=True)
class FileHistoryOperationRecord:
    id: str
    request_id: str
    session_id: str
    active_session_id: str | None
    target_snapshot_id: str | None
    target_trace_id: str | None
    target_message_event_id: str | None
    workspace_identity: str | None
    mode: str | None
    decision: str | None
    state: str
    preview_token: str | None
    preview_revision: int
    conversation_rewound: bool
    active_snapshot_before: str | None
    active_snapshot_after: str | None
    restored_count: int
    skipped_count: int
    forced_count: int
    error_code: str | None
    error_detail: dict[str, Any] = field(default_factory=dict)
    compensation_state: str = "not_needed"
    created_at: str = ""
    updated_at: str = ""
    completed_at: str | None = None


@dataclass(frozen=True, slots=True)
class FileHistoryOperationFileRecord:
    operation_id: str
    canonical_path: str
    display_path: str
    preview_current_state: str
    preview_current_hash: str | None
    target_state: str
    target_backup_file_name: str | None
    target_hash: str | None
    target_size: int | None
    target_mode: int | None
    classification: str
    reason_code: str | None
    writer_session_id: str | None
    user_authorized: bool
    result_state: str
    error_code: str | None
    safety_state: str | None
    safety_backup_file_name: str | None
    safety_hash: str | None
    safety_size: int | None
    safety_mode: int | None
    updated_at: str
    scope_kind: str = "workspace"
    scope_identity: str = ""
    scope_root: str = ""
    scope_label: str = ""


class FileHistoryRepository:
    """Typed persistence boundary for file-history metadata.

    Methods accept an optional caller-owned connection so reverse orchestration can
    combine file-history metadata with the existing conversation transaction.
    """

    def __init__(self, db: Database) -> None:
        self.db = db

    @contextmanager
    def _connection(
        self,
        conn: sqlite3.Connection | None,
    ) -> Iterator[sqlite3.Connection]:
        if conn is not None:
            yield conn
            return
        with self.db.connect() as owned:
            yield owned

    @staticmethod
    def _snapshot_scope(
        conn: sqlite3.Connection,
        snapshot_id: str,
        *,
        scope_kind: str,
        scope_identity: str,
        scope_root: str,
        scope_label: str,
    ) -> tuple[str, str, str, str]:
        if scope_identity and scope_root:
            return (
                scope_kind or "workspace",
                scope_identity,
                scope_root,
                scope_label or scope_root,
            )
        snapshot = conn.execute(
            "select workspace_identity, workspace_root from file_history_snapshots where id = ?",
            (snapshot_id,),
        ).fetchone()
        if snapshot is None:
            raise ValueError(f"文件快照不存在: {snapshot_id}")
        identity = scope_identity or str(snapshot["workspace_identity"])
        root = scope_root or str(snapshot["workspace_root"])
        return (scope_kind or "workspace", identity, root, scope_label or root)

    @staticmethod
    def _ensure_snapshot_scope(
        conn: sqlite3.Connection,
        snapshot_id: str,
        scope: tuple[str, str, str, str],
    ) -> None:
        conn.execute(
            """
            insert into file_history_snapshot_scopes (
              snapshot_id, scope_kind, scope_identity, scope_root, scope_label
            ) values (?, ?, ?, ?, ?)
            on conflict(snapshot_id, scope_kind, scope_identity) do update set
              scope_root=excluded.scope_root,
              scope_label=excluded.scope_label
            """,
            (snapshot_id, *scope),
        )

    @staticmethod
    def _session_scope(
        conn: sqlite3.Connection,
        session_id: str,
        *,
        scope_kind: str,
        scope_identity: str,
        scope_root: str,
        scope_label: str,
        fallback_identity: str = "",
    ) -> tuple[str, str, str, str]:
        if scope_identity and scope_root:
            return (
                scope_kind or "workspace",
                scope_identity,
                scope_root,
                scope_label or scope_root,
            )
        snapshot = conn.execute(
            """
            select workspace_identity, workspace_root from file_history_snapshots
            where session_id = ? order by sequence desc limit 1
            """,
            (session_id,),
        ).fetchone()
        identity = scope_identity or fallback_identity
        root = scope_root
        if snapshot is not None:
            identity = identity or str(snapshot["workspace_identity"])
            root = root or str(snapshot["workspace_root"])
        identity = identity or f"legacy:{session_id}"
        root = root or identity
        return (scope_kind or "workspace", identity, root, scope_label or root)

    def get_session_state(
        self,
        session_id: str,
        *,
        conn: sqlite3.Connection | None = None,
    ) -> FileHistorySessionStateRecord | None:
        with self._connection(conn) as active:
            row = active.execute(
                "select * from file_history_session_state where session_id = ?",
                (session_id,),
            ).fetchone()
        return _session_state(row) if row is not None else None

    def list_session_states(
        self,
        *,
        conn: sqlite3.Connection | None = None,
    ) -> list[FileHistorySessionStateRecord]:
        with self._connection(conn) as active:
            rows = active.execute(
                "select * from file_history_session_state order by session_id asc"
            ).fetchall()
        return [_session_state(row) for row in rows]

    def ensure_session_state(
        self,
        session_id: str,
        *,
        conn: sqlite3.Connection | None = None,
    ) -> FileHistorySessionStateRecord:
        now = to_iso_z(utc_now())
        with self._connection(conn) as active:
            active.execute(
                """
                insert into file_history_session_state (
                  session_id, active_snapshot_id, next_sequence, state, revision,
                  created_at, updated_at
                ) values (?, null, 1, 'ready', 0, ?, ?)
                on conflict(session_id) do nothing
                """,
                (session_id, now, now),
            )
            row = active.execute(
                "select * from file_history_session_state where session_id = ?",
                (session_id,),
            ).fetchone()
        if row is None:
            raise RuntimeError("file history session state was not persisted")
        return _session_state(row)

    def update_session_state(
        self,
        session_id: str,
        *,
        active_snapshot_id: str | None | object = ...,
        next_sequence: int | None = None,
        state: str | None = None,
        blocked_reason: str | None | object = ...,
        expected_revision: int | None = None,
        conn: sqlite3.Connection | None = None,
    ) -> FileHistorySessionStateRecord | None:
        updates = ["updated_at = ?", "revision = revision + 1"]
        values: list[Any] = [to_iso_z(utc_now())]
        if active_snapshot_id is not ...:
            updates.append("active_snapshot_id = ?")
            values.append(active_snapshot_id)
        if next_sequence is not None:
            updates.append("next_sequence = ?")
            values.append(next_sequence)
        if state is not None:
            updates.append("state = ?")
            values.append(state)
        if blocked_reason is not ...:
            updates.append("blocked_reason = ?")
            values.append(blocked_reason)
        where = "session_id = ?"
        values.append(session_id)
        if expected_revision is not None:
            where += " and revision = ?"
            values.append(expected_revision)
        with self._connection(conn) as active:
            cursor = active.execute(
                f"update file_history_session_state set {', '.join(updates)} where {where}",
                values,
            )
            if cursor.rowcount != 1:
                return None
            row = active.execute(
                "select * from file_history_session_state where session_id = ?",
                (session_id,),
            ).fetchone()
        return _session_state(row) if row is not None else None

    def create_snapshot(
        self,
        snapshot: FileHistorySnapshotRecord,
        entries: Sequence[FileHistorySnapshotEntryRecord] = (),
        *,
        set_active: bool = False,
        conn: sqlite3.Connection | None = None,
    ) -> FileHistorySnapshotRecord:
        with self._connection(conn) as active:
            active.execute(
                """
                insert into file_history_snapshots (
                  id, session_id, active_session_id, trace_id, user_message_event_id,
                  parent_snapshot_id, kind, sequence, workspace_root, workspace_identity,
                  status, error_code, created_at, updated_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    snapshot.id,
                    snapshot.session_id,
                    snapshot.active_session_id,
                    snapshot.trace_id,
                    snapshot.user_message_event_id,
                    snapshot.parent_snapshot_id,
                    snapshot.kind,
                    snapshot.sequence,
                    snapshot.workspace_root,
                    snapshot.workspace_identity,
                    snapshot.status,
                    snapshot.error_code,
                    snapshot.created_at,
                    snapshot.updated_at,
                ),
            )
            self._ensure_snapshot_scope(
                active,
                snapshot.id,
                (
                    "workspace",
                    snapshot.workspace_identity,
                    snapshot.workspace_root,
                    snapshot.workspace_root,
                ),
            )
            self.replace_snapshot_entries(snapshot.id, entries, conn=active)
            if set_active:
                active.execute(
                    """
                    update file_history_session_state
                       set active_snapshot_id = ?,
                           next_sequence = max(next_sequence, ?),
                           state = 'ready', blocked_reason = null,
                           revision = revision + 1, updated_at = ?
                     where session_id = ?
                    """,
                    (
                        snapshot.id,
                        snapshot.sequence + 1,
                        to_iso_z(utc_now()),
                        snapshot.session_id,
                    ),
                )
        return snapshot

    def replace_snapshot_entries(
        self,
        snapshot_id: str,
        entries: Sequence[FileHistorySnapshotEntryRecord],
        *,
        conn: sqlite3.Connection | None = None,
    ) -> None:
        with self._connection(conn) as active:
            active.execute(
                "delete from file_history_snapshot_entries where snapshot_id = ?",
                (snapshot_id,),
            )
            normalized = [
                (
                    entry,
                    self._snapshot_scope(
                        active,
                        entry.snapshot_id,
                        scope_kind=entry.scope_kind,
                        scope_identity=entry.scope_identity,
                        scope_root=entry.scope_root,
                        scope_label=entry.scope_label,
                    ),
                )
                for entry in entries
            ]
            for entry, scope in normalized:
                self._ensure_snapshot_scope(active, entry.snapshot_id, scope)
            active.executemany(
                """
                insert into file_history_snapshot_entries (
                  snapshot_id, scope_kind, scope_identity, scope_root, scope_label,
                  canonical_path, display_path, state, backup_file_name,
                  version, backup_time, size, mode, content_hash
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        entry.snapshot_id,
                        *scope,
                        entry.canonical_path,
                        entry.display_path,
                        entry.state,
                        entry.backup_file_name,
                        entry.version,
                        entry.backup_time,
                        entry.size,
                        entry.mode,
                        entry.content_hash,
                    )
                    for entry, scope in normalized
                ],
            )

    def upsert_snapshot_entry(
        self,
        entry: FileHistorySnapshotEntryRecord,
        *,
        conn: sqlite3.Connection | None = None,
    ) -> None:
        with self._connection(conn) as active:
            scope = self._snapshot_scope(
                active,
                entry.snapshot_id,
                scope_kind=entry.scope_kind,
                scope_identity=entry.scope_identity,
                scope_root=entry.scope_root,
                scope_label=entry.scope_label,
            )
            self._ensure_snapshot_scope(active, entry.snapshot_id, scope)
            active.execute(
                """
                insert into file_history_snapshot_entries (
                  snapshot_id, scope_kind, scope_identity, scope_root, scope_label,
                  canonical_path, display_path, state, backup_file_name,
                  version, backup_time, size, mode, content_hash
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                on conflict(snapshot_id, scope_kind, scope_identity, canonical_path) do update set
                  scope_root=excluded.scope_root,
                  scope_label=excluded.scope_label,
                  display_path=excluded.display_path,
                  state=excluded.state,
                  backup_file_name=excluded.backup_file_name,
                  version=excluded.version,
                  backup_time=excluded.backup_time,
                  size=excluded.size,
                  mode=excluded.mode,
                  content_hash=excluded.content_hash
                """,
                (
                    entry.snapshot_id,
                    *scope,
                    entry.canonical_path,
                    entry.display_path,
                    entry.state,
                    entry.backup_file_name,
                    entry.version,
                    entry.backup_time,
                    entry.size,
                    entry.mode,
                    entry.content_hash,
                ),
            )

    def get_snapshot(
        self,
        snapshot_id: str,
        *,
        conn: sqlite3.Connection | None = None,
    ) -> FileHistorySnapshotRecord | None:
        with self._connection(conn) as active:
            row = active.execute(
                "select * from file_history_snapshots where id = ?",
                (snapshot_id,),
            ).fetchone()
        return _snapshot(row) if row is not None else None

    def update_snapshot(
        self,
        snapshot_id: str,
        *,
        status: str | None = None,
        error_code: str | None | object = ...,
        trace_id: str | None | object = ...,
        conn: sqlite3.Connection | None = None,
    ) -> FileHistorySnapshotRecord | None:
        assignments = ["updated_at = ?"]
        values: list[Any] = [to_iso_z(utc_now())]
        if status is not None:
            assignments.append("status = ?")
            values.append(status)
        for column, value in (("error_code", error_code), ("trace_id", trace_id)):
            if value is not ...:
                assignments.append(f"{column} = ?")
                values.append(value)
        values.append(snapshot_id)
        with self._connection(conn) as active:
            active.execute(
                f"update file_history_snapshots set {', '.join(assignments)} where id = ?",
                values,
            )
            row = active.execute(
                "select * from file_history_snapshots where id = ?",
                (snapshot_id,),
            ).fetchone()
        return _snapshot(row) if row is not None else None

    def get_snapshot_by_message(
        self,
        session_id: str,
        message_event_id: str,
        *,
        conn: sqlite3.Connection | None = None,
    ) -> FileHistorySnapshotRecord | None:
        with self._connection(conn) as active:
            row = active.execute(
                """
                select * from file_history_snapshots
                where session_id = ? and user_message_event_id = ?
                """,
                (session_id, message_event_id),
            ).fetchone()
        return _snapshot(row) if row is not None else None

    def list_snapshots(
        self,
        session_id: str,
        *,
        status: str | None = None,
        limit: int = 100,
        conn: sqlite3.Connection | None = None,
    ) -> list[FileHistorySnapshotRecord]:
        query = "select * from file_history_snapshots where session_id = ?"
        values: list[Any] = [session_id]
        if status is not None:
            query += " and status = ?"
            values.append(status)
        query += " order by sequence desc, id desc limit ?"
        values.append(max(1, int(limit)))
        with self._connection(conn) as active:
            rows = active.execute(query, values).fetchall()
        return [_snapshot(row) for row in rows]

    def delete_snapshots(
        self,
        snapshot_ids: Sequence[str],
        *,
        conn: sqlite3.Connection | None = None,
    ) -> int:
        normalized = tuple(sorted({str(value) for value in snapshot_ids if str(value)}))
        if not normalized:
            return 0
        placeholders = ",".join("?" for _ in normalized)
        with self._connection(conn) as active:
            active.execute(
                f"""
                update trace_record
                   set input_file_snapshot_id = null,
                       input_file_snapshot_status = 'expired',
                       updated_at = ?
                 where input_file_snapshot_id in ({placeholders})
                """,
                (to_iso_z(utc_now()), *normalized),
            )
            cursor = active.execute(
                f"delete from file_history_snapshots where id in ({placeholders})",
                normalized,
            )
        return max(0, int(cursor.rowcount))

    def list_snapshot_entries(
        self,
        snapshot_id: str,
        *,
        conn: sqlite3.Connection | None = None,
    ) -> list[FileHistorySnapshotEntryRecord]:
        with self._connection(conn) as active:
            rows = active.execute(
                """
                select * from file_history_snapshot_entries
                where snapshot_id = ?
                order by scope_kind asc, scope_identity asc, canonical_path asc
                """,
                (snapshot_id,),
            ).fetchall()
        return [_snapshot_entry(row) for row in rows]

    def get_snapshot_entry(
        self,
        snapshot_id: str,
        canonical_path: str,
        *,
        scope_kind: str,
        scope_identity: str,
        conn: sqlite3.Connection | None = None,
    ) -> FileHistorySnapshotEntryRecord | None:
        with self._connection(conn) as active:
            row = active.execute(
                """
                select * from file_history_snapshot_entries
                where snapshot_id = ? and scope_kind = ? and scope_identity = ?
                  and canonical_path = ?
                """,
                (snapshot_id, scope_kind, scope_identity, canonical_path),
            ).fetchone()
        return _snapshot_entry(row) if row is not None else None

    def find_reusable_entry(
        self,
        session_id: str,
        canonical_path: str,
        *,
        scope_kind: str = "workspace",
        scope_identity: str | None = None,
        state: str,
        content_hash: str | None,
        mode: int | None,
        conn: sqlite3.Connection | None = None,
    ) -> FileHistorySnapshotEntryRecord | None:
        query = """
            select entry.*
            from file_history_snapshot_entries entry
            join file_history_snapshots snapshot on snapshot.id = entry.snapshot_id
            where snapshot.session_id = ?
              and snapshot.status = 'ready'
              and entry.canonical_path = ?
              and entry.scope_kind = ?
              and entry.state = ?
        """
        values: list[Any] = [session_id, canonical_path, scope_kind, state]
        if scope_identity is not None:
            query += " and entry.scope_identity = ?"
            values.append(scope_identity)
        if state == "file":
            query += " and entry.content_hash = ? and entry.mode = ?"
            values.extend((content_hash, mode))
        query += " order by snapshot.sequence desc, entry.version desc limit 1"
        with self._connection(conn) as active:
            row = active.execute(query, values).fetchone()
        return _snapshot_entry(row) if row is not None else None

    def upsert_tracked_file(
        self,
        record: FileHistoryTrackedFileRecord,
        *,
        conn: sqlite3.Connection | None = None,
    ) -> None:
        with self._connection(conn) as active:
            scope = self._session_scope(
                active,
                record.session_id,
                scope_kind=record.scope_kind,
                scope_identity=record.scope_identity,
                scope_root=record.scope_root,
                scope_label=record.scope_label,
            )
            active.execute(
                """
                insert into file_history_tracked_files (
                  session_id, scope_kind, scope_identity, scope_root, scope_label,
                  canonical_path, display_path, latest_version,
                  first_snapshot_id, last_snapshot_id, last_observed_state,
                  last_observed_hash, last_observed_size, last_observed_mtime_ns,
                  last_observed_mode, created_at, updated_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                on conflict(session_id, scope_kind, scope_identity, canonical_path) do update set
                  scope_root=excluded.scope_root,
                  scope_label=excluded.scope_label,
                  display_path=excluded.display_path,
                  latest_version=excluded.latest_version,
                  first_snapshot_id=coalesce(file_history_tracked_files.first_snapshot_id,
                                             excluded.first_snapshot_id),
                  last_snapshot_id=excluded.last_snapshot_id,
                  last_observed_state=excluded.last_observed_state,
                  last_observed_hash=excluded.last_observed_hash,
                  last_observed_size=excluded.last_observed_size,
                  last_observed_mtime_ns=excluded.last_observed_mtime_ns,
                  last_observed_mode=excluded.last_observed_mode,
                  updated_at=excluded.updated_at
                """,
                (
                    record.session_id,
                    *scope,
                    record.canonical_path,
                    record.display_path,
                    record.latest_version,
                    record.first_snapshot_id,
                    record.last_snapshot_id,
                    record.last_observed_state,
                    record.last_observed_hash,
                    record.last_observed_size,
                    record.last_observed_mtime_ns,
                    record.last_observed_mode,
                    record.created_at,
                    record.updated_at,
                ),
            )
            if record.scope_identity and not record.scope_identity.startswith("legacy:"):
                active.execute(
                    """
                    delete from file_history_tracked_files
                    where session_id = ? and canonical_path = ?
                      and scope_identity like 'legacy:%'
                    """,
                    (record.session_id, record.canonical_path),
                )

    def get_tracked_file(
        self,
        session_id: str,
        canonical_path: str,
        *,
        scope_kind: str = "workspace",
        scope_identity: str | None = None,
        conn: sqlite3.Connection | None = None,
    ) -> FileHistoryTrackedFileRecord | None:
        with self._connection(conn) as active:
            row = active.execute(
                """
                select * from file_history_tracked_files
                where session_id = ? and canonical_path = ? and scope_kind = ?
                  and (? is null or scope_identity = ?)
                """,
                (session_id, canonical_path, scope_kind, scope_identity, scope_identity),
            ).fetchone()
        return _tracked_file(row) if row is not None else None

    def list_tracked_files(
        self,
        session_id: str,
        *,
        conn: sqlite3.Connection | None = None,
    ) -> list[FileHistoryTrackedFileRecord]:
        with self._connection(conn) as active:
            rows = active.execute(
                """
                select * from file_history_tracked_files
                where session_id = ?
                order by scope_kind asc, scope_identity asc, canonical_path asc
                """,
                (session_id,),
            ).fetchall()
        return [_tracked_file(row) for row in rows]

    def create_mutation(
        self,
        record: FileHistoryMutationRecord,
        *,
        conn: sqlite3.Connection | None = None,
    ) -> FileHistoryMutationRecord:
        with self._connection(conn) as active:
            scope = self._session_scope(
                active,
                record.session_id,
                scope_kind=record.scope_kind,
                scope_identity=record.scope_identity,
                scope_root=record.scope_root,
                scope_label=record.scope_label,
                fallback_identity=record.workspace_identity,
            )
            active.execute(
                """
                insert into file_history_mutations (
                  id, session_id, active_session_id, trace_id, turn_index, snapshot_id,
                  workspace_identity, scope_kind, scope_identity, scope_root, scope_label,
                  canonical_path, display_path, tool_name, tool_call_id,
                  batch_id, mutation_kind, before_state, before_hash, after_state,
                  after_hash, status, error_code, created_at, updated_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record.id,
                    record.session_id,
                    record.active_session_id,
                    record.trace_id,
                    record.turn_index,
                    record.snapshot_id,
                    record.workspace_identity,
                    *scope,
                    record.canonical_path,
                    record.display_path,
                    record.tool_name,
                    record.tool_call_id,
                    record.batch_id,
                    record.mutation_kind,
                    record.before_state,
                    record.before_hash,
                    record.after_state,
                    record.after_hash,
                    record.status,
                    record.error_code,
                    record.created_at,
                    record.updated_at,
                ),
            )
        return record

    def update_mutation(
        self,
        mutation_id: str,
        *,
        status: str,
        after_state: str | None = None,
        after_hash: str | None = None,
        error_code: str | None = None,
        conn: sqlite3.Connection | None = None,
    ) -> FileHistoryMutationRecord | None:
        with self._connection(conn) as active:
            active.execute(
                """
                update file_history_mutations
                   set status = ?, after_state = ?, after_hash = ?, error_code = ?, updated_at = ?
                 where id = ?
                """,
                (status, after_state, after_hash, error_code, to_iso_z(utc_now()), mutation_id),
            )
            row = active.execute(
                "select * from file_history_mutations where id = ?",
                (mutation_id,),
            ).fetchone()
        return _mutation(row) if row is not None else None

    def get_mutation(
        self,
        mutation_id: str,
        *,
        conn: sqlite3.Connection | None = None,
    ) -> FileHistoryMutationRecord | None:
        with self._connection(conn) as active:
            row = active.execute(
                "select * from file_history_mutations where id = ?",
                (mutation_id,),
            ).fetchone()
        return _mutation(row) if row is not None else None

    def get_mutation_for_snapshot_path(
        self,
        snapshot_id: str,
        canonical_path: str,
        *,
        scope_kind: str = "workspace",
        scope_identity: str | None = None,
        conn: sqlite3.Connection | None = None,
    ) -> FileHistoryMutationRecord | None:
        with self._connection(conn) as active:
            row = active.execute(
                """
                select * from file_history_mutations
                where snapshot_id = ? and canonical_path = ? and scope_kind = ?
                  and (? is null or scope_identity = ?)
                """,
                (snapshot_id, canonical_path, scope_kind, scope_identity, scope_identity),
            ).fetchone()
        return _mutation(row) if row is not None else None

    def list_mutations(
        self,
        *,
        session_id: str | None = None,
        snapshot_id: str | None = None,
        batch_id: str | None = None,
        conn: sqlite3.Connection | None = None,
    ) -> list[FileHistoryMutationRecord]:
        clauses: list[str] = []
        values: list[Any] = []
        for column, value in (
            ("session_id", session_id),
            ("snapshot_id", snapshot_id),
            ("batch_id", batch_id),
        ):
            if value is not None:
                clauses.append(f"{column} = ?")
                values.append(value)
        query = "select * from file_history_mutations"
        if clauses:
            query += " where " + " and ".join(clauses)
        query += (
            " order by created_at asc, scope_kind asc, scope_identity asc, "
            "canonical_path asc, id asc"
        )
        with self._connection(conn) as active:
            rows = active.execute(query, values).fetchall()
        return [_mutation(row) for row in rows]

    def get_path_head(
        self,
        workspace_identity: str,
        canonical_path: str,
        *,
        scope_kind: str = "workspace",
        scope_identity: str | None = None,
        conn: sqlite3.Connection | None = None,
    ) -> FileHistoryPathHeadRecord | None:
        with self._connection(conn) as active:
            row = active.execute(
                """
                select * from file_history_path_heads
                where canonical_path = ? and scope_kind = ? and scope_identity = ?
                """,
                (canonical_path, scope_kind, scope_identity or workspace_identity),
            ).fetchone()
        return _path_head(row) if row is not None else None

    def get_path_heads(
        self,
        resources: Sequence[tuple[str, str, str]],
        *,
        conn: sqlite3.Connection | None = None,
    ) -> list[FileHistoryPathHeadRecord]:
        """Load path heads for many resource identities using one connection.

        SQLite commonly limits a statement to 999 bound variables, so the
        composite resource keys are queried in bounded chunks.  This avoids
        opening one database connection per file during large previews while
        preserving the exact multi-scope identity lookup.
        """

        normalized = tuple(
            dict.fromkeys(
                (str(kind), str(identity), str(canonical_path))
                for kind, identity, canonical_path in resources
            )
        )
        if not normalized:
            return []
        rows: list[sqlite3.Row] = []
        with self._connection(conn) as active:
            for offset in range(0, len(normalized), 250):
                chunk = normalized[offset : offset + 250]
                predicates = " or ".join(
                    "(scope_kind = ? and scope_identity = ? and canonical_path = ?)"
                    for _ in chunk
                )
                values = [value for resource in chunk for value in resource]
                rows.extend(
                    active.execute(
                        f"select * from file_history_path_heads where {predicates}",
                        values,
                    ).fetchall()
                )
        return [_path_head(row) for row in rows]

    def upsert_path_head(
        self,
        record: FileHistoryPathHeadRecord,
        *,
        conn: sqlite3.Connection | None = None,
    ) -> FileHistoryPathHeadRecord:
        with self._connection(conn) as active:
            scope = self._session_scope(
                active,
                record.session_id,
                scope_kind=record.scope_kind,
                scope_identity=record.scope_identity,
                scope_root=record.scope_root,
                scope_label=record.scope_label,
                fallback_identity=record.workspace_identity,
            )
            active.execute(
                """
                insert into file_history_path_heads (
                  workspace_identity, scope_kind, scope_identity, scope_root, scope_label,
                  canonical_path, display_path, session_id, trace_id,
                  mutation_id, state, content_hash, revision, updated_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                on conflict(scope_kind, scope_identity, canonical_path) do update set
                  workspace_identity=excluded.workspace_identity,
                  scope_root=excluded.scope_root,
                  scope_label=excluded.scope_label,
                  display_path=excluded.display_path,
                  session_id=excluded.session_id,
                  trace_id=excluded.trace_id,
                  mutation_id=excluded.mutation_id,
                  state=excluded.state,
                  content_hash=excluded.content_hash,
                  revision=file_history_path_heads.revision + 1,
                  updated_at=excluded.updated_at
                """,
                (
                    record.workspace_identity,
                    *scope,
                    record.canonical_path,
                    record.display_path,
                    record.session_id,
                    record.trace_id,
                    record.mutation_id,
                    record.state,
                    record.content_hash,
                    max(1, record.revision),
                    record.updated_at,
                ),
            )
            row = active.execute(
                """
                select * from file_history_path_heads
                where scope_kind = ? and scope_identity = ? and canonical_path = ?
                """,
                (scope[0], scope[1], record.canonical_path),
            ).fetchone()
        if row is None:
            raise RuntimeError("file history path head was not persisted")
        return _path_head(row)

    def upsert_path_heads(
        self,
        records: Sequence[FileHistoryPathHeadRecord],
        *,
        conn: sqlite3.Connection | None = None,
    ) -> None:
        """Persist path heads as one batch without per-row readback."""

        if not records:
            return
        with self._connection(conn) as active:
            normalized = [
                (
                    record,
                    self._session_scope(
                        active,
                        record.session_id,
                        scope_kind=record.scope_kind,
                        scope_identity=record.scope_identity,
                        scope_root=record.scope_root,
                        scope_label=record.scope_label,
                        fallback_identity=record.workspace_identity,
                    ),
                )
                for record in records
            ]
            active.executemany(
                """
                insert into file_history_path_heads (
                  workspace_identity, scope_kind, scope_identity, scope_root, scope_label,
                  canonical_path, display_path, session_id, trace_id,
                  mutation_id, state, content_hash, revision, updated_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                on conflict(scope_kind, scope_identity, canonical_path) do update set
                  workspace_identity=excluded.workspace_identity,
                  scope_root=excluded.scope_root,
                  scope_label=excluded.scope_label,
                  display_path=excluded.display_path,
                  session_id=excluded.session_id,
                  trace_id=excluded.trace_id,
                  mutation_id=excluded.mutation_id,
                  state=excluded.state,
                  content_hash=excluded.content_hash,
                  revision=file_history_path_heads.revision + 1,
                  updated_at=excluded.updated_at
                """,
                [
                    (
                        record.workspace_identity,
                        *scope,
                        record.canonical_path,
                        record.display_path,
                        record.session_id,
                        record.trace_id,
                        record.mutation_id,
                        record.state,
                        record.content_hash,
                        max(1, record.revision),
                        record.updated_at,
                    )
                    for record, scope in normalized
                ],
            )

    def create_operation(
        self,
        record: FileHistoryOperationRecord,
        files: Sequence[FileHistoryOperationFileRecord] = (),
        *,
        conn: sqlite3.Connection | None = None,
    ) -> FileHistoryOperationRecord:
        with self._connection(conn) as active:
            active.execute(
                """
                insert into file_history_operations (
                  id, request_id, session_id, active_session_id, target_snapshot_id,
                  target_trace_id, target_message_event_id, workspace_identity, mode,
                  decision, state, preview_token, preview_revision, conversation_rewound,
                  active_snapshot_before, active_snapshot_after, restored_count,
                  skipped_count, forced_count, error_code, error_detail_json,
                  compensation_state, created_at, updated_at, completed_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    record.id,
                    record.request_id,
                    record.session_id,
                    record.active_session_id,
                    record.target_snapshot_id,
                    record.target_trace_id,
                    record.target_message_event_id,
                    record.workspace_identity,
                    record.mode,
                    record.decision,
                    record.state,
                    record.preview_token,
                    record.preview_revision,
                    int(record.conversation_rewound),
                    record.active_snapshot_before,
                    record.active_snapshot_after,
                    record.restored_count,
                    record.skipped_count,
                    record.forced_count,
                    record.error_code,
                    _json_dumps(record.error_detail),
                    record.compensation_state,
                    record.created_at,
                    record.updated_at,
                    record.completed_at,
                ),
            )
            self.replace_operation_files(record.id, files, conn=active)
        return record

    def replace_operation_files(
        self,
        operation_id: str,
        files: Sequence[FileHistoryOperationFileRecord],
        *,
        conn: sqlite3.Connection | None = None,
    ) -> None:
        with self._connection(conn) as active:
            active.execute(
                "delete from file_history_operation_files where operation_id = ?",
                (operation_id,),
            )
            operation = active.execute(
                "select session_id, workspace_identity from file_history_operations where id = ?",
                (operation_id,),
            ).fetchone()
            if operation is None:
                raise ValueError(f"文件恢复操作不存在: {operation_id}")
            normalized = [
                (
                    item,
                    self._session_scope(
                        active,
                        str(operation["session_id"]),
                        scope_kind=item.scope_kind,
                        scope_identity=item.scope_identity,
                        scope_root=item.scope_root,
                        scope_label=item.scope_label,
                        fallback_identity=str(operation["workspace_identity"] or ""),
                    ),
                )
                for item in files
            ]
            active.executemany(
                """
                insert into file_history_operation_files (
                  operation_id, scope_kind, scope_identity, scope_root, scope_label,
                  canonical_path, display_path, preview_current_state,
                  preview_current_hash, target_state, target_backup_file_name, target_hash,
                  target_size, target_mode, classification, reason_code, writer_session_id,
                  user_authorized, result_state, error_code, safety_state,
                  safety_backup_file_name, safety_hash, safety_size, safety_mode, updated_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        item.operation_id,
                        *scope,
                        item.canonical_path,
                        item.display_path,
                        item.preview_current_state,
                        item.preview_current_hash,
                        item.target_state,
                        item.target_backup_file_name,
                        item.target_hash,
                        item.target_size,
                        item.target_mode,
                        item.classification,
                        item.reason_code,
                        item.writer_session_id,
                        int(item.user_authorized),
                        item.result_state,
                        item.error_code,
                        item.safety_state,
                        item.safety_backup_file_name,
                        item.safety_hash,
                        item.safety_size,
                        item.safety_mode,
                        item.updated_at,
                    )
                    for item, scope in normalized
                ],
            )

    def get_operation(
        self,
        operation_id: str,
        *,
        conn: sqlite3.Connection | None = None,
    ) -> FileHistoryOperationRecord | None:
        with self._connection(conn) as active:
            row = active.execute(
                "select * from file_history_operations where id = ?",
                (operation_id,),
            ).fetchone()
        return _operation(row) if row is not None else None

    def get_operation_by_request(
        self,
        session_id: str,
        request_id: str,
        *,
        conn: sqlite3.Connection | None = None,
    ) -> FileHistoryOperationRecord | None:
        with self._connection(conn) as active:
            row = active.execute(
                """
                select * from file_history_operations
                where session_id = ? and request_id = ?
                """,
                (session_id, request_id),
            ).fetchone()
        return _operation(row) if row is not None else None

    def list_operations(
        self,
        *,
        states: Sequence[str] | None = None,
        session_id: str | None = None,
        conn: sqlite3.Connection | None = None,
    ) -> list[FileHistoryOperationRecord]:
        clauses: list[str] = []
        values: list[Any] = []
        if states:
            normalized = tuple(sorted(set(states)))
            placeholders = ",".join("?" for _ in normalized)
            clauses.append(f"state in ({placeholders})")
            values.extend(normalized)
        if session_id is not None:
            clauses.append("session_id = ?")
            values.append(session_id)
        query = "select * from file_history_operations"
        if clauses:
            query += " where " + " and ".join(clauses)
        query += " order by created_at asc, id asc"
        with self._connection(conn) as active:
            rows = active.execute(query, values).fetchall()
        return [_operation(row) for row in rows]

    def list_operation_target_snapshot_ids(
        self,
        *,
        conn: sqlite3.Connection | None = None,
    ) -> set[str]:
        with self._connection(conn) as active:
            rows = active.execute(
                """
                select distinct target_snapshot_id
                  from file_history_operations
                 where target_snapshot_id is not null
                """
            ).fetchall()
        return {str(row[0]) for row in rows}

    def delete_operations(
        self,
        operation_ids: Sequence[str],
        *,
        conn: sqlite3.Connection | None = None,
    ) -> int:
        normalized = tuple(sorted({str(value) for value in operation_ids if str(value)}))
        if not normalized:
            return 0
        placeholders = ",".join("?" for _ in normalized)
        with self._connection(conn) as active:
            cursor = active.execute(
                f"delete from file_history_operations where id in ({placeholders})",
                normalized,
            )
        return max(0, int(cursor.rowcount))

    def list_referenced_artifacts(
        self,
        *,
        conn: sqlite3.Connection | None = None,
    ) -> set[str]:
        """Return root-relative artifact paths pinned by durable metadata."""

        with self._connection(conn) as active:
            snapshot_rows = active.execute(
                """
                select snapshot.session_id, entry.backup_file_name
                  from file_history_snapshot_entries entry
                  join file_history_snapshots snapshot on snapshot.id = entry.snapshot_id
                 where entry.backup_file_name is not null
                """
            ).fetchall()
            safety_rows = active.execute(
                """
                select safety_backup_file_name
                  from file_history_operation_files
                 where safety_backup_file_name is not null
                """
            ).fetchall()
        referenced = {
            f"{row['session_id']}/{row['backup_file_name']}" for row in snapshot_rows
        }
        referenced.update(str(row[0]).replace("\\", "/") for row in safety_rows)
        return referenced

    def delete_expired_locks(
        self,
        *,
        conn: sqlite3.Connection | None = None,
    ) -> int:
        with self._connection(conn) as active:
            cursor = active.execute(
                "delete from file_history_locks where expires_at <= ?",
                (to_iso_z(utc_now()),),
            )
        return max(0, int(cursor.rowcount))

    def claim_operation(
        self,
        operation_id: str,
        *,
        request_id: str,
        mode: str,
        decision: str,
        conn: sqlite3.Connection | None = None,
    ) -> FileHistoryOperationRecord | None:
        with self._connection(conn) as active:
            cursor = active.execute(
                """
                update file_history_operations
                   set request_id = ?, mode = ?, decision = ?, state = 'running',
                       updated_at = ?
                 where id = ? and state = 'previewed' and request_id like 'preview:%'
                """,
                (request_id, mode, decision, to_iso_z(utc_now()), operation_id),
            )
            if cursor.rowcount != 1:
                return None
            row = active.execute(
                "select * from file_history_operations where id = ?",
                (operation_id,),
            ).fetchone()
        return _operation(row) if row is not None else None

    def is_session_turn_running(
        self,
        session_id: str,
        *,
        conn: sqlite3.Connection | None = None,
    ) -> bool:
        with self._connection(conn) as active:
            row = active.execute(
                """
                select 1
                  from trace_record
                 where session_id = ? and status = 'running' and is_deleted = 0
                 limit 1
                """,
                (session_id,),
            ).fetchone()
        return row is not None

    def acquire_operation_locks(
        self,
        operation_id: str,
        lock_keys: Sequence[str],
        *,
        lease_seconds: int = 3600,
        conn: sqlite3.Connection | None = None,
    ) -> bool:
        """Atomically acquire all persistent restore leases.

        Expired rows are reclaimed in the same immediate transaction. The
        caller must still hold the in-process locks while using this lease.
        """

        ordered_keys = tuple(sorted(set(lock_keys)))
        if not ordered_keys:
            return True
        now = to_iso_z(utc_now())
        expires_at = to_iso_z(utc_now() + timedelta(seconds=max(1, lease_seconds)))
        with self._connection(conn) as active:
            active.execute("delete from file_history_locks where expires_at <= ?", (now,))
            placeholders = ",".join("?" for _ in ordered_keys)
            occupied = active.execute(
                f"""
                select lock_key from file_history_locks
                 where lock_key in ({placeholders})
                   and owner_operation_id <> ?
                 limit 1
                """,
                (*ordered_keys, operation_id),
            ).fetchone()
            if occupied is not None:
                return False
            for lock_key in ordered_keys:
                active.execute(
                    """
                    insert into file_history_locks (
                      lock_key, owner_operation_id, acquired_at, expires_at
                    ) values (?, ?, ?, ?)
                    on conflict(lock_key) do update set
                      acquired_at = excluded.acquired_at,
                      expires_at = excluded.expires_at
                    where file_history_locks.owner_operation_id = excluded.owner_operation_id
                    """,
                    (lock_key, operation_id, now, expires_at),
                )
        return True

    def release_operation_locks(
        self,
        operation_id: str,
        lock_keys: Sequence[str] | None = None,
        *,
        conn: sqlite3.Connection | None = None,
    ) -> None:
        with self._connection(conn) as active:
            if lock_keys:
                ordered_keys = tuple(sorted(set(lock_keys)))
                placeholders = ",".join("?" for _ in ordered_keys)
                active.execute(
                    f"""
                    delete from file_history_locks
                     where owner_operation_id = ? and lock_key in ({placeholders})
                    """,
                    (operation_id, *ordered_keys),
                )
                return
            active.execute(
                "delete from file_history_locks where owner_operation_id = ?",
                (operation_id,),
            )

    def list_operation_files(
        self,
        operation_id: str,
        *,
        conn: sqlite3.Connection | None = None,
    ) -> list[FileHistoryOperationFileRecord]:
        with self._connection(conn) as active:
            rows = active.execute(
                """
                select * from file_history_operation_files
                where operation_id = ?
                order by scope_kind asc, scope_identity asc, canonical_path asc
                """,
                (operation_id,),
            ).fetchall()
        return [_operation_file(row) for row in rows]

    def update_operation(
        self,
        operation_id: str,
        *,
        state: str | None = None,
        mode: str | None = None,
        decision: str | None | object = ...,
        conversation_rewound: bool | None = None,
        active_snapshot_after: str | None | object = ...,
        restored_count: int | None = None,
        skipped_count: int | None = None,
        forced_count: int | None = None,
        error_code: str | None | object = ...,
        error_detail: dict[str, Any] | None = None,
        compensation_state: str | None = None,
        completed: bool = False,
        conn: sqlite3.Connection | None = None,
    ) -> FileHistoryOperationRecord | None:
        assignments = ["updated_at = ?"]
        values: list[Any] = [to_iso_z(utc_now())]
        fields: tuple[tuple[str, Any], ...] = (
            ("state", state),
            ("mode", mode),
            (
                "conversation_rewound",
                None if conversation_rewound is None else int(conversation_rewound),
            ),
            ("restored_count", restored_count),
            ("skipped_count", skipped_count),
            ("forced_count", forced_count),
            ("compensation_state", compensation_state),
        )
        for column, value in fields:
            if value is not None:
                assignments.append(f"{column} = ?")
                values.append(value)
        for column, value in (
            ("decision", decision),
            ("active_snapshot_after", active_snapshot_after),
            ("error_code", error_code),
        ):
            if value is not ...:
                assignments.append(f"{column} = ?")
                values.append(value)
        if error_detail is not None:
            assignments.append("error_detail_json = ?")
            values.append(_json_dumps(error_detail))
        if completed:
            assignments.append("completed_at = ?")
            values.append(to_iso_z(utc_now()))
        values.append(operation_id)
        with self._connection(conn) as active:
            active.execute(
                f"update file_history_operations set {', '.join(assignments)} where id = ?",
                values,
            )
            row = active.execute(
                "select * from file_history_operations where id = ?",
                (operation_id,),
            ).fetchone()
        return _operation(row) if row is not None else None

    def update_operation_file(
        self,
        operation_id: str,
        canonical_path: str,
        *,
        scope_kind: str = "workspace",
        scope_identity: str | None = None,
        result_state: str | None = None,
        user_authorized: bool | None = None,
        error_code: str | None | object = ...,
        safety_state: str | None | object = ...,
        safety_backup_file_name: str | None | object = ...,
        safety_hash: str | None | object = ...,
        safety_size: int | None | object = ...,
        safety_mode: int | None | object = ...,
        conn: sqlite3.Connection | None = None,
    ) -> FileHistoryOperationFileRecord | None:
        assignments = ["updated_at = ?"]
        values: list[Any] = [to_iso_z(utc_now())]
        if result_state is not None:
            assignments.append("result_state = ?")
            values.append(result_state)
        if user_authorized is not None:
            assignments.append("user_authorized = ?")
            values.append(int(user_authorized))
        for column, value in (
            ("error_code", error_code),
            ("safety_state", safety_state),
            ("safety_backup_file_name", safety_backup_file_name),
            ("safety_hash", safety_hash),
            ("safety_size", safety_size),
            ("safety_mode", safety_mode),
        ):
            if value is not ...:
                assignments.append(f"{column} = ?")
                values.append(value)
        values.extend((operation_id, canonical_path, scope_kind, scope_identity, scope_identity))
        with self._connection(conn) as active:
            active.execute(
                f"""
                update file_history_operation_files
                   set {', '.join(assignments)}
                 where operation_id = ? and canonical_path = ? and scope_kind = ?
                   and (? is null or scope_identity = ?)
                """,
                values,
            )
            row = active.execute(
                """
                select * from file_history_operation_files
                where operation_id = ? and canonical_path = ? and scope_kind = ?
                  and (? is null or scope_identity = ?)
                """,
                (operation_id, canonical_path, scope_kind, scope_identity, scope_identity),
            ).fetchone()
        return _operation_file(row) if row is not None else None


def _session_state(row: sqlite3.Row) -> FileHistorySessionStateRecord:
    return FileHistorySessionStateRecord(**dict(row))


def _snapshot(row: sqlite3.Row) -> FileHistorySnapshotRecord:
    return FileHistorySnapshotRecord(**dict(row))


def _snapshot_entry(row: sqlite3.Row) -> FileHistorySnapshotEntryRecord:
    return FileHistorySnapshotEntryRecord(**dict(row))


def _tracked_file(row: sqlite3.Row) -> FileHistoryTrackedFileRecord:
    return FileHistoryTrackedFileRecord(**dict(row))


def _mutation(row: sqlite3.Row) -> FileHistoryMutationRecord:
    return FileHistoryMutationRecord(**dict(row))


def _path_head(row: sqlite3.Row) -> FileHistoryPathHeadRecord:
    return FileHistoryPathHeadRecord(**dict(row))


def _operation(row: sqlite3.Row) -> FileHistoryOperationRecord:
    values = dict(row)
    values["conversation_rewound"] = bool(values["conversation_rewound"])
    values["error_detail"] = _json_loads(values.pop("error_detail_json"))
    return FileHistoryOperationRecord(**values)


def _operation_file(row: sqlite3.Row) -> FileHistoryOperationFileRecord:
    values = dict(row)
    values["user_authorized"] = bool(values["user_authorized"])
    return FileHistoryOperationFileRecord(**values)
