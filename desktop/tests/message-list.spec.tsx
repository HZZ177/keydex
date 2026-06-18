import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MessageList } from "@/renderer/pages/conversation/messages";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";

describe("MessageList", () => {
  it("renders empty and loading states", () => {
    const { rerender } = render(<MessageList messages={[]} emptyText="还没有消息" />);

    expect(screen.getByTestId("message-empty").textContent).toBe("还没有消息");

    rerender(<MessageList messages={[]} loading />);
    expect(screen.getAllByTestId("message-skeleton").length).toBe(3);
  });

  it("renders messages with the default lightweight renderer", () => {
    render(<MessageList messages={[message("m1", "user", "你好"), message("m2", "assistant", "收到")]} />);

    expect(screen.getByText("你好")).not.toBeNull();
    expect(screen.getByText("收到")).not.toBeNull();
    expect(screen.getAllByRole("button", { name: "复制消息" }).length).toBe(2);
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
    expect(within(textMessages[2]).getByRole("button", { name: "复制消息" })).not.toBeNull();
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

  it("summarizes consecutive tool messages and expands original blocks on demand", () => {
    render(<MessageList messages={[message("t1", "tool", "read_file"), message("c1", "command", "echo ok")]} />);

    expect(screen.getByTestId("message-group-block")).not.toBeNull();
    expect(screen.getByText("2 个工具步骤")).not.toBeNull();
    expect(screen.getByLabelText("步骤摘要")).not.toBeNull();
    expect(screen.getByText("read_file")).not.toBeNull();
    expect(screen.getByText("echo ok")).not.toBeNull();
    expect(screen.queryByTestId("tool-call-block")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "2 个工具步骤详情" }));

    expect(screen.getByTestId("tool-call-block")).not.toBeNull();
    expect(screen.getByTestId("command-execution-block")).not.toBeNull();
  });

  it("renders compact file-change summaries before expanding details", () => {
    render(<MessageList messages={[fileChangeMessage("file-change-1", "src/main.py"), fileChangeMessage("file-change-2", "src/app.py")]} />);

    expect(screen.getByText("2 个文件变更")).not.toBeNull();
    expect(screen.getByLabelText("步骤摘要").textContent).toContain("src/main.py");
    expect(screen.getByLabelText("步骤摘要").textContent).toContain("+1 -0");
    expect(screen.queryByTestId("file-change-block")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "2 个文件变更详情" }));

    expect(screen.getAllByTestId("file-change-block")).toHaveLength(2);
  });

  it("renders update_plan as a collapsible plan card", () => {
    render(<MessageList messages={[planMessage()]} />);

    expect(screen.getByTestId("message-plan")).not.toBeNull();
    expect(screen.getByText("计划")).not.toBeNull();
    expect(screen.getByText(/1\/3 已完成/)).not.toBeNull();
    expect(screen.getByText(/正在进行：实现计划卡片/)).not.toBeNull();
    expect(screen.getByText("补充 AionUi 计划展示")).not.toBeNull();
    expect(screen.getByText("进行中")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "收起计划详情" }));

    expect(screen.queryByText("补充 AionUi 计划展示")).toBeNull();
    expect(screen.getByRole("button", { name: "展开计划详情" }).getAttribute("aria-expanded")).toBe("false");
  });

  it("passes file preview callbacks into file change blocks", () => {
    const onFilePreview = vi.fn();
    render(<MessageList messages={[fileChangeMessage()]} onFilePreview={onFilePreview} />);

    fireEvent.click(screen.getByRole("button", { name: "预览" }));

    expect(onFilePreview).toHaveBeenCalledWith({
      path: "src/main.py",
      diff: "@@\n+hello",
    });
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

  it("does not force scroll when the user has scrolled up", async () => {
    const first = message("m1", "assistant", "第一段");
    const second = message("m2", "assistant", "第二段");
    const { rerender } = render(<MessageList messages={[first]} />);
    const scroller = screen.getByTestId("message-list-scroll") as HTMLDivElement;
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
      expect(scroller.scrollTop).toBe(800);
    });
  });

  it("uses the outer scroll container when the message list itself is not scrollable", async () => {
    const first = message("m1", "assistant", "第一段");
    render(
      <div data-testid="outer-scroll" style={{ height: 200, overflowY: "auto" }}>
        <MessageList messages={[first]} />
      </div>,
    );
    const outer = screen.getByTestId("outer-scroll") as HTMLDivElement;
    const scroller = screen.getByTestId("message-list-scroll") as HTMLDivElement;
    mockScrollMetrics(outer, { scrollHeight: 1200, clientHeight: 200, scrollTop: 120 });
    mockScrollMetrics(scroller, { scrollHeight: 1200, clientHeight: 1200, scrollTop: 0 });

    fireEvent.wheel(outer, { deltaY: -120 });
    fireEvent.scroll(outer);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "滚动到底" })).not.toBeNull();
    });

    fireEvent.click(screen.getByRole("button", { name: "滚动到底" }));
    await waitFor(() => {
      expect(outer.scrollTop).toBe(1000);
    });
    expect(scroller.scrollTop).toBe(0);
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

function fileChangeMessage(id = "file-change-1", path = "src/main.py"): ConversationMessage {
  return {
    id,
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: id,
    kind: "file_change",
    status: "completed",
    content: path,
    payload: {
      path,
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

function mockScrollMetrics(
  element: HTMLElement,
  metrics: { scrollHeight: number; clientHeight: number; scrollTop: number },
) {
  Object.defineProperty(element, "scrollHeight", { configurable: true, value: metrics.scrollHeight });
  Object.defineProperty(element, "clientHeight", { configurable: true, value: metrics.clientHeight });
  Object.defineProperty(element, "scrollTop", { configurable: true, writable: true, value: metrics.scrollTop });
}
