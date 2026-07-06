import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import type { AgentActionEnvelope } from "@/types/protocol";
import type { AgentConnection, ChatChannel, ChatChannelOptions, RuntimeBridge, WsConnectionStatus } from "@/runtime";
import {
  appModeFromPath,
  conversationPath,
  modeSwitchTargetsForPath,
  parseWorkbenchPath,
  PROJECT_PATH,
  workbenchPath,
} from "@/renderer/components/layout/appMode";
import { AppRouter } from "@/renderer/components/layout/Router";
import { emitSessionUpdated } from "@/renderer/events/sessionEvents";
import { LayoutStateProvider } from "@/renderer/hooks/layout/LayoutStateProvider";
import { AgentSessionProvider } from "@/renderer/providers/AgentSessionProvider";
import { NotificationProvider } from "@/renderer/providers/NotificationProvider";
import { PreviewProvider, usePreview } from "@/renderer/providers/PreviewProvider";
import { RuntimeConnectionProvider } from "@/renderer/providers/RuntimeConnectionProvider";
import { ThemeProvider } from "@/renderer/providers/ThemeProvider";
import { FontProvider } from "@/renderer/providers/FontProvider";
import type { AgentSession, CommandApprovalRequest, Workspace } from "@/types/protocol";

function renderRouter(
  initialEntries: Array<string | { pathname: string; state?: unknown }>,
  options: RenderRouterOptions = {},
) {
  const { extra, starter = () => Promise.resolve(agentConnection()), ...runtimeOptions } = options;
  const runtime = fakeRuntime(runtimeOptions);
  const result = render(
    <ThemeProvider>
      <FontProvider>
        <NotificationProvider>
          <LayoutStateProvider>
            <RuntimeConnectionProvider runtime={runtime} starter={starter}>
              <AgentSessionProvider runtime={runtime}>
                <PreviewProvider>
                  {extra}
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
    expect(appModeFromPath(PROJECT_PATH)).toBe("project");
    expect(appModeFromPath("/conversation/thread-1")).toBe("agent");
    expect(appModeFromPath("/settings/general")).toBe("agent");
    expect(modeSwitchTargetsForPath("/conversation/session%201", "workspace A")).toEqual({
      agent: "/conversation/session%201",
      workbench: "/workbench/workspace%20A",
      project: PROJECT_PATH,
    });
    expect(modeSwitchTargetsForPath("/workbench/workspace%20A/session/session%201", "workspace B")).toEqual({
      agent: "/conversation/session%201",
      workbench: "/workbench/workspace%20A/session/session%201",
      project: PROJECT_PATH,
    });
    expect(modeSwitchTargetsForPath(PROJECT_PATH, "workspace A")).toEqual({
      agent: "/guid",
      workbench: "/workbench/workspace%20A",
      project: PROJECT_PATH,
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
    expect(screen.getByRole("heading", { name: "常规" })).not.toBeNull();
    expect(screen.queryByLabelText("侧边栏")).toBeNull();
    expect(screen.queryByText("新对话")).toBeNull();

    fireEvent.click(screen.getByText("返回应用"));
    expect(await screen.findByRole("heading", { name: /thread-1/ }, { timeout: 10000 })).not.toBeNull();
  });

  it("supports direct settings route fallback back to guide", async () => {
    renderRouter(["/settings/usage"]);

    expect(await screen.findByTestId("settings-shell", undefined, { timeout: 10000 })).not.toBeNull();
    expect(screen.getByRole("heading", { name: "用量统计" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "常规" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "外观" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "供应商配置" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "模型配置" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "扩展功能" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "策略配置" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "用量统计" })).not.toBeNull();
    fireEvent.click(screen.getByText("返回应用"));
    expect(await screen.findByTestId("home-page", undefined, { timeout: 10000 })).not.toBeNull();
  });

  it("opens the model configuration settings route", async () => {
    renderRouter(["/settings/model-defaults"]);

    expect(await screen.findByRole("heading", { name: "模型配置" }, { timeout: 10000 })).not.toBeNull();
    expect(screen.getByTestId("model-default-settings-page")).not.toBeNull();
    expect(await screen.findByRole("heading", { name: "默认对话模型" }, { timeout: 10000 })).not.toBeNull();
  });

  it("opens the provider settings route", async () => {
    renderRouter(["/settings/providers"]);

    expect(await screen.findByRole("heading", { name: "供应商配置" }, { timeout: 10000 })).not.toBeNull();
  });

  it("opens the extension settings route", async () => {
    renderRouter(["/settings/extensions"]);

    expect(await screen.findByRole("heading", { name: "扩展功能" }, { timeout: 10000 })).not.toBeNull();
    expect(screen.getByTestId("extension-settings-page")).not.toBeNull();
    expect(await screen.findByRole("heading", { name: "标题生成" }, { timeout: 10000 })).not.toBeNull();
    expect(screen.getByRole("heading", { name: "上下文压缩" })).not.toBeNull();
  });

  it("opens the strategy configuration settings route", async () => {
    renderRouter(["/settings/policy-config"]);

    expect(await screen.findByRole("heading", { name: "策略配置" }, { timeout: 10000 })).not.toBeNull();
    expect(screen.getByTestId("config-settings-page")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "命令行工具" })).not.toBeNull();
  });

  it("opens the general settings route", async () => {
    renderRouter(["/settings/general"]);

    expect(await screen.findByRole("heading", { name: "常规" }, { timeout: 10000 })).not.toBeNull();
    fireEvent.click(screen.getByText("返回应用"));
    expect(await screen.findByTestId("home-page", undefined, { timeout: 10000 })).not.toBeNull();
  });

  it("opens the appearance settings route", async () => {
    renderRouter(["/settings/appearance"]);

    expect(await screen.findByRole("heading", { name: "外观" }, { timeout: 10000 })).not.toBeNull();
    expect(screen.getByTestId("appearance-settings-page")).not.toBeNull();
  });

  it("opens the workbench picker route", async () => {
    renderRouter(["/workbench"]);

    expect(await screen.findByTestId("workbench-mode-page", undefined, { timeout: 10000 })).not.toBeNull();
    expect(screen.getByRole("button", { name: "工作台模式" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("workbench-workspace-picker")).not.toBeNull();
    expect(screen.getByTestId("workbench-assistant-capsule").getAttribute("data-disabled")).toBe("true");
    expect(screen.queryByRole("button", { name: /无项目聊天/ })).toBeNull();
  });

  it("opens the project mode placeholder route", async () => {
    renderRouter([PROJECT_PATH]);

    expect(await screen.findByTestId("project-mode-page", undefined, { timeout: 10000 })).not.toBeNull();
    expect(screen.getByRole("button", { name: "项目模式" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("功能开发中，敬请期待")).not.toBeNull();
    expect(screen.getByTestId("app-shell").dataset.rightSidebarEnabled).toBe("false");
    expect(screen.queryByLabelText("侧边栏")).toBeNull();
    expect(screen.queryByText("新对话")).toBeNull();
    expect(screen.queryByRole("separator", { name: "调整侧边栏宽度" })).toBeNull();
    expect(screen.queryByLabelText("展开右侧栏")).toBeNull();
  });

  it("selects a workspace from the workbench picker", async () => {
    renderRouter(["/workbench"]);

    expect(await screen.findByTestId("workbench-workspace-picker", undefined, { timeout: 10000 })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "选择工作区" }));
    fireEvent.click(await screen.findByRole("option", { name: /keydex/ }, { timeout: 10000 }));

    expect(await screen.findByTestId("workbench-workspace-shell", undefined, { timeout: 10000 })).not.toBeNull();
    expect(screen.getByTestId("workbench-mode-page").getAttribute("data-workspace-id")).toBe("workspace A");
    expect(screen.getByTestId("workbench-titlebar-workspace-selector")).not.toBeNull();
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

  it("keeps pinned workbench sessions in the sidebar pinned section", async () => {
    renderRouter(["/workbench/workspace%20A"], {
      sessions: [
        agentSession({
          id: "workbench-pinned",
          title: "置顶工作台会话",
          session_type: "workspace",
          workspace_id: "workspace A",
          workspace: workspace("workspace A", "keydex"),
          pinned: true,
          pinned_at: "2026-06-17T11:00:00Z",
          updated_at: "2026-06-17T10:20:00Z",
        }),
        agentSession({
          id: "workbench-regular",
          title: "普通工作台会话",
          session_type: "workspace",
          workspace_id: "workspace A",
          workspace: workspace("workspace A", "keydex"),
          updated_at: "2026-06-17T10:10:00Z",
        }),
      ],
    });

    const pinned = await screen.findByRole("region", { name: "置顶" }, { timeout: 10000 });
    const flatList = await screen.findByRole("region", { name: "keydex列表" }, { timeout: 10000 });
    expect(within(pinned).getByRole("button", { name: "置顶工作台会话" })).not.toBeNull();
    expect(within(flatList).getByRole("button", { name: "普通工作台会话" })).not.toBeNull();
    expect(within(flatList).queryByRole("button", { name: "置顶工作台会话" })).toBeNull();

    act(() => {
      emitSessionUpdated({
        id: "workbench-pinned",
        pinned: false,
        pinned_at: null,
        updated_at: "2026-06-17T11:30:00Z",
      });
    });

    await waitFor(() => {
      expect(within(screen.getByRole("region", { name: "置顶" })).getByText("暂无置顶")).not.toBeNull();
    });
    expect(
      within(screen.getByRole("region", { name: "keydex列表" })).getByRole("button", {
        name: "置顶工作台会话",
      }),
    ).not.toBeNull();
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

  it("waits for the runtime connection before loading a direct conversation route", async () => {
    const connection = createDeferred<AgentConnection>();
    const starter = vi.fn(() => connection.promise);
    const { runtime } = renderRouter(["/conversation/thread-1"], { starter });

    await waitFor(() => expect(starter).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });

    expect(runtime.conversation.openChatChannel).not.toHaveBeenCalled();
    expect(runtime.conversation.loadHistory).not.toHaveBeenCalled();
    expect(runtime.settings.getSettings).not.toHaveBeenCalled();
    expect(runtime.settings.getModelDefaults).not.toHaveBeenCalled();
    expect(runtime.models.listProviders).not.toHaveBeenCalled();

    await act(async () => {
      connection.resolve(agentConnection());
      await connection.promise;
    });

    await waitFor(() => {
      expect(runtime.conversation.loadHistory).toHaveBeenCalledWith("thread-1", {
        allTurns: true,
        direction: "older",
        pageSize: undefined,
      });
    });
    expect(runtime.conversation.openChatChannel).toHaveBeenCalled();
    expect(runtime.settings.getSettings).toHaveBeenCalled();
    expect(runtime.settings.getModelDefaults).toHaveBeenCalled();
    expect(runtime.models.listProviders).toHaveBeenCalled();
  });

  it("waits for the runtime connection before loading a direct workbench session route", async () => {
    const connection = createDeferred<AgentConnection>();
    const starter = vi.fn(() => connection.promise);
    const { runtime } = renderRouter(["/workbench/workspace%20A/session/session%201"], { starter });

    await waitFor(() => expect(starter).toHaveBeenCalledTimes(1));
    expect(await screen.findByTestId("workbench-workspace-loading", undefined, { timeout: 10000 })).not.toBeNull();
    await act(async () => {
      await Promise.resolve();
    });

    expect(runtime.workspaces.list).not.toHaveBeenCalled();
    expect(runtime.workspaces.get).not.toHaveBeenCalled();
    expect(runtime.conversation.listSessions).not.toHaveBeenCalled();
    expect(runtime.conversation.getSession).not.toHaveBeenCalled();
    expect(runtime.conversation.loadHistory).not.toHaveBeenCalled();
    expect(runtime.workspace.listDirectory).not.toHaveBeenCalled();

    await act(async () => {
      connection.resolve(agentConnection());
      await connection.promise;
    });

    await waitFor(() => {
      expect(runtime.workspaces.list).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(runtime.conversation.listSessions).toHaveBeenCalledWith({
        sessionType: "workspace",
        workspaceId: "workspace A",
        pageSize: 50,
      });
    });
    await waitFor(() => {
      expect(runtime.conversation.loadHistory).toHaveBeenCalledWith("session 1", {
        allTurns: true,
        direction: "older",
        pageSize: undefined,
      });
    });
    await waitFor(() => {
      expect(runtime.workspace.listDirectory).toHaveBeenCalledWith({ workspaceId: "workspace A" }, "");
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
        currentModelProviderId: "provider-1",
        currentModel: "qwen-coder",
      });
    });
    expect(runtime.__spies.chat).toHaveBeenCalledWith({
      session_id: "new-workbench-session",
      message: "生成验收说明",
      provider_id: "provider-1",
      model: "qwen-coder",
    });
    await waitFor(() => {
      expect(screen.getByTestId("workbench-mode-page").getAttribute("data-selected-session-id")).toBe(
        "new-workbench-session",
      );
    });
  });

  it("routes workbench file-open requests into the main preview area", async () => {
    const { runtime } = renderRouter(["/workbench/workspace%20A/session/session%201"], {
      extra: <WorkbenchFileOpenProbe />,
    });

    expect(await screen.findByTestId("workbench-workspace-shell", undefined, { timeout: 10000 })).not.toBeNull();
    const shell = await screen.findByTestId("app-shell", undefined, { timeout: 10000 });
    expect(shell.dataset.rightSidebarEnabled).toBe("false");
    expect(shell.dataset.rightSidebar).toBe("closed");

    fireEvent.click(screen.getByRole("button", { name: "测试打开工作台文件" }));

    expect(await screen.findByTestId("workbench-main-file-preview", undefined, { timeout: 10000 })).not.toBeNull();
    await waitFor(() => {
      expect(runtime.workspace.readFile).toHaveBeenCalledWith({ workspaceId: "workspace A" }, "README.md");
    });
    expect(screen.queryByTestId("workspace-file-browser-preview")).toBeNull();
    expect(shell.dataset.rightSidebar).toBe("closed");
    expect(screen.queryByLabelText("展开右侧栏")).toBeNull();
  });

  it("routes workbench preview entries into the main preview area", async () => {
    const { runtime } = renderRouter(["/workbench/workspace%20A/session/session%201"], {
      extra: <WorkbenchFileOpenProbe />,
    });

    expect(await screen.findByTestId("workbench-workspace-shell", undefined, { timeout: 10000 })).not.toBeNull();
    const shell = await screen.findByTestId("app-shell", undefined, { timeout: 10000 });

    fireEvent.click(screen.getByRole("button", { name: "测试打开工作台预览" }));

    expect(await screen.findByTestId("workbench-main-file-preview", undefined, { timeout: 10000 })).not.toBeNull();
    await waitFor(() => {
      expect(runtime.workspace.readFile).toHaveBeenCalledWith({ workspaceId: "workspace A" }, "README.md");
    });
    expect(screen.queryByTestId("workspace-file-browser-preview")).toBeNull();
    expect(shell.dataset.rightSidebar).toBe("closed");
  });

  it("enters a blank workbench session route from the assistant new-session button", async () => {
    const { runtime } = renderRouter(["/workbench/workspace%20A/session/session%201"]);

    fireEvent.click(await screen.findByRole("button", { name: "新会话" }, { timeout: 10000 }));

    await waitFor(() => {
      expect(screen.getByTestId("workbench-mode-page").getAttribute("data-selected-session-id")).toBe("");
    });
    expect(runtime.conversation.createSession).not.toHaveBeenCalled();
    expect(screen.getByTestId("workbench-assistant-session-title").getAttribute("data-empty")).toBe("true");
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

    const shell = await screen.findByTestId("app-shell", undefined, { timeout: 10000 });
    const workspaceShell = await screen.findByTestId("workbench-workspace-shell", undefined, { timeout: 10000 });
    const canvasContent = screen.getByTestId("workbench-canvas-content");
    expect(shell.dataset.rightSidebarEnabled).toBe("false");
    expect(shell.dataset.rightSidebar).toBe("closed");
    expect(screen.queryByLabelText("展开右侧栏")).toBeNull();
    const surface = await screen.findByTestId("workbench-assistant-surface", undefined, { timeout: 10000 });
    const assistantShell = screen.getByTestId("workbench-assistant-shell");
    expect(assistantShell.getAttribute("data-shell-mode")).toBe("capsule");
    expect(assistantShell.getAttribute("data-transition-phase")).toBe("idle");
    expect(surface.getAttribute("data-surface-mode")).toBe("capsule");
    expect(surface.getAttribute("data-dock-layout")).toBe("overlay");
    expect(surface.getAttribute("data-dock-transition")).toBe("idle");
    expect(workspaceShell.getAttribute("data-dock-transitioning")).toBe("false");
    expect(workspaceShell.getAttribute("data-dock-transition-phase")).toBe("idle");
    expect(canvasContent.getAttribute("data-render-paused")).toBeNull();
    expect(screen.queryByTestId("workbench-dock-transition-loading")).toBeNull();
    expect(screen.getByTestId("workbench-assistant-capsule")).not.toBeNull();
    expect(screen.getByLabelText("输入框状态")).not.toBeNull();
    expect(screen.queryByLabelText("工作台助手输入")).toBeNull();
    expect(screen.queryByTestId("workbench-expanded-layer")).toBeNull();
    expect(screen.queryByTestId("workbench-assistant-drawer")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "展开工作台输入框" }));
    expect(await screen.findByLabelText("工作台助手输入")).not.toBeNull();
    expect(screen.getByTestId("workbench-assistant-shell")).toBe(assistantShell);
    expect(assistantShell.getAttribute("data-shell-mode")).toBe("composer");
    expect(surface.getAttribute("data-surface-mode")).toBe("composer");

    fireEvent.click(screen.getByRole("button", { name: "展开工作台消息层" }));
    expect(screen.getByTestId("workbench-expanded-layer")).not.toBeNull();
    expect(screen.getByTestId("workbench-assistant-shell")).toBe(assistantShell);
    expect(assistantShell.getAttribute("data-shell-mode")).toBe("composer");
    expect(surface.getAttribute("data-surface-mode")).toBe("expanded");

    fireEvent.click(screen.getByRole("button", { name: "收起工作台消息层" }));
    await waitFor(() => expect(screen.queryByTestId("workbench-expanded-layer")).toBeNull(), { timeout: 2000 });
    expect(surface.getAttribute("data-surface-mode")).toBe("composer");
    expect(assistantShell.getAttribute("data-shell-mode")).toBe("composer");
    expect(screen.getByLabelText("工作台助手输入")).not.toBeNull();

    const emptyInput = screen.getByLabelText("工作台助手输入");
    fireEvent.pointerDown(screen.getByTestId("workspace-file-browser"));
    expect(surface.getAttribute("data-surface-mode")).toBe("capsule");
    await waitFor(
      () => {
        expect(emptyInput.isConnected).toBe(false);
      },
      { timeout: 2000 },
    );

    fireEvent.click(screen.getByRole("button", { name: "展开工作台输入框" }));
    const stickyInput = await screen.findByLabelText("工作台助手输入");
    stickyInput.textContent = "保留草稿";
    fireEvent.input(stickyInput);
    fireEvent.pointerDown(screen.getByTestId("workspace-file-browser"));
    expect(surface.getAttribute("data-surface-mode")).toBe("composer");

    fireEvent.click(screen.getByRole("button", { name: "将工作台助手展开到右侧" }));
    expect(screen.getByTestId("workbench-assistant-shell")).toBe(assistantShell);
    expect(assistantShell.getAttribute("data-shell-mode")).toBe("dock-morph");
    expect(assistantShell.getAttribute("data-transition-phase")).toBe("dock-in");
    expect(surface.getAttribute("data-surface-mode")).toBe("composer");
    expect(surface.getAttribute("data-visual-mode")).toBe("dock-morph");
    expect(surface.getAttribute("data-dock-layout")).toBe("overlay");
    expect(surface.getAttribute("data-dock-transition")).toBe("dock-in");
    expect(workspaceShell.getAttribute("data-dock-transitioning")).toBe("true");
    expect(workspaceShell.getAttribute("data-dock-transition-phase")).toBe("dock-in");
    expect(canvasContent.isConnected).toBe(true);
    expect(screen.queryByTestId("workbench-dock-transition-loading")).toBeNull();
    expect(screen.getByTestId("workbench-assistant-morph-panel")).not.toBeNull();
    expect(screen.getByTestId("workbench-assistant-morph-header")).not.toBeNull();
    expect(screen.getByTestId("workbench-assistant-morph-middle")).not.toBeNull();
    expect(screen.getByTestId("workbench-assistant-morph-middle").getAttribute("data-content-state")).toBe("deferred");
    expect(screen.queryByTestId("workbench-assistant-morph-loading")).toBeNull();
    expect(screen.queryByTestId("conversation-panel")).toBeNull();
    expect(screen.getByLabelText("工作台助手输入").textContent).toContain("保留草稿");
    expect(screen.queryByTestId("workbench-assistant-drawer")).toBeNull();
    expect(shell.dataset.rightSidebar).toBe("closed");
    expect(screen.queryByTestId("right-sidebar-initial-page")).toBeNull();
    expect(screen.queryByTestId("workbench-expanded-layer")).toBeNull();
    await waitFor(
      () => {
        expect(surface.getAttribute("data-surface-mode")).toBe("drawer");
      },
      { timeout: 8000 },
    );
    expect(screen.getByTestId("workbench-assistant-drawer")).not.toBeNull();
    expect(surface.getAttribute("data-dock-layout")).toBe("inline");
    expect(surface.getAttribute("data-dock-transition")).toBe("idle");
    expect(workspaceShell.getAttribute("data-assistant-drawer-inline")).toBe("true");
    expect(workspaceShell.getAttribute("data-dock-transitioning")).toBe("false");
    expect(workspaceShell.getAttribute("data-dock-transition-phase")).toBe("idle");
    expect(workspaceShell.style.getPropertyValue("--workbench-assistant-dock-inline-size")).toBe("360px");
    expect(canvasContent.getAttribute("data-render-paused")).toBeNull();
    expect(screen.queryByTestId("workbench-dock-transition-loading")).toBeNull();
    expect(screen.getByTestId("workbench-assistant-shell")).toBe(assistantShell);
    expect(assistantShell.getAttribute("data-transition-phase")).toBe("idle");

    const drawerResizeHandle = screen.getByTestId("workbench-assistant-drawer-resize-handle");
    act(() => {
      dispatchPointer(drawerResizeHandle, "pointerdown", { button: 0, pointerId: 12, clientX: 400 });
    });
    await waitFor(() => {
      expect(drawerResizeHandle.getAttribute("data-dragging")).toBe("true");
    });
    expect(workspaceShell.getAttribute("data-dock-transition-phase")).toBe("idle");
    expect(surface.getAttribute("data-drawer-resizing")).toBe("true");
    act(() => {
      dispatchPointer(window, "pointermove", { pointerId: 12, clientX: 340 });
    });
    await waitFor(() => {
      expect(workspaceShell.style.getPropertyValue("--workbench-assistant-dock-inline-size")).toBe("420px");
      expect(surface.style.getPropertyValue("--workbench-assistant-dock-inline-size")).toBe("420px");
      expect(workspaceShell.getAttribute("data-dock-transition-phase")).toBe("idle");
    });
    act(() => {
      dispatchPointer(window, "pointerup", { pointerId: 12, clientX: 340 });
    });
    await waitFor(() => {
      expect(surface.getAttribute("data-drawer-resizing")).toBe("false");
    });
    fireEvent.doubleClick(drawerResizeHandle);
    await waitFor(() => {
      expect(workspaceShell.style.getPropertyValue("--workbench-assistant-dock-inline-size")).toBe("360px");
    });

    fireEvent.click(screen.getByRole("button", { name: "关闭工作台助手侧栏" }));
    expect(screen.queryByTestId("workbench-assistant-drawer")).toBeNull();
    expect(screen.getByTestId("workbench-assistant-shell")).toBe(assistantShell);
    expect(assistantShell.getAttribute("data-shell-mode")).toBe("dock-out-morph");
    expect(assistantShell.getAttribute("data-transition-phase")).toBe("dock-out");
    expect(surface.getAttribute("data-surface-mode")).toBe("drawer");
    expect(surface.getAttribute("data-visual-mode")).toBe("dock-out-morph");
    expect(surface.getAttribute("data-geometry-mode")).toBe("composer");
    expect(surface.getAttribute("data-dock-layout")).toBe("overlay");
    expect(surface.getAttribute("data-dock-transition")).toBe("dock-out");
    expect(workspaceShell.getAttribute("data-assistant-drawer-inline")).toBe("false");
    expect(workspaceShell.getAttribute("data-dock-transitioning")).toBe("true");
    expect(workspaceShell.getAttribute("data-dock-transition-phase")).toBe("dock-out");
    expect(canvasContent.isConnected).toBe(true);
    expect(screen.queryByTestId("workbench-dock-transition-loading")).toBeNull();
    expect(screen.getByTestId("workbench-assistant-morph-panel")).not.toBeNull();
    expect(screen.getByTestId("workbench-assistant-morph-middle").getAttribute("data-content-state")).toBe("deferred");
    expect(screen.queryByTestId("workbench-assistant-morph-loading")).toBeNull();
    expect(screen.queryByTestId("conversation-panel")).toBeNull();
    expect(screen.getByLabelText("工作台助手输入").textContent).toContain("保留草稿");
    await waitFor(
      () => {
        expect(surface.getAttribute("data-surface-mode")).toBe("composer");
      },
      { timeout: 8000 },
    );
    expect(surface.getAttribute("data-dock-layout")).toBe("overlay");
    expect(surface.getAttribute("data-dock-transition")).toBe("idle");
    expect(workspaceShell.getAttribute("data-dock-transitioning")).toBe("false");
    expect(workspaceShell.getAttribute("data-dock-transition-phase")).toBe("idle");
    expect(canvasContent.getAttribute("data-render-paused")).toBeNull();
    expect(screen.queryByTestId("workbench-dock-transition-loading")).toBeNull();
    expect(screen.getByTestId("workbench-assistant-shell")).toBe(assistantShell);
    expect(assistantShell.getAttribute("data-transition-phase")).toBe("idle");
  }, 20000);

  it("surfaces pending approval in the workbench assistant runtime carrier", async () => {
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

    await waitFor(
      () => {
        expect(surface.getAttribute("data-surface-mode")).toBe("capsule");
        expect(surface.getAttribute("data-message-trigger-state")).toBe("approval");
      },
      { timeout: 2000 },
    );
    expect(surface.getAttribute("data-dock-layout")).toBe("overlay");
    expect(surface.getAttribute("data-dock-transition")).toBe("idle");
    const carrier = screen.getByTestId("workbench-message-carrier");
    expect(carrier.getAttribute("data-state")).toBe("approval");
    expect(carrier.textContent).toContain("等待审批，点击处理");
    expect(screen.queryByTestId("workbench-assistant-drawer")).toBeNull();
    expect(screen.queryByTestId("workbench-approval-prompt")).toBeNull();
    expect(screen.queryByTestId("composer-approval-card")).toBeNull();

    fireEvent.click(carrier);

    expect(await screen.findByTestId("composer-approval-card", undefined, { timeout: 10000 })).not.toBeNull();
    expect(screen.getByText("是否允许执行命令？")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "提交" }));

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

  it("switches app modes without local skeleton placeholders", async () => {
    renderRouter(["/conversation/thread-1"]);

    expect(await screen.findByRole("heading", { name: /thread-1/ }, { timeout: 10000 })).not.toBeNull();
    expect(screen.queryByTestId("workbench-mode-page")).toBeNull();

    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByRole("button", { name: "工作台模式" }));

      expect(screen.getByTestId("app-mode-switch").getAttribute("data-mode")).toBe("workbench");
      expect(screen.getByTestId("app-shell").dataset.appModeLoading).toBeUndefined();
      expect(screen.queryByTestId("app-mode-session-loading-skeleton")).toBeNull();
      expect(screen.queryByTestId("app-mode-content-loading-skeleton")).toBeNull();
      expect(screen.queryByTestId("workbench-mode-page")).toBeNull();

      await act(async () => {
        vi.advanceTimersByTime(180);
        await Promise.resolve();
      });
    } finally {
      vi.useRealTimers();
    }

    expect(await screen.findByTestId("workbench-mode-page", undefined, { timeout: 10000 })).not.toBeNull();
  });

  it("switches to the project mode placeholder without local skeleton placeholders", async () => {
    renderRouter(["/conversation/thread-1"]);

    expect(await screen.findByRole("heading", { name: /thread-1/ }, { timeout: 10000 })).not.toBeNull();
    expect(screen.queryByTestId("project-mode-page")).toBeNull();

    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByRole("button", { name: "项目模式" }));

      expect(screen.getByTestId("app-mode-switch").getAttribute("data-mode")).toBe("project");
      expect(screen.getByTestId("app-shell").dataset.appModeLoading).toBeUndefined();
      expect(screen.queryByTestId("app-mode-session-loading-skeleton")).toBeNull();
      expect(screen.queryByTestId("app-mode-content-loading-skeleton")).toBeNull();
      expect(screen.queryByTestId("project-mode-page")).toBeNull();

      await act(async () => {
        vi.advanceTimersByTime(180);
        await Promise.resolve();
      });
    } finally {
      vi.useRealTimers();
    }

    expect(await screen.findByTestId("project-mode-page", undefined, { timeout: 10000 })).not.toBeNull();
  });
});

