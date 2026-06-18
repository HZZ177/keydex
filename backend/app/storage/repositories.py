import json
import sqlite3
from dataclasses import dataclass
from typing import Any

from backend.app.core.time import to_iso_z, utc_now
from backend.app.storage.db import Database


def _json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _json_loads(value: str | None, default: Any = None) -> Any:
    if value is None:
        return default
    return json.loads(value)


@dataclass(frozen=True)
class ModelProviderRecord:
    id: str
    name: str
    base_url: str
    api_key: str | None
    enabled: bool
    models: list[str]
    model_enabled: dict[str, bool]
    health: dict[str, Any]
    created_at: str
    updated_at: str


@dataclass(frozen=True)
class ModelDefaultRecord:
    scope: str
    provider_id: str
    model: str
    updated_at: str


@dataclass(frozen=True)
class SessionRecord:
    id: str
    user_id: str
    scene_id: str
    status: str
    session_tag: str
    title: str | None
    active_session_id: str | None
    created_at: str
    updated_at: str
    scene_version_seq: int | None = None
    is_debug: bool = False
    debug_type: str | None = None
    is_scheduled: bool = False
    scheduled_task_id: str | None = None
    parent_session_id: str | None = None
    child_session_id: str | None = None
    source_trace_id: str | None = None
    source_active_session_id: str | None = None
    source_checkpoint_id: str | None = None
    source_checkpoint_ns: str | None = None
    is_deleted: bool = False


@dataclass(frozen=True)
class MessageEventRecord:
    id: str
    session_id: str
    seq: int
    turn_index: int
    action: str
    data: dict[str, Any]
    created_at: str
    updated_at: str
    trace_record_id: str | None = None
    is_deleted: bool = False


@dataclass(frozen=True)
class TraceRecord:
    trace_id: str
    session_id: str
    scene_id: str
    user_id: str
    turn_index: int
    root_node_id: str
    status: str
    start_time: str
    created_at: str
    updated_at: str
    active_session_id: str | None = None
    scene_name: str | None = None
    scene_version_seq: int | None = None
    end_time: str | None = None
    duration_ms: int | None = None
    total_input_tokens: int = 0
    total_output_tokens: int = 0
    total_tokens: int = 0
    total_cache_read_tokens: int = 0
    user_message_preview: str | None = None
    output_checkpoint_id: str | None = None
    output_checkpoint_ns: str | None = None
    metadata: dict[str, Any] | None = None
    is_deleted: bool = False


@dataclass(frozen=True)
class TraceEventLogRecord:
    id: int
    trace_id: str
    trace_record_id: str
    event_type: str
    source: str
    idempotency_key: str
    timestamp_ms: int
    occurred_at: str
    payload: dict[str, Any]
    created_at: str
    updated_at: str
    node_id: str | None = None
    parent_node_id: str | None = None
    root_node_id: str | None = None
    sequence_no: int | None = None
    run_id: str | None = None
    turn_index: int | None = None
    user_id: str | None = None
    original_session_id: str | None = None
    active_session_id: str | None = None
    tags: dict[str, Any] | None = None


class SettingsRepository:
    def __init__(self, db: Database) -> None:
        self.db = db

    def set(self, key: str, value: Any) -> None:
        with self.db.transaction() as conn:
            conn.execute(
                """
                insert into settings (key, value_json, updated_at)
                values (?, ?, ?)
                on conflict(key) do update set
                  value_json=excluded.value_json,
                  updated_at=excluded.updated_at
                """,
                (key, _json_dumps(value), to_iso_z(utc_now())),
            )

    def get(self, key: str, default: Any = None) -> Any:
        with self.db.connect() as conn:
            row = conn.execute("select value_json from settings where key = ?", (key,)).fetchone()
        return _json_loads(row["value_json"], default) if row else default


