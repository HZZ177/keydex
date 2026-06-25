import json
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from backend.app.core.ids import new_id
from backend.app.core.logger import logger
from backend.app.core.time import to_iso_z, utc_now
from backend.app.security import normalize_workspace_root_for_storage

SCHEMA_SQL = """
pragma foreign_keys = on;

create table if not exists settings (
  key text primary key,
  value_json text not null,
  updated_at text not null
);

create table if not exists model_providers (
  id text primary key,
  name text not null,
  base_url text not null,
  api_key_encrypted text,
  enabled integer not null default 1,
  models_json text not null default '[]',
  model_enabled_json text not null default '{}',
  health_json text not null default '{}',
  created_at text not null,
  updated_at text not null
);

create table if not exists model_defaults (
  scope text primary key,
  provider_id text not null,
  model text not null,
  updated_at text not null,
  foreign key(provider_id) references model_providers(id) on delete cascade
);

create table if not exists workspaces (
  id text primary key,
  name text not null,
  root_path text not null,
  normalized_root_path text not null,
  type text not null default 'project',
  created_at text not null,
  updated_at text not null,
  last_opened_at text,
  is_deleted integer not null default 0
);

create unique index if not exists idx_workspaces_normalized_root_active
  on workspaces(normalized_root_path)
  where is_deleted = 0;
create index if not exists idx_workspaces_last_opened
  on workspaces(last_opened_at desc, updated_at desc, created_at desc);
create index if not exists idx_workspaces_deleted_updated
  on workspaces(is_deleted, updated_at desc);

create table if not exists sessions (
  id text primary key,
  user_id text not null,
  scene_id text not null,
  scene_version_seq integer,
  status text not null,
  is_debug integer not null default 0,
  debug_type text,
  is_scheduled integer not null default 0,
  scheduled_task_id text,
  session_tag text not null default 'chat',
  active_session_id text,
  parent_session_id text,
  child_session_id text,
  source_trace_id text,
  source_active_session_id text,
  source_checkpoint_id text,
  source_checkpoint_ns text,
  workspace_id text,
  session_type text not null default 'chat',
  cwd text,
  workspace_roots_json text not null default '[]',
  title text,
  created_at text not null,
  updated_at text not null,
  is_deleted integer not null default 0,
  foreign key(workspace_id) references workspaces(id) on delete set null
);

create index if not exists idx_sessions_scene_id on sessions(scene_id);
create index if not exists idx_sessions_scene_id_version_seq
  on sessions(scene_id, scene_version_seq);
create index if not exists idx_sessions_user_scene_session_tag
  on sessions(user_id, scene_id, session_tag);
create index if not exists idx_sessions_status on sessions(status);
create index if not exists idx_sessions_active_session_id on sessions(active_session_id);
create index if not exists idx_sessions_parent_session_id on sessions(parent_session_id);
create index if not exists idx_sessions_child_session_id on sessions(child_session_id);
create index if not exists idx_sessions_updated_at on sessions(updated_at desc);

create table if not exists workspace_file_annotations (
  id text primary key,
  scope_type text not null,
  scope_id text not null,
  workspace_id text,
  path text not null,
  anchor_type text not null,
  comment text not null,
  selected_text text,
  line_start integer,
  line_end integer,
  column_start integer,
  column_end integer,
  content_hash text,
  anchor_json text,
  created_at text not null,
  updated_at text not null,
  is_deleted integer not null default 0,
  foreign key(workspace_id) references workspaces(id) on delete set null
);

create index if not exists idx_workspace_file_annotations_scope_path
  on workspace_file_annotations(scope_type, scope_id, path, is_deleted, updated_at desc);
create index if not exists idx_workspace_file_annotations_workspace_path
  on workspace_file_annotations(workspace_id, path, is_deleted);

create table if not exists message_events (
  id text primary key,
  session_id text not null,
  trace_record_id text,
  seq integer not null,
  turn_index integer not null default 0,
  action text not null,
  data_json text,
  created_at text not null,
  updated_at text not null,
  is_deleted integer not null default 0,
  foreign key(session_id) references sessions(id) on delete cascade
);

create index if not exists idx_message_events_session_id on message_events(session_id);
create index if not exists idx_message_events_session_seq on message_events(session_id, seq);
create unique index if not exists idx_message_events_session_seq_unique
  on message_events(session_id, seq);

create table if not exists command_approval_requests (
  id text primary key,
  session_id text not null,
  trace_id text,
  turn_index integer,
  run_id text,
  tool_name text not null default 'run_command',
  kind text not null default 'exec',
  title text not null,
  description text not null default '',
  command text not null,
  cwd text not null default '.',
  shell text not null default 'shell',
  workspace_root text not null default '',
  details_json text not null default '{}',
  status text not null,
  decision text,
  trust_scope text,
  rule_match_type text,
  reject_message text,
  trusted_rule_id text,
  created_at text not null,
  resolved_at text,
  updated_at text not null,
  is_deleted integer not null default 0,
  foreign key(session_id) references sessions(id) on delete cascade
);

create index if not exists idx_command_approval_requests_session_status
  on command_approval_requests(session_id, status, created_at desc);
create index if not exists idx_command_approval_requests_status_created
  on command_approval_requests(status, created_at desc);

create table if not exists trusted_command_rules (
  id text primary key,
  command_pattern text not null,
  normalized_command text not null,
  match_type text not null,
  shell text not null default 'shell',
  workspace_root text not null default '',
  cwd_pattern text not null default '.',
  enabled integer not null default 1,
  created_from_approval_id text,
  created_at text not null,
  updated_at text not null,
  last_used_at text,
  is_deleted integer not null default 0,
  foreign key(created_from_approval_id) references command_approval_requests(id) on delete set null
);

create index if not exists idx_trusted_command_rules_lookup
  on trusted_command_rules(workspace_root, cwd_pattern, shell, match_type, enabled, is_deleted);
create index if not exists idx_trusted_command_rules_created
  on trusted_command_rules(created_at desc);

create table if not exists command_approval_audit (
  id text primary key,
  approval_id text not null,
  session_id text not null,
  command text not null,
  cwd text not null default '.',
  decision text not null,
  trust_scope text,
  rule_match_type text,
  trusted_rule_id text,
  reject_message text,
  metadata_json text not null default '{}',
  created_at text not null,
  foreign key(approval_id) references command_approval_requests(id) on delete cascade,
  foreign key(session_id) references sessions(id) on delete cascade,
  foreign key(trusted_rule_id) references trusted_command_rules(id) on delete set null
);

create index if not exists idx_command_approval_audit_created
  on command_approval_audit(created_at desc);
create index if not exists idx_command_approval_audit_session_created
  on command_approval_audit(session_id, created_at desc);

create table if not exists trace_record (
  trace_id text primary key,
  session_id text not null,
  active_session_id text,
  scene_id text not null,
  scene_name text,
  scene_version_seq integer,
  user_id text not null,
  turn_index integer not null,
  root_node_id text not null,
  status text not null,
  start_time text not null,
  end_time text,
  duration_ms integer,
  total_input_tokens integer not null default 0,
  total_output_tokens integer not null default 0,
  total_tokens integer not null default 0,
  total_cache_read_tokens integer not null default 0,
  user_message_preview text,
  output_checkpoint_id text,
  output_checkpoint_ns text,
  metadata_json text,
  created_at text not null,
  updated_at text not null,
  is_deleted integer not null default 0,
  foreign key(session_id) references sessions(id) on delete cascade
);

create index if not exists idx_trace_record_trace_id_created_at
  on trace_record(trace_id, created_at);
create index if not exists idx_trace_record_session_id_created_at
  on trace_record(session_id, created_at);
create index if not exists idx_trace_record_session_turn_created_at
  on trace_record(session_id, turn_index, created_at);
create index if not exists idx_trace_record_agg
  on trace_record(scene_id, scene_version_seq, end_time, status, user_id, created_at);

create table if not exists llm_request_logs (
  id text primary key,
  trace_id text not null,
  trace_record_id text not null,
  session_id text not null,
  active_session_id text,
  gateway_thread_id text,
  gateway_trace_id text,
  turn_index integer,
  provider_id text,
  provider_name text,
  model text not null,
  status text not null,
  start_time text not null,
  end_time text,
  duration_ms integer,
  input_tokens integer not null default 0,
  cache_read_tokens integer not null default 0,
  output_tokens integer not null default 0,
  total_tokens integer not null default 0,
  request_preview text,
  response_preview text,
  error_message text,
  metadata_json text not null default '{}',
  created_at text not null,
  updated_at text not null,
  is_deleted integer not null default 0,
  foreign key(trace_record_id) references trace_record(trace_id) on delete cascade,
  foreign key(session_id) references sessions(id) on delete cascade
);

create index if not exists idx_llm_request_logs_time
  on llm_request_logs(start_time desc);
create index if not exists idx_llm_request_logs_trace
  on llm_request_logs(trace_id, start_time);
create index if not exists idx_llm_request_logs_model_time
  on llm_request_logs(model, start_time desc);
create index if not exists idx_llm_request_logs_status_time
  on llm_request_logs(status, start_time desc);

create table if not exists trace_event_log (
  id integer primary key autoincrement,
  trace_id text not null,
  trace_record_id text not null,
  event_type text not null,
  source text not null,
  idempotency_key text not null,
  node_id text,
  parent_node_id text,
  root_node_id text,
  sequence_no integer,
  run_id text,
  turn_index integer,
  user_id text,
  original_session_id text,
  active_session_id text,
  timestamp_ms integer not null,
  occurred_at text not null,
  tags_json text,
  payload_json text not null,
  created_at text not null,
  updated_at text not null
);

create unique index if not exists udx_trace_event_log_idempotency_key
  on trace_event_log(idempotency_key);
create index if not exists idx_trace_event_log_trace_id_created_at
  on trace_event_log(trace_id, created_at);
create index if not exists idx_trace_event_log_trace_record_seq_created
  on trace_event_log(trace_record_id, sequence_no, created_at);
create index if not exists idx_trace_event_log_trace_record_event_created
  on trace_event_log(trace_record_id, event_type, created_at);

create table if not exists checkpoints_v2 (
  thread_id text not null,
  checkpoint_ns text not null default '',
  checkpoint_id text not null,
  created_at text not null,
  parent_checkpoint_id text,
  type text,
  checkpoint_blob blob not null,
  metadata text,
  primary key (thread_id, checkpoint_ns, checkpoint_id)
);

create index if not exists idx_ckpt_thread_ns_created_id
  on checkpoints_v2(thread_id, checkpoint_ns, created_at desc, checkpoint_id desc);

create table if not exists checkpoint_writes_v2 (
  thread_id text not null,
  checkpoint_ns text not null default '',
  checkpoint_id text not null,
  task_id text not null,
  task_path text not null default '',
  idx integer not null,
  channel text not null,
  type text,
  value_blob blob,
  created_at text not null,
  primary key (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
);

create index if not exists idx_writes_thread_ns_ckpt
  on checkpoint_writes_v2(thread_id, checkpoint_ns, checkpoint_id);
"""

