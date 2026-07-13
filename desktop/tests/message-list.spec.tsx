import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeBridge } from "@/runtime";
import { ConversationTurnNavigator, MessageList } from "@/renderer/pages/conversation/messages";
import {
  buildTurnNavigationItemsFromMessages,
  conversationListModeFor,
  visibleTurnIndexesFromMountedTurns,
} from "@/renderer/pages/conversation/messages/MessageList";
import { conversationBaselineDiagnostics } from "@/renderer/pages/conversation/messages/conversationBaselineDiagnostics";
import { MessageGroupBlock } from "@/renderer/pages/conversation/messages/MessageGroupBlock";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";

class AutoLoadingImage {
  decoding = "async";
  referrerPolicy = "";
  naturalWidth = 320;
  naturalHeight = 180;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private value = "";

  get src() {
    return this.value;
  }

  set src(value: string) {
    this.value = value;
    if (value) queueMicrotask(() => this.onload?.());
  }

  decode() {
    return Promise.resolve();
  }
}

afterEach(() => vi.unstubAllGlobals());

describe("MessageList", () => {
  it("keeps ordinary histories native and virtualizes only beyond explicit cost thresholds", () => {
    expect(conversationListModeFor({ turnCount: 120, unitCount: 420, a2uiWeight: 0 })).toBe("native");
    expect(conversationListModeFor({ turnCount: 1, unitCount: 3, a2uiWeight: 100 })).toBe("native");
    expect(conversationListModeFor({ turnCount: 121, unitCount: 360, a2uiWeight: 0 })).toBe("virtual");
    expect(conversationListModeFor({ turnCount: 100, unitCount: 421, a2uiWeight: 0 })).toBe("virtual");
    expect(conversationListModeFor({ turnCount: 41, unitCount: 180, a2uiWeight: 49 })).toBe("virtual");
  });

  it("keeps the chosen scroll surface stable while a conversation grows", () => {
    const renderMessage = (entry: ConversationMessage) => <span>{entry.id}</span>;
    const { rerender } = render(
      <MessageList messages={historyMessages(2, "stable-native")} renderMessage={renderMessage} />,
    );

    expect(screen.getByTestId("message-list").getAttribute("data-list-mode")).toBe("native");
    rerender(<MessageList messages={historyMessages(121, "stable-native")} renderMessage={renderMessage} />);
    expect(screen.getByTestId("message-list").getAttribute("data-list-mode")).toBe("native");
    expect(screen.queryByTestId("conversation-scroll-rail")).toBeNull();

    const anotherConversation = historyMessages(121, "new-virtual")
      .map((entry) => ({ ...entry, threadId: "thread-2" }));
    rerender(<MessageList messages={anotherConversation} renderMessage={renderMessage} />);
    expect(screen.getByTestId("message-list").getAttribute("data-list-mode")).toBe("virtual");
  });

  it("bounds turn navigator previews instead of retaining an entire giant reply", () => {
    const items = buildTurnNavigationItemsFromMessages([
      message("preview-user", "user", "简短问题"),
      message("preview-assistant", "assistant", "x".repeat(1024 * 1024)),
    ]);

    expect(items).toHaveLength(1);
    expect(items[0].userPreview).toBe("简短问题");
    expect(items[0].assistantPreview[0]).toHaveLength(240);
  });

  it("renders empty and loading states", () => {
    const { rerender } = render(<MessageList messages={[]} emptyText="还没有消息" />);

    expect(screen.getByTestId("message-empty").textContent).toBe("还没有消息");
    expect(screen.getByTestId("message-list-scroll").getAttribute("data-empty-layout")).toBe("default");

    rerender(<MessageList messages={[]} loading />);
    expect(screen.getByTestId("message-skeleton")).not.toBeNull();
    expect(screen.getByRole("status", { name: "正在加载消息" })).not.toBeNull();
  });

  it("exposes centered empty layout on the empty scroll surface", () => {
    render(<MessageList messages={[]} emptyLayout="center" emptyText="还没有消息" />);

    expect(screen.getByTestId("message-list-scroll").getAttribute("data-empty-layout")).toBe("center");
    expect(screen.getByTestId("message-empty").textContent).toBe("还没有消息");
  });

  it("renders messages with the default lightweight renderer", () => {
    render(<MessageList messages={[message("m1", "user", "你好"), message("m2", "assistant", "收到")]} />);

    expect(screen.getAllByText("你好").length).toBeGreaterThan(0);
    expect(screen.getAllByText("收到").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "复制消息" }).length).toBe(2);
  });

  it("shows branch actions only for persisted completed messages", () => {
    const fork = vi.fn();
    const reverse = vi.fn();
    const branchableAssistant = {
      ...message("m1", "assistant", "可以从这里继续"),
      payload: { messageEventId: "evt-ai-1" },
    };
    const reversibleUser = {
      ...message("m2", "user", "回退这一轮"),
      payload: { messageEventId: "evt-user-1" },
    };
    const running = {
      ...message("m3", "assistant", "还在输出"),
      status: "running" as const,
      payload: { messageEventId: "evt-ai-2" },
    };
    const { rerender } = render(
      <MessageList
        messages={[reversibleUser, branchableAssistant]}
        onForkFromMessage={fork}
        onReverseFromMessage={reverse}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "从该轮派生对话" }));
    fireEvent.click(screen.getByRole("button", { name: "回溯到此处" }));
    expect(fork).toHaveBeenCalledWith(branchableAssistant);
    expect(reverse).toHaveBeenCalledWith(reversibleUser);

    rerender(<MessageList messages={[message("m3", "assistant", "没有事件")]} onForkFromMessage={fork} />);
    expect(screen.queryByRole("button", { name: "从该轮派生对话" })).toBeNull();

    rerender(<MessageList messages={[running]} onForkFromMessage={fork} onReverseFromMessage={reverse} />);
    expect(screen.queryByRole("button", { name: "从该轮派生对话" })).toBeNull();
    expect(screen.queryByRole("button", { name: "回溯到此处" })).toBeNull();
  });

  it("can hide fork source markers while keeping turn actions", () => {
    const forkSource = {
      id: "fork-1",
      source_session_id: "source-session",
      target_session_id: "target-session",
      source_message_event_id: "source-event",
      target_message_event_id: "target-event",
    };
    const forkedAssistant = {
      ...message("m1", "assistant", "派生后的回答"),
      payload: {
        messageEventId: "target-event",
        forkSource,
      },
    };
    const { rerender } = render(<MessageList messages={[forkedAssistant]} onForkFromMessage={vi.fn()} />);

    expect(screen.getByTestId("message-fork-marker").textContent).toContain("从「源会话」中派生");
    expect(screen.getByRole("button", { name: "从该轮派生对话" })).not.toBeNull();

    rerender(
      <MessageList messages={[forkedAssistant]} onForkFromMessage={vi.fn()} showForkSourceMarkers={false} />,
    );

    expect(screen.queryByTestId("message-fork-marker")).toBeNull();
    expect(screen.getByRole("button", { name: "从该轮派生对话" })).not.toBeNull();
  });

  it("renders divider notices as text-only rows without leading icons", () => {
    const forkSource = {
      id: "fork-1",
      source_session_id: "source-session",
      target_session_id: "target-session",
      source_message_event_id: "source-event",
      target_message_event_id: "target-event",
    };
    const compressionNotice = message("m1", "context_compression", "上下文压缩已完成");
    const cancelledNotice = message("m2", "cancelled", "对话已取消");
    const retryNotice = message("m4", "llm_retry", "LLM 请求正在重试 1/3");
    const threadTaskNotice = goalTurnMarker("m5", 2);
    const forkedAssistant = {
      ...message("m3", "assistant", "派生后的回答"),
      payload: {
        messageEventId: "target-event",
        forkSource,
      },
    };

    render(
      <MessageList
        messages={[compressionNotice, retryNotice, threadTaskNotice, cancelledNotice, forkedAssistant]}
        topNotice={{
          content: "该会话前置1轮历史消息已加载",
          tone: "success",
          testId: "btw-conversation-history-notice",
        }}
      />,
    );

    expect(screen.getByTestId("btw-conversation-history-notice").querySelector("svg")).toBeNull();
    expect(screen.getByTestId("context-compression-notice").querySelector("svg")).toBeNull();
    expect(screen.getByTestId("llm-retry-notice").querySelector("svg")).toBeNull();
    expect(screen.getByTestId("llm-retry-notice").getAttribute("data-notice-kind")).toBe("llm_retry");
    expect(screen.getByTestId("thread-task-continuation-notice").querySelector("svg")).toBeNull();
    expect(screen.getByTestId("thread-task-continuation-notice").getAttribute("data-notice-kind")).toBe("thread_task_continue");
    expect(screen.getByTestId("conversation-cancelled-notice").querySelector("svg")).toBeNull();
    expect(screen.getByTestId("message-fork-marker").querySelector("svg")).toBeNull();
  });

  it("renders the shared loading icon only for running compression notices", () => {
    const runningCompression = {
      ...message("m1", "context_compression", "正在压缩上下文"),
      status: "running" as const,
      payload: {
        metadata: {
          compression: {
            kind: "context_compression",
            stage: "compression_started",
            mode: "context",
            notice_id: "context-compression:thread-1:run-1",
          },
        },
      },
    };
    const completedCompression = {
      ...message("m2", "context_compression", "上下文压缩已完成"),
      payload: {
        metadata: {
          compression: {
            kind: "context_compression",
            stage: "compression_completed",
            mode: "context",
            notice_id: "context-compression:thread-1:run-1",
          },
        },
      },
    };
    const { rerender } = render(<MessageList messages={[runningCompression]} />);

    expect(screen.getByTestId("context-compression-notice").getAttribute("data-state")).toBe("running");
    expect(screen.getByTestId("context-compression-notice").querySelector("svg")).not.toBeNull();

    rerender(<MessageList messages={[completedCompression]} />);

    expect(screen.getByTestId("context-compression-notice").getAttribute("data-state")).toBe("completed");
    expect(screen.getByTestId("context-compression-notice").querySelector("svg")).toBeNull();
  });

  it("renders compression notices as timeline events after the previous turn footer", () => {
    const user = {
      ...message("m1", "user", "请总结"),
      payload: { turnIndex: 1, turn_index: 1, messageEventId: "evt-user-1" },
    };
    const assistant = {
      ...message("m2", "assistant", "总结完成"),
      payload: { turnIndex: 1, turn_index: 1, messageEventId: "evt-assistant-1" },
    };
    const compressionNotice = {
      ...message("m3", "context_compression", "上下文压缩已完成"),
      payload: {
        turnIndex: 1,
        turn_index: 1,
        metadata: {
          compression: {
            kind: "context_compression",
            stage: "compression_completed",
            mode: "context",
            notice_id: "context-compression:thread-1:run-1",
          },
        },
      },
    };
    const { container } = render(<MessageList messages={[user, assistant, compressionNotice]} />);

    const turn = screen.getByTestId("message-turn");
    const timelineEvent = screen.getByTestId("message-timeline-event");
    const notice = screen.getByTestId("context-compression-notice");
    const turnFooter = container.querySelector('footer[data-placement="turn"]');

    expect(screen.getAllByTestId("message-turn")).toHaveLength(1);
    expect(timelineEvent.getAttribute("data-kind")).toBe("context_compression");
    expect(notice.closest('[data-testid="message-turn"]')).toBeNull();
    expect(turnFooter).not.toBeNull();
    expect(turnIndexFor(turnFooter)).toBe(turnIndexFor(turn));
    expect(Boolean(turnFooter!.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  });

  it("renders a goal continuation divider from a turn marker event", () => {
    render(
      <MessageList
        messages={[
          {
            ...message("m1", "user", "启动目标"),
            payload: { turnIndex: 1, turn_index: 1 },
          },
          {
            ...message("m2", "assistant", "第一轮回复"),
            payload: { turnIndex: 1, turn_index: 1 },
          },
          goalTurnMarker("m3", 2),
          {
            ...message("m4", "assistant", "第二轮续跑回复"),
            payload: { turnIndex: 2, turn_index: 2 },
          },
        ]}
      />,
    );

    expect(screen.getByTestId("thread-task-continuation-notice").textContent).toBe("目标继续执行");
    expect(screen.getAllByTestId("message-turn")).toHaveLength(2);
  });

  it("does not render a goal continuation divider from assistant metadata alone", () => {
    render(
      <MessageList
        messages={[
          message("m1", "user", "启动目标"),
          message("m2", "assistant", "第一轮回复"),
          {
            ...message("m3", "assistant", "第二轮续跑回复"),
            payload: {
              turnIndex: 2,
              turn_index: 2,
              metadata: {
                runtime_params: {
                  thread_task: {
                    task_id: "task-1",
                    run_id: "run-1",
                    trigger: "task_continue",
                    type: "goal",
                  },
                },
              },
            },
          },
        ]}
      />,
    );

    expect(screen.queryByTestId("thread-task-continuation-notice")).toBeNull();
  });

  it("keeps realtime goal continuation dividers inside the next agent turn", () => {
    render(
      <MessageList
        messages={[
          message("m1", "user", "启动目标"),
          message("m2", "assistant", "第一轮回复"),
          goalTurnMarker("m3", 2),
          message("m4", "assistant", "第二轮续跑回复"),
        ]}
      />,
    );

    const turns = screen.getAllByTestId("message-turn");
    expect(turns).toHaveLength(2);
    const continuation = screen.getByTestId("thread-task-continuation-notice");
    expect(turnIndexFor(screen.getByText("第一轮回复"))).toBe("0");
    expect(turnIndexFor(continuation)).toBe("1");
    expect(turnIndexFor(screen.getByText("第二轮续跑回复"))).toBe("1");
  });

  it("does not show continuation dividers for ordinary user turn markers", () => {
    render(
      <MessageList
        messages={[
          message("m1", "user", "第一轮"),
          message("m2", "assistant", "第一轮回复"),
          userTurnMarker("m3", 2),
          message("m4", "user", "第二轮"),
          message("m5", "assistant", "第二轮回复"),
        ]}
      />,
    );

    expect(screen.queryByTestId("thread-task-continuation-notice")).toBeNull();
    expect(screen.getAllByTestId("message-turn")).toHaveLength(2);
  });

  it("keeps realtime goal continuation dividers aligned to their turn markers while streaming", () => {
    const secondContinuation = {
      ...message("m4", "assistant", "第二轮续跑回复"),
      payload: { turnIndex: 2, turn_index: 2 },
    };
    const thirdContinuation = {
      ...message("m5", "assistant", "第三轮正在输出"),
      status: "running" as const,
      payload: { turnIndex: 3, turn_index: 3 },
    };

    render(
      <MessageList
        isProcessing
        messages={[
          message("m1", "user", "启动目标"),
          message("m2", "assistant", "第一轮回复"),
          goalTurnMarker("m3", 2),
          secondContinuation,
          goalTurnMarker("m6", 3),
          thirdContinuation,
        ]}
      />,
    );

    const turns = screen.getAllByTestId("message-turn");
    expect(turns).toHaveLength(3);
    expect(turnIndexFor(screen.getByText("第二轮续跑回复"))).toBe("1");
    const notices = screen.getAllByTestId("thread-task-continuation-notice");
    expect(turnIndexFor(notices[1])).toBe("2");
    expect(turnIndexFor(screen.getByText("第三轮正在输出"))).toBe("2");
  });

  it("keeps completed goal continuation turns with action footers while the next turn is streaming", () => {
    const secondContinuation = {
      ...message("m4", "assistant", "第二轮续跑回复"),
      payload: { messageEventId: "evt-goal-2" },
    };
    const thirdContinuation = {
      ...message("m6", "assistant", "第三轮正在输出"),
      status: "running" as const,
      payload: { messageEventId: "evt-goal-3" },
    };

    render(
      <MessageList
        isProcessing
        messages={[
          message("m1", "user", "启动目标"),
          { ...message("m2", "assistant", "第一轮回复"), payload: { messageEventId: "evt-goal-1" } },
          goalTurnMarker("m3", 2),
          secondContinuation,
          goalTurnMarker("m5", 3),
          thirdContinuation,
        ]}
        onForkFromMessage={vi.fn()}
      />,
    );

    const turns = screen.getAllByTestId("message-turn");
    expect(turns).toHaveLength(3);
    expect(turnIndexFor(screen.getByText("第二轮续跑回复"))).toBe("1");
    const forkButton = screen.getAllByRole("button", { name: "从该轮派生对话" }).find(
      (button) => turnIndexFor(button) === "1",
    );
    expect(forkButton).toBeDefined();
    expect(turnIndexFor(forkButton ?? null)).toBe("1");
    expect(turnIndexFor(screen.getAllByTestId("thread-task-continuation-notice")[1])).toBe("2");
    expect(turnIndexFor(screen.getByText("第三轮正在输出"))).toBe("2");
    const forkButtons = screen.getAllByRole("button", { name: "从该轮派生对话" });
    expect(forkButtons).toHaveLength(2);
    expect(forkButtons.some((button) => turnIndexFor(button) === "2")).toBe(false);
  });

  it("places goal continuation turn markers before their run content and keeps goal status at turn end", () => {
    const secondBoundary = at(goalTurnMarker("m3", 2), "2026-07-03T00:00:02.000Z");
    const secondReply = at(message("m4", "assistant", "第二轮回复"), "2026-07-03T00:00:02.100Z");
    const thirdReply = at(message("m5", "assistant", "第三轮前半段"), "2026-07-03T00:00:03.100Z");
    const goalStatus = at(
      {
        ...message("m6", "thread_task_status", "update_thread_task"),
        payload: {
          call: {
            id: "call-goal",
            name: "update_thread_task",
            arguments: {
              status: "complete",
              summary: "三轮目标已完成",
            },
          },
          result: {
            status: "success",
            ui_payload: {
              task: {
                type: "goal",
                type_label: "目标",
                status: "complete",
              },
            },
          },
        },
      },
      "2026-07-03T00:00:03.200Z",
    );
    const thirdBoundary = at(
      goalTurnMarker("m7", 3),
      "2026-07-03T00:00:03.000Z",
    );
    const thirdSummary = at(message("m8", "assistant", "第三轮总结"), "2026-07-03T00:00:03.300Z");

    render(
      <MessageList
        messages={[
          at(message("m1", "user", "启动目标"), "2026-07-03T00:00:01.000Z"),
          at(message("m2", "assistant", "第一轮回复"), "2026-07-03T00:00:01.100Z"),
          secondBoundary,
          secondReply,
          thirdBoundary,
          thirdReply,
          goalStatus,
          thirdSummary,
        ]}
      />,
    );

    const turns = screen.getAllByTestId("message-turn");
    expect(turns).toHaveLength(3);
    expect(turnIndexFor(screen.getByText("第二轮回复"))).toBe("1");
    expect(turnIndexFor(screen.getAllByTestId("thread-task-continuation-notice")[1])).toBe("2");
    expect(turnIndexFor(screen.getByText("第三轮前半段"))).toBe("2");
    expect(turnIndexFor(screen.getByText("第三轮总结"))).toBe("2");

    const statusSummary = screen.getByTestId("thread-task-status-summary");
    expect(turnIndexFor(statusSummary)).toBe("2");
    expect(statusSummary.textContent).toContain("目标已完成");
    expect(statusSummary.textContent).toContain("三轮目标已完成");
    expect(screen.getByText("第三轮总结").compareDocumentPosition(statusSummary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("renders goal status updates at the end of the turn instead of their raw tool position", () => {
    render(
      <MessageList
        messages={[
          message("m1", "user", "启动目标"),
          {
            ...message("m2", "thread_task_status", "update_thread_task"),
            payload: {
              call: {
                id: "call-goal",
                name: "update_thread_task",
                arguments: {
                  status: "complete",
                  summary: "目标执行完成",
                  checklist: [{ content: "完成自动续跑验证" }],
                },
              },
              result: {
                status: "success",
                duration_ms: 23,
                ui_payload: {
                  task: {
                    type: "goal",
                    type_label: "目标",
                    status: "complete",
                    objective: "验证 goal 功能",
                  },
                },
              },
            },
          },
          message("m3", "assistant", "最终回复"),
        ]}
      />,
    );

    const assistantText = screen.getByText("最终回复");
    const summary = screen.getByTestId("thread-task-status-summary");
    const block = screen.getByTestId("thread-task-status-block");

    expect(assistantText.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(summary.contains(block)).toBe(true);
    expect(block.textContent).toContain("目标已完成");
    expect(block.textContent).toContain("目标执行完成");
    expect(block.textContent).not.toContain("update_thread_task");
    expect(block.textContent).not.toContain("23ms");
  });

  it("waits until the active turn completes before showing goal status summary", () => {
    const messages = [
      message("m1", "user", "启动目标"),
      message("m2", "assistant", "准备标记目标"),
      {
        ...message("m3", "thread_task_status", "update_thread_task"),
        payload: {
          call: {
            id: "call-goal",
            name: "update_thread_task",
            arguments: {
              status: "complete",
              summary: "目标执行完成",
            },
          },
          result: {
            status: "success",
            ui_payload: {
              task: {
                type: "goal",
                type_label: "目标",
                status: "complete",
              },
            },
          },
        },
      },
    ];
    const { rerender } = render(<MessageList messages={messages} isProcessing />);

    expect(screen.queryByTestId("thread-task-status-summary")).toBeNull();
    expect(screen.queryByText("目标已完成")).toBeNull();

    rerender(<MessageList messages={messages} />);

    expect(screen.getByTestId("thread-task-status-summary").textContent).toContain("目标已完成");
    expect(screen.getByTestId("thread-task-status-summary").textContent).toContain("目标执行完成");
  });

  it("shows the final goal status result when a failed update is retried successfully", () => {
    render(
      <MessageList
        messages={[
          message("m1", "user", "启动目标"),
          {
            ...message("m2", "thread_task_status", "update_thread_task"),
            status: "failed",
            payload: {
              call: {
                id: "call-goal-failed",
                name: "update_thread_task",
                arguments: {
                  status: "complete",
                  summary: "第一次更新失败",
                },
              },
              result: {
                status: "error",
                error: "临时失败",
              },
            },
          },
          {
            ...message("m3", "thread_task_status", "update_thread_task"),
            payload: {
              call: {
                id: "call-goal-success",
                name: "update_thread_task",
                arguments: {
                  status: "complete",
                  summary: "目标执行完成",
                },
              },
              result: {
                status: "success",
                ui_payload: {
                  task: {
                    type: "goal",
                    type_label: "目标",
                    status: "complete",
                  },
                },
              },
            },
          },
          message("m4", "assistant", "最终回复"),
        ]}
      />,
    );

    const blocks = screen.getAllByTestId("thread-task-status-block");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].getAttribute("data-state")).toBe("success");
    expect(blocks[0].textContent).toContain("目标已完成");
    expect(blocks[0].textContent).toContain("重试后成功");
    expect(blocks[0].textContent).toContain("目标执行完成");
    expect(blocks[0].textContent).not.toContain("目标状态更新失败");
    expect(blocks[0].textContent).not.toContain("第一次更新失败");
  });

  it("coalesces historical failed goal status attempts without task id into the later successful task result", () => {
    render(
      <MessageList
        messages={[
          message("m1", "user", "启动目标"),
          {
            ...message("m2", "thread_task_status", "update_thread_task"),
            status: "failed",
            payload: {
              call: {
                id: "call-goal-failed",
                name: "update_thread_task",
                arguments: {
                  status: "complete",
                  summary: "第一轮输出两句话后等待；第二轮输出确认等待；第三轮准备完成",
                },
              },
              result: {
                status: "error",
                error: "临时失败",
              },
            },
          },
          {
            ...message("m3", "thread_task_status", "update_thread_task"),
            payload: {
              call: {
                id: "call-goal-success",
                name: "update_thread_task",
                arguments: {
                  status: "complete",
                  summary: "按计划在三轮对话后标记完成。",
                },
              },
              result: {
                status: "success",
                ui_payload: {
                  task: {
                    id: "task-1",
                    type: "goal",
                    type_label: "目标",
                    status: "complete",
                  },
                },
              },
            },
          },
          message("m4", "assistant", "最终回复"),
        ]}
      />,
    );

    const blocks = screen.getAllByTestId("thread-task-status-block");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].getAttribute("data-state")).toBe("success");
    expect(blocks[0].textContent).toContain("目标已完成");
    expect(blocks[0].textContent).toContain("重试后成功");
    expect(blocks[0].textContent).not.toContain("目标状态更新失败");
    expect(blocks[0].textContent).not.toContain("第一轮输出两句话后等待");
  });

  it("exposes the requested density variant on the list root and scroll surface", () => {
    render(<MessageList messages={[]} variant="compact" />);

    expect(screen.getByTestId("message-list").getAttribute("data-message-list-variant")).toBe("compact");
    expect(screen.getByTestId("message-list-scroll").getAttribute("data-message-list-variant")).toBe("compact");
  });

  it("exposes the requested performance profile on the list root", () => {
    render(<MessageList messages={[]} performanceProfile="interactivePanel" />);

    expect(screen.getByTestId("message-list").getAttribute("data-performance-profile")).toBe("interactivePanel");
  });

  it("renders a turn navigator with hover summary and indexed turn jumping", async () => {
    render(
      <MessageList
        messages={[
          message("m1", "user", "第一轮问题"),
          message("m2", "assistant", "第一行\n第二行\n第三行\n第四行"),
          message("m3", "user", "第二轮问题"),
          message("m4", "assistant", "第二轮回答"),
        ]}
      />,
    );

    expect(screen.getByTestId("conversation-turn-navigator")).not.toBeNull();
    expect(screen.getByTestId("conversation-turn-navigator-viewport")).not.toBeNull();
    expect(screen.getByTestId("conversation-turn-navigator-count").textContent).toBe("2 turn");
    const markers = screen.getAllByRole("button", { name: /跳转到第 \d+ 轮/ });
    expect(markers).toHaveLength(2);
    expect(markers.map((marker) => marker.getAttribute("data-current"))).toEqual(["false", "false"]);

    fireEvent.focus(markers[0]);
    expect(markers[0].style.getPropertyValue("--turn-marker-width")).toBe("35px");

    fireEvent.blur(markers[0]);
    expect(markers[0].style.getPropertyValue("--turn-marker-width")).toBe("12px");

    fireEvent.focus(markers[1]);
    expect(screen.getByTestId("conversation-turn-navigator-card").textContent).toContain("第二轮问题");
    expect(screen.getByTestId("conversation-turn-navigator-card").textContent).toContain("第二轮回答");

    fireEvent.click(markers[1]);
    await waitFor(() => expect(markers[1].getAttribute("data-current")).toBe("true"));
  });

  it("does not crash when turn preview content is not a string", () => {
    const dirtyMessages = [
      {
        ...message("m1", "user", ""),
        content: [{ type: "text", text: "数组问题" }] as unknown as string,
      },
      {
        ...message("m2", "assistant", ""),
        content: { text: "对象回答" } as unknown as string,
      },
      message("m3", "user", "第二轮问题"),
      message("m4", "assistant", "第二轮回答"),
    ];

    render(
      <MessageList messages={dirtyMessages} />,
    );

    expect(screen.getAllByText("数组问题").length).toBeGreaterThan(0);
    expect(screen.getAllByText("对象回答").length).toBeGreaterThan(0);
    expect(screen.getByTestId("conversation-turn-navigator")).not.toBeNull();
    const markers = screen.getAllByRole("button", { name: /跳转到第 \d+ 轮/ });
    fireEvent.focus(markers[0]);
    expect(screen.getByTestId("conversation-turn-navigator-card").textContent).toContain("数组问题");
    expect(screen.getByTestId("conversation-turn-navigator-card").textContent).toContain("对象回答");
  });

  it("only fades turn navigator edges with hidden markers", async () => {
    render(
      <ConversationTurnNavigator
        turns={Array.from({ length: 8 }, (_, index) => ({
          id: `turn-${index + 1}`,
          targetIndex: index,
          userPreview: `第 ${index + 1} 轮问题`,
          assistantPreview: [`第 ${index + 1} 轮回答`],
        }))}
        highlightedIndexes={[]}
        onNavigate={vi.fn()}
      />,
    );

    const viewport = screen.getByTestId("conversation-turn-navigator-viewport") as HTMLDivElement;

    mockScrollMetrics(viewport, { scrollHeight: 240, clientHeight: 80, scrollTop: 0 });
    await act(async () => {
      fireEvent.scroll(viewport);
    });
    expect(viewport.getAttribute("data-scrollable")).toBe("true");
    expect(viewport.getAttribute("data-fade-top")).toBe("false");
    expect(viewport.getAttribute("data-fade-bottom")).toBe("true");

    mockScrollMetrics(viewport, { scrollHeight: 240, clientHeight: 80, scrollTop: 80 });
    await act(async () => {
      fireEvent.scroll(viewport);
    });
    expect(viewport.getAttribute("data-fade-top")).toBe("true");
    expect(viewport.getAttribute("data-fade-bottom")).toBe("true");

    mockScrollMetrics(viewport, { scrollHeight: 240, clientHeight: 80, scrollTop: 160 });
    await act(async () => {
      fireEvent.scroll(viewport);
    });
    expect(viewport.getAttribute("data-fade-top")).toBe("true");
    expect(viewport.getAttribute("data-fade-bottom")).toBe("false");
  });

  it("keeps an external turn navigation request until delayed content is mounted", async () => {
      const messages = [
        message("m1", "user", "第一轮问题"),
        message("m2", "assistant", "第一轮回答"),
        message("m3", "user", "第二轮问题"),
        message("m4", "assistant", "第二轮回答"),
      ];
      const request = { requestId: 1, targetIndex: 1 };
      const { rerender } = render(<MessageList messages={messages} loading turnNavigationRequest={request} />);

      expect(screen.queryByTestId("message-skeleton")).toBeNull();
      expect(screen.getAllByText("第一轮问题").length).toBeGreaterThan(0);
      expect(screen.getAllByRole("button", { name: /跳转到第 \d+ 轮/ })[1].getAttribute("data-current")).toBe("false");

      rerender(<MessageList messages={messages} turnNavigationRequest={request} />);

      await waitFor(() => {
        expect(screen.getAllByRole("button", { name: /跳转到第 \d+ 轮/ })[1].getAttribute("data-current")).toBe("true");
      });
  });

  it("navigates to a business turn index and flashes the target assistant message", async () => {
      render(
        <MessageList
          messages={[
            { ...message("m1", "user", "第一轮问题"), payload: { turnIndex: 1 } },
            { ...message("m2", "assistant", "第一轮回答"), payload: { turnIndex: 1 } },
            { ...message("m3", "user", "第二轮问题"), payload: { turnIndex: 2 } },
            { ...message("m4", "assistant", "第二轮回答"), payload: { turnIndex: 2 } },
          ]}
          turnNavigationRequest={{ requestId: 1, targetTurnIndex: 2, flash: true }}
        />,
      );

      await waitFor(() => {
        expect(screen.getByText("第二轮回答").closest('[data-kind="assistant"]')?.getAttribute("data-focus-flash")).toBe(
          "true",
        );
      });
  });

  it("highlights every static turn intersecting the visible viewport", async () => {
    render(
      <MessageList
        messages={[
          message("m1", "user", "第一轮问题"),
          message("m2", "assistant", "第一轮回答"),
          message("m3", "user", "第二轮问题"),
          message("m4", "assistant", "第二轮回答"),
          message("m5", "user", "第三轮问题"),
          message("m6", "assistant", "第三轮回答"),
          message("m7", "user", "第四轮问题"),
          message("m8", "assistant", "第四轮回答"),
        ]}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("message-list").getAttribute("data-tail-bootstrap")).toBe("committed");
    });

    const scroller = screen.getByTestId("message-list-scroll") as HTMLDivElement;
    const turns = screen.getAllByTestId("message-turn") as HTMLElement[];
    mockElementRect(scroller, { height: 100, top: 0 });
    [-80, -20, 20, 120].forEach((top, index) => mockElementTop(turns[index], top));

    mockScrollMetrics(scroller, { scrollHeight: 600, clientHeight: 100, scrollTop: 180 });
    await act(async () => {
      fireEvent.scroll(scroller);
    });

    let markers = screen.getAllByRole("button", { name: /跳转到第 \d+ 轮/ });
    expect(markers.map((marker) => marker.getAttribute("data-current"))).toEqual(["false", "true", "true", "false"]);

    mockScrollMetrics(scroller, { scrollHeight: 600, clientHeight: 100, scrollTop: 400 });
    [-160, -120, -20, 80].forEach((top, index) => mockElementTop(turns[index], top));
    await act(async () => {
      fireEvent.scroll(scroller);
    });

    markers = screen.getAllByRole("button", { name: /跳转到第 \d+ 轮/ });
    expect(markers.map((marker) => marker.getAttribute("data-current"))).toEqual(["false", "false", "true", "true"]);
  });

  it("updates native turn navigation without reconciling stable message units", async () => {
    const renderMessage = vi.fn((entry: ConversationMessage) => <span>{entry.content}</span>);
    render(<MessageList messages={historyMessages(4, "native-nav")} renderMessage={renderMessage} />);
    await waitFor(() => {
      expect(screen.getByTestId("message-list").getAttribute("data-tail-bootstrap")).toBe("committed");
    });
    const rendersBeforeScroll = renderMessage.mock.calls.length;
    const scroller = screen.getByTestId("message-list-scroll") as HTMLDivElement;
    const turns = screen.getAllByTestId("message-turn") as HTMLElement[];
    mockElementRect(scroller, { height: 100, top: 0 });
    [-80, -20, 20, 120].forEach((top, index) => mockElementTop(turns[index], top));
    mockScrollMetrics(scroller, { scrollHeight: 600, clientHeight: 100, scrollTop: 180 });

    await act(async () => {
      fireEvent.scroll(scroller);
    });

    expect(renderMessage).toHaveBeenCalledTimes(rendersBeforeScroll);
  });

  it("adds a new user turn without claiming it is visible before viewport confirmation", async () => {
    const initialMessages = [
      message("m1", "user", "第一轮问题"),
      message("m2", "assistant", "第一轮回答"),
      message("m3", "user", "第二轮问题"),
      message("m4", "assistant", "第二轮回答"),
    ];
    const { rerender } = render(<MessageList messages={initialMessages} />);

    rerender(<MessageList messages={[...initialMessages, message("m5", "user", "第三轮问题")]} isProcessing />);

    await waitFor(() => {
      const markers = screen.getAllByRole("button", { name: /跳转到第 \d+ 轮/ });
      expect(markers).toHaveLength(3);
      expect(markers[2].getAttribute("data-current")).toBe("false");
      expect(markers[2].getAttribute("data-entering")).toBe("true");
    });
  });

  it("hides the turn navigator by default in compact and overlay variants", () => {
    const messages = [
      message("m1", "user", "第一轮问题"),
      message("m2", "assistant", "第一轮回答"),
      message("m3", "user", "第二轮问题"),
      message("m4", "assistant", "第二轮回答"),
    ];
    const { rerender } = render(<MessageList messages={messages} variant="compact" />);

    expect(screen.getByTestId("message-list").getAttribute("data-turn-navigator")).toBe("false");
    expect(screen.queryByTestId("conversation-turn-navigator")).toBeNull();

    rerender(<MessageList messages={messages} variant="overlay" />);
    expect(screen.getByTestId("message-list").getAttribute("data-turn-navigator")).toBe("false");
    expect(screen.queryByTestId("conversation-turn-navigator")).toBeNull();

    rerender(<MessageList messages={messages} variant="compact" turnNavigatorMode="auto" />);
    expect(screen.getByTestId("message-list").getAttribute("data-turn-navigator")).toBe("true");
    expect(screen.getByTestId("conversation-turn-navigator")).not.toBeNull();
  });

  it("keeps compact and overlay density attributes through empty and loading states", () => {
    const { rerender } = render(<MessageList messages={[]} variant="compact" loading />);

    expect(screen.getByTestId("message-list").getAttribute("data-message-list-variant")).toBe("compact");
    expect(screen.getByTestId("message-list-scroll").getAttribute("data-message-list-variant")).toBe("compact");
    expect(screen.getByTestId("message-skeleton")).not.toBeNull();

    rerender(<MessageList messages={[]} variant="overlay" emptyText="覆盖层暂无消息" />);

    expect(screen.getByTestId("message-list").getAttribute("data-message-list-variant")).toBe("overlay");
    expect(screen.getByTestId("message-list-scroll").getAttribute("data-message-list-variant")).toBe("overlay");
    expect(screen.getByTestId("message-empty").textContent).toBe("覆盖层暂无消息");
    expect(screen.getByTestId("message-list").getAttribute("data-turn-navigator")).toBe("false");
  });

  it("keeps an ordinary compact streaming conversation on the native renderer", () => {
    const originalResizeObserver = globalThis.ResizeObserver;
    const originalUserAgent = navigator.userAgent;
    class FakeResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }

    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      value: FakeResizeObserver,
    });
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      value: "Mozilla/5.0 Chrome",
    });

    try {
      render(<MessageList messages={[message("m1", "assistant", "流式内容")]} isProcessing />);

      expect(screen.getByTestId("message-list").getAttribute("data-list-mode")).toBe("native");
      expect(screen.getByTestId("message-list-scroll").getAttribute("data-conversation-native-timeline")).toBe("true");
      expect(screen.queryByTestId("conversation-scroll-rail")).toBeNull();
    } finally {
      Object.defineProperty(navigator, "userAgent", {
        configurable: true,
        value: originalUserAgent,
      });
      if (originalResizeObserver) {
        Object.defineProperty(globalThis, "ResizeObserver", {
          configurable: true,
          value: originalResizeObserver,
        });
      } else {
        delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
      }
    }
  });

  it("returns every mounted virtual turn intersecting the visible viewport", () => {
    const scroller = document.createElement("div");
    mockElementRect(scroller, { top: 0, height: 220 });
    mockScrollMetrics(scroller, { scrollHeight: 3200, clientHeight: 220, scrollTop: 960 });
    [-360, -20, 40, 220].forEach((top, index) => {
      const turn = document.createElement("div");
      turn.dataset.testid = "message-turn";
      turn.setAttribute("data-testid", "message-turn");
      turn.dataset.turnIndex = String(20 + index);
      turn.dataset.index = String(20 + index);
      mockElementTop(turn, top);
      scroller.appendChild(turn);
    });

    expect(Array.from(visibleTurnIndexesFromMountedTurns(scroller, 72))).toEqual([21, 22]);
  });

  it("requests older history when the static list is scrolled into the top buffer", async () => {
    const onLoadOlder = vi.fn();
    render(
      <MessageList
        messages={[message("m1", "user", "hello"), message("m2", "assistant", "world")]}
        hasMoreOlder
        onLoadOlder={onLoadOlder}
      />,
    );

    const scroller = screen.getByTestId("message-list-scroll") as HTMLDivElement;
    mockScrollMetrics(scroller, { scrollHeight: 900, clientHeight: 300, scrollTop: 180 });
    await act(async () => {
      fireEvent.scroll(scroller);
    });
    expect(onLoadOlder).not.toHaveBeenCalled();

    mockScrollMetrics(scroller, { scrollHeight: 900, clientHeight: 300, scrollTop: 24 });
    await act(async () => {
      fireEvent.scroll(scroller);
    });

    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  it("does not request older history on initial top layout before the list is armed", async () => {
    const onLoadOlder = vi.fn();
    render(
      <MessageList
        messages={[message("m1", "user", "hello"), message("m2", "assistant", "world")]}
        hasMoreOlder
        onLoadOlder={onLoadOlder}
      />,
    );

    const scroller = screen.getByTestId("message-list-scroll") as HTMLDivElement;
    mockScrollMetrics(scroller, { scrollHeight: 900, clientHeight: 300, scrollTop: 0 });
    await act(async () => {
      fireEvent.scroll(scroller);
    });

    expect(onLoadOlder).not.toHaveBeenCalled();
  });

  it("loads relative markdown images through the session workspace scope", async () => {
    vi.stubGlobal("Image", AutoLoadingImage);
    const readMedia = vi.fn().mockResolvedValue({
      path: "assets/pixel.png",
      media_type: "image/png",
      size: 68,
      data_url: "data:image/png;base64,abc",
    });
    const runtime = fakeRuntime(readMedia);

    render(
      <MessageList
        messages={[message("m1", "assistant", "![项目图](assets/pixel.png)")]}
        workspaceRuntime={runtime}
        workspaceScope={{ sessionId: "ses-1" }}
      />,
    );

    const image = (await screen.findByAltText("项目图")) as HTMLImageElement;
    await waitFor(() => {
      expect(image.getAttribute("src")).toBe("data:image/png;base64,abc");
    });
    expect(readMedia).toHaveBeenCalledWith({ sessionId: "ses-1" }, "assets/pixel.png");
  });

  it("shows a readable failure state for relative markdown images without workspace scope", async () => {
    vi.stubGlobal("Image", AutoLoadingImage);
    const readMedia = vi.fn();

    render(<MessageList messages={[message("m1", "assistant", "![项目图](assets/pixel.png)")]} />);

    const fallback = await screen.findByRole("img", { name: "项目图" });
    expect(fallback.textContent).toContain("项目图");
    expect((screen.getByAltText("项目图") as HTMLImageElement).dataset.markdownImageState).toBe("failed");
    expect((screen.getByAltText("项目图") as HTMLImageElement).hidden).toBe(true);
    expect(readMedia).not.toHaveBeenCalled();
  });

  it("shows assistant copy row only on the last assistant text in a turn", () => {
    render(
      <MessageList
        messages={[
          message("m1", "user", "开始"),
          message("m2", "assistant", "第一段"),
          message("m3", "assistant", "第二段"),
        ]}
      />,
    );

    const textMessages = screen.getAllByTestId("message-text");
    expect(within(textMessages[1]).queryByRole("button", { name: "复制消息" })).toBeNull();
    expect(within(textMessages[2]).queryByRole("button", { name: "复制消息" })).toBeNull();
    const assistantFooter = screen.getByTestId("message-turn-footer");
    expect(turnIndexFor(assistantFooter)).toBe(turnIndexFor(textMessages[2]));
    expect(within(assistantFooter).getByRole("button", { name: "复制消息" })).not.toBeNull();
    expect(screen.getAllByRole("button", { name: "复制消息" })).toHaveLength(2);
  });

  it("shows the assistant copy row at the bottom of a trailing tool activity group", () => {
    render(
      <MessageList
        messages={[
          message("m1", "user", "开始"),
          message("m2", "assistant", "最后一条文字"),
          toolMessage("t1", "read_file", { path: "docs/a.md" }),
          commandMessage("c1"),
        ]}
      />,
    );

    const textMessages = screen.getAllByTestId("message-text");
    expect(within(textMessages[1]).queryByRole("button", { name: "复制消息" })).toBeNull();
    const assistantFooter = screen.getByTestId("message-turn-footer");
    expect(turnIndexFor(assistantFooter)).toBe(turnIndexFor(screen.getByTestId("message-group-block")));
    expect(within(assistantFooter).getByRole("button", { name: "复制消息" })).not.toBeNull();
    expect(screen.getAllByRole("button", { name: "复制消息" })).toHaveLength(2);
  });

  it("shows the assistant copy row at the bottom of a trailing file change block", () => {
    render(
      <MessageList
        messages={[
          message("m1", "user", "开始"),
          message("m2", "assistant", "最后一条文字"),
          fileChangeMessage("f1", "docs/a.md"),
        ]}
      />,
    );

    const textMessages = screen.getAllByTestId("message-text");
    expect(within(textMessages[1]).queryByRole("button", { name: "复制消息" })).toBeNull();
    const assistantFooter = screen.getByTestId("message-turn-footer");
    expect(turnIndexFor(assistantFooter)).toBe(turnIndexFor(screen.getByTestId("file-change-block")));
    expect(within(assistantFooter).getByRole("button", { name: "复制消息" })).not.toBeNull();
    expect(screen.getAllByRole("button", { name: "复制消息" })).toHaveLength(2);
  });

  it("hides the final assistant copy row while the turn is still processing", () => {
    render(
      <MessageList
        messages={[message("m1", "user", "开始"), message("m2", "assistant", "处理中但已落一段")]}
        isProcessing
      />,
    );

    expect(screen.getAllByRole("button", { name: "复制消息" })).toHaveLength(1);
  });

  it("keeps a 5,000-turn navigator marker DOM bounded", () => {
    render(
      <ConversationTurnNavigator
        turns={Array.from({ length: 5_000 }, (_, index) => ({
          id: `bounded-turn-${index}`,
          targetIndex: index,
          userPreview: `问题 ${index}`,
          assistantPreview: [`回答 ${index}`],
        }))}
        highlightedIndexes={[4_999]}
        onNavigate={vi.fn()}
      />,
    );

    expect(screen.getByTestId("conversation-turn-navigator-count").textContent).toBe("5000 turn");
    expect(Number(screen.getByTestId("conversation-turn-navigator-rendered-count").textContent)).toBeLessThan(100);
    expect(document.querySelectorAll("button[aria-label^='跳转到第']").length).toBeLessThan(100);
  });

  it("shows a live turn duration below the active assistant turn", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T08:01:05.000Z"));
    const runningAssistant = {
      ...at(message("m2", "assistant", "正在处理"), "2026-07-10T08:00:00.000Z"),
      status: "running" as const,
    };
    const { unmount } = render(
      <MessageList
        messages={[message("m1", "user", "开始"), runningAssistant]}
        isProcessing
      />,
    );

    try {
      await act(async () => undefined);
      const duration = screen.getByTestId("turn-processing-time");
      expect(duration.textContent).toBe("已处理 1分5秒");
      expect(duration.getAttribute("data-live")).toBe("true");
      expect(turnIndexFor(duration)).toBe(turnIndexFor(screen.getByText("正在处理")));

      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      expect(duration.textContent).toBe("已处理 1分6秒");
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });

  it("starts the live turn duration when the first agent output is a tool call", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T08:00:12.000Z"));
    const runningTool = {
      ...at(toolMessage("t1", "read_file", { path: "README.md" }), "2026-07-10T08:00:05.000Z"),
      status: "running" as const,
    };
    const { unmount } = render(
      <MessageList
        messages={[message("m1", "user", "读取文件"), runningTool]}
        isProcessing
        turnFirstTokenAtMs={new Date("2026-07-10T08:00:00.000Z").getTime()}
      />,
    );

    try {
      await act(async () => undefined);
      expect(screen.getByTestId("turn-processing-time").textContent).toBe("已处理 12秒");
      expect(turnIndexFor(screen.getByTestId("turn-processing-time"))).toBe(
        turnIndexFor(screen.getByText("读取文件")),
      );
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });

  it("keeps the frozen turn duration first and separates the hover-only footer details", () => {
    const assistant = {
      ...message("m2", "assistant", "处理完成"),
      payload: { turnDurationMs: 3_723_000 },
    };
    render(<MessageList messages={[message("m1", "user", "开始"), assistant]} />);

    const duration = screen.getByTestId("turn-processing-time");
    const footer = duration.closest('footer[data-placement="turn"]');
    const footerDetails = footer?.querySelector('[data-turn-footer-details="true"]');
    expect(duration.textContent).toBe("已处理 1小时2分3秒");
    expect(duration.getAttribute("data-live")).toBe("false");
    expect(footer).not.toBeNull();
    expect(footer?.firstElementChild).toBe(duration);
    expect(footerDetails).not.toBeNull();
    expect(footerDetails?.contains(duration)).toBe(false);
    expect(within(footerDetails as HTMLElement).getByRole("button", { name: "复制消息" })).not.toBeNull();
    expect(footerDetails?.querySelector("time")).not.toBeNull();
  });

  it("shows sub-second frozen turn durations in milliseconds", async () => {
    const assistant = {
      ...message("m2", "assistant", "你好"),
      payload: { turnDurationMs: 286 },
    };
    const { rerender } = render(<MessageList messages={[message("m1", "user", "你好"), assistant]} />);

    expect(screen.getByTestId("turn-processing-time").textContent).toBe("已处理 286毫秒");

    rerender(
      <MessageList
        messages={[
          message("m1", "user", "你好"),
          { ...assistant, payload: { turnDurationMs: 3_700 } },
        ]}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("turn-processing-time").textContent).toBe("已处理 3秒"));

    rerender(
      <MessageList
        messages={[
          message("m1", "user", "你好"),
          { ...assistant, payload: { turnDurationMs: 93_784_000 } },
        ]}
      />,
    );
    await waitFor(() => expect(screen.getByTestId("turn-processing-time").textContent).toBe("已处理 1天2小时3分4秒"));
  });

  it("keeps the duration live until a waiting turn reaches a terminal state", () => {
    const startedAt = new Date(Date.now() - 5_000).toISOString();
    render(
      <MessageList
        messages={[
          message("m1", "user", "开始"),
          at(message("m2", "assistant", "请确认后继续"), startedAt),
        ]}
        runtimeState="waiting_approval"
      />,
    );

    expect(screen.getByTestId("turn-processing-time").getAttribute("data-live")).toBe("true");
    expect(screen.getAllByRole("button", { name: "复制消息" })).toHaveLength(1);
  });

  it("hides all assistant copy rows in the active turn until completion", () => {
    render(
      <MessageList
        messages={[
          message("m1", "user", "上一轮"),
          message("m2", "assistant", "上一轮回答"),
          message("m3", "user", "当前轮"),
          message("m4", "assistant", "第一段"),
          toolMessage("t1"),
          message("m5", "assistant", "第二段"),
        ]}
        isProcessing
      />,
    );

    const textMessages = screen.getAllByTestId("message-text");
    expect(within(textMessages[1]).queryByRole("button", { name: "复制消息" })).toBeNull();
    const previousTurnFooter = screen.getAllByTestId("message-turn-footer").find(
      (footer) => turnIndexFor(footer) === turnIndexFor(textMessages[1]),
    );
    expect(previousTurnFooter).toBeDefined();
    expect(within(previousTurnFooter as HTMLElement).getByRole("button", { name: "复制消息" })).not.toBeNull();
    expect(within(textMessages[3]).queryByRole("button", { name: "复制消息" })).toBeNull();
    expect(within(textMessages[4]).queryByRole("button", { name: "复制消息" })).toBeNull();
  });

  it("shows a pending assistant cursor while processing before the next stream chunk", () => {
    const { rerender } = render(<MessageList messages={[message("m1", "user", "开始")]} isProcessing />);

    const pendingCursor = screen.getByTestId("streaming-cursor");
    expect(pendingCursor.hidden).toBe(false);
    expect(pendingCursor.querySelectorAll('[data-streaming-cursor-dot="true"]')).toHaveLength(3);

    rerender(
      <MessageList
        messages={[
          message("m1", "user", "开始"),
          { ...message("m2", "assistant", "正在输出"), status: "running" },
        ]}
        isProcessing
      />,
    );
    expect(screen.getAllByTestId("streaming-cursor")).toHaveLength(1);

    rerender(
      <MessageList
        messages={[
          message("m1", "user", "开始"),
          message("m2", "assistant", "已落一段"),
          toolMessage("t1"),
        ]}
        isProcessing
      />,
    );
    expect(screen.getByTestId("streaming-cursor")).not.toBeNull();
  });

  it("does not append a second pending cursor while a file change is streaming", () => {
    const { rerender } = render(
      <MessageList
        messages={[
          message("m1", "user", "开始"),
          { ...message("m2", "assistant", "没问题，直接重新创建："), status: "running" },
          { ...fileChangeMessage("file-change-running", "docs/project-structure.md", "add"), status: "running" },
        ]}
        isProcessing
      />,
    );

    expect(screen.getAllByTestId("streaming-cursor")).toHaveLength(1);
    const assistantMessage = screen.getAllByTestId("message-text")[1];
    expect(within(assistantMessage).queryByTestId("streaming-cursor")).toBeNull();
    expect(turnIndexFor(screen.getByTestId("streaming-cursor"))).toBe(
      turnIndexFor(screen.getByTestId("file-change-block")),
    );

    rerender(
      <MessageList
        messages={[
          message("m1", "user", "开始"),
          { ...message("m2", "assistant", "没问题，直接重新创建："), status: "running" },
          fileChangeMessage("file-change-completed", "docs/project-structure.md", "add"),
        ]}
        isProcessing
      />,
    );

    expect(screen.getAllByTestId("streaming-cursor")).toHaveLength(1);
    expect(turnIndexFor(screen.getByTestId("streaming-cursor"))).toBe(
      turnIndexFor(screen.getByTestId("file-change-block")),
    );
  });

  it("summarizes consecutive tool messages and expands original blocks on demand", () => {
    render(<MessageList messages={[toolMessage("t1"), commandMessage("c1")]} />);

    expect(screen.getByTestId("message-group-block")).not.toBeNull();
    expect(screen.getByText("读取了 1 个文件，已运行 1 条命令")).not.toBeNull();
    expect(screen.queryByText("已执行 2 个工具步骤")).toBeNull();
    expect(screen.queryByText("2 步")).toBeNull();
    expect(screen.queryByLabelText("步骤摘要")).toBeNull();
    expect(screen.queryByText("read_file")).toBeNull();
    expect(screen.queryByText("pytest backend/tests")).toBeNull();
    expect(screen.queryByText(/"path": "README\.md"/)).toBeNull();
    expect(screen.queryByText("文件内容")).toBeNull();
    expect(screen.queryByTestId("tool-call-block")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "读取了 1 个文件，已运行 1 条命令详情" }));

    expect(screen.getByTestId("tool-call-block")).not.toBeNull();
    expect(screen.getByTestId("command-execution-block")).not.toBeNull();
    expect(screen.getByText("已读取文件 README.md")).not.toBeNull();
    expect(screen.getByText("已执行 pytest backend/tests")).not.toBeNull();
    expect(screen.queryByText(/"path": "README\.md"/)).toBeNull();
    expect(screen.queryByText("文件内容")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "展开工具详情" }));
    expect(screen.getByLabelText("工具入参").textContent).toContain('"path": "README.md"');
    expect(screen.getByText("文件内容")).not.toBeNull();
  });

  it("shows aggregated edit deltas on grouped tool activity", () => {
    const firstEdit = fileEditToolMessage("edit-1", "src/main.py", 4, 2, "running");
    const secondEdit = fileEditToolMessage("edit-2", "src/app.py", 5, 1);
    render(<MessageList messages={[firstEdit, secondEdit]} />);

    const group = screen.getByTestId("message-group-block");
    expect(screen.getByText("正在编辑 1 个文件，编辑了 1 个文件")).not.toBeNull();
    expect(within(group).getByTestId("line-change-ticker").textContent).toContain("+9");
    expect(within(group).getByTestId("line-change-ticker").textContent).toContain("-3");
    expect(within(group).getByTestId("line-change-ticker").textContent).not.toContain("行");
    expect(screen.queryByTestId("tool-call-block")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "正在编辑 1 个文件，编辑了 1 个文件详情" }));

    expect(screen.getAllByTestId("tool-call-block")).toHaveLength(2);
    expect(within(group).getAllByTestId("line-change-ticker")).toHaveLength(3);
    expect(screen.getByText("正在编辑文件")).not.toBeNull();
    expect(screen.getByText("已编辑文件")).not.toBeNull();
  });

  it("summarizes mixed tool activity by natural-language tool categories", () => {
    render(
      <MessageList
        messages={[
          toolMessage("read-1", "read_file", { path: "README.md" }),
          toolMessage("read-2", "read_file", { path: "src/main.ts" }),
          toolMessage("dir-1", "list_directory", { path: "src" }),
          toolMessage("search-1", "search_files", { query: "agent" }),
          commandMessage("cmd-1"),
        ]}
      />,
    );

    expect(screen.getByText("读取了 2 个文件，查看了 1 个目录，已搜索文件 1 次，已运行 1 条命令")).not.toBeNull();
    expect(screen.queryByText(/工具步骤/)).toBeNull();
    expect(screen.queryByText("5 步")).toBeNull();
    expect(screen.queryByText("read_file")).toBeNull();
  });

  it("keeps grouped tool details expanded when new tools are appended", () => {
    const firstTool = toolMessage("read-1", "read_file", { path: "README.md" });
    const command = commandMessage("cmd-1");
    const { rerender } = render(<MessageList messages={[firstTool, command]} />);

    const initialButton = screen.getByRole("button", { name: "读取了 1 个文件，已运行 1 条命令详情" });
    fireEvent.click(initialButton);

    expect(initialButton.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("tool-call-block")).not.toBeNull();
    expect(screen.getByTestId("command-execution-block")).not.toBeNull();

    rerender(
      <MessageList
        messages={[
          firstTool,
          command,
          toolMessage("read-2", "read_file", { path: "src/main.ts" }),
        ]}
      />,
    );

    const updatedButton = screen.getByRole("button", { name: "读取了 2 个文件，已运行 1 条命令详情" });
    expect(updatedButton.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByTestId("tool-call-block")).toHaveLength(2);
    expect(screen.getByTestId("command-execution-block")).not.toBeNull();
  });

  it("keeps grouped tool details expanded when a terminal marker is appended to the same turn", () => {
    const firstTool = toolMessage("read-1", "read_file", { path: "README.md" });
    const command = commandMessage("cmd-1");
    const { rerender } = render(<MessageList messages={[firstTool, command]} />);

    const initialButton = screen.getByRole("button", { name: "读取了 1 个文件，已运行 1 条命令详情" });
    fireEvent.click(initialButton);

    expect(initialButton.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("tool-call-block")).not.toBeNull();

    rerender(
      <MessageList
        messages={[
          firstTool,
          command,
          {
            ...message("cancel-1", "cancelled", ""),
            status: "cancelled",
            payload: { cancelled: true },
          },
        ]}
      />,
    );

    const updatedButton = screen.getByRole("button", { name: "读取了 1 个文件，已运行 1 条命令详情" });
    expect(updatedButton.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("tool-call-block")).not.toBeNull();
    expect(screen.getByTestId("conversation-cancelled-notice").textContent).toBe("对话已取消");
  });

  it("keeps the grouped tool header anchored while details expand near the top", () => {
    render(
      <div data-testid="message-list-scroll">
        <MessageGroupBlock
          count={2}
          groupKind="tool_activity"
          messages={[toolMessage("t1"), commandMessage("c1")]}
          sourceMessageIds={["t1", "c1"]}
        >
          <div>工具明细</div>
        </MessageGroupBlock>
      </div>,
    );

    const scroller = screen.getByTestId("message-list-scroll") as HTMLDivElement;
    const toggle = screen.getByRole("button", { name: "读取了 1 个文件，已运行 1 条命令详情" });
    mockScrollMetrics(scroller, { scrollHeight: 1200, clientHeight: 360, scrollTop: 160 });
    mockElementTop(scroller, 0);
    mockElementTopSequence(toggle, [90, 42]);

    fireEvent.click(toggle);

    expect(scroller.scrollTop).toBe(112);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("uses failure wording for grouped tools with error results", () => {
    render(
      <MessageList
        messages={[
          {
            ...toolMessage("read-failed", "read_file", { path: "missing.txt" }),
            payload: {
              call: {
                id: "call-read-failed",
                name: "read_file",
                arguments: { path: "missing.txt" },
              },
              result: {
                status: "error",
                error: "文件不存在",
              },
            },
          },
          {
            ...commandMessage("cmd-failed"),
            payload: {
              command: "pytest backend/tests",
              cwd: "D:/repo",
              stderr: "failed",
              exit_code: 1,
            },
          },
        ]}
      />,
    );

    expect(screen.getByText("读取失败 1 个文件，运行失败 1 条命令")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "读取失败 1 个文件，运行失败 1 条命令详情" }));
    expect(screen.getByText("读取文件失败 missing.txt")).not.toBeNull();
  });

  it("separates failed and successful counts inside grouped tool categories", () => {
    render(
      <MessageList
        messages={[
          failedToolMessage("read-failed", "read_file", { path: "missing.txt" }),
          toolMessage("read-ok", "read_file", { path: "README.md" }),
          failedToolMessage("dir-failed", "list_directory", { path: "/" }),
          toolMessage("dir-ok-1", "list_directory", { path: "src" }),
          toolMessage("dir-ok-2", "list_directory", { path: "docs" }),
          failedToolMessage("search-failed", "search_files", { query: "missing" }),
          toolMessage("search-ok", "search_files", { query: "agent" }),
          {
            ...commandMessage("cmd-failed"),
            payload: {
              command: "pytest backend/tests",
              cwd: "D:/repo",
              stderr: "failed",
              exit_code: 1,
            },
          },
          commandMessage("cmd-ok"),
          failedToolMessage("edit-failed", "write_file", { path: "bad.ts" }),
          toolMessage("edit-ok", "write_file", { path: "good.ts" }),
          failedToolMessage("other-failed", "unknown_tool", { path: "bad" }),
          toolMessage("other-ok", "unknown_tool", { path: "ok" }),
        ]}
      />,
    );

    expect(
      screen.getByText(
        "读取失败 1 个文件，读取了 1 个文件，查看失败 1 个目录，查看了 2 个目录，搜索文件失败 1 次，已搜索文件 1 次，运行失败 1 条命令，已运行 1 条命令，创建失败 1 个文件，创建了 1 个文件，调用失败 1 个工具，调用了 1 个工具",
      ),
    ).not.toBeNull();
    expect(screen.queryByText(/查看失败 3 个目录/)).toBeNull();
  });

  it("keeps failed search_files and create_file panels available inside grouped tools", () => {
    render(
      <MessageList
        messages={[
          failedToolMessage("search-failed", "search_files", { query: "README" }),
          failedToolMessage("create-failed", "create_file", { path: "test.txt", content: "hello" }),
        ]}
      />,
    );

    expect(screen.getByRole("button", { name: "搜索文件失败 1 次，创建失败 1 个文件详情" })).not.toBeNull();
    expect(screen.queryByTestId("tool-call-block")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "搜索文件失败 1 次，创建失败 1 个文件详情" }));

    const toolBlocks = screen.getAllByTestId("tool-call-block");
    expect(toolBlocks).toHaveLength(2);
    expect(screen.getByText("搜索文件失败 README")).not.toBeNull();
    expect(toolBlocks[1].textContent).toContain("创建文件失败 test.txt");
    expect(screen.getAllByText("错误信息：失败")).toHaveLength(2);
  });

  it("groups grep_files as search activity", () => {
    render(
      <MessageList
        messages={[
          toolMessage("grep-1", "grep_files", { query: "needle" }),
          toolMessage("grep-2", "grep_files", { query: "other" }),
        ]}
      />,
    );

    expect(screen.getByRole("button", { name: "已搜索文件 2 次详情" })).not.toBeNull();
  });

  it("groups search_text as content search activity", () => {
    render(
      <MessageList
        messages={[
          toolMessage("search-text-1", "search_text", { query: "needle" }),
          toolMessage("search-text-2", "search_text", { query: "other" }),
        ]}
      />,
    );

    expect(screen.getByRole("button", { name: "已搜索内容 2 次详情" })).not.toBeNull();
  });

  it("identifies grouped MCP tool activity", () => {
    render(
      <MessageList
        messages={[
          mcpToolMessage("mcp-1", "search"),
          mcpToolMessage("mcp-2", "write"),
        ]}
      />,
    );

    expect(screen.getByRole("button", { name: "调用了 2 个 MCP 工具详情" })).not.toBeNull();
    expect(screen.getByTestId("message-group-block").querySelector("[data-icon-kind]")?.getAttribute("data-icon-kind")).toBe("mcp");
    expect(screen.queryByTestId("tool-call-block")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "调用了 2 个 MCP 工具详情" }));
    expect(screen.getAllByTestId("tool-call-block")).toHaveLength(2);
    expect(screen.getByText("MCP · Ticket MCP · search")).not.toBeNull();
    expect(screen.getByText("MCP · Ticket MCP · write")).not.toBeNull();
  });

  it("uses the concrete tool icon for grouped activity with one tool category", () => {
    render(
      <MessageList
        messages={[
          toolMessage("read-1", "read_file", { path: "README.md" }),
          toolMessage("read-2", "read_file", { path: "src/main.ts" }),
        ]}
      />,
    );

    expect(screen.getByTestId("message-group-block").querySelector("[data-icon-kind]")?.getAttribute("data-icon-kind")).toBe("read");
  });

  it("keeps the check icon for grouped activity with mixed tool categories", () => {
    render(
      <MessageList
        messages={[
          toolMessage("read-1", "read_file", { path: "README.md" }),
          toolMessage("search-1", "search_files", { query: "agent" }),
          commandMessage("cmd-1"),
        ]}
      />,
    );

    expect(screen.getByTestId("message-group-block").querySelector("[data-icon-kind]")?.getAttribute("data-icon-kind")).toBe("done");
  });

  it("renders compact file-change summaries before expanding details", () => {
    render(<MessageList messages={[fileChangeMessage("file-change-1", "src/main.py"), fileChangeMessage("file-change-2", "src/app.py")]} />);

    expect(screen.getByText("编辑了 2 个文件")).not.toBeNull();
    expect(screen.queryByLabelText("步骤摘要")).toBeNull();
    expect(screen.queryByText("src/main.py")).toBeNull();
    expect(screen.queryByText("+1 -0")).toBeNull();
    expect(screen.queryByTestId("file-change-block")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "编辑了 2 个文件详情" }));

    expect(screen.getAllByTestId("file-change-block")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "src/main.py" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "src/app.py" })).not.toBeNull();
    expect(screen.getAllByTestId("line-change-ticker")).toHaveLength(2);
  });

  it("labels grouped created file changes separately from edits", () => {
    render(
      <MessageList
        messages={[
          fileChangeMessage("file-create-1", "src/new.ts", "add"),
          fileChangeMessage("file-create-2", "src/other.ts", "add"),
        ]}
      />,
    );

    expect(screen.getByText("创建了 2 个文件")).not.toBeNull();
    expect(screen.queryByText("编辑了 2 个文件")).toBeNull();
    expect(screen.getByTestId("message-group-block").querySelector("[data-icon-kind]")?.getAttribute("data-icon-kind")).toBe("create");
  });

  it("uses concrete add operation when grouping apply_patch file creations", () => {
    render(
      <MessageList
        messages={[
          fileChangeMessage("file-patch-add-1", "src/new.ts", "add", "apply_patch"),
          fileChangeMessage("file-patch-add-2", "src/other.ts", "add", "apply_patch"),
        ]}
      />,
    );

    expect(screen.getByText("创建了 2 个文件")).not.toBeNull();
    expect(screen.queryByText("编辑了 2 个文件")).toBeNull();
    expect(screen.getByTestId("message-group-block").querySelector("[data-icon-kind]")?.getAttribute("data-icon-kind")).toBe("create");
  });

  it("groups moved file changes with move wording", () => {
    render(
      <MessageList
        messages={[
          fileChangeMessage("file-move-1", "src/new.ts", "move", "move_file"),
          fileChangeMessage("file-move-2", "src/other.ts", "move", "move_file"),
        ]}
      />,
    );

    expect(screen.getByText("移动了 2 个文件")).not.toBeNull();
    expect(screen.queryByText("编辑了 2 个文件")).toBeNull();
    expect(screen.getByTestId("message-group-block").querySelector("[data-icon-kind]")?.getAttribute("data-icon-kind")).toBe("move");
  });

  it("separates failed and successful file-change counts", () => {
    render(
      <MessageList
        messages={[
          { ...fileChangeMessage("file-change-failed", "bad.ts"), status: "failed" },
          fileChangeMessage("file-change-ok", "good.ts"),
        ]}
      />,
    );

    expect(screen.getByText("编辑失败 1 个文件，编辑了 1 个文件")).not.toBeNull();
    expect(screen.queryByText("编辑失败 2 个文件")).toBeNull();
  });

  it("does not render update_plan in the main message list", () => {
    render(<MessageList messages={[planMessage()]} />);

    expect(screen.queryByTestId("message-plan")).toBeNull();
    expect(screen.queryByText("补充 AionUi 计划展示")).toBeNull();
    expect(screen.getByTestId("message-empty").textContent).toBe("暂无消息");
  });

  it("passes file preview callbacks into file change blocks", () => {
    const onFilePreview = vi.fn();
    render(<MessageList messages={[fileChangeMessage()]} onFilePreview={onFilePreview} />);

    fireEvent.click(screen.getByRole("button", { name: "展开文件变更详情" }));
    expect(screen.getByLabelText("文件变更预览")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "src/main.py" }));

    expect(onFilePreview).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "src/main.py",
        diff: "@@\n+hello",
        files: [expect.objectContaining({ path: "src/main.py" })],
        message: expect.objectContaining({ id: "file-change-1" }),
        title: "编辑了 1 个文件",
      }),
    );
  });

  it("follows the bottom when new messages arrive", () => {
    const first = message("m1", "assistant", "第一段");
    const second = message("m2", "assistant", "第二段");
    const { rerender } = render(<MessageList messages={[first]} />);
    const scroller = screen.getByTestId("message-list-scroll") as HTMLDivElement;
    mockScrollMetrics(scroller, { scrollHeight: 1000, clientHeight: 200, scrollTop: 800 });

    rerender(<MessageList messages={[first, second]} />);

    expect(scroller.scrollTop).toBe(800);
  });

  it("pins the static list to the bottom before the first paint", () => {
    const scrollHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    const clientHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => 1000 });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 200 });

    try {
      render(<MessageList messages={[message("history-1", "assistant", "历史消息")]} />);
      expect(screen.getByTestId("message-list-scroll").scrollTop).toBe(800);
    } finally {
      restorePrototypeDescriptor("scrollHeight", scrollHeightDescriptor);
      restorePrototypeDescriptor("clientHeight", clientHeightDescriptor);
    }
  });

  it("does not force scroll when the user has scrolled up", async () => {
    const first = message("m1", "assistant", "第一段");
    const second = message("m2", "assistant", "第二段");
    const { rerender } = render(<MessageList messages={[first]} />);
    const scroller = screen.getByTestId("message-list-scroll") as HTMLDivElement;
    await waitFor(() => expect(screen.getByTestId("message-list").getAttribute("data-tail-bootstrap")).toBe("committed"));
    mockScrollMetrics(scroller, { scrollHeight: 1000, clientHeight: 200, scrollTop: 120 });

    fireEvent.wheel(scroller, { deltaY: -120 });
    fireEvent.scroll(scroller);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "滚动到底" })).not.toBeNull();
    });

    rerender(<MessageList messages={[first, second]} />);
    expect(scroller.scrollTop).toBe(120);

    fireEvent.click(screen.getByRole("button", { name: "滚动到底" }));
    await waitFor(() => {
      expect(scroller.scrollTop).toBe(timelineBottom(scroller));
    });
  });

  it.each([2, 59])("commits a %i-turn history at the physical timeline bottom", async (turnCount) => {
    const scrollHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    const clientHeightDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get(this: HTMLElement) {
        if (this.dataset.messageListScroll !== "true") return 0;
        return Number(
          this.querySelector<HTMLElement>("[data-conversation-timeline-total-height]")
            ?.dataset.conversationTimelineTotalHeight ?? 0,
        );
      },
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return this.dataset.messageListScroll === "true" ? 600 : 0;
      },
    });
    const history = Array.from({ length: turnCount }, (_, index) => [
      { ...message(`history-user-${index}`, "user", `question-${index}`), turnId: `turn-${index}` },
      { ...message(`history-assistant-${index}`, "assistant", `answer-${index}`), turnId: `turn-${index}` },
    ]).flat();

    try {
      render(<MessageList messages={history} />);
      const scroller = screen.getByTestId("message-list-scroll") as HTMLElement;
      await waitFor(() => {
        expect(screen.getByTestId("message-list").getAttribute("data-tail-bootstrap")).toBe("committed");
      });
      expect(screen.getByTestId("message-list").getAttribute("data-list-mode")).toBe("native");
      expect(scroller.getAttribute("data-conversation-native-timeline")).toBe("true");
      expect(screen.queryByTestId("conversation-scroll-rail")).toBeNull();
      expect(scroller.scrollTop).toBe(timelineBottom(scroller));
      expect(scroller.querySelector(`[data-turn-index="${turnCount - 1}"]`)).not.toBeNull();
      expect(scroller.querySelector(`[data-conversation-unit-id="unit:footer:history-assistant-${turnCount - 1}"]`))
        .not.toBeNull();
    } finally {
      restorePrototypeDescriptor("scrollHeight", scrollHeightDescriptor);
      restorePrototypeDescriptor("clientHeight", clientHeightDescriptor);
    }
  });

  it("keeps repeated detached scroll events off the MessageList React reconciliation path", async () => {
    conversationBaselineDiagnostics.enable();
    try {
      render(<MessageList messages={[message("m1", "assistant", "long history")]} />);
      const scroller = screen.getByTestId("message-list-scroll") as HTMLDivElement;
      await waitFor(() => expect(screen.getByTestId("message-list").getAttribute("data-tail-bootstrap")).toBe("committed"));
      mockScrollMetrics(scroller, { scrollHeight: 2_000, clientHeight: 400, scrollTop: 600 });
      fireEvent.wheel(scroller, { deltaY: -120 });
      fireEvent.scroll(scroller);
      conversationBaselineDiagnostics.reset();
      for (let index = 0; index < 1_000; index += 1) {
        scroller.scrollTop = 600 + (index % 20);
        fireEvent.scroll(scroller);
      }
      const renders = conversationBaselineDiagnostics.snapshot().events.filter((event) => event.stage === "message-list-render");
      expect(renders).toHaveLength(0);
      expect(screen.getByTestId("message-list").getAttribute("data-follow-mode")).toBe("user-detached");
    } finally {
      conversationBaselineDiagnostics.enable(false);
      conversationBaselineDiagnostics.reset();
    }
  });

  it("lets upward wheel intent interrupt native auto-follow without enabling virtual scroll ownership", async () => {
    const running = { ...message("m1", "assistant", "正在输出"), status: "running" as const };
    const { rerender } = render(<MessageList messages={[running]} isProcessing />);
    const scroller = screen.getByTestId("message-list-scroll") as HTMLDivElement;
    await waitFor(() => expect(screen.getByTestId("message-list").getAttribute("data-tail-bootstrap")).toBe("committed"));
    mockScrollMetrics(scroller, { scrollHeight: 1000, clientHeight: 200, scrollTop: 800 });

    fireEvent.wheel(scroller, { deltaY: -120 });
    expect(screen.getByTestId("message-list").getAttribute("data-list-mode")).toBe("native");
    expect(scroller.dataset.conversationTimelineUserScrollActive).toBeUndefined();
    mockScrollMetrics(scroller, { scrollHeight: 1200, clientHeight: 200, scrollTop: 800 });
    rerender(
      <MessageList
        messages={[{ ...running, content: "正在输出更多内容" }]}
        isProcessing
      />,
    );

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 40));
    });
    expect(scroller.scrollTop).toBe(800);
  });

  it("keeps native scrollbar dragging outside virtual timeline ownership", async () => {
    render(<MessageList messages={[message("m1", "assistant", "long history")]} />);
    const scroller = screen.getByTestId("message-list-scroll") as HTMLDivElement;
    await waitFor(() => expect(screen.getByTestId("message-list").getAttribute("data-tail-bootstrap")).toBe("committed"));
    Object.defineProperties(scroller, {
      clientWidth: { configurable: true, value: 90 },
      offsetWidth: { configurable: true, value: 100 },
    });
    vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue({
      bottom: 200,
      height: 200,
      left: 0,
      right: 100,
      top: 0,
      width: 100,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    fireEvent(scroller, new MouseEvent("pointerdown", { bubbles: true, clientX: 99, clientY: 20 }));

    expect(screen.getByTestId("message-list").getAttribute("data-list-mode")).toBe("native");
    expect(scroller.dataset.conversationTimelineUserScrollActive).toBeUndefined();
  });

  it("keeps the controlled scrollbar thumb tied to pointer movement for histories above the virtual threshold", async () => {
    render(<MessageList messages={historyMessages(121, "controlled-rail")} />);
    const scroller = screen.getByTestId("message-list-scroll") as HTMLDivElement;
    await waitFor(() => expect(screen.getByTestId("message-list").getAttribute("data-tail-bootstrap")).toBe("committed"));
    expect(screen.getByTestId("message-list").getAttribute("data-list-mode")).toBe("virtual");
    mockScrollMetrics(scroller, { scrollHeight: 2_000, clientHeight: 400, scrollTop: 600 });
    const rail = screen.getByTestId("conversation-scroll-rail") as HTMLDivElement;
    const track = rail.firstElementChild as HTMLDivElement;
    const thumb = screen.getByTestId("conversation-scroll-thumb") as HTMLDivElement;
    Object.defineProperty(track, "clientHeight", { configurable: true, value: 200 });
    vi.spyOn(track, "getBoundingClientRect").mockReturnValue({
      bottom: 200,
      height: 200,
      left: 0,
      right: 14,
      top: 0,
      width: 14,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    fireEvent(rail, new MouseEvent("pointerdown", { bubbles: true, clientY: 100 }));
    expect(rail.dataset.dragging).toBe("true");
    expect(scroller.dataset.conversationTimelineUserScrollActive).toBe("true");
    expect(scroller.scrollTop).toBe(800);
    expect(thumb.style.transform).toBe("translateY(80px)");

    fireEvent(rail, new MouseEvent("pointermove", { bubbles: true, clientY: 150 }));
    expect(scroller.scrollTop).toBe(1_300);
    expect(thumb.style.transform).toBe("translateY(130px)");

    fireEvent(rail, new MouseEvent("pointerup", { bubbles: true, clientY: 150 }));
    expect(rail.dataset.dragging).toBeUndefined();
    expect(scroller.dataset.conversationTimelineUserScrollActive).toBe("false");
  });

  it("keeps the message list as the sole scroll owner when nested in another scroll container", async () => {
    const first = message("m1", "assistant", "第一段");
    render(
      <div data-testid="outer-scroll" style={{ height: 200, overflowY: "auto" }}>
        <MessageList messages={[first]} />
      </div>,
    );
    const outer = screen.getByTestId("outer-scroll") as HTMLDivElement;
    const scroller = screen.getByTestId("message-list-scroll") as HTMLDivElement;
    await waitFor(() => expect(screen.getByTestId("message-list").getAttribute("data-tail-bootstrap")).toBe("committed"));
    mockScrollMetrics(outer, { scrollHeight: 1200, clientHeight: 200, scrollTop: 120 });
    mockScrollMetrics(scroller, { scrollHeight: 1200, clientHeight: 200, scrollTop: 120 });

    fireEvent.wheel(scroller, { deltaY: -120 });
    fireEvent.scroll(scroller);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "滚动到底" })).not.toBeNull();
    });

    fireEvent.click(screen.getByRole("button", { name: "滚动到底" }));
    await waitFor(() => {
      expect(scroller.scrollTop).toBe(timelineBottom(scroller));
    });
    expect(outer.scrollTop).toBe(120);
  });

  it("starts following automatically when streamed content grows past the viewport", async () => {
    const first = message("m1", "assistant", "短回复");
    const { rerender } = render(<MessageList messages={[first]} isProcessing />);
    const scroller = screen.getByTestId("message-list-scroll") as HTMLDivElement;

    mockScrollMetrics(scroller, { scrollHeight: 200, clientHeight: 200, scrollTop: 0 });

    rerender(
      <MessageList
        messages={[{ ...first, status: "running", content: "这是一段持续增长的流式回复。".repeat(80) }]}
        isProcessing
      />,
    );
    mockScrollMetrics(scroller, { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 });

    await waitFor(() => {
      expect(scroller.scrollTop).toBe(800);
    });
  });

  it("uses the unified timeline runtime for a 1,000-turn product list with bounded mounted DOM and direct reveal", async () => {
    const originalResizeObserver = globalThis.ResizeObserver;
    const originalUserAgent = navigator.userAgent;
    const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    class PassiveResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: PassiveResizeObserver });
    Object.defineProperty(navigator, "userAgent", { configurable: true, value: "Mozilla/5.0 Chrome" });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 600 });
    const messages = Array.from({ length: 1_000 }, (_, index) => [
      { ...message(`large-user-${index}`, "user", `question-${index}`), turnId: `turn-${index}` },
      { ...message(`large-assistant-${index}`, "assistant", `answer-${index}`), turnId: `turn-${index}` },
    ]).flat();

    try {
      render(
        <MessageList
          messages={messages}
          turnNavigationRequest={{ requestId: 1, targetIndex: 999 }}
        />,
      );
      const scroller = screen.getByTestId("message-list-scroll");
      expect(screen.getByTestId("message-list").getAttribute("data-list-mode")).toBe("virtual");
      expect(scroller.getAttribute("data-conversation-timeline-runtime")).toBe("true");
      expect(scroller.querySelectorAll('[data-message-list-scroll="true"]')).toHaveLength(0);
      await waitFor(() => {
        expect(scroller.querySelector('[data-turn-index="999"]')).not.toBeNull();
        expect(scroller.querySelector('[data-conversation-unit-id="unit:user-markdown:large-user-999"]')).not.toBeNull();
        expect(scroller.textContent).toContain("question-999");
        expect(scroller.querySelectorAll("[data-conversation-unit-measurement-pending]")).toHaveLength(0);
      });
      expect(Number(scroller.getAttribute("data-conversation-timeline-mounted-units"))).toBeLessThan(80);
      expect(scroller.querySelectorAll("[data-conversation-unit-id]").length).toBeLessThan(80);
      expect(scroller.querySelectorAll('[style*="visibility: hidden"]')).toHaveLength(0);
      expect(scroller.querySelectorAll('[data-conversation-unit-pinned="true"]')).toHaveLength(0);
      expect(scroller.querySelectorAll('[data-conversation-unit-tail-adjacent="true"]')).toHaveLength(1);
      expect(scroller.getAttribute("data-conversation-timeline-follow-bottom")).toBe("false");
    } finally {
      Object.defineProperty(navigator, "userAgent", { configurable: true, value: originalUserAgent });
      if (originalResizeObserver) {
        Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: originalResizeObserver });
      } else {
        delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
      }
      restorePrototypeDescriptor("clientHeight", originalClientHeight);
    }
  });

  it("renders heterogeneous conversation units once and updates only the changed unit", async () => {
    const originalResizeObserver = globalThis.ResizeObserver;
    const originalUserAgent = navigator.userAgent;
    const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    class PassiveResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: PassiveResizeObserver });
    Object.defineProperty(navigator, "userAgent", { configurable: true, value: "Mozilla/5.0 Chrome" });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 800 });

    const history = Array.from({ length: 165 }, (_, index) => [
      { ...message(`mixed-history-user-${index}`, "user", `history-question-${index}`), turnId: `turn-${index}` },
      { ...message(`mixed-history-assistant-${index}`, "assistant", `history-answer-${index}`), turnId: `turn-${index}` },
    ]).flat();
    const mixedTurn: ConversationMessage[] = [
      message("mixed-user", "user", "mixed-user-content"),
      message("mixed-assistant", "assistant", "mixed-assistant-content"),
      { ...message("mixed-thinking", "thinking", "mixed-thinking-content"), status: "running" },
      message("mixed-tool", "tool", "mixed-tool-content"),
      message("mixed-file", "file_change", "mixed-file-content"),
      { ...message("mixed-a2ui", "a2ui", "mixed-a2ui-v1"), status: "pending" },
      { ...message("mixed-approval", "approval", "mixed-approval-content"), status: "pending" },
      { ...message("mixed-mcp", "mcp_elicitation", "mixed-mcp-content"), status: "pending" },
      message("mixed-error", "error", "mixed-error-content"),
      message("mixed-skill", "skill", "mixed-skill-content"),
      message("mixed-task", "thread_task_status", "mixed-task-content"),
      message("mixed-status", "status", "mixed-status-content"),
    ];
    const renderCounts = new Map<string, number>();
    const renderMessage = vi.fn((entry: ConversationMessage) => {
      renderCounts.set(entry.id, (renderCounts.get(entry.id) ?? 0) + 1);
      return <div data-message-id={entry.id}>{entry.content}</div>;
    });

    try {
      const { rerender } = render(
        <MessageList
          messages={[...history, ...mixedTurn]}
          renderMessage={renderMessage}
          turnNavigationRequest={{ requestId: 1, targetIndex: 165 }}
        />,
      );
      const scroller = screen.getByTestId("message-list-scroll");
      const expectedKinds = [
        "user-markdown",
        "assistant-markdown",
        "reasoning",
        "tool",
        "file-change",
        "a2ui",
        "approval",
        "mcp-elicitation",
        "error",
        "skill",
        "task-status",
        "status",
        "footer",
      ];
      await waitFor(() => {
        const mountedKinds = new Set(
          Array.from(scroller.querySelectorAll<HTMLElement>("[data-conversation-unit-kind]"))
            .map((element) => element.dataset.conversationUnitKind),
        );
        expectedKinds.forEach((kind) => expect(mountedKinds.has(kind)).toBe(true));
        expect(scroller.querySelector('[data-message-id="mixed-a2ui"]')?.textContent).toBe("mixed-a2ui-v1");
      });

      const assistantHost = scroller.querySelector('[data-conversation-unit-id="unit:assistant-markdown:mixed-assistant"]');
      const a2uiHost = scroller.querySelector('[data-conversation-unit-id="unit:a2ui:mixed-a2ui"]');
      expect(assistantHost).not.toBeNull();
      expect(a2uiHost).not.toBeNull();
      for (const entry of mixedTurn.filter((candidate) => candidate.kind !== "thread_task_status")) {
        expect(scroller.querySelectorAll(`[data-message-id="${entry.id}"]`)).toHaveLength(1);
      }
      const countsBefore = new Map(renderCounts);
      const updatedMessages = [...history, ...mixedTurn.map((entry) => (
        entry.id === "mixed-a2ui" ? { ...entry, content: "mixed-a2ui-v2" } : entry
      ))];

      rerender(
        <MessageList
          messages={updatedMessages}
          renderMessage={renderMessage}
          turnNavigationRequest={{ requestId: 1, targetIndex: 165 }}
        />,
      );
      await waitFor(() => {
        expect(scroller.querySelector('[data-message-id="mixed-a2ui"]')?.textContent).toBe("mixed-a2ui-v2");
      });
      expect(scroller.querySelector('[data-conversation-unit-id="unit:assistant-markdown:mixed-assistant"]')).toBe(assistantHost);
      expect(scroller.querySelector('[data-conversation-unit-id="unit:a2ui:mixed-a2ui"]')).toBe(a2uiHost);
      expect(renderCounts.get("mixed-a2ui")).toBe((countsBefore.get("mixed-a2ui") ?? 0) + 1);
      expect(renderCounts.get("mixed-assistant")).toBe(countsBefore.get("mixed-assistant"));
      expect(Number(scroller.getAttribute("data-conversation-timeline-mounted-units"))).toBeLessThan(80);
    } finally {
      Object.defineProperty(navigator, "userAgent", { configurable: true, value: originalUserAgent });
      if (originalResizeObserver) {
        Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: originalResizeObserver });
      } else {
        delete (globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
      }
      restorePrototypeDescriptor("clientHeight", originalClientHeight);
    }
  });
});

