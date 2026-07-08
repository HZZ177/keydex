export type PermissionMode = "read_only" | "workspace_write" | "full_access";
export type ThreadStatus = "idle" | "running" | "waiting_approval" | "waiting_input" | "failed";
export type TurnStatus = "queued" | "in_progress" | "completed" | "failed" | "cancelled";
export type ThreadItemStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export type ThreadItemType =
  | "user_message"
  | "assistant_message"
  | "reasoning"
  | "tool_call"
  | "command_execution"
  | "file_change"
  | "approval_request"
  | "error"
  | "token_usage";

export type RuntimeEventType =
  | "thread.created"
  | "thread.updated"
  | "turn.started"
  | "turn.completed"
  | "turn.failed"
  | "turn.cancelled"
  | "item.started"
  | "item.delta"
  | "item.completed"
  | "approval.requested"
  | "approval.resolved"
  | "runtime.error";

export interface Thread {
  id: string;
  title: string | null;
  preview: string;
  cwd: string;
  workspace_roots: string[];
  model: string;
  permission_mode: PermissionMode;
  status: ThreadStatus;
  created_at: string;
  updated_at: string;
  archived: boolean;
}

export interface TurnError {
  code: string;
  message: string;
  details: Record<string, unknown>;
}

export interface Turn {
  id: string;
  thread_id: string;
  status: TurnStatus;
  started_at: string | null;
  completed_at: string | null;
  duration_ms: number | null;
  error: TurnError | null;
}

export interface ThreadItem {
  id: string;
  thread_id: string;
  turn_id: string;
  type: ThreadItemType;
  status: ThreadItemStatus;
  payload: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  seq_start: number | null;
  seq_end: number | null;
}

export interface RuntimeEvent {
  event_id: string;
  thread_id: string;
  turn_id: string | null;
  item_id: string | null;
  seq: number;
  type: RuntimeEventType;
  created_at: string;
  payload: Record<string, unknown>;
}

export type ApprovalDecision = "approved" | "rejected";
export type ApprovalKind =
  | "exec"
  | "file_change"
  | "read_external"
  | "write_external"
  | "mcp_tool_call"
  | "mcp_sampling";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "cancelled";

export interface ApprovalRequest {
  id: string;
  thread_id: string;
  turn_id: string;
  item_id: string;
  call_id: string;
  kind: ApprovalKind;
  title: string;
  description: string;
  details: Record<string, unknown>;
  status: ApprovalStatus;
  created_at: string;
}

export type ToolKind = "function" | "freeform";
export type ToolResultStatus = "success" | "error" | "rejected" | "cancelled";

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  kind: ToolKind;
  requires_approval_by_default: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown> | string;
  raw: Record<string, unknown> | null;
}

