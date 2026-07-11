import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { RuntimeBridge } from "../src/runtime";
import {
  ConversationPanel,
  ConversationPanelComposerAccessory,
  type ConversationPanelVariant,
} from "../src/renderer/pages/conversation/ConversationPanel";
import { A2UIRenderSuspensionProvider } from "../src/renderer/pages/conversation/messages/a2ui/A2UIRenderSuspensionContext";
import type { ConversationPanelModel } from "../src/renderer/pages/conversation/useConversationPanelModel";
import type { ConversationMessage } from "../src/renderer/stores/conversationStore";

describe("ConversationPanel", () => {
  it("renders shared MessageList content through the full variant by default", () => {
    render(
      <ConversationPanel
        model={panelModel({
          messages: [
            {
              id: "assistant-1",
              threadId: "ses-1",
              turnId: "turn-1",
              itemId: "item-1",
              kind: "assistant",
              status: "completed",
              content: "共享消息面板",
              payload: {},
              createdAt: "2026-06-27T00:00:00.000Z",
              updatedAt: "2026-06-27T00:00:00.000Z",
            },
          ],
        })}
        workspaceRuntime={fakeRuntime()}
      />,
    );

    expect(screen.getByTestId("conversation-panel").getAttribute("data-conversation-panel-variant")).toBe("full");
    expect(screen.getByText("共享消息面板")).not.toBeNull();
  });

  it("keeps compact and overlay variants on the shared panel boundary", () => {
    const { rerender } = render(
      <ConversationPanel model={panelModel()} workspaceRuntime={fakeRuntime()} variant="compact" />,
    );
    expect(screen.getByTestId("conversation-panel").getAttribute("data-conversation-panel-variant")).toBe("compact");

    rerender(<ConversationPanel model={panelModel()} workspaceRuntime={fakeRuntime()} variant="overlay" />);
    expect(screen.getByTestId("conversation-panel").getAttribute("data-conversation-panel-variant")).toBe("overlay");
    expect(screen.getByTestId("message-list").getAttribute("data-message-list-variant")).toBe("overlay");
  });

  it("passes the requested message list performance profile through the panel boundary", () => {
    render(
      <ConversationPanel
        model={panelModel()}
        workspaceRuntime={fakeRuntime()}
        performanceProfile="interactivePanel"
      />,
    );

    expect(screen.getByTestId("message-list").getAttribute("data-performance-profile")).toBe("interactivePanel");
  });

  it("resets the cached message list to the bottom when switching sessions", () => {
    const scrollHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    const clientHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => 1000 });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 200 });

    try {
      const runtime = fakeRuntime();
      const sessionAMessage = { ...message("assistant-a", "assistant", "session A"), threadId: "ses-a" };
      const sessionBMessage = { ...message("assistant-b", "assistant", "session B"), threadId: "ses-b" };
      const { rerender } = render(
        <ConversationPanel
          model={panelModel({ sessionId: "ses-a", messages: [sessionAMessage] })}
          workspaceRuntime={runtime}
        />,
      );
      const firstSessionScroller = screen.getByTestId("message-list-scroll") as HTMLDivElement;
      expect(firstSessionScroller.scrollTop).toBe(800);
      fireEvent.wheel(firstSessionScroller, { deltaY: -120 });
      firstSessionScroller.scrollTop = 0;
      fireEvent.scroll(firstSessionScroller);

      rerender(
        <ConversationPanel
          model={panelModel({ sessionId: "ses-b", messages: [sessionBMessage] })}
          workspaceRuntime={runtime}
        />,
      );
      const secondSessionScroller = screen.getByTestId("message-list-scroll") as HTMLDivElement;
      expect(secondSessionScroller.scrollTop).toBe(800);
      fireEvent.wheel(secondSessionScroller, { deltaY: -120 });
      secondSessionScroller.scrollTop = 0;
      fireEvent.scroll(secondSessionScroller);

      rerender(
        <ConversationPanel
          model={panelModel({ sessionId: "ses-a", messages: [sessionAMessage] })}
          workspaceRuntime={runtime}
        />,
      );
      const restoredSessionScroller = screen.getByTestId("message-list-scroll") as HTMLDivElement;
      expect(restoredSessionScroller.scrollTop).toBe(800);
    } finally {
      restorePrototypeDescriptor("scrollHeight", scrollHeightDescriptor);
      restorePrototypeDescriptor("clientHeight", clientHeightDescriptor);
    }
  });

  it("inherits layout-level A2UI render suspension for main conversation content", () => {
    render(
      <A2UIRenderSuspensionProvider suspended>
        <ConversationPanel
          model={panelModel({ messages: [a2uiConversationMessage()] })}
          workspaceRuntime={fakeRuntime()}
        />
      </A2UIRenderSuspensionProvider>,
    );

    expect(screen.getByTestId("message-list").getAttribute("data-a2ui-render-suspended")).toBe("true");
    expect(screen.getByTestId("a2ui-block").getAttribute("data-a2ui-suspended")).toBe("resize");
    expect(screen.getByTestId("a2ui-resize-placeholder")).not.toBeNull();
    expect(screen.queryByTestId("a2ui-choice")).toBeNull();
  });

  it("renders a green top notice inside the shared message list", () => {
    render(
      <ConversationPanel
        model={panelModel()}
        workspaceRuntime={fakeRuntime()}
        topNotice={{
          content: "该会话前置2轮历史消息已加载",
          tone: "success",
          testId: "btw-conversation-history-notice",
        }}
        emptyText="旁路对话暂无消息"
      />,
    );

    const notice = screen.getByTestId("btw-conversation-history-notice");
    expect(notice.textContent).toContain("该会话前置2轮历史消息已加载");
    expect(notice.getAttribute("data-state")).toBe("success");
    expect(notice.querySelector("svg")).toBeNull();
    expect(screen.getByTestId("message-empty").textContent).toBe("旁路对话暂无消息");
  });

  it.each<ConversationPanelVariant>(["full", "compact", "overlay"])(
    "renders primary message kinds through the %s variant",
    (variant) => {
      render(
        <ConversationPanel
          model={panelModel({
            messages: [
              message("user-1", "user", "用户问题"),
              message("assistant-1", "assistant", "助手回答"),
              message("tool-1", "tool", "工具结果", {
                call: { id: "call-1", name: "workspace_search", arguments: { query: "README" } },
                result: { status: "success", model_content: "README.md" },
              }),
              message("file-1", "file_change", "编辑 README", {
                files: [{ path: "README.md", operation: "modify" }],
                result: { status: "success", files: [{ path: "README.md", operation: "modify" }] },
              }),
              message("error-1", "error", "执行失败", {
                error: { code: "runtime_error", message: "执行失败", details: {} },
              }),
            ],
          })}
          workspaceRuntime={fakeRuntime()}
          variant={variant}
        />,
      );

      expect(screen.getByTestId("conversation-panel").getAttribute("data-conversation-panel-variant")).toBe(variant);
      expect(screen.getByTestId("message-list").getAttribute("data-message-list-variant")).toBe(variant);
      expect(screen.getByText("用户问题")).not.toBeNull();
      expect(screen.getByText("助手回答")).not.toBeNull();
      expect(screen.getByTestId("tool-call-block")).not.toBeNull();
      expect(screen.getByTestId("file-change-block")).not.toBeNull();
      expect(screen.getByTestId("error-item")).not.toBeNull();
    },
  );

  it("can hide fork actions while keeping message content visible", () => {
    const forkFromMessage = vi.fn();
    const assistant = message("assistant-1", "assistant", "助手回答", {
      messageEventId: "evt-ai-1",
    });
    const { rerender } = render(
      <ConversationPanel
        model={panelModel({
          messages: [assistant],
          forkFromMessage,
        })}
        workspaceRuntime={fakeRuntime()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "从该轮派生对话" }));
    expect(forkFromMessage).toHaveBeenCalledWith(assistant);

    rerender(
      <ConversationPanel
        model={panelModel({
          messages: [assistant],
          forkFromMessage,
        })}
        workspaceRuntime={fakeRuntime()}
        showForkActions={false}
      />,
    );

    expect(screen.getByText("助手回答")).not.toBeNull();
    expect(screen.queryByRole("button", { name: "从该轮派生对话" })).toBeNull();
  });

  it("wires composer accessory file preview and scroll controls to the same model", () => {
    const openFileChangePreview = vi.fn();
    const scrollToBottom = vi.fn();
    render(
      <ConversationPanelComposerAccessory
        model={panelModel({
          showScrollToBottom: true,
          scrollToBottom,
          openFileChangePreview,
          messages: [
            {
              id: "tool-1",
              threadId: "ses-1",
              turnId: "turn-1",
              itemId: "item-1",
              kind: "file_change",
              status: "completed",
              content: "edited",
              payload: {
                files: [{ path: "README.md", operation: "modify" }],
                result: { status: "success", files: [{ path: "README.md", operation: "modify" }] },
              },
              createdAt: "2026-06-27T00:00:00.000Z",
              updatedAt: "2026-06-27T00:00:00.000Z",
            },
          ],
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "滚动到底" }));
    expect(scrollToBottom).toHaveBeenCalledTimes(1);
  });

  it("loads deferred tool details through the shared panel and keeps the loaded patch cached", async () => {
    const loadToolDetails = vi.fn().mockResolvedValue({
      payload: {
        call: {
          id: "call-1",
          name: "read_file",
          arguments: { path: "README.md", content: "large input" },
        },
        result: { status: "success", model_content: "完整文件内容" },
      },
    });
    const tool = deferredToolMessage();
    render(
      <ConversationPanel
        model={panelModel({
          messages: [tool],
          loadToolDetails,
        })}
        workspaceRuntime={fakeRuntime()}
        variant="compact"
      />,
    );

    expect(screen.getByText("已读取文件 README.md")).not.toBeNull();
    expect(screen.queryByText("完整文件内容")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "展开工具详情" }));

    await waitFor(() => {
      expect(loadToolDetails).toHaveBeenCalledWith(tool);
      expect(screen.getByText("完整文件内容")).not.toBeNull();
    });
    expect(screen.getByLabelText("工具入参").textContent).toContain('"content": "large input"');

    fireEvent.click(screen.getByRole("button", { name: "收起工具详情" }));
    fireEvent.click(screen.getByRole("button", { name: "展开工具详情" }));
    expect(loadToolDetails).toHaveBeenCalledTimes(1);
  });

  it("shows deferred tool detail failures without breaking the list and retries on the next expansion", async () => {
    const loadToolDetails = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary"))
      .mockResolvedValueOnce({
        payload: {
          result: { status: "success", model_content: "retry ok" },
        },
      });
    render(
      <ConversationPanel
        model={panelModel({
          messages: [deferredToolMessage()],
          loadToolDetails,
        })}
        workspaceRuntime={fakeRuntime()}
        variant="overlay"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "展开工具详情" }));

    await waitFor(() => {
      expect(screen.getByText("工具详情加载失败")).not.toBeNull();
    });
    expect(screen.getByText("已读取文件 README.md")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "收起工具详情" }));
    fireEvent.click(screen.getByRole("button", { name: "展开工具详情" }));

    await waitFor(() => {
      expect(loadToolDetails).toHaveBeenCalledTimes(2);
      expect(screen.getByText("retry ok")).not.toBeNull();
    });
  });

  it("clears deferred tool detail patches when the panel switches sessions", async () => {
    const loadToolDetails = vi
      .fn()
      .mockResolvedValueOnce({
        payload: {
          result: { status: "success", model_content: "session one detail" },
        },
      })
      .mockResolvedValueOnce({
        payload: {
          result: { status: "success", model_content: "session two detail" },
        },
      });
    const firstSessionMessage = deferredToolMessage({ threadId: "ses-1" });
    const secondSessionMessage = deferredToolMessage({ threadId: "ses-2" });
    const { rerender } = render(
      <ConversationPanel
        model={panelModel({
          sessionId: "ses-1",
          messages: [firstSessionMessage],
          loadToolDetails,
        })}
        workspaceRuntime={fakeRuntime()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "展开工具详情" }));
    await waitFor(() => {
      expect(screen.getByText("session one detail")).not.toBeNull();
    });

    rerender(
      <ConversationPanel
        model={panelModel({
          sessionId: "ses-2",
          messages: [secondSessionMessage],
          loadToolDetails,
        })}
        workspaceRuntime={fakeRuntime()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "展开工具详情" }));

    await waitFor(() => {
      expect(loadToolDetails).toHaveBeenCalledTimes(2);
      expect(loadToolDetails).toHaveBeenLastCalledWith(secondSessionMessage);
      expect(screen.getByText("session two detail")).not.toBeNull();
    });
    expect(screen.queryByText("session one detail")).toBeNull();
  });
});