function message(
  id: string,
  kind: ConversationMessage["kind"],
  content: string,
): ConversationMessage {
  return {
    id,
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: id,
    kind,
    status: "completed",
    content,
    payload: {},
    createdAt: `2026-06-17T10:00:0${id.slice(-1)}Z`,
    updatedAt: `2026-06-17T10:00:0${id.slice(-1)}Z`,
  };
}

function goalTurnMarker(id: string, turnIndex: number): ConversationMessage {
  return {
    ...message(id, "turn_marker", ""),
    payload: {
      turnIndex,
      turn_index: turnIndex,
      metadata: {
        kind: "turn_started",
        source: "thread_task",
        source_label: "目标继续执行",
        thread_task: {
          task_id: "task-1",
          run_id: `run-${turnIndex}`,
          trigger: "task_continue",
          type: "goal",
        },
      },
    },
  };
}

function userTurnMarker(id: string, turnIndex: number): ConversationMessage {
  return {
    ...message(id, "turn_marker", ""),
    payload: {
      turnIndex,
      turn_index: turnIndex,
      metadata: {
        kind: "turn_started",
        source: "user",
      },
    },
  };
}

function at(message: ConversationMessage, iso: string): ConversationMessage {
  return {
    ...message,
    createdAt: iso,
    updatedAt: iso,
  };
}

