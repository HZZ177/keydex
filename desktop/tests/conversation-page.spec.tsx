import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useLayoutEffect, type ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatChannel, RuntimeBridge, WsConnectionStatus } from "@/runtime";
import type { WorkspaceEntry, WorkspaceTreeResponse } from "@/runtime";
import { Layout, resetLayoutUiStateCacheForTests } from "@/renderer/components/layout/Layout";
import { LayoutStateProvider } from "@/renderer/hooks/layout/LayoutStateProvider";
import { ConversationPage } from "@/renderer/pages/conversation";
import { clearQuickChatSendQueue, queueQuickChatSend } from "@/renderer/pages/conversation/quickSend";
import { AgentSessionProvider, useAgentSessionRuntime } from "@/renderer/providers/AgentSessionProvider";
import { ActiveProjectCoordinatorProvider } from "@/renderer/providers/ActiveProjectCoordinatorProvider";
import { ComposerDraftProvider } from "@/renderer/features/composer";
import { NotificationProvider } from "@/renderer/providers/NotificationProvider";
import { PreviewProvider, usePreview } from "@/renderer/providers/PreviewProvider";
import { ThemeProvider } from "@/renderer/providers/ThemeProvider";
import type {
  AgentActionEnvelope,
  AgentChatMessagePayload,
  AgentHistoryResponse,
  AgentSession,
  AgentSessionBranchSource,
  AgentSessionFork,
  AgentToolDetails,
  CommandApprovalRequest,
  Workspace,
} from "@/types/protocol";

