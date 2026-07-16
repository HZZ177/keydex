import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MessageList, MessageThinking } from "@/renderer/pages/conversation/messages";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";

describe("MessageThinking", () => {
  it("shows running reasoning expanded by default and collapses on demand", () => {
    render(<MessageThinking message={thinking("running", "正在分析代码路径")} />);

    expect(screen.getByRole("button", { name: /正在思考/ }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("正在分析代码路径")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /正在思考/ }));
    expect(screen.getByRole("button", { name: /正在思考/ }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByTestId("message-thinking-content").getAttribute("aria-hidden")).toBe("true");
  });

  it("keeps live reasoning expanded through completion so the timeline height stays stable", () => {
    const { rerender } = render(<MessageThinking message={thinking("running", "正在分析代码路径")} />);

    expect(screen.getByText("正在分析代码路径")).not.toBeNull();

    rerender(<MessageThinking message={thinking("completed", "正在分析代码路径")} />);
    expect(screen.getByRole("button", { name: /已完成思考/ }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByTestId("message-thinking-content").getAttribute("aria-hidden")).toBe("false");
  });

  it("collapses completed reasoning by default and shows duration", () => {
    render(<MessageThinking message={thinking("completed", "分析完成", { duration_ms: 2400 })} />);

    expect(screen.getByRole("button", { name: /已完成思考/ }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("思考了 2秒")).not.toBeNull();
    expect(screen.queryByText("分析完成")).toBeNull();
  });

  it("shows durations up to one second in milliseconds", () => {
    const { rerender } = render(
      <MessageThinking message={thinking("completed", "分析完成", { duration_ms: 860 })} />,
    );

    expect(screen.getByText("思考了 860毫秒")).not.toBeNull();

    rerender(<MessageThinking message={thinking("completed", "分析完成", { duration_ms: 1000 })} />);
    expect(screen.getByText("思考了 1000毫秒")).not.toBeNull();
  });

  it("updates the elapsed time while reasoning and freezes the persisted duration on completion", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-17T10:00:00Z"));
    const { rerender, unmount } = render(<MessageThinking message={thinking("running", "正在分析代码路径")} />);

    expect(screen.getByText("思考了 0毫秒")).not.toBeNull();
    act(() => vi.advanceTimersByTime(2400));
    expect(screen.getByText("思考了 2秒")).not.toBeNull();

    rerender(
      <MessageThinking message={thinking("completed", "正在分析代码路径", { duration_ms: 2400 })} />,
    );
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.getByText("思考了 2秒")).not.toBeNull();

    unmount();
    vi.useRealTimers();
  });

  it("preserves user expansion after message updates", () => {
    const { rerender } = render(<MessageThinking message={thinking("completed", "第一段")} />);

    fireEvent.click(screen.getByRole("button", { name: /已完成思考/ }));
    expect(screen.getByText("第一段")).not.toBeNull();

    rerender(<MessageThinking message={thinking("completed", "第一段\n第二段")} />);
    expect(screen.getByText(/第二段/)).not.toBeNull();
    expect(screen.getByRole("button", { name: /已完成思考/ }).getAttribute("aria-expanded")).toBe("true");
  });

  it("follows new streaming content until the user scrolls away from the bottom", () => {
    const { rerender } = render(<MessageThinking message={thinking("running", "第一段")} />);
    const shell = screen.getByTestId("message-thinking-content");
    const viewport = shell.firstElementChild as HTMLDivElement;
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 400 },
    });

    rerender(<MessageThinking message={thinking("running", "第一段\n第二段")} />);
    expect(viewport.scrollTop).toBe(400);

    viewport.scrollTop = 120;
    fireEvent.scroll(viewport);
    Object.defineProperty(viewport, "scrollHeight", { configurable: true, value: 500 });
    rerender(<MessageThinking message={thinking("running", "第一段\n第二段\n第三段")} />);
    expect(viewport.scrollTop).toBe(120);

    viewport.scrollTop = 400;
    fireEvent.scroll(viewport);
    Object.defineProperty(viewport, "scrollHeight", { configurable: true, value: 600 });
    rerender(<MessageThinking message={thinking("running", "第一段\n第二段\n第三段\n第四段")} />);
    expect(viewport.scrollTop).toBe(600);
  });

  it("uses reasoning kind labels and does not render empty completed panels", () => {
    const { rerender } = render(
      <MessageThinking message={thinking("running", "正在扫描依赖", { reasoning_kind: "progress_fact" })} />,
    );

    expect(screen.getByRole("button", { name: /进展事实中/ })).not.toBeNull();

    rerender(<MessageThinking message={thinking("running", "正在思考", { reasoning_kind: "reasoning" })} />);
    expect(screen.getByRole("button", { name: /正在思考/ })).not.toBeNull();
    expect(screen.queryByRole("button", { name: /推理/ })).toBeNull();

    rerender(<MessageThinking message={thinking("completed", "")} />);
    expect(screen.queryByTestId("message-thinking")).toBeNull();
  });

  it("is used by MessageList for thinking messages", () => {
    render(<MessageList messages={[thinking("running", "推理增量")]} />);

    expect(screen.getByTestId("message-thinking")).not.toBeNull();
    expect(screen.getByText("推理增量")).not.toBeNull();
  });
});

function thinking(
  status: ConversationMessage["status"],
  content: string,
  payload: Record<string, unknown> = {},
): ConversationMessage {
  return {
    id: "thinking-1",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    kind: "thinking",
    status,
    content,
    payload,
    createdAt: "2026-06-17T10:00:00Z",
    updatedAt: "2026-06-17T10:00:02Z",
  };
}
