import type {
  AgentContextItem,
  AgentActionEnvelope,
  AgentChatMessagePayload,
  CommandApprovalDecisionPayload,
  AgentHistoryResponse,
  AgentSession,
  AgentSessionType,
  AgentSessionListResponse,
  AgentSessionResponse,
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
}

export interface UpdateSessionPayload {
  title?: string | null;
}

export interface ChatPayload {
  session_id?: string;
  message: string;
  user_id?: string;
  scene_id?: string;
  model?: string;
  system_prompt?: string | null;
  runtime_params?: Record<string, unknown> | null;
  runtimeParams?: Record<string, unknown> | null;
  contextItems?: AgentContextItem[];
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
  cancel(sessionId?: string): void;
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
  loadHistory(sessionId: string, options?: LoadHistoryOptions): Promise<AgentHistoryResponse>;
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
    loadHistory(sessionId, historyOptions = {}) {
      return http.request<AgentHistoryResponse>(
        `/api/sessions/${encodeURIComponent(sessionId)}/history${historyQuery(historyOptions)}`,
      );
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
        cancel: (sessionId) => client.cancel(sessionId),
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
  };
}
