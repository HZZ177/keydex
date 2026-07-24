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

create table if not exists web_settings (
  id integer primary key check (id = 1),
  enabled integer not null default 0 check (enabled in (0, 1)),
  active_provider_id text not null default 'tavily',
  updated_at text not null
);

insert or ignore into web_settings (id, enabled, active_provider_id, updated_at)
values (1, 0, 'tavily', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

create table if not exists web_provider_configs (
  provider_id text primary key,
  config_json text not null default '{}',
  secrets_json text not null default '{}',
  created_at text not null,
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
  refresh_interval_sec integer not null default 60,
  default_tool_exposure_mode text not null default 'allow_all_except_disabled'
    check (default_tool_exposure_mode in (
      'allow_all_except_disabled',
      'allow_selected_only'
    )),
  default_tool_approval_mode text not null default 'auto'
    check (default_tool_approval_mode in ('auto', 'prompt', 'approve')),
  supports_parallel_tool_calls integer not null default 0,
  elicitation_enabled integer not null default 1,
  sampling_enabled integer not null default 0,
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

create table if not exists mcp_tool_policies (
  id text primary key,
  server_id text not null references mcp_servers(id) on delete cascade,
  raw_tool_name text not null,
  enabled integer not null default 1,
  hidden integer not null default 0,
  priority_available integer not null default 0,
  approval_mode text not null default 'inherit'
    check (approval_mode in ('inherit', 'auto', 'prompt', 'approve', 'deny')),
  parameter_constraints_json text,
  schema_change_action text not null default 'require_review'
    check (schema_change_action in ('keep_enabled', 'require_review', 'disable')),
  updated_at text not null,
  unique(server_id, raw_tool_name)
);

create index if not exists idx_mcp_tool_policies_server
  on mcp_tool_policies(server_id);

create table if not exists mcp_session_tool_usage (
  session_id text not null,
  server_id text not null references mcp_servers(id) on delete cascade,
  raw_tool_name text not null,
  model_name text not null,
  success_count integer not null default 0,
  last_success_at text not null,
  primary key(session_id, server_id, raw_tool_name)
);

create index if not exists idx_mcp_session_tool_usage_recent
  on mcp_session_tool_usage(session_id, last_success_at desc);

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
    check (rule_kind in ('tool', 'tool_with_params', 'deny_tool')),
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
  capability_directory_json text not null default '[]',
  direct_available_tools integer not null default 0,
  on_demand_tools integer not null default 0,
  unavailable_tools integer not null default 0,
  created_at text not null
);

create index if not exists idx_mcp_runtime_snapshots_session_turn
  on mcp_runtime_snapshots(session_id, turn_id);

create table if not exists mcp_audit_log (
  id text primary key,
  event_type text not null,
  server_id text,
  raw_tool_name text,
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
  archived_at text
);

create unique index if not exists idx_workspaces_normalized_root_active
  on workspaces(normalized_root_path)
  where archived_at is null;
create index if not exists idx_workspaces_last_opened
  on workspaces(last_opened_at desc, updated_at desc, created_at desc);
create index if not exists idx_workspaces_archived
  on workspaces(archived_at desc, id desc)
  where archived_at is not null;

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
  visibility text not null default 'visible'
    check (visibility in ('visible', 'internal')),
  agent_kind text not null default 'main'
    check (agent_kind in ('main', 'subagent')),
  subagent_id text,
  subagent_role text check (subagent_role in ('explorer', 'worker')),
  subagent_closed_at text,
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
  archived_at text,
  archive_origin text,
  check (
    (archived_at is null and archive_origin is null)
    or
    (
      archived_at is not null
      and archive_origin is not null
      and archive_origin in ('manual', 'project')
    )
  ),
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
create index if not exists idx_sessions_archived
  on sessions(archived_at desc, id desc)
  where archived_at is not null;
create index if not exists idx_sessions_workspace_archive
  on sessions(workspace_id, archive_origin, archived_at desc, id desc);

create table if not exists right_sidebar_scope_states (
  id text primary key,
  scope_kind text not null
    check (scope_kind in ('session', 'workspace', 'global')),
  session_id text,
  workspace_id text,
  schema_version integer not null default 2
    check (schema_version = 2),
  state_json text not null,
  revision integer not null default 1
    check (revision >= 1),
  created_at text not null,
  updated_at text not null,
  check (
    (scope_kind = 'session' and session_id is not null and workspace_id is null)
    or (scope_kind = 'workspace' and session_id is null and workspace_id is not null)
    or (scope_kind = 'global' and session_id is null and workspace_id is null)
  ),
  foreign key(session_id) references sessions(id) on delete cascade,
  foreign key(workspace_id) references workspaces(id) on delete cascade
);

create unique index if not exists idx_right_sidebar_scope_session
  on right_sidebar_scope_states(session_id)
  where scope_kind = 'session';
create unique index if not exists idx_right_sidebar_scope_workspace
  on right_sidebar_scope_states(workspace_id)
  where scope_kind = 'workspace';
create unique index if not exists idx_right_sidebar_scope_global
  on right_sidebar_scope_states(scope_kind)
  where scope_kind = 'global';

create table if not exists right_sidebar_scope_promotions (
  id text primary key,
  source_scope_kind text not null
    check (source_scope_kind in ('workspace', 'global')),
  source_scope_key text not null,
  source_revision integer not null check (source_revision >= 1),
  target_session_id text not null,
  response_json text not null,
  created_at text not null,
  unique (source_scope_kind, source_scope_key, source_revision, target_session_id),
  foreign key(target_session_id) references sessions(id) on delete cascade
);

create index if not exists idx_right_sidebar_promotions_target
  on right_sidebar_scope_promotions(target_session_id, created_at desc);

create table if not exists web_annotation_resources (
  id text primary key,
  scope_kind text not null
    check (scope_kind in ('session', 'workspace', 'global')),
  session_id text,
  workspace_id text,
  source_kind text not null default 'web'
    check (source_kind in ('web', 'local_file')),
  normalization_version integer not null default 1
    check (
      (source_kind = 'web' and normalization_version = 1)
      or (source_kind = 'local_file' and normalization_version = 2)
    ),
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
    or (scope_kind = 'workspace' and session_id is null and workspace_id is not null)
    or (scope_kind = 'global' and session_id is null and workspace_id is null)
  ),
  foreign key(session_id) references sessions(id) on delete cascade,
  foreign key(workspace_id) references workspaces(id) on delete cascade
);

create unique index if not exists idx_web_resources_session_url
  on web_annotation_resources(session_id, url_key)
  where scope_kind = 'session';
create unique index if not exists idx_web_resources_workspace_url
  on web_annotation_resources(workspace_id, url_key)
  where scope_kind = 'workspace';
create unique index if not exists idx_web_resources_global_url
  on web_annotation_resources(scope_kind, url_key)
  where scope_kind = 'global';
create index if not exists idx_web_resources_document
  on web_annotation_resources(scope_kind, source_kind, document_url, updated_at desc);

create table if not exists web_annotations (
  id text primary key,
  resource_id text not null,
  target_type text not null
    check (target_type in ('text', 'element', 'region')),
  target_schema_version integer not null default 1
    check (target_schema_version = 1),
  target_json text not null check (length(target_json) > 0),
  body_markdown text not null,
  tags_json text not null default '[]',
  properties_json text not null default '[]',
  revision integer not null default 1 check (revision >= 1),
  created_at text not null,
  updated_at text not null,
  unique (id, resource_id),
  foreign key(resource_id) references web_annotation_resources(id) on delete cascade
);

create index if not exists idx_web_annotations_resource_created
  on web_annotations(resource_id, created_at, id);
create index if not exists idx_web_annotations_resource_updated
  on web_annotations(resource_id, updated_at desc, id);

create table if not exists web_annotation_target_history (
  id text primary key,
  annotation_id text not null,
  prior_revision integer not null check (prior_revision >= 1),
  target_type text not null
    check (target_type in ('text', 'element', 'region')),
  target_schema_version integer not null default 1
    check (target_schema_version = 1),
  target_json text not null check (length(target_json) > 0),
  reason text not null check (reason in ('user_retarget', 'migration')),
  created_at text not null,
  foreign key(annotation_id) references web_annotations(id) on delete cascade
);

create unique index if not exists idx_web_target_history_revision
  on web_annotation_target_history(annotation_id, prior_revision);

create table if not exists web_annotation_assets (
  id text primary key,
  resource_id text not null,
  annotation_id text,
  asset_kind text not null check (asset_kind in ('region_screenshot')),
  state text not null check (state in ('staged', 'attached')),
  storage_path text not null check (length(storage_path) > 0),
  mime_type text not null check (mime_type in ('image/png', 'image/jpeg', 'image/webp')),
  size_bytes integer not null check (size_bytes > 0),
  sha256 text not null check (length(sha256) = 64 and lower(sha256) = sha256),
  width integer not null check (width > 0),
  height integer not null check (height > 0),
  expires_at text,
  created_at text not null,
  updated_at text not null,
  check (
    (state = 'staged' and annotation_id is null and expires_at is not null)
    or (state = 'attached' and annotation_id is not null and expires_at is null)
  ),
  foreign key(resource_id) references web_annotation_resources(id) on delete cascade,
  foreign key(annotation_id, resource_id)
    references web_annotations(id, resource_id) on delete cascade
);