class ModelProvidersRepository:
    def __init__(self, db: Database) -> None:
        self.db = db

    def upsert(self, provider: ModelProviderRecord) -> None:
        with self.db.transaction() as conn:
            conn.execute(
                """
                insert into model_providers (
                  id, name, base_url, api_key_encrypted, enabled, models_json,
                  model_enabled_json, health_json, created_at, updated_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                on conflict(id) do update set
                  name=excluded.name,
                  base_url=excluded.base_url,
                  api_key_encrypted=excluded.api_key_encrypted,
                  enabled=excluded.enabled,
                  models_json=excluded.models_json,
                  model_enabled_json=excluded.model_enabled_json,
                  health_json=excluded.health_json,
                  updated_at=excluded.updated_at
                """,
                (
                    provider.id,
                    provider.name,
                    provider.base_url,
                    provider.api_key,
                    int(provider.enabled),
                    _json_dumps(provider.models),
                    _json_dumps(provider.model_enabled),
                    _json_dumps(provider.health),
                    provider.created_at,
                    provider.updated_at,
                ),
            )

    def get(self, provider_id: str) -> ModelProviderRecord | None:
        with self.db.connect() as conn:
            row = conn.execute(
                "select * from model_providers where id = ?",
                (provider_id,),
            ).fetchone()
        return self._from_row(row) if row else None

    def list(self) -> list[ModelProviderRecord]:
        with self.db.connect() as conn:
            rows = conn.execute(
                "select * from model_providers order by created_at, name",
            ).fetchall()
        return [self._from_row(row) for row in rows]

    def delete(self, provider_id: str) -> bool:
        with self.db.transaction() as conn:
            cursor = conn.execute("delete from model_providers where id = ?", (provider_id,))
        return cursor.rowcount > 0

    def set_default(self, *, scope: str, provider_id: str, model: str) -> None:
        with self.db.transaction() as conn:
            conn.execute(
                """
                insert into model_defaults (scope, provider_id, model, updated_at)
                values (?, ?, ?, ?)
                on conflict(scope) do update set
                  provider_id=excluded.provider_id,
                  model=excluded.model,
                  updated_at=excluded.updated_at
                """,
                (scope, provider_id, model, to_iso_z(utc_now())),
            )

    def get_default(self, scope: str = "global") -> ModelDefaultRecord | None:
        with self.db.connect() as conn:
            row = conn.execute(
                "select * from model_defaults where scope = ?",
                (scope,),
            ).fetchone()
        return (
            ModelDefaultRecord(
                scope=row["scope"],
                provider_id=row["provider_id"],
                model=row["model"],
                updated_at=row["updated_at"],
            )
            if row
            else None
        )

    @staticmethod
    def _from_row(row: sqlite3.Row) -> ModelProviderRecord:
        return ModelProviderRecord(
            id=row["id"],
            name=row["name"],
            base_url=row["base_url"],
            api_key=row["api_key_encrypted"],
            enabled=bool(row["enabled"]),
            models=_json_loads(row["models_json"], []),
            model_enabled=_json_loads(row["model_enabled_json"], {}),
            health=_json_loads(row["health_json"], {}),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )


