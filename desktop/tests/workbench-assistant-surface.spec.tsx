import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useMemo, useState, type ComponentProps, type PropsWithChildren } from "react";
import { describe, expect, it, vi } from "vitest";

import type { ChatChannel, RuntimeBridge, WorkspaceSkillSummary, WsConnectionStatus } from "@/runtime";
import { selectedQuoteFromText } from "@/renderer/components/chat/SendBox";
import { LayoutStateProvider } from "@/renderer/hooks/layout/LayoutStateProvider";
import type { AgentSessionController } from "@/renderer/hooks/useAgentSessionController";
import {
  WorkbenchAssistantSurface,
  WorkbenchMiniTurnNavigator,
} from "@/renderer/pages/workbench/WorkbenchAssistantSurface";
import { AgentSessionProvider } from "@/renderer/providers/AgentSessionProvider";
import { NotificationProvider } from "@/renderer/providers/NotificationProvider";
import { PreviewProvider, usePreview } from "@/renderer/providers/PreviewProvider";
import type { ConversationRuntimeState } from "@/renderer/stores/conversationStore";
import type {
  AgentActionEnvelope,
  AgentChatMessage,
  AgentSession,
  CommandApprovalRequest,
  ThreadTask,
  Workspace,
} from "@/types/protocol";

import { mockReducedMotionPreference } from "./helpers/motionPreference";

