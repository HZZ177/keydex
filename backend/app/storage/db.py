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

create table if not exists mcp_servers (
  id text primary key,
  name text not null,
  description text,
  enabled integer not null default 1,
  required integer not null default 0,
  transport text not null check (transport in ('stdio', 'streamable_http', 'sse')),
  command text,
  args_json text,
  cwd text,
  inherit_environment integer not null default 1,
  env_json text,
  url text,
  sse_url text,
  message_url text,
  headers_json text,
  env_headers_json text,
  bearer_token_env_var text,
  auth_type text not null default 'none'
    check (auth_type in ('none', 'header_token', 'bearer_env', 'oauth')),
  secret_refs_json text,
  oauth_config_json text,
  oauth_resource text,
  oauth_scopes_json text,
  startup_timeout_sec integer not null default 30,
  tool_timeout_sec integer not null default 60,
  read_timeout_sec integer not null default 60,
  sse_read_timeout_sec integer not null default 300,
  shutdown_timeout_sec integer not null default 10,
  restart_policy text not null default 'on_failure'
    check (restart_policy in ('never', 'on_failure', 'always')),
  connect_mode text not null default 'on_demand'
    check (connect_mode in ('on_startup', 'on_demand')),
  auto_refresh integer not null default 1,
  refresh_interval_sec integer not null default 1800,
  default_tool_exposure_mode text not null default 'allow_all_except_disabled'
    check (default_tool_exposure_mode in (
      'allow_all_except_disabled',
      'allow_selected_only',
      'read_only_auto'
    )),
  default_tool_approval_mode text not null default 'auto'
    check (default_tool_approval_mode in ('auto', 'prompt', 'approve')),
  supports_parallel_tool_calls integer not null default 0,
  elicitation_enabled integer not null default 1,
  sampling_enabled integer not null default 0,
  prompt_discovery_enabled integer not null default 1,
  resource_reserved_policy_json text,
  created_at text not null,
  updated_at text not null,
  unique(name)
);

create index if not exists idx_mcp_servers_enabled on mcp_servers(enabled);
create index if not exists idx_mcp_servers_transport on mcp_servers(transport);

create table if not exists mcp_server_status (
  server_id text primary key references mcp_servers(id) on delete cascade,
  status text not null default 'unknown'
    check (status in (
      'unknown',
      'online',
      'offline',
      'auth_required',
      'error',
      'disabled',
      'refreshing'
    )),
  capabilities_json text,
  server_info_json text,
  last_connected_at text,
  last_refresh_at text,
  last_refresh_revision integer not null default 0,
  last_error_code text,
  last_error_message text,
  last_error_detail_json text,
  tools_count integer not null default 0,
  prompts_count integer not null default 0,
  resources_reserved_count integer not null default 0,
  updated_at text not null
);

create index if not exists idx_mcp_server_status_status on mcp_server_status(status);
create index if not exists idx_mcp_server_status_last_refresh
  on mcp_server_status(last_refresh_at desc);

create table if not exists mcp_tools (
  id text primary key,
  server_id text not null references mcp_servers(id) on delete cascade,
  raw_name text not null,
  model_name text not null,
  callable_namespace text not null,
  callable_name text not null,
  display_name text,
  description text,
  input_schema_json text not null default '{}',
  annotations_json text,
  meta_json text,
  schema_hash text not null,
  risk_level text not null default 'unknown'
    check (risk_level in ('low', 'medium', 'high', 'unknown')),
  discovery_status text not null default 'active'
    check (discovery_status in ('new', 'active', 'removed', 'schema_changed')),
  first_seen_at text not null,
  last_seen_at text not null,
  removed_at text,
  last_used_at text,
  call_count integer not null default 0,
  failure_count integer not null default 0,
  unique(server_id, raw_name),
  unique(model_name)
);

