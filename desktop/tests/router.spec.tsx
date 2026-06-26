import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

import type { AgentActionEnvelope } from "@/types/protocol";
import type { ChatChannel, ChatChannelOptions, RuntimeBridge, WsConnectionStatus } from "@/runtime";
import {
  appModeFromPath,
  conversationPath,
  modeSwitchTargetsForPath,
  parseWorkbenchPath,
  workbenchPath,
} from "@/renderer/components/layout/appMode";
import { AppRouter } from "@/renderer/components/layout/Router";
import { LayoutStateProvider } from "@/renderer/hooks/layout/LayoutStateProvider";
import { AgentSessionProvider } from "@/renderer/providers/AgentSessionProvider";
import { NotificationProvider } from "@/renderer/providers/NotificationProvider";
import { PreviewProvider } from "@/renderer/providers/PreviewProvider";
import { RuntimeConnectionProvider } from "@/renderer/providers/RuntimeConnectionProvider";
import { ThemeProvider } from "@/renderer/providers/ThemeProvider";
import { FontProvider } from "@/renderer/providers/FontProvider";
import type { AgentSession, CommandApprovalRequest, Workspace } from "@/types/protocol";

function renderRouter(
  initialEntries: Array<string | { pathname: string; state?: unknown }>,
  options: FakeRuntimeOptions = {},
) {
  const runtime = fakeRuntime(options);
  const result = render(
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
  return { ...result, runtime };
}

describe("AppRouter", () => {
  it("builds and detects mode-aware route helpers", () => {
    expect(conversationPath("thread 1")).toBe("/conversation/thread%201");
    expect(workbenchPath()).toBe("/workbench");
    expect(workbenchPath("workspace A")).toBe("/workbench/workspace%20A");
    expect(workbenchPath("workspace A", "session 1")).toBe("/workbench/workspace%20A/session/session%201");
    expect(parseWorkbenchPath("/workbench")).toEqual({});
    expect(parseWorkbenchPath("/workbench/workspace%20A/session/session%201")).toEqual({
      workspaceId: "workspace A",
      sessionId: "session 1",
    });
    expect(parseWorkbenchPath("/conversation/thread-1")).toBeNull();
    expect(appModeFromPath("/workbench/workspace-a")).toBe("workbench");
    expect(appModeFromPath("/conversation/thread-1")).toBe("agent");
    expect(appModeFromPath("/settings/general")).toBe("agent");
    expect(modeSwitchTargetsForPath("/conversation/session%201", "workspace A")).toEqual({
      agent: "/conversation/session%201",
      workbench: "/workbench/workspace%20A",
    });
    expect(modeSwitchTargetsForPath("/workbench/workspace%20A/session/session%201", "workspace B")).toEqual({
      agent: "/conversation/session%201",
      workbench: "/workbench/workspace%20A/session/session%201",
    });
    expect(modeSwitchTargetsForPath("/guid", null).workbench).toBe("/workbench");
  });

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

  it("opens the workbench picker route", async () => {
    renderRouter(["/workbench"]);

    expect(await screen.findByTestId("workbench-mode-page", undefined, { timeout: 10000 })).not.toBeNull();
    expect(screen.getByRole("button", { name: "工作台模式" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("workbench-workspace-picker")).not.toBeNull();
    expect(screen.getByTestId("workbench-assistant-capsule").getAttribute("data-disabled")).toBe("true");
    expect(screen.queryByRole("button", { name: /无项目聊天/ })).toBeNull();
  });

  it("selects a workspace from the workbench picker", async () => {
    renderRouter(["/workbench"]);

    expect(await screen.findByTestId("workbench-workspace-picker", undefined, { timeout: 10000 })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "选择工作区" }));
    fireEvent.click(screen.getByRole("option", { name: /keydex/ }));

    expect(await screen.findByTestId("workbench-workspace-shell", undefined, { timeout: 10000 })).not.toBeNull();
    expect(screen.getByTestId("workbench-mode-page").getAttribute("data-workspace-id")).toBe("workspace A");
    expect(screen.getByTestId("workbench-sidebar-workspace-selector")).not.toBeNull();
    expect(
      within(screen.getByRole("main", { name: "工作台" })).queryByRole("button", { name: "选择工作区" }),
    ).toBeNull();
  });

  it("opens a workbench workspace session route", async () => {
    const { runtime } = renderRouter(["/workbench/workspace%20A/session/session%201"]);

    expect(await screen.findByTestId("workbench-mode-page", undefined, { timeout: 10000 })).not.toBeNull();
    expect(await screen.findByTestId("workbench-workspace-shell", undefined, { timeout: 10000 })).not.toBeNull();
    expect(screen.getByTestId("workspace-file-browser")).not.toBeNull();
    expect(screen.getByTestId("workbench-mode-page").getAttribute("data-workspace-id")).toBe("workspace A");
    expect(screen.getByTestId("workbench-mode-page").getAttribute("data-selected-session-id")).toBe("session 1");
    expect(screen.getByRole("button", { name: "工作台模式" }).getAttribute("aria-pressed")).toBe("true");
    expect(runtime.workspace.listDirectory).toHaveBeenCalledWith({ workspaceId: "workspace A" }, "");
    expect(runtime.conversation.listSessions).toHaveBeenCalledWith({
      sessionType: "workspace",
      workspaceId: "workspace A",
      pageSize: 50,
    });
  });

  it("drops a mismatched workbench session without switching workspace", async () => {
    renderRouter(["/workbench/workspace%20A/session/session%201"], {
      sessionWorkspaceId: "workspace B",
    });

    expect(await screen.findByTestId("workbench-workspace-shell", undefined, { timeout: 10000 })).not.toBeNull();
    await screen.findByTestId("workspace-file-browser", undefined, { timeout: 10000 });

    expect(screen.getByTestId("workbench-mode-page").getAttribute("data-workspace-id")).toBe("workspace A");
    await waitFor(() => {
      expect(screen.getByTestId("workbench-mode-page").getAttribute("data-selected-session-id")).toBe("");
    });
  });

  it("creates a workspace-owned session from the workbench assistant capsule", async () => {
    const { runtime } = renderRouter(["/workbench/workspace%20A"]);

    fireEvent.click(await screen.findByRole("button", { name: "展开工作台输入框" }, { timeout: 10000 }));
    const input = await screen.findByLabelText("工作台助手输入", undefined, { timeout: 10000 });
    input.textContent = "生成验收说明";
    fireEvent.input(input);
    const sendButton = screen.getByRole("button", { name: "发送" }) as HTMLButtonElement;
    await waitFor(() => {
      expect(sendButton.disabled).toBe(false);
    });
    fireEvent.click(sendButton);

    await waitFor(() => {
      expect(runtime.conversation.createSession).toHaveBeenCalledWith({
        title: "生成验收说明",
        session_tag: "chat",
        sessionType: "workspace",
        workspaceId: "workspace A",
      });
    });
    expect(runtime.__spies.chat).toHaveBeenCalledWith({
      session_id: "new-workbench-session",
      message: "生成验收说明",
      model: "qwen-coder",
    });
    await waitFor(() => {
      expect(screen.getByTestId("workbench-mode-page").getAttribute("data-selected-session-id")).toBe(
        "new-workbench-session",
      );
    });
  });

  it("searches files from the workbench assistant with the current workspace scope", async () => {
    const workspaceSearch = vi.fn().mockResolvedValue([{ path: "README.md", name: "README.md", type: "file" }]);
    renderRouter(["/workbench/workspace%20A/session/session%201"], { workspaceSearch });

    fireEvent.click(await screen.findByRole("button", { name: "展开工作台输入框" }, { timeout: 10000 }));
    const input = await screen.findByLabelText("工作台助手输入", undefined, { timeout: 10000 });
    input.textContent = "@READ";
    fireEvent.input(input);

    expect(await screen.findByTestId("at-file-menu", undefined, { timeout: 10000 })).not.toBeNull();
    await waitFor(() => {
      expect(workspaceSearch).toHaveBeenCalledWith(
        { workspaceId: "workspace A" },
        "READ",
        expect.objectContaining({ signal: expect.any(Object) }),
      );
    });
  });

  it("switches the workbench assistant between capsule, expanded layer and drawer", async () => {
    renderRouter(["/workbench/workspace%20A/session/session%201"]);

    const shell = screen.getByTestId("app-shell");
    const workspaceShell = await screen.findByTestId("workbench-workspace-shell", undefined, { timeout: 10000 });
    const canvasContent = screen.getByTestId("workbench-canvas-content");
    expect(shell.dataset.rightSidebarEnabled).toBe("false");
    expect(shell.dataset.rightSidebar).toBe("closed");
    expect(screen.queryByLabelText("展开右侧栏")).toBeNull();
    const surface = await screen.findByTestId("workbench-assistant-surface", undefined, { timeout: 10000 });
    expect(surface.getAttribute("data-surface-mode")).toBe("capsule");
    expect(surface.getAttribute("data-dock-layout")).toBe("overlay");
    expect(surface.getAttribute("data-dock-transition")).toBe("idle");
    expect(workspaceShell.getAttribute("data-dock-transitioning")).toBe("false");
    expect(canvasContent.getAttribute("data-render-paused")).toBe("false");
    expect(screen.getByTestId("workbench-assistant-capsule")).not.toBeNull();
    expect(screen.getByLabelText("输入框状态")).not.toBeNull();
    expect(screen.queryByLabelText("工作台助手输入")).toBeNull();
    expect(screen.queryByTestId("workbench-expanded-layer")).toBeNull();
    expect(screen.queryByTestId("workbench-assistant-drawer")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "展开工作台输入框" }));
    expect(await screen.findByLabelText("工作台助手输入")).not.toBeNull();
    expect(surface.getAttribute("data-surface-mode")).toBe("composer");

    fireEvent.click(screen.getByRole("button", { name: "展开工作台消息层" }));
    expect(screen.getByTestId("workbench-expanded-layer")).not.toBeNull();
    expect(surface.getAttribute("data-surface-mode")).toBe("expanded");

    fireEvent.click(screen.getByRole("button", { name: "收起工作台消息层" }));
    expect(screen.queryByTestId("workbench-expanded-layer")).toBeNull();
    expect(surface.getAttribute("data-surface-mode")).toBe("capsule");

    fireEvent.click(screen.getByRole("button", { name: "展开工作台输入框" }));
    const emptyInput = await screen.findByLabelText("工作台助手输入");
    fireEvent.pointerDown(screen.getByTestId("workspace-file-browser"));
    expect(surface.getAttribute("data-surface-mode")).toBe("capsule");
    expect(emptyInput.isConnected).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "展开工作台输入框" }));
    const stickyInput = await screen.findByLabelText("工作台助手输入");
    stickyInput.textContent = "保留草稿";
    fireEvent.input(stickyInput);
    fireEvent.pointerDown(screen.getByTestId("workspace-file-browser"));
    expect(surface.getAttribute("data-surface-mode")).toBe("composer");

    fireEvent.click(screen.getByRole("button", { name: "将工作台助手展开到右侧" }));
    expect(screen.getByTestId("workbench-assistant-drawer")).not.toBeNull();
    expect(surface.getAttribute("data-surface-mode")).toBe("drawer");
    expect(surface.getAttribute("data-dock-layout")).toBe("inline");
    expect(surface.getAttribute("data-dock-transition")).toBe("dock-in");
    expect(workspaceShell.getAttribute("data-dock-transitioning")).toBe("true");
    expect(canvasContent.getAttribute("data-render-paused")).toBe("true");
    expect(screen.getByTestId("workbench-dock-transition-loading")).not.toBeNull();
    const dockInMorph = screen.getByTestId("workbench-assistant-dock-morph");
    expect(dockInMorph.getAttribute("data-active")).toBe("false");
    await waitFor(() => {
      expect(dockInMorph.getAttribute("data-active")).toBe("true");
    });
    expect(shell.dataset.rightSidebar).toBe("closed");
    expect(screen.queryByTestId("right-sidebar-initial-page")).toBeNull();
    expect(screen.queryByTestId("workbench-expanded-layer")).toBeNull();
    await waitFor(() => {
      expect(surface.getAttribute("data-dock-transition")).toBe("idle");
    });
    expect(workspaceShell.getAttribute("data-dock-transitioning")).toBe("false");
    expect(canvasContent.getAttribute("data-render-paused")).toBe("false");
    expect(screen.queryByTestId("workbench-dock-transition-loading")).toBeNull();
    expect(screen.queryByTestId("workbench-assistant-dock-morph")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "关闭工作台助手侧栏" }));
    expect(screen.queryByTestId("workbench-assistant-drawer")).toBeNull();
    expect(surface.getAttribute("data-surface-mode")).toBe("composer");
    expect(surface.getAttribute("data-dock-layout")).toBe("overlay");
    expect(surface.getAttribute("data-dock-transition")).toBe("dock-out");
    expect(workspaceShell.getAttribute("data-dock-transitioning")).toBe("true");
    expect(canvasContent.getAttribute("data-render-paused")).toBe("true");
    expect(screen.getByTestId("workbench-dock-transition-loading")).not.toBeNull();
    const dockOutMorph = screen.getByTestId("workbench-assistant-dock-morph");
    expect(dockOutMorph.getAttribute("data-active")).toBe("false");
    await waitFor(() => {
      expect(dockOutMorph.getAttribute("data-active")).toBe("true");
    });
    await waitFor(() => {
      expect(surface.getAttribute("data-dock-transition")).toBe("idle");
    });
    expect(surface.getAttribute("data-dock-layout")).toBe("overlay");
    expect(workspaceShell.getAttribute("data-dock-transitioning")).toBe("false");
    expect(canvasContent.getAttribute("data-render-paused")).toBe("false");
    expect(screen.queryByTestId("workbench-dock-transition-loading")).toBeNull();
    expect(screen.queryByTestId("workbench-assistant-dock-morph")).toBeNull();
  });

  it("surfaces pending approval in the workbench assistant drawer", async () => {
    const { runtime } = renderRouter(["/workbench/workspace%20A/session/session%201"]);

    const surface = await screen.findByTestId("workbench-assistant-surface", undefined, { timeout: 10000 });
    await waitFor(() => {
      expect(runtime.conversation.openChatChannel).toHaveBeenCalled();
    });
    act(() => {
      runtime.__spies.emit({
        action: "approval_requested",
        data: {
          session_id: "session 1",
          approval: commandApproval("session 1", "approval-1"),
        },
      });
    });

    expect(await screen.findByTestId("workbench-approval-prompt", undefined, { timeout: 10000 })).not.toBeNull();
    expect(surface.getAttribute("data-surface-mode")).toBe("drawer");
    expect(surface.getAttribute("data-dock-layout")).toBe("inline");
    expect(surface.getAttribute("data-dock-transition")).toBe("dock-in");
    expect(screen.getByText("是否允许执行命令？")).not.toBeNull();
    await waitFor(() => {
      expect(surface.getAttribute("data-dock-transition")).toBe("idle");
    });

    fireEvent.click(screen.getByRole("button", { name: "批准" }));

    await waitFor(() => {
      expect(runtime.settings.resolveApproval).toHaveBeenCalledWith("approval-1", {
        decision: "approved",
        trust_scope: "once",
      });
    });
  });

  it("shows active plan status in the workbench assistant capsule group", async () => {
    const { runtime } = renderRouter(["/workbench/workspace%20A/session/session%201"]);

    await screen.findByTestId("workbench-assistant-surface", undefined, { timeout: 10000 });
    await waitFor(() => {
      expect(runtime.conversation.openChatChannel).toHaveBeenCalled();
    });

    act(() => {
      runtime.__spies.emit({
        action: "tool_start",
        data: {
          session_id: "session 1",
          run_id: "plan-run",
          tool_name: "update_plan",
          params: {
            plan: [
              { content: "确认工作台输入框交互", status: "completed" },
              { content: "补充状态胶囊", status: "in_progress" },
            ],
          },
        },
      });
    });

    const planPill = await screen.findByTestId("plan-summary-pill", undefined, { timeout: 10000 });
    expect(within(planPill).getByText(/补充状态胶囊/)).not.toBeNull();
    expect(screen.getByRole("button", { name: "展开工作台输入框" })).not.toBeNull();
  });

  it("shows local skeletons before switching app modes", async () => {
    renderRouter(["/conversation/thread-1"]);

    expect(await screen.findByRole("heading", { name: /thread-1/ }, { timeout: 10000 })).not.toBeNull();
    expect(screen.queryByTestId("workbench-mode-page")).toBeNull();
    const shell = screen.getByTestId("app-shell");

    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByRole("button", { name: "工作台模式" }));
      expect(shell.dataset.appModeLoading).toBe("true");
      expect(screen.getByTestId("app-mode-session-loading-skeleton")).not.toBeNull();
      expect(screen.getByTestId("app-mode-content-loading-skeleton")).not.toBeNull();
      expect(screen.queryByText("正在切换应用模式")).toBeNull();
      expect(screen.queryByTestId("workbench-mode-page")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "Agent" }));
      expect(shell.dataset.appModeLoading).toBe("false");
      expect(screen.queryByTestId("app-mode-session-loading-skeleton")).toBeNull();
      expect(screen.queryByTestId("app-mode-content-loading-skeleton")).toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(220);
        await Promise.resolve();
      });
      expect(screen.queryByTestId("workbench-mode-page")).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: "工作台模式" }));
      expect(shell.dataset.appModeLoading).toBe("true");
      expect(screen.getByTestId("app-mode-session-loading-skeleton")).not.toBeNull();
      expect(screen.getByTestId("app-mode-content-loading-skeleton")).not.toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(220);
        await Promise.resolve();
      });

      expect(screen.getByTestId("workbench-mode-page")).not.toBeNull();
      expect(screen.getByTestId("app-shell").dataset.appModeLoading).toBe("false");
      expect(screen.queryByTestId("app-mode-session-loading-skeleton")).toBeNull();
      expect(screen.queryByTestId("app-mode-content-loading-skeleton")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

interface FakeRuntimeOptions {
  sessionWorkspaceId?: string;
  workspaceSearch?: ReturnType<typeof vi.fn>;
}

type TestRuntimeBridge = RuntimeBridge & {
  __spies: {
    chat: ReturnType<typeof vi.fn>;
    emit: (event: AgentActionEnvelope) => void;
  };
};

function fakeRuntime(options: FakeRuntimeOptions = {}): TestRuntimeBridge {
  const sessionWorkspaceId = options.sessionWorkspaceId ?? "workspace A";
  const workspaceSearch = options.workspaceSearch ?? vi.fn().mockResolvedValue([]);
  let emit: (event: AgentActionEnvelope) => void = () => undefined;
  const chat = vi.fn();
  const listSessions = vi.fn(() =>
    Promise.resolve({
      list: [
        agentSession({
          id: "session 1",
          title: "工作台会话",
          session_type: "workspace",
          workspace_id: sessionWorkspaceId,
          workspace: workspace(sessionWorkspaceId, sessionWorkspaceId === "workspace A" ? "keydex" : "other"),
        }),
      ],
      total: 1,
      page: 1,
      page_size: 50,
    }),
  );
  const listDirectory = vi.fn(() =>
    Promise.resolve({
      root: "",
      entries: [{ name: "README.md", path: "README.md", type: "file", size: 12, modified_at: null }],
    }),
  );
  const createSession = vi.fn(() =>
    Promise.resolve(
      agentSession({
        id: "new-workbench-session",
        title: "生成验收说明",
        session_type: "workspace",
        workspace_id: "workspace A",
        workspace: workspace("workspace A", "keydex"),
      }),
    ),
  );

  return {
    __spies: { chat, emit: (event: AgentActionEnvelope) => emit(event) },
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
      resolveApproval: vi.fn((approvalId: string) =>
        Promise.resolve({
          ...commandApproval("session 1", approvalId),
          status: "approved",
          resolved_at: "2026-06-25T12:00:02Z",
        }),
      ),
    },
    models: {
      listModels: () => Promise.resolve({ models: [{ id: "qwen-coder" }], cached: true }),
      listProviders: () => Promise.resolve([]),
    },
    workspaces: {
      list: () => Promise.resolve({ list: [workspace("workspace A", "keydex")], total: 1 }),
      create: () => Promise.reject(new Error("not implemented")),
      get: (workspaceId: string) => Promise.resolve(workspace(workspaceId, workspaceId)),
    },
    workspace: {
      listDirectory,
      search: workspaceSearch,
    },
    desktopPicker: {
      isDirectoryPickerAvailable: () => false,
      pickDirectory: () => Promise.resolve(null),
    },
    conversation: {
      listSessions,
      loadHistory: () =>
        Promise.resolve({
          session: agentSession(),
          list: [],
          next_cursor: null,
          has_more_older: false,
        }),
      createSession,
      getSession: () =>
        Promise.resolve(
          agentSession({
            id: "session 1",
            title: "工作台会话",
            session_type: "workspace",
            workspace_id: sessionWorkspaceId,
            workspace: workspace(sessionWorkspaceId, sessionWorkspaceId === "workspace A" ? "keydex" : "other"),
          }),
        ),
      openChatChannel: vi.fn((onEvent: (event: AgentActionEnvelope) => void, options?: ChatChannelOptions) => {
        emit = onEvent;
        const channel = fakeChannel(options?.onStatus, chat);
        return channel;
      }),
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
  } as unknown as TestRuntimeBridge;
}

function fakeChannel(onStatus?: (status: WsConnectionStatus) => void, chat: ReturnType<typeof vi.fn> = vi.fn()): ChatChannel {
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
    chat,
    approvalDecision: () => undefined,
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

function agentSession(patch: Partial<AgentSession> = {}): AgentSession {
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
    ...patch,
  };
}

function workspace(id: string, name: string): Workspace {
  return {
    id,
    name,
    root_path: `D:/Pycharm Projects/${name}`,
    normalized_root_path: `d:/pycharm projects/${name.toLowerCase()}`,
    type: "project",
    created_at: "2026-06-21T00:00:00Z",
    updated_at: "2026-06-21T00:00:00Z",
    last_opened_at: null,
    is_deleted: false,
  };
}

function commandApproval(sessionId: string, id: string): CommandApprovalRequest {
  return {
    id,
    session_id: sessionId,
    thread_id: sessionId,
    turn_id: "turn-1",
    item_id: "item-command",
    call_id: "call-command",
    run_id: "run-command",
    tool_name: "run_command",
    kind: "exec",
    title: "是否允许执行命令？",
    description: "请求执行命令。",
    details: { command: "pnpm test", cwd: "D:/repo" },
    status: "pending",
    created_at: "2026-06-25T12:00:01Z",
    resolved_at: null,
  };
}