interface RenderRouterOptions extends FakeRuntimeOptions {
  extra?: ReactNode;
  starter?: () => Promise<AgentConnection>;
}

interface FakeRuntimeOptions {
  sessionWorkspaceId?: string;
  sessions?: AgentSession[];
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
  let sessions =
    options.sessions ??
    [
      agentSession({
        id: "session 1",
        title: "工作台会话",
        session_type: "workspace",
        workspace_id: sessionWorkspaceId,
        workspace: workspace(sessionWorkspaceId, sessionWorkspaceId === "workspace A" ? "keydex" : "other"),
      }),
    ];
  const listSessions = vi.fn(() =>
    Promise.resolve({
      list: sessions,
      total: sessions.length,
      page: 1,
      page_size: 50,
    }),
  );
  const updateSession = vi.fn((sessionId: string, patch: Partial<AgentSession>) => {
    const current = sessions.find((session) => session.id === sessionId) ?? agentSession({ id: sessionId });
    const updated = {
      ...current,
      ...patch,
      pinned_at:
        patch.pinned === true
          ? current.pinned_at ?? "2026-06-17T11:30:00Z"
          : patch.pinned === false
            ? null
            : current.pinned_at,
      updated_at: "2026-06-17T11:30:00Z",
    };
    sessions = [updated, ...sessions.filter((session) => session.id !== sessionId)];
    return Promise.resolve(updated);
  });
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
      getSettings: vi.fn(() =>
        Promise.resolve({
          model: {
            base_url: "https://api.example/v1",
            model: "qwen-coder",
            timeout_seconds: 60,
            api_key_set: true,
            api_key_preview: "sk-***",
          },
          general: {
            close_window_behavior: null,
          },
          appearance: {
            font_family: "system",
          },
          command: {
            selected_shell: "cmd",
            shell_path: "C:/Windows/System32/cmd.exe",
            shell_label: "CMD",
            shell_edition: null,
            require_approval_for_untrusted: true,
            allow_persistent_trust: true,
            file_access_mode: "workspace_trusted",
            default_timeout_seconds: 120,
            max_timeout_seconds: 600,
            inline_output_max_chars: 12000,
            tail_max_chars: 12000,
            output_file_max_bytes: 8388608,
            progress_interval_ms: 500,
          },
        })),
      saveGeneralSettings: vi.fn(),
      saveAppearanceSettings: vi.fn(),
      saveCommandSettings: vi.fn(),
      listTrustedCommandRules: vi.fn().mockResolvedValue([]),
      updateTrustedCommandRule: vi.fn(),
      deleteTrustedCommandRule: vi.fn(),
      listCommandApprovalHistory: vi.fn().mockResolvedValue({
        list: [],
        total: 0,
        page: 1,
        page_size: 10,
      }),
      getModelDefaults: vi.fn(() =>
        Promise.resolve({
          defaults: {
            default_chat: {
              scope: "default_chat",
              configured: true,
              provider_id: "provider-1",
              provider_name: "默认模型服务",
              model: "qwen-coder",
              provider_enabled: true,
              model_enabled: true,
              missing_reason: null,
            },
            fast: {
              scope: "fast",
              configured: false,
              provider_id: null,
              provider_name: null,
              model: null,
              provider_enabled: null,
              model_enabled: null,
              missing_reason: "not_configured",
            },
          },
        })),
      saveModelDefaults: vi.fn(),
      getExtensionSettings: () => Promise.resolve(defaultExtensionSettings()),
      saveExtensionSettings: vi.fn((payload) => Promise.resolve(payload)),
      resolveApproval: vi.fn((approvalId: string) =>
        Promise.resolve({
          ...commandApproval("session 1", approvalId),
          status: "approved",
          resolved_at: "2026-06-25T12:00:02Z",
        }),
      ),
    },
    models: {
      listProviders: vi.fn(() =>
        Promise.resolve([
          {
            id: "provider-1",
            name: "默认模型服务",
            base_url: "https://api.example/v1",
            enabled: true,
            api_key_set: true,
            api_key_preview: "sk-***",
            models: ["qwen-coder"],
            model_enabled: {},
            health: {},
          },
        ])),
    },
    workspaces: {
      list: vi.fn(() => Promise.resolve({ list: [workspace("workspace A", "keydex")], total: 1 })),
      create: () => Promise.reject(new Error("not implemented")),
      get: vi.fn((workspaceId: string) => Promise.resolve(workspace(workspaceId, workspaceId))),
    },
    workspace: {
      listDirectory,
      readFile: vi.fn((_scope: unknown, path: string) =>
        Promise.resolve({ path, content: "# Workbench file\n\n主区域文件内容", encoding: "utf-8" }),
      ),
      readMedia: vi.fn(),
      search: workspaceSearch,
    },
    desktopPicker: {
      isDirectoryPickerAvailable: () => false,
      pickDirectory: () => Promise.resolve(null),
    },
    conversation: {
      listSessions,
      loadHistory: vi.fn(() =>
        Promise.resolve({
          session: agentSession(),
          list: [],
          next_cursor: null,
          has_more_older: false,
        })),
      createSession,
      getSession: vi.fn(() =>
        Promise.resolve(
          agentSession({
            id: "session 1",
            title: "工作台会话",
            session_type: "workspace",
            workspace_id: sessionWorkspaceId,
            workspace: workspace(sessionWorkspaceId, sessionWorkspaceId === "workspace A" ? "keydex" : "other"),
          }),
        )),
      updateSession,
      deleteSession: vi.fn().mockResolvedValue(undefined),
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

function defaultExtensionSettings() {
  return {
    auto_title: {
      enabled: false,
      only_when_default_title: true,
      max_title_length: 20,
    },
    duplicate_tool_call_guard: {
      enabled: true,
      max_repeats: 3,
    },
    context_compression: {
      enabled: false,
      context_window_tokens: 128000,
      trigger_fraction: 0.75,
      emergency_fraction: 0.9,
      retain_rounds: 2,
    },
  };
}

function WorkbenchFileOpenProbe() {
  const preview = usePreview();
  return (
    <>
      <button type="button" onClick={() => preview.openFilePanel("README.md")}>
        测试打开工作台文件
      </button>
      <button type="button" onClick={() => preview.openPreview({ type: "file", path: "README.md" })}>
        测试打开工作台预览
      </button>
    </>
  );
}

function dispatchPointer(target: EventTarget, type: string, props: Record<string, number>) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries(props)) {
    Object.defineProperty(event, key, { configurable: true, value });
  }
  target.dispatchEvent(event);
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
    terminateCommand: () => undefined,
    requestStatus: () => undefined,
    ping: () => undefined,
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
    current_model_provider_id: "provider-1",
    current_model: "qwen-coder",
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
    tool_name: "run_cmd",
    kind: "exec",
    title: "是否允许执行命令？",
    description: "请求执行命令。",
    details: {
      command: "pnpm test",
      cwd: "D:/repo",
      tool_name: "run_cmd",
      shell: "cmd",
      shell_label: "CMD",
      shell_path: "C:/Windows/System32/cmd.exe",
    },
    status: "pending",
    created_at: "2026-06-25T12:00:01Z",
    resolved_at: null,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}