describe("ConversationPage", () => {
  beforeEach(() => {
    cleanup();
    resetLayoutUiStateCacheForTests();
    clearQuickChatSendQueue();
    localStorage.clear();
    sessionStorage.clear();
  });

  it("restores an empty session history with a clear empty state", async () => {
    const { runtime } = fakeRuntime({ history: [] });

    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    expect((await screen.findByTestId("conversation-empty")).textContent).toBe("还没有消息，输入需求开始对话。");
    expect(runtime.conversation.loadHistory).toHaveBeenCalledWith("ses-1", {
      allTurns: true,
      direction: "older",
      pageSize: undefined,
    });
    expect(runtime.conversation.openChatChannel).toHaveBeenCalled();
  });

  it("restores persisted context window usage when opening a session", async () => {
    const { runtime } = fakeRuntime({
      session: agentSession({
        context_window_usage: {
          session_id: "ses-1",
          active_session_id: "ses-1",
          token_count: 5371,
          context_window: 200000,
          threshold_token_count: 160000,
          threshold_usage_fraction: 5371 / 160000,
          token_source: "usage_metadata",
        },
      }),
    });

    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await readyComposer();
    const indicator = screen.getByTestId("context-window-indicator");
    await waitFor(() => {
      expect(indicator.getAttribute("aria-label")).toContain("5,371 tokens");
      expect(indicator.getAttribute("aria-label")).toContain("3.36%");
    });
  });

  it("restores persisted context window usage when history refreshes a stale session", async () => {
    let resolveHistory: ((response: AgentHistoryResponse) => void) | null = null;
    const loadHistory = vi.fn(
      () =>
        new Promise<AgentHistoryResponse>((resolve) => {
          resolveHistory = resolve;
        }),
    );
    const staleSession = agentSession({ context_window_usage: null });
    const hydratedSession = agentSession({
      context_window_usage: {
        middleware: "ContextCompressionMiddleware",
        stage: "context_window_snapshot",
        session_id: "ses-1",
        active_session_id: "ses-1",
        timestamp_ms: 1000,
        token_count: 5371,
        context_window: 200000,
        threshold_token_count: 160000,
        threshold_usage_fraction: 5371 / 160000,
        token_source: "usage_metadata",
      },
    });
    const { runtime, emit } = fakeRuntime({ session: staleSession, loadHistory });

    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    act(() => {
      emit(agentEvent("session_created", { session: staleSession }));
    });
    await readyComposer();
    expect(screen.getByTestId("context-window-indicator").getAttribute("aria-label")).toBe(
      "上下文窗口占用等待下一次模型调用",
    );

    await act(async () => {
      resolveHistory?.(historyResponse(hydratedSession, []));
    });

    await waitFor(() => {
      const label = screen.getByTestId("context-window-indicator").getAttribute("aria-label");
      expect(label).toContain("5,371 tokens");
      expect(label).toContain("3.36%");
    });
  });

  it("restores persisted context window usage after switching sessions with shared runtime state", async () => {
    const sessionA = agentSession({
      id: "ses-a",
      title: "会话 A",
      context_window_usage: {
        middleware: "ContextCompressionMiddleware",
        stage: "context_window_snapshot",
        session_id: "ses-a",
        active_session_id: "ses-a",
        timestamp_ms: 999999,
        token_count: 20000,
        context_window: 200000,
        threshold_token_count: 160000,
        threshold_usage_fraction: 20000 / 160000,
        token_source: "usage_metadata",
      },
    });
    const sessionB = agentSession({
      id: "ses-b",
      title: "会话 B",
      context_window_usage: {
        middleware: "ContextCompressionMiddleware",
        stage: "context_window_snapshot",
        session_id: "ses-b",
        active_session_id: "ses-b",
        timestamp_ms: 2000,
        token_count: 5371,
        context_window: 200000,
        threshold_token_count: 160000,
        threshold_usage_fraction: 5371 / 160000,
        token_source: "usage_metadata",
      },
    });
    const loadHistory = vi.fn((sessionId: string) =>
      Promise.resolve(historyResponse(sessionId === "ses-b" ? sessionB : sessionA, [])),
    );
    const { runtime } = fakeRuntime({ session: sessionA, loadHistory });

    const view = render(
      <AgentSessionProvider runtime={runtime}>
        <PreviewProvider>
          <ConversationPage threadId="ses-a" runtime={runtime} />
        </PreviewProvider>
      </AgentSessionProvider>,
    );

    await readyComposer();
    await waitFor(() => {
      expect(screen.getByTestId("context-window-indicator").getAttribute("aria-label")).toContain("20,000 tokens");
    });

    view.rerender(
      <AgentSessionProvider runtime={runtime}>
        <PreviewProvider>
          <ConversationPage threadId="ses-b" runtime={runtime} />
        </PreviewProvider>
      </AgentSessionProvider>,
    );

    await waitFor(() => {
      const label = screen.getByTestId("context-window-indicator").getAttribute("aria-label");
      expect(label).toContain("5,371 tokens");
      expect(label).toContain("3.36%");
    });
  });

  it("isolates composer drafts by session and restores them when switching back", async () => {
    const sessionA = agentSession({ id: "ses-a", title: "会话 A" });
    const sessionB = agentSession({ id: "ses-b", title: "会话 B" });
    const loadHistory = vi.fn((sessionId: string) =>
      Promise.resolve(historyResponse(sessionId === "ses-b" ? sessionB : sessionA, [])),
    );
    const { runtime } = fakeRuntime({ session: sessionA, loadHistory });
    const conversation = (sessionId: string) => (
      <ComposerDraftProvider storage={null}>
        <ActiveProjectCoordinatorProvider>
          <AgentSessionProvider runtime={runtime}>
            <PreviewProvider>
              <ConversationPage threadId={sessionId} runtime={runtime} />
            </PreviewProvider>
          </AgentSessionProvider>
        </ActiveProjectCoordinatorProvider>
      </ComposerDraftProvider>
    );
    const view = render(conversation("ses-a"));

    await readyComposer();
    const sessionAComposer = typeComposer("会话 A 的未发送内容");
    expect(sessionAComposer.textContent).toBe("会话 A 的未发送内容");

    view.rerender(conversation("ses-b"));
    await waitFor(() => {
      expect(screen.getByRole("textbox").textContent).toBe("");
    });
    typeComposer("会话 B 的未发送内容");

    view.rerender(conversation("ses-a"));
    await waitFor(() => {
      expect(screen.getByRole("textbox").textContent).toBe("会话 A 的未发送内容");
    });

    view.rerender(conversation("ses-b"));
    await waitFor(() => {
      expect(screen.getByRole("textbox").textContent).toBe("会话 B 的未发送内容");
    });
  });

  it("restores context window usage when switching from an empty session to a hydrated session", async () => {
    const sessionA = agentSession({
      id: "ses-a",
      title: "无窗口数据会话",
      context_window_usage: null,
    });
    const sessionB = agentSession({
      id: "ses-b",
      title: "有窗口数据会话",
      context_window_usage: {
        middleware: "ContextCompressionMiddleware",
        stage: "context_window_snapshot",
        session_id: "ses-b",
        active_session_id: "ses-b",
        timestamp_ms: 2000,
        token_count: 5371,
        context_window: 200000,
        threshold_token_count: 160000,
        threshold_usage_fraction: 5371 / 160000,
        token_source: "usage_metadata",
      },
    });
    const loadHistory = vi.fn((sessionId: string) =>
      Promise.resolve(historyResponse(sessionId === "ses-b" ? sessionB : sessionA, [])),
    );
    const { runtime } = fakeRuntime({ session: sessionA, loadHistory });

    const view = render(
      <AgentSessionProvider runtime={runtime}>
        <PreviewProvider>
          <ConversationPage threadId="ses-a" runtime={runtime} />
        </PreviewProvider>
      </AgentSessionProvider>,
    );

    await readyComposer();
    await waitFor(() => {
      expect(screen.getByTestId("context-window-indicator").getAttribute("aria-label")).toBe(
        "上下文窗口占用等待下一次模型调用",
      );
    });

    view.rerender(
      <AgentSessionProvider runtime={runtime}>
        <PreviewProvider>
          <ConversationPage threadId="ses-b" runtime={runtime} />
        </PreviewProvider>
      </AgentSessionProvider>,
    );

    await waitFor(() => {
      const label = screen.getByTestId("context-window-indicator").getAttribute("aria-label");
      expect(label).toContain("5,371 tokens");
      expect(label).toContain("3.36%");
    });
  });

  it("keeps the Agent route free of Workbench assistant shell chrome", async () => {
    const { runtime } = fakeRuntime({ history: [] });

    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    expect(await screen.findByTestId("chat-layout")).not.toBeNull();
    expect(screen.queryByTestId("workbench-assistant-surface")).toBeNull();
    expect(screen.queryByTestId("workbench-assistant-shell")).toBeNull();
    expect(screen.queryByTestId("workbench-assistant-capsule")).toBeNull();
  });

  it("shows history load failures as a top notification instead of an error message card", async () => {
    const { runtime } = fakeRuntime({ historyError: new Error("会话不存在：ses-1") });

    renderConversationWithNotifications(<ConversationPage threadId="ses-1" runtime={runtime} />);

    expect((await screen.findByRole("alert")).textContent).toContain("会话不存在：ses-1");
    expect(screen.queryByTestId("error-item")).toBeNull();
    expect((await screen.findByTestId("conversation-empty")).textContent).toBe("还没有消息，输入需求开始对话。");
  });

  it("does not show workspace picker in the bottom composer for a project session", async () => {
    const { runtime } = fakeRuntime({
      session: agentSession({
        session_type: "workspace",
        workspace_id: "ws-1",
        cwd: "D:/repo",
        workspace_roots: ["D:/repo"],
        workspace: workspace("ws-1", "repo", "D:/repo"),
      }),
    });

    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await readyComposer();
    expect(screen.getByTestId("chat-workspace-meta").textContent).toContain("repo");
    expect(screen.queryByLabelText("选择工作区")).toBeNull();
  });

  it("force reloads only effective skills when the websocket reports a matching Keydex change", async () => {
    const workspaceListSkills = vi.fn().mockResolvedValue({
      mode: "workspace_effective",
      workspace_root: "D:/repo",
      fingerprint: "test-fingerprint",
      loaded_at: "2026-06-25T12:00:00Z",
      skills: [],
      diagnostics: [],
    });
    const { runtime, emit } = fakeRuntime({
      session: agentSession({
        session_type: "workspace",
        workspace_id: "ws-1",
        cwd: "D:/repo",
        workspace_roots: ["D:/repo"],
        workspace: workspace("ws-1", "repo", "D:/repo"),
      }),
      workspaceListSkills,
    });

    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await readyComposer();
    await waitFor(() => {
      expect(workspaceListSkills).toHaveBeenCalledWith(
        "ses-1",
        expect.objectContaining({ forceReload: false }),
      );
    });

    act(() => {
      emit(agentEvent("keydexWorkspaceChanged", {
        session_id: "ses-1",
        changed_capabilities: ["skills"],
        capability_fingerprints: { skills: "changed-fingerprint" },
      }));
    });

    await waitFor(() => {
      expect(workspaceListSkills).toHaveBeenNthCalledWith(
        2,
        "ses-1",
        expect.objectContaining({ forceReload: true }),
      );
    });
    expect(runtime.conversation.loadHistory).toHaveBeenCalledTimes(1);
  });

  it("does not show project-free workspace picker in the bottom composer for a pure chat session", async () => {
    const { runtime } = fakeRuntime();

    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await readyComposer();
    expect(screen.queryByLabelText("选择工作区")).toBeNull();
  });

  it("does not expose workspace search when a bound workspace is unavailable", async () => {
    const { runtime } = fakeRuntime({
      session: agentSession({
        session_type: "workspace",
        workspace_id: "ws-missing",
        cwd: "D:/missing",
        workspace_roots: ["D:/missing"],
        workspace: null,
      }),
    });

    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await readyComposer();
    expect(screen.queryByLabelText("选择工作区")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    typeComposer("@README");
    expect(screen.queryByTestId("at-file-menu")).toBeNull();
    expect(runtime.workspace.search).not.toHaveBeenCalled();
  });

  it("restores persisted user and assistant messages from session history", async () => {
    const { runtime } = fakeRuntime({
      history: [
        historyMessage("user", "历史问题"),
        historyMessage("assistant", "历史回答"),
      ],
    });

    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    expect(await screen.findByText("历史问题")).not.toBeNull();
    expect(await screen.findByText("历史回答")).not.toBeNull();
    expect(screen.queryByTestId("conversation-empty")).toBeNull();
  });

  it("renders context compression history notices", async () => {
    const { runtime } = fakeRuntime({
      history: [
        historyMessage("system", "上下文已压缩，后续对话将从压缩分支继续。", {
          messageEventId: "evt-compressed",
          turnIndex: 2,
        }),
      ],
    });

    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    expect(await screen.findByText("上下文已压缩，后续对话将从压缩分支继续。")).not.toBeNull();
  });

  it("renders context compression divider notices from history metadata", async () => {
    const { runtime } = fakeRuntime({
      history: [
        historyMessage("system", "上下文压缩已完成", {
          messageEventId: "evt-compressed",
          turnIndex: 2,
          status: "completed",
          metadata: {
            compression: {
              kind: "context_compression",
              stage: "compression_completed",
              mode: "context",
              notice_id: "context-compression:trace-1",
            },
          },
        }),
      ],
    });

    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    const notice = await screen.findByTestId("context-compression-notice");
    expect(notice.textContent).toContain("上下文压缩已完成");
  });

  it("updates context compression divider notices in place", async () => {
    const { runtime, emit } = fakeRuntime();
    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await readyComposer();
    await act(async () => {
      emit(
        agentEvent("middleware_progress", {
          session_id: "ses-1",
          middleware: "ContextCompressionMiddleware",
          stage: "compression_started",
          compression_mode: "context",
          compression_reason: "automatic",
          notice_id: "context-compression:trace-1",
          trace_id: "trace-1",
        }),
      );
    });

    expect(await screen.findByText("正在压缩上下文")).not.toBeNull();

    await act(async () => {
      emit(
        agentEvent("middleware_progress", {
          session_id: "ses-1",
          middleware: "ContextCompressionMiddleware",
          stage: "compression_completed",
          compression_mode: "context",
          compression_reason: "automatic",
          notice_id: "context-compression:trace-1",
          trace_id: "trace-1",
        }),
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId("context-compression-notice").textContent).toContain("上下文压缩已完成");
    });
    expect(screen.queryByText("正在压缩上下文")).toBeNull();
  });

  it("starts context compression immediately from the slash command", async () => {
    let resolveCompress: (() => void) | null = null;
    const compressContext = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveCompress = resolve;
        }),
    );
    const { runtime } = fakeRuntime({ compressContext });
    renderConversationWithNotifications(<ConversationPage threadId="ses-1" runtime={runtime} />);

    const input = await readyComposer();
    typeComposer("/压缩");
    await waitFor(() => {
      expect(screen.getByTestId("slash-command-menu")).not.toBeNull();
    });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(compressContext).toHaveBeenCalledWith("ses-1");
    });
    expect(screen.queryByRole("dialog")).toBeNull();

    await act(async () => {
      resolveCompress?.();
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows compression failures as top notifications and a failed divider", async () => {
    const { runtime, emit } = fakeRuntime();
    renderConversationWithNotifications(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await readyComposer();
    await act(async () => {
      emit(
        agentEvent("middleware_progress", {
          session_id: "ses-1",
          middleware: "ContextCompressionMiddleware",
          stage: "compression_failed",
          compression_mode: "context",
          compression_reason: "automatic",
          reason: "missing_default_chat_model",
          notice_id: "context-compression:trace-1",
          trace_id: "trace-1",
        }),
      );
    });

    expect((await screen.findByRole("alert")).textContent).toContain("上下文压缩失败");
    expect(screen.getByTestId("context-compression-notice").textContent).toContain("上下文压缩失败");
  });

  it("updates the context window ring from model-call snapshots", async () => {
    const { runtime, emit } = fakeRuntime();
    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await readyComposer();
    await act(async () => {
      emit(
        agentEvent("middleware_progress", {
          session_id: "ses-1",
          active_session_id: "ses-1",
          middleware: "ContextCompressionMiddleware",
          stage: "context_window_snapshot",
          compression_mode: "snapshot",
          call_phase: "before",
          call_status: "running",
          token_source: "estimated",
          token_count: 400,
          context_window: 1000,
          window_fraction: 0.4,
          threshold_fraction: 0.75,
          threshold_token_count: 750,
          threshold_usage_fraction: 400 / 750,
          remaining_to_threshold_tokens: 350,
        }),
      );
    });

    const initialIndicator = await screen.findByTestId("context-window-indicator");
    expect(initialIndicator.getAttribute("aria-label")).toContain("当前已使用上下文 400 tokens");
    expect(initialIndicator.getAttribute("aria-label")).toContain("53.3%");

    await act(async () => {
      emit(
        agentEvent("middleware_progress", {
          session_id: "ses-1",
          active_session_id: "ses-1",
          middleware: "ContextCompressionMiddleware",
          stage: "context_window_snapshot",
          compression_mode: "snapshot",
          call_phase: "after",
          call_status: "completed",
          token_source: "usage_metadata",
          token_count: 700,
          context_window: 1000,
          window_fraction: 0.7,
          threshold_fraction: 0.75,
          threshold_token_count: 750,
          threshold_usage_fraction: 700 / 750,
          remaining_to_threshold_tokens: 50,
        }),
      );
    });

    const indicator = screen.getByTestId("context-window-indicator");
    expect(indicator.getAttribute("aria-label")).toContain("当前已使用上下文 700 tokens");
    expect(indicator.getAttribute("data-level")).toBe("warning");
    expect(indicator.getAttribute("aria-label")).toContain("上下文压缩进度 93.3%");
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip.textContent).toContain("当前已使用 700 tokens");
    expect(tooltip.textContent).toContain("上下文压缩进度 93.3%");
    expect(tooltip.textContent).not.toContain("全量压缩进度");
    expect(tooltip.querySelector('[data-progress-kind="ambient"]')?.getAttribute("data-level")).toBe("warning");
    expect(tooltip.querySelector('[data-progress-kind="blocking"]')).toBeNull();
    expect(tooltip.textContent).not.toContain("700 / 1,000 tokens");
    expect(tooltip.textContent).not.toContain("调用后 · 模型返回");
  });

  it("forks a restored message and navigates to the new branch session", async () => {
    const navigateToConversation = vi.fn();
    const forkSession = vi.fn().mockResolvedValue({
      session: agentSession({
        id: "ses-fork",
        title: "从该轮派生对话",
        fork_source: sessionFork({
          source_session_id: "ses-1",
          target_session_id: "ses-fork",
          source_message_event_id: "evt-ai-1",
          target_message_event_id: "evt-fork-ai-1",
          source_checkpoint_id: "checkpoint-1",
        }),
      }),
      source: branchSource({ message_event_id: "evt-ai-1" }),
    });
    const { runtime } = fakeRuntime({
      history: [
        historyMessage("user", "历史问题", { messageEventId: "evt-user-1" }),
        historyMessage("assistant", "历史回答", { messageEventId: "evt-ai-1" }),
      ],
      forkSession,
    });

    renderConversationWithNotifications(
      <ConversationPage threadId="ses-1" runtime={runtime} onNavigateToConversation={navigateToConversation} />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "从该轮派生对话" }));

    expect(forkSession).not.toHaveBeenCalled();
    expect(await screen.findByRole("dialog", { name: "确认从该轮派生对话？" })).not.toBeNull();
    expect(screen.getAllByText("历史回答").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "派生对话" }));

    await waitFor(() => {
      expect(forkSession).toHaveBeenCalledWith("ses-1", { messageEventId: "evt-ai-1" });
      expect(navigateToConversation).toHaveBeenCalledWith("ses-fork");
    });
  });

  it("cancels fork confirmation without creating a branch", async () => {
    const forkSession = vi.fn().mockResolvedValue({
      session: agentSession({ id: "ses-fork" }),
      source: branchSource({ message_event_id: "evt-ai-1" }),
    });
    const { runtime } = fakeRuntime({
      history: [
        historyMessage("user", "历史问题", { messageEventId: "evt-user-1" }),
        historyMessage("assistant", "历史回答", { messageEventId: "evt-ai-1" }),
      ],
      forkSession,
    });

    renderConversationWithNotifications(<ConversationPage threadId="ses-1" runtime={runtime} />);

    fireEvent.click(await screen.findByRole("button", { name: "从该轮派生对话" }));
    expect(await screen.findByRole("dialog", { name: "确认从该轮派生对话？" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "确认从该轮派生对话？" })).toBeNull();
    });
    expect(forkSession).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "从该轮派生对话" }));
    expect(await screen.findByRole("dialog", { name: "确认从该轮派生对话？" })).not.toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "确认从该轮派生对话？" })).toBeNull();
    });
    expect(forkSession).not.toHaveBeenCalled();
  });

  it("renders the fork origin marker inside the forked session", async () => {
    const { runtime } = fakeRuntime({
      history: [
        historyMessage("user", "历史问题", { messageEventId: "evt-user-1" }),
        historyMessage("assistant", "历史回答", {
          messageEventId: "evt-fork-ai-1",
          forkSource: sessionFork({
            target_session_id: "ses-fork",
            target_message_event_id: "evt-fork-ai-1",
          }),
        }),
      ],
    });

    renderConversationWithNotifications(<ConversationPage threadId="ses-1" runtime={runtime} />);

    expect((await screen.findByTestId("message-fork-marker")).textContent).toContain("从「源会话」中派生");
  });

  it("navigates to the source session from the fork origin marker", async () => {
    const navigateToConversation = vi.fn();
    const fork = sessionFork({
      source_session_id: "ses-source",
      source_title: "很长很长的源会话标题不应该显示在标记里",
      target_session_id: "ses-fork",
      target_message_event_id: "evt-fork-ai-1",
    });
    const { runtime } = fakeRuntime({
      session: agentSession({ id: "ses-fork", fork_source: fork }),
      history: [
        historyMessage("user", "历史问题", { messageEventId: "evt-user-1" }),
        historyMessage("assistant", "历史回答", {
          messageEventId: "evt-fork-ai-1",
          forkSource: fork,
        }),
      ],
    });

    renderConversationWithNotifications(
      <ConversationPage threadId="ses-fork" runtime={runtime} onNavigateToConversation={navigateToConversation} />,
    );

    const marker = await screen.findByTestId("message-fork-marker");
    expect(marker.textContent).toContain("从「源会话」中派生");
    expect(marker.textContent).not.toContain("很长很长的源会话标题");
    fireEvent.click(within(marker).getByRole("button", { name: /查看源会话/ }));

    expect(navigateToConversation).toHaveBeenCalledWith("ses-source");
  });

  it("navigates to the source session from the conversation action menu", async () => {
    const navigateToConversation = vi.fn();
    const fork = sessionFork({
      source_session_id: "ses-source",
      source_title: "源会话",
      target_session_id: "ses-fork",
    });
    const { runtime } = fakeRuntime({
      session: agentSession({ id: "ses-fork", fork_source: fork }),
    });

    renderConversationWithNotifications(
      <ConversationPage threadId="ses-fork" runtime={runtime} onNavigateToConversation={navigateToConversation} />,
    );

    expect(await screen.findByRole("heading", { name: "测试对话" })).not.toBeNull();
    fireEvent.click(screen.getByLabelText("更多对话操作"));
    fireEvent.click(screen.getByRole("menuitem", { name: "查看源会话" }));

    expect(navigateToConversation).toHaveBeenCalledWith("ses-source");
  });

  it("uses the sidebar session actions in the conversation header menu", async () => {
    const session = agentSession({ id: "ses-1", title: "原会话名称" });
    const messages = [
      historyMessage("user", "历史问题", { messageEventId: "evt-user-1", turnIndex: 1 }),
      historyMessage("assistant", "历史回答", { messageEventId: "evt-ai-1", turnIndex: 1 }),
    ];
    const updateSession = vi.fn().mockResolvedValue({ ...session, title: "新会话名称" });
    const archiveSession = vi.fn().mockImplementation((sessionId: string) => Promise.resolve({
      operation_id: "op-archive",
      request_id: "req-archive",
      session_id: sessionId,
      workspace_id: null,
      changed: true,
      archived_at: "2026-07-14T00:00:00Z",
      archive_origin: "manual",
      event: null,
    }));
    const forkSession = vi.fn().mockResolvedValue({
      session: agentSession({ id: "ses-fork", title: "派生会话" }),
      source: branchSource({ message_event_id: "evt-ai-1" }),
    });
    const onNavigateToConversation = vi.fn();
    const onArchived = vi.fn();
    const { runtime } = fakeRuntime({
      session,
      history: messages,
      updateSession,
      archiveSession,
      forkSession,
    });

    renderConversationWithNotifications(
      <ConversationPage
        threadId="ses-1"
        runtime={runtime}
        onNavigateToConversation={onNavigateToConversation}
        onArchived={onArchived}
      />,
    );

    expect(await screen.findByRole("heading", { name: "原会话名称" })).not.toBeNull();
    fireEvent.click(screen.getByLabelText("更多对话操作"));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual([
      "导出对话记录",
      "从对话派生",
      "重命名",
      "归档",
      "刷新",
    ]);
    expect(screen.queryByRole("menuitem", { name: "复制标题" })).toBeNull();

    fireEvent.click(screen.getByRole("menuitem", { name: "重命名" }));
    fireEvent.change(screen.getByLabelText("会话名称"), { target: { value: "新会话名称" } });
    fireEvent.click(screen.getByRole("button", { name: "保存重命名" }));
    await waitFor(() => expect(updateSession).toHaveBeenCalledWith("ses-1", { title: "新会话名称" }));
    expect(await screen.findByRole("heading", { name: "新会话名称" })).not.toBeNull();

    fireEvent.click(screen.getByLabelText("更多对话操作"));
    fireEvent.click(screen.getByRole("menuitem", { name: "刷新" }));
    await waitFor(() => expect(runtime.conversation.loadHistory).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByLabelText("更多对话操作"));
    fireEvent.click(screen.getByRole("menuitem", { name: "从对话派生" }));
    await waitFor(() => expect(forkSession).toHaveBeenCalledWith("ses-1", {}));
    expect(runtime.conversation.loadHistory).toHaveBeenCalledTimes(2);
    expect(onNavigateToConversation).toHaveBeenCalledWith("ses-fork");

    fireEvent.click(screen.getByLabelText("更多对话操作"));
    fireEvent.click(screen.getByRole("menuitem", { name: "归档会话" }));
    await waitFor(() => expect(archiveSession).toHaveBeenCalledWith(
      "ses-1",
      expect.objectContaining({ stopIfActive: false }),
    ));
    expect(onArchived).toHaveBeenCalledTimes(1);
  });

  it("confirms and reverses a restored user message in the current session", async () => {
    const navigateToConversation = vi.fn();
    const session = agentSession({ id: "ses-1", title: "源会话" });
    const initialHistory = [
      historyMessage("user", "历史问题", { messageEventId: "evt-user-1" }),
      historyMessage("assistant", "历史回答", { messageEventId: "evt-ai-1" }),
    ];
    const loadHistory = vi
      .fn()
      .mockResolvedValueOnce(historyResponse(session, initialHistory))
      .mockResolvedValue(historyResponse(session, []));
    const executeSessionReverse = vi.fn().mockResolvedValue(reverseResult({ restored_input: "历史问题" }));
    const { runtime } = fakeRuntime({
      session,
      loadHistory,
      executeSessionReverse,
    });

    renderConversationWithNotifications(
      <ConversationPage threadId="ses-1" runtime={runtime} onNavigateToConversation={navigateToConversation} />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "回溯到此处" }));

    expect(executeSessionReverse).not.toHaveBeenCalled();
    const dialog = await screen.findByRole("dialog", { name: "回溯到此处" });
    expect(screen.getAllByText("历史问题").length).toBeGreaterThan(0);
    fireEvent.click(await within(dialog).findByRole("button", { name: "回溯到此处" }));

    await waitFor(() => {
      expect(executeSessionReverse).toHaveBeenCalledWith(
        "ses-1",
        expect.objectContaining({
          message_event_id: "evt-user-1",
          mode: "conversation",
          decision: "full",
        }),
      );
      expect(navigateToConversation).not.toHaveBeenCalled();
      expect(loadHistory).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(screen.getByLabelText("继续输入").textContent).toBe("历史问题");
    });
    expect((await screen.findByTestId("notification-item")).textContent).toContain("已回溯到此处");
  });

  it("restores structured composer context when reversing a user message", async () => {
    const session = agentSession({
      id: "ses-1",
      title: "Workspace session",
      session_type: "workspace",
      workspace_id: "ws-1",
      cwd: "D:/repo",
      workspace_roots: ["D:/repo"],
      workspace: workspace("ws-1", "repo", "D:/repo"),
    });
    const initialHistory = [
      historyMessage("user", "please review", {
        messageEventId: "evt-user-1",
        contextItems: [
          {
            id: "skill:dev-plan",
            type: "skill",
            label: "/dev-plan",
            content: "Plan work",
            source: "workspace",
            skill_name: "dev-plan",
            skillName: "dev-plan",
            description: "Plan work",
            locator: ".keydex/skills/dev-plan/SKILL.md",
            metadata: {
              kind: "skill",
              skill_name: "dev-plan",
              source: "workspace",
              description: "Plan work",
              locator: ".keydex/skills/dev-plan/SKILL.md",
            },
          },
          {
            id: "quote:main",
            type: "source_quote",
            label: "main.ts",
            content: "export const answer = 42;",
            role: "HumanMessage",
            source: "follow",
            path: "src/main.ts",
            name: "main.ts",
            fileType: "file",
            metadata: {
              kind: "source_quote",
              source: "selection",
              path: "src/main.ts",
              name: "main.ts",
              line_start: 3,
              line_end: 4,
              source_start: 20,
              source_end: 45,
            },
          },
          {
            id: "file:readme",
            type: "file",
            label: "README.md",
            content: "workspace file: README.md",
            role: "HumanMessage",
            source: "follow",
            path: "README.md",
            name: "README.md",
            fileType: "file",
            metadata: {
              kind: "file",
              source: "workspace",
              path: "README.md",
              name: "README.md",
              fileType: "file",
            },
          },
        ],
        attachments: [
          {
            id: "att-1",
            attachment_id: "att-1",
            type: "image",
            name: "chart.png",
            path: "D:/repo/chart.png",
            source: "picker",
            mime_type: "image/png",
            size: 128,
          },
        ],
      }),
      historyMessage("assistant", "done", { messageEventId: "evt-ai-1" }),
    ];
    const loadHistory = vi
      .fn()
      .mockResolvedValueOnce(historyResponse(session, initialHistory))
      .mockResolvedValue(historyResponse(session, []));
    const chat = vi.fn();
    const { runtime } = fakeRuntime({
      session,
      chat,
      loadHistory,
      workspaceListSkills: vi.fn().mockResolvedValue({
        workspace_root: "D:/repo",
        fingerprint: "test-fingerprint",
        loaded_at: "2026-06-25T12:00:00Z",
        skills: [
          {
            name: "dev-plan",
            description: "Plan work",
            source: "workspace",
            label: "/dev-plan",
            locator: ".keydex/skills/dev-plan/SKILL.md",
          },
        ],
        diagnostics: [],
      }),
    });

    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    fireEvent.click(await screen.findByRole("button", { name: "回溯到此处" }));
    const reverseDialog = await screen.findByRole("dialog", { name: "回溯到此处" });
    fireEvent.click(await within(reverseDialog).findByRole("button", { name: "回溯到此处" }));

    const dock = await screen.findByTestId("conversation-composer");
    await waitFor(() => {
      expect(within(dock).getByRole("textbox").textContent).toBe("please review");
      expect(dock.textContent).toContain("dev-plan");
      expect(dock.textContent).toContain("main.ts");
      expect(dock.textContent).toContain("README.md");
      expect(dock.querySelector('[title="chart.png"]')).not.toBeNull();
      expect(runtime.attachments.readMedia).toHaveBeenCalledWith("att-1");
      expect(dock.querySelector('img[src="data:image/png;base64,AA=="]')).not.toBeNull();
    });

    const previewButton = dock.querySelector<HTMLButtonElement>('[title="chart.png"]');
    expect(previewButton).not.toBeNull();
    fireEvent.click(previewButton!);
    const dialog = await screen.findByRole("dialog", { name: "chart.png" });
    expect(dialog.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AA==");
    fireEvent.keyDown(document, { key: "Escape" });

    const sendButton = dock.querySelector<HTMLButtonElement>('button[type="submit"]');
    expect(sendButton).not.toBeNull();
    await waitFor(() => {
      expect(sendButton?.disabled).toBe(false);
    });
    fireEvent.click(sendButton!);

    await waitFor(() => {
      expect(chat).toHaveBeenCalled();
    });
    const payload = chat.mock.calls[0][0];
    expect(payload.message).toBe("please review");
    expect(payload.attachments).toEqual([
      {
        id: "att-1",
        attachment_id: "att-1",
        type: "image",
        name: "chart.png",
        path: "D:/repo/chart.png",
        source: "picker",
        mime_type: "image/png",
        size: 128,
      },
    ]);
    expect(payload.runtime_params.skill_activation).toEqual({
      skill_name: "dev-plan",
      source: "workspace",
      origin: "slash",
    });
    expect(payload.runtime_params.message_injection).toHaveLength(2);
    expect(JSON.stringify(payload.runtime_params.message_injection)).toContain("src/main.ts");
    expect(JSON.stringify(payload.runtime_params.message_injection)).toContain("README.md");
  });

  it("shows a product-facing message when a rewind cannot be completed", async () => {
    const session = agentSession({ id: "ses-1", title: "源会话" });
    const executeSessionReverse = vi.fn().mockRejectedValue({
      detail: { message: "该轮缺少输入前 checkpoint，不能安全回退" },
    });
    const { runtime } = fakeRuntime({
      session,
      history: [historyMessage("user", "历史问题", { messageEventId: "evt-user-1" })],
      executeSessionReverse,
    });

    renderConversationWithNotifications(<ConversationPage threadId="ses-1" runtime={runtime} />);

    fireEvent.click(await screen.findByRole("button", { name: "回溯到此处" }));
    const dialog = await screen.findByRole("dialog", { name: "回溯到此处" });
    fireEvent.click(await within(dialog).findByRole("button", { name: "回溯到此处" }));

    expect((await within(dialog).findByRole("alert")).textContent).toContain("暂时无法完成回溯，请稍后重试");
    expect((await screen.findByTestId("notification-item")).textContent).toContain("暂时无法完成回溯，请稍后重试");
    expect(document.body.textContent).not.toContain("checkpoint");
  });

  it("renders command approval as the composer instead of a conversation message", async () => {
    const { runtime, emit } = fakeRuntime();

    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await readyComposer();
    act(() => {
      emit(agentEvent("approval_requested", {
        session_id: "ses-1",
        approval: commandApproval("approval-1"),
      }));
    });

    const dock = screen.getByTestId("conversation-composer");
    expect(within(dock).getByTestId("composer-approval-card")).not.toBeNull();
    expect(within(dock).getByText("是否允许执行命令？")).not.toBeNull();
    expect(screen.getByTestId("message-surface").textContent).not.toContain("是否允许执行命令？");
    expect(screen.getByTestId("message-surface").textContent).not.toContain("pnpm test");
    expect(screen.queryByLabelText("继续输入")).toBeNull();

    fireEvent.click(within(dock).getByRole("radio", { name: "是" }));
    fireEvent.click(within(dock).getByRole("button", { name: "提交" }));

    await waitFor(() => {
      expect(screen.queryByTestId("composer-approval-card")).toBeNull();
    });
    expect(await screen.findByLabelText("继续输入")).not.toBeNull();
    expect(runtime.settings.resolveApproval).toHaveBeenCalledWith("approval-1", {
      decision: "approved",
      trust_scope: "once",
    });
  });

  it("restores injected follow context items with user history messages", async () => {
    const { runtime } = fakeRuntime({
      history: [
        historyMessage("user", "please review", {
          contextItems: [
            {
              id: "ctx-file",
              type: "file",
              label: "README.md",
              content: "workspace file: README.md",
              role: "HumanMessage",
              source: "follow",
              path: "README.md",
              fileType: "file",
            },
          ],
        }),
      ],
    });

    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    const message = await screen.findByTestId("message-text");
    expect(message.textContent).toContain("@README.md");
    expect(message.textContent).toContain("please review");
    expect(message.textContent).not.toContain("[[");
  });

  it("opens restored history file context chips in the right sidebar", async () => {
    const projectSession = agentSession({
      session_type: "workspace",
      workspace_id: "ws-1",
      workspace: workspace("ws-1", "keydex", "D:/repo/keydex"),
      cwd: "D:/repo/keydex",
    });
    const { runtime } = fakeRuntime({
      session: projectSession,
      history: [
        historyMessage("user", "please review", {
          contextItems: [
            {
              id: "ctx-file",
              type: "file",
              label: "README.md",
              content: "workspace file: README.md",
              role: "HumanMessage",
              source: "follow",
              path: "README.md",
              fileType: "file",
            },
          ],
        }),
      ],
      workspaceFilesByPath: {
        "README.md": "# README\n\n历史文件引用内容",
      },
    });

    renderConversationInLayout(<ConversationPage threadId="ses-1" runtime={runtime} />);

    const chip = await screen.findByRole("button", { name: "打开文件引用 README.md" });
    expect(screen.queryByText("workspace file: README.md")).toBeNull();

    fireEvent.click(chip);

    await waitFor(() => {
      expect(screen.getByTestId("app-shell").dataset.rightSidebar).toBe("open");
    });
    expect(await screen.findByText("历史文件引用内容", {}, { timeout: 5000 })).not.toBeNull();
    expect(runtime.workspace.readFile).toHaveBeenCalledWith({ sessionId: "ses-1" }, "README.md");
  });

  it("shows runtime typing speed above the bottom composer and scrolls to bottom from the dock button", async () => {
    const { runtime } = fakeRuntime({
      history: [historyMessage("assistant", "历史回答")],
    });
    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    expect((await screen.findByTestId("typing-speed-pill")).textContent).toBe("打字机 0 字符/s - 待输出 0 字");
    const scrollButton = screen.getByLabelText("滚动到底") as HTMLButtonElement;
    expect(scrollButton.disabled).toBe(true);

    const scroller = screen.getByTestId("message-list-scroll") as HTMLDivElement;
    mockScrollMetrics(scroller, { scrollHeight: 1000, clientHeight: 200, scrollTop: 120 });
    fireEvent.scroll(scroller);

    await waitFor(() => {
      expect(scrollButton.disabled).toBe(false);
    });

    fireEvent.click(scrollButton);
    await waitFor(() => {
      expect(scroller.scrollTop).toBe(800);
    });
  });

  it("scrolls back to the bottom when sending after reading older messages", async () => {
    const { runtime } = fakeRuntime({
      history: [historyMessage("assistant", "历史回答")],
    });
    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await readyComposer();
    const scroller = screen.getByTestId("message-list-scroll") as HTMLDivElement;
    mockScrollMetrics(scroller, { scrollHeight: 1000, clientHeight: 200, scrollTop: 120 });
    fireEvent.wheel(scroller, { deltaY: -120 });
    fireEvent.scroll(scroller);

    await waitFor(() => {
      expect((screen.getByLabelText("滚动到底") as HTMLButtonElement).disabled).toBe(false);
    });

    typeComposer("继续");
    await waitSendEnabled();
    fireEvent.click(screen.getByLabelText("发送"));

    expect(scroller.scrollTop).toBe(120);

    await waitFor(() => {
      expect(scroller.scrollTop).toBe(800);
    });
  });

  it("shows active turn file-change totals in the composer accessory", async () => {
    const { runtime, emit } = fakeRuntime();
    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await readyComposer();
    typeComposer("生成文件");
    await waitSendEnabled();
    fireEvent.click(screen.getByLabelText("发送"));

    await act(async () => {
      emit(agentEvent("tool_progress", {
        id: "evt-file-progress",
        session_id: "ses-1",
        run_id: "run-write",
        tool_name: "write_file",
        files: [
          {
            path: "docs/project-structure.md",
            operation: "add",
            additions: 149,
            deletions: 0,
          },
        ],
      }));
      emit(agentEvent("tool_progress", {
        id: "evt-file-progress-edit",
        session_id: "ses-1",
        run_id: "run-edit",
        tool_name: "apply_patch",
        files: [
          {
            path: "desktop/src/App.tsx",
            operation: "update",
            additions: 2,
            deletions: 1,
          },
        ],
      }));
    });

    const pill = await screen.findByTestId("file-change-summary-pill");
    expect(pill.textContent).toContain("本轮共创建了 1 个文件，编辑了 1 个文件");
    expect(pill.textContent).toContain("+151");
    expect(pill.textContent).toContain("-1");
    expect(screen.queryByTestId("typing-speed-pill")).toBeNull();
    expect(screen.getByTestId("file-change-summary-card").textContent).toContain("docs/project-structure.md");
    expect(screen.getByTestId("file-change-summary-card").textContent).toContain("desktop/src/App.tsx");
  });

  it("allows manually switching composer accessory items", async () => {
    const { runtime, emit } = fakeRuntime();
    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await readyComposer();
    typeComposer("生成文件");
    await waitSendEnabled();
    fireEvent.click(screen.getByLabelText("发送"));

    await act(async () => {
      emit(agentEvent("tool_progress", {
        id: "evt-file-progress",
        session_id: "ses-1",
        run_id: "run-write",
        tool_name: "write_file",
        files: [
          {
            path: "docs/project-structure.md",
            operation: "add",
            additions: 149,
            deletions: 0,
          },
        ],
      }));
    });

    expect((await screen.findByTestId("file-change-summary-pill")).textContent).toContain("+149");
    expect(screen.queryByTestId("typing-speed-pill")).toBeNull();

    fireEvent.click(screen.getByLabelText("切换胶囊信息"));
    expect(screen.getByTestId("composer-accessory-menu")).not.toBeNull();
    fireEvent.click(screen.getByRole("menuitemradio", { name: /打字机/ }));

    expect(screen.getByTestId("typing-speed-pill")).not.toBeNull();
    expect(screen.queryByTestId("file-change-summary-pill")).toBeNull();

    fireEvent.click(screen.getByLabelText("切换胶囊信息"));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /文件变更/ }));

    expect(screen.getByTestId("file-change-summary-pill").textContent).toContain("+149");
    expect(screen.queryByTestId("typing-speed-pill")).toBeNull();
  });

  it("drops active file-change totals when the progressing tool fails", async () => {
    const { runtime, emit } = fakeRuntime();
    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await readyComposer();
    typeComposer("生成文件");
    await waitSendEnabled();
    fireEvent.click(screen.getByLabelText("发送"));

    await act(async () => {
      emit(agentEvent("tool_progress", {
        id: "evt-file-progress",
        session_id: "ses-1",
        run_id: "run-write",
        tool_name: "write_file",
        files: [
          {
            path: "docs/broken.md",
            operation: "add",
            additions: 149,
            deletions: 0,
          },
        ],
      }));
    });

    expect((await screen.findByTestId("file-change-summary-pill")).textContent).toContain("+149");

    await act(async () => {
      emit(agentEvent("tool_end", {
        id: "evt-file-end",
        session_id: "ses-1",
        run_id: "run-write",
        tool_name: "write_file",
        status: "error",
        error: "write failed",
      }));
    });

    await waitFor(() => {
      expect(screen.queryByTestId("file-change-summary-pill")).toBeNull();
    });
    expect(screen.getByTestId("typing-speed-pill")).not.toBeNull();
  });

  it("keeps completed turn file-change totals until the next user message starts", async () => {
    const { runtime } = fakeRuntime({
      history: [
        historyMessage("user", "生成文件"),
        historyMessage("tool", "", {
          toolName: "write_file",
          toolParams: { path: "docs/project-structure.md" },
          fileChanges: [
            {
              path: "docs/project-structure.md",
              operation: "add",
              additions: 149,
              deletions: 0,
            },
          ],
          status: "completed",
        }),
        historyMessage("assistant", "完成"),
      ],
    });
    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    const pill = await screen.findByTestId("file-change-summary-pill");
    expect(pill.textContent).toContain("本轮共创建了 1 个文件");
    expect(pill.textContent).toContain("+149");
    expect(screen.queryByTestId("typing-speed-pill")).toBeNull();

    typeComposer("继续");
    await waitSendEnabled();
    fireEvent.click(screen.getByLabelText("发送"));

    await waitFor(() => {
      expect(screen.queryByTestId("file-change-summary-pill")).toBeNull();
    });
    expect(screen.getByTestId("typing-speed-pill").textContent).toBe("打字机 0 字符/s - 待输出 0 字");
  });

  it("restores a session plan and keeps it across the next user message", async () => {
    const { runtime } = fakeRuntime({
      history: [
        historyMessage("user", "梳理计划"),
        historyMessage("tool", "", {
          toolName: "update_plan",
          status: "completed",
          uiPayload: {
            explanation: "把计划同步到胶囊",
            entries: [
              { content: "分析现有胶囊入口", status: "completed" },
              { content: "实现计划胶囊面板", status: "in_progress" },
              { content: "补充回归测试", status: "pending" },
            ],
          },
        }),
      ],
    });
    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    const pill = await screen.findByTestId("plan-summary-pill");
    expect(pill.textContent).toBe("2/3 步");
    expect(pill.textContent).not.toContain("实现计划胶囊面板");
    expect(screen.getByTestId("typing-speed-pill")).not.toBeNull();
    expect(screen.getByTestId("plan-summary-card").textContent).not.toContain("把计划同步到胶囊");
    expect(screen.getByTestId("plan-summary-card").textContent).toContain("实现计划胶囊面板");
    expect(screen.getByTestId("plan-summary-card").textContent).toContain("补充回归测试");

    typeComposer("继续");
    await waitSendEnabled();
    fireEvent.click(screen.getByLabelText("发送"));

    await waitFor(() => {
      expect(screen.getByTestId("plan-summary-pill").textContent).toBe("2/3 步");
    });
    expect(screen.getByTestId("typing-speed-pill").textContent).toBe("打字机 0 字符/s - 待输出 0 字");
  });

  it("removes an omitted session plan step from a streaming replacement snapshot", async () => {
    const { runtime, emit } = fakeRuntime({
      history: [
        historyMessage("user", "执行旧任务"),
        historyMessage("tool", "", {
          toolName: "update_plan",
          status: "completed",
          uiPayload: {
            entries: [
              { content: "移除旧任务步骤", status: "completed" },
              { content: "保留验证步骤", status: "in_progress" },
            ],
          },
        }),
        historyMessage("user", "改为处理无关的小问题"),
      ],
    });
    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    expect((await screen.findByTestId("plan-summary-pill")).textContent).toBe("2/2 步");

    await act(async () => {
      emit(agentEvent("tool_start", {
        id: "evt-plan-replace",
        session_id: "ses-1",
        run_id: "run-plan-replace",
        tool_name: "update_plan",
        params: {
          plan: [
            { step: "保留验证步骤", status: "in_progress" },
          ],
        },
      }));
    });

    await waitFor(() => {
      expect(screen.getByTestId("plan-summary-pill").textContent).toBe("1/1 步");
    });
    expect(screen.getByTestId("plan-summary-card").textContent).not.toContain("移除旧任务步骤");
    expect(screen.getByTestId("plan-summary-card").textContent).toContain("保留验证步骤");
    expect(screen.getByTestId("typing-speed-pill")).not.toBeNull();
  });

  it("does not restore an older session plan after an empty replacement snapshot", async () => {
    const { runtime } = fakeRuntime({
      history: [
        historyMessage("user", "执行旧任务"),
        historyMessage("tool", "", {
          toolName: "update_plan",
          status: "completed",
          uiPayload: {
            entries: [{ content: "旧任务步骤", status: "completed" }],
          },
        }),
        historyMessage("user", "切换任务"),
        historyMessage("tool", "", {
          toolName: "update_plan",
          status: "completed",
          uiPayload: {
            entries: [],
          },
        }),
        historyMessage("assistant", "已切换"),
      ],
    });
    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await readyComposer();
    expect(screen.queryByTestId("plan-summary-pill")).toBeNull();
    expect(screen.getByTestId("typing-speed-pill")).not.toBeNull();
  });

  it("shows streaming update_plan arguments in the composer accessory plan panel", async () => {
    const { runtime, emit } = fakeRuntime();
    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await readyComposer();
    await act(async () => {
      emit(agentEvent("tool_start", {
        id: "evt-plan-start",
        session_id: "ses-1",
        run_id: "run-plan",
        tool_name: "update_plan",
        params: {
          plan: [
            { step: "确认计划入口", status: "completed" },
            { step: "渲染胶囊计划", status: "in_progress" },
          ],
        },
      }));
    });

    const pill = await screen.findByTestId("plan-summary-pill");
    expect(pill.textContent).toBe("2/2 步");
    expect(pill.textContent).not.toContain("渲染胶囊计划");
    expect(screen.getByTestId("typing-speed-pill")).not.toBeNull();
    expect(screen.getByTestId("plan-summary-card").textContent).toContain("确认计划入口");
    expect(screen.getByTestId("plan-summary-card").textContent).toContain("渲染胶囊计划");
  });

  it("shows failed update_plan steps in the composer accessory plan panel", async () => {
    const { runtime } = fakeRuntime({
      history: [
        historyMessage("user", "执行计划"),
        historyMessage("tool", "", {
          toolName: "update_plan",
          status: "completed",
          uiPayload: {
            entries: [
              { content: "完成前置分析", status: "completed" },
              { content: "执行集成测试", status: "failed" },
              { content: "整理验收结论", status: "pending" },
            ],
          },
        }),
      ],
    });
    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    const pill = await screen.findByTestId("plan-summary-pill");
    expect(pill.textContent).toBe("2/3 步");
    expect(pill.textContent).not.toContain("执行集成测试");
    expect(screen.getByTestId("plan-progress-ring").dataset.status).toBe("failed");
    expect(screen.getByTestId("plan-summary-card").textContent).toContain("执行集成测试");

    fireEvent.click(screen.getByLabelText("切换胶囊信息"));
    expect(screen.queryByRole("menuitemradio", { name: /计划/ })).toBeNull();
    expect(screen.getByRole("menuitemradio", { name: /打字机/ })).not.toBeNull();
  });

  it("shows a later completed update_plan step over an earlier failed step", async () => {
    const { runtime } = fakeRuntime({
      history: [
        historyMessage("user", "执行计划"),
        historyMessage("tool", "", {
          toolName: "update_plan",
          status: "completed",
          uiPayload: {
            entries: [
              { content: "完成前置分析", status: "completed" },
              { content: "编写单元测试", status: "failed" },
              { content: "执行集成测试", status: "completed" },
            ],
          },
        }),
      ],
    });
    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    const pill = await screen.findByTestId("plan-summary-pill");
    expect(pill.textContent).toBe("3/3 步");
    expect(pill.textContent).not.toContain("执行集成测试");
    expect(screen.getByTestId("plan-progress-ring").dataset.status).toBe("completed");
    expect(screen.getByTestId("plan-summary-card").textContent).toContain("编写单元测试");
    expect(screen.getByTestId("plan-summary-card").textContent).toContain("执行集成测试");
  });

  it("keeps a compact plan beside the active composer accessory item", async () => {
    const { runtime } = fakeRuntime({
      history: [
        historyMessage("user", "按计划修改文件"),
        historyMessage("tool", "", {
          toolName: "update_plan",
          status: "completed",
          uiPayload: {
            entries: [
              { content: "分析胶囊结构", status: "completed" },
              { content: "实现双槽布局", status: "in_progress" },
              { content: "验证交互行为", status: "pending" },
            ],
          },
        }),
        historyMessage("tool", "", {
          toolName: "apply_patch",
          toolParams: { path: "desktop/src/App.tsx" },
          fileChanges: [
            {
              path: "desktop/src/App.tsx",
              operation: "update",
              additions: 12,
              deletions: 3,
            },
          ],
          status: "completed",
        }),
      ],
    });
    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    const planSlot = await screen.findByTestId("persistent-plan-slot");
    const contentSlot = screen.getByTestId("composer-accessory-content");
    expect(screen.getByTestId("plan-summary-pill").textContent).toBe("2/3 步");
    expect(screen.getByTestId("file-change-summary-pill").textContent).toContain("+12");
    expect(
      Boolean(planSlot.compareDocumentPosition(contentSlot) & Node.DOCUMENT_POSITION_FOLLOWING),
    ).toBe(true);

    fireEvent.click(screen.getByLabelText("切换胶囊信息"));
    expect(screen.queryByRole("menuitemradio", { name: /计划/ })).toBeNull();
    expect(screen.getByRole("menuitemradio", { name: /文件变更/ })).not.toBeNull();
    fireEvent.click(screen.getByRole("menuitemradio", { name: /打字机/ }));

    expect(screen.getByTestId("plan-summary-pill").textContent).toBe("2/3 步");
    expect(screen.getByTestId("typing-speed-pill")).not.toBeNull();
    expect(screen.queryByTestId("file-change-summary-pill")).toBeNull();
  });

  it("excludes failed file changes from composer accessory totals", async () => {
    const { runtime } = fakeRuntime({
      history: [
        historyMessage("user", "生成文件"),
        historyMessage("tool", "", {
          toolName: "write_file",
          toolParams: { path: "docs/broken.md" },
          fileChanges: [
            {
              path: "docs/broken.md",
              operation: "add",
              additions: 149,
              deletions: 0,
            },
          ],
          status: "failed",
          toolError: "write failed",
        }),
        historyMessage("tool", "", {
          toolName: "apply_patch",
          toolParams: { path: "desktop/src/App.tsx" },
          fileChanges: [
            {
              path: "desktop/src/App.tsx",
              operation: "update",
              additions: 2,
              deletions: 1,
            },
          ],
          status: "completed",
        }),
        historyMessage("assistant", "完成"),
      ],
    });
    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    const pill = await screen.findByTestId("file-change-summary-pill");
    expect(pill.textContent).toContain("+2");
    expect(pill.textContent).toContain("-1");
    expect(pill.textContent).not.toContain("+151");
    expect(screen.getByTestId("file-change-summary-card").textContent).toContain("desktop/src/App.tsx");
    expect(screen.getByTestId("file-change-summary-card").textContent).not.toContain("docs/broken.md");
  });

  it("restores tool history as collapsed tool panels with result details", async () => {
    const { runtime } = fakeRuntime({
      history: [
        historyMessage("tool", "", {
          toolName: "read_file",
          toolParams: { path: "README.md" },
          toolResult: "文件内容",
          toolDurationMs: 1280,
          status: "completed",
        }),
      ],
    });

    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    expect((await screen.findByTestId("tool-call-block")).getAttribute("data-collapsed")).toBe("true");
    expect(screen.getByText("已读取文件 README.md")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "展开工具详情" }));
    expect(screen.getByLabelText("工具入参").textContent).toContain('"path": "README.md"');
    expect(screen.getByText("文件内容")).not.toBeNull();
  });

  it("loads deferred tool history details only when the panel is expanded", async () => {
    const { runtime } = fakeRuntime({
      history: [
        historyMessage("tool", "", {
          toolName: "read_file",
          runId: "run-read",
          toolParams: { path: "README.md" },
          toolDetailsDeferred: true,
          toolDetailRef: {
            startEventId: "evt_start",
            endEventId: "evt_end",
            runId: "run-read",
            toolCallId: "call-read",
          },
          status: "completed",
        }),
      ],
      toolDetails: {
        "evt_start:evt_end": {
          toolName: "read_file",
          runId: "run-read",
          toolCallId: "call-read",
          toolParams: { path: "README.md", content: "large input" },
          toolResult: "完整文件内容",
          toolDurationMs: 64,
          status: "completed",
        },
      },
    });
    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    expect(await screen.findByText("已读取文件 README.md")).not.toBeNull();
    expect(runtime.conversation.loadToolDetails).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "展开工具详情" }));

    await waitFor(() => {
      expect(runtime.conversation.loadToolDetails).toHaveBeenCalledWith("ses-1", {
        startEventId: "evt_start",
        endEventId: "evt_end",
        runId: "run-read",
        toolCallId: "call-read",
      });
      expect(screen.getByText("完整文件内容")).not.toBeNull();
    });
    expect(screen.getByLabelText("工具入参").textContent).toContain('"content": "large input"');

    fireEvent.click(screen.getByRole("button", { name: "收起工具详情" }));
    fireEvent.click(screen.getByRole("button", { name: "展开工具详情" }));
    expect(runtime.conversation.loadToolDetails).toHaveBeenCalledTimes(1);
  });

  it("restores hidden metadata, error and cancelled states from history", async () => {
    const { runtime } = fakeRuntime({
      history: [
        historyMessage("assistant", "完成", {
          ghostStats: {
            traceId: "trace-history",
            inputTokens: 10,
            cacheReadTokens: 2,
            outputTokens: 5,
          },
        }),
        historyMessage("error", "模型请求失败"),
        historyMessage("assistant", "已经输出的部分", { cancelled: true }),
      ],
    });

    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    expect(await screen.findByText("完成")).not.toBeNull();
    expect(screen.queryByText("trace-history")).toBeNull();
    expect(screen.queryByText(/^token /)).toBeNull();
    expect(screen.getByText("模型请求失败")).not.toBeNull();
    expect(screen.getByTestId("conversation-cancelled-notice").textContent).toBe("对话已取消");
  });

  it("streams assistant text from websocket events", async () => {
    const { runtime, emit } = fakeRuntime();
    const eventTime = new Date("2026-06-18T12:34:00+08:00").getTime();
    const expectedTime = new Date(eventTime).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await screen.findByLabelText("继续输入");

    await act(async () => {
      emit(agentEvent("stream", {
        id: "evt-stream-1",
        session_id: "ses-1",
        content: "来自事件的回答",
        timestamp_ms: eventTime,
      }));
      emit(agentEvent("completed", {
        id: "evt-stream-completed-1",
        session_id: "ses-1",
        status: "completed",
        events: [],
      }));
    });

    expect(await screen.findByText("来自事件的回答")).not.toBeNull();
    expect(screen.getByText(expectedTime)).not.toBeNull();
    expect(screen.queryByText("08:00")).toBeNull();
  });

  it("syncs persisted history after realtime completion so branch actions are available", async () => {
    const session = agentSession();
    const loadHistory = vi
      .fn()
      .mockResolvedValueOnce(historyResponse(session, []))
      .mockResolvedValue(
        historyResponse(session, [
          historyMessage("user", "实时问题", { messageEventId: "evt-user-1", turnIndex: 1 }),
          historyMessage("assistant", "实时回答", { messageEventId: "evt-ai-1", turnIndex: 1 }),
        ]),
      );
    const { runtime, emit } = fakeRuntime({ session, loadHistory });
    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await readyComposer();
    typeComposer("实时问题");
    await waitSendEnabled();
    fireEvent.click(screen.getByLabelText("发送"));
    expect(screen.queryByRole("button", { name: "回溯到此处" })).toBeNull();

    await act(async () => {
      emit(agentEvent("stream", { id: "evt-stream-realtime-actions", session_id: "ses-1", content: "实时回答" }));
      emit(agentEvent("completed", {
        id: "evt-completed-realtime-actions",
        session_id: "ses-1",
        status: "completed",
        events: [],
      }));
    });

    expect(await screen.findByRole("button", { name: "回溯到此处" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "从该轮派生对话" })).not.toBeNull();
    await waitFor(() => {
      expect(loadHistory).toHaveBeenCalledTimes(2);
    });
  });

  it("keeps the pending cursor visible after a tool result until completion", async () => {
    const { runtime, emit } = fakeRuntime();
    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await screen.findByLabelText("继续输入");

    await act(async () => {
      emit(agentEvent("stream", { id: "evt-stream-before-tool", session_id: "ses-1", content: "我先读取文件" }));
      emit(agentEvent("tool_start", {
        id: "evt-tool-start",
        session_id: "ses-1",
        run_id: "run-1",
        tool_name: "read_file",
        params: { path: "README.md" },
      }));
      emit(agentEvent("tool_end", {
        id: "evt-tool-end",
        session_id: "ses-1",
        run_id: "run-1",
        result: "文件内容",
        status: "success",
      }));
    });

    expect(await screen.findByText("已读取文件 README.md")).not.toBeNull();
    expect(screen.getByTestId("streaming-cursor")).not.toBeNull();
    expect(screen.getByLabelText("停止")).not.toBeNull();

    await act(async () => {
      emit(agentEvent("completed", {
        id: "evt-completed-after-tool",
        session_id: "ses-1",
        status: "completed",
        events: [],
      }));
    });

    await waitFor(() => {
      expect(screen.queryByTestId("streaming-cursor")).toBeNull();
    });
    expect(screen.getByLabelText("发送")).not.toBeNull();
  });

  it("sends the composer text through the bound chat channel", async () => {
    const { runtime, channel } = fakeRuntime();
    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await readyComposer();
    expect(screen.getByRole("form", { name: "继续对话输入" }).getAttribute("data-variant")).toBe("keydex");
    expect(screen.getByLabelText("选择模型").textContent).toContain("qwen-coder");
    fireEvent.click(screen.getByLabelText("选择模型"));
    expect(screen.getByRole("listbox", { name: "模型" }).closest("[data-placement]")?.getAttribute("data-placement")).toBe("top");
    fireEvent.click(screen.getByLabelText("选择模型"));
    typeComposer("继续修改");
    await waitSendEnabled();
    fireEvent.click(screen.getByLabelText("发送"));

    expect(channel.chat).toHaveBeenCalledWith({
      client_input_id: expect.any(String),
      delivery_mode: "steer",
      session_id: "ses-1",
      message: "继续修改",
      provider_id: "provider-1",
      model: "qwen-coder",
    });
    expect(screen.getByLabelText("停止")).not.toBeNull();
    expect(screen.queryByText("智能体正在处理")).toBeNull();
    expect(screen.getByLabelText("继续输入").getAttribute("contenteditable")).toBe("true");
    expect(screen.getByTestId("streaming-cursor")).not.toBeNull();
    expect(screen.queryByTestId("message-agent-status")).toBeNull();
  });

  it("uses the initial runtime model passed from quick chat", async () => {
    const { runtime, channel } = fakeRuntime({
      session: agentSession({ current_model: "deepseek-coder" }),
    });
    renderConversation(
      <ConversationPage
        threadId="ses-1"
        runtime={runtime}
        initialModel={{ providerId: "provider-1", model: "deepseek-coder" }}
      />,
    );

    await readyComposer();
    expect(screen.getByLabelText("选择模型").textContent).toContain("deepseek-coder");
    typeComposer("使用首页模型");
    await waitSendEnabled();
    fireEvent.click(screen.getByLabelText("发送"));

    expect(channel.chat).toHaveBeenCalledWith({
      client_input_id: expect.any(String),
      delivery_mode: "steer",
      session_id: "ses-1",
      message: "使用首页模型",
      provider_id: "provider-1",
      model: "deepseek-coder",
    });
  });

  it("persists model changes on the session before sending", async () => {
    const { runtime, channel } = fakeRuntime();
    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await readyComposer();
    fireEvent.click(screen.getByLabelText("选择模型"));
    fireEvent.click(screen.getByRole("option", { name: "deepseek-coder" }));

    await waitFor(() => {
      expect(runtime.conversation.updateSession).toHaveBeenCalledWith("ses-1", {
        current_model_provider_id: "provider-1",
        current_model: "deepseek-coder",
      });
    });

    typeComposer("使用切换后的模型");
    await waitSendEnabled();
    fireEvent.click(screen.getByLabelText("发送"));

    expect(channel.chat).toHaveBeenCalledWith({
      client_input_id: expect.any(String),
      delivery_mode: "steer",
      session_id: "ses-1",
      message: "使用切换后的模型",
      provider_id: "provider-1",
      model: "deepseek-coder",
    });
  });

  it("sends the queued quick chat message after the conversation route is ready", async () => {
    const { runtime, channel } = fakeRuntime();
    const queued = queueQuickChatSend({
      sessionId: "ses-1",
      model: { providerId: "provider-1", model: "deepseek-coder" },
      message: "从快速对话发送",
    });
    const onQuickSendConsumed = vi.fn();
    renderConversation(
      <ConversationPage
        threadId="ses-1"
        runtime={runtime}
        initialModel={{ providerId: "provider-1", model: "deepseek-coder" }}
        quickSendId={queued.id}
        onQuickSendConsumed={onQuickSendConsumed}
      />,
    );

    await waitFor(() => {
      expect(channel.chat).toHaveBeenCalledWith({
        client_input_id: expect.any(String),
        delivery_mode: "steer",
        session_id: "ses-1",
        message: "从快速对话发送",
        provider_id: "provider-1",
        model: "deepseek-coder",
      });
    });
    expect(onQuickSendConsumed).toHaveBeenCalledTimes(1);
    expect(screen.getByText("从快速对话发送")).not.toBeNull();
    expect(document.activeElement).toBe(screen.getByLabelText("继续输入"));
  });

  it("shows the queued quick chat message before initial history resolves", async () => {
    const session = agentSession();
    let resolveHistory: ((response: AgentHistoryResponse) => void) | null = null;
    const loadHistory = vi.fn(
      () =>
        new Promise<AgentHistoryResponse>((resolve) => {
          resolveHistory = resolve;
        }),
    );
    const { runtime, channel } = fakeRuntime({ session, loadHistory });
    const queued = queueQuickChatSend({
      sessionId: "ses-1",
      model: { providerId: "provider-1", model: "deepseek-coder" },
      message: "冷启动快速对话",
    });

    renderConversation(
      <ConversationPage
        threadId="ses-1"
        runtime={runtime}
        initialModel={{ providerId: "provider-1", model: "deepseek-coder" }}
        quickSendId={queued.id}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("冷启动快速对话")).not.toBeNull();
    });
    expect(screen.queryByTestId("conversation-empty")).toBeNull();
    expect(screen.queryByTestId("message-skeleton")).toBeNull();
    expect(screen.getByTestId("streaming-cursor")).not.toBeNull();
    expect(channel.chat).not.toHaveBeenCalled();

    await act(async () => {
      resolveHistory?.(historyResponse(session, []));
    });

    await waitFor(() => {
      expect(channel.chat).toHaveBeenCalledWith({
        client_input_id: expect.any(String),
        delivery_mode: "steer",
        session_id: "ses-1",
        message: "冷启动快速对话",
        provider_id: "provider-1",
        model: "deepseek-coder",
      });
    });
    expect(screen.queryByTestId("conversation-empty")).toBeNull();
    expect(screen.getByText("冷启动快速对话")).not.toBeNull();
  });

  it("keeps the queued user message when a non-user turn event arrives first", async () => {
    const { runtime, channel } = fakeRuntime({
      history: [historyMessage("system", "任务上下文已创建", { messageEventId: "evt-task-ready" })],
    });
    const queued = queueQuickChatSend({
      sessionId: "ses-1",
      model: { providerId: "provider-1", model: "deepseek-coder" },
      message: "先显示这条用户消息",
    });

    render(
      <AgentSessionProvider runtime={runtime}>
        <PreviewProvider>
          <ConversationWithPreloadedTurn runtime={runtime} quickSendId={queued.id} />
        </PreviewProvider>
      </AgentSessionProvider>,
    );

    await waitFor(() => {
      expect(channel.chat).toHaveBeenCalledWith(expect.objectContaining({
        session_id: "ses-1",
        message: "先显示这条用户消息",
      }));
    });
    expect(screen.getByText("先显示这条用户消息")).not.toBeNull();
  });

  it("does not resend the queued quick chat message when history already has the matching user message", async () => {
    const { runtime, channel } = fakeRuntime({
      history: [historyMessage("user", "从快速对话发送")],
    });
    const queued = queueQuickChatSend({
      sessionId: "ses-1",
      model: { providerId: "provider-1", model: "deepseek-coder" },
      message: "从快速对话发送",
    });
    const onQuickSendConsumed = vi.fn();

    renderConversation(
      <ConversationPage
        threadId="ses-1"
        runtime={runtime}
        initialModel={{ providerId: "provider-1", model: "deepseek-coder" }}
        quickSendId={queued.id}
        onQuickSendConsumed={onQuickSendConsumed}
      />,
    );

    expect(await screen.findByText("从快速对话发送")).not.toBeNull();
    await waitFor(() => {
      expect(onQuickSendConsumed).toHaveBeenCalledTimes(1);
    });
    expect(channel.chat).not.toHaveBeenCalled();
  });

  it("does not send when a quick chat route id has no queued user action", async () => {
    const { runtime, channel } = fakeRuntime();
    const onQuickSendConsumed = vi.fn();

    renderConversation(
      <ConversationPage
        threadId="ses-1"
        runtime={runtime}
        initialModel={{ providerId: "provider-1", model: "deepseek-coder" }}
        quickSendId="quick:missing"
        onQuickSendConsumed={onQuickSendConsumed}
      />,
    );

    await waitFor(() => {
      expect(onQuickSendConsumed).toHaveBeenCalledTimes(1);
    });
    expect(channel.chat).not.toHaveBeenCalled();
    expect(screen.getByLabelText("继续输入").textContent).toBe("");
  });

  it("allows sending another message after a channel error", async () => {
    const chat = vi.fn().mockImplementationOnce(() => {
      throw new Error("模型 400");
    });
    const { runtime } = fakeRuntime({ chat });
    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await readyComposer();
    typeComposer("第一次");
    await waitSendEnabled();
    fireEvent.click(screen.getByLabelText("发送"));
    expect((await screen.findAllByText("模型 400")).length).toBeGreaterThan(0);

    typeComposer("修正后继续");
    await waitSendEnabled();
    fireEvent.click(screen.getByLabelText("发送"));

    expect(chat).toHaveBeenCalledTimes(2);
    expect(chat).toHaveBeenLastCalledWith({
      client_input_id: expect.any(String),
      delivery_mode: "steer",
      session_id: "ses-1",
      message: "修正后继续",
      provider_id: "provider-1",
      model: "qwen-coder",
    });
  });

  it("allows sending another message after a duplicate tool failure event", async () => {
    const chat = vi.fn();
    const { runtime, emit } = fakeRuntime({ chat });
    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await readyComposer();
    await act(async () => {
      emit(agentEvent("error", {
        session_id: "ses-1",
        code: "duplicate_tool_call_stopped",
        message: "工具 `read_file` 使用相同参数连续调用已达 4 次，已强制终止本轮对话",
        trace_id: "trace-duplicate-tool",
        details: { tool_name: "read_file", repeat_count: 4 },
      }));
    });

    expect(
      await screen.findByText("工具 `read_file` 使用相同参数连续调用已达 4 次，已强制终止本轮对话"),
    ).not.toBeNull();
    typeComposer("调整后继续");
    await waitSendEnabled();
    fireEvent.click(screen.getByLabelText("发送"));

    expect(chat).toHaveBeenCalledWith({
      client_input_id: expect.any(String),
      delivery_mode: "steer",
      session_id: "ses-1",
      message: "调整后继续",
      provider_id: "provider-1",
      model: "qwen-coder",
    });
  });

  it("folds stack trace details out of the ordinary request error UI", async () => {
    const stack = [
      "Traceback (most recent call last):",
      '  File "D:/work/app.py", line 12, in run',
      "ValueError: boom",
    ].join("\n");
    const { runtime } = fakeRuntime({
      chat: vi.fn().mockImplementationOnce(() => {
        throw new Error(stack);
      }),
    });
    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await readyComposer();
    typeComposer("触发错误");
    await waitSendEnabled();
    fireEvent.click(screen.getByLabelText("发送"));

    expect((await screen.findAllByText("运行失败，详细信息已折叠")).length).toBeGreaterThan(0);
    expect(screen.queryByText(/app\.py/)).toBeNull();
  });

  it("cancels the active websocket turn and returns to send mode after a cancelled event", async () => {
    const { runtime, channel, emit } = fakeRuntime();
    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await screen.findByLabelText("继续输入");
    await act(async () => {
      emit(agentEvent("stream", { id: "evt-running-1", session_id: "ses-1", content: "输出中" }));
    });

    await waitFor(() => {
      expect(screen.getByLabelText("停止")).not.toBeNull();
    });
    fireEvent.click(screen.getByLabelText("停止"));

    expect(channel.cancel).toHaveBeenCalledWith("ses-1");

    await act(async () => {
      emit(agentEvent("cancelled", { id: "evt-cancel-1", session_id: "ses-1" }));
    });

    await waitFor(() => {
      expect(screen.getByLabelText("发送")).not.toBeNull();
    });
    expect(screen.getByTestId("conversation-cancelled-notice").textContent).toBe("对话已取消");
  });

  it("quotes selected assistant text into the composer", async () => {
    const { runtime, emit } = fakeRuntime();
    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await screen.findByLabelText("继续输入");
    await act(async () => {
      emit(agentEvent("stream", { id: "evt-stream-quote", session_id: "ses-1", content: "可以引用的回答" }));
    });
    await screen.findByText("可以引用的回答");

    const message = screen.getByTestId("message-text");
    const markdown = message.querySelector(".keydex-markdown");
    if (!markdown) {
      throw new Error("markdown container not found");
    }
    const selection = mockSelection(markdown, "可以引用的回答");
    act(() => {
      document.dispatchEvent(new MouseEvent("mouseup"));
    });
    fireEvent.click(await screen.findByRole("button", { name: "引用选中文本" }));

    const input = screen.getByLabelText("继续输入");
    expect(input.textContent).toBe("");
    expect(screen.getByLabelText("已添加上下文").textContent).toContain("引用片段");
    vi.useFakeTimers();
    try {
      fireEvent.mouseEnter(screen.getByText("引用片段"));
      act(() => {
        vi.advanceTimersByTime(220);
      });
      const hoverCard = document.querySelector('[data-sendbox-context-hover-card="true"]');
      expect(hoverCard?.textContent).toContain("引用片段");
      expect(hoverCard?.textContent).toContain("可以引用的回答");
      expect(screen.queryByRole("button", { name: "复制" })).toBeNull();
      expect(screen.getByRole("button", { name: /删除引用片段/ })).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
    expect(selection.removeAllRanges).toHaveBeenCalled();
    selection.restore();
  });

  it("asks selected assistant text in a bypass conversation with the same quote chip", async () => {
    const sourceSession = agentSession({ id: "ses-1" });
    const forkedSession = agentSession({
      id: "ses-btw",
      title: "旁路对话",
      session_tag: "btw",
      fork_source: sessionFork({
        source_session_id: "ses-1",
        target_session_id: "ses-btw",
        target_message_event_id: "evt-btw-ai-1",
      }),
    });
    const sourceHistory = [
      historyMessage("user", "历史问题 1", { messageEventId: "evt-user-1", turnIndex: 1 }),
      historyMessage("assistant", "历史回答 1", { messageEventId: "evt-ai-1", turnIndex: 1 }),
      historyMessage("user", "历史问题 2", { messageEventId: "evt-user-2", turnIndex: 2 }),
      historyMessage("assistant", "历史回答 2", { messageEventId: "evt-ai-2", turnIndex: 2 }),
      historyMessage("user", "历史问题 3", { messageEventId: "evt-user-3", turnIndex: 3 }),
      historyMessage("assistant", "可以旁路追问的回答", { messageEventId: "evt-ai-3", turnIndex: 3 }),
    ];
    const sidecarHistory: AgentChatMessagePayload[] = [];
    const loadHistory = vi.fn((sessionId: string) =>
      Promise.resolve(
        historyResponse(
          sessionId === "ses-btw" ? forkedSession : sourceSession,
          sessionId === "ses-btw" ? sidecarHistory : sourceHistory,
        ),
      ),
    );
    let resolveFork: ((response: { session: AgentSession; source: AgentSessionBranchSource }) => void) | null = null;
    const forkSession = vi.fn(
      () =>
        new Promise<{ session: AgentSession; source: AgentSessionBranchSource }>((resolve) => {
          resolveFork = resolve;
        }),
    );
    const { runtime } = fakeRuntime({ session: sourceSession, history: sourceHistory, loadHistory, forkSession });

    renderConversationInLayout(<ConversationPage threadId="ses-1" runtime={runtime} />, runtime);

    await screen.findByText("可以旁路追问的回答");
    const message = screen
      .getAllByTestId("message-text")
      .find((node) => node.textContent?.includes("可以旁路追问的回答"));
    if (!message) {
      throw new Error("message container not found");
    }
    const markdown = message.querySelector(".keydex-markdown");
    if (!markdown) {
      throw new Error("markdown container not found");
    }
    const selection = mockSelection(markdown, "可以旁路追问的回答");
    act(() => {
      document.dispatchEvent(new MouseEvent("mouseup"));
    });

    fireEvent.click(await screen.findByRole("button", { name: "在旁路对话中询问选中文本" }));

    expect(await screen.findByRole("status", { name: "正在打开旁路对话" })).not.toBeNull();
    expect(screen.getByRole("tab", { name: "旁路对话" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByTestId("btw-conversation-panel")).toBeNull();
    await waitFor(() => {
      expect(forkSession).toHaveBeenCalledWith("ses-1", {
        sessionTag: "btw",
        title: "旁路对话",
      });
    });
    await act(async () => {
      resolveFork?.({
        session: forkedSession,
        source: branchSource({
          message_event_id: null,
          source_type: "latest_checkpoint",
          turn_index: null,
        }),
      });
    });
    const panel = await screen.findByTestId("btw-conversation-panel");
    expect(within(panel).queryByTestId("btw-conversation-history-notice")).toBeNull();
    const sidecarInput = within(panel).getByLabelText("继续输入");
    await waitFor(() => {
      expect(document.activeElement).toBe(sidecarInput);
    });
    await waitFor(() => {
      expect(within(panel).getByLabelText("已添加上下文").textContent).toContain("引用片段");
    });
    vi.useFakeTimers();
    try {
      fireEvent.mouseEnter(within(panel).getByText("引用片段"));
      act(() => {
        vi.advanceTimersByTime(220);
      });
      const hoverCard = document.querySelector('[data-sendbox-context-hover-card="true"]');
      expect(hoverCard?.textContent).toContain("可以旁路追问的回答");
    } finally {
      vi.useRealTimers();
    }
    expect(selection.removeAllRanges).toHaveBeenCalled();
    selection.restore();
  });

  it("searches project files from the composer through the bound session workspace", async () => {
    const workspaceSearch = vi.fn().mockResolvedValue([
      { path: "README.md", name: "README.md", type: "file" },
    ]);
    const { runtime } = fakeRuntime({
      workspaceSearch,
      session: agentSession({
        session_type: "workspace",
        workspace_id: "ws-1",
        cwd: "D:/repo",
        workspace_roots: ["D:/repo"],
        workspace: workspace("ws-1", "repo", "D:/repo"),
      }),
    });
    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await screen.findByLabelText("继续输入");
    typeComposer("@READ");

    expect(await screen.findByTestId("at-file-menu")).not.toBeNull();
    await waitFor(() => {
      expect(workspaceSearch).toHaveBeenCalledWith(
        { sessionId: "ses-1" },
        "READ",
        expect.objectContaining({ signal: expect.any(Object) }),
      );
    });
    expect(await screen.findByRole("option", { name: /README\.md/ })).not.toBeNull();
  });

  it("loads default project file candidates from the composer at trigger", async () => {
    const { runtime, channel } = fakeRuntime({
      workspaceEntriesByPath: {
        "": [
          workspaceEntry("README.md", "README.md", "file", 128),
          workspaceEntry("src", "src", "directory"),
        ],
      },
      session: agentSession({
        session_type: "workspace",
        workspace_id: "ws-1",
        cwd: "D:/repo",
        workspace_roots: ["D:/repo"],
        workspace: workspace("ws-1", "repo", "D:/repo"),
      }),
    });
    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await screen.findByLabelText("继续输入");
    typeComposer("@");

    expect(await screen.findByTestId("at-file-menu")).not.toBeNull();
    await waitFor(() => {
      expect(runtime.workspace.listDirectory).toHaveBeenCalledWith({ sessionId: "ses-1" }, "");
    });
    fireEvent.mouseDown(await screen.findByRole("option", { name: "选择文件 README.md" }));

    await waitFor(() => {
      expect(screen.getByLabelText("继续输入").textContent).toBe("");
    });
    expect(screen.getByLabelText("已添加上下文").textContent).toContain("README.md");

    await waitSendEnabled();
    fireEvent.click(screen.getByLabelText("发送"));

    const chatMock = channel.chat as unknown as ReturnType<typeof vi.fn>;
    const payload = chatMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      session_id: "ses-1",
      message: "",
      model: "qwen-coder",
    });
    const runtimeParams = payload.runtime_params as { message_injection?: Array<Record<string, unknown>> } | undefined;
    expect(runtimeParams?.message_injection).toHaveLength(1);
    expect(runtimeParams?.message_injection?.[0]).toMatchObject({
      type: "follow",
      role: "HumanMessage",
      metadata: {
        kind: "file",
        path: "README.md",
        fileType: "file",
      },
    });
    expect(runtimeParams?.message_injection?.[0]?.content).toContain("README.md");
    expect(screen.getAllByTestId("message-text")[0].textContent).toContain("@README.md");
  });

  it("references a project directory and sends directory-specific context", async () => {
    const { runtime, channel } = fakeRuntime({
      workspaceEntriesByPath: {
        "": [
          workspaceEntry("README.md", "README.md", "file", 128),
          workspaceEntry("src", "src", "directory"),
        ],
        src: [workspaceEntry("index.ts", "src/index.ts", "file", 64)],
      },
      session: agentSession({
        session_type: "workspace",
        workspace_id: "ws-1",
        cwd: "D:/repo",
        workspace_roots: ["D:/repo"],
        workspace: workspace("ws-1", "repo", "D:/repo"),
      }),
    });
    renderConversationInLayout(<ConversationPage threadId="ses-1" runtime={runtime} />, runtime);

    await screen.findByLabelText("继续输入");
    typeComposer("@");
    await screen.findByRole("option", { name: "打开目录 src" });
    const referenceDirectoryButton = screen.getByRole("button", { name: "引用目录 src" });
    await act(async () => {
      fireEvent.mouseDown(referenceDirectoryButton);
    });

    await waitFor(() => {
      expect(screen.getByLabelText("继续输入").textContent).toBe("");
    });
    const composerContext = screen.getByLabelText("已添加上下文");
    expect(composerContext.textContent).toContain("src");
    expect(composerContext.querySelector('[data-context-chip-icon="directory"]')).not.toBeNull();
    const composerDirectoryChip = screen.getByRole("button", { name: "在文件列表中定位目录 src" });
    expect(composerDirectoryChip.hasAttribute("disabled")).toBe(false);

    fireEvent.click(composerDirectoryChip);
    await waitFor(() => {
      expect(screen.getByTestId("app-shell").dataset.rightSidebar).toBe("open");
    });
    expect(await screen.findByRole("button", { name: "选择文件 src/index.ts" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "折叠 src" })).not.toBeNull();
    expect(screen.getByTestId("workspace-file-browser").dataset.previewOpen).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "折叠 src" }));
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "选择文件 src/index.ts" })).toBeNull();
    });

    await waitSendEnabled();
    await act(async () => {
      fireEvent.click(screen.getByLabelText("发送"));
    });

    const chatMock = channel.chat as unknown as ReturnType<typeof vi.fn>;
    const payload = chatMock.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    const runtimeParams = payload.runtime_params as
      | {
          message_context_items?: Array<Record<string, unknown>>;
          message_injection?: Array<Record<string, unknown>>;
        }
      | undefined;
    expect(runtimeParams?.message_context_items?.[0]).toMatchObject({
      type: "file",
      path: "src",
      fileType: "directory",
    });
    expect(runtimeParams?.message_injection?.[0]).toMatchObject({
      type: "follow",
      role: "HumanMessage",
      metadata: {
        kind: "file",
        path: "src",
        fileType: "directory",
      },
    });
    expect(runtimeParams?.message_injection?.[0]?.content).toContain("用户通过 @ 引用了工作区目录：src");
    expect(runtimeParams?.message_injection?.[0]?.content).toContain("先使用可用工具列出或搜索该目录");

    const sentMessage = screen.getAllByTestId("message-text")[0];
    expect(sentMessage.textContent).toContain("@src");
    expect(sentMessage.querySelector('[data-context-chip-icon="directory"]')).not.toBeNull();
    const historyDirectoryChip = within(sentMessage).getByRole("button", {
      name: "在文件列表中定位目录 src",
    });
    expect(historyDirectoryChip.hasAttribute("disabled")).toBe(false);

    fireEvent.click(historyDirectoryChip);
    expect(await screen.findByRole("button", { name: "选择文件 src/index.ts" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "折叠 src" })).not.toBeNull();
    expect(screen.getByTestId("workspace-file-browser").dataset.previewOpen).toBe("false");
  });

  it("opens a selected file reference chip in the right sidebar file preview", async () => {
    const projectSession = agentSession({
      session_type: "workspace",
      workspace_id: "ws-1",
      workspace: workspace("ws-1", "keydex", "D:/repo/keydex"),
      cwd: "D:/repo/keydex",
    });
    const { runtime } = fakeRuntime({
      session: projectSession,
      workspaceEntriesByPath: {
        "": [workspaceEntry("README.md", "README.md", "file", 128)],
      },
      workspaceFilesByPath: {
        "README.md": "# README\n\n来自文件引用胶囊",
      },
    });

    renderConversationInLayout(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await screen.findByLabelText("继续输入");
    typeComposer("@");

    fireEvent.mouseDown(await screen.findByRole("option", { name: "选择文件 README.md" }));
    expect(await screen.findByRole("button", { name: "打开文件引用 README.md" })).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "打开文件引用 README.md" }));

    await waitFor(() => {
      expect(screen.getByTestId("app-shell").dataset.rightSidebar).toBe("open");
    });
    expect(await screen.findByRole("tab", { name: "文件" })).not.toBeNull();
    await waitFor(() => {
      expect(runtime.workspace.readFile).toHaveBeenCalledWith({ sessionId: "ses-1" }, "README.md");
    });
    expect(await screen.findByText("来自文件引用胶囊")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "折叠右侧栏" }));
    await waitFor(() => {
      expect(screen.getByTestId("app-shell").dataset.rightSidebar).toBe("closed");
    });
  });

  it("hides workspace file search inside the pure chat composer", async () => {
    const { runtime } = fakeRuntime();
    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await screen.findByLabelText("继续输入");
    typeComposer("@README");

    expect(screen.queryByTestId("at-file-menu")).toBeNull();
    expect(runtime.workspace.search).not.toHaveBeenCalled();
  });

  it("does not expose a fake workspace or empty preview entry when no panel content exists", async () => {
    const { runtime } = fakeRuntime();
    renderConversation(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await screen.findByLabelText("继续输入");

    expect(screen.queryByRole("complementary")).toBeNull();
    expect(runtime.workspace.listDirectory).not.toHaveBeenCalled();
  });

  it("opens rich message code blocks in the preview drawer", async () => {
    const { runtime, emit } = fakeRuntime();
    renderConversationInLayout(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await screen.findByLabelText("继续输入");
    await act(async () => {
      emit(agentEvent("stream", {
        id: "evt-html",
        session_id: "ses-1",
        content: "```html\n<style>h1 { color: rgb(220, 38, 38); }</style><main><h1>面板预览</h1></main>\n```",
      }));
    });

    fireEvent.click(await screen.findByRole("button", { name: "在预览面板打开 HTML 预览" }));

    const shell = screen.getByTestId("app-shell");
    await waitFor(() => {
      expect(shell.dataset.rightSidebar).toBe("open");
    }, { timeout: 8000 });
    expect(shell.dataset.rightSidebarMotion).toBe("true");
    expect(await screen.findByRole("complementary", { name: "右侧栏" })).not.toBeNull();
    const frame = (await screen.findByTitle("HTML 文件预览", {}, { timeout: 8000 })) as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("srcdoc")).toContain("<style>h1 { color: rgb(220, 38, 38); }</style>");
    expect(frame.getAttribute("srcdoc")).toContain("面板预览");
  }, 10000);

  it("opens file mutation clicks in the right sidebar review panel", async () => {
    const projectSession = agentSession({
      session_type: "workspace",
      workspace_id: "ws-1",
      workspace: workspace("ws-1", "keydex", "D:/repo/keydex"),
      cwd: "D:/repo/keydex",
    });
    const { runtime } = fakeRuntime({
      session: projectSession,
      history: [
        historyMessage("tool", "src/main.ts", {
          id: "tool-review",
          sessionId: "ses-1",
          timestamp: 1,
          toolName: "apply_patch",
          toolCallId: "call-review",
          toolParams: { path: "src/main.ts" },
          toolResult: "patched",
          status: "completed",
          fileChanges: [
            {
              path: "src/main.ts",
              operation: "update",
              added_lines: 1,
              deleted_lines: 1,
              diff: "--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1 +1 @@\n-old\n+new",
            },
          ],
        }),
      ],
      workspaceEntriesByPath: {
        "": [workspaceEntry("src", "src", "directory")],
        src: [workspaceEntry("main.ts", "src/main.ts", "file", 64)],
      },
      workspaceFilesByPath: {
        "src/main.ts": "export const value = 'new';",
      },
    });

    renderConversationInLayout(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await screen.findByLabelText("继续输入");
    fireEvent.click(within(await screen.findByTestId("tool-call-block")).getByRole("button", { name: "src/main.ts" }));

    await waitFor(() => {
      expect(screen.getByTestId("app-shell").dataset.rightSidebar).toBe("open");
    });
    expect(screen.getByRole("tab", { name: "审阅" }).getAttribute("aria-selected")).toBe("true");
    const reviewPanel = screen.getByTestId("right-sidebar-review-panel");
    expect(reviewPanel).not.toBeNull();
    expect(within(reviewPanel).queryByTestId("file-review-card")).toBeNull();
    expect(screen.getByLabelText("文件 diff").textContent).toContain("+new");
    expect(screen.queryByRole("tab", { name: "文件" })).toBeNull();

    fireEvent.click(within(reviewPanel).getByRole("button", { name: "打开文件 src/main.ts" }));

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "文件" }).getAttribute("aria-selected")).toBe("true");
    });
    expect(await screen.findByTestId("workspace-file-browser-preview")).not.toBeNull();
    await waitFor(() => {
      expect(runtime.workspace.readFile).toHaveBeenCalledWith({ sessionId: "ses-1" }, "src/main.ts");
    });
  });

  it("loads deferred file mutation details before opening the review panel", async () => {
    const { runtime } = fakeRuntime({
      history: [
        historyMessage("tool", "src/main.ts", {
          id: "tool-review-deferred",
          sessionId: "ses-1",
          timestamp: 1,
          toolName: "apply_patch",
          toolCallId: "call-review-deferred",
          toolParams: { path: "src/main.ts" },
          toolResult: "",
          status: "completed",
          toolDetailsDeferred: true,
          toolDetailRef: {
            startEventId: "start-review",
            endEventId: "end-review",
            runId: "run-review",
            toolCallId: "call-review-deferred",
          },
          fileChanges: [
            {
              path: "src/main.ts",
              operation: "update",
              added_lines: 1,
              deleted_lines: 1,
            },
          ],
        }),
      ],
      toolDetails: {
        "start-review:end-review": {
          detailRef: {
            startEventId: "start-review",
            endEventId: "end-review",
            runId: "run-review",
            toolCallId: "call-review-deferred",
          },
          toolName: "apply_patch",
          toolParams: { path: "src/main.ts" },
          toolResult: "patched",
          status: "completed",
          fileChanges: [
            {
              path: "src/main.ts",
              operation: "update",
              added_lines: 1,
              deleted_lines: 1,
              diff: "--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1 +1 @@\n-old\n+loaded",
            },
          ],
        },
      },
    });

    renderConversationInLayout(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await screen.findByLabelText("继续输入");
    fireEvent.click(within(await screen.findByTestId("tool-call-block")).getByRole("button", { name: "src/main.ts" }));

    await waitFor(() => {
      expect(runtime.conversation.loadToolDetails).toHaveBeenCalledWith("ses-1", {
        startEventId: "start-review",
        endEventId: "end-review",
        runId: "run-review",
        toolCallId: "call-review-deferred",
      });
      expect(screen.getByLabelText("文件 diff").textContent).toContain("+loaded");
    });
    expect(screen.getByRole("tab", { name: "审阅" }).getAttribute("aria-selected")).toBe("true");
  });

  it("merges same-file turn changes from the composer accessory review panel", async () => {
    const { runtime } = fakeRuntime({
      history: [
        historyMessage("user", "连续修改同一个文件"),
        historyMessage("tool", "src/main.ts", {
          id: "tool-review-old",
          sessionId: "ses-1",
          timestamp: 1,
          toolName: "apply_patch",
          toolCallId: "call-review-old",
          toolParams: { path: "src/main.ts" },
          toolResult: "patched",
          status: "completed",
          fileChanges: [
            {
              path: "src/main.ts",
              operation: "update",
              added_lines: 1,
              deleted_lines: 1,
              diff: "--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1 +1 @@\n-old\n+stale",
            },
          ],
        }),
        historyMessage("tool", "src/main.ts", {
          id: "tool-review-latest",
          sessionId: "ses-1",
          timestamp: 2,
          toolName: "apply_patch",
          toolCallId: "call-review-latest",
          toolParams: { path: "src/main.ts" },
          toolResult: "",
          status: "completed",
          toolDetailsDeferred: true,
          toolDetailRef: {
            startEventId: "start-review-latest",
            endEventId: "end-review-latest",
            runId: "run-review-latest",
            toolCallId: "call-review-latest",
          },
          fileChanges: [
            {
              path: "src/main.ts",
              operation: "update",
              added_lines: 3,
              deleted_lines: 2,
            },
          ],
        }),
      ],
      toolDetails: {
        "start-review-latest:end-review-latest": {
          detailRef: {
            startEventId: "start-review-latest",
            endEventId: "end-review-latest",
            runId: "run-review-latest",
            toolCallId: "call-review-latest",
          },
          toolName: "apply_patch",
          toolParams: { path: "src/main.ts" },
          toolResult: "patched latest",
          status: "completed",
          fileChanges: [
            {
              path: "src/main.ts",
              operation: "update",
              added_lines: 3,
              deleted_lines: 2,
              diff: "--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1 +1 @@\n-old\n+latest",
            },
          ],
        },
      },
    });

    renderConversationInLayout(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await screen.findByLabelText("继续输入");
    const card = await screen.findByTestId("file-change-summary-card");
    expect(within(card).getAllByRole("button", { name: "src/main.ts" })).toHaveLength(1);
    expect((await screen.findByTestId("file-change-summary-pill")).textContent).toContain("+4");
    expect(screen.getByTestId("file-change-summary-pill").textContent).toContain("-3");

    fireEvent.click(within(card).getByRole("button", { name: "src/main.ts" }));

    await waitFor(() => {
      expect(runtime.conversation.loadToolDetails).toHaveBeenCalledWith("ses-1", {
        startEventId: "start-review-latest",
        endEventId: "end-review-latest",
        runId: "run-review-latest",
        toolCallId: "call-review-latest",
      });
      expect(screen.getByLabelText("文件 diff").textContent).toContain("+latest");
    });
    expect(screen.getByLabelText("文件 diff").textContent).toContain("+stale");
  });

  it("does not carry preview drawer content into another session", async () => {
    const { runtime, emit } = fakeRuntime();
    const view = renderConversationInLayout(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await screen.findByLabelText("继续输入");
    await act(async () => {
      emit(agentEvent("stream", {
        id: "evt-html-session-a",
        session_id: "ses-1",
        content: "```html\n<main><h1>会话 A 面板</h1></main>\n```",
      }));
    });

    fireEvent.click(await screen.findByRole("button", { name: "在预览面板打开 HTML 预览" }));
    expect(screen.getByTestId("app-shell").dataset.rightSidebar).toBe("open");
    expect(((await screen.findByTitle("HTML 文件预览")) as HTMLIFrameElement).getAttribute("srcdoc")).toContain(
      "会话 A 面板",
    );

    const { runtime: nextRuntime } = fakeRuntime({ session: agentSession({ id: "ses-2", title: "会话 B" }) });
    view.rerender(conversationInLayout(<ConversationPage threadId="ses-2" runtime={nextRuntime} />));

    await waitFor(() => {
      expect(screen.getByTestId("app-shell").dataset.rightSidebar).toBe("open");
      expect(screen.queryByTitle("HTML 文件预览")).toBeNull();
      expect(screen.getByTestId("right-sidebar-initial-page")).not.toBeNull();
      expect(screen.getByRole("button", { name: "旁路对话" })).not.toBeNull();
    });
  });

  it("shows bypass conversation loading immediately from the right sidebar initial page", async () => {
    const sourceSession = agentSession({ id: "ses-1" });
    const forkedSession = agentSession({
      id: "ses-btw",
      title: "旁路对话",
      session_tag: "btw",
    });
    const sourceHistory = [
      historyMessage("user", "历史问题", { messageEventId: "evt-user-1", turnIndex: 1 }),
      historyMessage("assistant", "历史回答", { messageEventId: "evt-ai-1", turnIndex: 1 }),
    ];
    let resolveFork: ((response: { session: AgentSession; source: AgentSessionBranchSource }) => void) | null = null;
    const forkSession = vi.fn(
      () =>
        new Promise<{ session: AgentSession; source: AgentSessionBranchSource }>((resolve) => {
          resolveFork = resolve;
        }),
    );
    const loadHistory = vi.fn((sessionId: string) =>
      Promise.resolve(
        historyResponse(
          sessionId === "ses-btw" ? forkedSession : sourceSession,
          sessionId === "ses-btw" ? [] : sourceHistory,
        ),
      ),
    );
    const { runtime } = fakeRuntime({
      session: sourceSession,
      history: sourceHistory,
      loadHistory,
      forkSession,
    });

    renderConversationInLayout(<ConversationPage threadId="ses-1" runtime={runtime} />, runtime);

    await screen.findByLabelText("继续输入");
    fireEvent.click(screen.getByLabelText("展开右侧栏"));
    fireEvent.click(await screen.findByRole("button", { name: "旁路对话" }));

    expect(await screen.findByRole("status", { name: "正在打开旁路对话" })).not.toBeNull();
    expect(screen.getByTestId("app-shell").dataset.rightSidebar).toBe("open");
    expect(screen.getByRole("tab", { name: "旁路对话" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByTestId("btw-conversation-panel")).toBeNull();
    await waitFor(() => {
      expect(forkSession).toHaveBeenCalledWith("ses-1", {
        sessionTag: "btw",
        title: "旁路对话",
      });
    });

    await act(async () => {
      resolveFork?.({
        session: forkedSession,
        source: branchSource(),
      });
    });

    expect(await screen.findByTestId("btw-conversation-panel")).not.toBeNull();
  });

  it("opens the current project file tree from the right sidebar initial page", async () => {
    const projectSession = agentSession({
      session_type: "workspace",
      workspace_id: "ws-1",
      workspace: workspace("ws-1", "keydex", "D:/repo/keydex"),
      cwd: "D:/repo/keydex",
    });
    const { runtime } = fakeRuntime({
      session: projectSession,
      workspaceEntriesByPath: {
        "": [
          workspaceEntry("desktop", "desktop", "directory"),
          workspaceEntry("package.json", "package.json", "file", 128),
        ],
        desktop: [workspaceEntry("README.md", "desktop/README.md", "file", 64)],
      },
      workspaceFilesByPath: {
        "desktop/README.md": "# 文件预览\n\n侧边栏 Markdown 内容",
      },
    });

    renderConversationInLayout(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await screen.findByLabelText("继续输入");
    fireEvent.click(screen.getByLabelText("展开右侧栏"));

    expect(await screen.findByTestId("right-sidebar-initial-page")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "文件" }));

    expect(screen.getByRole("tab", { name: "文件" }).getAttribute("aria-selected")).toBe("true");
    expect(await screen.findByRole("tree", { name: "工作区目录" })).not.toBeNull();
    expect(await screen.findByText("desktop")).not.toBeNull();
    expect(screen.getByText("package.json")).not.toBeNull();
    expect(screen.queryByTestId("workspace-file-browser-preview")).toBeNull();
    expect(screen.queryByRole("separator", { name: "调整文件树宽度" })).toBeNull();
    expect(runtime.workspace.listDirectory).toHaveBeenCalledWith({ sessionId: "ses-1" }, "");

    fireEvent.click(screen.getByRole("button", { name: "展开 desktop" }));
    expect(await screen.findByText("README.md")).not.toBeNull();
    expect(runtime.workspace.listDirectory).toHaveBeenCalledWith({ sessionId: "ses-1" }, "desktop");

    fireEvent.click(await screen.findByRole("button", { name: "选择文件 desktop/README.md" }));
    expect(await screen.findByRole("heading", { name: "文件预览" })).not.toBeNull();
    expect(screen.getByTestId("workspace-file-browser-tree")).not.toBeNull();
    expect(screen.getByTestId("workspace-file-browser-preview")).not.toBeNull();
    expect(screen.getByRole("separator", { name: "调整文件树宽度" })).not.toBeNull();
    expect(runtime.workspace.readFile).toHaveBeenCalledWith({ sessionId: "ses-1" }, "desktop/README.md");

    fireEvent.click(screen.getByRole("button", { name: "新建侧边栏页面" }));
    expect(screen.getByRole("tab", { name: "新tab" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("right-sidebar-initial-page")).not.toBeNull();

    fireEvent.click(await screen.findByRole("button", { name: "文件" }));

    const fileTabs = screen.getAllByRole("tab", { name: "文件" });
    expect(fileTabs).toHaveLength(2);
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["文件", "文件"]);
    expect(fileTabs[0].getAttribute("aria-selected")).toBe("false");
    expect(fileTabs[1].getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByRole("heading", { name: "文件预览" })).toBeNull();
    expect(await screen.findByRole("tree", { name: "工作区目录" })).not.toBeNull();

    fireEvent.click(screen.getAllByRole("button", { name: "关闭侧边栏窗口 文件" })[1]);
    expect(screen.getAllByRole("tab", { name: "文件" })).toHaveLength(1);
    expect(await screen.findByRole("heading", { name: "文件预览" })).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "关闭侧边栏窗口 文件" }));
    expect(screen.queryByRole("tab", { name: "文件" })).toBeNull();
    expect(screen.getByTestId("app-shell").dataset.rightSidebar).toBe("closed");
    expect(screen.queryByTestId("right-sidebar-initial-page")).toBeNull();
  });

  it("restores the conversation area after quoting text from a maximized file preview", async () => {
    const projectSession = agentSession({
      session_type: "workspace",
      workspace_id: "ws-1",
      workspace: workspace("ws-1", "keydex", "D:/repo/keydex"),
      cwd: "D:/repo/keydex",
    });
    const { runtime } = fakeRuntime({
      session: projectSession,
      workspaceEntriesByPath: {
        "": [workspaceEntry("README.md", "README.md", "file", 64)],
      },
      workspaceFilesByPath: {
        "README.md": "# 文件预览\n\n侧边栏 Markdown 内容",
      },
    });

    renderConversationInLayout(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await screen.findByLabelText("继续输入");
    fireEvent.click(screen.getByLabelText("展开右侧栏"));
    fireEvent.click(await screen.findByRole("button", { name: "文件" }));
    fireEvent.click(await screen.findByRole("button", { name: "选择文件 README.md" }));

    expect(await screen.findByText("侧边栏 Markdown 内容")).not.toBeNull();
    const shell = screen.getByTestId("app-shell");
    fireEvent.click(screen.getByLabelText("展开右侧栏到对话区域"));
    expect(shell.dataset.rightSidebarMode).toBe("maximized");

    const previewBody = await screen.findByLabelText("预览内容");
    const selectableContent = previewBody.querySelector<HTMLElement>(
      "[data-file-preview-selectable-content='preview']",
    );
    expect(selectableContent).not.toBeNull();
    const selection = await showSelectionToolbar(selectableContent!, "侧边栏 Markdown 内容");
    fireEvent.click(await screen.findByRole("button", { name: "引用选中文本" }));

    expect(shell.dataset.rightSidebarMode).toBe("split");
    expect(screen.getByLabelText("已添加上下文").textContent).toContain("README.md");
    expect(selection.removeAllRanges).toHaveBeenCalled();
    selection.restore();
  });

  it("keeps the current tab order when a new tab opens the file page", async () => {
    const projectSession = agentSession({
      id: "ses-1",
      session_type: "workspace",
      workspace_id: "ws-1",
      workspace: workspace("ws-1", "keydex", "D:/repo/keydex"),
      cwd: "D:/repo/keydex",
    });
    const { runtime } = fakeRuntime({
      session: projectSession,
      workspaceEntriesByPath: {
        "": [workspaceEntry("README.md", "README.md", "file", 64)],
      },
    });

    renderConversationInLayout(<ConversationPage threadId="ses-1" runtime={runtime} />);

    await screen.findByLabelText("继续输入");
    fireEvent.click(screen.getByLabelText("展开右侧栏"));
    const addTabButton = await screen.findByRole("button", { name: "新建侧边栏页面" });

    fireEvent.click(addTabButton);
    fireEvent.click(addTabButton);
    fireEvent.click(addTabButton);

    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["新tab", "新tab", "新tab"]);
    expect(screen.getAllByRole("tab")[2].getAttribute("aria-selected")).toBe("true");

    fireEvent.click(await screen.findByRole("button", { name: "文件" }));

    expect(await screen.findByRole("tree", { name: "工作区目录" })).not.toBeNull();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["新tab", "新tab", "文件"]);
    expect(screen.getAllByRole("tab")[2].getAttribute("aria-selected")).toBe("true");
  });

  it("restores the file panel preview when switching back to a session", async () => {
    const sessionA = agentSession({
      id: "ses-a",
      title: "会话 A",
      session_type: "workspace",
      workspace_id: "ws-a",
      workspace: workspace("ws-a", "repo-a", "D:/repo/a"),
      cwd: "D:/repo/a",
    });
    const sessionB = agentSession({
      id: "ses-b",
      title: "会话 B",
      session_type: "workspace",
      workspace_id: "ws-b",
      workspace: workspace("ws-b", "repo-b", "D:/repo/b"),
      cwd: "D:/repo/b",
    });
    const { runtime: runtimeA } = fakeRuntime({
      session: sessionA,
      workspaceEntriesByPath: {
        "": [workspaceEntry("README.md", "README.md", "file", 64)],
      },
      workspaceFilesByPath: {
        "README.md": "# 会话 A 文件\n\nA 内容",
      },
    });
    const { runtime: runtimeB } = fakeRuntime({
      session: sessionB,
      workspaceEntriesByPath: {
        "": [workspaceEntry("README.md", "README.md", "file", 64)],
      },
      workspaceFilesByPath: {
        "README.md": "# 会话 B 文件\n\nB 内容",
      },
    });

    const view = renderConversationInLayout(<ConversationPage threadId="ses-a" runtime={runtimeA} />);

    await screen.findByLabelText("继续输入");
    fireEvent.click(screen.getByLabelText("展开右侧栏"));
    fireEvent.click(await screen.findByRole("button", { name: "文件" }));
    fireEvent.click(await screen.findByRole("button", { name: "选择文件 README.md" }));
    expect(await screen.findByRole("heading", { name: "会话 A 文件" })).not.toBeNull();

    view.rerender(conversationInLayout(<ConversationPage threadId="ses-b" runtime={runtimeB} />));

    await waitFor(() => {
      expect(screen.getByTestId("app-shell").dataset.rightSidebar).toBe("open");
      expect(screen.queryByRole("heading", { name: "会话 A 文件" })).toBeNull();
      expect(screen.getByTestId("right-sidebar-initial-page")).not.toBeNull();
    });

    view.rerender(conversationInLayout(<ConversationPage threadId="ses-a" runtime={runtimeA} />));

    expect(await screen.findByRole("tab", { name: "文件" })).not.toBeNull();
    expect(await screen.findByRole("heading", { name: "会话 A 文件" })).not.toBeNull();
    expect(screen.getByTestId("workspace-file-browser-preview")).not.toBeNull();
  });

  it("keeps file tab preview state isolated between sessions", async () => {
    const sessionA = agentSession({
      id: "ses-a",
      title: "会话 A",
      session_type: "workspace",
      workspace_id: "ws-a",
      workspace: workspace("ws-a", "repo-a", "D:/repo/a"),
      cwd: "D:/repo/a",
    });
    const sessionB = agentSession({
      id: "ses-b",
      title: "会话 B",
      session_type: "workspace",
      workspace_id: "ws-b",
      workspace: workspace("ws-b", "repo-b", "D:/repo/b"),
      cwd: "D:/repo/b",
    });
    const { runtime: runtimeA } = fakeRuntime({
      session: sessionA,
      workspaceEntriesByPath: {
        "": [workspaceEntry("README.md", "README.md", "file", 64)],
      },
      workspaceFilesByPath: {
        "README.md": "# 会话 A 文件\n\nA 内容",
      },
    });
    const { runtime: runtimeB } = fakeRuntime({
      session: sessionB,
      workspaceEntriesByPath: {
        "": [workspaceEntry("README.md", "README.md", "file", 64)],
      },
      workspaceFilesByPath: {
        "README.md": "# 会话 B 文件\n\nB 内容",
      },
    });

    const view = renderConversationInLayout(<ConversationPage threadId="ses-a" runtime={runtimeA} />);

    await screen.findByLabelText("继续输入");
    fireEvent.click(screen.getByLabelText("展开右侧栏"));
    fireEvent.click(await screen.findByRole("button", { name: "文件" }));
    fireEvent.click(await screen.findByRole("button", { name: "选择文件 README.md" }));
    expect(await screen.findByRole("heading", { name: "会话 A 文件" })).not.toBeNull();
    expect(screen.getByTestId("workspace-file-browser-preview")).not.toBeNull();

    view.rerender(conversationInLayout(<ConversationPage threadId="ses-b" runtime={runtimeB} />));

    await waitFor(() => {
      expect(screen.getByTestId("right-sidebar-initial-page")).not.toBeNull();
      expect(screen.queryByRole("heading", { name: "会话 A 文件" })).toBeNull();
    });
    fireEvent.click(await screen.findByRole("button", { name: "文件" }));

    expect(await screen.findByRole("tree", { name: "工作区目录" })).not.toBeNull();
    expect(screen.queryByTestId("workspace-file-browser-preview")).toBeNull();
    expect(runtimeB.workspace.readFile).not.toHaveBeenCalled();

    view.rerender(conversationInLayout(<ConversationPage threadId="ses-a" runtime={runtimeA} />));

    expect(await screen.findByRole("heading", { name: "会话 A 文件" })).not.toBeNull();
    expect(screen.getByTestId("workspace-file-browser-preview")).not.toBeNull();

    view.rerender(conversationInLayout(<ConversationPage threadId="ses-b" runtime={runtimeB} />));

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "文件" }).getAttribute("aria-selected")).toBe("true");
      expect(screen.queryByRole("heading", { name: "会话 A 文件" })).toBeNull();
      expect(screen.queryByTestId("workspace-file-browser-preview")).toBeNull();
    });
    expect(runtimeB.workspace.readFile).not.toHaveBeenCalled();
  });
});

