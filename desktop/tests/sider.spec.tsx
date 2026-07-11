import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import type { ChatChannel, ListSessionsOptions, RuntimeBridge, WsConnectionStatus } from "@/runtime";
import { Sider } from "@/renderer/components/layout/Sider";
import { emitSessionCreated, emitSessionUpdated } from "@/renderer/events/sessionEvents";
import { AgentSessionProvider } from "@/renderer/providers/AgentSessionProvider";
import { AppContextMenuProvider } from "@/renderer/providers/AppContextMenuProvider";
import { RuntimeConnectionProvider } from "@/renderer/providers/RuntimeConnectionProvider";
import { ThemeProvider } from "@/renderer/providers/ThemeProvider";
import type {
  AgentActionEnvelope,
  AgentChatMessagePayload,
  AgentHistoryResponse,
  AgentSession,
  AgentSessionBranchResponse,
  AgentSessionListResponse,
  CommandApprovalRequest,
  Workspace,
} from "@/types/protocol";

function renderSider(ui: ReactElement) {
  return render(<ThemeProvider>{ui}</ThemeProvider>);
}

function openSessionMenu(title: string) {
  fireEvent.click(screen.getByRole("button", { name: `更多操作 ${title}` }));
  return screen.getByRole("menu", { name: `会话操作 ${title}` });
}