create unique index if not exists idx_web_annotation_assets_path
  on web_annotation_assets(storage_path);
create index if not exists idx_web_annotation_assets_staged_expiry
  on web_annotation_assets(state, expires_at)
  where state = 'staged';
create index if not exists idx_web_annotation_assets_annotation
  on web_annotation_assets(annotation_id, created_at, id)
  where annotation_id is not null;

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

create table if not exists web_annotation_attachment_clones (
  id text primary key,
  session_id text not null,
  annotation_id text not null,
  asset_id text not null,
  context_digest text not null,
  attachment_id text not null unique,
  created_at text not null,
  unique(session_id, annotation_id, asset_id, context_digest),
  foreign key(session_id) references sessions(id) on delete cascade,
  foreign key(attachment_id) references attachments(id) on delete cascade
);

create index if not exists idx_web_annotation_attachment_clones_session
  on web_annotation_attachment_clones(session_id, created_at desc);

drop table if exists workspace_file_annotations;

create table if not exists workspace_annotations (
  id text primary key,
  workspace_id text not null,
  document_path text not null,
  target_type text not null check (target_type in ('document', 'text')),
  selector_json text,
  body text not null,
  created_at text not null,
  updated_at text not null,
  check (
    (target_type = 'document' and selector_json is null)
    or
    (target_type = 'text' and selector_json is not null)
  ),
  foreign key(workspace_id) references workspaces(id) on delete cascade
);

create index if not exists idx_workspace_annotations_document
  on workspace_annotations(workspace_id, document_path, created_at, id);

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

create table if not exists session_pending_inputs (
  id text primary key,
  session_id text not null,
  client_input_id text,
  mode text not null check (mode in ('steer', 'queue')),
  status text not null check (status in (
    'pending_steer',
    'queued',
    'starting',
    'running',
    'delivered',
    'cancelled',
    'failed',
    'converted'
  )),
  message text not null,
  provider_id text not null default '',
  model text not null default '',
  user_id text,
  scene_id text,
  runtime_params_json text not null default '{}',
  attachments_json text not null default '[]',
  target_turn_index integer,
  target_trace_id text,
  promoted_turn_index integer,
  promoted_trace_id text,
  queue_position integer not null default 0,
  lock_owner text,
  lock_expires_at text,
  error_code text,
  error_message text,
  created_at text not null,
  updated_at text not null,
  delivered_at text,
  cancelled_at text,
  paused_at text,
  pause_reason text,
  is_deleted integer not null default 0,
  foreign key(session_id) references sessions(id) on delete cascade
);

create unique index if not exists idx_pending_inputs_client_id
  on session_pending_inputs(session_id, client_input_id)
  where client_input_id is not null and client_input_id != '' and is_deleted = 0;
create index if not exists idx_pending_inputs_session_status_created
  on session_pending_inputs(session_id, status, created_at, id)
  where is_deleted = 0;
create index if not exists idx_pending_inputs_session_active
  on session_pending_inputs(session_id, updated_at desc)
  where is_deleted = 0 and status in ('pending_steer', 'queued', 'starting', 'running');

create table if not exists a2ui_interactions (
  id text primary key,
  session_id text not null,
  trace_id text,
  active_session_id text,
  turn_index integer not null default 0,
  tool_call_id text,
  stream_id text not null,
  render_key text not null,
  mode text not null check (mode in ('render', 'interactive')),
  payload_json text not null default '{}',
  input_schema_json text not null default '{}',
  submit_schema_snapshot_json text not null default '{}',
  status text not null default 'waiting_user_input'
    check (status in ('waiting_user_input', 'submitted', 'cancelled')),
  submit_request_id text,
  cancel_request_id text,
  submit_result_json text,
  cancel_reason text,
  langgraph_thread_id text,
  checkpoint_ns text not null default '',
  checkpoint_id text,
  interrupt_id text,
  resume_group_id text,
  resume_status text not null default 'not_started'
    check (resume_status in ('not_started', 'deferred', 'started', 'succeeded', 'failed')),
  resume_payload_json text,
  resume_error text,
  created_at text not null,
  updated_at text not null,
  submitted_at text,
  cancelled_at text,
  resume_started_at text,
  resume_finished_at text,
  is_deleted integer not null default 0
);

create index if not exists idx_a2ui_interactions_session_status
  on a2ui_interactions(session_id, status, created_at);
create index if not exists idx_a2ui_interactions_session_turn
  on a2ui_interactions(session_id, turn_index, created_at);
create index if not exists idx_a2ui_interactions_resume_group
  on a2ui_interactions(resume_group_id, status, resume_status);
create index if not exists idx_a2ui_interactions_tool_call
  on a2ui_interactions(session_id, trace_id, tool_call_id);
create unique index if not exists idx_a2ui_interactions_session_tool_call_unique
  on a2ui_interactions(session_id, tool_call_id)
  where tool_call_id is not null;

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
  input_file_snapshot_id text,
  input_file_snapshot_status text,
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

create table if not exists file_history_session_state (
  session_id text primary key,
  active_snapshot_id text,
  next_sequence integer not null default 1 check (next_sequence >= 1),
  state text not null default 'ready'
    check (state in ('ready', 'disabled', 'degraded', 'blocked')),
  blocked_reason text,
  revision integer not null default 0 check (revision >= 0),
  created_at text not null,
  updated_at text not null,
  foreign key(session_id) references sessions(id) on delete cascade
);

create table if not exists file_history_snapshots (
  id text primary key,
  session_id text not null,
  active_session_id text,
  trace_id text,
  user_message_event_id text,
  parent_snapshot_id text,
  kind text not null check (kind in ('input', 'restore_result')),
  sequence integer not null check (sequence >= 1),
  workspace_root text not null,
  workspace_identity text not null,
  status text not null
    check (status in ('pending', 'ready', 'failed', 'superseded')),
  error_code text,
  created_at text not null,
  updated_at text not null,
  foreign key(session_id) references sessions(id) on delete cascade,
  foreign key(parent_snapshot_id) references file_history_snapshots(id) on delete set null,
  unique(session_id, sequence),
  unique(session_id, user_message_event_id)
);

create index if not exists idx_file_history_snapshots_session_status_sequence
  on file_history_snapshots(session_id, status, sequence desc);
create index if not exists idx_file_history_snapshots_trace
  on file_history_snapshots(trace_id)
  where trace_id is not null;
create index if not exists idx_file_history_snapshots_parent
  on file_history_snapshots(parent_snapshot_id)
  where parent_snapshot_id is not null;

create table if not exists file_history_snapshot_scopes (
  snapshot_id text not null,
  scope_kind text not null check (scope_kind in ('workspace', 'external')),
  scope_identity text not null check (length(scope_identity) > 0),
  scope_root text not null check (length(scope_root) > 0),
  scope_label text not null,
  primary key(snapshot_id, scope_kind, scope_identity),
  foreign key(snapshot_id) references file_history_snapshots(id) on delete cascade
);

create table if not exists file_history_snapshot_entries (
  snapshot_id text not null,
  scope_kind text not null check (scope_kind in ('workspace', 'external')),
  scope_identity text not null check (length(scope_identity) > 0),
  scope_root text not null check (length(scope_root) > 0),
  scope_label text not null,
  canonical_path text not null,
  display_path text not null,
  state text not null check (state in ('file', 'missing')),
  backup_file_name text,
  version integer not null check (version >= 1),
  backup_time text not null,
  size integer,
  mode integer,
  content_hash text,
  primary key(snapshot_id, scope_kind, scope_identity, canonical_path),
  foreign key(snapshot_id) references file_history_snapshots(id) on delete cascade,
  foreign key(snapshot_id, scope_kind, scope_identity)
    references file_history_snapshot_scopes(snapshot_id, scope_kind, scope_identity)
    on delete cascade,
  check (
    (state = 'missing' and backup_file_name is null and size is null and content_hash is null)
    or
    (
      state = 'file' and backup_file_name is not null
      and size is not null and content_hash is not null
    )
  )
);

create index if not exists idx_file_history_entries_path_snapshot
  on file_history_snapshot_entries(scope_kind, scope_identity, canonical_path, snapshot_id);
create index if not exists idx_file_history_entries_backup
  on file_history_snapshot_entries(backup_file_name)
  where backup_file_name is not null;

