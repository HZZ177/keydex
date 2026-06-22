import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeBridge } from "@/runtime";
import { Sider } from "@/renderer/components/layout/Sider";
import { emitSessionCreated } from "@/renderer/events/sessionEvents";
import { ThemeProvider } from "@/renderer/providers/ThemeProvider";
import type { AgentSession, Workspace } from "@/types/protocol";

function renderSider(ui: ReactElement) {
  return render(<ThemeProvider>{ui}</ThemeProvider>);
}

describe("Sider", () => {
  it("renders the personal local navigation without removed AionUi entries", () => {
    const { container } = renderSider(
      <Sider
        projects={[{ id: "project-1", title: "keydex" }]}
        conversations={[{ id: "thread-1", title: "研读文档与 Codex 源码" }]}
      />,
    );

    expect(screen.getByText("新对话")).not.toBeNull();
    expect(screen.getByText("搜索")).not.toBeNull();
    expect(screen.getByText("keydex")).not.toBeNull();
    expect(screen.getByText("研读文档与 Codex 源码")).not.toBeNull();
    expect(screen.getByText("设置")).not.toBeNull();
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

    expect(onNavigate).toHaveBeenNthCalledWith(1, "/guid");
    expect(onNavigate).toHaveBeenNthCalledWith(2, "/conversation/thread-1");
    expect(onNavigate).toHaveBeenNthCalledWith(3, "/settings/model");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(screen.getByRole("button", { name: "会话 A" }).getAttribute("aria-current")).toBe("page");
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

    const row = screen.getByRole("button", { name: "会话 A" });
    expect(row.getAttribute("title")).toBeNull();
    expect(row.querySelector("time")?.getAttribute("datetime")).toBe("2026-06-17T10:00:00Z");
    expect(row.getAttribute("aria-current")).toBe("page");
  });

  it("uses icon-only collapsed affordances", () => {
    renderSider(<Sider collapsed />);

    expect(screen.getByTitle("新对话")).not.toBeNull();
    expect(screen.getByTitle("搜索")).not.toBeNull();
    expect(screen.getByTitle("切换主题")).not.toBeNull();
    expect(screen.getByTitle("设置")).not.toBeNull();
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
    expect(screen.getByText("对话")).not.toBeNull();
    expect(screen.getByRole("button", { name: "项目会话 A" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: "项目会话 B" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "纯聊天" })).not.toBeNull();
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

    const button = await screen.findByRole("button", { name: "打开会话 项目会话 A" });
    fireEvent.mouseEnter(button);

    const card = screen.getByRole("tooltip");
    expect(card.textContent).toContain("项目会话 A");
    expect(card.textContent).toContain("keydex");
    expect(card.textContent).toContain("当前会话");
  });

  it("renames conversations through updateSession", async () => {
    const runtime = fakeRuntime([thread({ id: "thread-a", title: "旧标题" })]);
    renderSider(<Sider runtime={runtime} />);

    await screen.findByText("旧标题");
    fireEvent.click(screen.getByRole("button", { name: "重命名 旧标题" }));
    fireEvent.change(screen.getByLabelText("重命名 旧标题"), { target: { value: "新标题" } });
    fireEvent.click(screen.getByRole("button", { name: "保存重命名" }));

    await waitFor(() => {
      expect(runtime.conversation.updateSession).toHaveBeenCalledWith("thread-a", { title: "新标题" });
    });
    expect(await screen.findByText("新标题")).not.toBeNull();
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
    fireEvent.click(screen.getByRole("button", { name: "重命名 旧标题" }));
    fireEvent.change(screen.getByLabelText("重命名 旧标题"), { target: { value: "新标题" } });
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
    fireEvent.click(screen.getByRole("button", { name: "删除 待删除会话" }));
    expect(screen.getByText("确认删除？")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "确认" }));

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
    fireEvent.click(screen.getByRole("button", { name: "删除 当前会话" }));
    fireEvent.click(screen.getByRole("button", { name: "确认" }));

    await waitFor(() => {
      expect(onNavigate).toHaveBeenCalledWith("/guid");
    });
  });
});

function fakeRuntime(threads: AgentSession[]): RuntimeBridge {
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
    },
  } as unknown as RuntimeBridge;
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
