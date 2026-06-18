import { describe, expect, it, vi } from "vitest";

import type { AgentActionEnvelope, AgentInboundAction } from "@/types/protocol";
import { createRuntimeBridge } from "@/runtime/bridge";
import { RuntimeWsClient, type WsClientOptions } from "@/runtime/wsClient";

describe("RuntimeBridge", () => {
  it("routes settings and model calls through the backend HTTP facade", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init = {}) => {
      const url = requestUrl(input);
      if (url.endsWith("/api/settings") && init.method === "GET") {
        return Promise.resolve(
          jsonResponse(200, {
            model: {
              base_url: "https://api.example/v1",
              model: "qwen-coder",
              timeout_seconds: 60,
              api_key_set: true,
              api_key_preview: "sk-***",
            },
          }),
        );
      }
      if (url.endsWith("/api/models/refresh") && init.method === "POST") {
        return Promise.resolve(jsonResponse(200, { models: [{ id: "qwen-coder" }], cached: false }));
      }
      if (url.includes("/api/workspace/search?") && init.method === "GET") {
        return Promise.resolve(jsonResponse(200, [{ path: "src/main.ts", name: "main.ts", type: "file" }]));
      }
      if (url.includes("/api/workspace/media?") && init.method === "GET") {
        return Promise.resolve(
          jsonResponse(200, {
            path: "docs/assets/pixel.png",
            media_type: "image/png",
            size: 68,
            data_url: "data:image/png;base64,abc",
          }),
        );
      }
      return jsonResponse(404, { detail: "not found" });
    });
    const runtime = createRuntimeBridge({ baseUrl: "http://127.0.0.1:8765/", fetcher });

    await expect(runtime.settings.getSettings()).resolves.toMatchObject({
      model: { model: "qwen-coder", api_key_set: true },
    });
    await expect(runtime.models.refreshModels({ model: "qwen-coder" })).resolves.toEqual({
      models: [{ id: "qwen-coder" }],
      cached: false,
    });
    await expect(runtime.workspace.search("D:/repo", "main")).resolves.toEqual([
      { path: "src/main.ts", name: "main.ts", type: "file" },
    ]);
    await expect(runtime.workspace.readMedia("D:/repo", "docs/assets/pixel.png")).resolves.toMatchObject({
      media_type: "image/png",
      data_url: "data:image/png;base64,abc",
    });

    expect(fetcher).toHaveBeenNthCalledWith(1, "http://127.0.0.1:8765/api/settings", {
      method: "GET",
      headers: {},
      body: undefined,
    });
    expect(fetcher).toHaveBeenNthCalledWith(2, "http://127.0.0.1:8765/api/models/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: { model: "qwen-coder" } }),
    });
    expect(fetcher).toHaveBeenNthCalledWith(
      3,
      "http://127.0.0.1:8765/api/workspace/search?root=D%3A%2Frepo&q=main",
      {
        method: "GET",
        headers: {},
        body: undefined,
      },
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      4,
      "http://127.0.0.1:8765/api/workspace/media?root=D%3A%2Frepo&path=docs%2Fassets%2Fpixel.png",
      {
        method: "GET",
        headers: {},
        body: undefined,
      },
    );
  });

  it("routes conversation HTTP calls to session and history endpoints", async () => {
    const session = {
      id: "ses-1",
      user_id: "local-user",
      scene_id: "desktop-agent",
      status: "active",
      title: "会话",
      session_tag: "chat",
      active_session_id: null,
      parent_session_id: null,
      child_session_id: null,
      source_trace_id: null,
      created_at: "2026-06-18T00:00:00Z",
      updated_at: "2026-06-18T00:00:00Z",
      is_debug: false,
      is_scheduled: false,
      is_current: false,
    };
    const fetcher = vi.fn<typeof fetch>(async (input, init = {}) => {
      const url = requestUrl(input);
      if (url.includes("/api/sessions?") && init.method === "GET") {
        return Promise.resolve(jsonResponse(200, { list: [session], total: 1, page: 1, page_size: 20 }));
      }
      if (url.endsWith("/api/sessions") && init.method === "POST") {
        return Promise.resolve(jsonResponse(200, { session }));
      }
      if (url.endsWith("/api/sessions/ses%201") && init.method === "GET") {
        return Promise.resolve(jsonResponse(200, { session: { ...session, id: "ses 1" } }));
      }
      if (url.endsWith("/api/sessions/ses%201") && init.method === "PATCH") {
        return Promise.resolve(jsonResponse(200, { session: { ...session, id: "ses 1", title: "新标题" } }));
      }
      if (url.endsWith("/api/sessions/ses%201") && init.method === "DELETE") {
        return Promise.resolve(jsonResponse(204, undefined));
      }
      if (url.includes("/api/sessions/ses%201/history?") && init.method === "GET") {
        return Promise.resolve(
          jsonResponse(200, {
            list: [{ role: "assistant", content: "历史" }],
            total: 1,
            page: 1,
            page_size: 50,
            session,
            event_total: 3,
            turn_indexes: [1],
          }),
        );
      }
      return jsonResponse(404, { detail: "not found" });
    });
    const runtime = createRuntimeBridge({ fetcher });

    await expect(runtime.conversation.listSessions({ title: "会话", page: 1, pageSize: 20 })).resolves.toMatchObject({
      list: [{ id: "ses-1" }],
    });
    await expect(runtime.conversation.createSession({ title: "会话" })).resolves.toMatchObject({ id: "ses-1" });
    await expect(runtime.conversation.getSession("ses 1")).resolves.toMatchObject({ id: "ses 1" });
    await expect(runtime.conversation.updateSession("ses 1", { title: "新标题" })).resolves.toMatchObject({
      id: "ses 1",
      title: "新标题",
    });
    await expect(runtime.conversation.deleteSession("ses 1")).resolves.toBeUndefined();
    await expect(runtime.conversation.loadHistory("ses 1", { turnIndex: 1, order: "asc" })).resolves.toMatchObject({
      list: [{ role: "assistant", content: "历史" }],
      turn_indexes: [1],
    });

    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "http://127.0.0.1:8765/api/sessions?title=%E4%BC%9A%E8%AF%9D&page=1&page_size=20",
      expect.objectContaining({
        method: "GET",
      }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "http://127.0.0.1:8765/api/sessions",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ title: "会话" }),
      }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      3,
      "http://127.0.0.1:8765/api/sessions/ses%201",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      4,
      "http://127.0.0.1:8765/api/sessions/ses%201",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ title: "新标题" }),
      }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      5,
      "http://127.0.0.1:8765/api/sessions/ses%201",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      6,
      "http://127.0.0.1:8765/api/sessions/ses%201/history?turn_index=1&order=asc",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("opens chat websocket channels and sends action envelopes", () => {
    const createdOptions: WsClientOptions[] = [];
    const clients: FakeRuntimeWsClient[] = [];
    const runtime = createRuntimeBridge({
      baseUrl: "https://agent.example",
      wsClientFactory(options) {
        createdOptions.push(options);
        const client = new FakeRuntimeWsClient(options);
        clients.push(client);
        return client;
      },
    });
    const onEvent = vi.fn();

    const channel = runtime.conversation.openChatChannel(onEvent, { sessionId: "ses-1" });
    channel.chat({ message: "你好" });
    channel.cancel();
    channel.ping();

    expect(createdOptions[0].baseUrl).toBe("wss://agent.example");
    expect(clients[0].connectedWith).toEqual({ sessionId: "ses-1" });
    expect(clients[0].sent).toEqual([
      { action: "chat", data: { message: "你好" } },
      { action: "cancel", data: { session_id: "ses-1" } },
      { action: "ping", data: {} },
    ]);
    expect(channel.getStatus()).toBe("open");
    expect(channel.getSessionId()).toBe("ses-1");
  });

  it("routes model provider commands to real backend paths", async () => {
    const provider = {
      id: "provider-1",
      name: "主模型",
      base_url: "http://provider.test/v1",
      enabled: true,
      api_key_set: true,
      models: ["qwen-coder"],
      model_enabled: { "qwen-coder": true },
      health: {},
      default_model: "qwen-coder",
    };
    const fetcher = vi.fn<typeof fetch>(async (input, init = {}) => {
      const url = requestUrl(input);
      if (url.endsWith("/api/model-providers") && init.method === "GET") {
        return Promise.resolve(jsonResponse(200, { providers: [provider] }));
      }
      if (url.endsWith("/api/model-providers") && init.method === "POST") {
        return Promise.resolve(jsonResponse(201, provider));
      }
      if (url.endsWith("/api/model-providers/provider-1") && init.method === "PATCH") {
        return Promise.resolve(jsonResponse(200, { ...provider, name: "更新模型" }));
      }
      if (url.endsWith("/api/model-providers/provider-1/refresh") && init.method === "POST") {
        return Promise.resolve(jsonResponse(200, { provider, models: ["qwen-coder"] }));
      }
      if (
        url.endsWith("/api/model-providers/provider-1/models/qwen-coder/health") &&
        init.method === "POST"
      ) {
        return Promise.resolve(
          jsonResponse(200, {
            provider,
            health: {
              status: "healthy",
              latency_ms: 12,
              error: null,
              checked_at: "2026-06-17T10:00:00Z",
            },
          }),
        );
      }
      if (url.endsWith("/api/model-providers/default") && init.method === "PUT") {
        return Promise.resolve(jsonResponse(200, { providers: [provider] }));
      }
      if (url.endsWith("/api/model-providers/provider-1") && init.method === "DELETE") {
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return jsonResponse(404, { detail: "not found" });
    });
    const runtime = createRuntimeBridge({ fetcher });

    await expect(runtime.models.listProviders()).resolves.toEqual([provider]);
    await expect(
      runtime.models.createProvider({ name: "主模型", base_url: "http://provider.test/v1" }),
    ).resolves.toEqual(provider);
    await expect(runtime.models.updateProvider("provider-1", { name: "更新模型" })).resolves.toMatchObject({
      name: "更新模型",
    });
    await expect(runtime.models.refreshProviderModels("provider-1")).resolves.toEqual(provider);
    await expect(runtime.models.checkModelHealth("provider-1", "qwen-coder")).resolves.toMatchObject({
      health: { status: "healthy" },
    });
    await expect(runtime.models.setDefaultModel("provider-1", "qwen-coder")).resolves.toEqual(provider);
    await expect(runtime.models.deleteProvider("provider-1")).resolves.toBeUndefined();
  });
});

