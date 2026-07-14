import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ChatChannel, RuntimeBridge, WsConnectionStatus } from "@/runtime";
import { createConversationRuntime } from "@/runtime/conversation";
import type { HttpClient } from "@/runtime/httpClient";
import { RuntimeWsClient } from "@/runtime/wsClient";
import { useAgentSessionController } from "@/renderer/hooks/useAgentSessionController";
import type {
  AgentActionEnvelope,
  AgentHistoryResponse,
  AgentInboundAction,
  AgentSession,
} from "@/types/protocol";

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

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
  }
}

describe("A2UI runtime send", () => {
  it("sends A2UI submit and cancel through RuntimeWsClient", () => {
    const client = new RuntimeWsClient({
      baseUrl: "ws://127.0.0.1:8765",
      WebSocketImpl: FakeWebSocket,
      onEvent: vi.fn(),
    });

    client.connect("ses-1");
    const socket = FakeWebSocket.instances[0];
    socket.open();
    client.submitA2UI({
      action: "a2ui_submit",
      session_id: "ses-1",
      interaction_id: "int-1",
      request_id: "req-submit",
      submit_result: { confirmed: true },
    });
    client.cancelA2UI({
      action: "a2ui_cancel",
      session_id: "ses-1",
      interaction_id: "int-1",
      request_id: "req-cancel",
      cancel_reason: "用户取消",
    });

    expect(socket.sent.map((item) => JSON.parse(item))).toEqual([
      { action: "bind_session", data: { session_id: "ses-1" } },
      {
        action: "a2ui_submit",
        data: {
          session_id: "ses-1",
          interaction_id: "int-1",
          request_id: "req-submit",
          submit_result: { confirmed: true },
        },
      },
      {
        action: "a2ui_cancel",
        data: {
          session_id: "ses-1",
          interaction_id: "int-1",
          request_id: "req-cancel",
          cancel_reason: "用户取消",
        },
      },
    ]);
  });

  it("routes A2UI payloads through conversation chat channels", () => {
    const clients: FakeRuntimeWsClient[] = [];
    const runtime = createConversationRuntime(fakeHttp(), {
      wsClientFactory(options) {
        const client = new FakeRuntimeWsClient(options);
        clients.push(client);
        return client;
      },
    });

    const channel = runtime.openChatChannel(vi.fn(), { sessionId: "ses-1" });
    channel.submitA2UI({
      action: "a2ui_submit",
      session_id: "ses-1",
      interaction_id: "int-1",
      request_id: "req-submit",
      submit_result: { selected_values: ["a"] },
    });
    channel.cancelA2UI({
      action: "a2ui_cancel",
      session_id: "ses-1",
      interaction_id: "int-1",
      request_id: "req-cancel",
      cancel_reason: "skip",
    });

    expect(clients[0].sent).toEqual([
      {
        action: "a2ui_submit",
        data: {
          session_id: "ses-1",
          interaction_id: "int-1",
          request_id: "req-submit",
          submit_result: { selected_values: ["a"] },
        },
      },
      {
        action: "a2ui_cancel",
        data: {
          session_id: "ses-1",
          interaction_id: "int-1",
          request_id: "req-cancel",
          cancel_reason: "skip",
        },
      },
    ]);
  });

  it("exposes A2UI submit and cancel callbacks from the session controller", async () => {
    const channel = fakeChannel();
    const runtime = fakeRuntime(channel);

    const { result } = renderHook(() =>
      useAgentSessionController({
        runtime,
        sessionId: "ses-1",
        syncThreadTasks: false,
      }),
    );

    await waitFor(() => {
      expect(result.current.connectionReady).toBe(true);
    });

    await act(async () => {
      await result.current.submitA2UI("int-1", { confirmed: true });
      await result.current.cancelA2UI("int-1", "用户取消");
    });

    expect(channel.submitA2UI).toHaveBeenCalledTimes(1);
    expect(channel.submitA2UI).toHaveBeenCalledWith(expect.objectContaining({
      action: "a2ui_submit",
      session_id: "ses-1",
      interaction_id: "int-1",
      submit_result: { confirmed: true },
    }));
    expect(channel.submitA2UI.mock.calls[0][0].request_id).toMatch(/^submit-/);
    expect(channel.cancelA2UI).toHaveBeenCalledWith(expect.objectContaining({
      action: "a2ui_cancel",
      session_id: "ses-1",
      interaction_id: "int-1",
      cancel_reason: "用户取消",
    }));
    expect(channel.cancelA2UI.mock.calls[0][0].request_id).toMatch(/^cancel-/);
  });
});

class FakeRuntimeWsClient extends RuntimeWsClient {
  sent: Array<{ action: AgentInboundAction; data: Record<string, unknown> }> = [];
  private fakeSessionId: string | null = null;

  override connect(sessionId?: string | null) {
    this.fakeSessionId = sessionId ?? null;
  }

  override getStatus() {
    return "open" as const;
  }

  override getSessionId() {
    return this.fakeSessionId;
  }

  override sendAction(action: AgentInboundAction, data: Record<string, unknown> = {}) {
    this.sent.push({ action, data });
  }
}

function fakeHttp(): HttpClient {
  return {
    getBaseUrl: () => "https://agent.example",
    request: vi.fn(),
  } as unknown as HttpClient;
}

function fakeRuntime(channel: ReturnType<typeof fakeChannel>): RuntimeBridge {
  return {
    conversation: {
      loadHistory: vi.fn().mockResolvedValue(historyResponse()),
      openChatChannel: vi.fn(
        (_onEvent: (event: AgentActionEnvelope) => void, options?: { onStatus?: (status: WsConnectionStatus) => void }) => {
          options?.onStatus?.("open");
          return channel;
        },
      ),
    },
  } as unknown as RuntimeBridge;
}

function fakeChannel() {
  return {
    close: vi.fn(),
    getStatus: vi.fn((): WsConnectionStatus => "open"),
    getSessionId: vi.fn(() => "ses-1"),
    createSession: vi.fn(),
    bindSession: vi.fn(),
    unbindSession: vi.fn(),
    chat: vi.fn(),
    submitA2UI: vi.fn(),
    cancelA2UI: vi.fn(),
    approvalDecision: vi.fn(),
    resolveMcpElicitation: vi.fn(),
    cancel: vi.fn(),
    terminateCommand: vi.fn(),
    requestStatus: vi.fn(),
    ping: vi.fn(),
  };
}

function historyResponse(): AgentHistoryResponse {
  return {
    list: [],
    total: 0,
    page: 1,
    page_size: 50,
    session: agentSession(),
    event_total: 0,
    turn_indexes: [],
  };
}

function agentSession(): AgentSession {
  return {
    id: "ses-1",
    user_id: "local-user",
    scene_id: "desktop-agent",
    status: "active",
    title: "测试对话",
    session_tag: "chat",
    session_type: "workspace",
    workspace_id: null,
    cwd: null,
    workspace_roots: [],
    workspace: null,
    active_session_id: null,
    parent_session_id: null,
    child_session_id: null,
    source_trace_id: null,
    created_at: "2026-06-18T07:00:00Z",
    updated_at: "2026-06-18T08:00:00Z",
    archived_at: null,
    archive_origin: null,
    is_debug: false,
    is_scheduled: false,
    is_current: false,
    current_model_provider_id: "provider-1",
    current_model: "qwen-coder",
  };
}
