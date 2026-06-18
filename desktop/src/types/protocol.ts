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

export interface SettingsResponse {
  model: PublicModelSettings;
}

export interface ModelInfo {
  id: string;
  owned_by?: string | null;
  raw?: Record<string, unknown>;
}

export const AGENT_CHAT_ACTIONS = [
  "session_created",
  "bind_ok",
  "unbind_ok",
  "stream",
  "completed",
  "cancelled",
  "tool_start",
  "tool_end",
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
  "ping",
  "get_status",
] as const;

export type AgentInboundAction = (typeof AGENT_INBOUND_ACTIONS)[number];

export type AgentSessionStatus = "active" | "running" | "closed" | "failed";
export type AgentChatRole = "user" | "assistant" | "tool" | "system" | "subagent" | "reasoning" | "error";
export type AgentToolStatus = "running" | "completed" | "error" | "cancelled";
export type AgentReasoningKind = "initial_response" | "status_update" | "progress_fact" | (string & {});

export interface AgentSession {
  id: string;
  user_id: string;
  scene_id: string;
  status: AgentSessionStatus;
  title: string | null;
  session_tag: string;
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
  parentRunId?: string | null;
  toolName: string;
  toolParams?: unknown;
  toolResult?: string;
  toolDurationMs?: number;
  toolError?: string;
  toolErrorType?: string;
  status: AgentToolStatus;
  uiPayload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
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

export interface AgentChatMessage {
  id: string;
  sessionId: string;
  turnIndex?: number | null;
  role: AgentChatRole;
  content: string;
  timestamp: number;
  reasoningKind?: AgentReasoningKind;
  attachments?: AgentFileAttachment[];
  ghostStats?: AgentGhostStats;
  traceId?: string;
  traceQueryContext?: AgentTraceQueryContext;
  runId?: string;
  toolName?: string;
  toolParams?: unknown;
  toolResult?: string;
  toolDurationMs?: number;
  toolError?: string;
  toolErrorType?: string;
  status?: AgentToolStatus | AgentSessionStatus | "streaming";
  uiPayload?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
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
  parent_run_id?: string | null;
  tool?: string;
  tool_name?: string;
  params?: unknown;
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
