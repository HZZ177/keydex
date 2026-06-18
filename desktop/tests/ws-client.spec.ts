import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentActionEnvelope } from "@/types/protocol";
import { RuntimeWsClient, buildWsUrl, toWebSocketBaseUrl } from "@/runtime/wsClient";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  readyState = 0;
  sent: string[] = [];
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  open() {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }

  serverClose() {
    this.readyState = 3;
    this.onclose?.(new CloseEvent("close"));
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
    this.onclose?.(new CloseEvent("close"));
  }

  message(event: AgentActionEnvelope | string) {
    const data = typeof event === "string" ? event : JSON.stringify(event);
    this.onmessage?.({ data } as MessageEvent<string>);
  }
}

afterEach(() => {
  FakeWebSocket.instances = [];
  vi.useRealTimers();
});

describe("RuntimeWsClient", () => {
  it("builds backend websocket urls", () => {
    expect(buildWsUrl("ws://127.0.0.1:8765", "ses 1")).toBe(
      "ws://127.0.0.1:8765/agent-base/ws/chat?session_id=ses+1",
    );
    expect(buildWsUrl("ws://127.0.0.1:8765")).toBe("ws://127.0.0.1:8765/agent-base/ws/chat");
    expect(toWebSocketBaseUrl("https://agent.example")).toBe("wss://agent.example");
  });

  it("connects, binds an existing session and receives action envelopes", () => {
    const onEvent = vi.fn();
    const onStatus = vi.fn();
    const client = new RuntimeWsClient({
      baseUrl: "ws://127.0.0.1:8765",
      WebSocketImpl: FakeWebSocket,
      onEvent,
      onStatus,
    });

    client.connect("ses-1");
    const socket = FakeWebSocket.instances[0];
    socket.open();
    socket.message({ action: "stream", data: { session_id: "ses-1", content: "你" } });

    expect(socket.url).toBe("ws://127.0.0.1:8765/agent-base/ws/chat?session_id=ses-1");
    expect(JSON.parse(socket.sent[0])).toEqual({
      action: "bind_session",
      data: { session_id: "ses-1" },
    });
    expect(onStatus).toHaveBeenCalledWith("connecting");
    expect(onStatus).toHaveBeenCalledWith("open");
    expect(onEvent).toHaveBeenCalledWith({
      action: "stream",
      data: { session_id: "ses-1", content: "你" },
    });
  });

  it("sends create, chat, cancel and ping actions", () => {
    const client = new RuntimeWsClient({
      baseUrl: "ws://127.0.0.1:8765",
      WebSocketImpl: FakeWebSocket,
      onEvent: vi.fn(),
    });

    client.connect();
    const socket = FakeWebSocket.instances[0];
    socket.open();
    client.createSession({ title: "新会话" });
    socket.message({ action: "session_created", data: { session_id: "ses-2" } });
    client.chat({ message: "你好" });
    client.cancel();
    client.ping();

    expect(socket.sent.map((item) => JSON.parse(item))).toEqual([
      { action: "create_session", data: { title: "新会话" } },
      { action: "chat", data: { message: "你好", session_id: "ses-2" } },
      { action: "cancel", data: { session_id: "ses-2" } },
      { action: "ping", data: {} },
    ]);
  });

  it("reconnects and rebinds the current session after unexpected close", () => {
    vi.useFakeTimers();
    const client = new RuntimeWsClient({
      baseUrl: "ws://127.0.0.1:8765",
      WebSocketImpl: FakeWebSocket,
      reconnectDelayMs: 25,
      onEvent: vi.fn(),
    });

    client.connect("ses-1");
    FakeWebSocket.instances[0].open();
    FakeWebSocket.instances[0].serverClose();
    vi.advanceTimersByTime(25);
    FakeWebSocket.instances[1].open();

    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[1].url).toBe(
      "ws://127.0.0.1:8765/agent-base/ws/chat?session_id=ses-1",
    );
    expect(JSON.parse(FakeWebSocket.instances[1].sent[0])).toEqual({
      action: "bind_session",
      data: { session_id: "ses-1" },
    });
  });

  it("surfaces malformed websocket messages", () => {
    const onError = vi.fn();
    const onStatus = vi.fn();
    const client = new RuntimeWsClient({
      WebSocketImpl: FakeWebSocket,
      onEvent: vi.fn(),
      onStatus,
      onError,
    });

    client.connect("ses-1");
    FakeWebSocket.instances[0].message("{not-json");

    expect(onStatus).toHaveBeenCalledWith("error");
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
