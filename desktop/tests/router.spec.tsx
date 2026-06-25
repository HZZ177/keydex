import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";

import type { AgentActionEnvelope } from "@/types/protocol";
import type { ChatChannel, ChatChannelOptions, RuntimeBridge, WsConnectionStatus } from "@/runtime";
import { AppRouter } from "@/renderer/components/layout/Router";
import { LayoutStateProvider } from "@/renderer/hooks/layout/LayoutStateProvider";
import { AgentSessionProvider } from "@/renderer/providers/AgentSessionProvider";
import { NotificationProvider } from "@/renderer/providers/NotificationProvider";
import { PreviewProvider } from "@/renderer/providers/PreviewProvider";
import { RuntimeConnectionProvider } from "@/renderer/providers/RuntimeConnectionProvider";
import { ThemeProvider } from "@/renderer/providers/ThemeProvider";
import { FontProvider } from "@/renderer/providers/FontProvider";
import type { AgentSession } from "@/types/protocol";

function renderRouter(initialEntries: Array<string | { pathname: string; state?: unknown }>) {
  const runtime = fakeRuntime();
  return render(
    <ThemeProvider>
      <FontProvider>
        <NotificationProvider>
          <LayoutStateProvider>
            <RuntimeConnectionProvider runtime={runtime} starter={() => Promise.resolve(agentConnection())}>
              <AgentSessionProvider runtime={runtime}>
                <PreviewProvider>
                  <MemoryRouter initialEntries={initialEntries}>
                    <AppRouter runtime={runtime} />
                  </MemoryRouter>
                </PreviewProvider>
              </AgentSessionProvider>
            </RuntimeConnectionProvider>
          </LayoutStateProvider>
        </NotificationProvider>
      </FontProvider>
    </ThemeProvider>,
  );
}

describe("AppRouter", () => {
  it("redirects root to the guide page", async () => {
    renderRouter(["/"]);

    expect(await screen.findByTestId("home-page", undefined, { timeout: 10000 })).not.toBeNull();
    expect(screen.getByLabelText("输入需求")).not.toBeNull();
  });

  it("opens settings in an isolated settings workspace and returns to the source route", async () => {
    renderRouter(["/conversation/thread-1"]);

    expect(await screen.findByRole("heading", { name: /thread-1/ }, { timeout: 10000 })).not.toBeNull();
    expect(screen.getByTestId("titlebar").textContent).not.toContain("thread-1");
    expect(screen.getByTestId("chat-layout").parentElement?.getAttribute("data-content")).toBe("full");
    fireEvent.click(screen.getByText("设置"));
    expect(await screen.findByTestId("settings-shell", undefined, { timeout: 10000 })).not.toBeNull();
    expect(screen.getByTestId("settings-sidebar")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "外观" })).not.toBeNull();
    expect(screen.queryByLabelText("侧边栏")).toBeNull();
    expect(screen.queryByText("新对话")).toBeNull();

    fireEvent.click(screen.getByText("返回应用"));
    expect(await screen.findByRole("heading", { name: /thread-1/ }, { timeout: 10000 })).not.toBeNull();
  });

  it("supports direct settings route fallback back to guide", async () => {
    renderRouter(["/settings/usage"]);

    expect(await screen.findByTestId("settings-shell", undefined, { timeout: 10000 })).not.toBeNull();
    expect(screen.getByRole("heading", { name: "用量统计" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "外观" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "供应商" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "用量统计" })).not.toBeNull();
    fireEvent.click(screen.getByText("返回应用"));
    expect(await screen.findByTestId("home-page", undefined, { timeout: 10000 })).not.toBeNull();
  });

  it("opens the general settings route", async () => {
    renderRouter(["/settings/general"]);

    expect(await screen.findByRole("heading", { name: "外观" }, { timeout: 10000 })).not.toBeNull();
    fireEvent.click(screen.getByText("返回应用"));
    expect(await screen.findByTestId("home-page", undefined, { timeout: 10000 })).not.toBeNull();
  });
});

function fakeRuntime(): RuntimeBridge {
  return {
    settings: {
      getSettings: () =>
        Promise.resolve({
          model: {
            base_url: "https://api.example/v1",
            model: "qwen-coder",
            timeout_seconds: 60,
            api_key_set: true,
            api_key_preview: "sk-***",
          },
        }),
    },
    models: {
      listModels: () => Promise.resolve({ models: [{ id: "qwen-coder" }], cached: true }),
      listProviders: () => Promise.resolve([]),
    },
    workspaces: {
      list: () => Promise.resolve({ list: [], total: 0 }),
      create: () => Promise.reject(new Error("not implemented")),
    },
    workspace: {
      listDirectory: () => Promise.resolve({ root: "", entries: [] }),
      search: () => Promise.resolve([]),
    },
    desktopPicker: {
      isDirectoryPickerAvailable: () => false,
      pickDirectory: () => Promise.resolve(null),
    },
    conversation: {
      listSessions: () => Promise.resolve({ items: [], total: 0 }),
      loadHistory: () =>
        Promise.resolve({
          session: agentSession(),
          list: [],
          next_cursor: null,
          has_more_older: false,
        }),
      createSession: () => Promise.resolve(agentSession()),
      openChatChannel(_onEvent: (event: AgentActionEnvelope) => void, options?: ChatChannelOptions) {
        const channel = fakeChannel(options?.onStatus);
        return channel;
      },
    },
    usage: {
      getSummary: () =>
        Promise.resolve({
          request_count: 0,
          total_tokens: 0,
          input_tokens: 0,
          cache_read_tokens: 0,
          output_tokens: 0,
          success_count: 0,
          failed_count: 0,
          avg_duration_ms: 0,
        }),
      getTrend: () => Promise.resolve([]),
      listRequests: () => Promise.resolve({ list: [], total: 0, page: 1, page_size: 12 }),
      getRequestDetail: () => Promise.reject(new Error("not implemented")),
    },
  } as unknown as RuntimeBridge;
}

function fakeChannel(onStatus?: (status: WsConnectionStatus) => void): ChatChannel {
  let status: WsConnectionStatus = "open";
  let sessionId: string | null = null;
  queueMicrotask(() => onStatus?.("open"));
  return {
    bindSession: (id: string) => {
      sessionId = id;
    },
    createSession: () => undefined,
    unbindSession: () => {
      sessionId = null;
    },
    chat: () => undefined,
    cancel: () => undefined,
    ping: () => undefined,
    requestStatus: () => undefined,
    close: () => {
      status = "closed";
      onStatus?.("closed");
    },
    getSessionId: () => sessionId,
    getStatus: () => status,
  };
}

function agentConnection() {
  return {
    host: "127.0.0.1",
    port: 8765,
    base_url: "http://127.0.0.1:8765",
    data_dir: "",
  };
}

function agentSession(): AgentSession {
  return {
    id: "thread-1",
    user_id: "local-user",
    scene_id: "desktop-agent",
    status: "active",
    title: "thread-1",
    session_tag: "chat",
    session_type: "chat",
    workspace_id: null,
    cwd: null,
    workspace_roots: [],
    workspace: null,
    active_session_id: null,
    parent_session_id: null,
    child_session_id: null,
    source_trace_id: null,
    created_at: "2026-06-17T10:00:00Z",
    updated_at: "2026-06-17T10:00:00Z",
    is_debug: false,
    is_scheduled: false,
    is_current: false,
  };
}