function renderConversation(ui: ReactElement) {
  return render(<PreviewProvider>{ui}</PreviewProvider>);
}

function ConversationWithPreloadedTurn({ runtime, quickSendId }: { runtime: RuntimeBridge; quickSendId: string }) {
  const { dispatch } = useAgentSessionRuntime();
  useLayoutEffect(() => {
    dispatch({
      type: "event/receive",
      event: {
        action: "turn_started",
        data: {
          session_id: "ses-1",
          turn_index: 1,
          source: "thread_task",
        },
      },
    });
  }, [dispatch]);
  return (
    <ConversationPage
      threadId="ses-1"
      runtime={runtime}
      initialModel={{ providerId: "provider-1", model: "deepseek-coder" }}
      quickSendId={quickSendId}
    />
  );
}

function renderConversationWithNotifications(ui: ReactElement) {
  return render(
    <NotificationProvider>
      <PreviewProvider>{ui}</PreviewProvider>
    </NotificationProvider>,
  );
}

function renderConversationInLayout(ui: ReactElement, runtime?: RuntimeBridge) {
  return render(conversationInLayout(ui, runtime));
}

function conversationInLayout(ui: ReactElement, runtime?: RuntimeBridge) {
  return (
    <ThemeProvider>
      <LayoutStateProvider>
        <PreviewProvider>
          <Layout contentMode="full" runtime={runtime}>{ui}</Layout>
        </PreviewProvider>
      </LayoutStateProvider>
    </ThemeProvider>
  );
}