class FakeRuntimeWsClient extends RuntimeWsClient {
  connectedWith: { sessionId: string | null } | null = null;
  sent: Array<{ action: string; data: Record<string, unknown> }> = [];
  private fakeStatus: ReturnType<RuntimeWsClient["getStatus"]> = "idle";
  private fakeSessionId: string | null = null;

  constructor(readonly createdWith: WsClientOptions) {
    super(createdWith);
  }

  override connect(sessionId?: string | null) {
    this.connectedWith = { sessionId: sessionId ?? null };
    this.fakeSessionId = sessionId ?? null;
    this.fakeStatus = "open";
  }

  override close() {
    this.fakeStatus = "closed";
  }

  override getStatus() {
    return this.fakeStatus;
  }

  override getSessionId() {
    return this.fakeSessionId;
  }

  override sendAction(action: AgentInboundAction, data: Record<string, unknown> = {}) {
    this.sent.push({ action, data });
  }

  override chat(data: Record<string, unknown>) {
    this.sent.push({ action: "chat", data });
  }

  override cancel(sessionId = this.fakeSessionId) {
    this.sent.push({ action: "cancel", data: sessionId ? { session_id: sessionId } : {} });
  }

  override ping() {
    this.sent.push({ action: "ping", data: {} });
  }

  emit(event: AgentActionEnvelope) {
    this.createdWith.onEvent(event);
  }
}

function jsonResponse(status: number, body: unknown) {
  if (status === 204) {
    return new Response(null, { status });
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
}
