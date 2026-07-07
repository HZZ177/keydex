import type {
  AgentContextItem,
  AgentActionEnvelope,
  AgentChatMessagePayload,
  AgentToolDetailRef,
  AgentToolDetailResponse,
  AgentToolDetails,
  CommandApprovalDecisionPayload,
  McpElicitationResolvePayload,
  AgentHistoryResponse,
  AgentSession,
  AgentSessionBranchResponse,
  AgentSessionType,
  AgentSessionListResponse,
  AgentSessionResponse,
  AgentFileAttachment,
  ManualContextCompressionResponse,
  ThreadTask,
  ThreadTaskListResponse,
  ThreadTaskResponse,
  ThreadTaskRun,
  ThreadTaskRunsResponse,
  ThreadTaskType,
  ThreadTaskUserStatus,
} from "@/types/protocol";

import type { HttpClient } from "./httpClient";
import {
  RuntimeWsClient,
  createWsClient,
  toWebSocketBaseUrl,
  type WebSocketConstructor,
  type WsClientOptions,
  type WsConnectionStatus,
} from "./wsClient";

export interface CreateSessionPayload {
  user_id?: string;
  scene_id?: string;
  title?: string | null;
  session_tag?: string;
  session_id?: string | null;
  sessionType?: AgentSessionType;
  workspaceId?: string | null;
  cwd?: string | null;
  workspaceRoots?: string[];
  currentModelProviderId?: string | null;
  currentModel?: string | null;
}

export interface ListSessionsOptions {
  userId?: string;
  sceneId?: string;
  status?: string;
  sessionTag?: string;
  sessionType?: AgentSessionType;
  workspaceId?: string;
  title?: string;
  currentSessionId?: string;
  page?: number;
  pageSize?: number;
}

export interface LoadHistoryOptions {
  turnIndex?: number;
  page?: number;
  pageSize?: number;
  order?: "asc" | "desc";
  cursor?: string | null;
  direction?: "older" | "newer";
  allTurns?: boolean;
}

export type LoadToolDetailsOptions = AgentToolDetailRef;

export interface UpdateSessionPayload {
  title?: string | null;
  pinned?: boolean | null;
  current_model_provider_id?: string | null;
  current_model?: string | null;
}

export interface SessionBranchPayload {
  userId?: string;
  title?: string | null;
  sessionTag?: string | null;
  checkpointId?: string | null;
  checkpointNs?: string | null;
  traceId?: string | null;
  messageEventId?: string | null;
  turnIndex?: number | null;
}

