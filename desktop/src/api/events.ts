import type { RuntimeEvent } from "@/types/protocol";

export type EventConnectionStatus = "idle" | "connecting" | "open" | "closed" | "error";

export interface RuntimeEventClientOptions {
  baseUrl?: string;
  WebSocketImpl?: typeof WebSocket;
  onStatus?: (status: EventConnectionStatus) => void;
  onEvent: (event: RuntimeEvent) => void;
  onError?: (error: Event) => void;
}

export class RuntimeEventClient {
  private socket: WebSocket | null = null;
  private readonly WebSocketImpl: typeof WebSocket;
  private readonly baseUrl: string;

  constructor(private readonly options: RuntimeEventClientOptions) {
    this.baseUrl = (options.baseUrl ?? "ws://127.0.0.1:8765").replace(/\/$/, "");
    this.WebSocketImpl = options.WebSocketImpl ?? WebSocket;
  }

  connect(threadId: string, afterSeq = 0): void {
    this.close();
    this.options.onStatus?.("connecting");
    const url = new URL("/agent-base/ws/chat", this.baseUrl);
    url.searchParams.set("session_id", threadId);
    if (afterSeq > 0) {
      url.searchParams.set("after_seq", String(afterSeq));
    }
    this.socket = new this.WebSocketImpl(url.toString());
    this.socket.onopen = () => this.options.onStatus?.("open");
    this.socket.onclose = () => this.options.onStatus?.("closed");
    this.socket.onerror = (event) => {
      this.options.onStatus?.("error");
      this.options.onError?.(event);
    };
    this.socket.onmessage = (event) => {
      this.options.onEvent(JSON.parse(event.data) as RuntimeEvent);
    };
  }

  close(): void {
    if (this.socket && this.socket.readyState < WebSocket.CLOSING) {
      this.socket.close();
    }
    this.socket = null;
  }
}