export interface ToolResult {
  call_id: string;
  status: ToolResultStatus;
  model_content: string;
  ui_payload: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export type McpTransport = "stdio" | "streamable_http" | "sse";
export type McpServerStatus =
  | "unknown"
  | "online"
  | "offline"
  | "auth_required"
  | "error"
  | "disabled"
  | "refreshing";
export type McpApprovalMode = "auto" | "prompt" | "approve" | "deny" | "inherit";
export type McpToolExposureMode =
  | "allow_all_except_disabled"
  | "allow_selected_only";
export type McpAuthType = "none" | "header_token" | "bearer_env" | "oauth";
export type McpRestartPolicy = "never" | "on_failure" | "always";
export type McpConnectMode = "on_demand" | "on_startup";
export type McpToolSchemaChangeAction = "keep_enabled" | "require_review" | "disable";
export type McpToolDiscoveryStatus = "new" | "active" | "removed" | "schema_changed";
export type McpToolAvailabilityMode = "direct" | "on_demand" | "disabled";
export type McpToolEffectiveState =
  | "enabled"
  | "disabled_persistently"
  | "disabled_for_session"
  | "disabled_by_server"
  | "server_offline"
  | "approval_required"
  | "removed"
  | "schema_changed";
export type McpToolBulkPolicyAction =
  | "enable_selected"
  | "disable_selected"
  | "keep_selected_only"
  | "prompt_all";
export type McpImportSourceType = "keydex";
export type McpImportConflictStrategy = "skip" | "rename" | "error";
export type McpTrustRuleKind = "tool" | "tool_with_params" | "deny_tool";
export type McpTrustRuleScope = "session" | "global";
export type McpTrustApprovalMode = "approve" | "deny";
export type McpErrorCode =
  | "mcp_disabled"
  | "server_not_found"
  | "server_disabled"
  | "server_offline"
  | "auth_required"
  | "tool_not_found"
  | "tool_disabled_by_policy"
  | "tool_disabled_by_session"
  | "approval_required"
  | "approval_rejected"
  | "policy_denied"
  | "timeout"
  | "cancelled"
  | "protocol_error"
  | "validation_error"
  | "result_too_large"
  | "resource_reserved"
  | "internal_error";

export interface McpServerAuthSummary {
  auth_type: McpAuthType;
  headers_configured: boolean;
  env_headers_configured: boolean;
  bearer_token_env_var?: string | null;
  secret_ref_keys: string[];
  oauth_configured: boolean;
  oauth_resource?: string | null;
  oauth_scopes: string[];
}

export interface McpServerSummary {
  id: string;
  name: string;
  description?: string | null;
  enabled: boolean;
  required: boolean;
  transport: McpTransport;
  auth_type?: McpAuthType;
  status: McpServerStatus;
  tools_count: number;
  direct_tools_count?: number;
  on_demand_tools_count?: number;
  recently_used_tools_count?: number;
  resources_reserved: boolean;
  resources_reserved_count?: number;
  last_connected_at?: string | null;
  last_refresh_at?: string | null;
  last_error_code?: string | null;
  last_error_message?: string | null;
  last_error_detail?: Record<string, unknown> | null;
  created_at?: string;
  updated_at?: string;
}

export interface McpServerDetailResponse extends McpServerSummary {
  auth?: McpServerAuthSummary;
  command?: string | null;
  args?: string[];
  cwd?: string | null;
  url?: string | null;
  sse_url?: string | null;
  message_url?: string | null;
  inherit_environment?: boolean;
  env_keys?: string[];
  header_keys?: string[];
  env_header_keys?: string[];
  bearer_token_env_var?: string | null;
  auth_type?: McpAuthType;
  secret_ref_keys?: string[];
  oauth_configured?: boolean;
  oauth_resource?: string | null;
  oauth_scopes?: string[];
  startup_timeout_sec: number;
  tool_timeout_sec: number;
  read_timeout_sec: number;
  sse_read_timeout_sec: number;
  shutdown_timeout_sec: number;
  restart_policy?: McpRestartPolicy;
  connect_mode?: McpConnectMode;
  auto_refresh: boolean;
  refresh_interval_sec: number;
  default_tool_exposure_mode: McpToolExposureMode;
  default_tool_approval_mode: Extract<McpApprovalMode, "auto" | "prompt" | "approve">;
  supports_parallel_tool_calls?: boolean;
  elicitation_enabled: boolean;
  sampling_enabled: boolean;
  sampling_approval_mode?: "prompt" | "auto" | string | null;
  sampling_model_policy?: "current_default" | string | null;
  sampling_max_tokens?: number | null;
  sampling_audit_detail?: "summary" | "none" | "full" | string | null;
  resource_reserved_policy?: Record<string, unknown> | null;
}

export interface McpToolSummary {
  id: string;
  server_id: string;
  server_name: string;
  raw_name: string;
  model_name: string;
  display_name?: string | null;
  description?: string | null;
  input_schema?: Record<string, unknown>;
  enabled: boolean;
  hidden: boolean;
  priority_available?: boolean;
  availability_mode?: McpToolAvailabilityMode | string;
  status?: McpToolDiscoveryStatus | string;
  discovery_status?: McpToolDiscoveryStatus | string;
  effective_state: McpToolEffectiveState;
  approval_mode: McpApprovalMode;
  effective_approval_mode?: McpApprovalMode;
  schema_change_action?: McpToolSchemaChangeAction;
  parameter_constraints?: Record<string, unknown> | null;
  annotations?: Record<string, unknown>;
  last_used_at?: string | null;
  call_count?: number;
  failure_count?: number;
  first_seen_at?: string;
  last_seen_at?: string;
  removed_at?: string | null;
}

export interface McpRuntimeSnapshotSummary {
  id?: string;
  snapshot_id?: string;
  session_id: string;
  turn_id?: string | null;
  tool_inventory_revision?: number;
  visible_tools_count?: number;
  visible_tools?: Array<{
    server_id?: string | null;
    server_name?: string | null;
    raw_name?: string | null;
    model_name?: string | null;
    description?: string | null;
    exposure?: string | null;
  }>;
  server_status?: Record<string, unknown>;
  policy_summary?: Record<string, unknown>;
  capability_directory?: Array<Record<string, unknown>>;
  direct_available_tools?: number;
  on_demand_tools?: number;
  unavailable_tools?: number;
  servers_total?: number;
  servers_online?: number;
  tools_visible?: number;
  tools_disabled_for_session?: number;
  pending_approvals?: number;
  created_at: string;
}

export interface McpToolEventMetadata {
  kind: "mcp_tool";
  snapshot_id?: string;
  server_id?: string;
  server_name?: string | null;
  raw_tool_name?: string;
  model_tool_name?: string;
  model_name?: string;
  approval_mode?: McpApprovalMode | string;
  exposure?: string;
  call_id?: string | null;
  annotations?: Record<string, unknown> | null;
}

export interface McpErrorPayload {
  code: McpErrorCode;
  message: string;
  detail: Record<string, unknown>;
}

export interface McpServerListResponse {
  list: McpServerSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface McpServerCreatePayload {
  name: string;
  description?: string | null;
  enabled?: boolean;
  required?: boolean;
  transport: McpTransport;
  command?: string | null;
  args?: string[] | null;
  cwd?: string | null;
  env?: Record<string, string> | null;
  inherit_environment?: boolean;
  url?: string | null;
  sse_url?: string | null;
  message_url?: string | null;
  headers?: Record<string, unknown> | null;
  env_headers?: Record<string, string> | null;
  bearer_token_env_var?: string | null;
  auth_type?: McpAuthType;
  secret_refs?: Record<string, string> | null;
  oauth_config?: Record<string, unknown> | null;
  oauth_resource?: string | null;
  oauth_scopes?: string[] | null;
  startup_timeout_sec?: number;
  tool_timeout_sec?: number;
  read_timeout_sec?: number;
  sse_read_timeout_sec?: number;
  shutdown_timeout_sec?: number;
  restart_policy?: McpRestartPolicy;
  connect_mode?: McpConnectMode;
  auto_refresh?: boolean;
  refresh_interval_sec?: number;
  default_tool_exposure_mode?: McpToolExposureMode;
  default_tool_approval_mode?: Extract<McpApprovalMode, "auto" | "prompt" | "approve">;
  supports_parallel_tool_calls?: boolean;
  elicitation_enabled?: boolean;
  sampling_enabled?: boolean;
  resource_reserved_policy?: Record<string, unknown> | null;
}

export type McpServerUpdatePayload = Partial<McpServerCreatePayload>;

export interface McpRefreshResult {
  ok: boolean;
  server_id?: string;
  status?: McpServerStatus | string;
  tools_count?: number;
  resources_reserved_count?: number;
  removed_tools_count?: number;
  schema_changed_tools_count?: number;
  refresh_revision?: number;
  duration_ms?: number;
  error?: McpErrorPayload;
}

export interface McpRefreshAllResponse {
  ok: boolean;
  list: McpRefreshResult[];
  total: number;
}

export interface McpConnectionTestResponse {
  ok: boolean;
  server_id: string;
  status: McpServerStatus | string;
  protocol_version?: string;
  server_info?: Record<string, unknown>;
  capabilities?: Record<string, unknown>;
  tools_count?: number;
  resources_reserved_count?: number;
  duration_ms?: number;
  error?: McpErrorPayload;
}

export interface McpConnectionTestPayload {
  server: McpServerCreatePayload;
  base_server_id?: string | null;
}

export interface McpToolListResponse {
  list: McpToolSummary[];
  total: number;
  limit: number;
}

export interface McpToolPolicyUpdatePayload {
  enabled?: boolean | null;
  hidden?: boolean | null;
  priority_available?: boolean | null;
  approval_mode?: McpApprovalMode | null;
  parameter_constraints?: Record<string, unknown> | null;
  schema_change_action?: McpToolSchemaChangeAction | null;
}

export interface McpToolBulkPolicyPayload {
  action: McpToolBulkPolicyAction;
  tool_ids?: string[];
  raw_tool_names?: string[];
}

export interface McpToolBulkPolicyResponse {
  server_id: string;
  action: McpToolBulkPolicyAction;
  updated_count: number;
  tools: McpToolSummary[];
}

export interface McpSessionToolOverride {
  id: string;
  session_id: string;
  server_id: string;
  raw_tool_name: string;
  enabled: boolean;
  reason?: string | null;
  created_at: string;
  expires_at?: string | null;
}

export interface McpRuntimeCallSummary {
  call_id: string;
  session_id?: string | null;
  snapshot_id: string;
  server_id: string;
  server_name: string;
  raw_tool_name: string;
  model_name: string;
  approval_mode: McpApprovalMode | string;
  started_at: string;
  elapsed_ms: number;
}

export interface McpRuntimeStatusResponse {
  session_id: string;
  manager: {
    enabled: boolean;
    runtime_status: string;
    started: boolean;
    active_client_count: number;
  };
  snapshot: McpRuntimeSnapshotSummary | null;
  servers: McpServerSummary[];
  tools: McpToolSummary[];
  overrides: McpSessionToolOverride[];
  running_calls: McpRuntimeCallSummary[];
  pending_approvals: number;
  summary: {
    servers_total: number;
    servers_online: number;
    tools_total: number;
    tools_enabled: number;
    running_calls: number;
    pending_approvals: number;
  };
}

export interface McpSessionToolOverridePayload {
  enabled: boolean;
  server_id?: string | null;
  reason?: string | null;
}

export interface McpSessionToolOverrideResponse {
  session_id: string;
  override?: McpSessionToolOverride;
  deleted?: boolean;
  tool: McpToolSummary;
  apply_timing?: Record<string, unknown>;
  applies_to_current_run?: boolean;
}

export interface McpRuntimeCallCancelResponse {
  call_id: string;
  cancelled: boolean;
  reason?: string;
  server_id?: string;
  raw_tool_name?: string;
}

export type McpElicitationStatus = "pending" | "submitted" | "cancelled" | "timeout";

export interface McpElicitationRequest {
  elicitation_id: string;
  id?: string;
  session_id: string;
  server_id: string;
  server_name?: string | null;
  raw_tool_name?: string | null;
  title: string;
  schema: Record<string, unknown>;
  status?: McpElicitationStatus;
  values?: Record<string, unknown> | null;
  created_at: string;
}

export interface McpElicitationResolvePayload {
  elicitation_id: string;
  values?: Record<string, unknown>;
  cancelled?: boolean;
  user_id?: string | null;
}

export interface McpImportPreviewServer {
  name: string;
  transport: McpTransport | string;
  enabled: boolean;
  conflict: boolean;
  action: "create" | "skip" | "rename" | "error" | string;
  missing_secrets: string[];
  unknown_fields: string[];
}

export interface McpImportPreviewResponse {
  source_type: McpImportSourceType;
  conflict_strategy: McpImportConflictStrategy;
  server_count: number;
  servers: McpImportPreviewServer[];
  conflicts: string[];
  missing_secrets: string[];
  unknown_fields: string[];
  valid: boolean;
  applied?: boolean;
  created_count?: number;
  skipped_count?: number;
  created?: Array<{ id: string; name: string; transport: McpTransport | string }>;
  skipped?: string[];
}

export interface McpImportPayload {
  source_type: McpImportSourceType;
  config: Record<string, unknown>;
  confirm?: boolean;
  conflict_strategy?: McpImportConflictStrategy;
}

export interface McpExportPayload {
  include_trust_rules?: boolean;
  server_ids?: string[];
}

export interface McpExportResponse {
  format: "keydex.mcp.v1" | string;
  servers: Array<Record<string, unknown>>;
  tool_policies: Array<Record<string, unknown>>;
  trust_rules?: Array<Record<string, unknown>>;
}

export interface McpAuditRecord {
  id: string;
  event_type: string;
  server_id?: string | null;
  raw_tool_name?: string | null;
  session_id?: string | null;
  turn_id?: string | null;
  call_id?: string | null;
  approval_id?: string | null;
  actor?: string | null;
  status?: string | null;
  duration_ms?: number | null;
  summary?: string | null;
  detail?: Record<string, unknown> | null;
  created_at: string;
}

export interface McpAuditListResponse {
  list: McpAuditRecord[];
  total: number;
  limit: number;
  offset: number;
}

export interface McpTrustRule {
  id: string;
  rule_kind: McpTrustRuleKind;
  scope: McpTrustRuleScope;
  approval_mode: McpTrustApprovalMode;
  hit_count: number;
  created_at: string;
  updated_at: string;
  server_id?: string | null;
  raw_tool_name?: string | null;
  session_id?: string | null;
  condition?: Record<string, unknown> | null;
  created_from_approval_id?: string | null;
  expires_at?: string | null;
  last_hit_at?: string | null;
}

export interface McpTrustRulePayload {
  rule_kind: McpTrustRuleKind;
  scope: McpTrustRuleScope;
  approval_mode: McpTrustApprovalMode;
  server_id?: string | null;
  raw_tool_name?: string | null;
  session_id?: string | null;
  condition?: Record<string, unknown> | null;
  expires_at?: string | null;
}

export interface McpOAuthStartPayload {
  redirect_uri?: string | null;
}

export interface McpOAuthStartResponse {
  server_id: string;
  auth_url: string;
  state: string;
}

export interface McpOAuthCallbackPayload {
  state: string;
  code: string;
}

export interface McpOAuthStatusResponse {
  server_id: string;
  status: string;
  token_configured: boolean;
  account_label?: string | null;
  scopes: unknown[];
  expires_at?: string | null;
}

export interface ThreadDetail {
  thread: Thread;
  turns: Turn[];
  items: ThreadItem[];
}

export interface ModelSettings {
  base_url: string;
  api_key?: string | null;
  model: string;
  timeout_seconds?: number;
}

export interface PublicModelSettings {
  base_url: string;
  model: string;
  timeout_seconds: number;
  api_key_set: boolean;
  api_key_preview: string | null;
}

export type ModelDefaultScope = "default_chat" | "fast";

export interface PublicModelDefault {
  scope: ModelDefaultScope;
  configured: boolean;
  provider_id: string | null;
  provider_name: string | null;
  model: string | null;
  provider_enabled: boolean | null;
  model_enabled: boolean | null;
  missing_reason: string | null;
}

export interface ModelDefaultsResponse {
  defaults: Record<ModelDefaultScope, PublicModelDefault>;
}

export interface ModelDefaultSelection {
  provider_id: string;
  model: string;
}

export interface UpdateModelDefaultsPayload {
  defaults: Partial<Record<ModelDefaultScope, ModelDefaultSelection | null>>;
}

export interface AutoTitleRuntimeSettings {
  enabled: boolean;
  only_when_default_title: boolean;
  max_title_length: number;
}

export interface DuplicateToolCallGuardRuntimeSettings {
  enabled: boolean;
  max_repeats: number;
}

export interface ContextCompressionRuntimeSettings {
  enabled: boolean;
  context_window_tokens: number;
  trigger_fraction: number;
}

export interface A2UIRuntimeSettings {
  enabled: boolean;
}

export interface AgentRuntimeSettings {
  auto_title: AutoTitleRuntimeSettings;
  duplicate_tool_call_guard: DuplicateToolCallGuardRuntimeSettings;
  context_compression: ContextCompressionRuntimeSettings;
  a2ui: A2UIRuntimeSettings;
}

export type AppFontFamily = "system" | "maple-mono" | "jetbrains-mono";

export interface AppearanceSettings {
  font_family: AppFontFamily;
}

export type CloseWindowBehavior = "exit" | "minimize_to_tray";

export interface GeneralSettings {
  close_window_behavior: CloseWindowBehavior | null;
}

export type FileAccessMode = "no_file_access" | "workspace_read_only" | "workspace_trusted" | "full_access";
export type CommandShell = "git_bash" | "powershell" | "cmd";

export interface CommandShellConfig {
  shell_path: string;
  shell_label: string;
  shell_edition?: string | null;
  shell_version?: string | null;
}

export interface CommandSettings {
  command_enabled: boolean;
  selected_shell: CommandShell;
  shell_path: string;
  shell_label: string;
  shell_edition?: string | null;
  shell_version?: string | null;
  shells: Partial<Record<CommandShell, CommandShellConfig>>;
  require_approval_for_untrusted: boolean;
  allow_persistent_trust: boolean;
  file_access_mode: FileAccessMode;
  default_timeout_seconds: number;
  max_timeout_seconds: number;
  inline_output_max_chars: number;
  tail_max_chars: number;
  output_file_max_bytes: number;
  progress_interval_ms: number;
}

export interface CommandRuntimeProbeResponse {
  shell: CommandShell;
  found: boolean;
  path?: string | null;
  label?: string | null;
  edition?: string | null;
  version?: string | null;
  diagnostics: string[];
  error?: string | null;
}

export type TrustedCommandRuleMatchType = "exact" | "prefix";

export interface TrustedCommandRule {
  id: string;
  command_pattern: string;
  normalized_command: string;
  match_type: TrustedCommandRuleMatchType;
  tool_name: string;
  shell: string;
  shell_path: string;
  workspace_root: string;
  cwd_pattern: string;
  enabled: boolean;
  created_from_approval_id?: string | null;
  created_at: string;
  updated_at: string;
  last_used_at?: string | null;
}

export type CommandApprovalDecisionValue = "approved" | "rejected";
export type CommandApprovalTrustScope =
  | "once"
  | "persistent"
  | "session"
  | "persistent_tool"
  | "persistent_server";

export interface CommandApprovalRequest {
  id: string;
  session_id: string;
  thread_id?: string;
  turn_id?: string;
  item_id?: string;
  call_id?: string;
  run_id?: string | null;
  tool_name: string;
  kind: "exec" | string;
  title: string;
  description: string;
  details: Record<string, unknown>;
  status: ApprovalStatus;
  decision?: CommandApprovalDecisionValue | null;
  trust_scope?: CommandApprovalTrustScope | null;
  rule_match_type?: TrustedCommandRuleMatchType | null;
  reject_message?: string | null;
  trusted_rule_id?: string | null;
  metadata?: Record<string, unknown>;
  server_id?: string | null;
  server_name?: string | null;
  raw_tool_name?: string | null;
  model_tool_name?: string | null;
  snapshot_id?: string | null;
  created_at: string;
  resolved_at?: string | null;
}

export interface CommandApprovalDecisionPayload {
  decision: CommandApprovalDecisionValue;
  trust_scope?: CommandApprovalTrustScope;
  rule_match_type?: TrustedCommandRuleMatchType | null;
  reject_message?: string;
}

export interface CommandApprovalAuditRecord {
  id: string;
  approval_id: string;
  session_id: string;
  command: string;
  cwd: string;
  decision: CommandApprovalDecisionValue;
  trust_scope?: CommandApprovalTrustScope | null;
  rule_match_type?: TrustedCommandRuleMatchType | null;
  trusted_rule_id?: string | null;
  reject_message?: string | null;
  metadata?: Record<string, unknown>;
  created_at: string;
}

export interface SettingsResponse {
  model: PublicModelSettings;
  general: GeneralSettings;
  appearance: AppearanceSettings;
  command: CommandSettings;
}

export interface ModelInfo {
  id: string;
  owned_by?: string | null;
  raw?: Record<string, unknown>;
}

export type UsageBucket = "hour" | "day";
export type UsageRequestStatus = "running" | "completed" | "failed" | "cancelled" | (string & {});

export interface UsageSummary {
  request_count: number;
  total_tokens: number;
  input_tokens: number;
  cache_read_tokens: number;
  output_tokens: number;
  success_count: number;
  failed_count: number;
  avg_duration_ms: number;
}

export interface UsageTrendPoint {
  time: string;
  request_count: number;
  input_tokens: number;
  cache_read_tokens: number;
  output_tokens: number;
  total_tokens: number;
  failed_count: number;
}

export interface UsageTrendResponse {
  points: UsageTrendPoint[];
  next_cursor?: string | null;
  has_more?: boolean;
}

export interface UsageRequestLog {
  id: string;
  created_at: string;
  updated_at: string;
  trace_id: string;
  trace_record_id: string;
  session_id: string;
  active_session_id?: string | null;
  gateway_thread_id?: string | null;
  gateway_trace_id?: string | null;
  turn_index?: number | null;
  provider_id?: string | null;
  provider_name?: string | null;
  model: string;
  status: UsageRequestStatus;
  start_time: string;
  end_time?: string | null;
  duration_ms?: number | null;
  time_to_first_token?: number | null;
  call_kind?: string | null;
  output_tokens_per_second?: number | null;
  input_tokens: number;
  cache_read_tokens: number;
  output_tokens: number;
  total_tokens: number;
  request_preview?: string | null;
  response_preview?: string | null;
  error_message?: string | null;
  metadata?: Record<string, unknown>;
}

export interface UsageRequestListResponse {
  list: UsageRequestLog[];
  total: number;
  page: number;
  page_size: number;
}

export interface UsageTraceSummary {
  trace_id: string;
  session_id: string;
  active_session_id?: string | null;
  scene_id: string;
  scene_name?: string | null;
  user_id: string;
  turn_index: number;
  status: string;
  start_time: string;
  end_time?: string | null;
  duration_ms?: number | null;
  total_input_tokens: number;
  total_cache_read_tokens: number;
  total_output_tokens: number;
  total_tokens: number;
  user_message_preview?: string | null;
}

export interface UsageEventSummary {
  id: number;
  event_type: string;
  source: string;
  occurred_at: string;
  sequence_no?: number | null;
  run_id?: string | null;
  turn_index?: number | null;
  payload_summary: string;
}

export interface UsageRequestDetail {
  request: UsageRequestLog;
  trace: UsageTraceSummary | null;
  events: UsageEventSummary[];
}

export const AGENT_CHAT_ACTIONS = [
  "session_created",
  "bind_ok",
  "unbind_ok",
  "stream",
  "a2ui_stream_start",
  "a2ui_stream_chunk",
  "a2ui_stream_finish",
  "a2ui_created",
  "waiting_input",
  "a2ui_submit_ack",
  "a2ui_cancel_ack",
  "a2ui_resume",
  "a2ui_waiting_input",
  "system_message",
  "completed",
  "cancelled",
  "tool_start",
  "tool_progress",
  "tool_end",
  "turn_started",
  "approval_requested",
  "approval_resolved",
  "subagent_start",
  "subagent_end",
  "subagent_error",
  "error",
  "pong",
  "status",
  "session_closed",
  "session_title_updated",
  "task_result",
  "task_updated",
  "task_deleted",
  "task_run_started",
  "task_run_finished",
  "thread_task_status",
  "reasoning",
  "middleware_progress",
  "workspaceSkillsChanged",
  "command_terminated",
  "mcp_server_status_changed",
  "mcp_runtime_snapshot_created",
  "mcp_tool_policy_changed",
  "mcp_elicitation_requested",
  "mcp_elicitation_resolved",
  "mcp_oauth_required",
] as const;

export type AgentChatAction = (typeof AGENT_CHAT_ACTIONS)[number];

export const AGENT_REPLAY_ACTIONS = [
  "user_message",
  "system_message",
  "ai_message",
  "a2ui_created",
  "waiting_input",
  "stream_batch",
  "tool_start",
  "tool_end",
  "turn_started",
  "approval_requested",
  "approval_resolved",
  "subagent_start",
  "subagent_end",
  "subagent_error",
  "memory_recalled",
  "completed",
  "cancelled",
  "error",
  "scheduled_task_result",
  "task_updated",
  "task_deleted",
  "task_run_started",
  "task_run_finished",
  "thread_task_status",
  "reasoning",
  "middleware_progress",
  "mcp_server_status_changed",
  "mcp_runtime_snapshot_created",
  "mcp_tool_policy_changed",
  "mcp_elicitation_requested",
  "mcp_elicitation_resolved",
  "mcp_oauth_required",
] as const;

export type AgentReplayAction = (typeof AGENT_REPLAY_ACTIONS)[number];

export const AGENT_COMPLETED_EVENT_ITEM_ACTIONS = [
  "ai_message",
  "tool_start",
  "tool_end",
  "stream",
  "reasoning_message",
] as const;

export type AgentCompletedEventItemAction = (typeof AGENT_COMPLETED_EVENT_ITEM_ACTIONS)[number];

export const AGENT_INBOUND_ACTIONS = [
  "create_session",
  "bind_session",
  "unbind_session",
  "chat",
  "a2ui_submit",
  "a2ui_cancel",
  "scheduled_chat",
  "close_session",
  "cancel",
  "approval_decision",
  "ping",
  "get_status",
  "terminate_command",
  "mcp_elicitation_resolved",
] as const;

export type AgentInboundAction = (typeof AGENT_INBOUND_ACTIONS)[number];

export type AgentSessionType = "chat" | "workspace";
export type AgentSessionStatus = "active" | "running" | "waiting_approval" | "waiting_input" | "closed" | "failed";
export type AgentChatRole =
  | "user"
  | "assistant"
  | "tool"
  | "system"
  | "subagent"
  | "reasoning"
  | "approval"
  | "mcp_elicitation"
  | "a2ui"
  | "error"
  | "turn"
  | "thread_task";
export type AgentToolStatus = "running" | "completed" | "error" | "cancelled";
export type AgentReasoningKind = "initial_response" | "status_update" | "progress_fact" | (string & {});
export type ThreadTaskType = "goal" | (string & {});
export type ThreadTaskStatus = "active" | "paused" | "blocked" | "complete" | "system_stopped" | "cancelled";
export type ThreadTaskUserStatus = Extract<ThreadTaskStatus, "active" | "paused" | "cancelled">;
export type ThreadTaskRunStatus = "running" | "succeeded" | "failed" | "skipped" | "cancelled";

export interface Workspace {
  id: string;
  name: string;
  root_path: string;
  normalized_root_path: string;
  type: string;
  created_at: string;
  updated_at: string;
  last_opened_at: string | null;
  is_deleted: boolean;
}

export interface AgentSession {
  id: string;
  user_id: string;
  scene_id: string;
  status: AgentSessionStatus;
  title: string | null;
  title_source?: "auto_candidate" | "auto" | "manual" | null;
  session_tag: string;
  session_type: AgentSessionType;
  workspace_id: string | null;
  cwd: string | null;
  workspace_roots: string[];
  workspace: Workspace | null;
  current_model_provider_id: string | null;
  current_model: string | null;
  context_window_usage?: AgentMiddlewareProgressData | null;
  context_compression_epoch?: number;
  pinned?: boolean;
  pinned_at?: string | null;
  active_session_id: string | null;
  parent_session_id: string | null;
  child_session_id: string | null;
  source_trace_id: string | null;
  source_active_session_id?: string | null;
  source_checkpoint_id?: string | null;
  source_checkpoint_ns?: string | null;
  fork_source?: AgentSessionFork | null;
  created_at: string;
  updated_at: string;
  is_debug: boolean;
  is_scheduled: boolean;
  is_current: boolean;
  scene_version_seq?: number | null;
}

export interface ThreadTask {
  id: string;
  session_id: string;
  type: ThreadTaskType;
  type_label: string;
  title: string | null;
  objective: string;
  status: ThreadTaskStatus;
  metadata: Record<string, unknown>;
  evidence: unknown[];
  blocked_audit: Record<string, unknown>;
  system_stop_reason: string | null;
  current_run_id: string | null;
  turn_count: number;
  elapsed_seconds: number;
  token_usage: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  is_open: boolean;
  is_terminal: boolean;
}

export interface ThreadTaskRun {
  id: string;
  task_id: string;
  session_id: string;
  turn_index: number | null;
  trace_id: string | null;
  status: ThreadTaskRunStatus;
  summary: Record<string, unknown>;
  error: Record<string, unknown>;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
  is_running: boolean;
}

export interface ThreadTaskResponse {
  task: ThreadTask;
}

export interface ThreadTaskListResponse {
  list: ThreadTask[];
}

export interface ThreadTaskRunsResponse {
  list: ThreadTaskRun[];
}

export interface ThreadTaskEventData {
  session_id: string;
  task_id: string;
  task?: ThreadTask | null;
  run_id?: string | null;
  trace_id?: string | null;
  turn_index?: number | null;
}

export interface ThreadTaskRunEventData extends ThreadTaskEventData {
  run_id: string;
  run: ThreadTaskRun;
  run_status?: ThreadTaskRunStatus;
  status?: ThreadTaskRunStatus;
  reason?: string;
}

export interface AgentSessionFork {
  id: string;
  source_session_id: string;
  target_session_id: string;
  source_message_event_id: string;
  target_message_event_id: string;
  source_turn_index: number;
  target_turn_index: number;
  source_trace_id?: string | null;
  source_active_session_id?: string | null;
  source_checkpoint_id?: string | null;
  source_checkpoint_ns?: string | null;
  relation_type: string;
  created_at: string;
  updated_at: string;
  target_title?: string | null;
  source_title?: string | null;
}

export interface AgentSessionResponse {
  session: AgentSession;
}

export interface ManualContextCompressionResponse {
  success: boolean;
  session_id: string;
  active_session_id: string | null;
  notice_id: string | null;
  reason: string | null;
  context_compression_epoch: number | null;
  compression_message_count: number;
  total_message_count: number;
}

export interface AgentSessionBranchSource {
  session_id: string;
  active_session_id: string;
  checkpoint_id: string | null;
  checkpoint_ns: string;
  trace_id: string | null;
  turn_index: number | null;
  message_event_id: string | null;
  source_type: string;
}

export interface AgentSessionBranchResponse {
  session: AgentSession;
  source: AgentSessionBranchSource;
}

export interface AgentSessionListResponse {
  list: AgentSession[];
  total: number;
  page: number;
  page_size: number;
}

export interface AgentHistoryResponse {
  list: AgentChatMessagePayload[];
  total: number;
  page: number;
  page_size: number;
  session: AgentSession;
  event_total: number;
  turn_indexes: number[];
  next_cursor?: string | null;
  prev_cursor?: string | null;
  has_more_older?: boolean;
}

export interface AgentToolDetailRef {
  startEventId?: string | null;
  endEventId?: string | null;
  runId?: string | null;
  toolCallId?: string | null;
}

export interface AgentToolDetails {
  detailRef?: AgentToolDetailRef;
  runId?: string;
  toolCallId?: string | null;
  toolName?: string;
  toolParams?: unknown;
  toolResult?: string;
  toolDurationMs?: number;
  toolError?: string | null;
  toolErrorType?: string | null;
  status?: AgentToolStatus | "success" | "failed";
  uiPayload?: Record<string, unknown> | null;
  fileChanges?: AgentFileChange[];
  metadata?: Record<string, unknown> | null;
}

export interface AgentToolDetailResponse {
  detail: AgentToolDetails;
}

export interface AgentFileAttachment {
  id?: string;
  attachment_id?: string;
  type?: "image" | "document" | "sandbox" | "file" | (string & {});
  name?: string;
  path?: string;
  url?: string;
  source?: string;
  sandbox_file_id?: string;
  mime_type?: string;
  size?: number;
  [key: string]: unknown;
}

export interface AgentGhostStats {
  traceId: string;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
}

export interface AgentTokenUsage {
  input_tokens?: number;
  cache_read_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

export interface AgentTraceQueryContext {
  trace_id?: string;
  trace_record_id?: string;
  date_prefix?: string;
  start_time?: string;
  end_time?: string;
}

export type A2UIRenderKey = "chart" | "confirm" | "choice" | "form" | (string & {});
export type A2UIMode = "render" | "interactive";
export type A2UIInteractionStatus =
  | "waiting_user_input"
  | "submitted"
  | "cancelled"
  | "missing"
  | (string & {});
export type A2UIResumeStatus =
  | "not_started"
  | "deferred"
  | "started"
  | "succeeded"
  | "failed"
  | (string & {});
export type A2UIStreamStatus =
  | "start"
  | "chunk"
  | "finish"
  | "failed"
  | "started"
  | "streaming"
  | "finished"
  | (string & {});
export type A2UIJsonParseStatus = "empty" | "partial" | "valid" | "invalid" | (string & {});
export type A2UIDebugLifecycleStatus =
  | "idle"
  | "started"
  | "streaming"
  | "finished"
  | "created"
  | "waiting_input"
  | "submitted"
  | "cancelled"
  | "failed";

export interface A2UIResumeSummary {
  status: A2UIResumeStatus;
  started?: boolean;
  resume_group_id?: string | null;
  pending_count?: number;
  error?: string | null;
  reason?: string | null;
}

export interface A2UIInteractionState {
  interaction_id: string;
  status: A2UIInteractionStatus;
  can_submit: boolean;
  submit_request_id?: string | null;
  cancel_request_id?: string | null;
  submit_result?: Record<string, unknown> | null;
  cancel_reason?: string | null;
  resume_status?: A2UIResumeStatus;
  resume_group_id?: string | null;
  pending_count?: number | null;
  resume_error?: string | null;
  error?: string | null;
}

export interface A2UIObject {
  render_key: A2UIRenderKey;
  mode: A2UIMode;
  stream_id: string;
  tool_call_id?: string | null;
  trace_id?: string | null;
  turn_index?: number | null;
  payload: Record<string, unknown>;
  input_schema: Record<string, unknown>;
  submit_schema: Record<string, unknown>;
  interaction?: A2UIInteractionState | null;
  waiting_input?: {
    reason?: string | null;
    checkpoint?: Record<string, unknown>;
  };
}

export interface A2UIStreamFrame {
  status: A2UIStreamStatus;
  chunk_index?: number;
  args_delta?: string;
  args_text_length?: number;
  args_text?: string;
  parsed_payload?: Record<string, unknown> | null;
  json_parse_status?: A2UIJsonParseStatus;
  finish_reason?: string | null;
  error?: string | null;
}

export interface A2UIStreamActionData {
  session_id?: string;
  trace_id?: string | null;
  turn_index?: number | null;
  render_key: A2UIRenderKey;
  mode?: A2UIMode;
  stream_id: string;
  stream_group_id?: string | null;
  tool_call_id?: string | null;
  stream: A2UIStreamFrame;
}

export interface A2UICreatedActionData {
  session_id?: string;
  trace_id?: string | null;
  turn_index?: number | null;
  render_key?: A2UIRenderKey;
  mode?: A2UIMode;
  stream_id?: string;
  stream_group_id?: string | null;
  tool_call_id?: string | null;
  interaction_id?: string;
  interaction?: A2UIInteractionState | null;
  a2ui: A2UIObject;
}

export interface A2UIWaitingInputActionData {
  session_id?: string;
  reason?: string;
  interaction_id: string;
  render_key: A2UIRenderKey;
  stream_id: string;
  stream_group_id?: string | null;
  tool_call_id?: string | null;
  a2ui?: A2UIObject;
  checkpoint?: Record<string, unknown>;
}

export interface A2UIWaitingInputStatusItem extends Partial<A2UIInteractionState> {
  session_id?: string;
  interaction_id: string;
  render_key?: A2UIRenderKey;
  stream_id?: string;
  tool_call_id?: string | null;
}

export interface A2UIAckActionData {
  session_id?: string;
  trace_id?: string | null;
  turn_index?: number | null;
  render_key?: A2UIRenderKey;
  stream_id?: string;
  tool_call_id?: string | null;
  interaction_id: string;
  request_id: string;
  status: A2UIInteractionStatus;
  can_submit?: boolean;
  idempotent?: boolean;
  interaction?: A2UIInteractionState;
  submit_result?: Record<string, unknown>;
  cancel_reason?: string | null;
  resume?: A2UIResumeSummary;
}

export interface A2UIResumeActionData {
  session_id?: string;
  interaction_id?: string;
  resume_status?: A2UIResumeStatus;
  resume_group_id?: string | null;
  pending_count?: number;
  error?: string | null;
  resume_payload?: Record<string, unknown>;
  resume_items?: Array<Record<string, unknown>>;
}

export interface A2UIDebugRawEvent {
  id: string;
  action: string;
  timestamp: number;
  data: Record<string, unknown>;
}

export interface A2UIDebugBlockState {
  id: string;
  status: A2UIDebugLifecycleStatus;
  renderKey?: string;
  mode?: A2UIMode | string;
  streamId?: string;
  streamGroupId?: string | null;
  interactionId?: string;
  toolCallId?: string | null;
  traceId?: string | null;
  turnIndex?: number | null;
  chunkCount: number;
  argsBuffer: string;
  argsTextLength: number;
  latestChunk?: string;
  jsonParseStatus: A2UIJsonParseStatus;
  parsedArgs?: unknown;
  parseError?: string;
  error?: string | null;
  finishReason?: string | null;
  a2ui?: A2UIObject | Record<string, unknown>;
  createdFrame?: Record<string, unknown>;
  payload?: unknown;
  inputSchema?: Record<string, unknown>;
  submitSchema?: Record<string, unknown>;
  interaction?: A2UIInteractionState | Record<string, unknown>;
  rawEvents: A2UIDebugRawEvent[];
  updatedAt: number;
}

export interface A2UISubmitActionPayload {
  action: "a2ui_submit";
  session_id: string;
  interaction_id: string;
  request_id: string;
  submit_result: Record<string, unknown>;
}

export interface A2UICancelActionPayload {
  action: "a2ui_cancel";
  session_id: string;
  interaction_id: string;
  request_id: string;
  cancel_reason?: string | null;
}

export interface AgentToolCall {
  id?: string;
  messageEventId?: string;
  runId: string;
  toolCallId?: string;
  toolDetailRef?: AgentToolDetailRef;
  toolDetailsDeferred?: boolean;
  toolSummary?: Record<string, unknown>;
  parentRunId?: string | null;
  toolName: string;
  toolParams?: unknown;
  toolResult?: string;
  toolDurationMs?: number;
  toolError?: string;
  toolErrorType?: string;
  status: AgentToolStatus;
  uiPayload?: Record<string, unknown>;
  fileChanges?: AgentFileChange[];
  metadata?: Record<string, unknown>;
}

export interface AgentFileChange {
  path: string;
  operation?: string;
  added_lines?: number;
  deleted_lines?: number;
  removed_lines?: number;
  additions?: number;
  deletions?: number;
  diff?: string;
  [key: string]: unknown;
}

export interface AgentSubagentTextItem {
  id: string;
  type: "text";
  content: string;
  timestamp: number;
  streaming?: boolean;
}

export type AgentSubagentToolItem = AgentToolCall & {
  type: "tool";
  id: string;
  timestamp: number;
};

export type AgentSubagentItem = AgentSubagentTextItem | AgentSubagentToolItem;

export interface AgentContextItem {
  id: string;
  type: "file" | "quote" | "slot" | "follow" | string;
  label: string;
  content: string;
  role?: "SystemMessage" | "HumanMessage" | "AIMessage" | string;
  source?: "slot" | "follow" | string;
  path?: string;
  name?: string;
  skill_name?: string;
  skillName?: string;
  description?: string;
  locator?: string;
  fileType?: "file" | "directory" | string;
  timestamp?: number;
  metadata?: Record<string, unknown>;
}

export interface AgentChatMessage {
  id: string;
  sessionId: string;
  messageEventId?: string;
  turnIndex?: number | null;
  role: AgentChatRole;
  content: string;
  contentType?: "a2ui" | string;
  content_type?: "a2ui" | string;
  timestamp: number;
  contextItems?: AgentContextItem[];
  reasoningKind?: AgentReasoningKind;
  attachments?: AgentFileAttachment[];
  ghostStats?: AgentGhostStats;
  traceId?: string;
  traceQueryContext?: AgentTraceQueryContext;
  forkSource?: AgentSessionFork | null;
  runId?: string;
  toolCallId?: string;
  toolDetailRef?: AgentToolDetailRef;
  toolDetailsDeferred?: boolean;
  toolSummary?: Record<string, unknown>;
  toolName?: string;
  toolParams?: unknown;
  toolResult?: string;
  toolDurationMs?: number;
  toolError?: string;
  toolErrorType?: string;
  status?: AgentToolStatus | AgentSessionStatus | ApprovalStatus | "streaming";
  uiPayload?: Record<string, unknown>;
  fileChanges?: AgentFileChange[];
  metadata?: Record<string, unknown>;
  hydratedFromHistory?: boolean;
  a2ui?: A2UIObject | null;
  a2uiDebug?: A2UIDebugBlockState;
  approval?: CommandApprovalRequest;
  subagentName?: string;
  subagentId?: string;
  subagentRunId?: string;
  subagentTask?: string;
  subagentToolCalls?: AgentToolCall[];
  subagentItems?: AgentSubagentItem[];
  streaming?: boolean;
  cancelled?: boolean;
}

export type AgentChatMessagePayload = Partial<Pick<AgentChatMessage, "id" | "sessionId" | "timestamp">> &
  Omit<AgentChatMessage, "id" | "sessionId" | "timestamp">;

export interface AgentActionEnvelope<
  TAction extends AgentChatAction = AgentChatAction,
  TData extends object = Record<string, unknown>,
> {
  action: TAction;
  data: TData;
}

export interface AgentStreamActionData {
  session_id: string;
  content?: string;
  text?: string;
  is_subagent?: boolean;
  subagent_name?: string | null;
  subagent_id?: string | null;
  trace_id?: string;
  trace_record_id?: string;
  turn_index?: number | null;
}

export interface AgentToolEventData {
  session_id?: string;
  run_id: string;
  tool_call_id?: string;
  parent_run_id?: string | null;
  kind?: "mcp_tool" | string;
  server_id?: string;
  server_name?: string | null;
  raw_tool_name?: string;
  model_tool_name?: string;
  snapshot_id?: string;
  approval_mode?: McpApprovalMode | string;
  tool?: string;
  tool_name?: string;
  params?: unknown;
  files?: AgentFileChange[];
  result?: string;
  duration_ms?: number;
  status?: AgentToolStatus | "success" | "failed";
  error?: string | null;
  error_type?: string | null;
  ui_payload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  is_subagent?: boolean;
  subagent_name?: string | null;
  subagent_id?: string | null;
  trace_id?: string;
  trace_record_id?: string;
  turn_index?: number | null;
  node_id?: string;
  input_data?: Record<string, unknown>;
  output_data?: Record<string, unknown>;
}

export interface AgentTurnStartedData {
  session_id: string;
  turn_index: number;
  trace_id?: string | null;
  source?: "user" | "thread_task" | string;
  source_label?: string | null;
  thread_task?: Record<string, unknown> | null;
  runtime_params?: Record<string, unknown>;
  timestamp_ms?: number;
}

export interface AgentThreadTaskStatusData {
  session_id: string;
  turn_index: number;
  trace_id?: string | null;
  task_id?: string | null;
  run_id?: string | null;
  type?: ThreadTaskType;
  status?: ThreadTaskStatus | "complete" | "blocked" | string;
  summary?: string;
  payload?: Record<string, unknown>;
  task?: ThreadTask | Record<string, unknown> | null;
  ui_payload?: Record<string, unknown>;
  timestamp_ms?: number;
}

export interface AgentToolProgressData extends Omit<AgentToolEventData, "duration_ms" | "result"> {
  run_id: string;
  tool_call_id?: string;
  phase?: "streaming" | "completed" | "failed" | string;
  files?: AgentFileChange[];
}

export interface AgentReasoningData {
  session_id: string;
  kind?: AgentReasoningKind;
  content?: string;
  text?: string;
  done?: boolean;
  trace_id?: string;
  turn_index?: number | null;
  cancel_main?: boolean;
}

export interface AgentMiddlewareProgressData {
  session_id?: string;
  active_session_id?: string;
  middleware?: string;
  kind?: string;
  stage?: string;
  attempt?: number;
  retry_index?: number;
  max_retries?: number;
  max_attempts?: number;
  retry_after_ms?: number | null;
  gateway_trace_id?: string;
  error?: string;
  error_type?: string;
  compression_mode?: "context" | "snapshot" | string;
  compression_reason?: "manual" | "automatic" | string;
  notice_id?: string;
  reason?: string | null;
  trace_id?: string | null;
  timestamp_ms?: number;
  snapshot_hook?: string;
  call_phase?: "before" | "after" | string;
  call_status?: "running" | "completed" | "failed" | string;
  token_source?: "estimated" | "usage_metadata" | string;
  token_count?: number;
  usage_token_count?: number | null;
  context_window?: number;
  window_fraction?: number;
  trigger_fraction?: number;
  threshold_fraction?: number;
  threshold_token_count?: number;
  threshold_usage_fraction?: number;
  remaining_to_threshold_tokens?: number;
  compression_available?: boolean;
  total_message_count?: number;
  compression_message_count?: number;
  retain_message_count?: number;
}

export interface AgentCompletedEventItem {
  action: AgentCompletedEventItemAction;
  data: Record<string, unknown>;
}

export interface AgentCompletedPayload {
  session_id: string;
  scene_id?: string;
  user_id?: string;
  trace_id?: string;
  trace_record_id?: string;
  turn_index?: number | null;
  status: "completed" | "cancelled" | "failed";
  events: AgentCompletedEventItem[];
  chain_token_usage?: AgentTokenUsage;
  latest_llm_token_usage?: AgentTokenUsage;
  trace_query_context?: AgentTraceQueryContext;
  final_content?: string;
  reasoning_routed?: boolean;
  scene_name?: string;
  scene_version_seq?: number | null;
  thread_task?: Record<string, unknown>;
  threadTask?: Record<string, unknown>;
  ghost_footer?: {
    trace_id?: string;
    chain_token_usage?: AgentTokenUsage;
    latest_llm_token_usage?: AgentTokenUsage;
    trace_query_context?: AgentTraceQueryContext;
  };
}

export interface AgentErrorData {
  session_id?: string;
  code?: string | number;
  message?: string;
  error?: string;
  details?: Record<string, unknown>;
  trace_id?: string;
  turn_index?: number | null;
  thread_task?: Record<string, unknown>;
  threadTask?: Record<string, unknown>;
}