create table if not exists file_history_tracked_files (
  session_id text not null,
  scope_kind text not null check (scope_kind in ('workspace', 'external')),
  scope_identity text not null check (length(scope_identity) > 0),
  scope_root text not null check (length(scope_root) > 0),
  scope_label text not null,
  canonical_path text not null,
  display_path text not null,
  latest_version integer not null default 0 check (latest_version >= 0),
  first_snapshot_id text,
  last_snapshot_id text,
  last_observed_state text check (last_observed_state in ('file', 'missing')),
  last_observed_hash text,
  last_observed_size integer,
  last_observed_mtime_ns integer,
  last_observed_mode integer,
  created_at text not null,
  updated_at text not null,
  primary key(session_id, scope_kind, scope_identity, canonical_path),
  foreign key(session_id) references sessions(id) on delete cascade,
  foreign key(first_snapshot_id) references file_history_snapshots(id) on delete set null,
  foreign key(last_snapshot_id) references file_history_snapshots(id) on delete set null
);

create index if not exists idx_file_history_tracked_updated
  on file_history_tracked_files(session_id, updated_at desc);

create table if not exists file_history_mutations (
  id text primary key,
  session_id text not null,
  active_session_id text,
  trace_id text,
  turn_index integer,
  snapshot_id text,
  workspace_identity text not null,
  scope_kind text not null check (scope_kind in ('workspace', 'external')),
  scope_identity text not null check (length(scope_identity) > 0),
  scope_root text not null check (length(scope_root) > 0),
  scope_label text not null,
  canonical_path text not null,
  display_path text not null,
  tool_name text,
  tool_call_id text,
  batch_id text,
  mutation_kind text not null
    check (mutation_kind in ('create', 'update', 'delete', 'move_source', 'move_destination')),
  before_state text not null check (before_state in ('file', 'missing')),
  before_hash text,
  after_state text check (after_state in ('file', 'missing')),
  after_hash text,
  status text not null check (status in ('prepared', 'committed', 'aborted', 'dirty')),
  error_code text,
  created_at text not null,
  updated_at text not null,
  foreign key(session_id) references sessions(id) on delete cascade,
  foreign key(snapshot_id) references file_history_snapshots(id) on delete set null
);

create index if not exists idx_file_history_mutations_session_trace
  on file_history_mutations(session_id, trace_id, created_at);
create index if not exists idx_file_history_mutations_workspace_path
  on file_history_mutations(scope_kind, scope_identity, canonical_path, created_at desc);
create index if not exists idx_file_history_mutations_batch
  on file_history_mutations(batch_id)
  where batch_id is not null;
create unique index if not exists idx_file_history_mutations_snapshot_path
  on file_history_mutations(snapshot_id, scope_kind, scope_identity, canonical_path)
  where snapshot_id is not null;

create table if not exists file_history_path_heads (
  workspace_identity text not null,
  scope_kind text not null check (scope_kind in ('workspace', 'external')),
  scope_identity text not null check (length(scope_identity) > 0),
  scope_root text not null check (length(scope_root) > 0),
  scope_label text not null,
  canonical_path text not null,
  display_path text not null,
  session_id text not null,
  trace_id text,
  mutation_id text,
  state text not null check (state in ('file', 'missing')),
  content_hash text,
  revision integer not null default 1 check (revision >= 1),
  updated_at text not null,
  primary key(scope_kind, scope_identity, canonical_path),
  foreign key(session_id) references sessions(id) on delete cascade,
  foreign key(mutation_id) references file_history_mutations(id) on delete set null
);

create index if not exists idx_file_history_path_heads_session
  on file_history_path_heads(session_id, updated_at desc);

create table if not exists file_history_operations (
  id text primary key,
  request_id text not null,
  session_id text not null,
  active_session_id text,
  target_snapshot_id text,
  target_trace_id text,
  target_message_event_id text,
  workspace_identity text,
  mode text check (mode in ('both', 'code', 'conversation')),
  decision text check (
    decision is null or decision in (
      'full', 'safe_partial', 'force_conflicts', 'conversation_only', 'cancel'
    )
  ),
  state text not null check (
    state in (
      'previewed', 'running', 'full', 'partial', 'cancelled', 'failed',
      'compensated', 'compensation_failed', 'blocked'
    )
  ),
  preview_token text,
  preview_revision integer not null default 1 check (preview_revision >= 1),
  conversation_rewound integer not null default 0,
  active_snapshot_before text,
  active_snapshot_after text,
  restored_count integer not null default 0,
  skipped_count integer not null default 0,
  forced_count integer not null default 0,
  error_code text,
  error_detail_json text not null default '{}',
  compensation_state text not null default 'not_needed'
    check (compensation_state in ('not_needed', 'pending', 'complete', 'failed')),
  created_at text not null,
  updated_at text not null,
  completed_at text,
  foreign key(session_id) references sessions(id) on delete cascade,
  foreign key(target_snapshot_id) references file_history_snapshots(id) on delete set null,
  unique(session_id, request_id)
);

create index if not exists idx_file_history_operations_session_created
  on file_history_operations(session_id, created_at desc);
create index if not exists idx_file_history_operations_state
  on file_history_operations(state, updated_at);
create index if not exists idx_file_history_operations_target
  on file_history_operations(target_snapshot_id)
  where target_snapshot_id is not null;

create table if not exists file_history_operation_files (
  operation_id text not null,
  scope_kind text not null check (scope_kind in ('workspace', 'external')),
  scope_identity text not null check (length(scope_identity) > 0),
  scope_root text not null check (length(scope_root) > 0),
  scope_label text not null,
  canonical_path text not null,
  display_path text not null,
  preview_current_state text not null check (preview_current_state in ('file', 'missing')),
  preview_current_hash text,
  target_state text not null check (target_state in ('file', 'missing')),
  target_backup_file_name text,
  target_hash text,
  target_size integer,
  target_mode integer,
  classification text not null
    check (classification in ('ready', 'forceable_conflict', 'unrecoverable')),
  reason_code text,
  writer_session_id text,
  user_authorized integer not null default 0,
  result_state text not null default 'pending'
    check (result_state in ('pending', 'restored', 'forced', 'skipped', 'failed', 'compensated')),
  error_code text,
  safety_state text check (safety_state in ('file', 'missing')),
  safety_backup_file_name text,
  safety_hash text,
  safety_size integer,
  safety_mode integer,
  updated_at text not null,
  primary key(operation_id, scope_kind, scope_identity, canonical_path),
  foreign key(operation_id) references file_history_operations(id) on delete cascade
);

create index if not exists idx_file_history_operation_files_classification
  on file_history_operation_files(operation_id, classification, result_state);

create table if not exists file_history_locks (
  lock_key text primary key,
  owner_operation_id text not null,
  acquired_at text not null,
  expires_at text not null,
  foreign key(owner_operation_id) references file_history_operations(id) on delete cascade
);

create index if not exists idx_file_history_locks_expires
  on file_history_locks(expires_at);

create table if not exists lifecycle_operations (
  id text primary key,
  request_id text not null,
  payload_hash text not null,
  entity_type text not null check (entity_type in ('workspace', 'session')),
  entity_id text,
  entity_hash text not null,
  action text not null check (action in ('archive', 'restore', 'purge')),
  state text not null check (
    state in (
      'planned', 'running', 'quarantined', 'db_committed', 'completed',
      'cleanup_failed', 'rolled_back', 'compensation_failed', 'blocked', 'failed'
    )
  ),
  revision integer not null default 1 check (revision >= 1),
  counts_json text not null default '{}',
  result_json text not null default '{}',
  error_code text,
  error_detail_json text not null default '{}',
  quarantine_token text,
  created_at text not null,
  updated_at text not null,
  completed_at text,
  unique(entity_type, entity_hash, request_id)
);

create index if not exists idx_lifecycle_operations_entity_action
  on lifecycle_operations(entity_type, entity_hash, action, created_at desc);
create index if not exists idx_lifecycle_operations_state
  on lifecycle_operations(state, updated_at);

create table if not exists lifecycle_locks (
  lock_key text primary key,
  owner_operation_id text not null,
  acquired_at text not null,
  expires_at text not null,
  foreign key(owner_operation_id) references lifecycle_operations(id) on delete cascade
);

create index if not exists idx_lifecycle_locks_expires
  on lifecycle_locks(expires_at);

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
"""

LEGACY_CHECKPOINT_SCHEMA_SQL = """
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

CHECKPOINT_DOWNGRADE_GUARD_MESSAGE = (
    "Keydex 会话数据已升级，请使用当前版本或更高版本打开"
)