describe("WorkbenchAssistantSurface", () => {
  it("opens and focuses the bottom composer from page-level Enter", async () => {
    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchAssistantSurface
          runtime={fakeRuntime()}
          workspaceId="ws-1"
          workspace={workspace()}
          controller={fakeController()}
        />
      </WorkbenchSurfaceTestProviders>,
    );

    const surface = screen.getByTestId("workbench-assistant-surface");
    expect(surface.getAttribute("data-surface-mode")).toBe("capsule");

    fireEvent.keyDown(document, { key: "Enter" });

    await waitForSurfaceMode("composer");
    const input = await screen.findByRole("textbox", { name: "工作台助手输入" });
    await waitFor(() => {
      expect(document.activeElement).toBe(input);
    });
  });

  it("shows persisted context window usage in the bottom workbench composer", async () => {
    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchAssistantSurface
          runtime={fakeRuntime()}
          workspaceId="ws-1"
          workspace={workspace()}
          controller={fakeController({
            session: session("ses-usage", { context_window_usage: contextWindowUsage("ses-usage", 5371) }),
          })}
        />
      </WorkbenchSurfaceTestProviders>,
    );

    openWorkbenchComposerIfCollapsed();

    const indicator = await screen.findByTestId("context-window-indicator");
    await waitFor(() => {
      const label = indicator.getAttribute("aria-label");
      expect(label).toContain("5,371 tokens");
      expect(label).toContain("3.36%");
    });
  });

  it("keeps the MCP accessory selectable in the workbench composer", async () => {
    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchAssistantSurface
          runtime={fakeRuntime()}
          workspaceId="ws-1"
          workspace={workspace()}
          controller={fakeController()}
        />
      </WorkbenchSurfaceTestProviders>,
    );

    openWorkbenchComposerIfCollapsed();
    fireEvent.click(screen.getByTestId("composer-accessory-switcher"));

    const mcpItem = within(screen.getByTestId("composer-accessory-menu")).getByRole("menuitemradio", { name: /MCP/ });
    expect((mcpItem as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(mcpItem);
    expect(await screen.findByTestId("mcp-runtime-pill")).not.toBeNull();
  });

  it("shows persisted context window usage in the drawer workbench composer", async () => {
    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchAssistantSurface
          runtime={fakeRuntime()}
          workspaceId="ws-1"
          workspace={workspace()}
          controller={fakeController({
            session: session("ses-usage", { context_window_usage: contextWindowUsage("ses-usage", 5371) }),
          })}
        />
      </WorkbenchSurfaceTestProviders>,
    );

    fireEvent.click(screen.getByRole("button", { name: "将工作台助手展开到右侧" }));
    await waitForSurfaceMode("drawer", 8000);

    const drawerFrame = screen.getByTestId("workbench-assistant-drawer-composer-frame");
    const indicator = within(drawerFrame).getByTestId("context-window-indicator");
    await waitFor(() => {
      const label = indicator.getAttribute("aria-label");
      expect(label).toContain("5,371 tokens");
      expect(label).toContain("3.36%");
    });
  });

  it("creates a goal task from the workbench slash command and sends the seed turn", async () => {
    const createThreadTask = vi.fn().mockResolvedValue(threadTask({ objective: "完成工作台目标" }));
    const sendText = vi.fn().mockResolvedValue(true);
    const runtime = fakeRuntime({ createThreadTask });

    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchGoalHarness runtime={runtime} sendText={sendText} />
      </WorkbenchSurfaceTestProviders>,
    );

    openWorkbenchComposerIfCollapsed();
    typeWorkbenchComposer("/目标");
    fireEvent.keyDown(screen.getByRole("textbox", { name: "工作台助手输入" }), { key: "Enter" });

    expect(await screen.findByTestId("goal-mode-accessory")).not.toBeNull();

    typeWorkbenchComposer("完成工作台目标");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => {
      expect(createThreadTask).toHaveBeenCalled();
    });
    expect(createThreadTask).toHaveBeenCalledWith(
      "ses-1",
      expect.objectContaining({
        type: "goal",
        objective: "完成工作台目标",
        metadata: {
          seed_turn_context: expect.objectContaining({
            schema_version: 1,
            source: "goal_composer",
            message: "完成工作台目标",
            context_items: [],
            runtime_params: {},
            attachments: [],
          }),
        },
      }),
    );
    await waitFor(() => {
      expect(sendText).toHaveBeenCalled();
    });
    expect(sendText.mock.calls[0][0]).toBe("完成工作台目标");
    expect(sendText.mock.calls[0][2]).toEqual(
      expect.objectContaining({
        clearDraft: true,
        targetSessionId: "ses-1",
        contextItems: expect.arrayContaining([
          expect.objectContaining({
            type: "goal",
            label: "目标",
            content: "完成工作台目标",
          }),
        ]),
        runtimeParams: expect.objectContaining({
          initial_thread_task: {
            task_id: "task-1",
            type: "goal",
            trigger: "task_start",
          },
          message_context_items: expect.arrayContaining([
            expect.objectContaining({
              type: "goal",
              content: "完成工作台目标",
            }),
          ]),
        }),
        attachments: [],
      }),
    );
    await waitFor(() => {
      expect(screen.queryByTestId("goal-mode-accessory")).toBeNull();
    });
  });

  it("keeps the workbench goal entry from opening when an active task already exists", async () => {
    const createThreadTask = vi.fn();

    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchGoalHarness
          runtime={fakeRuntime({ createThreadTask })}
          activeTask={threadTask({ objective: "已有目标" })}
        />
      </WorkbenchSurfaceTestProviders>,
    );

    openWorkbenchComposerIfCollapsed();
    typeWorkbenchComposer("/目标");
    fireEvent.keyDown(screen.getByRole("textbox", { name: "工作台助手输入" }), { key: "Enter" });

    expect(screen.queryByTestId("goal-mode-accessory")).toBeNull();
    expect(createThreadTask).not.toHaveBeenCalled();
  });

  it("ensures a new workbench session before creating a goal task", async () => {
    const ensuredSession = session("ses-new");
    const onEnsureSession = vi.fn().mockResolvedValue(ensuredSession);
    const createThreadTask = vi.fn().mockResolvedValue(threadTask({ objective: "新会话目标" }));
    const sendText = vi.fn().mockResolvedValue(true);
    const runtime = fakeRuntime({ createThreadTask });

    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchGoalHarness
          runtime={runtime}
          sendText={sendText}
          sessionValue={null}
          onEnsureSession={onEnsureSession}
        />
      </WorkbenchSurfaceTestProviders>,
    );

    openWorkbenchComposerIfCollapsed();
    typeWorkbenchComposer("/目标");
    fireEvent.keyDown(screen.getByRole("textbox", { name: "工作台助手输入" }), { key: "Enter" });
    typeWorkbenchComposer("新会话目标");
    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => {
      expect(onEnsureSession).toHaveBeenCalled();
    });
    expect(onEnsureSession).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "新会话目标",
        message: "新会话目标",
      }),
    );
    await waitFor(() => {
      expect(createThreadTask).toHaveBeenCalledWith(
        "ses-new",
        expect.objectContaining({
          type: "goal",
          objective: "新会话目标",
        }),
      );
    });
    expect(sendText.mock.calls[0][0]).toBe("新会话目标");
    expect(sendText.mock.calls[0][2]).toEqual(
      expect.objectContaining({
        targetSessionId: "ses-new",
        runtimeParams: expect.objectContaining({
          initial_thread_task: {
            task_id: "task-1",
            type: "goal",
            trigger: "task_start",
          },
        }),
      }),
    );
  });

  it("renders a workbench bypass drawer as a temporary conversation panel", async () => {
    const onCloseBtwConversation = vi.fn();
    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchAssistantSurface
          runtime={fakeRuntime()}
          workspaceId="ws-1"
          workspace={workspace()}
          controller={fakeController({
            session: session("btw-1", { title: "旁路对话", session_tag: "btw" }),
            agentMessages: [
              agentMessage({ id: "history-user", role: "user", content: "历史用户消息" }),
              agentMessage({ id: "history-assistant", role: "assistant", content: "历史助手消息" }),
            ],
          })}
          btwActive
          btwLoadedHistoryTurnCount={3}
          onCloseBtwConversation={onCloseBtwConversation}
        />
      </WorkbenchSurfaceTestProviders>,
    );

    fireEvent.click(screen.getByRole("button", { name: "将工作台助手展开到右侧" }));
    await waitForSurfaceMode("drawer", 8000);

    const notice = await screen.findByTestId("btw-conversation-history-notice");
    expect(notice.textContent).toContain("该会话前置3轮历史消息已加载");
    expect(notice.querySelector("svg")).toBeNull();
    expect(screen.queryByText("历史用户消息")).toBeNull();
    expect(screen.queryByText("历史助手消息")).toBeNull();
    const input = screen.getByRole("textbox", { name: "工作台助手输入" });
    await waitFor(() => {
      expect(document.activeElement).toBe(input);
    });

    const header = screen.getByTestId("workbench-assistant-drawer-header");
    fireEvent.click(within(header).getByRole("button", { name: "返回主对话" }));
    expect(onCloseBtwConversation).toHaveBeenCalledTimes(1);
  });

  it("keeps the workbench bypass drawer pinned to new turns after history refreshes", async () => {
    const btwSession = session("btw-1", { title: "旁路对话", session_tag: "btw" });
    const initialHistory = [
      agentMessage({
        id: "history-user-1",
        sessionId: "btw-1",
        role: "user",
        content: "历史用户消息 1",
        turnIndex: 1,
      }),
      agentMessage({
        id: "history-assistant-1",
        sessionId: "btw-1",
        role: "assistant",
        content: "历史助手消息 1",
        turnIndex: 1,
      }),
      agentMessage({
        id: "history-user-2",
        sessionId: "btw-1",
        role: "user",
        content: "历史用户消息 2",
        turnIndex: 2,
      }),
      agentMessage({
        id: "history-assistant-2",
        sessionId: "btw-1",
        role: "assistant",
        content: "历史助手消息 2",
        turnIndex: 2,
      }),
    ];
    const { rerender } = render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchAssistantSurface
          runtime={fakeRuntime()}
          workspaceId="ws-1"
          workspace={workspace()}
          controller={fakeController({ session: btwSession, agentMessages: initialHistory })}
          btwActive
        />
      </WorkbenchSurfaceTestProviders>,
    );

    fireEvent.click(screen.getByRole("button", { name: "将工作台助手展开到右侧" }));
    await waitForSurfaceMode("drawer", 8000);

    const notice = await screen.findByTestId("btw-conversation-history-notice");
    expect(notice.textContent).toContain("该会话前置2轮历史消息已加载");
    expect(screen.queryByText("历史用户消息 1")).toBeNull();
    expect(screen.queryByText("历史助手消息 2")).toBeNull();

    rerender(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchAssistantSurface
          runtime={fakeRuntime()}
          workspaceId="ws-1"
          workspace={workspace()}
          controller={fakeController({
            session: btwSession,
            agentMessages: [
              agentMessage({
                id: "history-user-1-refresh",
                sessionId: "btw-1",
                role: "user",
                content: "历史用户消息 1",
                turnIndex: 1,
              }),
              agentMessage({
                id: "history-assistant-1-refresh",
                sessionId: "btw-1",
                role: "assistant",
                content: "历史助手消息 1",
                turnIndex: 1,
              }),
              agentMessage({
                id: "history-user-2-refresh",
                sessionId: "btw-1",
                role: "user",
                content: "历史用户消息 2",
                turnIndex: 2,
              }),
              agentMessage({
                id: "history-assistant-2-refresh",
                sessionId: "btw-1",
                role: "assistant",
                content: "历史助手消息 2",
                turnIndex: 2,
              }),
              agentMessage({ id: "new-user", sessionId: "btw-1", role: "user", content: "新的旁路问题", turnIndex: 3 }),
              agentMessage({
                id: "new-assistant",
                sessionId: "btw-1",
                role: "assistant",
                content: "新的旁路回答",
                turnIndex: 3,
              }),
            ],
          })}
          btwActive
        />
      </WorkbenchSurfaceTestProviders>,
    );

    expect(screen.getByTestId("btw-conversation-history-notice").textContent).toContain(
      "该会话前置2轮历史消息已加载",
    );
    expect(screen.queryByText("历史用户消息 1")).toBeNull();
    expect(screen.queryByText("历史助手消息 2")).toBeNull();
    expect(await screen.findByText("新的旁路问题")).not.toBeNull();
    expect(screen.getByText("新的旁路回答")).not.toBeNull();
  });

  it("updates context window usage in the workbench composer from live runtime snapshots", async () => {
    const { runtime, emit } = fakeRuntimeWithEvents();
    render(
      <WorkbenchSurfaceTestProviders>
        <AgentSessionProvider runtime={runtime}>
          <WorkbenchAssistantSurface
            runtime={runtime}
            workspaceId="ws-1"
            workspace={workspace()}
            controller={fakeController({ session: session("ses-live") })}
          />
        </AgentSessionProvider>
      </WorkbenchSurfaceTestProviders>,
    );

    openWorkbenchComposerIfCollapsed();
    const indicator = await screen.findByTestId("context-window-indicator");
    expect(indicator.getAttribute("aria-label")).toContain("等待下一次模型调用");

    await act(async () => {
      emit({
        action: "middleware_progress",
        data: {
          session_id: "ses-live",
          active_session_id: "ses-live",
          middleware: "ContextCompressionMiddleware",
          stage: "context_window_snapshot",
          timestamp_ms: 2000,
          token_count: 5371,
          context_window: 200000,
          threshold_token_count: 160000,
          threshold_usage_fraction: 5371 / 160000,
          token_source: "usage_metadata",
        },
      } as AgentActionEnvelope);
    });

    await waitFor(() => {
      const label = indicator.getAttribute("aria-label");
      expect(label).toContain("5,371 tokens");
      expect(label).toContain("3.36%");
    });
  });

  it("does not steal Enter from focused editable controls", async () => {
    render(
      <WorkbenchSurfaceTestProviders>
        <input aria-label="外部输入" />
        <WorkbenchAssistantSurface
          runtime={fakeRuntime()}
          workspaceId="ws-1"
          workspace={workspace()}
          controller={fakeController()}
        />
      </WorkbenchSurfaceTestProviders>,
    );

    const surface = screen.getByTestId("workbench-assistant-surface");
    const outsideInput = screen.getByLabelText("外部输入");
    await act(async () => {
      outsideInput.focus();
    });

    fireEvent.keyDown(outsideInput, { key: "Enter" });

    expect(surface.getAttribute("data-surface-mode")).toBe("capsule");
    expect(document.activeElement).toBe(outsideInput);
  });

  it("keeps a stable assistant shell while switching surface modes", async () => {
    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchAssistantSurface
          runtime={fakeRuntime()}
          workspaceId="ws-1"
          workspace={workspace()}
          controller={fakeController()}
        />
      </WorkbenchSurfaceTestProviders>,
    );

    const shell = screen.getByTestId("workbench-assistant-shell");
    const chrome = screen.getByTestId("workbench-assistant-chrome");
    expect(shell.getAttribute("data-shell-mode")).toBe("capsule");
    expect(chrome.getAttribute("data-shell-mode")).toBe("capsule");

    fireEvent.click(screen.getByRole("button", { name: "展开工作台输入框" }));
    await waitFor(() => {
      expect(screen.getByTestId("workbench-assistant-shell")).toBe(shell);
      expect(screen.getByTestId("workbench-assistant-chrome")).toBe(chrome);
      expect(shell.getAttribute("data-shell-mode")).toBe("composer");
      expect(chrome.getAttribute("data-shell-mode")).toBe("composer");
    });

    fireEvent.click(screen.getByRole("button", { name: "将工作台助手展开到右侧" }));
    expect(screen.getByTestId("workbench-assistant-shell")).toBe(shell);
    expect(screen.getByTestId("workbench-assistant-chrome")).toBe(chrome);
    expect(shell.getAttribute("data-shell-mode")).toBe("dock-morph");
    expect(chrome.getAttribute("data-shell-mode")).toBe("dock-morph");
    expect(screen.getByTestId("workbench-assistant-composer-frame").getAttribute("data-message-trigger-visible")).toBe("false");
    expect(screen.queryByTestId("workbench-message-trigger")).toBeNull();
    expect(screen.getByTestId("workbench-assistant-morph-panel")).not.toBeNull();
    expect(screen.getByTestId("workbench-assistant-morph-middle").getAttribute("data-content-state")).toBe("deferred");
    expect(screen.queryByTestId("conversation-panel")).toBeNull();

    await waitForSurfaceMode("drawer", 8000);
    expect(screen.getByTestId("workbench-assistant-shell")).toBe(shell);
    expect(screen.getByTestId("workbench-assistant-chrome")).toBe(chrome);
    expect(shell.getAttribute("data-shell-mode")).toBe("drawer");
    expect(chrome.getAttribute("data-shell-mode")).toBe("drawer");
    expect(screen.getByTestId("workbench-assistant-drawer-composer-frame").getAttribute("data-message-trigger-visible")).toBe("false");
    expect(screen.getByTestId("conversation-panel")).not.toBeNull();
  });

  it("keeps the same chrome while undocking from the drawer", async () => {
    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchAssistantSurface
          runtime={fakeRuntime()}
          workspaceId="ws-1"
          workspace={workspace()}
          controller={fakeController({ draft: "继续修改 README" })}
        />
      </WorkbenchSurfaceTestProviders>,
    );

    const surface = screen.getByTestId("workbench-assistant-surface");
    const shell = screen.getByTestId("workbench-assistant-shell");
    const chrome = screen.getByTestId("workbench-assistant-chrome");

    fireEvent.click(screen.getByRole("button", { name: "将工作台助手展开到右侧" }));
    expect(surface.getAttribute("data-surface-mode")).toBe("composer");
    expect(surface.getAttribute("data-visual-mode")).toBe("dock-morph");
    expect(surface.getAttribute("data-dock-layout")).toBe("overlay");
    expect(surface.getAttribute("data-dock-transition")).toBe("dock-in");
    expect(surface.getAttribute("data-session-title-visible")).toBe("false");
    expect(screen.getByTestId("workbench-assistant-composer-frame").getAttribute("data-session-title-visible")).toBe(
      "false",
    );
    expect(screen.getByTestId("workbench-assistant-session-title").getAttribute("data-empty")).toBe("true");
    expect(screen.getByTestId("workbench-assistant-morph-panel")).not.toBeNull();
    expect(screen.getByTestId("workbench-assistant-morph-header")).not.toBeNull();
    expect(screen.getByTestId("workbench-assistant-morph-middle")).not.toBeNull();
    expect(screen.queryByTestId("workbench-assistant-morph-loading")).toBeNull();
    expect(screen.getByTestId("workbench-assistant-morph-middle").getAttribute("data-content-state")).toBe("deferred");
    expect(screen.queryByTestId("conversation-panel")).toBeNull();
    expect(screen.queryByTestId("workbench-assistant-drawer")).toBeNull();
    expect(screen.getByLabelText("工作台助手输入").textContent).toContain("继续修改 README");
    await waitForSurfaceMode("drawer");
    expect(screen.queryByRole("button", { name: "展开工作台消息层" })).toBeNull();
    expect(screen.queryByTestId("workbench-message-trigger")).toBeNull();
    expect(screen.getByRole("button", { name: "收回工作台助手为胶囊" })).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "关闭工作台助手侧栏" }));

    expect(screen.getByTestId("workbench-assistant-shell")).toBe(shell);
    expect(screen.getByTestId("workbench-assistant-chrome")).toBe(chrome);
    expect(surface.getAttribute("data-surface-mode")).toBe("drawer");
    expect(surface.getAttribute("data-visual-mode")).toBe("dock-out-morph");
    expect(surface.getAttribute("data-geometry-mode")).toBe("composer");
    expect(surface.getAttribute("data-dock-layout")).toBe("overlay");
    expect(surface.getAttribute("data-dock-transition")).toBe("dock-out");
    expect(shell.getAttribute("data-transition-phase")).toBe("dock-out");
    expect(screen.getByTestId("workbench-assistant-composer-frame").getAttribute("data-message-trigger-visible")).toBe("true");
    expect(screen.getByTestId("workbench-message-trigger").getAttribute("data-state")).toBe("idle");
    expect(screen.getByTestId("workbench-assistant-morph-panel")).not.toBeNull();
    expect(screen.queryByTestId("workbench-assistant-morph-loading")).toBeNull();
    expect(screen.getByTestId("workbench-assistant-morph-middle").getAttribute("data-content-state")).toBe("deferred");
    expect(screen.queryByTestId("conversation-panel")).toBeNull();
    expect(screen.getByLabelText("工作台助手输入").textContent).toContain("继续修改 README");

    await waitForDockTransitionIdle();
    expect(surface.getAttribute("data-surface-mode")).toBe("composer");
    expect(surface.getAttribute("data-dock-layout")).toBe("overlay");
    expect(screen.getByTestId("workbench-assistant-shell")).toBe(shell);
    expect(screen.getByTestId("workbench-assistant-chrome")).toBe(chrome);
  });

  it("keeps composer content mounted while shrinking to a collapsed capsule target", async () => {
    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchAssistantSurface
          runtime={fakeRuntime()}
          workspaceId="ws-1"
          workspace={workspace()}
          controller={fakeController({
            agentMessages: [
              agentMessage({ id: "user-1", role: "user", content: "第一轮问题" }),
              agentMessage({ id: "assistant-1", role: "assistant", content: "第一轮回答" }),
              agentMessage({ id: "user-2", role: "user", content: "第二轮问题" }),
              agentMessage({ id: "assistant-2", role: "assistant", content: "第二轮回答" }),
            ],
          })}
        />
      </WorkbenchSurfaceTestProviders>,
    );

    const surface = screen.getByTestId("workbench-assistant-surface");
    fireEvent.click(screen.getByRole("button", { name: "将工作台助手展开到右侧" }));
    await waitForSurfaceMode("drawer");
    expect(screen.queryByRole("button", { name: "展开工作台消息层" })).toBeNull();
    expect(screen.getByRole("button", { name: "收回工作台助手为胶囊" })).not.toBeNull();
    expect(screen.queryByTestId("workbench-mini-turn-navigator")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "收回工作台助手为胶囊" }));

    expect(surface.getAttribute("data-surface-mode")).toBe("drawer");
    expect(surface.getAttribute("data-visual-mode")).toBe("dock-out-morph");
    expect(surface.getAttribute("data-geometry-mode")).toBe("capsule");
    expect(surface.getAttribute("data-dock-transition")).toBe("dock-out");
    expect(screen.getByTestId("workbench-assistant-capsule").getAttribute("data-compose-open")).toBe("true");
    expect(screen.getByTestId("workbench-assistant-capsule").getAttribute("data-compose-collapsing")).toBe("true");
    expect(screen.getByLabelText("工作台助手输入")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "展开工作台输入框" })).toBeNull();
    expect(screen.getByTestId("workbench-assistant-composer-frame").getAttribute("data-mini-navigator-visible")).toBe(
      "true",
    );
    expect(screen.getByTestId("workbench-mini-turn-navigator").getAttribute("data-turn-count")).toBe("2");

    await waitForDockTransitionIdle();
    expect(surface.getAttribute("data-surface-mode")).toBe("capsule");
    expect(screen.getByTestId("workbench-assistant-capsule").getAttribute("data-compose-open")).toBe("false");
    expect(screen.getByTestId("workbench-mini-turn-navigator").getAttribute("data-turn-count")).toBe("2");
  });

  it("uses a lightweight drawer header instead of the full Agent chat layout header", async () => {
    const stop = vi.fn();
    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchAssistantSurface
          runtime={fakeRuntime()}
          workspaceId="ws-1"
          workspace={workspace()}
          controller={fakeController({ runtimeState: "running" as ConversationRuntimeState, canStop: true, stop })}
        />
      </WorkbenchSurfaceTestProviders>,
    );

    fireEvent.click(screen.getByRole("button", { name: "将工作台助手展开到右侧" }));
    await waitForSurfaceMode("drawer");

    const header = await screen.findByTestId("workbench-assistant-drawer-header");
    expect(header.textContent).toContain("Workbench");
    expect(header.textContent).toContain("运行中");
    expect(screen.getByTestId("workbench-assistant-surface").getAttribute("data-session-title-visible")).toBe("false");
    expect(screen.getByTestId("workbench-assistant-drawer-composer-frame").getAttribute("data-session-title-visible")).toBe(
      "false",
    );
    expect(screen.getByTestId("workbench-assistant-session-title").getAttribute("data-empty")).toBe("true");
    expect(screen.getByRole("button", { name: "关闭工作台助手侧栏" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("chat-layout")).toBeNull();
    expect(screen.queryByRole("button", { name: "更多对话操作" })).toBeNull();
  });

  it("shows a left-edge resize handle while the workbench assistant drawer is open", async () => {
    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchAssistantSurface
          runtime={fakeRuntime()}
          workspaceId="ws-1"
          workspace={workspace()}
          controller={fakeController()}
        />
      </WorkbenchSurfaceTestProviders>,
    );

    fireEvent.click(screen.getByRole("button", { name: "将工作台助手展开到右侧" }));
    await waitForSurfaceMode("drawer");

    const surface = screen.getByTestId("workbench-assistant-surface");
    const handle = screen.getByTestId("workbench-assistant-drawer-resize-handle");
    expect(surface.style.getPropertyValue("--workbench-assistant-dock-width")).toBe("360px");
    expect(handle.getAttribute("role")).toBe("separator");
    expect(handle.getAttribute("aria-orientation")).toBe("vertical");
    expect(handle.getAttribute("data-visible")).toBe("true");
    expect(handle.getAttribute("title")).toBe("拖动调整宽度，双击恢复默认宽度");

    act(() => {
      dispatchPointer(handle, "pointerdown", { button: 0, pointerId: 7, clientX: 400 });
    });
    await waitFor(() => {
      expect(handle.getAttribute("data-dragging")).toBe("true");
    });
    act(() => {
      dispatchPointer(window, "pointermove", { pointerId: 7, clientX: 280 });
    });
    await waitFor(() => {
      expect(surface.style.getPropertyValue("--workbench-assistant-dock-width")).toBe("480px");
    });
    act(() => {
      dispatchPointer(window, "pointerup", { pointerId: 7, clientX: 280 });
    });

    fireEvent.doubleClick(handle);
    expect(surface.style.getPropertyValue("--workbench-assistant-dock-width")).toBe("360px");
  });

  it("renders the shared approval card in the bottom and drawer composer areas", async () => {
    const submitApproval = vi.fn().mockResolvedValue(undefined);
    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchAssistantSurface
          runtime={fakeRuntime()}
          workspaceId="ws-1"
          workspace={workspace()}
          controller={fakeController({
            runtimeState: "waiting_approval" as ConversationRuntimeState,
            pendingApproval: approvalRequest(),
            submitApproval,
          })}
        />
      </WorkbenchSurfaceTestProviders>,
    );

    const surface = screen.getByTestId("workbench-assistant-surface");
    expect(surface.getAttribute("data-surface-mode")).toBe("capsule");
    expect(surface.getAttribute("data-message-trigger-state")).toBe("approval");
    const carrier = screen.getByTestId("workbench-message-carrier");
    expect(carrier.getAttribute("data-state")).toBe("approval");
    expect(carrier.textContent).toContain("等待审批，点击处理");
    expect(screen.queryByTestId("workbench-assistant-drawer")).toBeNull();
    expect(screen.queryByTestId("workbench-approval-prompt")).toBeNull();
    expect(screen.queryByTestId("composer-approval-card")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "展开工作台输入框" }));

    await waitFor(() => {
      expect(surface.getAttribute("data-surface-mode")).toBe("composer");
    });
    const bottomInputSurface = screen.getByTestId("workbench-assistant-input-surface");
    expect(within(bottomInputSurface).getByTestId("composer-approval-card")).not.toBeNull();
    expect(screen.queryByRole("textbox", { name: "工作台助手输入" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "将工作台助手展开到右侧" }));
    await waitForSurfaceMode("drawer", 8000);

    const drawerInputSurface = screen.getByTestId("workbench-assistant-drawer-input-surface");
    expect(within(drawerInputSurface).getByTestId("composer-approval-card")).not.toBeNull();
    expect(screen.queryByTestId("workbench-approval-prompt")).toBeNull();

    fireEvent.click(within(drawerInputSurface).getByRole("button", { name: "提交" }));

    await waitFor(() => {
      expect(submitApproval).toHaveBeenCalledWith({ decision: "approved", trust_scope: "once" });
    });
  });

  it("renders drawer messages with the shared compact ConversationPanel", async () => {
    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchAssistantSurface
          runtime={fakeRuntime()}
          workspaceId="ws-1"
          workspace={workspace()}
          controller={fakeController({
            agentMessages: [
              agentMessage({ id: "user-1", role: "user", content: "解释 README" }),
              agentMessage({ id: "assistant-1", role: "assistant", content: "我会先读取 README。" }),
              agentMessage({
                id: "tool-1",
                role: "tool",
                toolName: "workspace_search",
                toolResult: "README.md",
                status: "completed",
              }),
              agentMessage({
                id: "file-1",
                role: "tool",
                toolName: "apply_patch",
                fileChanges: [{ path: "README.md", operation: "modify" }],
                status: "completed",
              }),
            ],
          })}
        />
      </WorkbenchSurfaceTestProviders>,
    );

    fireEvent.click(screen.getByRole("button", { name: "将工作台助手展开到右侧" }));
    await waitForSurfaceMode("drawer");

    expect(screen.getByTestId("workbench-drawer-panel-loading")).not.toBeNull();
    expect(screen.queryByText("解释 README")).toBeNull();
    expect(screen.queryByTestId("conversation-panel")).toBeNull();
    expect(await screen.findByText("解释 README")).not.toBeNull();
    expect(screen.getByText("我会先读取 README。")).not.toBeNull();
    expect(screen.getByTestId("conversation-panel").getAttribute("data-conversation-panel-variant")).toBe("compact");
    expect(screen.getByTestId("message-list").getAttribute("data-message-list-variant")).toBe("compact");
    expect(screen.getByTestId("message-list").getAttribute("data-performance-profile")).toBe("default");
    expect(screen.queryByTestId("tool-call-block")).toBeNull();
    expect(screen.queryByTestId("file-change-block")).toBeNull();
    fireEvent.click(within(screen.getByTestId("message-group-block")).getByRole("button"));
    expect(screen.getAllByTestId("tool-call-block")).toHaveLength(2);
    expect(screen.queryByTestId("file-change-block")).toBeNull();
  });

  it("shows the turn navigator inside the drawer conversation panel", async () => {
    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchAssistantSurface
          runtime={fakeRuntime()}
          workspaceId="ws-1"
          workspace={workspace()}
          controller={fakeController({
            agentMessages: [
              agentMessage({ id: "user-1", role: "user", content: "第一轮问题" }),
              agentMessage({ id: "assistant-1", role: "assistant", content: "第一轮回答" }),
              agentMessage({ id: "user-2", role: "user", content: "第二轮问题" }),
              agentMessage({ id: "assistant-2", role: "assistant", content: "第二轮回答" }),
            ],
          })}
        />
      </WorkbenchSurfaceTestProviders>,
    );

    fireEvent.click(screen.getByRole("button", { name: "将工作台助手展开到右侧" }));
    await waitForSurfaceMode("drawer");

    expect(await screen.findByText("第一轮问题")).not.toBeNull();
    expect(screen.getByTestId("conversation-panel").getAttribute("data-conversation-panel-variant")).toBe("compact");
    expect(screen.getByTestId("message-list").getAttribute("data-message-list-variant")).toBe("compact");
    expect(screen.getByTestId("message-list").getAttribute("data-turn-navigator")).toBe("true");
    expect(screen.getByTestId("conversation-turn-navigator")).not.toBeNull();
    expect(screen.getByTestId("conversation-turn-navigator-count").textContent).toBe("2 turn");
  });

  it("keeps a 10,000-turn capsule navigator bounded and preserves first middle last targets", async () => {
    const onNavigateTurn = vi.fn();
    render(
      <WorkbenchMiniTurnNavigator
        disabled={false}
        onNavigateTurn={onNavigateTurn}
        turns={Array.from({ length: 10_000 }, (_, index) => ({
          id: `mini-bounded-turn-${index}`,
          targetIndex: index,
          userPreview: `问题 ${index}`,
          assistantPreview: [`回答 ${index}`],
        }))}
      />,
    );

    const navigator = screen.getByTestId("workbench-mini-turn-navigator");
    const viewport = screen.getByTestId("workbench-mini-turn-navigator-viewport");
    expect(navigator.getAttribute("data-turn-count")).toBe("10000");
    expect(Number(screen.getByTestId("workbench-mini-turn-navigator-rendered-count").textContent)).toBeLessThan(100);
    expect(within(navigator).getAllByRole("button").length).toBeLessThan(100);

    fireEvent.click(within(navigator).getByRole("button", { name: /跳转到第 1 轮/ }));
    expect(onNavigateTurn).toHaveBeenLastCalledWith(0);

    viewport.scrollTop = 5_000 * 12;
    fireEvent.scroll(viewport);
    const middle = await within(navigator).findByRole("button", { name: /跳转到第 5001 轮/ });
    fireEvent.focus(middle);
    expect(within(navigator).getByTestId("workbench-mini-turn-navigator-card").textContent).toContain("问题 5000");
    fireEvent.click(middle);
    expect(onNavigateTurn).toHaveBeenLastCalledWith(5_000);

    fireEvent.click(within(navigator).getByRole("button", { name: /跳转到第 10000 轮/ }));
    expect(onNavigateTurn).toHaveBeenLastCalledWith(9_999);
    expect(onNavigateTurn).toHaveBeenCalledTimes(3);
  });

  it("shows a separate live message carrier while the assistant is running", async () => {
    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchAssistantSurface
          runtime={fakeRuntime()}
          workspaceId="ws-1"
          workspace={workspace()}
          controller={fakeController({
            runtimeState: "running" as ConversationRuntimeState,
            agentMessages: [
              agentMessage({
                id: "assistant-streaming",
                role: "assistant",
                content: "正在整理工作台模式的交互细节，并补充运行态提示。",
                streaming: true,
              }),
            ],
          })}
        />
      </WorkbenchSurfaceTestProviders>,
    );

    const surface = screen.getByTestId("workbench-assistant-surface");
    const frame = screen.getByTestId("workbench-assistant-composer-frame");
    const trigger = screen.getByTestId("workbench-message-carrier");
    expect(surface.getAttribute("data-message-trigger-state")).toBe("streaming");
    expect(frame.getAttribute("data-message-trigger-state")).toBe("streaming");
    expect(trigger.getAttribute("data-state")).toBe("streaming");
    expect(trigger.getAttribute("data-layout-motion")).toBe("static");
    expect(screen.queryByTestId("workbench-message-trigger")).toBeNull();
    expect(trigger.querySelector('[data-typewriter="true"]')).not.toBeNull();
    expect(trigger.textContent).toContain("正");
    expect(trigger.textContent).not.toContain("Agent 正在回复");
    expect(screen.getByRole("button", { name: "展开工作台输入框" })).not.toBeNull();

    fireEvent.click(trigger);
    await waitFor(() => {
      expect(surface.getAttribute("data-surface-mode")).toBe("expanded");
    });
    expect(screen.getByTestId("workbench-expanded-layer")).not.toBeNull();
  });

  it("refreshes the live assistant carrier with the latest streamed tail", async () => {
    const initialStreamingContent = `开头不会保留 ${"中间内容 ".repeat(24)} 初始尾部片段`;
    const updatedStreamingContent = `旧内容不再显示 ${"新的中间内容 ".repeat(24)} 最新尾部片段`;
    vi.useFakeTimers();
    try {
      const { rerender } = render(
        <WorkbenchSurfaceTestProviders>
          <WorkbenchAssistantSurface
            runtime={fakeRuntime()}
            workspaceId="ws-1"
            workspace={workspace()}
            controller={fakeController({
              runtimeState: "running" as ConversationRuntimeState,
              agentMessages: [
                agentMessage({
                  id: "assistant-streaming-long",
                  role: "assistant",
                  content: initialStreamingContent,
                  streaming: true,
                }),
              ],
            })}
          />
        </WorkbenchSurfaceTestProviders>,
      );

      const trigger = screen.getByTestId("workbench-message-carrier");
      expect(trigger.querySelector('[data-typewriter="true"]')).not.toBeNull();
      expect(trigger.textContent).not.toContain("初始尾部片段");

      await act(async () => {
        vi.advanceTimersByTime(420);
      });

      expect(trigger.textContent).toContain("初始尾部片段");
      expect(trigger.textContent).not.toContain("开头不会保留");

      rerender(
        <WorkbenchSurfaceTestProviders>
          <WorkbenchAssistantSurface
            runtime={fakeRuntime()}
            workspaceId="ws-1"
            workspace={workspace()}
            controller={fakeController({
              runtimeState: "running" as ConversationRuntimeState,
              agentMessages: [
                agentMessage({
                  id: "assistant-streaming-long",
                  role: "assistant",
                  content: updatedStreamingContent,
                  streaming: true,
                }),
              ],
            })}
          />
        </WorkbenchSurfaceTestProviders>,
      );

      expect(trigger.textContent).toContain("初始尾部片段");
      expect(trigger.textContent).not.toContain("最新尾部片段");

      await act(async () => {
        vi.advanceTimersByTime(560);
      });

      expect(trigger.textContent).not.toContain("最新尾部片段");

      await act(async () => {
        vi.advanceTimersByTime(420);
      });

      expect(trigger.textContent).toContain("最新尾部片段");
      expect(trigger.textContent).not.toContain("旧内容不再显示");
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses a pending placeholder before the first assistant content arrives", async () => {
    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchAssistantSurface
          runtime={fakeRuntime()}
          workspaceId="ws-1"
          workspace={workspace()}
          controller={fakeController({
            runtimeState: "running" as ConversationRuntimeState,
            agentMessages: [
              agentMessage({
                id: "assistant-streaming-empty",
                role: "assistant",
                content: "",
                streaming: true,
              }),
            ],
          })}
        />
      </WorkbenchSurfaceTestProviders>,
    );

    const trigger = screen.getByTestId("workbench-message-carrier");
    expect(trigger.textContent).toContain("正在等待回复");
    await act(async () => {
      await Promise.resolve();
    });
  });

  it("shows the live message carrier during the priming step after send", async () => {
    const onSend = vi.fn(() => Promise.resolve(true));
    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchSendHarness onSend={onSend} />
      </WorkbenchSurfaceTestProviders>,
    );

    const surface = screen.getByTestId("workbench-assistant-surface");
    await screen.findByRole("textbox", { name: "工作台助手输入" });

    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledTimes(1);
      expect(surface.getAttribute("data-message-trigger-state")).toBe("priming");
    });
    const trigger = screen.getByTestId("workbench-message-carrier");
    expect(trigger.getAttribute("data-state")).toBe("priming");
    expect(trigger.getAttribute("data-layout-motion")).toBe("static");
    expect(screen.queryByTestId("workbench-message-trigger")).toBeNull();
    expect(trigger.textContent).toContain("正在等待回复");
  });

  it("shows only tool activity in the live message trigger without leaking tool params", async () => {
    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchAssistantSurface
          runtime={fakeRuntime()}
          workspaceId="ws-1"
          workspace={workspace()}
          controller={fakeController({
            runtimeState: "running" as ConversationRuntimeState,
            agentMessages: [
              agentMessage({
                id: "tool-running",
                role: "tool",
                content: "",
                toolName: "run_cmd",
                toolParams: { command: "npm run secret-build -- --token=abc" },
                status: "running",
              }),
            ],
          })}
        />
      </WorkbenchSurfaceTestProviders>,
    );

    const trigger = screen.getByTestId("workbench-message-carrier");
    expect(trigger.getAttribute("data-state")).toBe("streaming");
    expect(trigger.textContent).toContain("正在执行命令");
    expect(trigger.textContent).not.toContain("secret-build");
    expect(trigger.textContent).not.toContain("token");
    await act(async () => {
      await Promise.resolve();
    });
  });

  it("reuses the shared line change ticker for running file edit tools", async () => {
    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchAssistantSurface
          runtime={fakeRuntime()}
          workspaceId="ws-1"
          workspace={workspace()}
          controller={fakeController({
            runtimeState: "running" as ConversationRuntimeState,
            agentMessages: [
              agentMessage({
                id: "file-tool-running",
                role: "tool",
                content: "",
                toolName: "apply_patch",
                fileChanges: [{ path: "README.md", operation: "modify", added_lines: 12, deleted_lines: 4 }],
                status: "running",
              }),
            ],
          })}
        />
      </WorkbenchSurfaceTestProviders>,
    );

    const trigger = screen.getByTestId("workbench-message-carrier");
    expect(trigger.textContent).toContain("正在编辑文件");
    expect(within(trigger).getByTestId("line-change-ticker")).not.toBeNull();
    expect(within(trigger).getByText("+")).not.toBeNull();
    expect(within(trigger).getByText("-")).not.toBeNull();
    await act(async () => {
      await Promise.resolve();
    });
  });

  it("reuses the shared line change ticker for running move_file tools", async () => {
    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchAssistantSurface
          runtime={fakeRuntime()}
          workspaceId="ws-1"
          workspace={workspace()}
          controller={fakeController({
            runtimeState: "running" as ConversationRuntimeState,
            agentMessages: [
              agentMessage({
                id: "file-tool-running",
                role: "tool",
                content: "",
                toolName: "move_file",
                fileChanges: [
                  {
                    path: "docs/new.md",
                    old_path: "docs/old.md",
                    new_path: "docs/new.md",
                    operation: "move",
                  },
                ],
                status: "running",
              }),
            ],
          })}
        />
      </WorkbenchSurfaceTestProviders>,
    );

    const trigger = screen.getByTestId("workbench-message-carrier");
    expect(trigger.textContent).toContain("正在移动文件");
    expect(within(trigger).getByTestId("line-change-ticker")).not.toBeNull();
    await act(async () => {
      await Promise.resolve();
    });
  });

  it("collapses the bottom composer after a successful send", async () => {
    const onSend = vi.fn(() => Promise.resolve(true));
    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchSendHarness onSend={onSend} />
      </WorkbenchSurfaceTestProviders>,
    );

    const surface = screen.getByTestId("workbench-assistant-surface");
    expect(await screen.findByRole("textbox", { name: "工作台助手输入" })).not.toBeNull();
    await waitFor(() => {
      expect(surface.getAttribute("data-surface-mode")).toBe("composer");
    });

    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledTimes(1);
      expect(surface.getAttribute("data-surface-mode")).toBe("capsule");
    });
  });

  it("keeps the expanded message panel open after sending from it", async () => {
    const onSend = vi.fn(() => Promise.resolve(true));
    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchSendHarness onSend={onSend} />
      </WorkbenchSurfaceTestProviders>,
    );

    const surface = screen.getByTestId("workbench-assistant-surface");
    expect(await screen.findByRole("textbox", { name: "工作台助手输入" })).not.toBeNull();
    await waitFor(() => {
      expect(surface.getAttribute("data-surface-mode")).toBe("composer");
    });

    fireEvent.click(screen.getByRole("button", { name: "展开工作台消息层" }));
    await waitFor(() => {
      expect(surface.getAttribute("data-surface-mode")).toBe("expanded");
    });

    fireEvent.click(screen.getByRole("button", { name: "发送" }));

    await waitFor(() => {
      expect(onSend).toHaveBeenCalledTimes(1);
    });
    expect(surface.getAttribute("data-surface-mode")).toBe("expanded");
    expect(screen.getByTestId("workbench-expanded-layer")).not.toBeNull();
    expect(screen.queryByText("正在等待回复")).toBeNull();
  });

  it("keeps a completed unread message trigger until the user opens messages", async () => {
    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchRuntimeHarness />
      </WorkbenchSurfaceTestProviders>,
    );

    const surface = screen.getByTestId("workbench-assistant-surface");
    const streamingTrigger = screen.getByTestId("workbench-message-carrier");
    expect(streamingTrigger.getAttribute("data-state")).toBe("streaming");
    expect(streamingTrigger.getAttribute("data-layout-motion")).toBe("static");
    expect(screen.queryByTestId("workbench-message-trigger")).toBeNull();

    fireEvent.click(screen.getByTestId("complete-agent-reply"));

    await waitFor(() => {
      expect(surface.getAttribute("data-message-trigger-state")).toBe("completed");
    });
    const completedTrigger = screen.getByTestId("workbench-message-carrier");
    expect(completedTrigger.getAttribute("data-state")).toBe("completed");
    expect(completedTrigger.getAttribute("data-layout-motion")).toBe("static");
    expect(completedTrigger.textContent).toContain("回复已完成，点击查看");

    fireEvent.click(completedTrigger);
    await waitFor(() => {
      expect(surface.getAttribute("data-surface-mode")).toBe("expanded");
    });
    expect(screen.getByTestId("workbench-message-trigger").getAttribute("data-state")).toBe("idle");
    expect(screen.queryByText("回复已完成，点击查看")).toBeNull();
  });

  it("does not show a completed carrier after closing a panel that saw the reply finish", async () => {
    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchRuntimeHarness />
      </WorkbenchSurfaceTestProviders>,
    );

    const surface = screen.getByTestId("workbench-assistant-surface");
    fireEvent.click(screen.getByTestId("workbench-message-carrier"));
    await waitFor(() => {
      expect(surface.getAttribute("data-surface-mode")).toBe("expanded");
    });

    fireEvent.click(screen.getByTestId("complete-agent-reply"));
    await waitFor(() => {
      expect(screen.getByText("回答已经生成完成，可以展开消息查看完整内容。")).not.toBeNull();
    });

    fireEvent.click(screen.getByTestId("workbench-expanded-layer"));

    await waitFor(() => {
      expect(surface.getAttribute("data-surface-mode")).toBe("capsule");
    });
    expect(screen.queryByTestId("workbench-message-carrier")).toBeNull();
    expect(screen.queryByText("回复已完成，点击查看")).toBeNull();
  });

  it("marks a failed reply trigger with the failed state", async () => {
    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchAssistantSurface
          runtime={fakeRuntime()}
          workspaceId="ws-1"
          workspace={workspace()}
          controller={fakeController({ runtimeState: "failed" as ConversationRuntimeState })}
        />
      </WorkbenchSurfaceTestProviders>,
    );

    const surface = screen.getByTestId("workbench-assistant-surface");
    const trigger = screen.getByTestId("workbench-message-carrier");
    expect(surface.getAttribute("data-message-trigger-state")).toBe("failed");
    expect(trigger.getAttribute("data-state")).toBe("failed");
    expect(trigger.getAttribute("data-layout-motion")).toBe("static");
    expect(trigger.textContent).toContain("回复失败，点击查看");
    await act(async () => {
      await Promise.resolve();
    });
  });

  it("renders a quick new session button beside the status capsule", async () => {
    const requestNewSession = vi.fn();
    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchAssistantSurface
          runtime={fakeRuntime()}
          workspaceId="ws-1"
          workspace={workspace()}
          controller={fakeController()}
          onRequestNewSession={requestNewSession}
        />
      </WorkbenchSurfaceTestProviders>,
    );

    expect(screen.getByTestId("workbench-assistant-composer-frame").getAttribute("data-new-session-enabled")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "新会话" }));

    expect(requestNewSession).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "将工作台助手展开到右侧" }));
    await waitForSurfaceMode("drawer");
    expect(screen.queryByRole("button", { name: "展开工作台消息层" })).toBeNull();
    expect(screen.getByRole("button", { name: "新会话" })).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "新会话" }));

    expect(requestNewSession).toHaveBeenCalledTimes(2);
    await act(async () => {
      await Promise.resolve();
    });
  });

  it("keeps the drawer docked when requesting a new session changes the bound session", async () => {
    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchSessionSwitchHarness />
      </WorkbenchSurfaceTestProviders>,
    );

    const surface = screen.getByTestId("workbench-assistant-surface");
    fireEvent.click(screen.getByRole("button", { name: "将工作台助手展开到右侧" }));
    await waitForSurfaceMode("drawer");

    fireEvent.click(screen.getByRole("button", { name: "新会话" }));

    await waitFor(() => {
      expect(surface.getAttribute("data-surface-mode")).toBe("drawer");
      expect(surface.getAttribute("data-dock-transition")).toBe("idle");
    });
    expect(screen.getByRole("textbox", { name: "工作台助手输入" })).not.toBeNull();
  });

  it("keeps the expanded message panel open when switching sessions outside the assistant", async () => {
    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchSessionSwitchHarness />
      </WorkbenchSurfaceTestProviders>,
    );

    const surface = screen.getByTestId("workbench-assistant-surface");
    fireEvent.click(screen.getByRole("button", { name: "展开工作台消息层" }));

    await waitFor(() => {
      expect(surface.getAttribute("data-surface-mode")).toBe("expanded");
    });
    expect(screen.getByTestId("workbench-expanded-layer")).not.toBeNull();

    const sessionSwitcher = screen.getByTestId("switch-workbench-session");
    fireEvent.pointerDown(sessionSwitcher);
    fireEvent.click(sessionSwitcher);

    await waitFor(() => {
      expect(surface.getAttribute("data-surface-mode")).toBe("expanded");
    });
    expect(screen.getByTestId("workbench-expanded-layer")).not.toBeNull();
  });

  it("renders the expanded overlay as an overlay conversation panel without docking", async () => {
    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchAssistantSurface
          runtime={fakeRuntime()}
          workspaceId="ws-1"
          workspace={workspace()}
          controller={fakeController({
            agentMessages: [
              agentMessage({ id: "user-1", role: "user", content: "第一轮问题" }),
              agentMessage({ id: "assistant-1", role: "assistant", content: "覆盖层消息" }),
              agentMessage({ id: "user-2", role: "user", content: "第二轮问题" }),
              agentMessage({ id: "assistant-2", role: "assistant", content: "第二轮回答" }),
              agentMessage({
                id: "tool-1",
                role: "tool",
                toolName: "workspace_search",
                toolResult: "docs/guide.md",
                status: "completed",
              }),
              agentMessage({
                id: "file-1",
                role: "tool",
                toolName: "apply_patch",
                fileChanges: [{ path: "docs/guide.md", operation: "modify" }],
                status: "completed",
              }),
            ],
          })}
        />
      </WorkbenchSurfaceTestProviders>,
    );

    const surface = screen.getByTestId("workbench-assistant-surface");
    expect(screen.getByTestId("workbench-assistant-composer-frame").getAttribute("data-mini-navigator-visible")).toBe(
      "true",
    );
    const miniNavigator = screen.getByTestId("workbench-mini-turn-navigator");
    expect(miniNavigator.getAttribute("data-turn-count")).toBe("2");
    expect(within(miniNavigator).queryByTestId("conversation-turn-navigator")).toBeNull();
    expect(within(miniNavigator).getByTestId("workbench-mini-turn-navigator-viewport")).not.toBeNull();
    expect(miniNavigator.textContent).toContain("2 turn");
    const secondTurnMarker = within(miniNavigator).getByRole("button", { name: /跳转到第 2 轮/ });
    fireEvent.focus(secondTurnMarker);
    expect(within(miniNavigator).getByTestId("workbench-mini-turn-navigator-card")).not.toBeNull();
    fireEvent.click(secondTurnMarker);

    await waitFor(() => {
      expect(surface.getAttribute("data-surface-mode")).toBe("expanded");
    });
    expect(surface.getAttribute("data-dock-layout")).toBe("overlay");
    const chrome = screen.getByTestId("workbench-assistant-chrome");
    const expandedLayer = screen.getByTestId("workbench-expanded-layer");
    expect(chrome.getAttribute("data-shell-mode")).toBe("composer");
    expect(chrome.contains(expandedLayer)).toBe(false);
    expect(screen.getByTestId("workbench-expanded-panel-frame")).not.toBeNull();
    expect(screen.getByRole("button", { name: "收起工作台消息层" }).closest("form")).toBeNull();
    expect(screen.getByTestId("workbench-expanded-layer")).not.toBeNull();
    expect(screen.getByTestId("workbench-expanded-panel-loading")).not.toBeNull();
    expect(screen.queryByText("覆盖层消息")).toBeNull();
    expect(screen.queryByTestId("conversation-panel")).toBeNull();
    await screen.findByTestId("conversation-panel");
    expect(screen.getByTestId("conversation-panel").getAttribute("data-conversation-panel-variant")).toBe("overlay");
    expect(screen.getByTestId("message-list").getAttribute("data-message-list-variant")).toBe("overlay");
    expect(screen.getByTestId("message-list").getAttribute("data-performance-profile")).toBe("default");
    expect(screen.getByTestId("message-list").getAttribute("data-turn-navigator")).toBe("true");
    expect(screen.getByTestId("conversation-turn-navigator")).not.toBeNull();
    expect(screen.queryByTestId("workbench-mini-turn-navigator")).toBeNull();
    expect(screen.getByText("覆盖层消息")).not.toBeNull();
    expect(screen.queryByTestId("tool-call-block")).toBeNull();
    expect(screen.queryByTestId("file-change-block")).toBeNull();
    fireEvent.click(within(screen.getByTestId("message-group-block")).getByRole("button"));
    expect(screen.getAllByTestId("tool-call-block")).toHaveLength(2);
    expect(screen.queryByTestId("file-change-block")).toBeNull();
    expect(screen.getByTestId("workbench-assistant-capsule")).not.toBeNull();
    expect(screen.getByRole("button", { name: "收起工作台消息层" })).not.toBeNull();
    expect(screen.queryByTestId("workbench-assistant-drawer")).toBeNull();
  });

  it("centers the expanded overlay empty message in the panel", async () => {
    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchAssistantSurface
          runtime={fakeRuntime()}
          workspaceId="ws-1"
          workspace={workspace()}
          controller={fakeController()}
        />
      </WorkbenchSurfaceTestProviders>,
    );

    fireEvent.click(screen.getByRole("button", { name: "展开工作台消息层" }));
    await screen.findByTestId("conversation-panel");

    expect(screen.getByTestId("workbench-expanded-message-empty").textContent).toBe(
      "当前工作空间还没有助手消息。",
    );
    expect(screen.getByTestId("message-list-scroll").getAttribute("data-empty-layout")).toBe("center");
  });

  it("closes the expanded overlay from backdrop and Escape without collapsing a draft composer", async () => {
    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchDraftHarness initialDraft="保留展开层草稿" />
      </WorkbenchSurfaceTestProviders>,
    );

    const surface = screen.getByTestId("workbench-assistant-surface");
    const input = await screen.findByRole("textbox", { name: "工作台助手输入" });
    expect(input.textContent).toContain("保留展开层草稿");

    fireEvent.click(screen.getByRole("button", { name: "展开工作台消息层" }));
    await waitFor(() => {
      expect(surface.getAttribute("data-surface-mode")).toBe("expanded");
    });
    expect(screen.queryByRole("button", { name: "展开工作台消息层" })).toBeNull();
    expect(screen.getByRole("button", { name: "收起工作台消息层" })).not.toBeNull();

    fireEvent.click(screen.getByTestId("workbench-expanded-panel-frame"));
    expect(surface.getAttribute("data-surface-mode")).toBe("expanded");

    fireEvent.click(screen.getByTestId("workbench-expanded-layer"));
    await waitFor(() => {
      expect(surface.getAttribute("data-surface-mode")).toBe("composer");
    });
    expect(screen.getByRole("textbox", { name: "工作台助手输入" }).textContent).toContain("保留展开层草稿");

    fireEvent.click(screen.getByRole("button", { name: "展开工作台消息层" }));
    await waitFor(() => {
      expect(surface.getAttribute("data-surface-mode")).toBe("expanded");
    });
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => {
      expect(surface.getAttribute("data-surface-mode")).toBe("composer");
    });
    expect(screen.getByRole("textbox", { name: "工作台助手输入" }).textContent).toContain("保留展开层草稿");
  });

  it("closes the expanded overlay and empty composer from backdrop and Escape", async () => {
    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchDraftHarness />
      </WorkbenchSurfaceTestProviders>,
    );

    const surface = screen.getByTestId("workbench-assistant-surface");
    openWorkbenchComposerIfCollapsed();
    await screen.findByRole("textbox", { name: "工作台助手输入" });

    fireEvent.click(screen.getByRole("button", { name: "展开工作台消息层" }));
    await waitFor(() => {
      expect(surface.getAttribute("data-surface-mode")).toBe("expanded");
    });

    fireEvent.click(screen.getByTestId("workbench-expanded-layer"));
    await waitFor(() => {
      expect(surface.getAttribute("data-surface-mode")).toBe("capsule");
    });
    await waitFor(
      () => {
        expect(screen.queryByRole("textbox", { name: "工作台助手输入" })).toBeNull();
      },
      { timeout: 2000 },
    );

    openWorkbenchComposerIfCollapsed();
    await screen.findByRole("textbox", { name: "工作台助手输入" });
    fireEvent.click(screen.getByRole("button", { name: "展开工作台消息层" }));
    await waitFor(() => {
      expect(surface.getAttribute("data-surface-mode")).toBe("expanded");
    });

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => {
      expect(surface.getAttribute("data-surface-mode")).toBe("capsule");
    });
    await waitFor(
      () => {
        expect(screen.queryByRole("textbox", { name: "工作台助手输入" })).toBeNull();
      },
      { timeout: 2000 },
    );
  });

  it("opens the composer when an external quote chip is injected", async () => {
    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchQuoteInjectionHarness />
      </WorkbenchSurfaceTestProviders>,
    );

    const surface = screen.getByTestId("workbench-assistant-surface");
    expect(surface.getAttribute("data-surface-mode")).toBe("capsule");
    expect(screen.queryByLabelText("工作台助手输入")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "注入引用片段" }));

    await waitFor(() => {
      expect(surface.getAttribute("data-surface-mode")).toBe("composer");
    });
    expect(await screen.findByLabelText("工作台助手输入")).not.toBeNull();
    expect(await screen.findByText("guide.md · L3")).not.toBeNull();
  });

  it("does not replay a deleted external quote chip after collapsing and reopening the composer", async () => {
    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchQuoteInjectionHarness />
      </WorkbenchSurfaceTestProviders>,
    );

    const surface = screen.getByTestId("workbench-assistant-surface");
    fireEvent.click(screen.getByRole("button", { name: "注入引用片段" }));

    const input = await screen.findByLabelText("工作台助手输入");
    expect(await screen.findByText("guide.md · L3")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /删除guide\.md · L3/ }));
    expect(screen.queryByText("guide.md · L3")).toBeNull();

    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => {
      expect(surface.getAttribute("data-surface-mode")).toBe("capsule");
    });

    fireEvent.click(await screen.findByRole("button", { name: "展开工作台输入框" }));
    expect(await screen.findByLabelText("工作台助手输入")).not.toBeNull();
    expect(screen.queryByText("guide.md · L3")).toBeNull();
  });

  it("resets temporary shell state on session switch without replaying old context requests", async () => {
    const quote = selectedQuoteFromText("旧会话引用", {
      source: "selection",
      file: {
        path: "docs/old.md",
        name: "old.md",
        lineStart: 2,
        lineEnd: 2,
      },
    });
    if (!quote) {
      throw new Error("quote not created");
    }
    const quoteChipRequest = { requestId: 5, quote };
    const view = render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchAssistantSurface
          runtime={fakeRuntime()}
          workspaceId="ws-1"
          workspace={workspace()}
          controller={fakeController({ session: session("ses-1"), quoteChipRequest })}
        />
      </WorkbenchSurfaceTestProviders>,
    );

    const surface = screen.getByTestId("workbench-assistant-surface");
    fireEvent.click(screen.getByRole("button", { name: "将工作台助手展开到右侧" }));
    await waitForSurfaceMode("drawer");

    view.rerender(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchAssistantSurface
          runtime={fakeRuntime()}
          workspaceId="ws-1"
          workspace={workspace()}
          controller={fakeController({ session: session("ses-2"), quoteChipRequest })}
        />
      </WorkbenchSurfaceTestProviders>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("workbench-assistant-surface").getAttribute("data-surface-mode")).toBe("drawer");
    });
    expect(screen.getByTestId("workbench-assistant-surface").getAttribute("data-dock-transition")).toBe("idle");
    expect(screen.getByLabelText("工作台助手输入")).not.toBeNull();
    expect(screen.queryByText("old.md · L2")).toBeNull();
  });

  it("renders the collapsed capsule as chrome content instead of a separate shell", async () => {
    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchAssistantSurface
          runtime={fakeRuntime()}
          workspaceId="ws-1"
          workspace={workspace()}
          controller={fakeController()}
        />
      </WorkbenchSurfaceTestProviders>,
    );
    await act(async () => {
      await Promise.resolve();
    });

    const chrome = screen.getByTestId("workbench-assistant-chrome");
    const capsule = screen.getByTestId("workbench-assistant-capsule");
    const composerFrame = screen.getByTestId("workbench-assistant-composer-frame");
    expect(chrome.contains(capsule)).toBe(true);
    expect(chrome.getAttribute("data-shell-mode")).toBe("capsule");
    expect(capsule.getAttribute("data-compose-open")).toBe("false");
    expect(composerFrame.getAttribute("data-mini-navigator-visible")).toBe("false");
    expect(screen.queryByTestId("workbench-mini-turn-navigator")).toBeNull();
    expect(screen.getByTestId("workbench-assistant-session-title").textContent).toBe("Workbench");
    expect(screen.getByRole("button", { name: "展开工作台输入框" }).textContent).toContain("要求后续变更");
    expect(screen.getByRole("button", { name: "将工作台助手展开到右侧" })).not.toBeNull();
    expect(screen.queryByLabelText("工作台助手输入")).toBeNull();
  });

  it("falls back to the placeholder when no workbench session is bound", async () => {
    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchAssistantSurface
          runtime={fakeRuntime()}
          workspaceId="ws-1"
          workspace={workspace()}
          controller={fakeController({ session: null })}
        />
      </WorkbenchSurfaceTestProviders>,
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText("要求后续变更")).not.toBeNull();
    expect(screen.getByTestId("workbench-assistant-surface").getAttribute("data-session-title-visible")).toBe("false");
    expect(screen.getByTestId("workbench-assistant-composer-frame").getAttribute("data-session-title-visible")).toBe(
      "false",
    );
    expect(screen.getByTestId("workbench-assistant-session-title").getAttribute("data-empty")).toBe("true");
    expect(screen.getByRole("button", { name: "展开工作台输入框" }).getAttribute("title")).toBe("要求后续变更");
  });

  it("collapses an empty composer on outside click but keeps a draft open", async () => {
    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchDraftHarness />
      </WorkbenchSurfaceTestProviders>,
    );

    const surface = screen.getByTestId("workbench-assistant-surface");
    openWorkbenchComposerIfCollapsed();
    const emptyInput = await screen.findByLabelText("工作台助手输入");
    fireEvent.pointerDown(screen.getByTestId("outside-workspace"));

    await waitFor(() => {
      expect(surface.getAttribute("data-surface-mode")).toBe("capsule");
    });
    expect(emptyInput.isConnected).toBe(true);
    await waitFor(
      () => {
        expect(emptyInput.isConnected).toBe(false);
      },
      { timeout: 2000 },
    );

    fireEvent.click(screen.getByRole("button", { name: "展开工作台输入框" }));
    const draftInput = await screen.findByLabelText("工作台助手输入");
    draftInput.textContent = "保留这个工作台草稿";
    fireEvent.input(draftInput);
    fireEvent.pointerDown(screen.getByTestId("outside-workspace"));

    expect(surface.getAttribute("data-surface-mode")).toBe("composer");
    expect(screen.getByLabelText("工作台助手输入").textContent).toContain("保留这个工作台草稿");
  });

  it("collapses a focused draft composer on Escape and restores cached text when reopened", async () => {
    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchDraftHarness initialDraft="Esc 收起后保留" />
      </WorkbenchSurfaceTestProviders>,
    );

    const surface = screen.getByTestId("workbench-assistant-surface");
    const input = await screen.findByRole("textbox", { name: "工作台助手输入" });
    await waitFor(() => {
      expect(document.activeElement).toBe(input);
    });
    expect(input.textContent).toContain("Esc 收起后保留");
    expect(screen.getByRole("button", { name: "展开工作台消息层" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "展开工作台消息层" }).closest("form")).toBeNull();
    expect(screen.getByRole("button", { name: "将工作台助手展开到右侧" })).not.toBeNull();

    fireEvent.keyDown(input, { key: "Escape" });

    await waitFor(() => {
      expect(surface.getAttribute("data-surface-mode")).toBe("capsule");
      expect(surface.getAttribute("data-dock-out-target")).toBe("capsule");
      expect(surface.getAttribute("data-geometry-mode")).toBe("capsule");
    });
    const reopenButton = await screen.findByRole("button", { name: "展开工作台输入框" }, { timeout: 2000 });
    expect(reopenButton.textContent).toContain("Esc 收起后保留");
    fireEvent.click(reopenButton);
    expect((await screen.findByRole("textbox", { name: "工作台助手输入" })).textContent).toContain("Esc 收起后保留");

    fireEvent.click(screen.getByRole("button", { name: "将工作台助手展开到右侧" }));
    await waitForSurfaceMode("drawer");
    expect(await screen.findByRole("button", { name: "关闭工作台助手侧栏" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "收回工作台助手为胶囊" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "展开工作台消息层" })).toBeNull();
  });

  it("collapses a focused empty composer on Escape", async () => {
    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchDraftHarness />
      </WorkbenchSurfaceTestProviders>,
    );

    const surface = screen.getByTestId("workbench-assistant-surface");
    openWorkbenchComposerIfCollapsed();
    const input = await screen.findByRole("textbox", { name: "工作台助手输入" });

    fireEvent.keyDown(input, { key: "Escape" });

    await waitFor(() => {
      expect(surface.getAttribute("data-surface-mode")).toBe("capsule");
    });
  });

  it("keeps a focused drawer composer docked on Escape and keeps cached draft text", async () => {
    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchDraftHarness initialDraft="侧栏 Esc 后保留" />
      </WorkbenchSurfaceTestProviders>,
    );

    const surface = screen.getByTestId("workbench-assistant-surface");
    await screen.findByRole("textbox", { name: "工作台助手输入" });
    fireEvent.click(screen.getByRole("button", { name: "将工作台助手展开到右侧" }));
    await waitForSurfaceMode("drawer");
    const drawerInput = screen.getByRole("textbox", { name: "工作台助手输入" });

    fireEvent.keyDown(drawerInput, { key: "Escape" });

    await waitFor(() => {
      expect(surface.getAttribute("data-surface-mode")).toBe("drawer");
    });
    expect(screen.getByRole("textbox", { name: "工作台助手输入" }).textContent).toContain("侧栏 Esc 后保留");
    expect(screen.getByRole("button", { name: "收回工作台助手为胶囊" })).not.toBeNull();
  });

  it("keeps draft text and input focus across composer, drawer and undock modes", async () => {
    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchDraftHarness initialDraft="跨形态保留的草稿" />
      </WorkbenchSurfaceTestProviders>,
    );

    const surface = screen.getByTestId("workbench-assistant-surface");
    const composerInput = await screen.findByLabelText("工作台助手输入");
    await waitFor(() => {
      expect(surface.getAttribute("data-surface-mode")).toBe("composer");
      expect(document.activeElement).toBe(composerInput);
    });
    expect(composerInput.textContent).toContain("跨形态保留的草稿");

    fireEvent.click(screen.getByRole("button", { name: "将工作台助手展开到右侧" }));
    await waitForSurfaceMode("drawer");
    const drawerInput = screen.getByLabelText("工作台助手输入");
    expect(drawerInput.textContent).toContain("跨形态保留的草稿");
    await waitFor(() => {
      expect(document.activeElement).toBe(drawerInput);
    });

    fireEvent.click(screen.getByRole("button", { name: "关闭工作台助手侧栏" }));
    expect(surface.getAttribute("data-surface-mode")).toBe("drawer");
    expect(surface.getAttribute("data-visual-mode")).toBe("dock-out-morph");
    expect(surface.getAttribute("data-geometry-mode")).toBe("composer");
    await waitForSurfaceMode("composer");
    const undockedInput = screen.getByLabelText("工作台助手输入");
    expect(undockedInput.textContent).toContain("跨形态保留的草稿");
    await waitFor(() => {
      expect(document.activeElement).toBe(undockedInput);
    });
  });

  it("keeps file, quote, skill and model context across composer, drawer and undock modes", async () => {
    const quote = selectedQuoteFromText("引用文件里的片段", {
      source: "selection",
      file: {
        path: "docs/guide.md",
        name: "guide.md",
        lineStart: 7,
        lineEnd: 7,
      },
    });
    if (!quote) {
      throw new Error("quote not created");
    }
    const skill = workspaceSkill();
    const runtime = fakeRuntime({ skills: [skill] });

    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchAssistantSurface
          runtime={runtime}
          workspaceId="ws-1"
          workspace={workspace()}
          controller={fakeController({
            selectedSkill: skill,
            fileChipRequest: {
              requestId: 1,
              file: {
                path: "src/main.ts",
                name: "main.ts",
                type: "file",
                source: "workspace",
              },
            },
            quoteChipRequest: { requestId: 1, quote },
          })}
        />
      </WorkbenchSurfaceTestProviders>,
    );

    const surface = screen.getByTestId("workbench-assistant-surface");
    openWorkbenchComposerIfCollapsed();
    await waitFor(() => {
      expect(screen.getByLabelText("已添加上下文").textContent).toContain("main.ts");
      expect(screen.getByLabelText("已添加上下文").textContent).toContain("guide.md · L7");
      expect(screen.getByLabelText("已添加上下文").textContent).toContain("dev-plan");
      expect(screen.getByRole("button", { name: "选择模型" }).textContent).toContain("qwen-coder");
    });

    fireEvent.click(screen.getByRole("button", { name: "将工作台助手展开到右侧" }));
    await waitForSurfaceMode("drawer");
    expect(screen.getByLabelText("已添加上下文").textContent).toContain("main.ts");
    expect(screen.getByLabelText("已添加上下文").textContent).toContain("guide.md · L7");
    expect(screen.getByLabelText("已添加上下文").textContent).toContain("dev-plan");
    expect(screen.getByRole("button", { name: "选择模型" }).textContent).toContain("qwen-coder");

    fireEvent.click(screen.getByRole("button", { name: "关闭工作台助手侧栏" }));
    expect(surface.getAttribute("data-surface-mode")).toBe("drawer");
    expect(surface.getAttribute("data-visual-mode")).toBe("dock-out-morph");
    expect(surface.getAttribute("data-geometry-mode")).toBe("composer");
    await waitForSurfaceMode("composer");
    await waitFor(() => {
      expect(screen.getByLabelText("已添加上下文").textContent).toContain("main.ts");
      expect(screen.getByLabelText("已添加上下文").textContent).toContain("guide.md · L7");
      expect(screen.getByLabelText("已添加上下文").textContent).toContain("dev-plan");
      expect(screen.getByRole("button", { name: "选择模型" }).textContent).toContain("qwen-coder");
    });
  });

  it("opens workbench composer context chips through the shared preview panel", async () => {
    const quote = selectedQuoteFromText("引用文件里的片段", {
      source: "selection",
      file: {
        path: "docs/guide.md",
        name: "guide.md",
        lineStart: 7,
        lineEnd: 8,
      },
    });
    if (!quote) {
      throw new Error("quote not created");
    }
    const skill = workspaceSkill();
    const runtime = fakeRuntime({ skills: [skill] });

    render(
      <WorkbenchSurfaceTestProviders>
        <PreviewFilePanelProbe />
        <WorkbenchAssistantSurface
          runtime={runtime}
          workspaceId="ws-1"
          workspace={workspace()}
          controller={fakeController({
            selectedSkill: skill,
            fileChipRequest: {
              requestId: 1,
              file: {
                path: "src/main.ts",
                name: "main.ts",
                type: "file",
                source: "workspace",
              },
            },
            quoteChipRequest: { requestId: 1, quote },
          })}
        />
      </WorkbenchSurfaceTestProviders>,
    );

    openWorkbenchComposerIfCollapsed();

    const fileChip = (await screen.findByRole("button", {
      name: "打开文件引用 src/main.ts",
    })) as HTMLButtonElement;
    const quoteChip = screen.getByRole("button", { name: "打开引用来源 docs/guide.md" }) as HTMLButtonElement;
    const skillChip = screen.getByRole("button", { name: "打开 Skill dev-plan" }) as HTMLButtonElement;

    expect(fileChip.disabled).toBe(false);
    expect(quoteChip.disabled).toBe(false);
    expect(skillChip.disabled).toBe(false);

    fireEvent.click(fileChip);
    await waitFor(() => {
      expect(screen.getByTestId("preview-file-panel-path").textContent).toBe("src/main.ts");
    });

    fireEvent.click(quoteChip);
    await waitFor(() => {
      expect(screen.getByTestId("preview-file-panel-path").textContent).toBe("docs/guide.md");
      expect(screen.getByTestId("preview-file-panel-reveal").textContent).toContain('"lineStart":7');
      expect(screen.getByTestId("preview-file-panel-reveal").textContent).toContain('"lineEnd":8');
    });

    fireEvent.click(skillChip);
    await waitFor(() => {
      expect(screen.getByTestId("preview-file-panel-path").textContent).toBe(".keydex/skills/dev-plan/SKILL.md");
    });
  });

  it("keeps a selected skill chip while workspace skills are still loading", async () => {
    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchSkillLoadingHarness />
      </WorkbenchSurfaceTestProviders>,
    );

    openWorkbenchComposerIfCollapsed();

    await waitFor(() => {
      expect(screen.getByLabelText("已添加上下文").textContent).toContain("dev-plan");
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByLabelText("已添加上下文").textContent).toContain("dev-plan");
  });

  it("skips dock transition waits when reduced motion is preferred", async () => {
    const restoreMotionPreference = mockReducedMotionPreference(true);
    const onDockTransitionChange = vi.fn();
    try {
      render(
        <WorkbenchSurfaceTestProviders>
          <WorkbenchAssistantSurface
            runtime={fakeRuntime()}
            workspaceId="ws-1"
            workspace={workspace()}
            controller={fakeController()}
            onDockTransitionChange={onDockTransitionChange}
          />
        </WorkbenchSurfaceTestProviders>,
      );

      const surface = screen.getByTestId("workbench-assistant-surface");
      fireEvent.click(screen.getByRole("button", { name: "将工作台助手展开到右侧" }));

      await waitFor(() => {
        expect(surface.getAttribute("data-surface-mode")).toBe("drawer");
      });
      expect(surface.getAttribute("data-dock-layout")).toBe("inline");
      expect(surface.getAttribute("data-dock-transition")).toBe("idle");
      expect(screen.getByTestId("workbench-assistant-shell").getAttribute("data-transition-phase")).toBe("idle");
      expect(onDockTransitionChange).not.toHaveBeenCalledWith(true);

      fireEvent.click(screen.getByRole("button", { name: "关闭工作台助手侧栏" }));

      await waitFor(() => {
        expect(surface.getAttribute("data-surface-mode")).toBe("capsule");
      });
      expect(surface.getAttribute("data-dock-layout")).toBe("overlay");
      expect(surface.getAttribute("data-dock-transition")).toBe("idle");
      expect(screen.getByTestId("workbench-assistant-shell").getAttribute("data-transition-phase")).toBe("idle");
      expect(onDockTransitionChange).not.toHaveBeenCalledWith(true);
    } finally {
      restoreMotionPreference();
    }
  });

  it("renders shared plan accessory data from Agent messages", async () => {
    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchAssistantSurface
          runtime={fakeRuntime()}
          workspaceId="ws-1"
          workspace={workspace()}
          controller={fakeController({
            agentMessages: [
              agentMessage({
                id: "plan-1",
                role: "tool",
                toolName: "update_plan",
                uiPayload: {
                  entries: [{ content: "复用主对话面板", status: "completed" }],
                },
                status: "completed",
              }),
            ],
          })}
        />
      </WorkbenchSurfaceTestProviders>,
    );

    expect(await screen.findByTestId("plan-summary-pill")).not.toBeNull();
    expect(screen.getByText(/第 1 \/ 1 步 · 复用主对话面板/)).not.toBeNull();
  });

  it("renders shared file-change accessory data from Agent messages", async () => {
    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchAssistantSurface
          runtime={fakeRuntime()}
          workspaceId="ws-1"
          workspace={workspace()}
          controller={fakeController({
            agentMessages: [
              agentMessage({
                id: "file-1",
                role: "tool",
                toolName: "apply_patch",
                fileChanges: [{ path: "README.md", operation: "modify" }],
                status: "completed",
              }),
            ],
          })}
        />
      </WorkbenchSurfaceTestProviders>,
    );

    expect(await screen.findByTestId("file-change-summary-pill")).not.toBeNull();
    expect(screen.getByText(/编辑了 1 个文件/)).not.toBeNull();
  });

  it("opens file review as a drawer secondary page without the composer", async () => {
    render(
      <WorkbenchSurfaceTestProviders>
        <WorkbenchReviewProbe />
        <WorkbenchAssistantSurface
          runtime={fakeRuntime()}
          workspaceId="ws-1"
          workspace={workspace()}
          controller={fakeController()}
        />
      </WorkbenchSurfaceTestProviders>,
    );

    fireEvent.click(screen.getByRole("button", { name: "打开工作台审阅" }));

    await waitForSurfaceMode("drawer", 8000);
    expect(await screen.findByTestId("workbench-review-panel")).not.toBeNull();
    expect(screen.getByTestId("workbench-review-panel").textContent).toContain("src/main.ts");
    expect(screen.getByLabelText("文件 diff").textContent).toContain("+const value = 2;");
    expect(screen.getByLabelText("文件 diff").getAttribute("data-wrap")).toBe("true");
    expect(screen.getByRole("button", { name: "返回主对话" })).not.toBeNull();
    expect(screen.queryByTestId("workbench-assistant-drawer-input-surface")).toBeNull();
    expect(screen.queryByRole("textbox", { name: "工作台助手输入" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "返回主对话" }));

    await waitFor(() => {
      expect(screen.queryByTestId("workbench-review-panel")).toBeNull();
    });
    expect(screen.getByTestId("workbench-assistant-drawer-input-surface")).not.toBeNull();
  });
});