function toolMessage(
  id: string,
  name = "read_file",
  args: Record<string, unknown> = { path: "README.md" },
): ConversationMessage {
  return {
    ...message(id, "tool", name),
    payload: {
      call: {
        id: `call-${id}`,
        name,
        arguments: args,
      },
      result: {
        status: "success",
        model_content: "文件内容",
      },
    },
  };
}

function failedToolMessage(
  id: string,
  name = "read_file",
  args: Record<string, unknown> = { path: "missing.txt" },
): ConversationMessage {
  return {
    ...toolMessage(id, name, args),
    status: "failed",
    payload: {
      call: {
        id: `call-${id}`,
        name,
        arguments: args,
      },
      result: {
        status: "error",
        error: "失败",
      },
    },
  };
}

function mcpToolMessage(id: string, rawToolName: string): ConversationMessage {
  const modelToolName = `mcp__srv_1__${rawToolName}`;
  return {
    ...toolMessage(id, modelToolName, { query: "KT-1" }),
    payload: {
      call: {
        id: `call-${id}`,
        name: modelToolName,
        arguments: { query: "KT-1" },
      },
      result: {
        status: "success",
        model_content: "ok",
      },
      metadata: {
        mcp: {
          kind: "mcp_tool",
          snapshot_id: "snap-1",
          server_id: "srv-1",
          server_name: "Ticket MCP",
          raw_tool_name: rawToolName,
          model_tool_name: modelToolName,
          approval_mode: "auto",
        },
      },
    },
  };
}