create index if not exists idx_mcp_tools_server on mcp_tools(server_id);
create index if not exists idx_mcp_tools_status on mcp_tools(discovery_status);
create index if not exists idx_mcp_tools_risk on mcp_tools(risk_level);

create table if not exists mcp_tool_policies (
  id text primary key,
  server_id text not null references mcp_servers(id) on delete cascade,
  raw_tool_name text not null,
  enabled integer not null default 1,
  hidden integer not null default 0,
  approval_mode text not null default 'inherit'
    check (approval_mode in ('inherit', 'auto', 'prompt', 'approve', 'deny')),
  risk_override text check (risk_override in ('low', 'medium', 'high', 'unknown')),
  parameter_constraints_json text,
  schema_change_action text not null default 'require_review'
    check (schema_change_action in ('keep_enabled', 'require_review', 'disable')),
  updated_at text not null,
  unique(server_id, raw_tool_name)
);

create index if not exists idx_mcp_tool_policies_server
  on mcp_tool_policies(server_id);

create table if not exists mcp_prompts (
  id text primary key,
  server_id text not null references mcp_servers(id) on delete cascade,
  raw_name text not null,
  display_name text,
  description text,
  arguments_schema_json text not null default '{}',
  meta_json text,
  discovery_status text not null default 'active'
    check (discovery_status in ('new', 'active', 'removed', 'schema_changed')),
  first_seen_at text not null,
  last_seen_at text not null,
  removed_at text,
  unique(server_id, raw_name)
);

create index if not exists idx_mcp_prompts_server on mcp_prompts(server_id);
create index if not exists idx_mcp_prompts_status on mcp_prompts(discovery_status);

create table if not exists mcp_prompt_policies (
  id text primary key,
  server_id text not null references mcp_servers(id) on delete cascade,
  raw_prompt_name text not null,
  enabled integer not null default 1,
  exposure_mode text not null default 'manual'
    check (exposure_mode in ('hidden', 'manual', 'slash_command', 'agent_selectable')),
  updated_at text not null,
  unique(server_id, raw_prompt_name)
);

create index if not exists idx_mcp_prompt_policies_server
  on mcp_prompt_policies(server_id);

create table if not exists mcp_resources (
  id text primary key,
  server_id text not null references mcp_servers(id) on delete cascade,
  uri text not null,
  name text,
  description text,
  mime_type text,
  meta_json text,
  last_seen_at text,
  reserved_only integer not null default 1,
  unique(server_id, uri)
);

create index if not exists idx_mcp_resources_server on mcp_resources(server_id);

create table if not exists mcp_resource_templates (
  id text primary key,
  server_id text not null references mcp_servers(id) on delete cascade,
  uri_template text not null,
  name text,
  description text,
  mime_type text,
  meta_json text,
  last_seen_at text,
  reserved_only integer not null default 1,
  unique(server_id, uri_template)
);

create index if not exists idx_mcp_resource_templates_server
  on mcp_resource_templates(server_id);

create table if not exists mcp_oauth_tokens (
  id text primary key,
  server_id text not null references mcp_servers(id) on delete cascade,
  account_label text,
  token_ref text not null,
  refresh_token_ref text,
  scopes_json text,
  expires_at text,
  status text not null default 'active'
    check (status in ('active', 'expired', 'revoked', 'error')),
  created_at text not null,
  updated_at text not null
);

create index if not exists idx_mcp_oauth_tokens_server_status
  on mcp_oauth_tokens(server_id, status);

create table if not exists mcp_trust_rules (
  id text primary key,
  server_id text references mcp_servers(id) on delete cascade,
  raw_tool_name text,
  rule_kind text not null
    check (rule_kind in ('server_readonly', 'tool', 'tool_with_params', 'deny_tool')),
  scope text not null check (scope in ('session', 'global')),
  session_id text,
  condition_json text,
  approval_mode text not null check (approval_mode in ('approve', 'deny')),
  hit_count integer not null default 0,
  created_from_approval_id text,
  expires_at text,
  last_hit_at text,
  created_at text not null,
  updated_at text not null
);