async function readyComposer() {
  return screen.findByLabelText("继续输入");
}

function typeComposer(value: string) {
  const input = screen.getByLabelText("继续输入");
  input.textContent = value;
  fireEvent.input(input);
  return input;
}

async function waitSendEnabled() {
  await waitFor(() => {
    expect((screen.getByLabelText("发送") as HTMLButtonElement).disabled).toBe(false);
  });
}

function reversePreview(
  overrides: Partial<Awaited<ReturnType<RuntimeBridge["conversation"]["previewSessionReverse"]>>> = {},
) {
  return {
    operation_id: "operation-1",
    source: {},
    conversation_available: true,
    code_available: false,
    default_mode: "conversation" as const,
    snapshot_id: null,
    preview_token: "preview-token-1",
    files: [],
    insertions: 0,
    deletions: 0,
    warnings: [],
    ...overrides,
  };
}

function reverseResult(
  overrides: Partial<Awaited<ReturnType<RuntimeBridge["conversation"]["executeSessionReverse"]>>> = {},
) {
  return {
    operation_id: "operation-1",
    status: "full" as const,
    mode: "conversation" as const,
    decision: "full" as const,
    conversation_rewound: true,
    restored_files: [],
    skipped_files: [],
    forced_files: [],
    failed_files: [],
    restored_input: null,
    source: {},
    error_code: null,
    ...overrides,
  };
}