async function waitForSurfaceMode(mode: string, timeout = 2000) {
  await waitFor(
    () => {
      expect(screen.getByTestId("workbench-assistant-surface").getAttribute("data-surface-mode")).toBe(mode);
    },
    { timeout },
  );
}

function openWorkbenchComposerIfCollapsed() {
  const openButton = screen.queryByRole("button", { name: "展开工作台输入框" });
  if (openButton) {
    fireEvent.click(openButton);
  }
}

function typeWorkbenchComposer(value: string) {
  const input = screen.getByRole("textbox", { name: "工作台助手输入" });
  input.textContent = value;
  fireEvent.input(input);
  return input;
}

async function waitForDockTransitionIdle() {
  await waitFor(
    () => {
      expect(screen.getByTestId("workbench-assistant-surface").getAttribute("data-dock-transition")).toBe("idle");
    },
    { timeout: 2000 },
  );
}

function WorkbenchSurfaceTestProviders({ children }: PropsWithChildren) {
  return (
    <NotificationProvider>
      <PreviewProvider>
        <LayoutStateProvider>{children}</LayoutStateProvider>
      </PreviewProvider>
    </NotificationProvider>
  );
}

function PreviewFilePanelProbe() {
  const preview = usePreview();
  return (
    <div aria-hidden="true">
      <output data-testid="preview-file-panel-path">{preview.filePanelRequest?.path ?? ""}</output>
      <output data-testid="preview-file-panel-reveal">
        {JSON.stringify(preview.filePanelRequest?.revealTarget ?? null)}
      </output>
    </div>
  );
}