class SessionsRepository:
    VALID_STATUSES = {"active", "closed", "failed", "running"}

    def __init__(self, db: Database) -> None:
        self.db = db

    def create(
        self,
        *,
        session_id: str,
        user_id: str,
        scene_id: str,
        title: str | None = None,
        status: str = "active",
        session_tag: str = "chat",
        scene_version_seq: int | None = None,
        active_session_id: str | None = None,
        is_debug: bool = False,
    ) -> SessionRecord:
        self._validate_status(status)
        now = to_iso_z(utc_now())
        resolved_active_session_id = active_session_id or session_id
        with self.db.transaction() as conn:
            conn.execute(
                """
                insert into sessions (
                  id, user_id, scene_id, scene_version_seq, status, is_debug,
                  session_tag, active_session_id, title, created_at, updated_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    session_id,
                    user_id,
                    scene_id,
                    scene_version_seq,
                    status,
                    int(is_debug),
                    session_tag,
                    resolved_active_session_id,
                    title,
                    now,
                    now,
                ),
            )
        record = self.get(session_id)
        if record is None:
            raise RuntimeError(f"创建 session 后无法读取: {session_id}")
        return record

    def get(self, session_id: str, *, include_deleted: bool = False) -> SessionRecord | None:
        query = "select * from sessions where id = ?"
        params: list[Any] = [session_id]
        if not include_deleted:
            query += " and is_deleted = 0"
        with self.db.connect() as conn:
            row = conn.execute(query, params).fetchone()
        return self._from_row(row) if row else None

    def list(
        self,
        *,
        user_id: str | None = None,
        scene_id: str | None = None,
        status: str | None = None,
        session_tag: str | None = None,
        include_deleted: bool = False,
        limit: int = 100,
    ) -> list[SessionRecord]:
        filters: list[str] = []
        params: list[Any] = []
        if user_id is not None:
            filters.append("user_id = ?")
            params.append(user_id)
        if scene_id is not None:
            filters.append("scene_id = ?")
            params.append(scene_id)
        if status is not None:
            self._validate_status(status)
            filters.append("status = ?")
            params.append(status)
        if session_tag is not None:
            filters.append("session_tag = ?")
            params.append(session_tag)
        if not include_deleted:
            filters.append("is_deleted = 0")

        where = f"where {' and '.join(filters)}" if filters else ""
        params.append(max(1, min(limit, 500)))
        with self.db.connect() as conn:
            rows = conn.execute(
                f"""
                select * from sessions
                {where}
                order by updated_at desc, created_at desc, id desc
                limit ?
                """,
                params,
            ).fetchall()
        return [self._from_row(row) for row in rows]

    def update(
        self,
        session_id: str,
        *,
        title: str | None = None,
        status: str | None = None,
        active_session_id: str | None = None,
    ) -> SessionRecord | None:
        assignments: list[str] = []
        params: list[Any] = []
        if title is not None:
            assignments.append("title = ?")
            params.append(title)
        if status is not None:
            self._validate_status(status)
            assignments.append("status = ?")
            params.append(status)
        if active_session_id is not None:
            assignments.append("active_session_id = ?")
            params.append(active_session_id)
        if not assignments:
            return self.get(session_id)

        assignments.append("updated_at = ?")
        params.append(to_iso_z(utc_now()))
        params.append(session_id)
        with self.db.transaction() as conn:
            conn.execute(
                f"update sessions set {', '.join(assignments)} where id = ? and is_deleted = 0",
                params,
            )
        return self.get(session_id)

    def touch(self, session_id: str) -> SessionRecord | None:
        with self.db.transaction() as conn:
            conn.execute(
                "update sessions set updated_at = ? where id = ? and is_deleted = 0",
                (to_iso_z(utc_now()), session_id),
            )
        return self.get(session_id)

    def close(self, session_id: str) -> SessionRecord | None:
        return self.update(session_id, status="closed")

    def soft_delete(self, session_id: str) -> SessionRecord | None:
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            cursor = conn.execute(
                """
                update sessions
                set is_deleted = 1, updated_at = ?
                where id = ? and is_deleted = 0
                """,
                (now, session_id),
            )
        if cursor.rowcount == 0:
            return None
        return self.get(session_id, include_deleted=True)

    @classmethod
    def _validate_status(cls, status: str) -> None:
        if status not in cls.VALID_STATUSES:
            raise ValueError(f"不支持的 session 状态: {status}")

    @staticmethod
    def _from_row(row: sqlite3.Row) -> SessionRecord:
        return SessionRecord(
            id=row["id"],
            user_id=row["user_id"],
            scene_id=row["scene_id"],
            scene_version_seq=row["scene_version_seq"],
            status=row["status"],
            is_debug=bool(row["is_debug"]),
            debug_type=row["debug_type"],
            is_scheduled=bool(row["is_scheduled"]),
            scheduled_task_id=row["scheduled_task_id"],
            session_tag=row["session_tag"],
            active_session_id=row["active_session_id"],
            parent_session_id=row["parent_session_id"],
            child_session_id=row["child_session_id"],
            source_trace_id=row["source_trace_id"],
            source_active_session_id=row["source_active_session_id"],
            source_checkpoint_id=row["source_checkpoint_id"],
            source_checkpoint_ns=row["source_checkpoint_ns"],
            title=row["title"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            is_deleted=bool(row["is_deleted"]),
        )


class MessageEventsRepository:
    def __init__(self, db: Database) -> None:
        self.db = db

    def append(
        self,
        *,
        event_id: str,
        session_id: str,
        turn_index: int,
        action: str,
        data: dict[str, Any] | None = None,
        trace_record_id: str | None = None,
    ) -> MessageEventRecord:
        now = to_iso_z(utc_now())
        with self.db.transaction(immediate=True) as conn:
            row = conn.execute(
                """
                select coalesce(max(seq), 0) as max_seq
                from message_events
                where session_id = ? and is_deleted = 0
                """,
                (session_id,),
            ).fetchone()
            seq = int(row["max_seq"]) + 1
            conn.execute(
                """
                insert into message_events (
                  id, session_id, trace_record_id, seq, turn_index, action,
                  data_json, created_at, updated_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    event_id,
                    session_id,
                    trace_record_id,
                    seq,
                    turn_index,
                    action,
                    _json_dumps(data or {}),
                    now,
                    now,
                ),
            )
        record = self.get(event_id)
        if record is None:
            raise RuntimeError(f"追加 message event 后无法读取: {event_id}")
        return record

    def get(self, event_id: str, *, include_deleted: bool = False) -> MessageEventRecord | None:
        query = "select * from message_events where id = ?"
        params: list[Any] = [event_id]
        if not include_deleted:
            query += " and is_deleted = 0"
        with self.db.connect() as conn:
            row = conn.execute(query, params).fetchone()
        return self._from_row(row) if row else None

    def list_by_session(
        self,
        session_id: str,
        *,
        include_deleted: bool = False,
        limit: int = 1000,
    ) -> list[MessageEventRecord]:
        query = "select * from message_events where session_id = ?"
        params: list[Any] = [session_id]
        if not include_deleted:
            query += " and is_deleted = 0"
        query += " order by seq asc limit ?"
        params.append(max(1, min(limit, 5000)))
        with self.db.connect() as conn:
            rows = conn.execute(query, params).fetchall()
        return [self._from_row(row) for row in rows]

    def list_by_turn(
        self,
        session_id: str,
        turn_index: int,
        *,
        include_deleted: bool = False,
    ) -> list[MessageEventRecord]:
        query = "select * from message_events where session_id = ? and turn_index = ?"
        params: list[Any] = [session_id, turn_index]
        if not include_deleted:
            query += " and is_deleted = 0"
        query += " order by seq asc"
        with self.db.connect() as conn:
            rows = conn.execute(query, params).fetchall()
        return [self._from_row(row) for row in rows]

    def get_max_seq_and_turn(self, session_id: str) -> tuple[int, int]:
        with self.db.connect() as conn:
            row = conn.execute(
                """
                select
                  coalesce(max(seq), 0) as max_seq,
                  coalesce(max(turn_index), 0) as max_turn
                from message_events
                where session_id = ? and is_deleted = 0
                """,
                (session_id,),
            ).fetchone()
        return int(row["max_seq"]), int(row["max_turn"])

    @staticmethod
    def _from_row(row: sqlite3.Row) -> MessageEventRecord:
        return MessageEventRecord(
            id=row["id"],
            session_id=row["session_id"],
            trace_record_id=row["trace_record_id"],
            seq=int(row["seq"]),
            turn_index=int(row["turn_index"]),
            action=row["action"],
            data=_json_loads(row["data_json"], {}),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            is_deleted=bool(row["is_deleted"]),
        )


