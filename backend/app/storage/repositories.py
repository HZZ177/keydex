from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from backend.app.core.ids import new_id
from backend.app.core.time import to_iso_z, utc_now
from backend.app.security import WorkspacePathError, normalize_workspace_root_for_storage
from backend.app.storage.db import Database


def _json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _json_loads(value: str | None, default: Any = None) -> Any:
    if value is None:
        return default
    return json.loads(value)


SENSITIVE_METADATA_KEYS = {
    "api_key",
    "apikey",
    "authorization",
    "proxy_authorization",
    "x-api-key",
    "x_api_key",
    "headers",
}


def _clip_text(value: str | None, limit: int = 4000) -> str | None:
    if value is None:
        return None
    text = str(value)
    if len(text) <= limit:
        return text
    return f"{text[:limit]}..."


def _sanitize_metadata(value: Any) -> Any:
    if isinstance(value, dict):
        cleaned: dict[str, Any] = {}
        for key, item in value.items():
            key_text = str(key)
            if key_text.lower() in SENSITIVE_METADATA_KEYS:
                continue
            cleaned[key_text] = _sanitize_metadata(item)
        return cleaned
    if isinstance(value, list):
        return [_sanitize_metadata(item) for item in value]
    if value is None or isinstance(value, str | int | float | bool):
        return value
    return str(value)


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
class WorkspaceRecord:
    id: str
    name: str
    root_path: str
    normalized_root_path: str
    type: str
    created_at: str
    updated_at: str
    last_opened_at: str | None = None
    is_deleted: bool = False


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
    workspace_id: str | None = None
    session_type: str = "chat"
    cwd: str | None = None
    workspace_roots: list[str] = field(default_factory=list)
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
class WorkspaceFileAnnotationRecord:
    id: str
    scope_type: str
    scope_id: str
    path: str
    anchor_type: str
    comment: str
    created_at: str
    updated_at: str
    workspace_id: str | None = None
    selected_text: str | None = None
    line_start: int | None = None
    line_end: int | None = None
    column_start: int | None = None
    column_end: int | None = None
    content_hash: str | None = None
    anchor_json: dict[str, Any] | None = None
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


@dataclass(frozen=True)
class LLMRequestLogRecord:
    id: str
    trace_id: str
    trace_record_id: str
    session_id: str
    model: str
    status: str
    start_time: str
    created_at: str
    updated_at: str
    active_session_id: str | None = None
    gateway_thread_id: str | None = None
    gateway_trace_id: str | None = None
    turn_index: int | None = None
    provider_id: str | None = None
    provider_name: str | None = None
    end_time: str | None = None
    duration_ms: int | None = None
    input_tokens: int = 0
    cache_read_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    request_preview: str | None = None
    response_preview: str | None = None
    error_message: str | None = None
    metadata: dict[str, Any] | None = None
    is_deleted: bool = False


@dataclass(frozen=True)
class CommandApprovalRequestRecord:
    id: str
    session_id: str
    tool_name: str
    kind: str
    title: str
    description: str
    command: str
    cwd: str
    shell: str
    workspace_root: str
    details: dict[str, Any]
    status: str
    created_at: str
    updated_at: str
    trace_id: str | None = None
    turn_index: int | None = None
    run_id: str | None = None
    decision: str | None = None
    trust_scope: str | None = None
    rule_match_type: str | None = None
    reject_message: str | None = None
    trusted_rule_id: str | None = None
    resolved_at: str | None = None
    is_deleted: bool = False


@dataclass(frozen=True)
class TrustedCommandRuleRecord:
    id: str
    command_pattern: str
    normalized_command: str
    match_type: str
    shell: str
    workspace_root: str
    cwd_pattern: str
    enabled: bool
    created_at: str
    updated_at: str
    created_from_approval_id: str | None = None
    last_used_at: str | None = None
    is_deleted: bool = False


@dataclass(frozen=True)
class CommandApprovalAuditRecord:
    id: str
    approval_id: str
    session_id: str
    command: str
    cwd: str
    decision: str
    created_at: str
    trust_scope: str | None = None
    rule_match_type: str | None = None
    trusted_rule_id: str | None = None
    reject_message: str | None = None
    metadata: dict[str, Any] | None = None


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