function fakeRuntime({
  history = [],
  session = agentSession(),
  chat = vi.fn(),
  cancel = vi.fn(),
  forkSession = vi.fn().mockResolvedValue({
    session: agentSession({
      id: "ses-fork",
      fork_source: sessionFork({ source_session_id: session.id, target_session_id: "ses-fork" }),
    }),
    source: branchSource(),
  }),
  reverseSession = vi.fn().mockResolvedValue({
    session,
    source: branchSource(),
  }),
  previewSessionReverse = vi.fn().mockResolvedValue(reversePreview()),
  executeSessionReverse = vi.fn().mockResolvedValue(reverseResult()),
  getSessionReverseStatus = vi.fn().mockResolvedValue({
    operation_id: "operation-1",
    status: "failed",
    result: null,
    error_code: null,
    blocked_paths: [],
  }),
  getSession = vi.fn().mockResolvedValue(session),
  compressContext = vi.fn().mockResolvedValue(undefined),
  updateSession = vi.fn().mockImplementation((_sessionId: string, patch: Partial<AgentSession>) =>
    Promise.resolve({ ...session, ...patch }),
  ),
  archiveSession = vi.fn().mockImplementation((sessionId: string) => Promise.resolve({
    operation_id: "op-archive",
    request_id: "req-archive",
    session_id: sessionId,
    workspace_id: null,
    changed: true,
    archived_at: "2026-07-14T00:00:00Z",
    archive_origin: "manual",
    event: null,
  })),
  loadHistory,
  workspaceSearch = vi.fn().mockResolvedValue([]),
  workspaceListSkills = vi.fn().mockResolvedValue({
    mode: "workspace_effective",
    workspace_root: "D:/repo",
    fingerprint: "test-fingerprint",
    loaded_at: "2026-06-25T12:00:00Z",
    skills: [],
    diagnostics: [],
  }),
  workspaceEntriesByPath = { "": [] },
  workspaceFilesByPath = {},
  wsStatus = "open",
  model = "qwen-coder",
  historyError,
  toolDetails = {},
}: {
  history?: AgentChatMessagePayload[];
  session?: AgentSession;
  chat?: ReturnType<typeof vi.fn>;
  cancel?: ReturnType<typeof vi.fn>;
  forkSession?: ReturnType<typeof vi.fn>;
  reverseSession?: ReturnType<typeof vi.fn>;
  previewSessionReverse?: ReturnType<typeof vi.fn>;
  executeSessionReverse?: ReturnType<typeof vi.fn>;
  getSessionReverseStatus?: ReturnType<typeof vi.fn>;
  getSession?: ReturnType<typeof vi.fn>;
  compressContext?: ReturnType<typeof vi.fn>;
  updateSession?: ReturnType<typeof vi.fn>;
  archiveSession?: ReturnType<typeof vi.fn>;
  loadHistory?: ReturnType<typeof vi.fn>;
  workspaceSearch?: ReturnType<typeof vi.fn>;
  workspaceListSkills?: ReturnType<typeof vi.fn>;
  workspaceEntriesByPath?: Record<string, WorkspaceEntry[]>;
  workspaceFilesByPath?: Record<string, string>;
  wsStatus?: WsConnectionStatus;
  model?: string;
  historyError?: Error;
  toolDetails?: Record<string, AgentToolDetails>;
} = {}) {
  let handler: ((event: AgentActionEnvelope) => void) | null = null;
  const channel: ChatChannel = {
    close: vi.fn(),
    getStatus: vi.fn(() => wsStatus),
    getSessionId: vi.fn(() => session.id),
    createSession: vi.fn(),
    bindSession: vi.fn(),
    unbindSession: vi.fn(),
    chat,
    submitA2UI: vi.fn(),
    cancelA2UI: vi.fn(),
    approvalDecision: vi.fn(),
    cancel,
    terminateCommand: vi.fn(),
    requestStatus: vi.fn(),
    ping: vi.fn(),
  };
  const runtime = {
    conversation: {
      forkSession,
      reverseSession,
      previewSessionReverse,
      executeSessionReverse,
      getSessionReverseStatus,
      getSession,
      compressContext,
      updateSession,
      archiveSession,
      loadHistory:
        loadHistory ??
        (historyError
          ? vi.fn().mockRejectedValue(historyError)
          : vi.fn().mockResolvedValue(historyResponse(session, history))),
      loadToolDetails: vi.fn((_sessionId: string, ref: { startEventId?: string | null; endEventId?: string | null }) => {
        const key = `${ref.startEventId ?? ""}:${ref.endEventId ?? ""}`;
        const detail = toolDetails[key];
        return detail ? Promise.resolve(detail) : Promise.reject(new Error("tool detail missing"));
      }),
      openChatChannel: vi.fn((onEvent: (event: AgentActionEnvelope) => void, options?: { onStatus?: (status: WsConnectionStatus) => void }) => {
        handler = onEvent;
        options?.onStatus?.(wsStatus);
        return channel;
      }),
    },
    settings: {
      getSettings: vi.fn().mockResolvedValue({
        model: {
          base_url: "https://api.example/v1",
          model,
          timeout_seconds: 60,
          api_key_set: true,
          api_key_preview: "sk-***",
        },
        appearance: { font_family: "system" },
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
      }),
      getModelDefaults: vi.fn().mockResolvedValue({
        defaults: {
          default_chat: {
            scope: "default_chat",
            configured: Boolean(model),
            provider_id: model ? "provider-1" : null,
            provider_name: model ? "默认模型服务" : null,
            model: model || null,
            provider_enabled: model ? true : null,
            model_enabled: model ? true : null,
            missing_reason: model ? null : "not_configured",
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
      }),
      getExtensionSettings: vi.fn().mockResolvedValue(defaultExtensionSettings()),
      resolveApproval: vi.fn((approvalId: string) =>
        Promise.resolve({
          ...commandApproval(approvalId),
          status: "approved",
          decision: "approved",
          trust_scope: "once",
          resolved_at: "2026-06-17T10:00:03Z",
        }),
      ),
    },
    models: {
      listProviders: vi.fn().mockResolvedValue(
        model
          ? [
              {
                id: "provider-1",
                name: "默认模型服务",
                base_url: "https://api.example/v1",
                enabled: true,
                api_key_set: true,
                api_key_preview: "sk-***",
                models: [model, "deepseek-coder"],
                model_enabled: {},
                health: {},
              },
            ]
          : [],
      ),
    },
    skills: {
      listSession: workspaceListSkills,
      listWorkspace: workspaceListSkills,
      listSystem: workspaceListSkills,
    },
    workspace: {
      listDirectory: vi.fn((_scope: unknown, path = ""): Promise<WorkspaceTreeResponse> => {
        const entries = workspaceEntriesByPath[path];
        if (!entries) {
          return Promise.reject(new Error(`目录不存在：${path}`));
        }
        return Promise.resolve({ root: "D:/repo", entries });
      }),
      readFile: vi.fn((_scope: unknown, path: string) =>
        Promise.resolve({ path, content: workspaceFilesByPath[path] ?? "", encoding: "utf-8" }),
      ),
      readMedia: vi.fn(),
      search: workspaceSearch,
    },
    attachments: {
      uploadImage: vi.fn(),
      uploadLocalFile: vi.fn(),
      registerImagePath: vi.fn(),
      importImageUrl: vi.fn(),
      readMedia: vi.fn().mockResolvedValue({
        attachment_id: "att-1",
        path: "D:/repo/chart.png",
        name: "chart.png",
        media_type: "image",
        mime_type: "image/png",
        size: 128,
        data_url: "data:image/png;base64,AA==",
      }),
    },
  } as unknown as RuntimeBridge;
  return {
    runtime,
    channel,
    emit(event: AgentActionEnvelope) {
      handler?.(event);
    },
  };
}

function defaultExtensionSettings() {
  return {
    file_edit_tool_style: "claude_code",
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
      enabled: true,
      context_window_tokens: 256000,
      trigger_fraction: 0.8,
    },
    a2ui: {
      enabled: true,
      debug_info_enabled: false,
    },
  };
}

function historyResponse(session: AgentSession, list: AgentChatMessagePayload[]): AgentHistoryResponse {
  return {
    list,
    total: list.length,
    page: 1,
    page_size: 50,
    session,
    event_total: list.length,
    turn_indexes: list.length ? [1] : [],
  };
}

function historyMessage(
  role: AgentChatMessagePayload["role"],
  content: string,
  patch: Partial<AgentChatMessagePayload> = {},
): AgentChatMessagePayload {
  return {
    role,
    content,
    ...patch,
  } as AgentChatMessagePayload;
}

function agentSession(patch: Partial<AgentSession> = {}): AgentSession {
  return {
    id: "ses-1",
    user_id: "local-user",
    scene_id: "desktop-agent",
    status: "active",
    title: "测试对话",
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
    archived_at: null,
    archive_origin: null,
    ...patch,
  };
}

function branchSource(patch: Partial<AgentSessionBranchSource> = {}): AgentSessionBranchSource {
  return {
    session_id: "ses-1",
    active_session_id: "ses-1",
    checkpoint_id: "checkpoint-1",
    checkpoint_ns: "",
    trace_id: "trace-1",
    turn_index: 1,
    message_event_id: "evt-ai-1",
    source_type: "message_event",
    ...patch,
  };
}

function sessionFork(patch: Partial<AgentSessionFork> = {}): AgentSessionFork {
  return {
    id: "fork-1",
    source_session_id: "ses-1",
    target_session_id: "ses-fork",
    source_message_event_id: "evt-ai-1",
    target_message_event_id: "evt-fork-ai-1",
    source_turn_index: 1,
    target_turn_index: 1,
    source_trace_id: "trace-1",
    source_active_session_id: "ses-1",
    source_checkpoint_id: "checkpoint-1",
    source_checkpoint_ns: "",
    relation_type: "fork",
    created_at: "2026-06-17T10:00:00Z",
    updated_at: "2026-06-17T10:00:00Z",
    target_title: "从该轮派生对话",
    source_title: "源会话",
    ...patch,
  };
}

function workspace(id: string, name: string, rootPath: string): Workspace {
  return {
    id,
    name,
    root_path: rootPath,
    normalized_root_path: rootPath.replace(/\\/g, "/").toLowerCase(),
    type: "project",
    created_at: "2026-06-21T00:00:00Z",
    updated_at: "2026-06-21T00:00:00Z",
    last_opened_at: null,
    archived_at: null,
  };
}

function workspaceEntry(
  name: string,
  path: string,
  type: WorkspaceEntry["type"],
  size: number | null = null,
): WorkspaceEntry {
  return {
    name,
    path,
    type,
    size,
    modified_at: null,
  };
}

function agentEvent(action: AgentActionEnvelope["action"], data: Record<string, unknown>): AgentActionEnvelope {
  return { action, data } as AgentActionEnvelope;
}

function commandApproval(id: string): CommandApprovalRequest {
  return {
    id,
    session_id: "ses-1",
    thread_id: "ses-1",
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
      suggested_exact_rule: "pnpm test",
      suggested_prefix_rule: "pnpm",
    },
    status: "pending",
    created_at: "2026-06-17T10:00:02Z",
    resolved_at: null,
  };
}

