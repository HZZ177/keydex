export type PermissionMode = "read_only" | "workspace_write" | "full_access";
export type ThreadStatus = "idle" | "running" | "waiting_approval" | "failed";
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
export type ApprovalKind = "exec" | "file_change" | "read_external" | "write_external";
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

export type AppFontFamily = "system" | "maple-mono";

export interface AppearanceSettings {
  font_family: AppFontFamily;
}

export interface CommandSettings {
  command_enabled: boolean;
  require_approval_for_untrusted: boolean;
  allow_persistent_trust: boolean;
  default_timeout_seconds: number;
  max_timeout_seconds: number;
  max_output_chars: number;
}

export type TrustedCommandRuleMatchType = "exact" | "prefix";

export interface TrustedCommandRule {
  id: string;
  command_pattern: string;
  normalized_command: string;
  match_type: TrustedCommandRuleMatchType;
  shell: string;
  workspace_root: string;
  cwd_pattern: string;
  enabled: boolean;
  created_from_approval_id?: string | null;
  created_at: string;
  updated_at: string;
  last_used_at?: string | null;
}

export type CommandApprovalDecisionValue = "approved" | "rejected";
export type CommandApprovalTrustScope = "once" | "persistent";

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
  "completed",
  "cancelled",
  "tool_start",
  "tool_progress",
  "tool_end",
  "approval_requested",
  "approval_resolved",
  "subagent_start",
  "subagent_end",
  "subagent_error",
  "error",
  "pong",
  "status",
  "session_closed",
  "task_result",
  "reasoning",
] as const;

export type AgentChatAction = (typeof AGENT_CHAT_ACTIONS)[number];

export const AGENT_REPLAY_ACTIONS = [
  "user_message",
  "system_message",
  "ai_message",
  "stream_batch",
  "tool_start",
  "tool_end",
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
  "reasoning",
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
  "scheduled_chat",
  "close_session",
  "cancel",
  "approval_decision",
  "ping",
  "get_status",
] as const;

export type AgentInboundAction = (typeof AGENT_INBOUND_ACTIONS)[number];

export type AgentSessionType = "chat" | "workspace";
export type AgentSessionStatus = "active" | "running" | "waiting_approval" | "closed" | "failed";
export type AgentChatRole = "user" | "assistant" | "tool" | "system" | "subagent" | "reasoning" | "approval" | "error";
export type AgentToolStatus = "running" | "completed" | "error" | "cancelled";
export type AgentReasoningKind = "initial_response" | "status_update" | "progress_fact" | (string & {});

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
  session_tag: string;
  session_type: AgentSessionType;
  workspace_id: string | null;
  cwd: string | null;
  workspace_roots: string[];
  workspace: Workspace | null;
  active_session_id: string | null;
  parent_session_id: string | null;
  child_session_id: string | null;
  source_trace_id: string | null;
  created_at: string;
  updated_at: string;
  is_debug: boolean;
  is_scheduled: boolean;
  is_current: boolean;
  scene_version_seq?: number | null;
}

export interface AgentSessionResponse {
  session: AgentSession;
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

export interface AgentFileAttachment {
  type?: "image" | "document" | "sandbox" | "file" | (string & {});
  name?: string;
  path?: string;
  url?: string;
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

export interface AgentToolCall {
  id?: string;
  runId: string;
  toolCallId?: string;
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
  fileType?: "file" | "directory" | string;
  timestamp?: number;
  metadata?: Record<string, unknown>;
}

export interface AgentChatMessage {
  id: string;
  sessionId: string;
  turnIndex?: number | null;
  role: AgentChatRole;
  content: string;
  timestamp: number;
  contextItems?: AgentContextItem[];
  reasoningKind?: AgentReasoningKind;
  attachments?: AgentFileAttachment[];
  ghostStats?: AgentGhostStats;
  traceId?: string;
  traceQueryContext?: AgentTraceQueryContext;
  runId?: string;
  toolCallId?: string;
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
}

export interface AgentToolEventData {
  session_id?: string;
  run_id: string;
  tool_call_id?: string;
  parent_run_id?: string | null;
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
  node_id?: string;
  input_data?: Record<string, unknown>;
  output_data?: Record<string, unknown>;
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
  cancel_main?: boolean;
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
  status: "completed" | "cancelled" | "failed";
  events: AgentCompletedEventItem[];
  chain_token_usage?: AgentTokenUsage;
  latest_llm_token_usage?: AgentTokenUsage;
  trace_query_context?: AgentTraceQueryContext;
  final_content?: string;
  reasoning_routed?: boolean;
  scene_name?: string;
  scene_version_seq?: number | null;
  ghost_footer?: {
    trace_id?: string;
    chain_token_usage?: AgentTokenUsage;
    latest_llm_token_usage?: AgentTokenUsage;
    trace_query_context?: AgentTraceQueryContext;
  };
}

export interface AgentErrorData {
  session_id?: string;
  code?: string;
  message?: string;
  error?: string;
  details?: Record<string, unknown>;
  trace_id?: string;
}