function WorkbenchReviewProbe() {
  const preview = usePreview();
  return (
    <button
      type="button"
      onClick={() =>
        preview.openReviewPanel(
          {
            files: [
              {
                path: "src/main.ts",
                additions: 1,
                deletions: 1,
                diff: "--- a/src/main.ts\n+++ b/src/main.ts\n@@\n-const value = 1;\n+const value = 2;",
                operation: "update",
                source: "streaming",
              },
            ],
            focusedPath: "src/main.ts",
            title: "审阅",
          },
          { sessionId: "ses-1", workspaceId: "ws-1", workspaceAvailable: true },
        )
      }
    >
      打开工作台审阅
    </button>
  );
}

function WorkbenchQuoteInjectionHarness() {
  const [quoteChipRequest, setQuoteChipRequest] = useState<AgentSessionController["quoteChipRequest"]>(null);
  const runtime = useMemo(() => fakeRuntime(), []);
  const controller = fakeController({ quoteChipRequest });
  const quote = selectedQuoteFromText("Target text", {
    source: "selection",
    file: {
      path: "docs/guide.md",
      name: "guide.md",
      lineStart: 3,
      lineEnd: 3,
    },
  });

  return (
    <>
      <button
        type="button"
        onClick={() => {
          if (!quote) {
            return;
          }
          setQuoteChipRequest((current) => ({
            requestId: (current?.requestId ?? 0) + 1,
            quote,
          }));
        }}
      >
        注入引用片段
      </button>
      <WorkbenchAssistantSurface
        runtime={runtime}
        workspaceId="ws-1"
        workspace={workspace()}
        controller={controller}
      />
    </>
  );
}