async function showSelectionToolbar(container: Element, text: string) {
  const selection = mockSelection(container, text);
  await act(async () => {
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 0);
    });
    document.dispatchEvent(new MouseEvent("mouseup"));
    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 0);
    });
    document.dispatchEvent(new KeyboardEvent("keyup"));
  });
  return selection;
}

function mockSelection(container: Element, text: string) {
  const addRange = vi.fn();
  const removeAllRanges = vi.fn();
  const range = {
    commonAncestorContainer: container,
    getBoundingClientRect: () => ({
      left: 120,
      top: 140,
      right: 220,
      bottom: 160,
      width: 100,
      height: 20,
      x: 120,
      y: 140,
      toJSON: () => ({}),
    }),
  };
  const spy = vi.spyOn(window, "getSelection").mockReturnValue({
    toString: () => text,
    rangeCount: 1,
    getRangeAt: () => range,
    addRange,
    removeAllRanges,
  } as unknown as Selection);

  return {
    addRange,
    removeAllRanges,
    restore: () => spy.mockRestore(),
  };
}

function mockScrollMetrics(
  element: HTMLElement,
  metrics: { scrollHeight: number; clientHeight: number; scrollTop: number },
) {
  Object.defineProperty(element, "scrollHeight", { configurable: true, value: metrics.scrollHeight });
  Object.defineProperty(element, "clientHeight", { configurable: true, value: metrics.clientHeight });
  Object.defineProperty(element, "scrollTop", { configurable: true, writable: true, value: metrics.scrollTop });
}