export interface CreateThreadTaskPayload {
  type?: Extract<ThreadTaskType, "goal">;
  objective: string;
  title?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface UpdateThreadTaskPayload {
  objective?: string | null;
  title?: string | null;
  status?: ThreadTaskUserStatus | null;
  metadata?: Record<string, unknown> | null;
}

export interface ChatPayload {
  session_id?: string;
  message: string;
  user_id?: string;
  scene_id?: string;
  provider_id?: string;
  model?: string;
  system_prompt?: string | null;
  runtime_params?: Record<string, unknown> | null;
  runtimeParams?: Record<string, unknown> | null;
  contextItems?: AgentContextItem[];
  attachments?: AgentFileAttachment[];
  files?: unknown[];
  [key: string]: unknown;
}

export interface ChatChannelOptions {
  sessionId?: string | null;
  onStatus?: (status: WsConnectionStatus) => void;
  onError?: (error: unknown) => void;
}

export interface ChatChannel {
  close(): void;
  getStatus(): WsConnectionStatus;
  getSessionId(): string | null;
  createSession(payload?: CreateSessionPayload): void;
  bindSession(sessionId: string): void;
  unbindSession(sessionId?: string): void;
  chat(payload: ChatPayload): void;
  approvalDecision(approvalId: string, decision: CommandApprovalDecisionPayload): void;
  resolveMcpElicitation?(payload: McpElicitationResolvePayload): void;
  cancel(sessionId?: string): void;
  terminateCommand(sessionId: string, commandId: string): void;
  requestStatus(sessionId?: string): void;
  ping(): void;
}

export interface ConversationRuntimeOptions {
  wsBaseUrl?: string;
  WebSocketImpl?: WebSocketConstructor;
  reconnectDelayMs?: number;
  maxReconnectAttempts?: number;
  wsClientFactory?: (options: WsClientOptions) => RuntimeWsClient;
}

export interface ConversationRuntime {
  listSessions(options?: ListSessionsOptions): Promise<AgentSessionListResponse>;
  createSession(payload?: CreateSessionPayload): Promise<AgentSession>;
  getSession(sessionId: string): Promise<AgentSession>;
  updateSession(sessionId: string, payload: UpdateSessionPayload): Promise<AgentSession>;
  deleteSession(sessionId: string): Promise<void>;
  forkSession(sessionId: string, payload: SessionBranchPayload): Promise<AgentSessionBranchResponse>;
  reverseSession(sessionId: string, payload: SessionBranchPayload): Promise<AgentSessionBranchResponse>;
  compressContext(sessionId: string): Promise<ManualContextCompressionResponse>;
  loadHistory(sessionId: string, options?: LoadHistoryOptions): Promise<AgentHistoryResponse>;
  loadToolDetails(sessionId: string, ref: LoadToolDetailsOptions): Promise<AgentToolDetails>;
  listThreadTasks(sessionId: string): Promise<ThreadTask[]>;
  createThreadTask(sessionId: string, payload: CreateThreadTaskPayload): Promise<ThreadTask>;
  updateThreadTask(sessionId: string, taskId: string, payload: UpdateThreadTaskPayload): Promise<ThreadTask>;
  deleteThreadTask(sessionId: string, taskId: string): Promise<ThreadTask>;
  listThreadTaskRuns(sessionId: string, taskId: string): Promise<ThreadTaskRun[]>;
  openChatChannel(
    onEvent: (event: AgentActionEnvelope) => void,
    options?: ChatChannelOptions,
  ): ChatChannel;
}

export function createConversationRuntime(
  http: HttpClient,
  options: ConversationRuntimeOptions = {},
): ConversationRuntime {
  const wsFactory = options.wsClientFactory ?? createWsClient;

  return {
    listSessions(listOptions = {}) {
      return http.request<AgentSessionListResponse>(`/api/sessions${sessionListQuery(listOptions)}`);
    },
    createSession(payload = {}) {
      return http
        .request<AgentSessionResponse>("/api/sessions", {
          method: "POST",
          body: snakeSessionPayload(payload),
        })
        .then((response) => response.session);
    },
    getSession(sessionId) {
      return http
        .request<AgentSessionResponse>(`/api/sessions/${encodeURIComponent(sessionId)}`)
        .then((response) => response.session);
    },
    updateSession(sessionId, payload) {
      return http
        .request<AgentSessionResponse>(`/api/sessions/${encodeURIComponent(sessionId)}`, {
          method: "PATCH",
          body: payload,
        })
        .then((response) => response.session);
    },
    deleteSession(sessionId) {
      return http.request<void>(`/api/sessions/${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
      });
    },
    forkSession(sessionId, payload) {
      return http.request<AgentSessionBranchResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/fork`, {
        method: "POST",
        body: branchPayload(payload),
      });
    },
    reverseSession(sessionId, payload) {
      return http.request<AgentSessionBranchResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/reverse`, {
        method: "POST",
        body: branchPayload(payload),
      });
    },
    compressContext(sessionId) {
      return http.request<ManualContextCompressionResponse>(
        `/api/sessions/${encodeURIComponent(sessionId)}/context-compression`,
        {
          method: "POST",
          body: {},
        },
      );
    },
    loadHistory(sessionId, historyOptions = {}) {
      return http.request<AgentHistoryResponse>(
        `/api/sessions/${encodeURIComponent(sessionId)}/history${historyQuery(historyOptions)}`,
      );
    },
    loadToolDetails(sessionId, ref) {
      return http
        .request<AgentToolDetailResponse>(
          `/api/sessions/${encodeURIComponent(sessionId)}/tool-details${toolDetailsQuery(ref)}`,
        )
        .then((response) => response.detail);
    },
    listThreadTasks(sessionId) {
      return http
        .request<ThreadTaskListResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/tasks`)
        .then((response) => response.list);
    },
    createThreadTask(sessionId, payload) {
      return http
        .request<ThreadTaskResponse>(`/api/sessions/${encodeURIComponent(sessionId)}/tasks`, {
          method: "POST",
          body: threadTaskCreatePayload(payload),
        })
        .then((response) => response.task);
    },
    updateThreadTask(sessionId, taskId, payload) {
      return http
        .request<ThreadTaskResponse>(
          `/api/sessions/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent(taskId)}`,
          {
            method: "PATCH",
            body: threadTaskUpdatePayload(payload),
          },
        )
        .then((response) => response.task);
    },
    deleteThreadTask(sessionId, taskId) {
      return http
        .request<ThreadTaskResponse>(
          `/api/sessions/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent(taskId)}`,
          {
            method: "DELETE",
          },
        )
        .then((response) => response.task);
    },
    listThreadTaskRuns(sessionId, taskId) {
      return http
        .request<ThreadTaskRunsResponse>(
          `/api/sessions/${encodeURIComponent(sessionId)}/tasks/${encodeURIComponent(taskId)}/runs`,
        )
        .then((response) => response.list);
    },
    openChatChannel(onEvent, channelOptions = {}) {
      const client = wsFactory({
        baseUrl: options.wsBaseUrl ?? toWebSocketBaseUrl(http.getBaseUrl()),
        WebSocketImpl: options.WebSocketImpl,
        reconnectDelayMs: options.reconnectDelayMs,
        maxReconnectAttempts: options.maxReconnectAttempts,
        onEvent,
        onStatus: channelOptions.onStatus,
        onError: channelOptions.onError,
      });
      client.connect(channelOptions.sessionId);
      return {
        close: () => client.close(),
        getStatus: () => client.getStatus(),
        getSessionId: () => client.getSessionId(),
        createSession: (payload = {}) => client.createSession(snakeSessionPayload(payload)),
        bindSession: (sessionId) => client.bindSession(sessionId),
        unbindSession: (sessionId) => client.unbindSession(sessionId),
        chat: (payload) => client.chat(payload),
        approvalDecision: (approvalId, decision) =>
          client.sendAction("approval_decision", {
            approval_id: approvalId,
            ...decision,
          }),
        resolveMcpElicitation: (payload) =>
          client.sendAction("mcp_elicitation_resolved", { ...payload }),
        cancel: (sessionId) => client.cancel(sessionId),
        terminateCommand: (sessionId, commandId) =>
          client.sendAction("terminate_command", {
            session_id: sessionId,
            command_id: commandId,
          }),
        requestStatus: (sessionId) => client.requestStatus(sessionId),
        ping: () => client.ping(),
      };
    },
  };
}