describe("Sider", () => {
  it("renders the personal local navigation without removed AionUi entries", () => {
    const { container } = renderSider(
      <Sider
        projects={[{ id: "project-1", title: "keydex" }]}
        conversations={[{ id: "thread-1", title: "研读文档与 Keydex 源码" }]}
      />,
    );

    expect(screen.getByText("新对话")).not.toBeNull();
    expect(screen.getByText("搜索")).not.toBeNull();
    expect(screen.getByText("keydex")).not.toBeNull();
    expect(screen.getByText("研读文档与 Keydex 源码")).not.toBeNull();
    expect(screen.getByText("设置")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "MCP服务器" })).toBeNull();
    expect(screen.queryByText("Team")).toBeNull();
    expect(screen.queryByText("Cron")).toBeNull();
    expect(screen.queryByText("Scheduled")).toBeNull();
    expect(screen.queryByText("自动化")).toBeNull();
    expect(container.querySelector('section[aria-label="keydex"] svg')).not.toBeNull();
  });

  it("emits navigation requests and toggles theme", () => {
    const onNavigate = vi.fn();
    renderSider(
      <Sider
        activePath="/conversation/thread-1"
        conversations={[{ id: "thread-1", title: "会话 A" }]}
        onNavigate={onNavigate}
      />,
    );

    fireEvent.click(screen.getByText("新对话"));
    fireEvent.click(screen.getByText("会话 A"));
    fireEvent.click(screen.getByText("设置"));
    fireEvent.click(screen.getByLabelText("切换主题"));

    expect(onNavigate).toHaveBeenNthCalledWith(1, "/guid?focus=prompt");
    expect(onNavigate).toHaveBeenNthCalledWith(2, "/conversation/thread-1");
    expect(onNavigate).toHaveBeenNthCalledWith(3, "/settings/general");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(screen.getByRole("button", { name: "会话 A" }).getAttribute("aria-current")).toBe("page");
  });

  it("uses controlled conversations without loading global history and supports workbench session paths", () => {
    const onNavigate = vi.fn();
    const runtime = fakeRuntime([thread({ id: "global-chat", title: "全局会话" })]);

    renderSider(
      <Sider
        appMode="workbench"
        activePath="/workbench/ws-1/session/workbench-thread"
        runtime={runtime}
        projects={[{ id: "ws-1", title: "keydex" }]}
        conversations={[{ id: "workbench-thread", title: "工作台会话" }]}
        showChatBucket={false}
        newConversationPath="/workbench/ws-1"
        getSessionPath={(sessionId) => `/workbench/ws-1/session/${sessionId}`}
        getWorkspaceNewConversationPath={(workspaceId) => `/workbench/${workspaceId ?? "ws-1"}`}
        deleteActiveFallbackPath="/workbench/ws-1"
        onNavigate={onNavigate}
      />,
    );

    expect(runtime.conversation.listSessions).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("选择工作区")).toBeNull();
    expect(screen.getByRole("button", { name: "工作台会话" }).getAttribute("aria-current")).toBe("page");
    expect(screen.queryByRole("region", { name: "项目" })).toBeNull();
    expect(screen.queryByRole("region", { name: "对话" })).toBeNull();
    expect(screen.queryByRole("button", { name: "收起项目 keydex" })).toBeNull();
    expect(screen.queryByRole("button", { name: "在项目 keydex 中新建对话" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "工作台会话" }));
    fireEvent.click(screen.getByRole("button", { name: "新对话" }));

    expect(onNavigate).toHaveBeenNthCalledWith(1, "/workbench/ws-1/session/workbench-thread");
    expect(onNavigate).toHaveBeenNthCalledWith(2, "/workbench/ws-1");
  });

  it("keeps pinned controls in the flat workbench session list", async () => {
    const onNavigate = vi.fn();
    const runtime = fakeRuntime([]);

    renderSider(
      <Sider
        appMode="workbench"
        activePath="/workbench/ws-1/session/workbench-pinned"
        runtime={runtime}
        projects={[{ id: "ws-1", title: "keydex" }]}
        conversations={[
          {
            id: "workbench-pinned",
            title: "置顶工作台会话",
            updatedAt: "2026-06-17T10:30:00Z",
            pinnedAt: "2026-06-17T11:00:00Z",
          },
          {
            id: "workbench-regular",
            title: "普通工作台会话",
            updatedAt: "2026-06-17T10:20:00Z",
          },
        ]}
        showChatBucket={false}
        newConversationPath="/workbench/ws-1"
        getSessionPath={(sessionId) => `/workbench/ws-1/session/${sessionId}`}
        onNavigate={onNavigate}
      />,
    );

    const pinned = screen.getByRole("region", { name: "置顶" });
    const flatList = screen.getByRole("region", { name: "keydex列表" });
    expect(within(pinned).getByRole("button", { name: "置顶工作台会话" })).not.toBeNull();
    expect(within(pinned).queryByRole("button", { name: "普通工作台会话" })).toBeNull();
    expect(within(flatList).getByRole("button", { name: "普通工作台会话" })).not.toBeNull();
    expect(within(flatList).queryByRole("button", { name: "置顶工作台会话" })).toBeNull();
    expect(screen.queryByRole("region", { name: "项目" })).toBeNull();
    expect(screen.queryByRole("region", { name: "对话" })).toBeNull();
    expect(screen.queryByRole("button", { name: "收起项目 keydex" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "置顶 普通工作台会话" }));
    await waitFor(() => {
      expect(runtime.conversation.updateSession).toHaveBeenCalledWith("workbench-regular", { pinned: true });
    });

    fireEvent.click(screen.getByRole("button", { name: "取消置顶 置顶工作台会话" }));
    await waitFor(() => {
      expect(runtime.conversation.updateSession).toHaveBeenLastCalledWith("workbench-pinned", { pinned: false });
    });
  });

  it("opens a new chat page scoped to a project from the project header", () => {
    const onNavigate = vi.fn();
    renderSider(
      <Sider
        projects={[{ id: "project-1", title: "keydex" }]}
        conversations={[{ id: "thread-1", title: "会话 A" }]}
        onNavigate={onNavigate}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "在项目 keydex 中新建对话" }));

    expect(onNavigate).toHaveBeenCalledWith("/guid?workspaceId=project-1&focus=prompt");
    expect(screen.getByRole("button", { name: "收起项目 keydex" }).getAttribute("aria-expanded")).toBe("true");
  });

  it("highlights route-aware shell entries without turning projects into fake routes", () => {
    renderSider(
      <Sider
        activePath="/guid"
        projects={[{ id: "project-1", title: "keydex" }]}
        conversations={[{ id: "thread-1", title: "会话 A" }]}
      />,
    );

    expect(screen.getByRole("button", { name: "新对话" }).getAttribute("data-active")).toBe("true");
    expect(screen.getByText("keydex").getAttribute("role")).toBeNull();
  });

  it("keeps history rows quiet with weak time metadata and no native title popup", () => {
    renderSider(
      <Sider
        activePath="/conversation/thread-1"
        conversations={[{ id: "thread-1", title: "会话 A", updatedAt: "2026-06-17T10:00:00Z" }]}
      />,
    );

    const button = screen.getByRole("button", { name: "会话 A" });
    const row = button.parentElement;
    expect(button.getAttribute("title")).toBeNull();
    expect(row?.querySelector("time")?.getAttribute("datetime")).toBe("2026-06-17T10:00:00Z");
    expect(button.getAttribute("aria-current")).toBe("page");
  });

  it("uses icon-only collapsed affordances", () => {
    renderSider(<Sider collapsed conversations={[]} />);

    expect(screen.getByTitle("新对话")).not.toBeNull();
    expect(screen.getByTitle("搜索")).not.toBeNull();
    expect(screen.getByTitle("切换主题")).not.toBeNull();
    expect(screen.getByTitle("设置")).not.toBeNull();
  });

  it("renders the sidebar collapse control in the main navigation list", () => {
    const onToggleSidebar = vi.fn();
    const { rerender } = renderSider(<Sider conversations={[]} onToggleSidebar={onToggleSidebar} />);

    const collapseButton = screen.getByRole("button", { name: "折叠侧边栏" });
    expect(collapseButton.getAttribute("data-icon")).toBe("panel-left-close");
    expect(collapseButton.parentElement?.getAttribute("aria-label")).toBe("主导航");

    fireEvent.click(collapseButton);
    expect(onToggleSidebar).toHaveBeenCalledTimes(1);

    rerender(
      <ThemeProvider>
        <Sider collapsed conversations={[]} onToggleSidebar={onToggleSidebar} />
      </ThemeProvider>,
    );

    expect(screen.getByRole("button", { name: "展开侧边栏" }).getAttribute("data-icon")).toBe("panel-left-open");
  });

  it("hides the footer feather when the history list is scrolled to the bottom", () => {
    renderSider(
      <Sider
        conversations={[
          { id: "thread-1", title: "会话 A" },
          { id: "thread-2", title: "会话 B" },
          { id: "thread-3", title: "会话 C" },
        ]}
      />,
    );

    const sider = screen.getByLabelText("侧边栏");
    const history = screen.getByLabelText("会话历史") as HTMLDivElement;
    Object.defineProperty(history, "scrollHeight", { configurable: true, value: 300 });
    Object.defineProperty(history, "clientHeight", { configurable: true, value: 100 });
    Object.defineProperty(history, "scrollTop", { configurable: true, writable: true, value: 0 });

    fireEvent.scroll(history);
    expect(sider.getAttribute("data-footer-feather")).toBe("true");

    history.scrollTop = 200;
    fireEvent.scroll(history);
    expect(sider.getAttribute("data-footer-feather")).toBe("false");
  });

  it("keeps collapsed sessions as center rail buttons with hover cards", () => {
    const onNavigate = vi.fn();
    renderSider(
      <Sider
        collapsed
        activePath="/conversation/thread-1"
        conversations={[{ id: "thread-1", title: "研读文档", updatedAt: "2026-06-17T10:00:00Z" }]}
        onNavigate={onNavigate}
      />,
    );

    const button = screen.getByRole("button", { name: "打开会话 研读文档" });
    expect(button.getAttribute("aria-current")).toBe("page");
    expect(screen.queryByText("研读文档")).toBeNull();

    fireEvent.mouseEnter(button);

    const card = screen.getByRole("tooltip");
    expect(card.textContent).toContain("研读文档");
    expect(card.textContent).toContain("当前会话");

    fireEvent.click(button);
    expect(onNavigate).toHaveBeenCalledWith("/conversation/thread-1");
  });

  it("shows the same session hover card for expanded history rows", () => {
    renderSider(
      <Sider
        activePath="/conversation/thread-1"
        conversations={[{ id: "thread-1", title: "研读文档", updatedAt: "2026-06-17T10:00:00Z" }]}
      />,
    );

    const button = screen.getByRole("button", { name: "研读文档" });
    expect(screen.queryByRole("tooltip")).toBeNull();

    fireEvent.mouseEnter(button.parentElement as HTMLElement);

    const card = screen.getByRole("tooltip");
    expect(card.textContent).toContain("研读文档");
    expect(card.textContent).toContain("当前会话");
  });

  it("opens a session search dialog from the top search action", async () => {
    const runtime = fakeRuntime([
      thread({ id: "thread-a", title: "研读源码" }),
      thread({ id: "thread-b", title: "修复按钮" }),
    ]);
    const onNavigate = vi.fn();

    renderSider(<Sider runtime={runtime} onNavigate={onNavigate} />);

    expect(await screen.findByText("研读源码")).not.toBeNull();
    expect(screen.getByText("修复按钮")).not.toBeNull();
    expect(runtime.conversation.listSessions).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByText("搜索"));
    const dialog = screen.getByRole("dialog", { name: "搜索会话" });
    fireEvent.change(within(dialog).getByLabelText("搜索会话"), { target: { value: "修复" } });

    expect(within(dialog).queryByText("研读源码")).toBeNull();
    expect(within(dialog).getByText("修复按钮")).not.toBeNull();
    expect(runtime.conversation.listSessions).toHaveBeenCalledTimes(1);

    fireEvent.click(within(dialog).getByText("修复按钮"));
    expect(onNavigate).toHaveBeenCalledWith("/conversation/thread-b");
  });

  it("keeps loaded session history across sidebar remounts and local session inserts", async () => {
    const runtime = fakeRuntime([thread({ id: "thread-a", title: "已有会话" })]);

    const view = renderSider(<Sider runtime={runtime} />);

    expect(await screen.findByRole("button", { name: "已有会话" })).not.toBeNull();
    expect(runtime.conversation.listSessions).toHaveBeenCalledTimes(1);

    act(() => {
      emitSessionCreated(thread({ id: "thread-new", title: "新会话", updated_at: "2026-06-17T11:00:00Z" }));
    });

    expect(screen.getByRole("button", { name: "新会话" })).not.toBeNull();
    view.unmount();

    renderSider(<Sider runtime={runtime} />);

    expect(screen.getByRole("button", { name: "新会话" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "已有会话" })).not.toBeNull();
    expect(screen.queryByTestId("sidebar-session-skeleton")).toBeNull();
    expect(runtime.conversation.listSessions).toHaveBeenCalledTimes(1);
  });

  it("moves only the updated session to the top without reloading session history", async () => {
    const runtime = fakeRuntime([
      thread({ id: "thread-newer", title: "较新的会话", updated_at: "2026-06-17T10:30:00Z" }),
      thread({ id: "thread-older", title: "继续历史会话", updated_at: "2026-06-17T10:20:00Z" }),
    ]);

    renderSider(<Sider runtime={runtime} />);

    const newerButton = await screen.findByRole("button", { name: "较新的会话" });
    const olderButton = screen.getByRole("button", { name: "继续历史会话" });
    const olderRow = olderButton.parentElement;
    expect(runtime.conversation.listSessions).toHaveBeenCalledTimes(1);

    act(() => {
      emitSessionUpdated({ id: "thread-older", updated_at: "2026-06-17T11:00:00Z" });
    });

    const movedButton = screen.getByRole("button", { name: "继续历史会话" });
    expect(movedButton.parentElement).toBe(olderRow);
    expect(Boolean(movedButton.compareDocumentPosition(newerButton) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(runtime.conversation.listSessions).toHaveBeenCalledTimes(1);
  });

  it("preserves locally inserted sessions when the initial history request resolves late", async () => {
    const deferred = createDeferred<AgentSessionListResponse>();
    const runtime = fakeRuntime([]);
    runtime.conversation.listSessions = vi.fn(() => deferred.promise);

    renderSider(<Sider runtime={runtime} />);

    act(() => {
      emitSessionCreated(thread({ id: "thread-new", title: "新会话", updated_at: "2026-06-17T11:00:00Z" }));
    });

    expect(screen.getByRole("button", { name: "新会话" })).not.toBeNull();

    await act(async () => {
      deferred.resolve({
        list: [thread({ id: "thread-a", title: "已有会话" })],
        total: 1,
        page: 1,
        page_size: 50,
      });
      await deferred.promise;
    });

    expect(screen.getByRole("button", { name: "新会话" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "已有会话" })).not.toBeNull();
  });

  it("does not load backend history before the runtime connection is ready", async () => {
    const deferred = createDeferred<{
      host: string;
      port: number;
      base_url: string;
      data_dir: string;
    }>();
    const runtime = fakeRuntime([thread({ id: "thread-a", title: "启动后会话" })]);

    renderSider(
      <RuntimeConnectionProvider
        runtime={runtime}
        starter={() => deferred.promise}
        isDesktopRuntime={() => true}
      >
        <Sider runtime={runtime} />
      </RuntimeConnectionProvider>,
    );

    const loadingState = screen.getByRole("status", { name: "正在加载会话" });
    expect(screen.getByTestId("sidebar-session-skeleton")).toBe(loadingState);
    const loadingShell = screen.getByTestId("sidebar-session-skeleton-shell");
    expect(loadingShell.contains(loadingState)).toBe(true);
    expect(loadingShell.closest('[aria-label="会话历史"]')?.getAttribute("data-loading")).toBe("true");
    expect(loadingState.querySelector("svg")).toBeNull();
    expect(screen.queryByRole("region", { name: "项目" })).toBeNull();
    expect(screen.queryByRole("region", { name: "对话" })).toBeNull();
    expect(screen.queryByText("正在连接本地服务")).toBeNull();
    expect(runtime.conversation.listSessions).not.toHaveBeenCalled();

    await act(async () => {
      deferred.resolve({
        host: "127.0.0.1",
        port: 9234,
        base_url: "http://127.0.0.1:9234",
        data_dir: "D:/Keydex",
      });
      await deferred.promise;
    });

    expect(await screen.findByText("启动后会话")).not.toBeNull();
    expect(runtime.conversation.listSessions).toHaveBeenCalledTimes(1);
  });

  it("groups loaded sessions by their real workspace and pure chat bucket", async () => {
    const runtime = fakeRuntime([
      thread({
        id: "workspace-a",
        title: "项目会话 A",
        session_type: "workspace",
        workspace_id: "ws-1",
        workspace: workspace("ws-1", "keydex"),
      }),
      thread({
        id: "workspace-b",
        title: "项目会话 B",
        session_type: "workspace",
        workspace_id: "ws-2",
        workspace: workspace("ws-2", "kt-agent-framework"),
      }),
      thread({ id: "chat-a", title: "纯聊天" }),
    ]);

    renderSider(<Sider runtime={runtime} activePath="/conversation/workspace-a" />);

    expect(await screen.findByText("keydex")).not.toBeNull();
    expect(screen.getByText("kt-agent-framework")).not.toBeNull();
    expect(screen.getByRole("region", { name: "项目" })).not.toBeNull();
    expect(screen.getByRole("region", { name: "对话" })).not.toBeNull();
    expect(screen.getByRole("region", { name: "对话列表" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "收起项目区域" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "收起对话区域" })).not.toBeNull();
    const keydexToggle = screen.getByRole("button", { name: "收起项目 keydex" });
    expect(keydexToggle.getAttribute("aria-expanded")).toBe("true");
    expect(keydexToggle.querySelector(".lucide-folder-open")).not.toBeNull();
    expect(keydexToggle.querySelector(".lucide-chevron-down")).not.toBeNull();
    expect(screen.getByRole("button", { name: "项目会话 A" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: "项目会话 B" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "纯聊天" })).not.toBeNull();

    fireEvent.click(keydexToggle);
    const collapsedKeydexToggle = screen.getByRole("button", { name: "展开项目 keydex" });
    expect(collapsedKeydexToggle.getAttribute("aria-expanded")).toBe("false");
    expect(collapsedKeydexToggle.querySelector(".lucide-folder")).not.toBeNull();
    expect(collapsedKeydexToggle.querySelector(".lucide-folder-open")).toBeNull();
    expect(collapsedKeydexToggle.querySelector(".lucide-chevron-down")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "项目会话 A" })).toBeNull();

    fireEvent.click(collapsedKeydexToggle);
    expect(screen.getByRole("button", { name: "收起项目 keydex" }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "项目会话 A" })).not.toBeNull();
  });

  it("expands a collapsed bucket when navigation targets one of its sessions", async () => {
    const runtime = fakeRuntime([
      thread({
        id: "workspace-a",
        title: "项目会话 A",
        session_type: "workspace",
        workspace_id: "ws-1",
        workspace: workspace("ws-1", "keydex"),
      }),
      thread({ id: "chat-a", title: "纯聊天" }),
    ]);

    const view = renderSider(<Sider runtime={runtime} activePath="/conversation/chat-a" />);

    await screen.findByText("keydex");
    fireEvent.click(screen.getByRole("button", { name: "收起项目区域" }));
    expect(screen.queryByRole("button", { name: "项目会话 A" })).toBeNull();

    view.rerender(
      <ThemeProvider>
        <Sider runtime={runtime} activePath="/conversation/workspace-a" />
      </ThemeProvider>,
    );

    expect(screen.getByRole("button", { name: "收起项目区域" }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "项目会话 A" }).getAttribute("aria-current")).toBe("page");
  });

  it("expands workspace session history ten rows at a time", async () => {
    const allWorkspaceThreads = Array.from({ length: 17 }, (_, index) =>
      thread({
        id: `workspace-${index + 1}`,
        title: `项目会话 ${index + 1}`,
        session_type: "workspace",
        workspace_id: "ws-1",
        workspace: workspace("ws-1", "keydex"),
        updated_at: `2026-06-17T10:${String(59 - index).padStart(2, "0")}:00Z`,
      }),
    );
    const initialThreads = allWorkspaceThreads.slice(0, 6);
    const listSessions = vi.fn((options?: ListSessionsOptions) => {
      const list = options?.workspaceId === "ws-1" ? allWorkspaceThreads : initialThreads;
      return Promise.resolve({
        list,
        total: list.length,
        page: options?.page ?? 1,
        page_size: options?.pageSize ?? 50,
      });
    });
    const runtime = fakeRuntime(initialThreads);
    runtime.conversation.listSessions = listSessions;

    renderSider(<Sider runtime={runtime} />);

    const group = await screen.findByRole("region", { name: "keydex" });
    expect(within(group).getByRole("button", { name: "项目会话 5" })).not.toBeNull();
    expect(within(group).queryByRole("button", { name: "项目会话 6" })).toBeNull();
    expect(within(group).queryByRole("button", { name: "项目会话 16" })).toBeNull();

    const expandButton = within(group).getByRole("button", { name: "展开 keydex 会话历史" });
    expect(expandButton.textContent).toContain("展开会话");
    expect(group.querySelector('[data-history-extra-items="true"]')?.getAttribute("data-expanded")).toBe("false");
    fireEvent.click(expandButton);

    await waitFor(() => {
      expect(listSessions).toHaveBeenCalledWith({
        sessionType: "workspace",
        workspaceId: "ws-1",
        page: 1,
        pageSize: 100,
      });
    });
    expect(await within(group).findByRole("button", { name: "项目会话 15" })).not.toBeNull();
    expect(within(group).queryByRole("button", { name: "项目会话 16" })).toBeNull();
    expect(group.querySelector('[data-history-extra-items="true"]')?.getAttribute("data-expanded")).toBe("true");
    expect(within(group).getByRole("button", { name: "展开 keydex 会话历史" })).not.toBeNull();
    expect(within(group).getByRole("button", { name: "折叠 keydex 会话历史" })).not.toBeNull();

    fireEvent.click(within(group).getByRole("button", { name: "展开 keydex 会话历史" }));
    expect(await within(group).findByRole("button", { name: "项目会话 17" })).not.toBeNull();
    expect(within(group).queryByRole("button", { name: "展开 keydex 会话历史" })).toBeNull();

    const collapseButton = within(group).getByRole("button", { name: "折叠 keydex 会话历史" });
    expect(collapseButton.textContent).toContain("折叠会话");
    fireEvent.click(collapseButton);

    expect(group.querySelector('[data-history-extra-items="true"]')?.getAttribute("data-expanded")).toBe("false");
    expect(within(group).queryByRole("button", { name: "项目会话 6" })).toBeNull();
    expect(within(group).queryByRole("button", { name: "项目会话 17" })).toBeNull();
    expect(within(group).getByRole("button", { name: "展开 keydex 会话历史" })).not.toBeNull();
    expect(within(group).queryByRole("button", { name: "折叠 keydex 会话历史" })).toBeNull();
  });

  it("expands hidden session history when navigation targets an overflow item", async () => {
    const allWorkspaceThreads = Array.from({ length: 7 }, (_, index) =>
      thread({
        id: `workspace-${index + 1}`,
        title: `项目会话 ${index + 1}`,
        session_type: "workspace",
        workspace_id: "ws-1",
        workspace: workspace("ws-1", "keydex"),
        updated_at: `2026-06-17T10:${String(59 - index).padStart(2, "0")}:00Z`,
      }),
    );
    const runtime = fakeRuntime(allWorkspaceThreads);

    const view = renderSider(<Sider runtime={runtime} activePath="/conversation/workspace-1" />);

    const group = await screen.findByRole("region", { name: "keydex" });
    expect(within(group).getByRole("button", { name: "项目会话 5" })).not.toBeNull();
    expect(within(group).queryByRole("button", { name: "项目会话 6" })).toBeNull();

    view.rerender(
      <ThemeProvider>
        <Sider runtime={runtime} activePath="/conversation/workspace-6" />
      </ThemeProvider>,
    );

    expect(group.querySelector('[data-history-extra-items="true"]')?.getAttribute("data-expanded")).toBe("true");
    expect(within(group).getByRole("button", { name: "项目会话 6" }).getAttribute("aria-current")).toBe("page");
  });

  it("renders pinned sessions above project groups without duplicating them", async () => {
    const pinnedThreads = Array.from({ length: 6 }, (_, index) =>
      thread({
        id: `pinned-${index + 1}`,
        title: `置顶会话 ${index + 1}`,
        session_type: "workspace",
        workspace_id: "ws-1",
        workspace: workspace("ws-1", "keydex"),
        pinned: true,
        pinned_at: `2026-06-17T11:${String(59 - index).padStart(2, "0")}:00Z`,
        updated_at: `2026-06-17T10:${String(59 - index).padStart(2, "0")}:00Z`,
      }),
    );
    const runtime = fakeRuntime([
      ...pinnedThreads,
      thread({
        id: "regular-1",
        title: "普通项目会话",
        session_type: "workspace",
        workspace_id: "ws-1",
        workspace: workspace("ws-1", "keydex"),
      }),
    ]);

    renderSider(<Sider runtime={runtime} />);

    const pinned = await screen.findByRole("region", { name: "置顶" });
    const project = await screen.findByRole("region", { name: "keydex" });
    expect(within(pinned).getByRole("button", { name: "收起置顶区域" }).querySelector(".lucide-pin")).toBeNull();
    expect(Boolean(pinned.compareDocumentPosition(project) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(within(pinned).getByRole("button", { name: "置顶会话 1" })).not.toBeNull();
    expect(within(pinned).getByRole("button", { name: "置顶会话 5" })).not.toBeNull();
    expect(within(pinned).queryByRole("button", { name: "置顶会话 6" })).toBeNull();
    expect(within(project).queryByRole("button", { name: "置顶会话 1" })).toBeNull();
    expect(within(project).getByRole("button", { name: "普通项目会话" })).not.toBeNull();

    fireEvent.click(within(pinned).getByRole("button", { name: "展开 置顶 会话历史" }));
    expect(within(pinned).getByRole("button", { name: "置顶会话 6" })).not.toBeNull();

    fireEvent.click(within(pinned).getByRole("button", { name: "收起置顶区域" }));
    expect(within(pinned).queryByRole("button", { name: "置顶会话 1" })).toBeNull();
  });

  it("pins and unpins a session through updateSession", async () => {
    const runtime = fakeRuntime([thread({ id: "thread-pin", title: "待置顶会话" })]);

    renderSider(<Sider runtime={runtime} />);

    const emptyPinned = await screen.findByRole("region", { name: "置顶" });
    expect(within(emptyPinned).getByText("暂无置顶")).not.toBeNull();
    expect(within(emptyPinned).getByRole("button", { name: "收起置顶区域" }).querySelector(".lucide-pin")).toBeNull();
    await screen.findByRole("button", { name: "待置顶会话" });
    const pinButton = screen.getByRole("button", { name: "置顶 待置顶会话" });
    const emptyPinIcon = pinButton.querySelector("svg");
    expect(emptyPinIcon?.classList.contains("lucide-pin")).toBe(true);
    expect(emptyPinIcon?.classList.contains("lucide-pin-off")).toBe(false);
    fireEvent.click(pinButton);

    await waitFor(() => {
      expect(runtime.conversation.updateSession).toHaveBeenCalledWith("thread-pin", { pinned: true });
    });
    const pinned = await screen.findByRole("region", { name: "置顶" });
    expect(within(pinned).getByRole("button", { name: "待置顶会话" })).not.toBeNull();

    const unpinButton = screen.getByRole("button", { name: "取消置顶 待置顶会话" });
    expect(unpinButton.querySelector("svg")?.classList.contains("lucide-pin-off")).toBe(true);
    fireEvent.click(unpinButton);
    await waitFor(() => {
      expect(runtime.conversation.updateSession).toHaveBeenLastCalledWith("thread-pin", { pinned: false });
    });
    const emptyPinnedAgain = screen.getByRole("region", { name: "置顶" });
    expect(within(emptyPinnedAgain).getByText("暂无置顶")).not.toBeNull();
    expect(within(emptyPinnedAgain).queryByRole("button", { name: "待置顶会话" })).toBeNull();
  });

  it("collapses history buckets and starts the requested new chat type", async () => {
    const onNavigate = vi.fn();
    const runtime = fakeRuntime([
      thread({
        id: "workspace-a",
        title: "项目会话 A",
        session_type: "workspace",
        workspace_id: "ws-1",
        workspace: workspace("ws-1", "keydex"),
      }),
      thread({ id: "chat-a", title: "纯聊天" }),
    ]);

    renderSider(<Sider runtime={runtime} onNavigate={onNavigate} />);

    expect(await screen.findByRole("button", { name: "项目会话 A" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "纯聊天" })).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "新建项目对话" }));
    fireEvent.click(screen.getByRole("button", { name: "新建无项目对话" }));

    expect(onNavigate).toHaveBeenNthCalledWith(1, "/guid?workspaceId=ws-1&focus=prompt");
    expect(onNavigate).toHaveBeenNthCalledWith(2, "/guid?sessionType=chat&focus=prompt");

    fireEvent.click(screen.getByRole("button", { name: "收起项目区域" }));
    expect(screen.queryByRole("button", { name: "项目会话 A" })).toBeNull();
    expect(screen.getByRole("button", { name: "展开项目区域" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "纯聊天" })).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "收起对话区域" }));
    expect(screen.queryByRole("button", { name: "纯聊天" })).toBeNull();
    expect(screen.getByRole("button", { name: "展开对话区域" })).not.toBeNull();
  });

  it("shows workspace ownership in collapsed session hover cards", async () => {
    const runtime = fakeRuntime([
      thread({
        id: "workspace-a",
        title: "项目会话 A",
        session_type: "workspace",
        workspace_id: "ws-1",
        workspace: workspace("ws-1", "keydex"),
      }),
    ]);

    renderSider(<Sider runtime={runtime} collapsed activePath="/conversation/workspace-a" />);

    const projectToggle = await screen.findByRole("button", { name: "收起项目 keydex" });
    expect(projectToggle.getAttribute("aria-expanded")).toBe("true");
    expect(projectToggle.getAttribute("title")).toBeNull();
    expect(projectToggle.querySelector(".lucide-folder-open")).not.toBeNull();
    fireEvent.mouseEnter(projectToggle);
    expect(screen.getByRole("tooltip").textContent).toContain("keydex");
    expect(screen.getByRole("tooltip").textContent).toContain("当前项目");
    expect(screen.getByRole("tooltip").textContent).toContain("已展开");
    fireEvent.mouseLeave(projectToggle);

    const button = await screen.findByRole("button", { name: "打开会话 项目会话 A" });
    fireEvent.mouseEnter(button);

    const card = screen.getByRole("tooltip");
    expect(card.textContent).toContain("项目会话 A");
    expect(card.textContent).toContain("keydex");
    expect(card.textContent).toContain("当前会话");

    fireEvent.click(projectToggle);
    const collapsedProjectToggle = screen.getByRole("button", { name: "展开项目 keydex" });
    expect(collapsedProjectToggle.getAttribute("aria-expanded")).toBe("false");
    expect(collapsedProjectToggle.querySelector(".lucide-folder")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "打开会话 项目会话 A" })).toBeNull();
    fireEvent.mouseEnter(collapsedProjectToggle);
    expect(screen.getByRole("tooltip").textContent).toContain("已收起");
    fireEvent.mouseLeave(collapsedProjectToggle);

    fireEvent.click(collapsedProjectToggle);
    expect(screen.getByRole("button", { name: "收起项目 keydex" }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("button", { name: "打开会话 项目会话 A" })).not.toBeNull();
  });

  it("shows background streaming and unread indicators from the shared agent runtime", async () => {
    let emit: (event: AgentActionEnvelope) => void = () => undefined;
    const requestStatus = vi.fn();
    const runtime = fakeRuntime([
      thread({ id: "thread-a", title: "当前会话" }),
      thread({ id: "thread-b", title: "后台会话" }),
    ]);
    const channel: ChatChannel = {
      close: vi.fn(),
      getStatus: vi.fn<() => WsConnectionStatus>(() => "open"),
      getSessionId: vi.fn(() => null),
      createSession: vi.fn(),
      bindSession: vi.fn(),
      unbindSession: vi.fn(),
      chat: vi.fn(),
      submitA2UI: vi.fn(),
      cancelA2UI: vi.fn(),
      approvalDecision: vi.fn(),
      cancel: vi.fn(),
      terminateCommand: vi.fn(),
      requestStatus,
      ping: vi.fn(),
    };
    runtime.conversation.openChatChannel = vi.fn((onEvent, options?: { onStatus?: (status: "open") => void }) => {
      emit = onEvent;
      options?.onStatus?.("open");
      return channel;
    });

    renderSider(
      <AgentSessionProvider runtime={runtime}>
        <Sider runtime={runtime} activePath="/conversation/thread-a" />
      </AgentSessionProvider>,
    );

    await screen.findByText("后台会话");
    await waitFor(() => expect(requestStatus).toHaveBeenCalled());

    act(() => {
      emit({
        action: "status",
        data: {
          status: "idle",
          running_sessions: [{ session_id: "thread-b" }],
        },
      });
      emit({ action: "stream", data: { session_id: "thread-b", content: "后台输出" } });
    });

    const backgroundButton = screen.getByRole("button", { name: "后台会话" });
    const backgroundRow = backgroundButton.parentElement!;
    const loadingIndicator = backgroundRow.querySelector('[data-session-indicators="true"]');
    expect(loadingIndicator?.getAttribute("data-streaming")).toBe("true");
    expect(loadingIndicator?.getAttribute("data-unread")).toBe("false");
    expect(backgroundRow.querySelector("time")).toBeNull();

    act(() => {
      emit({ action: "completed", data: { session_id: "thread-b", status: "completed", events: [] } });
    });

    const completedIndicator = backgroundRow.querySelector('[data-session-indicators="true"]');
    expect(completedIndicator?.getAttribute("data-streaming")).toBe("false");
    expect(completedIndicator?.getAttribute("data-unread")).toBe("true");
    expect(screen.getByRole("button", { name: "当前会话" }).parentElement?.querySelector('[data-unread="true"]')).toBeNull();
  });

  it("updates loaded session titles from realtime title update events", async () => {
    let emit: (event: AgentActionEnvelope) => void = () => undefined;
    const runtime = fakeRuntime([thread({ id: "thread-a", title: "临时标题", title_source: "auto_candidate" })]);
    const channel: ChatChannel = {
      close: vi.fn(),
      getStatus: vi.fn<() => WsConnectionStatus>(() => "open"),
      getSessionId: vi.fn(() => null),
      createSession: vi.fn(),
      bindSession: vi.fn(),
      unbindSession: vi.fn(),
      chat: vi.fn(),
      submitA2UI: vi.fn(),
      cancelA2UI: vi.fn(),
      approvalDecision: vi.fn(),
      cancel: vi.fn(),
      terminateCommand: vi.fn(),
      requestStatus: vi.fn(),
      ping: vi.fn(),
    };
    runtime.conversation.openChatChannel = vi.fn((onEvent, options?: { onStatus?: (status: "open") => void }) => {
      emit = onEvent;
      options?.onStatus?.("open");
      return channel;
    });

    renderSider(
      <AgentSessionProvider runtime={runtime}>
        <Sider runtime={runtime} activePath="/conversation/thread-a" />
      </AgentSessionProvider>,
    );

    expect(await screen.findByRole("button", { name: "临时标题" })).not.toBeNull();

    act(() => {
      emit({
        action: "session_title_updated",
        data: {
          session_id: "thread-a",
          title: "自动标题",
          title_source: "auto",
          updated_at: "2026-06-17T11:00:00Z",
        },
      });
    });

    expect(screen.getByRole("button", { name: "自动标题" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "临时标题" })).toBeNull();
  });

  it("keeps waiting approval indicator visible until approval is resolved", async () => {
    let emit: (event: AgentActionEnvelope) => void = () => undefined;
    const onNavigate = vi.fn();
    const runtime = fakeRuntime([
      thread({ id: "thread-a", title: "当前会话" }),
      thread({ id: "thread-b", title: "待审批会话" }),
    ]);
    const channel: ChatChannel = {
      close: vi.fn(),
      getStatus: vi.fn<() => WsConnectionStatus>(() => "open"),
      getSessionId: vi.fn(() => null),
      createSession: vi.fn(),
      bindSession: vi.fn(),
      unbindSession: vi.fn(),
      chat: vi.fn(),
      submitA2UI: vi.fn(),
      cancelA2UI: vi.fn(),
      approvalDecision: vi.fn(),
      cancel: vi.fn(),
      terminateCommand: vi.fn(),
      requestStatus: vi.fn(),
      ping: vi.fn(),
    };
    runtime.conversation.openChatChannel = vi.fn((onEvent, options?: { onStatus?: (status: "open") => void }) => {
      emit = onEvent;
      options?.onStatus?.("open");
      return channel;
    });

    renderSider(
      <AgentSessionProvider runtime={runtime}>
        <Sider runtime={runtime} activePath="/conversation/thread-a" onNavigate={onNavigate} />
      </AgentSessionProvider>,
    );

    await screen.findByText("待审批会话");

    act(() => {
      emit({
        action: "approval_requested",
        data: { session_id: "thread-b", approval: commandApproval("thread-b", "approval-1") },
      });
    });

    const backgroundButton = screen.getByRole("button", { name: "待审批会话" });
    const backgroundRow = backgroundButton.parentElement!;
    let indicator = backgroundRow.querySelector('[data-session-indicators="true"]');
    expect(indicator?.getAttribute("data-waiting-approval")).toBe("true");
    expect(indicator?.textContent).toContain("等待批准");
    expect(backgroundRow.querySelector("time")).toBeNull();

    fireEvent.click(backgroundButton);
    expect(onNavigate).toHaveBeenCalledWith("/conversation/thread-b");
    indicator = backgroundRow.querySelector('[data-session-indicators="true"]');
    expect(indicator?.getAttribute("data-waiting-approval")).toBe("true");

    act(() => {
      emit({
        action: "approval_resolved",
        data: {
          session_id: "thread-b",
          approval: { ...commandApproval("thread-b", "approval-1"), status: "approved" },
        },
      });
    });

    expect(backgroundRow.querySelector('[data-waiting-approval="true"]')).toBeNull();
  });

  it("shows waiting interaction instead of waiting approval for A2UI input blocking", async () => {
    let emit: (event: AgentActionEnvelope) => void = () => undefined;
    const runtime = fakeRuntime([
      thread({ id: "thread-a", title: "当前会话" }),
      thread({ id: "thread-b", title: "交互会话" }),
    ]);
    const channel: ChatChannel = {
      close: vi.fn(),
      getStatus: vi.fn<() => WsConnectionStatus>(() => "open"),
      getSessionId: vi.fn(() => null),
      createSession: vi.fn(),
      bindSession: vi.fn(),
      unbindSession: vi.fn(),
      chat: vi.fn(),
      submitA2UI: vi.fn(),
      cancelA2UI: vi.fn(),
      approvalDecision: vi.fn(),
      cancel: vi.fn(),
      terminateCommand: vi.fn(),
      requestStatus: vi.fn(),
      ping: vi.fn(),
    };
    runtime.conversation.openChatChannel = vi.fn((onEvent, options?: { onStatus?: (status: "open") => void }) => {
      emit = onEvent;
      options?.onStatus?.("open");
      return channel;
    });

    renderSider(
      <AgentSessionProvider runtime={runtime}>
        <Sider runtime={runtime} activePath="/conversation/thread-a" />
      </AgentSessionProvider>,
    );

    await screen.findByText("交互会话");

    act(() => {
      const a2ui = {
        interaction_id: "interaction-live-waiting",
        mode: "interactive",
        payload: {
          title: "请补充信息",
          fields: [{ key: "name", label: "名称", type: "text" }],
        },
        render_key: "form",
        status: "waiting_input",
        stream_id: "stream-live-waiting",
        tool_call_id: "tool-live-waiting",
        interaction: {
          interaction_id: "interaction-live-waiting",
          status: "waiting_user_input",
          can_submit: true,
        },
      };
      emit({
        action: "a2ui_created",
        data: {
          session_id: "thread-b",
          render_key: "form",
          stream_id: "stream-live-waiting",
          interaction_id: "interaction-live-waiting",
          a2ui,
        },
      });
      emit({
        action: "waiting_input",
        data: {
          session_id: "thread-b",
          stream_id: "stream-live-waiting",
          interaction_id: "interaction-live-waiting",
          a2ui,
        },
      });
      emit({
        action: "a2ui_stream_finish",
        data: {
          session_id: "thread-b",
          render_key: "form",
          stream_id: "stream-live-waiting",
          tool_call_id: "tool-live-waiting",
          stream: {
            status: "finish",
            args_text_length: 0,
            finish_reason: "a2ui_waiting_input",
          },
        },
      });
    });

    const backgroundButton = screen.getByRole("button", { name: "交互会话" });
    const backgroundRow = backgroundButton.parentElement!;
    const indicator = backgroundRow.querySelector('[data-session-indicators="true"]');
    expect(indicator?.getAttribute("data-waiting-approval")).toBe("false");
    expect(indicator?.getAttribute("data-waiting-interaction")).toBe("true");
    expect(indicator?.textContent).toContain("等待交互");
    expect(indicator?.textContent).not.toContain("等待批准");
    expect(backgroundRow.querySelector("time")).toBeNull();
  });

  it("renders collapsed background loading in the session button center", async () => {
    let emit: (event: AgentActionEnvelope) => void = () => undefined;
    const runtime = fakeRuntime([
      thread({ id: "thread-a", title: "当前会话" }),
      thread({ id: "thread-b", title: "后台会话" }),
    ]);
    const channel: ChatChannel = {
      close: vi.fn(),
      getStatus: vi.fn<() => WsConnectionStatus>(() => "open"),
      getSessionId: vi.fn(() => null),
      createSession: vi.fn(),
      bindSession: vi.fn(),
      unbindSession: vi.fn(),
      chat: vi.fn(),
      submitA2UI: vi.fn(),
      cancelA2UI: vi.fn(),
      approvalDecision: vi.fn(),
      cancel: vi.fn(),
      terminateCommand: vi.fn(),
      requestStatus: vi.fn(),
      ping: vi.fn(),
    };
    runtime.conversation.openChatChannel = vi.fn((onEvent, options?: { onStatus?: (status: "open") => void }) => {
      emit = onEvent;
      options?.onStatus?.("open");
      return channel;
    });

    renderSider(
      <AgentSessionProvider runtime={runtime}>
        <Sider runtime={runtime} collapsed activePath="/conversation/thread-a" />
      </AgentSessionProvider>,
    );

    await screen.findByRole("button", { name: "打开会话 后台会话" });

    act(() => {
      emit({
        action: "status",
        data: {
          status: "idle",
          running_sessions: [{ session_id: "thread-b" }],
        },
      });
      emit({ action: "stream", data: { session_id: "thread-b", content: "后台输出" } });
    });

    const backgroundButton = screen.getByRole("button", { name: "打开会话 后台会话" });
    expect(backgroundButton.querySelector('[data-collapsed-loading="true"]')).not.toBeNull();
    expect(backgroundButton.querySelector('[data-session-indicators="true"]')).toBeNull();
    expect(backgroundButton.textContent).not.toContain("后");

    act(() => {
      emit({ action: "completed", data: { session_id: "thread-b", status: "completed", events: [] } });
    });

    expect(backgroundButton.querySelector('[data-collapsed-loading="true"]')).toBeNull();
    expect(backgroundButton.querySelector('[data-unread="true"]')).not.toBeNull();
  });

  it("renames conversations through updateSession", async () => {
    const runtime = fakeRuntime([thread({ id: "thread-a", title: "旧标题" })]);
    renderSider(<Sider runtime={runtime} />);

    await screen.findByText("旧标题");
    const menu = openSessionMenu("旧标题");
    expect(menu.parentElement).toBe(document.body);
    expect(within(menu).queryByRole("menuitem", { name: "刷新" })).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("menu", { name: "会话操作 旧标题" })).toBeNull();
    });
    fireEvent.click(within(openSessionMenu("旧标题")).getByRole("menuitem", { name: "重命名" }));
    expect(screen.getByRole("dialog", { name: "重命名会话" })).not.toBeNull();
    fireEvent.change(screen.getByLabelText("会话名称"), { target: { value: "新标题" } });
    fireEvent.click(screen.getByRole("button", { name: "保存重命名" }));

    await waitFor(() => {
      expect(runtime.conversation.updateSession).toHaveBeenCalledWith("thread-a", { title: "新标题" });
    });
    expect(await screen.findByText("新标题")).not.toBeNull();
  });

  it("opens the same session action menu from right-click", async () => {
    const runtime = fakeRuntime([thread({ id: "thread-a", title: "右键会话" })], {
      forkSession: vi.fn(),
      loadHistory: vi.fn(),
    });
    renderSider(
      <AppContextMenuProvider>
        <Sider runtime={runtime} />
      </AppContextMenuProvider>,
    );

    await screen.findByText("右键会话");
    const sessionButton = screen.getByRole("button", { name: "右键会话" });
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 80,
      clientY: 96,
    });
    fireEvent(sessionButton, event);

    expect(event.defaultPrevented).toBe(true);
    expect(screen.queryByRole("menu", { name: "页面右键菜单" })).toBeNull();
    const menu = screen.getByRole("menu", { name: "会话操作 右键会话" });
    expect(within(menu).getByRole("menuitem", { name: "从对话派生" })).not.toBeNull();
    expect(within(menu).getByRole("menuitem", { name: "重命名" })).not.toBeNull();
    expect(within(menu).getByRole("menuitem", { name: "删除" })).not.toBeNull();
    expect(within(menu).getByRole("menuitem", { name: "刷新" })).not.toBeNull();

    fireEvent.click(within(menu).getByRole("menuitem", { name: "重命名" }));
    expect(screen.getByRole("dialog", { name: "重命名会话" })).not.toBeNull();
  });

  it("refreshes the session list from the session right-click menu", async () => {
    const runtime = fakeRuntime([thread({ id: "thread-a", title: "可刷新会话" })]);
    renderSider(<Sider runtime={runtime} />);

    await screen.findByText("可刷新会话");
    expect(runtime.conversation.listSessions).toHaveBeenCalledTimes(1);

    const sessionButton = screen.getByRole("button", { name: "可刷新会话" });
    fireEvent.contextMenu(sessionButton, { clientX: 80, clientY: 96 });
    fireEvent.click(within(screen.getByRole("menu", { name: "会话操作 可刷新会话" })).getByRole("menuitem", { name: "刷新" }));

    await waitFor(() => {
      expect(runtime.conversation.listSessions).toHaveBeenCalledTimes(2);
    });
  });

  it("forks a session from the latest complete turn in the action menu", async () => {
    const sourceSession = thread({ id: "thread-a", title: "可派生会话" });
    const forkedSession = thread({
      id: "thread-fork",
      title: "派生会话",
      parent_session_id: "thread-a",
      updated_at: "2026-06-17T11:30:00Z",
    });
    const loadHistory = vi.fn().mockResolvedValue(
      historyResponse(
        sourceSession,
        [
          chatMessage({
            role: "user",
            content: "上一轮问题",
            messageEventId: "event-user-complete",
            turnIndex: 1,
          }),
          chatMessage({
            role: "assistant",
            content: "上一轮回答",
            messageEventId: "event-assistant-complete",
            turnIndex: 1,
          }),
          chatMessage({
            role: "user",
            content: "正在进行的问题",
            messageEventId: "event-user-running",
            turnIndex: 2,
          }),
          chatMessage({
            role: "assistant",
            content: "正在流式输出",
            messageEventId: "event-assistant-running",
            status: "streaming",
            streaming: true,
            turnIndex: 2,
          }),
        ],
      ),
    );
    const forkSession = vi.fn().mockResolvedValue(branchResponse(forkedSession));
    const runtime = fakeRuntime([sourceSession], { forkSession, loadHistory });
    const onNavigate = vi.fn();

    renderSider(<Sider runtime={runtime} onNavigate={onNavigate} />);

    await screen.findByText("可派生会话");
    fireEvent.click(within(openSessionMenu("可派生会话")).getByRole("menuitem", { name: "从对话派生" }));

    await waitFor(() => {
      expect(loadHistory).toHaveBeenCalledWith("thread-a", { pageSize: 100 });
    });
    expect(forkSession).toHaveBeenCalledWith("thread-a", { messageEventId: "event-assistant-complete" });
    await waitFor(() => {
      expect(onNavigate).toHaveBeenCalledWith("/conversation/thread-fork");
    });
    expect(await screen.findByText("派生会话")).not.toBeNull();
  });

  it("renames a session inside its workspace group without moving it", async () => {
    const runtime = fakeRuntime([
      thread({
        id: "thread-a",
        title: "旧标题",
        session_type: "workspace",
        workspace_id: "ws-1",
        workspace: workspace("ws-1", "keydex"),
      }),
    ]);
    renderSider(<Sider runtime={runtime} />);

    await screen.findByText("keydex");
    fireEvent.click(within(openSessionMenu("旧标题")).getByRole("menuitem", { name: "重命名" }));
    expect(screen.getByRole("dialog", { name: "重命名会话" })).not.toBeNull();
    fireEvent.change(screen.getByLabelText("会话名称"), { target: { value: "新标题" } });
    fireEvent.click(screen.getByRole("button", { name: "保存重命名" }));

    const group = await screen.findByRole("region", { name: "keydex" });
    expect(within(group).getByRole("button", { name: "新标题" })).not.toBeNull();
  });

  it("inserts a locally created session into the matching workspace group top", async () => {
    const runtime = fakeRuntime([
      thread({
        id: "thread-old",
        title: "旧会话",
        updated_at: "2026-06-17T10:00:00Z",
        session_type: "workspace",
        workspace_id: "ws-1",
        workspace: workspace("ws-1", "keydex"),
      }),
    ]);
    renderSider(<Sider runtime={runtime} />);

    const oldNode = await screen.findByText("旧会话");
    act(() => {
      emitSessionCreated(
        thread({
          id: "thread-new",
          title: "新会话",
          updated_at: "2026-06-17T11:00:00Z",
          session_type: "workspace",
          workspace_id: "ws-1",
          workspace: workspace("ws-1", "keydex"),
        }),
      );
    });

    const group = await screen.findByRole("region", { name: "keydex" });
    const newNode = within(group).getByText("新会话");
    expect(Boolean(newNode.compareDocumentPosition(oldNode) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  });

  it("deletes conversations after explicit delete confirmation", async () => {
    const runtime = fakeRuntime([thread({ id: "thread-a", title: "待删除会话" })]);
    renderSider(<Sider runtime={runtime} />);

    await screen.findByText("待删除会话");
    fireEvent.click(within(openSessionMenu("待删除会话")).getByRole("menuitem", { name: "删除" }));
    const dialog = screen.getByRole("dialog", { name: "确认删除会话？" });
    expect(within(dialog).getByText("待删除会话")).not.toBeNull();
    expect(within(dialog).getAllByRole("button").map((button) => button.textContent)).toEqual(["取消", "删除"]);
    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));

    await waitFor(() => {
      expect(runtime.conversation.deleteSession).toHaveBeenCalledWith("thread-a");
    });
    expect(screen.queryByText("待删除会话")).toBeNull();
  });

  it("returns to quick chat when the active conversation is deleted", async () => {
    const runtime = fakeRuntime([thread({ id: "thread-a", title: "当前会话" })]);
    const onNavigate = vi.fn();
    renderSider(<Sider activePath="/conversation/thread-a" runtime={runtime} onNavigate={onNavigate} />);

    await screen.findByText("当前会话");
    fireEvent.click(within(openSessionMenu("当前会话")).getByRole("menuitem", { name: "删除" }));
    const dialog = screen.getByRole("dialog", { name: "确认删除会话？" });
    fireEvent.click(within(dialog).getByRole("button", { name: "删除" }));

    await waitFor(() => {
      expect(onNavigate).toHaveBeenCalledWith("/guid");
    });
  });
});