CHECKPOINT_DOWNGRADE_GUARD_SQL = f"""
create table if not exists checkpoint_backend_guard (
  id integer primary key check (id = 1),
  required_backend text not null,
  user_message text not null
);

insert or replace into checkpoint_backend_guard (
  id, required_backend, user_message
) values (
  1,
  'official_async_sqlite_delta_v1',
  '{CHECKPOINT_DOWNGRADE_GUARD_MESSAGE}'
);

-- These are intentionally empty compatibility shells, not legacy storage.  An old
-- binary can run its CREATE TABLE/INDEX IF NOT EXISTS startup DDL, then every
-- attempted mutation is stopped by the triggers below with an actionable message.
-- Views cannot be used here because SQLite rejects the old CREATE INDEX ... ON view
-- statements before considering IF NOT EXISTS.
create table if not exists checkpoints_v2 (
  thread_id text not null,
  checkpoint_ns text not null default '',
  checkpoint_id text not null,
  created_at text not null,
  parent_checkpoint_id text,
  type text not null,
  checkpoint_blob blob not null,
  metadata text,
  primary key (thread_id, checkpoint_ns, checkpoint_id)
);

create table if not exists checkpoint_writes_v2 (
  thread_id text not null,
  checkpoint_ns text not null default '',
  checkpoint_id text not null,
  task_id text not null,
  task_path text not null default '',
  idx integer not null,
  channel text not null,
  type text not null,
  value_blob blob not null,
  created_at text not null,
  primary key (thread_id, checkpoint_ns, checkpoint_id, task_id, task_path, idx)
);

create index if not exists idx_ckpt_thread_ns_created_id
  on checkpoints_v2(thread_id, checkpoint_ns, created_at desc, checkpoint_id desc);
create index if not exists idx_writes_thread_ns_ckpt
  on checkpoint_writes_v2(thread_id, checkpoint_ns, checkpoint_id);

create trigger if not exists trg_checkpoints_v2_downgrade_insert
before insert on checkpoints_v2
begin
  select raise(abort, '{CHECKPOINT_DOWNGRADE_GUARD_MESSAGE}');
end;
create trigger if not exists trg_checkpoints_v2_downgrade_update
before update on checkpoints_v2
begin
  select raise(abort, '{CHECKPOINT_DOWNGRADE_GUARD_MESSAGE}');
end;
create trigger if not exists trg_checkpoints_v2_downgrade_delete
before delete on checkpoints_v2
begin
  select raise(abort, '{CHECKPOINT_DOWNGRADE_GUARD_MESSAGE}');
end;
create trigger if not exists trg_checkpoint_writes_v2_downgrade_insert
before insert on checkpoint_writes_v2
begin
  select raise(abort, '{CHECKPOINT_DOWNGRADE_GUARD_MESSAGE}');
end;
create trigger if not exists trg_checkpoint_writes_v2_downgrade_update
before update on checkpoint_writes_v2
begin
  select raise(abort, '{CHECKPOINT_DOWNGRADE_GUARD_MESSAGE}');
end;
create trigger if not exists trg_checkpoint_writes_v2_downgrade_delete
before delete on checkpoint_writes_v2
begin
  select raise(abort, '{CHECKPOINT_DOWNGRADE_GUARD_MESSAGE}');
end;
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
  where pinned_at is not null and archived_at is null;
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

create table if not exists tool_result_artifacts (
  id text primary key,
  owner_user_id text not null,
  source_session_id text,
  tool_call_id text not null,
  tool_name text not null,
  storage_kind text not null
    check (storage_kind in ('managed_json', 'managed_text', 'command_log')),
  relative_path text not null,
  content_type text not null,
  content_sha256 text not null,
  content_bytes integer not null check (content_bytes >= 0),
  approximate_tokens integer not null check (approximate_tokens >= 0),
  is_complete integer not null default 1 check (is_complete in (0, 1)),
  status text not null default 'active'
    check (status in ('active', 'quarantined', 'deleted')),
  created_at text not null,
  last_accessed_at text,
  deleted_at text,
  unique (source_session_id, tool_call_id, content_sha256)
);

create index if not exists idx_tool_result_artifacts_owner_status
  on tool_result_artifacts(owner_user_id, status);
create index if not exists idx_tool_result_artifacts_source_session
  on tool_result_artifacts(source_session_id);

create table if not exists tool_result_artifact_grants (
  artifact_id text not null,
  session_id text not null,
  created_at text not null,
  primary key (artifact_id, session_id),
  foreign key (artifact_id) references tool_result_artifacts(id) on delete cascade,
  foreign key (session_id) references sessions(id) on delete cascade
);

create index if not exists idx_tool_result_artifact_grants_session
  on tool_result_artifact_grants(session_id);
"""

CHECKPOINT_MIGRATION_SCHEMA_SQL = """
create table if not exists checkpoint_migration_state (
  migration_id text primary key,
  source_schema text not null,
  target_schema text not null,
  status text not null check (status in (
    'pending', 'preflighting', 'copying_business_data',
    'collapsing_checkpoints', 'verifying_target', 'ready_to_swap',
    'swapping', 'smoke_checking', 'completed', 'failed'
  )),
  source_db_fingerprint text not null,
  source_db_bytes integer not null default 0,
  source_wal_bytes integer not null default 0,
  source_page_count integer not null default 0,
  source_freelist_count integer not null default 0,
  estimated_target_bytes integer not null default 0,
  free_disk_bytes integer not null default 0,
  target_db_bytes integer not null default 0,
  target_temp_path text,
  backup_path text,
  progress_basis_points integer not null default 0
    check (progress_basis_points between 0 and 10000),
  migrated_namespaces integer not null default 0,
  created_roots integer not null default 0,
  preserved_head_writes integer not null default 0,
  discarded_checkpoints integer not null default 0,
  discarded_writes integer not null default 0,
  source_checkpoint_count integer,
  source_write_count integer,
  inventory_json text not null default '{}',
  business_source_digest text,
  business_target_digest text,
  error_code text,
  error_detail text,
  started_at text,
  completed_at text,
  ui_acknowledged_at text,
  progress_updated_at text,
  updated_at text not null
);

create table if not exists checkpoint_migration_namespaces (
  migration_id text not null,
  thread_id text not null,
  checkpoint_ns text not null default '',
  status text not null check (status in ('pending', 'running', 'completed', 'failed')),
  source_checkpoint_count integer not null default 0,
  source_write_count integer not null default 0,
  root_checkpoint_id text,
  preserved_head_write_count integer not null default 0,
  discarded_checkpoint_count integer not null default 0,
  discarded_write_count integer not null default 0,
  source_head_digest text,
  target_root_digest text,
  hydrate_digest text,
  error_code text,
  error_detail text,
  started_at text,
  completed_at text,
  updated_at text not null,
  primary key (migration_id, thread_id, checkpoint_ns),
  foreign key (migration_id) references checkpoint_migration_state(migration_id)
    on delete cascade
);

create index if not exists idx_checkpoint_migration_ns_status
  on checkpoint_migration_namespaces(migration_id, status, thread_id, checkpoint_ns);
"""


class _ClosingConnection(sqlite3.Connection):
    """SQLite connection whose context manager owns and closes the handle.

    ``sqlite3.Connection.__exit__`` only commits or rolls back.  Most of the
    repository deliberately uses ``with database.connect()`` as an ownership
    boundary, so leaving the standard behavior in place leaks Windows file
    handles and makes an atomic database replacement impossible.
    """

    def __exit__(self, exc_type, exc_value, traceback) -> bool:
        try:
            return super().__exit__(exc_type, exc_value, traceback)
        finally:
            self.close()