export function normalizeHistoryMessages(response: AgentHistoryResponse): AgentChatMessagePayload[] {
  return response.list;
}

function sessionListQuery(options: ListSessionsOptions) {
  const params = new URLSearchParams();
  appendParam(params, "user_id", options.userId);
  appendParam(params, "scene_id", options.sceneId);
  appendParam(params, "status", options.status);
  appendParam(params, "session_tag", options.sessionTag);
  appendParam(params, "session_type", options.sessionType);
  appendParam(params, "workspace_id", options.workspaceId);
  appendParam(params, "title", options.title);
  appendParam(params, "current_session_id", options.currentSessionId);
  appendParam(params, "page", options.page);
  appendParam(params, "page_size", options.pageSize);
  const query = params.toString();
  return query ? `?${query}` : "";
}

function historyQuery(options: LoadHistoryOptions) {
  const params = new URLSearchParams();
  appendParam(params, "turn_index", options.turnIndex);
  appendParam(params, "page", options.page);
  appendParam(params, "page_size", options.pageSize);
  appendParam(params, "order", options.order);
  appendParam(params, "cursor", options.cursor);
  appendParam(params, "direction", options.direction);
  appendParam(params, "all_turns", options.allTurns ? "true" : undefined);
  const query = params.toString();
  return query ? `?${query}` : "";
}