create index if not exists idx_mcp_trust_rules_server_tool
  on mcp_trust_rules(server_id, raw_tool_name);
create index if not exists idx_mcp_trust_rules_scope
  on mcp_trust_rules(scope, session_id);

create table if not exists mcp_session_tool_overrides (
  id text primary key,
  session_id text not null,
  server_id text not null references mcp_servers(id) on delete cascade,
  raw_tool_name text not null,
  enabled integer not null,
  reason text,
  created_at text not null,
  expires_at text,
  unique(session_id, server_id, raw_tool_name)
);

create index if not exists idx_mcp_session_tool_overrides_session
  on mcp_session_tool_overrides(session_id);

create table if not exists mcp_runtime_snapshots (
  id text primary key,
  session_id text not null,
  turn_id text,
  tool_inventory_revision integer not null,
  visible_tools_json text not null,
  server_status_json text not null,
  policy_summary_json text not null,
  created_at text not null
);

create index if not exists idx_mcp_runtime_snapshots_session_turn
  on mcp_runtime_snapshots(session_id, turn_id);

create table if not exists mcp_audit_log (
  id text primary key,
  event_type text not null,
  server_id text,
  raw_tool_name text,
  prompt_name text,
  session_id text,
  turn_id text,
  call_id text,
  approval_id text,
  actor text,
  status text,
  duration_ms integer,
  summary text,
  detail_json text,
  created_at text not null
);

create index if not exists idx_mcp_audit_log_server_created
  on mcp_audit_log(server_id, created_at desc);
create index if not exists idx_mcp_audit_log_session_created
  on mcp_audit_log(session_id, created_at desc);
create index if not exists idx_mcp_audit_log_event_created
  on mcp_audit_log(event_type, created_at desc);

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
  current_model_provider_id text,
  current_model text,
  context_window_usage_json text,
  context_compression_epoch integer not null default 0,
  pinned_at text,
  title text,
  title_source text not null default 'manual',
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

create table if not exists thread_tasks (
  id text primary key,
  session_id text not null,
  type text not null,
  title text,
  objective text not null,
  status text not null
    check (status in ('active', 'paused', 'blocked', 'complete', 'system_stopped', 'cancelled')),
  metadata_json text not null default '{}',
  evidence_json text not null default '[]',
  blocked_audit_json text not null default '{}',
  system_stop_reason text,
  current_run_id text,
  turn_count integer not null default 0,
  elapsed_seconds integer not null default 0,
  token_usage_json text not null default '{}',
  created_at text not null,
  updated_at text not null,
  deleted_at text,
  foreign key(session_id) references sessions(id) on delete cascade
);

create index if not exists idx_thread_tasks_session_updated
  on thread_tasks(session_id, updated_at desc);
create index if not exists idx_thread_tasks_session_status
  on thread_tasks(session_id, status, updated_at desc)
  where deleted_at is null;
create unique index if not exists idx_thread_tasks_one_open_per_session
  on thread_tasks(session_id)
  where deleted_at is null and status in ('active', 'paused', 'blocked');

create table if not exists thread_task_runs (
  id text primary key,
  task_id text not null,
  session_id text not null,
  turn_index integer,
  trace_id text,
  status text not null
    check (status in ('running', 'succeeded', 'failed', 'skipped', 'cancelled')),
  summary_json text not null default '{}',
  error_json text not null default '{}',
  started_at text not null,
  finished_at text,
  created_at text not null,
  updated_at text not null,
  foreign key(task_id) references thread_tasks(id) on delete cascade,
  foreign key(session_id) references sessions(id) on delete cascade
);

create index if not exists idx_thread_task_runs_task_started
  on thread_task_runs(task_id, started_at desc);
create index if not exists idx_thread_task_runs_session_started
  on thread_task_runs(session_id, started_at desc);