interface FakeRuntimeOptions {
  forkSession?: RuntimeBridge["conversation"]["forkSession"];
  loadHistory?: RuntimeBridge["conversation"]["loadHistory"];
}

function fakeRuntime(threads: AgentSession[], options: FakeRuntimeOptions = {}): RuntimeBridge {
  const listSessions = vi.fn().mockResolvedValue({
    list: threads,
    total: threads.length,
    page: 1,
    page_size: 50,
  });
  const updateSession = vi.fn((threadId: string, patch: Partial<AgentSession>) => {
    const current = threads.find((item) => item.id === threadId) ?? thread({ id: threadId });
    return Promise.resolve({ ...current, ...patch, updated_at: "2026-06-17T11:00:00Z" });
  });
  const deleteSession = vi.fn().mockResolvedValue(undefined);
  return {
    conversation: {
      listSessions,
      updateSession,
      deleteSession,
      ...(options.forkSession ? { forkSession: options.forkSession } : {}),
      ...(options.loadHistory ? { loadHistory: options.loadHistory } : {}),
    },
  } as unknown as RuntimeBridge;
}

function chatMessage(
  patch: Pick<AgentChatMessagePayload, "content" | "role"> & Partial<AgentChatMessagePayload>,
): AgentChatMessagePayload {
  return patch;
}

function historyResponse(session: AgentSession, list: AgentChatMessagePayload[]): AgentHistoryResponse {
  return {
    list,
    total: list.length,
    page: 1,
    page_size: 100,
    session,
    event_total: list.length,
    turn_indexes: Array.from(
      new Set(
        list
          .map((message) => message.turnIndex)
          .filter((turnIndex): turnIndex is number => typeof turnIndex === "number"),
      ),
    ),
  };
}

function branchResponse(session: AgentSession): AgentSessionBranchResponse {
  return {
    session,
    source: {
      session_id: session.id,
      active_session_id: session.active_session_id ?? session.id,
      checkpoint_id: null,
      checkpoint_ns: "",
      trace_id: null,
      turn_index: null,
      message_event_id: null,
      source_type: "message_event",
    },
  };
}

function thread(patch: Partial<AgentSession> = {}): AgentSession {
  return {
    id: "thread-a",
    title: "会话",
    user_id: "local-user",
    scene_id: "desktop-agent",
    status: "active",
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
    normalized_root_path: `d:/pycharm projects/${name}`,
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
    created_at: "2026-06-17T10:00:01Z",
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