function WorkbenchSessionSwitchHarness() {
  const [sessionId, setSessionId] = useState("ses-1");
  const runtime = useMemo(() => fakeRuntime(), []);
  const controller = fakeController({ session: session(sessionId) });

  return (
    <>
      <button type="button" data-testid="switch-workbench-session" onClick={() => setSessionId("ses-2")}>
        切换会话
      </button>
      <WorkbenchAssistantSurface
        runtime={runtime}
        workspaceId="ws-1"
        workspace={workspace()}
        controller={controller}
        onRequestNewSession={() => setSessionId("ses-2")}
      />
    </>
  );
}

function WorkbenchDraftHarness({ initialDraft = "" }: { initialDraft?: string }) {
  const [draft, setDraft] = useState(initialDraft);
  const runtime = useMemo(() => fakeRuntime(), []);
  const controller = fakeController({ draft, setDraft });

  return (
    <>
      <button type="button" data-testid="outside-workspace">
        workspace
      </button>
      <WorkbenchAssistantSurface
        runtime={runtime}
        workspaceId="ws-1"
        workspace={workspace()}
        controller={controller}
      />
    </>
  );
}

function WorkbenchSkillLoadingHarness() {
  const [selectedSkill, setSelectedSkill] = useState<WorkspaceSkillSummary | null>(workspaceSkill());
  const runtime = useMemo(() => {
    const base = fakeRuntime();
    return {
      ...base,
      workspace: {
        ...base.workspace,
        listSkills: vi.fn(() => new Promise(() => undefined)) as RuntimeBridge["workspace"]["listSkills"],
      },
    } as RuntimeBridge;
  }, []);
  const controller = fakeController({
    canSend: false,
    selectedSkill,
    setSelectedSkill,
  });

  return (
    <WorkbenchAssistantSurface
      runtime={runtime}
      workspaceId="ws-1"
      workspace={workspace()}
      controller={controller}
    />
  );
}