class TraceRecordsRepository:
    VALID_STATUSES = {"running", "completed", "failed", "cancelled"}

    def __init__(self, db: Database) -> None:
        self.db = db

    def create(
        self,
        *,
        trace_id: str,
        session_id: str,
        scene_id: str,
        user_id: str,
        turn_index: int,
        root_node_id: str,
        active_session_id: str | None = None,
        scene_name: str | None = None,
        scene_version_seq: int | None = None,
        user_message_preview: str | None = None,
        metadata: dict[str, Any] | None = None,
        status: str = "running",
    ) -> TraceRecord:
        self._validate_status(status)
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            conn.execute(
                """
                insert into trace_record (
                  trace_id, session_id, active_session_id, scene_id, scene_name,
                  scene_version_seq, user_id, turn_index, root_node_id, status,
                  start_time, user_message_preview, metadata_json, created_at, updated_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    trace_id,
                    session_id,
                    active_session_id,
                    scene_id,
                    scene_name,
                    scene_version_seq,
                    user_id,
                    turn_index,
                    root_node_id,
                    status,
                    now,
                    user_message_preview,
                    _json_dumps(metadata or {}),
                    now,
                    now,
                ),
            )
        record = self.get(trace_id)
        if record is None:
            raise RuntimeError(f"创建 trace_record 后无法读取: {trace_id}")
        return record

    def get(self, trace_id: str, *, include_deleted: bool = False) -> TraceRecord | None:
        query = "select * from trace_record where trace_id = ?"
        params: list[Any] = [trace_id]
        if not include_deleted:
            query += " and is_deleted = 0"
        with self.db.connect() as conn:
            row = conn.execute(query, params).fetchone()
        return self._from_row(row) if row else None

    def list_by_session(self, session_id: str) -> list[TraceRecord]:
        with self.db.connect() as conn:
            rows = conn.execute(
                """
                select * from trace_record
                where session_id = ? and is_deleted = 0
                order by turn_index asc, created_at asc
                """,
                (session_id,),
            ).fetchall()
        return [self._from_row(row) for row in rows]

    def finish(
        self,
        trace_id: str,
        *,
        status: str,
        duration_ms: int | None = None,
        total_input_tokens: int = 0,
        total_output_tokens: int = 0,
        total_cache_read_tokens: int = 0,
        output_checkpoint_id: str | None = None,
        output_checkpoint_ns: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> TraceRecord | None:
        self._validate_status(status)
        now = to_iso_z(utc_now())
        total_tokens = total_input_tokens + total_output_tokens
        with self.db.transaction() as conn:
            conn.execute(
                """
                update trace_record set
                  status = ?,
                  end_time = ?,
                  duration_ms = ?,
                  total_input_tokens = ?,
                  total_output_tokens = ?,
                  total_tokens = ?,
                  total_cache_read_tokens = ?,
                  output_checkpoint_id = ?,
                  output_checkpoint_ns = ?,
                  metadata_json = ?,
                  updated_at = ?
                where trace_id = ? and is_deleted = 0
                """,
                (
                    status,
                    now,
                    duration_ms,
                    total_input_tokens,
                    total_output_tokens,
                    total_tokens,
                    total_cache_read_tokens,
                    output_checkpoint_id,
                    output_checkpoint_ns,
                    _json_dumps(metadata or {}),
                    now,
                    trace_id,
                ),
            )
        return self.get(trace_id)

    @classmethod
    def _validate_status(cls, status: str) -> None:
        if status not in cls.VALID_STATUSES:
            raise ValueError(f"不支持的 trace 状态: {status}")

    @staticmethod
    def _from_row(row: sqlite3.Row) -> TraceRecord:
        return TraceRecord(
            trace_id=row["trace_id"],
            session_id=row["session_id"],
            active_session_id=row["active_session_id"],
            scene_id=row["scene_id"],
            scene_name=row["scene_name"],
            scene_version_seq=row["scene_version_seq"],
            user_id=row["user_id"],
            turn_index=int(row["turn_index"]),
            root_node_id=row["root_node_id"],
            status=row["status"],
            start_time=row["start_time"],
            end_time=row["end_time"],
            duration_ms=row["duration_ms"],
            total_input_tokens=int(row["total_input_tokens"]),
            total_output_tokens=int(row["total_output_tokens"]),
            total_tokens=int(row["total_tokens"]),
            total_cache_read_tokens=int(row["total_cache_read_tokens"]),
            user_message_preview=row["user_message_preview"],
            output_checkpoint_id=row["output_checkpoint_id"],
            output_checkpoint_ns=row["output_checkpoint_ns"],
            metadata=_json_loads(row["metadata_json"], {}),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            is_deleted=bool(row["is_deleted"]),
        )


class TraceEventLogsRepository:
    def __init__(self, db: Database) -> None:
        self.db = db

    def append(
        self,
        *,
        trace_id: str,
        trace_record_id: str,
        event_type: str,
        source: str,
        idempotency_key: str,
        timestamp_ms: int,
        payload: dict[str, Any],
        occurred_at: str | None = None,
        node_id: str | None = None,
        parent_node_id: str | None = None,
        root_node_id: str | None = None,
        sequence_no: int | None = None,
        run_id: str | None = None,
        turn_index: int | None = None,
        user_id: str | None = None,
        original_session_id: str | None = None,
        active_session_id: str | None = None,
        tags: dict[str, Any] | None = None,
    ) -> TraceEventLogRecord:
        now = to_iso_z(utc_now())
        resolved_occurred_at = occurred_at or now
        with self.db.transaction() as conn:
            cursor = conn.execute(
                """
                insert into trace_event_log (
                  trace_id, trace_record_id, event_type, source, idempotency_key,
                  node_id, parent_node_id, root_node_id, sequence_no, run_id,
                  turn_index, user_id, original_session_id, active_session_id,
                  timestamp_ms, occurred_at, tags_json, payload_json,
                  created_at, updated_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    trace_id,
                    trace_record_id,
                    event_type,
                    source,
                    idempotency_key,
                    node_id,
                    parent_node_id,
                    root_node_id,
                    sequence_no,
                    run_id,
                    turn_index,
                    user_id,
                    original_session_id,
                    active_session_id,
                    timestamp_ms,
                    resolved_occurred_at,
                    _json_dumps(tags or {}),
                    _json_dumps(payload),
                    now,
                    now,
                ),
            )
            row_id = int(cursor.lastrowid)
        record = self.get(row_id)
        if record is None:
            raise RuntimeError(f"追加 trace_event_log 后无法读取: {row_id}")
        return record

    def get(self, row_id: int) -> TraceEventLogRecord | None:
        with self.db.connect() as conn:
            row = conn.execute(
                "select * from trace_event_log where id = ?",
                (row_id,),
            ).fetchone()
        return self._from_row(row) if row else None

    def list_by_trace_record(self, trace_record_id: str) -> list[TraceEventLogRecord]:
        with self.db.connect() as conn:
            rows = conn.execute(
                """
                select * from trace_event_log
                where trace_record_id = ?
                order by sequence_no asc, id asc
                """,
                (trace_record_id,),
            ).fetchall()
        return [self._from_row(row) for row in rows]

    @staticmethod
    def _from_row(row: sqlite3.Row) -> TraceEventLogRecord:
        return TraceEventLogRecord(
            id=int(row["id"]),
            trace_id=row["trace_id"],
            trace_record_id=row["trace_record_id"],
            event_type=row["event_type"],
            source=row["source"],
            idempotency_key=row["idempotency_key"],
            node_id=row["node_id"],
            parent_node_id=row["parent_node_id"],
            root_node_id=row["root_node_id"],
            sequence_no=row["sequence_no"],
            run_id=row["run_id"],
            turn_index=row["turn_index"],
            user_id=row["user_id"],
            original_session_id=row["original_session_id"],
            active_session_id=row["active_session_id"],
            timestamp_ms=int(row["timestamp_ms"]),
            occurred_at=row["occurred_at"],
            tags=_json_loads(row["tags_json"], {}),
            payload=_json_loads(row["payload_json"], {}),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )


class StorageRepositories:
    """Repositories retained during backend runtime replacement.

    The previous Thread/Turn/Item/Event/Approval repositories are intentionally
    removed from this shell. New session/message_event/trace repositories are
    introduced by the kt-agentloop rewrite issues.
    """

    def __init__(self, db: Database) -> None:
        self.db = db
        self.settings = SettingsRepository(db)
        self.model_providers = ModelProvidersRepository(db)
        self.sessions = SessionsRepository(db)
        self.message_events = MessageEventsRepository(db)
        self.trace_records = TraceRecordsRepository(db)
        self.trace_event_logs = TraceEventLogsRepository(db)


def legacy_model_provider_from_settings(value: dict[str, Any]) -> ModelProviderRecord | None:
    base_url = str(value.get("base_url") or "").strip().rstrip("/")
    model = str(value.get("model") or "").strip()
    if not base_url and not model:
        return None
    now = to_iso_z(utc_now())
    models = [model] if model else []
    return ModelProviderRecord(
        id="legacy-openai-compatible",
        name="OpenAI-compatible",
        base_url=base_url,
        api_key=value.get("api_key") if isinstance(value.get("api_key"), str) else None,
        enabled=True,
        models=models,
        model_enabled={model: True} if model else {},
        health={},
        created_at=now,
        updated_at=now,
    )