function panelModel(overrides: Partial<ConversationPanelModel> = {}): ConversationPanelModel {
  return {
    sessionId: "ses-1",
    messages: [],
    session: null,
    sessionViewState: null,
    pendingApproval: null,
    runtimeState: "idle",
    runtimeDetail: null,
    loading: false,
    loadingOlderHistory: false,
    loadOlderHistory: vi.fn(),
    messageWorkspaceScope: { sessionId: "ses-1" },
    workspaceAvailable: false,
    workspaceUnavailable: false,
    workspaceLabel: undefined,
    workspaceSkills: [],
    searchWorkspace: undefined,
    listWorkspaceDirectory: undefined,
    showScrollToBottom: false,
    updateScrollControls: vi.fn(),
    scrollToBottom: vi.fn(),
    scrollToBottomAfterSend: vi.fn(),
    handleRuntimeError: vi.fn(),
    handleRuntimeEventSideEffects: vi.fn(),
    quoteSelection: vi.fn(),
    startChatFromAnnotation: vi.fn(),
    previewRenderContext: {},
    openPreview: vi.fn(),
    openFileReference: vi.fn(),
    openFileChangePreview: vi.fn(),
    loadToolDetails: vi.fn(),
    ...overrides,
  } as unknown as ConversationPanelModel;
}