function WorkbenchSendHarness({ onSend }: { onSend: AgentSessionController["send"] }) {
  const [draft, setDraft] = useState("发送后自动收起");
  const runtime = useMemo(() => fakeRuntime(), []);
  const controller = fakeController({
    draft,
    setDraft,
    send: async (files, quotes, model) => {
      setDraft("");
      return onSend(files, quotes, model);
    },
  });

  return (
    <WorkbenchAssistantSurface
      runtime={runtime}
      workspaceId="ws-1"
      workspace={workspace()}
      controller={controller}
    />
  );
}

function WorkbenchRuntimeHarness() {
  const [runtimeState, setRuntimeState] = useState<ConversationRuntimeState>("running");
  const [agentMessages, setAgentMessages] = useState<AgentChatMessage[]>([
    agentMessage({
      id: "assistant-live",
      role: "assistant",
      content: "正在生成回答。",
      streaming: true,
    }),
  ]);
  const runtime = useMemo(() => fakeRuntime(), []);
  const controller = fakeController({ agentMessages, runtimeState });

  return (
    <>
      <button
        type="button"
        data-testid="complete-agent-reply"
        onClick={() => {
          setAgentMessages([
            agentMessage({
              id: "assistant-live",
              role: "assistant",
              content: "回答已经生成完成，可以展开消息查看完整内容。",
              status: "completed",
            }),
          ]);
          setRuntimeState("idle");
        }}
      >
        complete
      </button>
      <WorkbenchAssistantSurface
        runtime={runtime}
        workspaceId="ws-1"
        workspace={workspace()}
        controller={controller}
      />
    </>
  );
}