SCHEMA_UPGRADE_SQL = """
create index if not exists idx_llm_request_logs_gateway_trace
  on llm_request_logs(gateway_trace_id);
create index if not exists idx_llm_request_logs_gateway_thread_time
  on llm_request_logs(gateway_thread_id, start_time desc);
create index if not exists idx_sessions_workspace_id
  on sessions(workspace_id);
create index if not exists idx_sessions_session_type
  on sessions(session_type);
create index if not exists idx_sessions_workspace_updated
  on sessions(workspace_id, updated_at desc);
create index if not exists idx_sessions_type_updated
  on sessions(session_type, updated_at desc);
create index if not exists idx_command_approval_requests_session_status
  on command_approval_requests(session_id, status, created_at desc);
create index if not exists idx_command_approval_requests_status_created
  on command_approval_requests(status, created_at desc);
create index if not exists idx_trusted_command_rules_lookup
  on trusted_command_rules(workspace_root, cwd_pattern, shell, match_type, enabled, is_deleted);
create index if not exists idx_trusted_command_rules_created
  on trusted_command_rules(created_at desc);
create index if not exists idx_command_approval_audit_created
  on command_approval_audit(created_at desc);
create index if not exists idx_command_approval_audit_session_created
  on command_approval_audit(session_id, created_at desc);
"""


