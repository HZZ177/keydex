import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

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
  title text,
  created_at text not null,
  updated_at text not null,
  is_deleted integer not null default 0
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


class Database:
    def __init__(self, path: Path | str) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.path)
        conn.row_factory = sqlite3.Row
        conn.execute("pragma foreign_keys = on")
        return conn

    def init_schema(self) -> None:
        with self.connect() as conn:
            conn.executescript(SCHEMA_SQL)

    @contextmanager
    def transaction(self, *, immediate: bool = False) -> Iterator[sqlite3.Connection]:
        conn = self.connect()
        try:
            conn.execute("begin immediate" if immediate else "begin")
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


def init_database(path: Path | str) -> Database:
    db = Database(path)
    db.init_schema()
    return db
