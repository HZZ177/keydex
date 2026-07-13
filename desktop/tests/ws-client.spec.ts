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
    client.requestStatus();
    client.ping();

    expect(socket.sent.map((item) => JSON.parse(item))).toEqual([
      { action: "create_session", data: { title: "新会话" } },
      { action: "chat", data: { message: "你好", session_id: "ses-2" } },
      { action: "cancel", data: { session_id: "ses-2" } },
      { action: "get_status", data: { session_id: "ses-2" } },
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

  it("parses typed workspace and local file watch events", () => {
    const onEvent = vi.fn();
    const onError = vi.fn();
    const client = new RuntimeWsClient({
      baseUrl: "ws://127.0.0.1:8765",
      WebSocketImpl: FakeWebSocket,
      onEvent,
      onError,
    });
    client.connect();
    const socket = FakeWebSocket.instances[0];
    socket.open();

    socket.message({
      action: "workspaceWatchBound",
      data: { workspace_id: "ws-1", sequence: 0, resync_required: true },
    });
    socket.message({
      action: "workspaceFilesChanged",
      data: {
        workspace_id: "ws-1",
        sequence: 1,
        resync_required: false,
        changes: [{ kind: "modified", path: "src/main.ts" }],
      },
    });
    socket.message({ action: "workspaceWatchUnbound", data: { workspace_id: "ws-1" } });
    socket.message({
      action: "localFileWatchBound",
      data: { watch_id: "local-1", path: "D:/tmp/a.md", sequence: 0, resync_required: true },
    });
    socket.message({
      action: "localFileChanged",
      data: {
        watch_id: "local-1",
        path: "D:/tmp/a.md",
        sequence: 1,
        resync_required: false,
        changes: [{ kind: "deleted", path: "D:/tmp/a.md" }],
      },
    });
    socket.message({ action: "localFileWatchUnbound", data: { watch_id: "local-1" } });
    socket.message(
      JSON.stringify({
        action: "workspaceFilesChanged",
        data: {
          workspace_id: "ws-1",
          sequence: 2,
          resync_required: false,
          changes: [{ kind: "renamed", path: "bad" }],
        },
      }),
    );

    expect(onEvent).toHaveBeenCalledTimes(6);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("sends workspace watch bind after socket opens", () => {
    const client = new RuntimeWsClient({
      baseUrl: "ws://127.0.0.1:8765",
      WebSocketImpl: FakeWebSocket,
      onEvent: vi.fn(),
    });

    client.bindWorkspaceWatch("ws-1");
    client.connect();
    FakeWebSocket.instances[0].open();

    expect(FakeWebSocket.instances[0].sent.map((item) => JSON.parse(item))).toEqual([
      { action: "bind_workspace_watch", data: { workspace_id: "ws-1" } },
    ]);
  });

  it("rebinds desired workspace watches after reconnect", () => {
    vi.useFakeTimers();
    const client = new RuntimeWsClient({
      baseUrl: "ws://127.0.0.1:8765",
      WebSocketImpl: FakeWebSocket,
      reconnectDelayMs: 10,
      onEvent: vi.fn(),
    });
    client.bindWorkspaceWatch("ws-1");
    client.connect();
    FakeWebSocket.instances[0].open();
    FakeWebSocket.instances[0].serverClose();
    vi.advanceTimersByTime(10);
    FakeWebSocket.instances[1].open();

    expect(FakeWebSocket.instances[1].sent.map((item) => JSON.parse(item))).toEqual([
      { action: "bind_workspace_watch", data: { workspace_id: "ws-1" } },
    ]);
  });

  it("does not rebind workspace watch after explicit unbind", () => {
    vi.useFakeTimers();
    const client = new RuntimeWsClient({
      baseUrl: "ws://127.0.0.1:8765",
      WebSocketImpl: FakeWebSocket,
      reconnectDelayMs: 10,
      onEvent: vi.fn(),
    });
    client.bindWorkspaceWatch("ws-1");
    client.connect();
    FakeWebSocket.instances[0].open();
    client.unbindWorkspaceWatch("ws-1");
    FakeWebSocket.instances[0].serverClose();
    vi.advanceTimersByTime(10);
    FakeWebSocket.instances[1].open();

    expect(FakeWebSocket.instances[0].sent.map((item) => JSON.parse(item))).toContainEqual({
      action: "unbind_workspace_watch",
      data: { workspace_id: "ws-1" },
    });
    expect(FakeWebSocket.instances[1].sent).toEqual([]);
  });

  it("rebinds desired local file watches after reconnect", () => {
    vi.useFakeTimers();
    const client = new RuntimeWsClient({
      baseUrl: "ws://127.0.0.1:8765",
      WebSocketImpl: FakeWebSocket,
      reconnectDelayMs: 10,
      onEvent: vi.fn(),
    });
    client.bindLocalFileWatch("local-1", "D:/tmp/a.md");
    client.connect();
    FakeWebSocket.instances[0].open();
    FakeWebSocket.instances[0].serverClose();
    vi.advanceTimersByTime(10);
    FakeWebSocket.instances[1].open();

    expect(FakeWebSocket.instances[1].sent.map((item) => JSON.parse(item))).toEqual([
      {
        action: "bind_local_file_watch",
        data: { watch_id: "local-1", path: "D:/tmp/a.md" },
      },
    ]);
  });

  it("does not rebind local file watch after explicit unbind", () => {
    vi.useFakeTimers();
    const client = new RuntimeWsClient({
      baseUrl: "ws://127.0.0.1:8765",
      WebSocketImpl: FakeWebSocket,
      reconnectDelayMs: 10,
      onEvent: vi.fn(),
    });
    client.bindLocalFileWatch("local-1", "D:/tmp/a.md");
    client.connect();
    FakeWebSocket.instances[0].open();
    client.unbindLocalFileWatch("local-1");
    FakeWebSocket.instances[0].serverClose();
    vi.advanceTimersByTime(10);
    FakeWebSocket.instances[1].open();

    expect(FakeWebSocket.instances[0].sent.map((item) => JSON.parse(item))).toContainEqual({
      action: "unbind_local_file_watch",
      data: { watch_id: "local-1" },
    });
    expect(FakeWebSocket.instances[1].sent).toEqual([]);
  });

  it("surfaces malformed websocket messages", () => {
    const onError = vi.fn();
    const onStatus = vi.fn();
    const client = new RuntimeWsClient({
      baseUrl: "ws://127.0.0.1:8765",
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