function fileEditToolMessage(
  id: string,
  path: string,
  additions: number,
  deletions: number,
  status: ConversationMessage["status"] = "completed",
): ConversationMessage {
  return {
    ...toolMessage(id, "apply_patch", { path, patch: "*** Begin Patch" }),
    status,
    payload: {
      call: {
        id: `call-${id}`,
        name: "apply_patch",
        arguments: { path, patch: "*** Begin Patch" },
      },
      result: {
        status: status === "running" ? "running" : "success",
        model_content: status === "running" ? "" : "patched",
        files: [
          {
            path,
            operation: "update",
            added_lines: additions,
            deleted_lines: deletions,
          },
        ],
      },
    },
  };
}

function commandMessage(id: string): ConversationMessage {
  return {
    ...message(id, "command", "pytest backend/tests"),
    payload: {
      command: "pytest backend/tests",
      cwd: "D:/repo",
      stdout: "24 passed",
      exit_code: 0,
    },
  };
}

function fileChangeMessage(
  id = "file-change-1",
  path = "src/main.py",
  operation = "update",
  toolName = "",
): ConversationMessage {
  return {
    id,
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: id,
    kind: "file_change",
    status: "completed",
    content: path,
    payload: {
      ...(toolName ? { call: { name: toolName, arguments: {} }, tool: toolName } : {}),
      path,
      operation,
      diff: "@@\n+hello",
      additions: 1,
      deletions: 0,
    },
    createdAt: "2026-06-17T10:00:00Z",
    updatedAt: "2026-06-17T10:00:00Z",
  };
}