class Database:
    def __init__(self, path: Path | str) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(
            self.path,
            timeout=30.0,
            factory=_ClosingConnection,
        )
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
            self._migrate_archive_lifecycle_schema(conn)
            self._migrate_file_history_multiscope_schema(conn)
            self._migrate_web_annotation_resource_identity_schema(conn)
            conn.executescript(SCHEMA_SQL)
            conn.executescript(CHECKPOINT_MIGRATION_SCHEMA_SQL)
            self._ensure_column(conn, "sessions", "workspace_id", "text")
            self._ensure_column(
                conn,
                "sessions",
                "session_type",
                "text not null default 'chat'",
            )
            self._ensure_column(
                conn,
                "sessions",
                "visibility",
                "text not null default 'visible' check (visibility in ('visible', 'internal'))",
            )
            self._ensure_column(
                conn,
                "sessions",
                "agent_kind",
                "text not null default 'main' check (agent_kind in ('main', 'subagent'))",
            )
            self._ensure_column(conn, "sessions", "subagent_id", "text")
            self._ensure_column(
                conn,
                "sessions",
                "subagent_role",
                "text check (subagent_role in ('explorer', 'worker'))",
            )
            self._ensure_column(conn, "sessions", "subagent_closed_at", "text")
            self._ensure_subagent_session_schema(conn)
            self._ensure_subagent_run_schema(conn)
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
            self._ensure_column(
                conn,
                "sessions",
                "checkpoint_lineage_epoch",
                "integer not null default 0",
            )
            self._ensure_column(
                conn,
                "sessions",
                "checkpoint_history_floor_turn_index",
                "integer not null default 0",
            )
            self._ensure_column(conn, "sessions", "checkpoint_root_id", "text")
            self._ensure_column(conn, "sessions", "checkpoint_collapsed_at", "text")
            self._ensure_column(conn, "sessions", "checkpoint_migration_id", "text")
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
            self._ensure_column(conn, "trace_record", "input_checkpoint_id", "text")
            self._ensure_column(conn, "trace_record", "input_checkpoint_ns", "text")
            self._ensure_column(conn, "trace_record", "input_file_snapshot_id", "text")
            self._ensure_column(conn, "trace_record", "input_file_snapshot_status", "text")
            conn.execute(
                """
                create index if not exists idx_trace_record_input_file_snapshot
                  on trace_record(input_file_snapshot_id)
                  where input_file_snapshot_id is not null
                """
            )
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
            self._ensure_column(
                conn,
                "mcp_runtime_snapshots",
                "capability_directory_json",
                "text not null default '[]'",
            )
            self._ensure_column(
                conn,
                "mcp_runtime_snapshots",
                "direct_available_tools",
                "integer not null default 0",
            )
            self._ensure_column(
                conn,
                "mcp_runtime_snapshots",
                "on_demand_tools",
                "integer not null default 0",
            )
            self._ensure_column(
                conn,
                "mcp_runtime_snapshots",
                "unavailable_tools",
                "integer not null default 0",
            )
            self._ensure_column(
                conn,
                "mcp_tool_policies",
                "priority_available",
                "integer not null default 0",
            )
            self._ensure_column(conn, "session_pending_inputs", "paused_at", "text")
            self._ensure_column(conn, "session_pending_inputs", "pause_reason", "text")
            conn.executescript(SCHEMA_UPGRADE_SQL)
            self._remove_mcp_prompt_schema(conn)
            self._remove_mcp_risk_schema(conn)
            self._migrate_mcp_refresh_interval_default(conn)
            self._normalize_legacy_mcp_refreshing_status(conn)
            self._ensure_checkpoint_downgrade_guard(conn)
            if should_migrate_legacy_sessions:
                self._migrate_legacy_sessions_to_default_workspace(
                    conn,
                    default_workspace_root=default_workspace_root,
                )
            foreign_key_errors = conn.execute("pragma foreign_key_check").fetchall()
            if foreign_key_errors:
                raise RuntimeError(
                    "归档生命周期 schema 迁移后外键校验失败: "
                    f"{[tuple(row) for row in foreign_key_errors[:5]]}"
                )
        logger.info(f"[Database] 初始化 schema 完成 | path={self.path}")

    @staticmethod
    def _column_names(conn: sqlite3.Connection, table_name: str) -> set[str]:
        return {
            str(row["name"]) for row in conn.execute(f"pragma table_info({table_name})").fetchall()
        }

    @staticmethod
    def _ensure_checkpoint_downgrade_guard(conn: sqlite3.Connection) -> None:
        has_guard = (
            conn.execute(
                """
                select 1 from sqlite_master
                where type = 'table' and name = 'checkpoint_backend_guard'
                """
            ).fetchone()
            is not None
        )
        if has_guard:
            conn.executescript(CHECKPOINT_DOWNGRADE_GUARD_SQL)
            return
        legacy_tables = int(
            conn.execute(
                """
                select count(*) from sqlite_master
                where type = 'table'
                  and name in ('checkpoints_v2', 'checkpoint_writes_v2')
                """
            ).fetchone()[0]
        )
        if legacy_tables:
            return
        conn.executescript(CHECKPOINT_DOWNGRADE_GUARD_SQL)

    @staticmethod
    def _migration_column_expr(
        columns: set[str],
        column_name: str,
        *,
        alias: str,
        default_sql: str,
    ) -> str:
        if column_name in columns:
            return f'{alias}."{column_name}"'
        return default_sql

    @classmethod
    def _migrate_web_annotation_resource_identity_schema(
        cls,
        conn: sqlite3.Connection,
    ) -> None:
        """Rebuild the v1-only resource table for web v1/local_file v2.

        SQLite cannot alter CHECK constraints in place. The rebuild keeps the
        original table name as the foreign-key target and copies every legacy
        row as ``source_kind='web'`` in one transaction.
        """

        columns = cls._column_names(conn, "web_annotation_resources")
        if not columns or "source_kind" in columns:
            return
        expected_count = int(
            conn.execute("select count(*) from web_annotation_resources").fetchone()[0]
        )
        conn.commit()
        conn.execute("pragma foreign_keys = off")
        conn.execute("pragma legacy_alter_table = on")
        try:
            conn.executescript(
                """
                begin immediate;
                drop index if exists idx_web_resources_session_url;
                drop index if exists idx_web_resources_workspace_url;
                drop index if exists idx_web_resources_global_url;
                drop index if exists idx_web_resources_document;

                alter table web_annotation_resources
                  rename to web_annotation_resources_legacy_v1;

                create table web_annotation_resources (
                  id text primary key,
                  scope_kind text not null
                    check (scope_kind in ('session', 'workspace', 'global')),
                  session_id text,
                  workspace_id text,
                  source_kind text not null default 'web'
                    check (source_kind in ('web', 'local_file')),
                  normalization_version integer not null default 1
                    check (
                      (source_kind = 'web' and normalization_version = 1)
                      or (source_kind = 'local_file' and normalization_version = 2)
                    ),
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
                    or (scope_kind = 'workspace' and session_id is null and workspace_id is not null)
                    or (scope_kind = 'global' and session_id is null and workspace_id is null)
                  ),
                  foreign key(session_id) references sessions(id) on delete cascade,
                  foreign key(workspace_id) references workspaces(id) on delete cascade
                );

                insert into web_annotation_resources (
                  id, scope_kind, session_id, workspace_id, source_kind,
                  normalization_version, url_key, url_normalized, document_url,
                  canonical_url, origin, title, page_fingerprint_json,
                  created_at, updated_at
                )
                select
                  id, scope_kind, session_id, workspace_id, 'web',
                  normalization_version, url_key, url_normalized, document_url,
                  canonical_url, origin, title, page_fingerprint_json,
                  created_at, updated_at
                from web_annotation_resources_legacy_v1;

                drop table web_annotation_resources_legacy_v1;

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
                  on web_annotation_resources(
                    scope_kind, source_kind, document_url, updated_at desc
                  );
                commit;
                """
            )
            actual_count = int(
                conn.execute("select count(*) from web_annotation_resources").fetchone()[0]
            )
            if actual_count != expected_count:
                raise RuntimeError(
                    "Web annotation resource identity migration changed row count"
                )
        except BaseException:
            if conn.in_transaction:
                conn.rollback()
            raise
        finally:
            conn.execute("pragma legacy_alter_table = off")
            conn.execute("pragma foreign_keys = on")

    @classmethod
    def _migrate_file_history_multiscope_schema(cls, conn: sqlite3.Connection) -> None:
        """Rebuild legacy single-root history tables as composite resources.

        The migration is metadata-only: roots need not be online and backup
        artifacts are intentionally left in place. The old snapshot root is the
        authoritative workspace scope for every legacy entry.
        """

        entry_columns = cls._column_names(conn, "file_history_snapshot_entries")
        if not entry_columns or "scope_kind" in entry_columns:
            return
        required_tables = (
            "file_history_snapshot_entries",
            "file_history_tracked_files",
            "file_history_mutations",
            "file_history_path_heads",
            "file_history_operation_files",
        )
        counts = {
            table: int(conn.execute(f'select count(*) from "{table}"').fetchone()[0])
            for table in required_tables
        }
        conn.commit()
        conn.execute("pragma foreign_keys = off")
        conn.execute("pragma legacy_alter_table = on")
        try:
            conn.executescript(
                """
                begin immediate;
                drop index if exists idx_file_history_entries_path_snapshot;
                drop index if exists idx_file_history_entries_backup;
                drop index if exists idx_file_history_tracked_updated;
                drop index if exists idx_file_history_mutations_session_trace;
                drop index if exists idx_file_history_mutations_workspace_path;
                drop index if exists idx_file_history_mutations_batch;
                drop index if exists idx_file_history_mutations_snapshot_path;
                drop index if exists idx_file_history_path_heads_session;
                drop index if exists idx_file_history_operation_files_classification;

                alter table file_history_operation_files
                  rename to file_history_operation_files_legacy;
                alter table file_history_path_heads
                  rename to file_history_path_heads_legacy;
                alter table file_history_mutations
                  rename to file_history_mutations_legacy;
                alter table file_history_tracked_files
                  rename to file_history_tracked_files_legacy;
                alter table file_history_snapshot_entries
                  rename to file_history_snapshot_entries_legacy;

                create table file_history_snapshot_scopes (
                  snapshot_id text not null,
                  scope_kind text not null check (scope_kind in ('workspace', 'external')),
                  scope_identity text not null check (length(scope_identity) > 0),
                  scope_root text not null check (length(scope_root) > 0),
                  scope_label text not null,
                  primary key(snapshot_id, scope_kind, scope_identity),
                  foreign key(snapshot_id) references file_history_snapshots(id) on delete cascade
                );
                insert into file_history_snapshot_scopes (
                  snapshot_id, scope_kind, scope_identity, scope_root, scope_label
                )
                select id, 'workspace', workspace_identity, workspace_root, workspace_root
                from file_history_snapshots;

                create table file_history_snapshot_entries (
                  snapshot_id text not null,
                  scope_kind text not null check (scope_kind in ('workspace', 'external')),
                  scope_identity text not null check (length(scope_identity) > 0),
                  scope_root text not null check (length(scope_root) > 0),
                  scope_label text not null,
                  canonical_path text not null,
                  display_path text not null,
                  state text not null check (state in ('file', 'missing')),
                  backup_file_name text,
                  version integer not null check (version >= 1),
                  backup_time text not null,
                  size integer,
                  mode integer,
                  content_hash text,
                  primary key(snapshot_id, scope_kind, scope_identity, canonical_path),
                  foreign key(snapshot_id) references file_history_snapshots(id) on delete cascade,
                  foreign key(snapshot_id, scope_kind, scope_identity)
                    references file_history_snapshot_scopes(snapshot_id, scope_kind, scope_identity)
                    on delete cascade,
                  check (
                    (state = 'missing' and backup_file_name is null and size is null and content_hash is null)
                    or (state = 'file' and backup_file_name is not null
                        and size is not null and content_hash is not null)
                  )
                );
                insert into file_history_snapshot_entries (
                  snapshot_id, scope_kind, scope_identity, scope_root, scope_label,
                  canonical_path, display_path, state, backup_file_name, version,
                  backup_time, size, mode, content_hash
                )
                select e.snapshot_id, 'workspace', s.workspace_identity, s.workspace_root,
                       s.workspace_root, e.canonical_path, e.display_path, e.state,
                       e.backup_file_name, e.version, e.backup_time, e.size, e.mode,
                       e.content_hash
                from file_history_snapshot_entries_legacy e
                join file_history_snapshots s on s.id = e.snapshot_id;

                create table file_history_tracked_files (
                  session_id text not null,
                  scope_kind text not null check (scope_kind in ('workspace', 'external')),
                  scope_identity text not null check (length(scope_identity) > 0),
                  scope_root text not null check (length(scope_root) > 0),
                  scope_label text not null,
                  canonical_path text not null,
                  display_path text not null,
                  latest_version integer not null default 0 check (latest_version >= 0),
                  first_snapshot_id text,
                  last_snapshot_id text,
                  last_observed_state text check (last_observed_state in ('file', 'missing')),
                  last_observed_hash text,
                  last_observed_size integer,
                  last_observed_mtime_ns integer,
                  last_observed_mode integer,
                  created_at text not null,
                  updated_at text not null,
                  primary key(session_id, scope_kind, scope_identity, canonical_path),
                  foreign key(session_id) references sessions(id) on delete cascade,
                  foreign key(first_snapshot_id) references file_history_snapshots(id) on delete set null,
                  foreign key(last_snapshot_id) references file_history_snapshots(id) on delete set null
                );
                insert into file_history_tracked_files (
                  session_id, scope_kind, scope_identity, scope_root, scope_label,
                  canonical_path, display_path, latest_version, first_snapshot_id,
                  last_snapshot_id, last_observed_state, last_observed_hash,
                  last_observed_size, last_observed_mtime_ns, last_observed_mode,
                  created_at, updated_at
                )
                select t.session_id, 'workspace',
                       coalesce(s.workspace_identity, 'legacy:' || t.session_id),
                       coalesce(s.workspace_root, s.workspace_identity, 'legacy:' || t.session_id),
                       coalesce(s.workspace_root, s.workspace_identity, 'legacy:' || t.session_id),
                       t.canonical_path, t.display_path, t.latest_version,
                       t.first_snapshot_id, t.last_snapshot_id, t.last_observed_state,
                       t.last_observed_hash, t.last_observed_size,
                       t.last_observed_mtime_ns, t.last_observed_mode,
                       t.created_at, t.updated_at
                from file_history_tracked_files_legacy t
                left join file_history_snapshots s
                  on s.id = coalesce(t.last_snapshot_id, t.first_snapshot_id);

                create table file_history_mutations (
                  id text primary key,
                  session_id text not null,
                  active_session_id text,
                  trace_id text,
                  turn_index integer,
                  snapshot_id text,
                  workspace_identity text not null,
                  scope_kind text not null check (scope_kind in ('workspace', 'external')),
                  scope_identity text not null check (length(scope_identity) > 0),
                  scope_root text not null check (length(scope_root) > 0),
                  scope_label text not null,
                  canonical_path text not null,
                  display_path text not null,
                  tool_name text,
                  tool_call_id text,
                  batch_id text,
                  mutation_kind text not null
                    check (mutation_kind in ('create', 'update', 'delete', 'move_source', 'move_destination')),
                  before_state text not null check (before_state in ('file', 'missing')),
                  before_hash text,
                  after_state text check (after_state in ('file', 'missing')),
                  after_hash text,
                  status text not null check (status in ('prepared', 'committed', 'aborted', 'dirty')),
                  error_code text,
                  created_at text not null,
                  updated_at text not null,
                  foreign key(session_id) references sessions(id) on delete cascade,
                  foreign key(snapshot_id) references file_history_snapshots(id) on delete set null
                );
                insert into file_history_mutations (
                  id, session_id, active_session_id, trace_id, turn_index, snapshot_id,
                  workspace_identity, scope_kind, scope_identity, scope_root, scope_label,
                  canonical_path, display_path, tool_name, tool_call_id, batch_id,
                  mutation_kind, before_state, before_hash, after_state, after_hash,
                  status, error_code, created_at, updated_at
                )
                select m.id, m.session_id, m.active_session_id, m.trace_id, m.turn_index,
                       m.snapshot_id, m.workspace_identity, 'workspace', m.workspace_identity,
                       coalesce(s.workspace_root, m.workspace_identity),
                       coalesce(s.workspace_root, m.workspace_identity),
                       m.canonical_path, m.display_path, m.tool_name, m.tool_call_id,
                       m.batch_id, m.mutation_kind, m.before_state, m.before_hash,
                       m.after_state, m.after_hash, m.status, m.error_code,
                       m.created_at, m.updated_at
                from file_history_mutations_legacy m
                left join file_history_snapshots s on s.id = m.snapshot_id;

                create table file_history_path_heads (
                  workspace_identity text not null,
                  scope_kind text not null check (scope_kind in ('workspace', 'external')),
                  scope_identity text not null check (length(scope_identity) > 0),
                  scope_root text not null check (length(scope_root) > 0),
                  scope_label text not null,
                  canonical_path text not null,
                  display_path text not null,
                  session_id text not null,
                  trace_id text,
                  mutation_id text,
                  state text not null check (state in ('file', 'missing')),
                  content_hash text,
                  revision integer not null default 1 check (revision >= 1),
                  updated_at text not null,
                  primary key(scope_kind, scope_identity, canonical_path),
                  foreign key(session_id) references sessions(id) on delete cascade,
                  foreign key(mutation_id) references file_history_mutations(id) on delete set null
                );
                insert into file_history_path_heads (
                  workspace_identity, scope_kind, scope_identity, scope_root, scope_label,
                  canonical_path, display_path, session_id, trace_id, mutation_id,
                  state, content_hash, revision, updated_at
                )
                select h.workspace_identity, 'workspace', h.workspace_identity,
                       coalesce(s.workspace_root, h.workspace_identity),
                       coalesce(s.workspace_root, h.workspace_identity),
                       h.canonical_path, h.display_path, h.session_id, h.trace_id,
                       h.mutation_id, h.state, h.content_hash, h.revision, h.updated_at
                from file_history_path_heads_legacy h
                left join file_history_snapshots s on s.id = (
                  select id from file_history_snapshots
                  where session_id = h.session_id order by sequence desc limit 1
                );

                create table file_history_operation_files (
                  operation_id text not null,
                  scope_kind text not null check (scope_kind in ('workspace', 'external')),
                  scope_identity text not null check (length(scope_identity) > 0),
                  scope_root text not null check (length(scope_root) > 0),
                  scope_label text not null,
                  canonical_path text not null,
                  display_path text not null,
                  preview_current_state text not null check (preview_current_state in ('file', 'missing')),
                  preview_current_hash text,
                  target_state text not null check (target_state in ('file', 'missing')),
                  target_backup_file_name text,
                  target_hash text,
                  target_size integer,
                  target_mode integer,
                  classification text not null
                    check (classification in ('ready', 'forceable_conflict', 'unrecoverable')),
                  reason_code text,
                  writer_session_id text,
                  user_authorized integer not null default 0,
                  result_state text not null default 'pending'
                    check (result_state in ('pending', 'restored', 'forced', 'skipped', 'failed', 'compensated')),
                  error_code text,
                  safety_state text check (safety_state in ('file', 'missing')),
                  safety_backup_file_name text,
                  safety_hash text,
                  safety_size integer,
                  safety_mode integer,
                  updated_at text not null,
                  primary key(operation_id, scope_kind, scope_identity, canonical_path),
                  foreign key(operation_id) references file_history_operations(id) on delete cascade
                );
                insert into file_history_operation_files (
                  operation_id, scope_kind, scope_identity, scope_root, scope_label,
                  canonical_path, display_path, preview_current_state,
                  preview_current_hash, target_state, target_backup_file_name,
                  target_hash, target_size, target_mode, classification, reason_code,
                  writer_session_id, user_authorized, result_state, error_code,
                  safety_state, safety_backup_file_name, safety_hash, safety_size,
                  safety_mode, updated_at
                )
                select f.operation_id, 'workspace',
                       coalesce(s.workspace_identity, o.workspace_identity, 'legacy:' || o.session_id),
                       coalesce(s.workspace_root, o.workspace_identity, 'legacy:' || o.session_id),
                       coalesce(s.workspace_root, o.workspace_identity, 'legacy:' || o.session_id),
                       f.canonical_path, f.display_path, f.preview_current_state,
                       f.preview_current_hash, f.target_state, f.target_backup_file_name,
                       f.target_hash, f.target_size, f.target_mode, f.classification,
                       f.reason_code, f.writer_session_id, f.user_authorized,
                       f.result_state, f.error_code, f.safety_state,
                       f.safety_backup_file_name, f.safety_hash, f.safety_size,
                       f.safety_mode, f.updated_at
                from file_history_operation_files_legacy f
                join file_history_operations o on o.id = f.operation_id
                left join file_history_snapshots s on s.id = o.target_snapshot_id;

                drop table file_history_operation_files_legacy;
                drop table file_history_path_heads_legacy;
                drop table file_history_mutations_legacy;
                drop table file_history_tracked_files_legacy;
                drop table file_history_snapshot_entries_legacy;
                commit;
                """
            )
            for table, expected in counts.items():
                actual = int(conn.execute(f'select count(*) from "{table}"').fetchone()[0])
                if actual != expected:
                    raise RuntimeError(
                        f"文件历史多作用域迁移行数不一致: {table} {expected} != {actual}"
                    )
        except Exception:
            if conn.in_transaction:
                conn.rollback()
            raise
        finally:
            conn.execute("pragma legacy_alter_table = off")
            conn.execute("pragma foreign_keys = on")

    @classmethod
    def _migrate_archive_lifecycle_schema(cls, conn: sqlite3.Connection) -> None:
        workspace_columns = cls._column_names(conn, "workspaces")
        session_columns = cls._column_names(conn, "sessions")
        migrate_workspaces = bool(workspace_columns) and (
            "is_deleted" in workspace_columns or "archived_at" not in workspace_columns
        )
        migrate_sessions = bool(session_columns) and (
            "is_deleted" in session_columns
            or "archived_at" not in session_columns
            or "archive_origin" not in session_columns
        )
        if not migrate_workspaces and not migrate_sessions:
            return

        migrated_at = to_iso_z(utc_now())
        conn.commit()
        conn.execute("pragma foreign_keys = off")
        conn.execute("pragma legacy_alter_table = on")
        try:
            conn.execute("begin immediate")
            for index_name in (
                "idx_workspaces_normalized_root_active",
                "idx_workspaces_last_opened",
                "idx_workspaces_deleted_updated",
                "idx_workspaces_archived",
                "idx_sessions_scene_id",
                "idx_sessions_scene_id_version_seq",
                "idx_sessions_user_scene_session_tag",
                "idx_sessions_status",
                "idx_sessions_active_session_id",
                "idx_sessions_parent_session_id",
                "idx_sessions_child_session_id",
                "idx_sessions_updated_at",
                "idx_sessions_workspace_id",
                "idx_sessions_session_type",
                "idx_sessions_workspace_updated",
                "idx_sessions_type_updated",
                "idx_sessions_pinned_at",
                "idx_sessions_archived",
                "idx_sessions_workspace_archive",
            ):
                conn.execute(f'drop index if exists "{index_name}"')

            if migrate_workspaces:
                conn.execute("drop table if exists workspaces__archive_new")
                conn.execute(
                    """
                    create table workspaces__archive_new (
                      id text primary key,
                      name text not null,
                      root_path text not null,
                      normalized_root_path text not null,
                      type text not null default 'project',
                      created_at text not null,
                      updated_at text not null,
                      last_opened_at text,
                      archived_at text
                    )
                    """
                )
                workspace_expr = lambda name, default: cls._migration_column_expr(  # noqa: E731
                    workspace_columns,
                    name,
                    alias="w",
                    default_sql=default,
                )
                if "archived_at" in workspace_columns:
                    workspace_archived_expr = "w.archived_at"
                    workspace_params: tuple[str, ...] = ()
                elif "is_deleted" in workspace_columns:
                    workspace_archived_expr = (
                        "case when coalesce(w.is_deleted, 0) = 1 then ? else null end"
                    )
                    workspace_params = (migrated_at,)
                else:
                    workspace_archived_expr = "null"
                    workspace_params = ()
                conn.execute(
                    f"""
                    insert into workspaces__archive_new (
                      id, name, root_path, normalized_root_path, type,
                      created_at, updated_at, last_opened_at, archived_at
                    )
                    select
                      {workspace_expr('id', "''")},
                      {workspace_expr('name', "''")},
                      {workspace_expr('root_path', "''")},
                      {workspace_expr('normalized_root_path', "''")},
                      {workspace_expr('type', "'project'")},
                      {workspace_expr('created_at', "''")},
                      {workspace_expr('updated_at', "''")},
                      {workspace_expr('last_opened_at', 'null')},
                      {workspace_archived_expr}
                    from workspaces w
                    """,
                    workspace_params,
                )

            if migrate_sessions:
                conn.execute("drop table if exists sessions__archive_new")
                conn.execute(
                    """
                    create table sessions__archive_new (
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
                      archived_at text,
                      archive_origin text,
                      check (
                        (archived_at is null and archive_origin is null)
                        or
                        (
                          archived_at is not null
                          and archive_origin is not null
                          and archive_origin in ('manual', 'project')
                        )
                      ),
                      foreign key(workspace_id) references workspaces(id) on delete set null
                    )
                    """
                )
                session_expr = lambda name, default: cls._migration_column_expr(  # noqa: E731
                    session_columns,
                    name,
                    alias="s",
                    default_sql=default,
                )
                legacy_session_was_deleted = (
                    "coalesce(s.is_deleted, 0) = 1"
                    if "is_deleted" in session_columns
                    else "s.archived_at is not null"
                )
                workspace_join = ""
                workspace_archived = "0"
                if workspace_columns and "workspace_id" in session_columns:
                    workspace_join = "left join workspaces w on w.id = s.workspace_id"
                    if "is_deleted" in workspace_columns:
                        workspace_archived = "coalesce(w.is_deleted, 0) = 1"
                    elif "archived_at" in workspace_columns:
                        workspace_archived = "w.archived_at is not null"
                valid_existing_archive = (
                    "s.archived_at is not null "
                    "and s.archive_origin in ('manual', 'project')"
                    if {"archived_at", "archive_origin"}.issubset(session_columns)
                    else "0"
                )
                existing_archived_at = (
                    "s.archived_at" if "archived_at" in session_columns else "null"
                )
                existing_origin = (
                    "s.archive_origin" if "archive_origin" in session_columns else "null"
                )
                conn.execute(
                    f"""
                    insert into sessions__archive_new (
                      id, user_id, scene_id, scene_version_seq, status, is_debug,
                      debug_type, is_scheduled, scheduled_task_id, session_tag,
                      active_session_id, parent_session_id, child_session_id,
                      source_trace_id, source_active_session_id, source_checkpoint_id,
                      source_checkpoint_ns, workspace_id, session_type, cwd,
                      workspace_roots_json, current_model_provider_id, current_model,
                      context_window_usage_json, context_compression_epoch, pinned_at,
                      title, title_source, created_at, updated_at,
                      archived_at, archive_origin
                    )
                    select
                      {session_expr('id', "''")},
                      {session_expr('user_id', "''")},
                      {session_expr('scene_id', "''")},
                      {session_expr('scene_version_seq', 'null')},
                      {session_expr('status', "'active'")},
                      {session_expr('is_debug', '0')},
                      {session_expr('debug_type', 'null')},
                      {session_expr('is_scheduled', '0')},
                      {session_expr('scheduled_task_id', 'null')},
                      {session_expr('session_tag', "'chat'")},
                      {session_expr('active_session_id', 's.id')},
                      {session_expr('parent_session_id', 'null')},
                      {session_expr('child_session_id', 'null')},
                      {session_expr('source_trace_id', 'null')},
                      {session_expr('source_active_session_id', 'null')},
                      {session_expr('source_checkpoint_id', 'null')},
                      {session_expr('source_checkpoint_ns', 'null')},
                      {session_expr('workspace_id', 'null')},
                      {session_expr('session_type', "'chat'")},
                      {session_expr('cwd', 'null')},
                      {session_expr('workspace_roots_json', "'[]'")},
                      {session_expr('current_model_provider_id', 'null')},
                      {session_expr('current_model', 'null')},
                      {session_expr('context_window_usage_json', 'null')},
                      {session_expr('context_compression_epoch', '0')},
                      {session_expr('pinned_at', 'null')},
                      {session_expr('title', 'null')},
                      {session_expr('title_source', "'manual'")},
                      {session_expr('created_at', "''")},
                      {session_expr('updated_at', "''")},
                      case
                        when {valid_existing_archive} then {existing_archived_at}
                        when {legacy_session_was_deleted} then ?
                        when {workspace_archived} then ?
                        else null
                      end,
                      case
                        when {valid_existing_archive} then {existing_origin}
                        when {legacy_session_was_deleted} then 'manual'
                        when {workspace_archived} then 'project'
                        else null
                      end
                    from sessions s
                    {workspace_join}
                    """,
                    (migrated_at, migrated_at),
                )

            if migrate_sessions:
                conn.execute("drop table sessions")
            if migrate_workspaces:
                conn.execute("drop table workspaces")
                conn.execute("alter table workspaces__archive_new rename to workspaces")
            if migrate_sessions:
                conn.execute("alter table sessions__archive_new rename to sessions")
            foreign_key_errors = conn.execute("pragma foreign_key_check").fetchall()
            if foreign_key_errors:
                raise RuntimeError(
                    "归档生命周期表重建外键校验失败: "
                    f"{[tuple(row) for row in foreign_key_errors[:5]]}"
                )
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.execute("pragma legacy_alter_table = off")
            conn.execute("pragma foreign_keys = on")

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
    def _ensure_subagent_session_schema(conn: sqlite3.Connection) -> None:
        conn.executescript(
            """
            create index if not exists idx_sessions_visibility
              on sessions(visibility);
            create index if not exists idx_sessions_parent_agent_kind
              on sessions(parent_session_id, agent_kind);
            create unique index if not exists idx_sessions_subagent_id_unique
              on sessions(subagent_id)
              where subagent_id is not null;

            create trigger if not exists trg_sessions_subagent_shape_insert
            before insert on sessions
            when
              (
                new.agent_kind = 'subagent'
                and not (
                  new.visibility = 'internal'
                  and new.subagent_id is not null
                  and length(trim(new.subagent_id)) > 0
                  and new.subagent_role in ('explorer', 'worker')
                  and new.parent_session_id is not null
                  and length(trim(new.parent_session_id)) > 0
                  and new.session_type = 'workspace'
                  and new.session_tag = 'subagent'
                )
              )
              or
              (
                new.agent_kind = 'main'
                and (
                  new.subagent_id is not null
                  or new.subagent_role is not null
                  or new.subagent_closed_at is not null
                )
              )
            begin
              select raise(abort, 'invalid subagent session shape');
            end;

            create trigger if not exists trg_sessions_subagent_shape_update
            before update of
              visibility, agent_kind, subagent_id, subagent_role,
              subagent_closed_at, parent_session_id, session_type, session_tag
            on sessions
            when
              (
                new.agent_kind = 'subagent'
                and not (
                  new.visibility = 'internal'
                  and new.subagent_id is not null
                  and length(trim(new.subagent_id)) > 0
                  and new.subagent_role in ('explorer', 'worker')
                  and new.parent_session_id is not null
                  and length(trim(new.parent_session_id)) > 0
                  and new.session_type = 'workspace'
                  and new.session_tag = 'subagent'
                )
              )
              or
              (
                new.agent_kind = 'main'
                and (
                  new.subagent_id is not null
                  or new.subagent_role is not null
                  or new.subagent_closed_at is not null
                )
              )
            begin
              select raise(abort, 'invalid subagent session shape');
            end;
            """
        )

    @staticmethod
    def _ensure_subagent_run_schema(conn: sqlite3.Connection) -> None:
        conn.executescript(
            """
            create table if not exists subagent_run (
              run_id text primary key,
              subagent_id text not null,
              child_session_id text not null,
              parent_session_id text not null,
              parent_trace_id text,
              parent_tool_call_id text,
              parent_timeline_sequence integer not null
                check (parent_timeline_sequence >= 0),
              initiated_by text not null
                check (initiated_by in ('main_agent', 'user')),
              role text not null
                check (role in ('explorer', 'worker')),
              task text not null check (length(trim(task)) > 0),
              state text not null
                check (state in (
                  'queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted'
                )),
              blocked_on text
                check (blocked_on is null or blocked_on in (
                  'approval', 'user_input', 'external_tool'
                )),
              version integer not null default 1 check (version >= 1),
              final_report text,
              report_truncated integer not null default 0
                check (report_truncated in (0, 1)),
              error_code text,
              error_message text,
              created_at text not null,
              queued_at text not null,
              started_at text,
              finished_at text,
              updated_at text not null,
              cancel_requested_at text,
              check (blocked_on is null or state = 'running'),
              check (
                (state in ('queued', 'running') and finished_at is null)
                or
                (state in ('completed', 'failed', 'cancelled', 'interrupted')
                  and finished_at is not null)
              ),
              check (
                (state = 'completed'
                  and final_report is not null
                  and length(trim(final_report)) > 0
                  and error_code is null
                  and error_message is null)
                or
                (state = 'failed'
                  and final_report is null
                  and error_code is not null
                  and error_message is not null)
                or
                (state in ('queued', 'running', 'cancelled', 'interrupted')
                  and final_report is null)
              ),
              check (report_truncated = 0 or final_report is not null),
              check (
                (initiated_by = 'main_agent' and parent_tool_call_id is not null)
                or initiated_by = 'user'
              ),
              foreign key(child_session_id) references sessions(id) on delete cascade,
              foreign key(parent_session_id) references sessions(id) on delete cascade
            );

            create unique index if not exists idx_subagent_run_parent_sequence
              on subagent_run(parent_session_id, parent_timeline_sequence);
            create unique index if not exists idx_subagent_run_active_instance
              on subagent_run(subagent_id)
              where state in ('queued', 'running');
            create index if not exists idx_subagent_run_parent_created
              on subagent_run(parent_session_id, parent_timeline_sequence, created_at, run_id);
            create index if not exists idx_subagent_run_child_created
              on subagent_run(child_session_id, created_at, run_id);
            create index if not exists idx_subagent_run_instance_created
              on subagent_run(subagent_id, created_at, run_id);
            create index if not exists idx_subagent_run_parent_trace_active
              on subagent_run(parent_session_id, parent_trace_id, state);
            create index if not exists idx_subagent_run_state
              on subagent_run(state, updated_at);
            """
        )

    @classmethod
    def _remove_mcp_prompt_schema(cls, conn: sqlite3.Connection) -> None:
        conn.execute("drop table if exists mcp_prompt_policies")
        conn.execute("drop table if exists mcp_prompts")
        cls._drop_column_if_exists(conn, "mcp_servers", "prompt_discovery_enabled")
        cls._drop_column_if_exists(conn, "mcp_server_status", "prompts_count")
        cls._drop_column_if_exists(conn, "mcp_audit_log", "prompt_name")

    @classmethod
    def _remove_mcp_risk_schema(cls, conn: sqlite3.Connection) -> None:
        conn.execute("drop index if exists idx_mcp_tools_risk")
        cls._drop_column_if_exists(conn, "mcp_tools", "risk_level")
        cls._drop_column_if_exists(conn, "mcp_tool_policies", "risk_override")

    @staticmethod
    def _migrate_mcp_refresh_interval_default(conn: sqlite3.Connection) -> None:
        conn.execute(
            """
            update mcp_servers
               set refresh_interval_sec = 60
             where refresh_interval_sec = 1800
            """
        )

    @staticmethod
    def _normalize_legacy_mcp_refreshing_status(conn: sqlite3.Connection) -> None:
        conn.execute(
            """
            update mcp_server_status
               set status = 'unknown',
                   updated_at = ?
             where status = 'refreshing'
            """,
            (to_iso_z(utc_now()),),
        )

    @classmethod
    def _drop_column_if_exists(
        cls,
        conn: sqlite3.Connection,
        table_name: str,
        column_name: str,
    ) -> None:
        if column_name in cls._column_names(conn, table_name):
            conn.execute(f"alter table {table_name} drop column {column_name}")

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
            where normalized_root_path = ? and archived_at is null
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