function toolDetailsQuery(ref: LoadToolDetailsOptions) {
  const params = new URLSearchParams();
  appendParam(params, "start_event_id", ref.startEventId);
  appendParam(params, "end_event_id", ref.endEventId);
  const query = params.toString();
  return query ? `?${query}` : "";
}

function appendParam(params: URLSearchParams, key: string, value: string | number | undefined | null) {
  if (value === undefined || value === null || value === "") {
    return;
  }
  params.set(key, String(value));
}

function snakeSessionPayload(payload: CreateSessionPayload): Record<string, unknown> {
  return {
    ...(payload.user_id !== undefined ? { user_id: payload.user_id } : {}),
    ...(payload.scene_id !== undefined ? { scene_id: payload.scene_id } : {}),
    ...(payload.title !== undefined ? { title: payload.title } : {}),
    ...(payload.session_tag !== undefined ? { session_tag: payload.session_tag } : {}),
    ...(payload.session_id !== undefined ? { session_id: payload.session_id } : {}),
    ...(payload.sessionType !== undefined ? { session_type: payload.sessionType } : {}),
    ...(payload.workspaceId !== undefined ? { workspace_id: payload.workspaceId } : {}),
    ...(payload.cwd !== undefined ? { cwd: payload.cwd } : {}),
    ...(payload.workspaceRoots !== undefined ? { workspace_roots: payload.workspaceRoots } : {}),
    ...(payload.currentModelProviderId !== undefined ? { current_model_provider_id: payload.currentModelProviderId } : {}),
    ...(payload.currentModel !== undefined ? { current_model: payload.currentModel } : {}),
  };
}

function branchPayload(payload: SessionBranchPayload): Record<string, unknown> {
  return {
    ...(payload.userId !== undefined ? { user_id: payload.userId } : {}),
    ...(payload.title !== undefined ? { title: payload.title } : {}),
    ...(payload.sessionTag !== undefined ? { session_tag: payload.sessionTag } : {}),
    ...(payload.checkpointId !== undefined ? { checkpoint_id: payload.checkpointId } : {}),
    ...(payload.checkpointNs !== undefined ? { checkpoint_ns: payload.checkpointNs } : {}),
    ...(payload.traceId !== undefined ? { trace_id: payload.traceId } : {}),
    ...(payload.messageEventId !== undefined ? { message_event_id: payload.messageEventId } : {}),
    ...(payload.turnIndex !== undefined ? { turn_index: payload.turnIndex } : {}),
  };
}

function threadTaskCreatePayload(payload: CreateThreadTaskPayload): Record<string, unknown> {
  return {
    type: payload.type ?? "goal",
    objective: payload.objective,
    ...(payload.title !== undefined ? { title: payload.title } : {}),
    ...(payload.metadata !== undefined ? { metadata: payload.metadata } : {}),
  };
}

function threadTaskUpdatePayload(payload: UpdateThreadTaskPayload): Record<string, unknown> {
  return {
    ...(payload.objective !== undefined ? { objective: payload.objective } : {}),
    ...(payload.title !== undefined ? { title: payload.title } : {}),
    ...(payload.status !== undefined ? { status: payload.status } : {}),
    ...(payload.metadata !== undefined ? { metadata: payload.metadata } : {}),
  };
}