function planMessage(): ConversationMessage {
  return {
    id: "plan-1",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "plan-1",
    kind: "plan",
    status: "completed",
    content: "update_plan",
    payload: {
      ui_payload: {
        explanation: "补充 AionUi 计划展示",
        entries: [
          { content: "分析 AionUi 计划卡片", status: "completed" },
          { content: "实现计划卡片", status: "in_progress" },
          { content: "回填测试报告", status: "pending" },
        ],
      },
    },
    createdAt: "2026-06-17T10:00:00Z",
    updatedAt: "2026-06-17T10:00:00Z",
  };
}

function turnIndexFor(element: Element | null): string | null {
  return element?.closest<HTMLElement>("[data-turn-index]")?.dataset.turnIndex ?? null;
}

function timelineBottom(scroller: HTMLElement): number {
  if (scroller.dataset.conversationNativeTimeline === "true") {
    return Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  }
  const canvas = scroller.querySelector<HTMLElement>("[data-conversation-timeline-total-height]");
  return Math.max(0, Number(canvas?.dataset.conversationTimelineTotalHeight ?? 0) - scroller.clientHeight);
}

function historyMessages(turnCount: number, prefix: string): ConversationMessage[] {
  return Array.from({ length: turnCount }, (_, index) => [
    { ...message(`${prefix}-user-${index}`, "user", `question-${index}`), turnId: `${prefix}-turn-${index}` },
    { ...message(`${prefix}-assistant-${index}`, "assistant", `answer-${index}`), turnId: `${prefix}-turn-${index}` },
  ]).flat();
}