class Database:
    def __init__(self, path: Path | str) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path, timeout=30.0)
        conn.row_factory = sqlite3.Row
        conn.execute("pragma foreign_keys = on")
        conn.execute("pragma busy_timeout = 30000")
        conn.execute("pragma journal_mode = wal")
        conn.execute("pragma synchronous = normal")
        return conn

    def init_schema(self, *, default_workspace_root: Path | str | None = None) -> None:
        with self.connect() as conn:
            legacy_session_columns = self._column_names(conn, "sessions")
            should_migrate_legacy_sessions = (
                bool(legacy_session_columns)
                and "workspace_id" not in legacy_session_columns
            )
            conn.executescript(SCHEMA_SQL)
            self._ensure_column(conn, "sessions", "workspace_id", "text")
            self._ensure_column(
                conn,
                "sessions",
                "session_type",
                "text not null default 'chat'",
            )
            self._ensure_column(conn, "sessions", "cwd", "text")
            self._ensure_column(
                conn,
                "sessions",
                "workspace_roots_json",
                "text not null default '[]'",
            )
            self._ensure_column(conn, "llm_request_logs", "gateway_thread_id", "text")
            self._ensure_column(conn, "llm_request_logs", "gateway_trace_id", "text")
            self._ensure_column(conn, "workspace_file_annotations", "anchor_json", "text")
            conn.executescript(SCHEMA_UPGRADE_SQL)
            if should_migrate_legacy_sessions:
                self._migrate_legacy_sessions_to_default_workspace(
                    conn,
                    default_workspace_root=default_workspace_root,
                )
        logger.info(f"[Database] 初始化 schema 完成 | path={self.path}")

    @staticmethod
    def _column_names(conn: sqlite3.Connection, table_name: str) -> set[str]:
        return {
            str(row["name"])
            for row in conn.execute(f"pragma table_info({table_name})").fetchall()
        }

    @staticmethod
    def _ensure_column(
        conn: sqlite3.Connection,
        table_name: str,
        column_name: str,
        column_definition: str,
    ) -> None:
        columns = {
            str(row["name"])
            for row in conn.execute(f"pragma table_info({table_name})").fetchall()
        }
        if column_name not in columns:
            conn.execute(f"alter table {table_name} add column {column_name} {column_definition}")

    @staticmethod
    def _migrate_legacy_sessions_to_default_workspace(
        conn: sqlite3.Connection,
        *,
        default_workspace_root: Path | str | None,
    ) -> None:
        root = Path(default_workspace_root or Path.cwd()).expanduser().resolve()
        root_text = str(root)
        normalized_root = normalize_workspace_root_for_storage(root)
        workspace = conn.execute(
            """
            select id from workspaces
            where normalized_root_path = ? and is_deleted = 0
            limit 1
            """,
            (normalized_root,),
        ).fetchone()
        workspace_id = str(workspace["id"]) if workspace else new_id()
        now = to_iso_z(utc_now())
        if workspace is None:
            conn.execute(
                """
                insert into workspaces (
                  id, name, root_path, normalized_root_path, type,
                  created_at, updated_at, last_opened_at
                ) values (?, ?, ?, ?, 'project', ?, ?, ?)
                """,
                (workspace_id, "keydex", root_text, normalized_root, now, now, now),
            )

        cursor = conn.execute(
            """
            update sessions
            set
              workspace_id = ?,
              session_type = 'workspace',
              cwd = ?,
              workspace_roots_json = ?
            where workspace_id is null
              and session_tag = 'chat'
            """,
            (workspace_id, root_text, json.dumps([root_text], ensure_ascii=False)),
        )
        logger.info(
            "[Database] 旧会话已迁移到默认工作区 | "
            f"workspace_id={workspace_id} | root={root_text} | sessions={cursor.rowcount}"
        )

    @contextmanager
    def transaction(self, *, immediate: bool = False) -> Iterator[sqlite3.Connection]:
        conn = self.connect()
        try:
            conn.execute("begin immediate" if immediate else "begin")
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            logger.opt(exception=True).error(f"[Database] 事务回滚 | path={self.path}")
            raise
        finally:
            conn.close()


def init_database(
    path: Path | str,
    *,
    default_workspace_root: Path | str | None = None,
) -> Database:
    db = Database(path)
    db.init_schema(default_workspace_root=default_workspace_root)
    logger.info(f"[Database] 数据库已就绪 | path={db.path}")
    return db