class WorkspacesRepository:
    VALID_TYPES = {"project"}

    def __init__(self, db: Database) -> None:
        self.db = db

    def create(
        self,
        *,
        workspace_id: str,
        root_path: str | Path,
        name: str | None = None,
        workspace_type: str = "project",
        last_opened_at: str | None = None,
    ) -> WorkspaceRecord:
        self._validate_type(workspace_type)
        resolved_root = self._resolve_workspace_directory(root_path)
        normalized_root = normalize_workspace_root_for_storage(resolved_root)
        existing = self.get_by_normalized_root_path(normalized_root)
        if existing is not None:
            return existing

        now = to_iso_z(utc_now())
        resolved_name = self._resolve_name(name, resolved_root)
        with self.db.transaction() as conn:
            conn.execute(
                """
                insert into workspaces (
                  id, name, root_path, normalized_root_path, type, created_at,
                  updated_at, last_opened_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    workspace_id,
                    resolved_name,
                    str(resolved_root),
                    normalized_root,
                    workspace_type,
                    now,
                    now,
                    last_opened_at,
                ),
            )
        record = self.get(workspace_id)
        if record is None:
            raise RuntimeError(f"创建 workspace 后无法读取: {workspace_id}")
        return record

    def get(self, workspace_id: str, *, include_deleted: bool = False) -> WorkspaceRecord | None:
        query = "select * from workspaces where id = ?"
        params: list[Any] = [workspace_id]
        if not include_deleted:
            query += " and is_deleted = 0"
        with self.db.connect() as conn:
            row = conn.execute(query, params).fetchone()
        return self._from_row(row) if row else None

    def get_by_root_path(
        self,
        root_path: str | Path,
        *,
        include_deleted: bool = False,
    ) -> WorkspaceRecord | None:
        resolved_root = self._resolve_workspace_directory(root_path)
        return self.get_by_normalized_root_path(
            normalize_workspace_root_for_storage(resolved_root),
            include_deleted=include_deleted,
        )

    def get_by_normalized_root_path(
        self,
        normalized_root_path: str,
        *,
        include_deleted: bool = False,
    ) -> WorkspaceRecord | None:
        query = "select * from workspaces where normalized_root_path = ?"
        params: list[Any] = [normalized_root_path]
        if not include_deleted:
            query += " and is_deleted = 0"
        query += " order by is_deleted asc, updated_at desc, created_at desc limit 1"
        with self.db.connect() as conn:
            row = conn.execute(query, params).fetchone()
        return self._from_row(row) if row else None

    def list(
        self,
        *,
        include_deleted: bool = False,
        limit: int = 100,
    ) -> list[WorkspaceRecord]:
        filters: list[str] = []
        if not include_deleted:
            filters.append("is_deleted = 0")
        where = f"where {' and '.join(filters)}" if filters else ""
        with self.db.connect() as conn:
            rows = conn.execute(
                f"""
                select * from workspaces
                {where}
                order by
                  last_opened_at is null,
                  last_opened_at desc,
                  updated_at desc,
                  created_at desc,
                  name asc
                limit ?
                """,
                (max(1, min(limit, 500)),),
            ).fetchall()
        return [self._from_row(row) for row in rows]

    def update(
        self,
        workspace_id: str,
        *,
        name: str | None = None,
        root_path: str | Path | None = None,
        workspace_type: str | None = None,
        last_opened_at: str | None = None,
    ) -> WorkspaceRecord | None:
        assignments: list[str] = []
        params: list[Any] = []
        if name is not None:
            assignments.append("name = ?")
            params.append(self._resolve_name(name, None))
        if root_path is not None:
            resolved_root = self._resolve_workspace_directory(root_path)
            assignments.extend(["root_path = ?", "normalized_root_path = ?"])
            params.extend([str(resolved_root), normalize_workspace_root_for_storage(resolved_root)])
        if workspace_type is not None:
            self._validate_type(workspace_type)
            assignments.append("type = ?")
            params.append(workspace_type)
        if last_opened_at is not None:
            assignments.append("last_opened_at = ?")
            params.append(last_opened_at)
        if not assignments:
            return self.get(workspace_id)

        assignments.append("updated_at = ?")
        params.append(to_iso_z(utc_now()))
        params.append(workspace_id)
        with self.db.transaction() as conn:
            cursor = conn.execute(
                f"""
                update workspaces
                set {', '.join(assignments)}
                where id = ? and is_deleted = 0
                """,
                params,
            )
        if cursor.rowcount == 0:
            return None
        return self.get(workspace_id)

    def touch(self, workspace_id: str, *, opened_at: str | None = None) -> WorkspaceRecord | None:
        return self.update(workspace_id, last_opened_at=opened_at or to_iso_z(utc_now()))

    def soft_delete(self, workspace_id: str) -> WorkspaceRecord | None:
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            cursor = conn.execute(
                """
                update workspaces
                set is_deleted = 1, updated_at = ?
                where id = ? and is_deleted = 0
                """,
                (now, workspace_id),
            )
        if cursor.rowcount == 0:
            return None
        return self.get(workspace_id, include_deleted=True)

    @classmethod
    def _validate_type(cls, workspace_type: str) -> None:
        if workspace_type not in cls.VALID_TYPES:
            raise ValueError(f"不支持的 workspace 类型: {workspace_type}")

    @staticmethod
    def _resolve_workspace_directory(root_path: str | Path) -> Path:
        root_text = str(root_path).strip()
        if not root_text:
            raise WorkspacePathError("工作区路径不能为空")
        resolved = Path(root_text).expanduser().resolve()
        if not resolved.exists():
            raise WorkspacePathError(f"工作区路径不存在: {root_path}")
        if not resolved.is_dir():
            raise WorkspacePathError(f"工作区路径不是目录: {root_path}")
        return resolved

    @staticmethod
    def _resolve_name(name: str | None, root_path: Path | None) -> str:
        cleaned = str(name or "").strip()
        if cleaned:
            return cleaned
        if root_path is not None and root_path.name:
            return root_path.name
        raise ValueError("工作区名称不能为空")

    @staticmethod
    def _from_row(row: sqlite3.Row) -> WorkspaceRecord:
        return WorkspaceRecord(
            id=row["id"],
            name=row["name"],
            root_path=row["root_path"],
            normalized_root_path=row["normalized_root_path"],
            type=row["type"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            last_opened_at=row["last_opened_at"],
            is_deleted=bool(row["is_deleted"]),
        )


class SessionsRepository:
    VALID_STATUSES = {"active", "closed", "failed", "running", "waiting_approval"}
    VALID_SESSION_TYPES = {"workspace", "chat"}

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
        workspace_id: str | None = None,
        session_type: str = "chat",
        cwd: str | None = None,
        workspace_roots: list[str] | None = None,
    ) -> SessionRecord:
        self._validate_status(status)
        self._validate_session_type(session_type)
        now = to_iso_z(utc_now())
        resolved_active_session_id = active_session_id or session_id
        with self.db.transaction() as conn:
            conn.execute(
                """
                insert into sessions (
                  id, user_id, scene_id, scene_version_seq, status, is_debug,
                  session_tag, active_session_id, workspace_id, session_type, cwd,
                  workspace_roots_json, title, created_at, updated_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                    workspace_id,
                    session_type,
                    cwd,
                    _json_dumps(workspace_roots or []),
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
        workspace_id: str | None = None,
        session_type: str | None = None,
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
        if workspace_id is not None:
            filters.append("workspace_id = ?")
            params.append(workspace_id)
        if session_type is not None:
            self._validate_session_type(session_type)
            filters.append("session_type = ?")
            params.append(session_type)
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
        workspace_id: str | None = None,
        session_type: str | None = None,
        cwd: str | None = None,
        workspace_roots: list[str] | None = None,
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
        if workspace_id is not None:
            assignments.append("workspace_id = ?")
            params.append(workspace_id)
        if session_type is not None:
            self._validate_session_type(session_type)
            assignments.append("session_type = ?")
            params.append(session_type)
        if cwd is not None:
            assignments.append("cwd = ?")
            params.append(cwd)
        if workspace_roots is not None:
            assignments.append("workspace_roots_json = ?")
            params.append(_json_dumps(workspace_roots))
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
        assignments = ["updated_at = ?"]
        params: list[Any] = [to_iso_z(utc_now())]
        params.append(session_id)
        with self.db.transaction() as conn:
            conn.execute(
                f"update sessions set {', '.join(assignments)} where id = ? and is_deleted = 0",
                params,
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

    @classmethod
    def _validate_session_type(cls, session_type: str) -> None:
        if session_type not in cls.VALID_SESSION_TYPES:
            raise ValueError(f"不支持的 session 类型: {session_type}")

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
            workspace_id=row["workspace_id"],
            session_type=row["session_type"],
            cwd=row["cwd"],
            workspace_roots=_json_loads(row["workspace_roots_json"], []),
            title=row["title"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            is_deleted=bool(row["is_deleted"]),
        )


class WorkspaceFileAnnotationsRepository:
    VALID_SCOPE_TYPES = {"session", "workspace"}
    VALID_ANCHOR_TYPES = {"file", "selection"}

    def __init__(self, db: Database) -> None:
        self.db = db

    def create(
        self,
        *,
        scope_type: str,
        scope_id: str,
        workspace_id: str | None,
        path: str,
        anchor_type: str,
        comment: str,
        selected_text: str | None = None,
        line_start: int | None = None,
        line_end: int | None = None,
        column_start: int | None = None,
        column_end: int | None = None,
        content_hash: str | None = None,
        anchor_json: dict[str, Any] | None = None,
        annotation_id: str | None = None,
    ) -> WorkspaceFileAnnotationRecord:
        values = self._validate_values(
            scope_type=scope_type,
            scope_id=scope_id,
            path=path,
            anchor_type=anchor_type,
            comment=comment,
            selected_text=selected_text,
            line_start=line_start,
            line_end=line_end,
            column_start=column_start,
            column_end=column_end,
            content_hash=content_hash,
            anchor_json=anchor_json,
        )
        resolved_id = annotation_id or new_id()
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            conn.execute(
                """
                insert into workspace_file_annotations (
                  id, scope_type, scope_id, workspace_id, path, anchor_type, comment,
                  selected_text, line_start, line_end, column_start, column_end,
                  content_hash, anchor_json, created_at, updated_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    resolved_id,
                    values["scope_type"],
                    values["scope_id"],
                    workspace_id,
                    values["path"],
                    values["anchor_type"],
                    values["comment"],
                    values["selected_text"],
                    values["line_start"],
                    values["line_end"],
                    values["column_start"],
                    values["column_end"],
                    values["content_hash"],
                    (
                        _json_dumps(values["anchor_json"])
                        if values["anchor_json"] is not None
                        else None
                    ),
                    now,
                    now,
                ),
            )
        record = self.get(
            resolved_id,
            scope_type=values["scope_type"],
            scope_id=values["scope_id"],
        )
        if record is None:
            raise RuntimeError(f"Created annotation cannot be loaded: {resolved_id}")
        return record

    def get(
        self,
        annotation_id: str,
        *,
        scope_type: str,
        scope_id: str,
        include_deleted: bool = False,
    ) -> WorkspaceFileAnnotationRecord | None:
        self._validate_scope(scope_type, scope_id)
        query = """
            select * from workspace_file_annotations
            where id = ? and scope_type = ? and scope_id = ?
        """
        params: list[Any] = [annotation_id, scope_type, scope_id]
        if not include_deleted:
            query += " and is_deleted = 0"
        with self.db.connect() as conn:
            row = conn.execute(query, params).fetchone()
        return self._from_row(row) if row else None

    def list(
        self,
        *,
        scope_type: str,
        scope_id: str,
        path: str,
    ) -> list[WorkspaceFileAnnotationRecord]:
        scope_type, scope_id = self._validate_scope(scope_type, scope_id)
        normalized_path = self._normalize_path(path)
        with self.db.connect() as conn:
            rows = conn.execute(
                """
                select * from workspace_file_annotations
                where scope_type = ?
                  and scope_id = ?
                  and path = ?
                  and is_deleted = 0
                order by updated_at desc, created_at desc, id desc
                """,
                (scope_type, scope_id, normalized_path),
            ).fetchall()
        return [self._from_row(row) for row in rows]

    def update(
        self,
        annotation_id: str,
        *,
        scope_type: str,
        scope_id: str,
        anchor_type: str,
        comment: str,
        selected_text: str | None = None,
        line_start: int | None = None,
        line_end: int | None = None,
        column_start: int | None = None,
        column_end: int | None = None,
        content_hash: str | None = None,
        anchor_json: dict[str, Any] | None = None,
    ) -> WorkspaceFileAnnotationRecord | None:
        values = self._validate_values(
            scope_type=scope_type,
            scope_id=scope_id,
            path="placeholder.txt",
            anchor_type=anchor_type,
            comment=comment,
            selected_text=selected_text,
            line_start=line_start,
            line_end=line_end,
            column_start=column_start,
            column_end=column_end,
            content_hash=content_hash,
            anchor_json=anchor_json,
        )
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            cursor = conn.execute(
                """
                update workspace_file_annotations
                set
                  anchor_type = ?,
                  comment = ?,
                  selected_text = ?,
                  line_start = ?,
                  line_end = ?,
                  column_start = ?,
                  column_end = ?,
                  content_hash = ?,
                  anchor_json = ?,
                  updated_at = ?
                where id = ?
                  and scope_type = ?
                  and scope_id = ?
                  and is_deleted = 0
                """,
                (
                    values["anchor_type"],
                    values["comment"],
                    values["selected_text"],
                    values["line_start"],
                    values["line_end"],
                    values["column_start"],
                    values["column_end"],
                    values["content_hash"],
                    (
                        _json_dumps(values["anchor_json"])
                        if values["anchor_json"] is not None
                        else None
                    ),
                    now,
                    annotation_id,
                    values["scope_type"],
                    values["scope_id"],
                ),
            )
        if cursor.rowcount == 0:
            return None
        return self.get(
            annotation_id,
            scope_type=values["scope_type"],
            scope_id=values["scope_id"],
        )

    def delete(
        self,
        annotation_id: str,
        *,
        scope_type: str,
        scope_id: str,
    ) -> bool:
        scope_type, scope_id = self._validate_scope(scope_type, scope_id)
        with self.db.transaction() as conn:
            cursor = conn.execute(
                """
                update workspace_file_annotations
                set is_deleted = 1, updated_at = ?
                where id = ?
                  and scope_type = ?
                  and scope_id = ?
                  and is_deleted = 0
                """,
                (to_iso_z(utc_now()), annotation_id, scope_type, scope_id),
            )
        return cursor.rowcount > 0

    @classmethod
    def _validate_values(
        cls,
        *,
        scope_type: str,
        scope_id: str,
        path: str,
        anchor_type: str,
        comment: str,
        selected_text: str | None,
        line_start: int | None,
        line_end: int | None,
        column_start: int | None,
        column_end: int | None,
        content_hash: str | None,
        anchor_json: dict[str, Any] | None,
    ) -> dict[str, Any]:
        normalized_scope_type, normalized_scope_id = cls._validate_scope(scope_type, scope_id)
        normalized_path = cls._normalize_path(path)
        normalized_anchor_type = str(anchor_type or "").strip()
        if normalized_anchor_type not in cls.VALID_ANCHOR_TYPES:
            raise ValueError(f"Unsupported annotation anchor_type: {anchor_type}")

        normalized_comment = str(comment or "").strip()
        if not normalized_comment:
            raise ValueError("Annotation comment cannot be empty")

        resolved_selected_text = selected_text if selected_text is None else str(selected_text)
        if normalized_anchor_type == "selection" and not (resolved_selected_text or "").strip():
            raise ValueError("Selection annotation requires selected_text")
        if normalized_anchor_type == "file":
            resolved_selected_text = None
            line_start = None
            line_end = None
            column_start = None
            column_end = None
            anchor_json = None

        normalized_anchor_json = cls._validate_anchor_json(anchor_json)
        if normalized_anchor_json is not None:
            if normalized_anchor_type != "selection":
                raise ValueError("Only selection annotations can include anchor_json")
            anchor_selected_text = normalized_anchor_json["selectedText"]
            if resolved_selected_text and resolved_selected_text != anchor_selected_text:
                raise ValueError("Annotation selected_text must match anchor_json.selectedText")
            resolved_selected_text = anchor_selected_text
            line_start = cls._same_or_default(
                line_start,
                normalized_anchor_json["lineStart"],
                "line_start",
            )
            line_end = cls._same_or_default(line_end, normalized_anchor_json["lineEnd"], "line_end")
            column_start = cls._same_or_default(
                column_start,
                normalized_anchor_json["columnStart"],
                "column_start",
            )
            column_end = cls._same_or_default(
                column_end,
                normalized_anchor_json["columnEnd"],
                "column_end",
            )
            anchor_content_hash = normalized_anchor_json["contentHash"]
            if content_hash and str(content_hash).strip() != anchor_content_hash:
                raise ValueError("Annotation content_hash must match anchor_json.contentHash")
            content_hash = anchor_content_hash

        if normalized_anchor_type == "selection" and not (resolved_selected_text or "").strip():
            raise ValueError("Selection annotation requires selected_text")

        cls._validate_range(
            line_start=line_start,
            line_end=line_end,
            column_start=column_start,
            column_end=column_end,
        )

        return {
            "scope_type": normalized_scope_type,
            "scope_id": normalized_scope_id,
            "path": normalized_path,
            "anchor_type": normalized_anchor_type,
            "comment": normalized_comment,
            "selected_text": resolved_selected_text,
            "line_start": line_start,
            "line_end": line_end,
            "column_start": column_start,
            "column_end": column_end,
            "content_hash": str(content_hash).strip() if content_hash else None,
            "anchor_json": normalized_anchor_json,
        }

    @classmethod
    def _validate_scope(cls, scope_type: str, scope_id: str) -> tuple[str, str]:
        normalized_scope_type = str(scope_type or "").strip()
        normalized_scope_id = str(scope_id or "").strip()
        if normalized_scope_type not in cls.VALID_SCOPE_TYPES:
            raise ValueError(f"Unsupported annotation scope_type: {scope_type}")
        if not normalized_scope_id:
            raise ValueError("Annotation scope_id cannot be empty")
        return normalized_scope_type, normalized_scope_id

    @staticmethod
    def _normalize_path(path: str) -> str:
        normalized = str(path or "").replace("\\", "/").strip().strip("/")
        if not normalized or normalized == ".":
            raise ValueError("Annotation path cannot be empty")
        if Path(normalized).is_absolute():
            raise ValueError("Annotation path must be workspace-relative")
        segments = [segment for segment in normalized.split("/") if segment]
        if any(segment == ".." for segment in segments):
            raise ValueError("Annotation path must stay inside the workspace")
        return "/".join(segments)

    @staticmethod
    def _validate_range(
        *,
        line_start: int | None,
        line_end: int | None,
        column_start: int | None,
        column_end: int | None,
    ) -> None:
        if (line_start is None) != (line_end is None):
            raise ValueError("Annotation line range must include start and end")
        if line_start is not None and line_end is not None:
            if line_start < 1 or line_end < 1 or line_end < line_start:
                raise ValueError("Annotation line range is invalid")
        if (column_start is None) != (column_end is None):
            raise ValueError("Annotation column range must include start and end")
        if column_start is not None and column_end is not None:
            if line_start is None or line_end is None:
                raise ValueError("Annotation column range requires a line range")
            if column_start < 1 or column_end < 1:
                raise ValueError("Annotation column range is invalid")
            if line_start == line_end and column_end < column_start:
                raise ValueError("Annotation column range is invalid")

    @classmethod
    def _validate_anchor_json(cls, value: dict[str, Any] | None) -> dict[str, Any] | None:
        if value is None:
            return None
        if not isinstance(value, dict):
            raise ValueError("Annotation anchor_json must be an object")

        required = {
            "version",
            "kind",
            "sourceStart",
            "sourceEnd",
            "selectedText",
            "sourceText",
            "contentHash",
            "lineStart",
            "lineEnd",
            "columnStart",
            "columnEnd",
            "createdInView",
        }
        missing = sorted(required - set(value))
        if missing:
            raise ValueError(f"Annotation anchor_json missing fields: {', '.join(missing)}")
        if value["version"] != 2 or value["kind"] != "source-range":
            raise ValueError("Annotation anchor_json version or kind is unsupported")
        if value["createdInView"] not in {"preview", "source"}:
            raise ValueError("Annotation anchor_json.createdInView is invalid")

        source_start = cls._positive_or_zero_int(value["sourceStart"], "sourceStart")
        source_end = cls._positive_or_zero_int(value["sourceEnd"], "sourceEnd")
        if source_end <= source_start:
            raise ValueError("Annotation anchor_json source range is invalid")

        line_start = cls._positive_int(value["lineStart"], "lineStart")
        line_end = cls._positive_int(value["lineEnd"], "lineEnd")
        column_start = cls._positive_int(value["columnStart"], "columnStart")
        column_end = cls._positive_int(value["columnEnd"], "columnEnd")
        cls._validate_range(
            line_start=line_start,
            line_end=line_end,
            column_start=column_start,
            column_end=column_end,
        )

        selected_text = str(value["selectedText"])
        source_text = str(value["sourceText"])
        content_hash = str(value["contentHash"]).strip()
        if not selected_text.strip():
            raise ValueError("Annotation anchor_json.selectedText cannot be empty")
        if not source_text:
            raise ValueError("Annotation anchor_json.sourceText cannot be empty")
        if len(source_text) != source_end - source_start:
            raise ValueError("Annotation anchor_json.sourceText length must match source range")
        if not content_hash:
            raise ValueError("Annotation anchor_json.contentHash cannot be empty")

        return {
            "version": 2,
            "kind": "source-range",
            "sourceStart": source_start,
            "sourceEnd": source_end,
            "selectedText": selected_text,
            "sourceText": source_text,
            "contentHash": content_hash,
            "lineStart": line_start,
            "lineEnd": line_end,
            "columnStart": column_start,
            "columnEnd": column_end,
            "createdInView": value["createdInView"],
        }

    @staticmethod
    def _positive_or_zero_int(value: Any, field_name: str) -> int:
        if type(value) is not int or value < 0:
            raise ValueError(f"Annotation anchor_json.{field_name} must be a non-negative integer")
        return value

    @staticmethod
    def _positive_int(value: Any, field_name: str) -> int:
        if type(value) is not int or value < 1:
            raise ValueError(f"Annotation anchor_json.{field_name} must be a positive integer")
        return value

    @staticmethod
    def _same_or_default(value: int | None, expected: int, field_name: str) -> int:
        if value is not None and value != expected:
            raise ValueError(f"Annotation {field_name} must match anchor_json")
        return expected

    @staticmethod
    def _from_row(row: sqlite3.Row) -> WorkspaceFileAnnotationRecord:
        return WorkspaceFileAnnotationRecord(
            id=row["id"],
            scope_type=row["scope_type"],
            scope_id=row["scope_id"],
            workspace_id=row["workspace_id"],
            path=row["path"],
            anchor_type=row["anchor_type"],
            comment=row["comment"],
            selected_text=row["selected_text"],
            line_start=row["line_start"],
            line_end=row["line_end"],
            column_start=row["column_start"],
            column_end=row["column_end"],
            content_hash=row["content_hash"],
            anchor_json=_json_loads(row["anchor_json"], None),
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

    def count_by_session(self, session_id: str, *, include_deleted: bool = False) -> int:
        query = "select count(*) as count from message_events where session_id = ?"
        params: list[Any] = [session_id]
        if not include_deleted:
            query += " and is_deleted = 0"
        with self.db.connect() as conn:
            row = conn.execute(query, params).fetchone()
        return int(row["count"] if row else 0)

    def count_turns(self, session_id: str, *, include_deleted: bool = False) -> int:
        query = (
            "select count(distinct turn_index) as count "
            "from message_events where session_id = ?"
        )
        params: list[Any] = [session_id]
        if not include_deleted:
            query += " and is_deleted = 0"
        with self.db.connect() as conn:
            row = conn.execute(query, params).fetchone()
        return int(row["count"] if row else 0)

    def list_turn_indexes(
        self,
        session_id: str,
        *,
        cursor_turn_index: int | None = None,
        direction: str = "older",
        limit: int | None = 5,
        offset: int = 0,
        include_deleted: bool = False,
    ) -> list[int]:
        query = "select turn_index from message_events where session_id = ?"
        params: list[Any] = [session_id]
        if not include_deleted:
            query += " and is_deleted = 0"
        if cursor_turn_index is not None:
            if direction == "newer":
                query += " and turn_index > ?"
            else:
                query += " and turn_index < ?"
            params.append(cursor_turn_index)
        order = "asc" if direction == "newer" else "desc"
        query += f" group by turn_index order by turn_index {order}"
        if limit is not None:
            query += " limit ? offset ?"
            params.extend([max(1, min(limit, 101)), max(0, offset)])
        with self.db.connect() as conn:
            rows = conn.execute(query, params).fetchall()
        return [int(row["turn_index"]) for row in rows]

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


class LLMRequestLogsRepository:
    VALID_STATUSES = {"running", "completed", "failed", "cancelled"}

    def __init__(self, db: Database) -> None:
        self.db = db

    def start(
        self,
        *,
        request_id: str,
        trace_id: str,
        trace_record_id: str,
        session_id: str,
        model: str,
        active_session_id: str | None = None,
        gateway_thread_id: str | None = None,
        gateway_trace_id: str | None = None,
        turn_index: int | None = None,
        provider_id: str | None = None,
        provider_name: str | None = None,
        request_preview: str | None = None,
        metadata: dict[str, Any] | None = None,
        start_time: str | None = None,
    ) -> LLMRequestLogRecord:
        now = to_iso_z(utc_now())
        resolved_start_time = start_time or now
        with self.db.transaction() as conn:
            conn.execute(
                """
                insert into llm_request_logs (
                  id, trace_id, trace_record_id, session_id, active_session_id,
                  gateway_thread_id, gateway_trace_id, turn_index,
                  provider_id, provider_name, model, status,
                  start_time, request_preview, metadata_json, created_at, updated_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    request_id,
                    trace_id,
                    trace_record_id,
                    session_id,
                    active_session_id,
                    gateway_thread_id,
                    gateway_trace_id,
                    turn_index,
                    provider_id,
                    provider_name,
                    model,
                    "running",
                    resolved_start_time,
                    _clip_text(request_preview),
                    _json_dumps(_sanitize_metadata(metadata or {})),
                    now,
                    now,
                ),
            )
        record = self.get(request_id)
        if record is None:
            raise RuntimeError(f"创建 LLM 请求日志后无法读取: {request_id}")
        return record

    def finish(
        self,
        request_id: str,
        *,
        input_tokens: int = 0,
        cache_read_tokens: int = 0,
        output_tokens: int = 0,
        total_tokens: int | None = None,
        response_preview: str | None = None,
        metadata: dict[str, Any] | None = None,
        duration_ms: int | None = None,
        end_time: str | None = None,
        gateway_thread_id: str | None = None,
        gateway_trace_id: str | None = None,
    ) -> LLMRequestLogRecord | None:
        return self._complete(
            request_id,
            status="completed",
            input_tokens=input_tokens,
            cache_read_tokens=cache_read_tokens,
            output_tokens=output_tokens,
            total_tokens=total_tokens,
            response_preview=response_preview,
            metadata=metadata,
            duration_ms=duration_ms,
            end_time=end_time,
            gateway_thread_id=gateway_thread_id,
            gateway_trace_id=gateway_trace_id,
        )

    def fail(
        self,
        request_id: str,
        *,
        error_message: str,
        input_tokens: int = 0,
        cache_read_tokens: int = 0,
        output_tokens: int = 0,
        total_tokens: int | None = None,
        response_preview: str | None = None,
        metadata: dict[str, Any] | None = None,
        duration_ms: int | None = None,
        end_time: str | None = None,
        gateway_thread_id: str | None = None,
        gateway_trace_id: str | None = None,
    ) -> LLMRequestLogRecord | None:
        return self._complete(
            request_id,
            status="failed",
            input_tokens=input_tokens,
            cache_read_tokens=cache_read_tokens,
            output_tokens=output_tokens,
            total_tokens=total_tokens,
            response_preview=response_preview,
            error_message=error_message,
            metadata=metadata,
            duration_ms=duration_ms,
            end_time=end_time,
            gateway_thread_id=gateway_thread_id,
            gateway_trace_id=gateway_trace_id,
        )

    def get(self, request_id: str, *, include_deleted: bool = False) -> LLMRequestLogRecord | None:
        query = "select * from llm_request_logs where id = ?"
        params: list[Any] = [request_id]
        if not include_deleted:
            query += " and is_deleted = 0"
        with self.db.connect() as conn:
            row = conn.execute(query, params).fetchone()
        return self._from_row(row) if row else None

    def list(
        self,
        *,
        start_time: str | None = None,
        end_time: str | None = None,
        model: str | None = None,
        status: str | None = None,
        page: int = 1,
        page_size: int = 20,
    ) -> tuple[list[LLMRequestLogRecord], int]:
        where, params = self._filters(
            start_time=start_time,
            end_time=end_time,
            model=model,
            status=status,
        )
        resolved_page = max(1, page)
        resolved_page_size = max(1, min(page_size, 200))
        offset = (resolved_page - 1) * resolved_page_size
        with self.db.connect() as conn:
            total_row = conn.execute(
                f"select count(*) as total from llm_request_logs {where}",
                params,
            ).fetchone()
            rows = conn.execute(
                f"""
                select * from llm_request_logs
                {where}
                order by start_time desc, created_at desc, id desc
                limit ? offset ?
                """,
                [*params, resolved_page_size, offset],
            ).fetchall()
        return [self._from_row(row) for row in rows], int(total_row["total"])

    def summary(
        self,
        *,
        start_time: str | None = None,
        end_time: str | None = None,
        model: str | None = None,
    ) -> dict[str, Any]:
        where, params = self._filters(start_time=start_time, end_time=end_time, model=model)
        with self.db.connect() as conn:
            row = conn.execute(
                f"""
                select
                  count(*) as request_count,
                  coalesce(sum(input_tokens), 0) as input_tokens,
                  coalesce(sum(cache_read_tokens), 0) as cache_read_tokens,
                  coalesce(sum(output_tokens), 0) as output_tokens,
                  coalesce(sum(total_tokens), 0) as total_tokens,
                  coalesce(
                    sum(case when status = 'completed' then 1 else 0 end),
                    0
                  ) as success_count,
                  coalesce(sum(case when status = 'failed' then 1 else 0 end), 0) as failed_count,
                  avg(duration_ms) as avg_duration_ms
                from llm_request_logs
                {where}
                """,
                params,
            ).fetchone()
        return {
            "request_count": int(row["request_count"] or 0),
            "input_tokens": int(row["input_tokens"] or 0),
            "cache_read_tokens": int(row["cache_read_tokens"] or 0),
            "output_tokens": int(row["output_tokens"] or 0),
            "total_tokens": int(row["total_tokens"] or 0),
            "success_count": int(row["success_count"] or 0),
            "failed_count": int(row["failed_count"] or 0),
            "avg_duration_ms": int(row["avg_duration_ms"] or 0),
        }

    def trend(
        self,
        *,
        start_time: str | None = None,
        end_time: str | None = None,
        model: str | None = None,
        bucket: str = "day",
        timezone_offset_minutes: int = 0,
    ) -> list[dict[str, Any]]:
        return self.trend_page(
            start_time=start_time,
            end_time=end_time,
            model=model,
            bucket=bucket,
            timezone_offset_minutes=timezone_offset_minutes,
        )["points"]

    def trend_page(
        self,
        *,
        start_time: str | None = None,
        end_time: str | None = None,
        model: str | None = None,
        bucket: str = "day",
        timezone_offset_minutes: int = 0,
        start_after: str | None = None,
        limit: int | None = None,
    ) -> dict[str, Any]:
        if bucket not in {"hour", "day"}:
            raise ValueError(f"不支持的用量统计粒度: {bucket}")
        _validate_timezone_offset(timezone_offset_minutes)
        if limit is not None and limit < 1:
            raise ValueError("趋势分页数量必须大于等于 1")
        if limit is not None and limit > 2000:
            raise ValueError("趋势分页数量不能超过 2000")

        cursor_start_time = (
            _usage_cursor_next_start_time(
                start_after,
                bucket=bucket,
                timezone_offset_minutes=timezone_offset_minutes,
            )
            if start_after
            else None
        )
        effective_start_time = _max_iso_time(start_time, cursor_start_time)
        where, params = self._filters(
            start_time=effective_start_time,
            end_time=end_time,
            model=model,
        )
        bucket_expression = _usage_bucket_sql_expression(bucket)
        timezone_modifier = _sqlite_timezone_modifier(timezone_offset_minutes)
        query_params: list[Any] = [timezone_modifier, *params]
        fetch_limit = limit + 1 if limit is not None else None
        limit_sql = ""
        if fetch_limit is not None:
            limit_sql = "limit ?"
            query_params.append(fetch_limit)
        with self.db.connect() as conn:
            rows = conn.execute(
                f"""
                select
                  {bucket_expression} as time,
                  count(*) as request_count,
                  coalesce(sum(input_tokens), 0) as input_tokens,
                  coalesce(sum(cache_read_tokens), 0) as cache_read_tokens,
                  coalesce(sum(output_tokens), 0) as output_tokens,
                  coalesce(sum(total_tokens), 0) as total_tokens,
                  coalesce(sum(case when status = 'failed' then 1 else 0 end), 0) as failed_count
                from llm_request_logs
                {where}
                group by time
                order by time asc
                {limit_sql}
                """,
                query_params,
            ).fetchall()
        has_more = fetch_limit is not None and len(rows) > limit
        visible_rows = rows[:limit] if has_more and limit is not None else rows
        points = [
            {
                "time": str(row["time"]),
                "request_count": int(row["request_count"] or 0),
                "input_tokens": int(row["input_tokens"] or 0),
                "cache_read_tokens": int(row["cache_read_tokens"] or 0),
                "output_tokens": int(row["output_tokens"] or 0),
                "total_tokens": int(row["total_tokens"] or 0),
                "failed_count": int(row["failed_count"] or 0),
            }
            for row in visible_rows
        ]
        return {
            "points": points,
            "next_cursor": points[-1]["time"] if has_more and points else None,
            "has_more": has_more,
        }

    def list_models(self) -> list[str]:
        with self.db.connect() as conn:
            rows = conn.execute(
                """
                select distinct model from llm_request_logs
                where is_deleted = 0
                order by model asc
                """
            ).fetchall()
        return [str(row["model"]) for row in rows]

    def _complete(
        self,
        request_id: str,
        *,
        status: str,
        input_tokens: int = 0,
        cache_read_tokens: int = 0,
        output_tokens: int = 0,
        total_tokens: int | None = None,
        response_preview: str | None = None,
        error_message: str | None = None,
        metadata: dict[str, Any] | None = None,
        duration_ms: int | None = None,
        end_time: str | None = None,
        gateway_thread_id: str | None = None,
        gateway_trace_id: str | None = None,
    ) -> LLMRequestLogRecord | None:
        self._validate_status(status)
        now = to_iso_z(utc_now())
        resolved_end_time = end_time or now
        resolved_total_tokens = (
            int(total_tokens)
            if total_tokens is not None
            else int(input_tokens or 0) + int(output_tokens or 0)
        )
        metadata_json = None if metadata is None else _json_dumps(_sanitize_metadata(metadata))
        with self.db.transaction() as conn:
            conn.execute(
                """
                update llm_request_logs set
                  status = ?,
                  end_time = ?,
                  duration_ms = coalesce(?, duration_ms),
                  gateway_thread_id = coalesce(?, gateway_thread_id),
                  gateway_trace_id = coalesce(?, gateway_trace_id),
                  input_tokens = ?,
                  cache_read_tokens = ?,
                  output_tokens = ?,
                  total_tokens = ?,
                  response_preview = coalesce(?, response_preview),
                  error_message = ?,
                  metadata_json = coalesce(?, metadata_json),
                  updated_at = ?
                where id = ? and is_deleted = 0
                """,
                (
                    status,
                    resolved_end_time,
                    duration_ms,
                    gateway_thread_id,
                    gateway_trace_id,
                    max(0, int(input_tokens or 0)),
                    max(0, int(cache_read_tokens or 0)),
                    max(0, int(output_tokens or 0)),
                    max(0, resolved_total_tokens),
                    _clip_text(response_preview),
                    _clip_text(error_message),
                    metadata_json,
                    now,
                    request_id,
                ),
            )
        return self.get(request_id)

    @classmethod
    def _validate_status(cls, status: str) -> None:
        if status not in cls.VALID_STATUSES:
            raise ValueError(f"不支持的 LLM 请求状态: {status}")

    @staticmethod
    def _filters(
        *,
        start_time: str | None = None,
        end_time: str | None = None,
        model: str | None = None,
        status: str | None = None,
    ) -> tuple[str, list[Any]]:
        filters = ["is_deleted = 0"]
        params: list[Any] = []
        if start_time:
            filters.append("start_time >= ?")
            params.append(start_time)
        if end_time:
            filters.append("start_time <= ?")
            params.append(end_time)
        if model:
            filters.append("model = ?")
            params.append(model)
        if status:
            filters.append("status = ?")
            params.append(status)
        return f"where {' and '.join(filters)}", params

    @staticmethod
    def _from_row(row: sqlite3.Row) -> LLMRequestLogRecord:
        return LLMRequestLogRecord(
            id=row["id"],
            trace_id=row["trace_id"],
            trace_record_id=row["trace_record_id"],
            session_id=row["session_id"],
            active_session_id=row["active_session_id"],
            gateway_thread_id=row["gateway_thread_id"],
            gateway_trace_id=row["gateway_trace_id"],
            turn_index=row["turn_index"],
            provider_id=row["provider_id"],
            provider_name=row["provider_name"],
            model=row["model"],
            status=row["status"],
            start_time=row["start_time"],
            end_time=row["end_time"],
            duration_ms=row["duration_ms"],
            input_tokens=int(row["input_tokens"]),
            cache_read_tokens=int(row["cache_read_tokens"]),
            output_tokens=int(row["output_tokens"]),
            total_tokens=int(row["total_tokens"]),
            request_preview=row["request_preview"],
            response_preview=row["response_preview"],
            error_message=row["error_message"],
            metadata=_json_loads(row["metadata_json"], {}),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            is_deleted=bool(row["is_deleted"]),
        )


class CommandApprovalRequestsRepository:
    VALID_STATUSES = {"pending", "approved", "rejected", "expired", "cancelled"}

    def __init__(self, db: Database) -> None:
        self.db = db

    def create(
        self,
        *,
        approval_id: str,
        session_id: str,
        command: str,
        cwd: str,
        title: str,
        description: str = "",
        trace_id: str | None = None,
        turn_index: int | None = None,
        run_id: str | None = None,
        tool_name: str = "run_command",
        kind: str = "exec",
        shell: str = "shell",
        workspace_root: str = "",
        details: dict[str, Any] | None = None,
    ) -> CommandApprovalRequestRecord:
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            conn.execute(
                """
                insert into command_approval_requests (
                  id, session_id, trace_id, turn_index, run_id, tool_name, kind,
                  title, description, command, cwd, shell, workspace_root, details_json,
                  status, created_at, updated_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
                """,
                (
                    approval_id,
                    session_id,
                    trace_id,
                    turn_index,
                    run_id,
                    tool_name,
                    kind,
                    title,
                    description,
                    command,
                    cwd,
                    shell,
                    workspace_root,
                    _json_dumps(details or {}),
                    now,
                    now,
                ),
            )
        record = self.get(approval_id)
        if record is None:
            raise RuntimeError(f"创建 command 审批后无法读取: {approval_id}")
        return record

    def get(
        self,
        approval_id: str,
        *,
        include_deleted: bool = False,
    ) -> CommandApprovalRequestRecord | None:
        query = "select * from command_approval_requests where id = ?"
        params: list[Any] = [approval_id]
        if not include_deleted:
            query += " and is_deleted = 0"
        with self.db.connect() as conn:
            row = conn.execute(query, params).fetchone()
        return self._from_row(row) if row else None

    def list_pending(
        self,
        *,
        session_id: str | None = None,
        limit: int = 100,
    ) -> list[CommandApprovalRequestRecord]:
        filters = ["status = 'pending'", "is_deleted = 0"]
        params: list[Any] = []
        if session_id:
            filters.append("session_id = ?")
            params.append(session_id)
        params.append(max(1, min(limit, 500)))
        with self.db.connect() as conn:
            rows = conn.execute(
                f"""
                select * from command_approval_requests
                where {' and '.join(filters)}
                order by created_at asc, id asc
                limit ?
                """,
                params,
            ).fetchall()
        return [self._from_row(row) for row in rows]

    def list_history(
        self,
        *,
        session_id: str | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> tuple[list[CommandApprovalRequestRecord], int]:
        filters = ["is_deleted = 0"]
        params: list[Any] = []
        if session_id:
            filters.append("session_id = ?")
            params.append(session_id)
        where = f"where {' and '.join(filters)}"
        resolved_limit = max(1, min(limit, 500))
        resolved_offset = max(0, offset)
        with self.db.connect() as conn:
            total = conn.execute(
                f"select count(*) as total from command_approval_requests {where}",
                params,
            ).fetchone()
            rows = conn.execute(
                f"""
                select * from command_approval_requests
                {where}
                order by created_at desc, id desc
                limit ? offset ?
                """,
                [*params, resolved_limit, resolved_offset],
            ).fetchall()
        return [self._from_row(row) for row in rows], int(total["total"])

    def resolve(
        self,
        approval_id: str,
        *,
        status: str,
        decision: str | None,
        trust_scope: str | None = None,
        rule_match_type: str | None = None,
        reject_message: str | None = None,
        trusted_rule_id: str | None = None,
    ) -> CommandApprovalRequestRecord | None:
        self._validate_status(status)
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            conn.execute(
                """
                update command_approval_requests set
                  status = ?,
                  decision = ?,
                  trust_scope = ?,
                  rule_match_type = ?,
                  reject_message = ?,
                  trusted_rule_id = ?,
                  resolved_at = ?,
                  updated_at = ?
                where id = ? and is_deleted = 0
                """,
                (
                    status,
                    decision,
                    trust_scope,
                    rule_match_type,
                    reject_message,
                    trusted_rule_id,
                    now,
                    now,
                    approval_id,
                ),
            )
        return self.get(approval_id)

    def cancel_pending_for_session(self, session_id: str) -> int:
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            cursor = conn.execute(
                """
                update command_approval_requests set
                  status = 'cancelled',
                  decision = 'rejected',
                  reject_message = coalesce(reject_message, '本轮对话已取消'),
                  resolved_at = ?,
                  updated_at = ?
                where session_id = ? and status = 'pending' and is_deleted = 0
                """,
                (now, now, session_id),
            )
        return int(cursor.rowcount or 0)

    @classmethod
    def _validate_status(cls, status: str) -> None:
        if status not in cls.VALID_STATUSES:
            raise ValueError(f"不支持的 command 审批状态: {status}")

    @staticmethod
    def _from_row(row: sqlite3.Row) -> CommandApprovalRequestRecord:
        return CommandApprovalRequestRecord(
            id=row["id"],
            session_id=row["session_id"],
            trace_id=row["trace_id"],
            turn_index=row["turn_index"],
            run_id=row["run_id"],
            tool_name=row["tool_name"],
            kind=row["kind"],
            title=row["title"],
            description=row["description"],
            command=row["command"],
            cwd=row["cwd"],
            shell=row["shell"],
            workspace_root=row["workspace_root"],
            details=_json_loads(row["details_json"], {}),
            status=row["status"],
            decision=row["decision"],
            trust_scope=row["trust_scope"],
            rule_match_type=row["rule_match_type"],
            reject_message=row["reject_message"],
            trusted_rule_id=row["trusted_rule_id"],
            created_at=row["created_at"],
            resolved_at=row["resolved_at"],
            updated_at=row["updated_at"],
            is_deleted=bool(row["is_deleted"]),
        )


class TrustedCommandRulesRepository:
    VALID_MATCH_TYPES = {"exact", "prefix"}

    def __init__(self, db: Database) -> None:
        self.db = db

    def create(
        self,
        *,
        rule_id: str,
        command_pattern: str,
        normalized_command: str,
        match_type: str,
        shell: str,
        workspace_root: str,
        cwd_pattern: str,
        created_from_approval_id: str | None = None,
        enabled: bool = True,
    ) -> TrustedCommandRuleRecord:
        self._validate_match_type(match_type)
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            conn.execute(
                """
                insert into trusted_command_rules (
                  id, command_pattern, normalized_command, match_type, shell,
                  workspace_root, cwd_pattern, enabled, created_from_approval_id,
                  created_at, updated_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    rule_id,
                    command_pattern,
                    normalized_command,
                    match_type,
                    shell,
                    workspace_root,
                    cwd_pattern,
                    int(enabled),
                    created_from_approval_id,
                    now,
                    now,
                ),
            )
        record = self.get(rule_id)
        if record is None:
            raise RuntimeError(f"创建已信任命令后无法读取: {rule_id}")
        return record

    def get(
        self,
        rule_id: str,
        *,
        include_deleted: bool = False,
    ) -> TrustedCommandRuleRecord | None:
        query = "select * from trusted_command_rules where id = ?"
        params: list[Any] = [rule_id]
        if not include_deleted:
            query += " and is_deleted = 0"
        with self.db.connect() as conn:
            row = conn.execute(query, params).fetchone()
        return self._from_row(row) if row else None

    def list(
        self,
        *,
        include_disabled: bool = True,
        include_deleted: bool = False,
        limit: int = 200,
    ) -> list[TrustedCommandRuleRecord]:
        filters: list[str] = []
        if not include_disabled:
            filters.append("enabled = 1")
        if not include_deleted:
            filters.append("is_deleted = 0")
        where = f"where {' and '.join(filters)}" if filters else ""
        with self.db.connect() as conn:
            rows = conn.execute(
                f"""
                select * from trusted_command_rules
                {where}
                order by created_at desc, id desc
                limit ?
                """,
                (max(1, min(limit, 500)),),
            ).fetchall()
        return [self._from_row(row) for row in rows]

    def set_enabled(self, rule_id: str, enabled: bool) -> TrustedCommandRuleRecord | None:
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            conn.execute(
                """
                update trusted_command_rules set
                  enabled = ?,
                  updated_at = ?
                where id = ? and is_deleted = 0
                """,
                (int(enabled), now, rule_id),
            )
        return self.get(rule_id)

    def delete(self, rule_id: str) -> bool:
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            cursor = conn.execute(
                """
                update trusted_command_rules set
                  is_deleted = 1,
                  enabled = 0,
                  updated_at = ?
                where id = ? and is_deleted = 0
                """,
                (now, rule_id),
            )
        return int(cursor.rowcount or 0) > 0

    def touch_last_used(self, rule_id: str) -> TrustedCommandRuleRecord | None:
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            conn.execute(
                """
                update trusted_command_rules set
                  last_used_at = ?,
                  updated_at = ?
                where id = ? and is_deleted = 0
                """,
                (now, now, rule_id),
            )
        return self.get(rule_id)

    @classmethod
    def _validate_match_type(cls, match_type: str) -> None:
        if match_type not in cls.VALID_MATCH_TYPES:
            raise ValueError(f"不支持的命令匹配类型: {match_type}")

    @staticmethod
    def _from_row(row: sqlite3.Row) -> TrustedCommandRuleRecord:
        return TrustedCommandRuleRecord(
            id=row["id"],
            command_pattern=row["command_pattern"],
            normalized_command=row["normalized_command"],
            match_type=row["match_type"],
            shell=row["shell"],
            workspace_root=row["workspace_root"],
            cwd_pattern=row["cwd_pattern"],
            enabled=bool(row["enabled"]),
            created_from_approval_id=row["created_from_approval_id"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            last_used_at=row["last_used_at"],
            is_deleted=bool(row["is_deleted"]),
        )


class CommandApprovalAuditRepository:
    def __init__(self, db: Database) -> None:
        self.db = db

    def create(
        self,
        *,
        audit_id: str,
        approval_id: str,
        session_id: str,
        command: str,
        cwd: str,
        decision: str,
        trust_scope: str | None = None,
        rule_match_type: str | None = None,
        trusted_rule_id: str | None = None,
        reject_message: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> CommandApprovalAuditRecord:
        now = to_iso_z(utc_now())
        with self.db.transaction() as conn:
            conn.execute(
                """
                insert into command_approval_audit (
                  id, approval_id, session_id, command, cwd, decision, trust_scope,
                  rule_match_type, trusted_rule_id, reject_message, metadata_json, created_at
                ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    audit_id,
                    approval_id,
                    session_id,
                    command,
                    cwd,
                    decision,
                    trust_scope,
                    rule_match_type,
                    trusted_rule_id,
                    reject_message,
                    _json_dumps(_sanitize_metadata(metadata or {})),
                    now,
                ),
            )
        record = self.get(audit_id)
        if record is None:
            raise RuntimeError(f"创建 command 审批审计后无法读取: {audit_id}")
        return record

    def get(self, audit_id: str) -> CommandApprovalAuditRecord | None:
        with self.db.connect() as conn:
            row = conn.execute(
                "select * from command_approval_audit where id = ?",
                (audit_id,),
            ).fetchone()
        return self._from_row(row) if row else None

    def list(
        self,
        *,
        session_id: str | None = None,
        limit: int = 100,
        offset: int = 0,
    ) -> tuple[list[CommandApprovalAuditRecord], int]:
        filters: list[str] = []
        params: list[Any] = []
        if session_id:
            filters.append("session_id = ?")
            params.append(session_id)
        where = f"where {' and '.join(filters)}" if filters else ""
        resolved_limit = max(1, min(limit, 500))
        resolved_offset = max(0, offset)
        with self.db.connect() as conn:
            total = conn.execute(
                f"select count(*) as total from command_approval_audit {where}",
                params,
            ).fetchone()
            rows = conn.execute(
                f"""
                select * from command_approval_audit
                {where}
                order by created_at desc, id desc
                limit ? offset ?
                """,
                [*params, resolved_limit, resolved_offset],
            ).fetchall()
        return [self._from_row(row) for row in rows], int(total["total"])

    @staticmethod
    def _from_row(row: sqlite3.Row) -> CommandApprovalAuditRecord:
        return CommandApprovalAuditRecord(
            id=row["id"],
            approval_id=row["approval_id"],
            session_id=row["session_id"],
            command=row["command"],
            cwd=row["cwd"],
            decision=row["decision"],
            trust_scope=row["trust_scope"],
            rule_match_type=row["rule_match_type"],
            trusted_rule_id=row["trusted_rule_id"],
            reject_message=row["reject_message"],
            metadata=_json_loads(row["metadata_json"], {}),
            created_at=row["created_at"],
        )


def _validate_timezone_offset(value: int) -> None:
    if value < -14 * 60 or value > 14 * 60:
        raise ValueError("时区偏移必须在 -840 到 840 分钟之间")


def _usage_bucket_key(
    start_time: str,
    *,
    bucket: str,
    timezone_offset_minutes: int,
) -> str:
    value = datetime.fromisoformat(str(start_time).replace("Z", "+00:00"))
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    local_time = value.astimezone(UTC) + timedelta(minutes=timezone_offset_minutes)
    if bucket == "hour":
        return local_time.strftime("%Y-%m-%dT%H:00:00")
    return local_time.strftime("%Y-%m-%d")


def _usage_bucket_sql_expression(bucket: str) -> str:
    if bucket == "hour":
        return "strftime('%Y-%m-%dT%H:00:00', start_time, ?)"
    return "strftime('%Y-%m-%d', start_time, ?)"


def _sqlite_timezone_modifier(timezone_offset_minutes: int) -> str:
    sign = "+" if timezone_offset_minutes >= 0 else "-"
    return f"{sign}{abs(timezone_offset_minutes)} minutes"


def _usage_cursor_next_start_time(
    start_after: str,
    *,
    bucket: str,
    timezone_offset_minutes: int,
) -> str:
    if bucket == "hour":
        try:
            local_bucket = datetime.strptime(start_after, "%Y-%m-%dT%H:00:00")
        except ValueError as exc:
            raise ValueError("趋势游标格式不正确") from exc
        next_bucket = local_bucket + timedelta(hours=1)
    else:
        try:
            local_bucket = datetime.strptime(start_after, "%Y-%m-%d")
        except ValueError as exc:
            raise ValueError("趋势游标格式不正确") from exc
        next_bucket = local_bucket + timedelta(days=1)
    utc_bucket = next_bucket - timedelta(minutes=timezone_offset_minutes)
    return to_iso_z(utc_bucket.replace(tzinfo=UTC))


def _max_iso_time(left: str | None, right: str | None) -> str | None:
    if not left:
        return right
    if not right:
        return left
    return max(left, right)


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
        self.workspaces = WorkspacesRepository(db)
        self.sessions = SessionsRepository(db)
        self.workspace_file_annotations = WorkspaceFileAnnotationsRepository(db)
        self.message_events = MessageEventsRepository(db)
        self.command_approvals = CommandApprovalRequestsRepository(db)
        self.trusted_command_rules = TrustedCommandRulesRepository(db)
        self.command_approval_audit = CommandApprovalAuditRepository(db)
        self.trace_records = TraceRecordsRepository(db)
        self.trace_event_logs = TraceEventLogsRepository(db)
        self.llm_request_logs = LLMRequestLogsRepository(db)


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