function WorkbenchGoalHarness({
  activeTask = null,
  onEnsureSession,
  runtime,
  sendText = vi.fn().mockResolvedValue(true),
  sessionValue = session(),
}: {
  activeTask?: ThreadTask | null;
  onEnsureSession?: ComponentProps<typeof WorkbenchAssistantSurface>["onEnsureSession"];
  runtime: RuntimeBridge;
  sendText?: ReturnType<typeof vi.fn>;
  sessionValue?: AgentSession | null;
}) {
  const [draft, setDraft] = useState("");
  const [selectedSkill, setSelectedSkill] = useState<WorkspaceSkillSummary | null>(null);
  const controller = fakeController({
    activeTask,
    draft,
    selectedSkill,
    session: sessionValue,
    sendText,
    setDraft,
    setSelectedSkill,
    threadTasks: activeTask ? [activeTask] : [],
  });

  return (
    <WorkbenchAssistantSurface
      runtime={runtime}
      workspaceId="ws-1"
      workspace={workspace()}
      controller={controller}
      onEnsureSession={onEnsureSession}
    />
  );
}

function fakeController(overrides: Partial<AgentSessionController> = {}): AgentSessionController {
  return {
    state: {},
    dispatch: vi.fn(),
    session: session(),
    sessionViewState: null,
    threadTasks: [],
    activeTask: null,
    taskRunState: {},
    agentMessages: [],
    runtimeState: "idle" as ConversationRuntimeState,
    pendingApproval: null,
    draft: "",
    setDraft: vi.fn(),
    selectedSkill: null,
    setSelectedSkill: vi.fn(),
    fileChipRequest: null,
    quoteChipRequest: null,
    loading: false,
    loadingOlderHistory: false,
    wsStatus: "open",
    runtimeDetail: null,
    setRuntimeDetail: vi.fn(),
    connectionReady: true,
    canSend: true,
    canStop: false,
    usingSharedRuntime: false,
    quoteSelection: vi.fn(),
    startChatFromAnnotation: vi.fn(),
    loadOlderHistory: vi.fn(),
    sendText: vi.fn(),
    send: vi.fn(),
    stop: vi.fn(),
    submitApproval: vi.fn(),
    approvalSubmitting: false,
    approvalError: null,
    ...overrides,
  } as unknown as AgentSessionController;
}