function mockScrollMetrics(
  element: HTMLElement,
  metrics: { scrollHeight: number; clientHeight: number; scrollTop: number },
) {
  Object.defineProperty(element, "scrollHeight", { configurable: true, value: metrics.scrollHeight });
  Object.defineProperty(element, "clientHeight", { configurable: true, value: metrics.clientHeight });
  Object.defineProperty(element, "scrollTop", { configurable: true, writable: true, value: metrics.scrollTop });
}

function mockElementTop(element: HTMLElement, top: number) {
  mockElementTopSequence(element, [top]);
}

function mockElementRect(element: HTMLElement, rect: { top: number; height: number; width?: number }) {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () =>
      ({
        top: rect.top,
        bottom: rect.top + rect.height,
        left: 0,
        right: rect.width ?? 320,
        width: rect.width ?? 320,
        height: rect.height,
        x: 0,
        y: rect.top,
        toJSON: () => ({}),
      }) as DOMRect,
  });
}

function mockElementInlineSize(element: HTMLElement, metrics: { clientWidth: number; offsetWidth: number }) {
  Object.defineProperty(element, "clientWidth", { configurable: true, value: metrics.clientWidth });
  Object.defineProperty(element, "offsetWidth", { configurable: true, value: metrics.offsetWidth });
}

function mockElementTopSequence(element: HTMLElement, tops: number[]) {
  let index = 0;
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => {
      const top = tops[Math.min(index, tops.length - 1)] ?? 0;
      index += 1;
      return {
        top,
        bottom: top + 28,
        left: 0,
        right: 320,
        width: 320,
        height: 28,
        x: 0,
        y: top,
        toJSON: () => ({}),
      } as DOMRect;
    },
  });
}

function restorePrototypeDescriptor(
  property: "clientHeight" | "scrollHeight",
  descriptor: PropertyDescriptor | undefined,
) {
  if (descriptor) {
    Object.defineProperty(HTMLElement.prototype, property, descriptor);
    return;
  }
  delete (HTMLElement.prototype as unknown as Record<string, unknown>)[property];
}

function fakeRuntime(readMedia: ReturnType<typeof vi.fn>): RuntimeBridge {
  return {
    workspace: {
      readMedia,
      readFile: vi.fn(),
    },
  } as unknown as RuntimeBridge;
}