create index if not exists idx_thread_task_runs_status_started
  on thread_task_runs(status, started_at desc);

create table if not exists session_forks (
  id text primary key,
  source_session_id text not null,
  target_session_id text not null,
  source_message_event_id text not null,
  target_message_event_id text not null,
  source_turn_index integer not null,
  target_turn_index integer not null,
  source_trace_id text,
  source_active_session_id text,
  source_checkpoint_id text,
  source_checkpoint_ns text not null default '',
  relation_type text not null default 'fork',
  created_at text not null,
  updated_at text not null,
  is_deleted integer not null default 0,
  foreign key(source_session_id) references sessions(id),
  foreign key(target_session_id) references sessions(id)
);

create unique index if not exists idx_session_forks_target
  on session_forks(target_session_id)
  where is_deleted = 0;
create index if not exists idx_session_forks_source_message
  on session_forks(source_session_id, source_message_event_id)
  where is_deleted = 0;
create index if not exists idx_session_forks_source_turn
  on session_forks(source_session_id, source_turn_index)
  where is_deleted = 0;

create table if not exists attachments (
  id text primary key,
  session_id text,
  user_id text not null,
  type text not null,
  source text not null,
  name text not null,
  path text not null,
  mime_type text not null,
  size integer not null default 0,
  created_at text not null,
  updated_at text not null,
  is_deleted integer not null default 0,
  foreign key(session_id) references sessions(id) on delete cascade
);

create index if not exists idx_attachments_session_id
  on attachments(session_id, is_deleted, created_at desc);
create index if not exists idx_attachments_user_id
  on attachments(user_id, is_deleted, created_at desc);
create index if not exists idx_attachments_path
  on attachments(path);

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

create table if not exists compression_staging (
  id integer primary key autoincrement,
  original_session_id text not null,
  active_session_id text not null,
  target_session_id text not null,
  generation integer not null,
  status text not null default 'pending',
  staging_strategy text not null default 'anchor_replacement',
  anchor_message_id text,
  source_last_message_id text,
  l1_content text,
  l2_content text,
  failure_reason text,
  applied_at text,
  created_at text not null,
  updated_at text not null,
  is_deleted integer not null default 0,
  foreign key(original_session_id) references sessions(id) on delete cascade,
  foreign key(target_session_id) references sessions(id) on delete cascade
);

create index if not exists idx_compression_staging_original_status_target
  on compression_staging(original_session_id, status, target_session_id, generation desc, id desc);
create index if not exists idx_compression_staging_original_generation
  on compression_staging(original_session_id, generation desc, id desc);

