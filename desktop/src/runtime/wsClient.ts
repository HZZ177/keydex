import type {
  AgentActionEnvelope,
  AgentChatAction,
  AgentInboundAction,
} from "@/types/protocol";

export type WsConnectionStatus = "idle" | "connecting" | "open" | "reconnecting" | "closed" | "error";

export interface WebSocketLike {
  readyState: number;
  onopen: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  send(data: string): void;
  close(): void;
}

export type WebSocketConstructor = new (url: string) => WebSocketLike;

export interface WsClientOptions {
  baseUrl?: string;
  WebSocketImpl?: WebSocketConstructor;
  reconnectDelayMs?: number;
  maxReconnectAttempts?: number;
  onStatus?: (status: WsConnectionStatus) => void;
  onEvent: (event: AgentActionEnvelope) => void;
  onError?: (error: unknown) => void;
}

const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;

export class RuntimeWsClient {
  private socket: WebSocketLike | null = null;
  private sessionId: string | null = null;
  private status: WsConnectionStatus = "idle";
  private reconnectAttempts = 0;
  private closedByClient = false;
  private readonly baseUrl: string;
  private readonly WebSocketImpl: WebSocketConstructor;
  private readonly reconnectDelayMs: number;
  private readonly maxReconnectAttempts: number;

  constructor(private readonly options: WsClientOptions) {
    this.baseUrl = (options.baseUrl ?? "ws://127.0.0.1:8765").replace(/\/$/, "");
    this.WebSocketImpl = options.WebSocketImpl ?? WebSocket;
    this.reconnectDelayMs = options.reconnectDelayMs ?? 500;
    this.maxReconnectAttempts = options.maxReconnectAttempts ?? 10;
  }

  connect(sessionId?: string | null) {
    this.closeSocket();
    this.sessionId = sessionId?.trim() || null;
    this.reconnectAttempts = 0;
    this.closedByClient = false;
    this.openSocket("connecting");
  }

  close() {
    this.closedByClient = true;
    this.closeSocket();
    this.setStatus("closed");
  }

  getStatus() {
    return this.status;
  }

  getSessionId() {
    return this.sessionId;
  }

  sendAction<TData extends Record<string, unknown> = Record<string, unknown>>(
    action: AgentInboundAction,
    data: TData = {} as TData,
  ) {
    const socket = this.socket;
    if (!socket || socket.readyState !== SOCKET_OPEN) {
      throw new Error("WebSocket 未连接");
    }
    socket.send(JSON.stringify({ action, data }));
  }

  createSession(data: Record<string, unknown> = {}) {
    this.sendAction("create_session", data);
  }

  bindSession(sessionId = this.sessionId) {
    if (!sessionId) {
      throw new Error("session_id 必填");
    }
    this.sessionId = sessionId;
    this.sendAction("bind_session", { session_id: sessionId });
  }

  unbindSession(sessionId = this.sessionId) {
    this.sendAction("unbind_session", sessionId ? { session_id: sessionId } : {});
    if (!sessionId || sessionId === this.sessionId) {
      this.sessionId = null;
    }
  }

  chat(data: Record<string, unknown>) {
    this.sendAction("chat", this.withSession(data));
  }

  cancel(sessionId = this.sessionId) {
    this.sendAction("cancel", sessionId ? { session_id: sessionId } : {});
  }

  ping() {
    this.sendAction("ping");
  }

  private openSocket(status: WsConnectionStatus) {
    this.setStatus(status);
    const socket = new this.WebSocketImpl(buildWsUrl(this.baseUrl, this.sessionId));
    this.socket = socket;

    socket.onopen = () => {
      this.reconnectAttempts = 0;
      this.setStatus("open");
      if (this.sessionId) {
        this.sendAction("bind_session", { session_id: this.sessionId });
      }
    };
    socket.onerror = (event) => {
      this.setStatus("error");
      this.options.onError?.(event);
    };
    socket.onmessage = (event) => this.handleMessage(event.data);
    socket.onclose = () => {
      if (this.closedByClient) {
        this.setStatus("closed");
        return;
      }
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.setStatus("closed");
      return;
    }

    this.reconnectAttempts += 1;
    this.setStatus("reconnecting");
    window.setTimeout(() => {
      if (!this.closedByClient) {
        this.openSocket("reconnecting");
      }
    }, this.reconnectDelayMs);
  }

  private handleMessage(data: string) {
    let event: AgentActionEnvelope;
    try {
      event = JSON.parse(data) as AgentActionEnvelope;
    } catch (error) {
      this.setStatus("error");
      this.options.onError?.(error);
      return;
    }

    if (!isAgentEnvelope(event)) {
      this.setStatus("error");
      this.options.onError?.(new Error("WebSocket 消息缺少 action/data"));
      return;
    }

    this.rememberSessionFromEvent(event);
    this.options.onEvent(event);
  }

  private rememberSessionFromEvent(event: AgentActionEnvelope) {
    const data = event.data;
    const sessionId =
      typeof data.session_id === "string"
        ? data.session_id
        : typeof data.session === "object" &&
            data.session !== null &&
            typeof (data.session as { id?: unknown }).id === "string"
          ? (data.session as { id: string }).id
          : "";
    if (event.action === "session_created" && sessionId) {
      this.sessionId = sessionId;
    }
  }

  private withSession(data: Record<string, unknown>) {
    if (!this.sessionId || data.session_id) {
      return data;
    }
    return { ...data, session_id: this.sessionId };
  }

  private closeSocket() {
    const socket = this.socket;
    this.socket = null;
    if (socket && (socket.readyState === SOCKET_CONNECTING || socket.readyState === SOCKET_OPEN)) {
      socket.close();
    }
  }

  private setStatus(status: WsConnectionStatus) {
    this.status = status;
    this.options.onStatus?.(status);
  }
}

export function createWsClient(options: WsClientOptions) {
  return new RuntimeWsClient(options);
}

export function buildWsUrl(baseUrl: string, sessionId?: string | null) {
  const url = new URL("/agent-base/ws/chat", baseUrl.replace(/\/$/, ""));
  if (sessionId) {
    url.searchParams.set("session_id", sessionId);
  }
  return url.toString();
}

export function toWebSocketBaseUrl(httpBaseUrl: string) {
  const url = new URL(httpBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString().replace(/\/$/, "");
}

function isAgentEnvelope(value: unknown): value is AgentActionEnvelope<AgentChatAction> {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as { action?: unknown }).action === "string" &&
    Boolean((value as { action?: string }).action) &&
    typeof (value as { data?: unknown }).data === "object" &&
    (value as { data?: unknown }).data !== null
  );
}