function restorePrototypeDescriptor(
  key: "scrollHeight" | "clientHeight",
  descriptor: PropertyDescriptor | undefined,
) {
  if (descriptor) {
    Object.defineProperty(HTMLElement.prototype, key, descriptor);
    return;
  }
  delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
}

function message(
  id: string,
  kind: ConversationMessage["kind"],
  content: string,
  payload: ConversationMessage["payload"] = {},
): ConversationMessage {
  return {
    id,
    threadId: "ses-1",
    turnId: "turn-1",
    itemId: id,
    kind,
    status: kind === "error" ? "failed" : "completed",
    content,
    payload,
    createdAt: "2026-06-27T00:00:00.000Z",
    updatedAt: "2026-06-27T00:00:00.000Z",
  };
}

function a2uiConversationMessage(): ConversationMessage {
  const a2ui = {
    render_key: "choice",
    mode: "interactive",
    stream_id: "stream-choice",
    tool_call_id: "tool-choice",
    trace_id: "trace-choice",
    turn_index: 1,
    payload: {
      title: "选择发布方式",
      description: "选一个继续",
      options: [{ label: "立即发布", value: "now" }],
    },
    input_schema: {},
    submit_schema: {},
    interaction: {
      interaction_id: "interaction-choice",
      status: "waiting_user_input",
      can_submit: true,
    },
  };

  return {
    id: "agent:a2ui-choice",
    threadId: "ses-1",
    turnId: "turn-1",
    itemId: "a2ui-choice",
    kind: "a2ui",
    status: "pending",
    content: "",
    payload: {
      a2ui,
      a2uiDebug: {
        id: "stream-choice",
        status: "created",
        renderKey: "choice",
        mode: "interactive",
        streamId: "stream-choice",
        interactionId: "interaction-choice",
        toolCallId: "tool-choice",
        traceId: "trace-choice",
        turnIndex: 1,
        chunkCount: 0,
        argsBuffer: "",
        argsTextLength: 0,
        jsonParseStatus: "valid",
        a2ui,
        payload: a2ui.payload,
        inputSchema: {},
        submitSchema: {},
        interaction: a2ui.interaction,
        rawEvents: [],
        updatedAt: 1_700_000_000_000,
      },
      interaction: a2ui.interaction,
      interactionId: "interaction-choice",
      renderKey: "choice",
      streamId: "stream-choice",
    },
    createdAt: "2026-06-27T00:00:00.000Z",
    updatedAt: "2026-06-27T00:00:00.000Z",
  };
}

function deferredToolMessage(overrides: Partial<ConversationMessage> = {}): ConversationMessage {
  return {
    id: "tool-1",
    threadId: "ses-1",
    turnId: "turn-1",
    itemId: "item-tool-1",
    kind: "tool",
    itemType: "tool_call",
    status: "completed",
    content: "read_file",
    payload: {
      call: {
        id: "call-1",
        name: "read_file",
        arguments: { path: "README.md" },
      },
      toolDetailsDeferred: true,
      toolDetailRef: {
        startEventId: "evt-start",
        endEventId: "evt-end",
        runId: "run-1",
        toolCallId: "call-1",
      },
    },
    createdAt: "2026-06-27T00:00:00.000Z",
    updatedAt: "2026-06-27T00:00:00.000Z",
    ...overrides,
  };
}

function fakeRuntime(): RuntimeBridge {
  return {} as RuntimeBridge;
}