create table if not exists command_approval_requests (
  id text primary key,
  session_id text not null,
  trace_id text,
  turn_index integer,
  run_id text,
  tool_name text not null default 'command',
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
  tool_name text not null default '',
  shell text not null default 'shell',
  shell_path text not null default '',
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
  on trusted_command_rules(
    workspace_root, cwd_pattern, tool_name, shell, shell_path,
    match_type, enabled, is_deleted
  );
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
  input_checkpoint_id text,
  input_checkpoint_ns text,
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
  time_to_first_token integer,
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
create index if not exists idx_sessions_pinned_at
  on sessions(pinned_at desc)
  where pinned_at is not null and is_deleted = 0;
create index if not exists idx_command_approval_requests_session_status
  on command_approval_requests(session_id, status, created_at desc);
create index if not exists idx_command_approval_requests_status_created
  on command_approval_requests(status, created_at desc);
create index if not exists idx_trusted_command_rules_lookup
  on trusted_command_rules(
    workspace_root, cwd_pattern, tool_name, shell, shell_path,
    match_type, enabled, is_deleted
  );
create index if not exists idx_trusted_command_rules_created
  on trusted_command_rules(created_at desc);
create index if not exists idx_command_approval_audit_created
  on command_approval_audit(created_at desc);
create index if not exists idx_command_approval_audit_session_created
  on command_approval_audit(session_id, created_at desc);
create index if not exists idx_compression_staging_original_status_target
  on compression_staging(original_session_id, status, target_session_id, generation desc, id desc);
create index if not exists idx_compression_staging_original_generation
  on compression_staging(original_session_id, generation desc, id desc);
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
                bool(legacy_session_columns) and "workspace_id" not in legacy_session_columns
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
            self._ensure_column(conn, "sessions", "current_model_provider_id", "text")
            self._ensure_column(conn, "sessions", "current_model", "text")
            self._ensure_column(conn, "sessions", "context_window_usage_json", "text")
            self._ensure_column(
                conn,
                "sessions",
                "context_compression_epoch",
                "integer not null default 0",
            )
            self._ensure_column(conn, "sessions", "pinned_at", "text")
            self._ensure_column(conn, "sessions", "title_source", "text not null default 'manual'")
            self._ensure_column(
                conn,
                "session_forks",
                "target_message_event_id",
                "text not null default ''",
            )
            self._ensure_column(
                conn,
                "session_forks",
                "target_turn_index",
                "integer not null default 0",
            )
            conn.execute(
                """
                create index if not exists idx_session_forks_target_message
                  on session_forks(target_session_id, target_message_event_id)
                  where is_deleted = 0
                """
            )
            self._migrate_model_default_scopes(conn)
            self._ensure_column(conn, "llm_request_logs", "gateway_thread_id", "text")
            self._ensure_column(conn, "llm_request_logs", "gateway_trace_id", "text")
            self._ensure_column(conn, "llm_request_logs", "time_to_first_token", "integer")
            self._ensure_column(conn, "workspace_file_annotations", "anchor_json", "text")
            self._ensure_column(conn, "trace_record", "input_checkpoint_id", "text")
            self._ensure_column(conn, "trace_record", "input_checkpoint_ns", "text")
            self._ensure_column(
                conn,
                "compression_staging",
                "staging_strategy",
                "text not null default 'anchor_replacement'",
            )
            self._ensure_column(conn, "compression_staging", "source_last_message_id", "text")
            self._ensure_column(
                conn,
                "trusted_command_rules",
                "tool_name",
                "text not null default ''",
            )
            self._ensure_column(
                conn,
                "trusted_command_rules",
                "shell_path",
                "text not null default ''",
            )
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
            str(row["name"]) for row in conn.execute(f"pragma table_info({table_name})").fetchall()
        }

    @staticmethod
    def _ensure_column(
        conn: sqlite3.Connection,
        table_name: str,
        column_name: str,
        column_definition: str,
    ) -> None:
        columns = {
            str(row["name"]) for row in conn.execute(f"pragma table_info({table_name})").fetchall()
        }
        if column_name not in columns:
            conn.execute(f"alter table {table_name} add column {column_name} {column_definition}")

    @staticmethod
    def _migrate_model_default_scopes(conn: sqlite3.Connection) -> None:
        """Normalize legacy model default scopes to explicit product semantics."""
        rows = conn.execute("select scope, provider_id, model from model_defaults").fetchall()
        scopes = {str(row["scope"]) for row in rows}
        if "default_chat" not in scopes:
            source = next((row for row in rows if str(row["scope"]) == "main"), None)
            if source is None:
                source = next((row for row in rows if str(row["scope"]) == "global"), None)
            if source is not None:
                conn.execute(
                    """
                    insert into model_defaults (scope, provider_id, model, updated_at)
                    values ('default_chat', ?, ?, ?)
                    on conflict(scope) do update set
                      provider_id=excluded.provider_id,
                      model=excluded.model,
                      updated_at=excluded.updated_at
                    """,
                    (source["provider_id"], source["model"], to_iso_z(utc_now())),
                )
        conn.execute("delete from model_defaults where scope in ('main', 'global')")

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