function agentMessage(overrides: Partial<AgentChatMessage> = {}): AgentChatMessage {
  return {
    id: "message-1",
    sessionId: "ses-1",
    role: "assistant",
    content: "",
    timestamp: Date.now(),
    ...overrides,
  } as AgentChatMessage;
}

function approvalRequest(): CommandApprovalRequest {
  return {
    id: "approval-1",
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
    },
    status: "pending",
    created_at: "2026-06-25T12:00:01Z",
    resolved_at: null,
  };
}

function fakeRuntime({
  createThreadTask = vi.fn().mockResolvedValue(threadTask()),
  deleteThreadTask = vi.fn().mockResolvedValue(threadTask({ deleted_at: "2026-07-03T00:00:00Z", is_open: false })),
  listThreadTasks = vi.fn().mockResolvedValue([]),
  skills = [],
}: {
  createThreadTask?: ReturnType<typeof vi.fn>;
  deleteThreadTask?: ReturnType<typeof vi.fn>;
  listThreadTasks?: ReturnType<typeof vi.fn>;
  skills?: WorkspaceSkillSummary[];
} = {}): RuntimeBridge {
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
      getModelDefaults: () =>
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
        }),
      getExtensionSettings: () =>
        Promise.resolve({
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
        }),
    },
    models: {
      listProviders: () =>
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
        ]),
    },
    workspace: {
      listSkills: () =>
        Promise.resolve({
          workspace_root: "D:/repo/keydex",
          skills,
          diagnostics: [],
          fingerprint: "empty",
          loaded_at: "2026-06-26T00:00:00Z",
        }),
      search: vi.fn().mockResolvedValue([]),
      listDirectory: vi.fn().mockResolvedValue({ root: "", entries: [] }),
    },
    conversation: {
      createThreadTask,
      deleteThreadTask,
      listThreadTasks,
    },
    mcp: {
      getRuntimeStatus: vi.fn().mockResolvedValue(mcpRuntimeStatus()),
    },
  } as unknown as RuntimeBridge;
}

function mcpRuntimeStatus() {
  return {
    session_id: "ses-1",
    manager: {
      enabled: true,
      runtime_status: "started",
      started: true,
      active_client_count: 1,
    },
    snapshot: {
      id: "snap_1",
      snapshot_id: "snap_1",
      session_id: "ses-1",
      servers_total: 1,
      servers_online: 1,
      tools_visible: 2,
      tools_disabled_for_session: 0,
      pending_approvals: 0,
      created_at: "2026-07-06T09:00:00Z",
    },
    servers: [],
    tools: [],
    overrides: [],
    running_calls: [],
    pending_approvals: 0,
    summary: {
      servers_total: 1,
      servers_online: 1,
      tools_total: 2,
      tools_enabled: 2,
      running_calls: 0,
      pending_approvals: 0,
    },
  };
}

function fakeRuntimeWithEvents({ skills = [] }: { skills?: WorkspaceSkillSummary[] } = {}) {
  let handler: ((event: AgentActionEnvelope) => void) | null = null;
  const base = fakeRuntime({ skills });
  const channel: ChatChannel = {
    close: vi.fn(),
    getStatus: vi.fn(() => "open" as WsConnectionStatus),
    getSessionId: vi.fn(() => "ses-live"),
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
  const runtime = {
    ...base,
    conversation: {
      openChatChannel: vi.fn(
        (onEvent: (event: AgentActionEnvelope) => void, options?: { onStatus?: (status: WsConnectionStatus) => void }) => {
          handler = onEvent;
          options?.onStatus?.("open");
          return channel;
        },
      ),
    },
  } as unknown as RuntimeBridge;
  return {
    runtime,
    emit(event: AgentActionEnvelope) {
      handler?.(event);
    },
  };
}

function dispatchPointer(target: EventTarget, type: string, props: Record<string, number>) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries(props)) {
    Object.defineProperty(event, key, { configurable: true, value });
  }
  target.dispatchEvent(event);
}

function workspaceSkill(): WorkspaceSkillSummary {
  return {
    name: "dev-plan",
    label: "/dev-plan",
    description: "Plan work from a design doc",
    source: "workspace",
    locator: ".keydex/skills/dev-plan/SKILL.md",
  };
}

function workspace(): Workspace {
  return {
    id: "ws-1",
    name: "keydex",
    root_path: "D:/repo/keydex",
    created_at: "2026-06-26T00:00:00Z",
    updated_at: "2026-06-26T00:00:00Z",
  } as Workspace;
}

function session(id = "ses-1", patch: Partial<AgentSession> = {}): AgentSession {
  return {
    id,
    title: "Workbench",
    session_type: "workspace",
    workspace_id: "ws-1",
    workspace: workspace(),
    created_at: "2026-06-26T00:00:00Z",
    updated_at: "2026-06-26T00:00:00Z",
    current_model_provider_id: "provider-1",
    current_model: "qwen-coder",
    ...patch,
  } as AgentSession;
}

function threadTask(patch: Partial<ThreadTask> = {}): ThreadTask {
  return {
    id: "task-1",
    session_id: "ses-1",
    type: "goal",
    type_label: "目标",
    title: null,
    objective: "目标",
    status: "active",
    metadata: {},
    evidence: [],
    blocked_audit: {},
    system_stop_reason: null,
    is_open: true,
    is_terminal: false,
    current_run_id: null,
    turn_count: 0,
    elapsed_seconds: 0,
    token_usage: {},
    created_at: "2026-07-03T00:00:00Z",
    updated_at: "2026-07-03T00:00:00Z",
    deleted_at: null,
    ...patch,
  } as ThreadTask;
}

function contextWindowUsage(sessionId: string, tokenCount: number): NonNullable<AgentSession["context_window_usage"]> {
  return {
    middleware: "ContextCompressionMiddleware",
    stage: "context_window_snapshot",
    session_id: sessionId,
    active_session_id: sessionId,
    timestamp_ms: 1000,
    token_count: tokenCount,
    context_window: 200000,
    threshold_token_count: 160000,
    threshold_usage_fraction: tokenCount / 160000,
    token_source: "usage_metadata",
  };
}
