import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeBridge } from "@/runtime";
import { Sider } from "@/renderer/components/layout/Sider";
import { ThemeProvider } from "@/renderer/providers/ThemeProvider";
import type { AgentSession } from "@/types/protocol";

function renderSider(ui: ReactElement) {
  return render(<ThemeProvider>{ui}</ThemeProvider>);
}

describe("Sider", () => {
  it("renders the personal local navigation without removed AionUi entries", () => {
    renderSider(
      <Sider
        projects={[{ id: "project-1", title: "codex-copy" }]}
        conversations={[{ id: "thread-1", title: "研读文档与 Codex 源码" }]}
      />,
    );

    expect(screen.getByText("快速对话")).not.toBeNull();
    expect(screen.getByText("搜索")).not.toBeNull();
    expect(screen.getByText("codex-copy")).not.toBeNull();
    expect(screen.getByText("研读文档与 Codex 源码")).not.toBeNull();
    expect(screen.getByText("设置")).not.toBeNull();
    expect(screen.queryByText("Team")).toBeNull();
    expect(screen.queryByText("Cron")).toBeNull();
    expect(screen.queryByText("Scheduled")).toBeNull();
    expect(screen.queryByText("自动化")).toBeNull();
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

    fireEvent.click(screen.getByText("快速对话"));
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
        projects={[{ id: "project-1", title: "codex-copy" }]}
        conversations={[{ id: "thread-1", title: "会话 A" }]}
      />,
    );

    expect(screen.getByRole("button", { name: "快速对话" }).getAttribute("data-active")).toBe("true");
    expect(screen.getByText("codex-copy").getAttribute("role")).toBeNull();
  });

  it("uses icon-only collapsed affordances", () => {
    renderSider(<Sider collapsed />);

    expect(screen.getByTitle("快速对话")).not.toBeNull();
    expect(screen.getByTitle("搜索")).not.toBeNull();
    expect(screen.getByTitle("切换主题")).not.toBeNull();
    expect(screen.getByTitle("设置")).not.toBeNull();
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
