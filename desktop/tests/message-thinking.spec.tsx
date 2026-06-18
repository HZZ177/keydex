import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MessageList, MessageThinking } from "@/renderer/pages/conversation/messages";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";

describe("MessageThinking", () => {
  it("shows running reasoning collapsed by default and expands on demand", () => {
    render(<MessageThinking message={thinking("running", "正在分析代码路径")} />);

    expect(screen.getByRole("button", { name: /正在思考/ }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("正在分析代码路径")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /正在思考/ }));
    expect(screen.getByText("正在分析代码路径")).not.toBeNull();
  });

  it("collapses completed reasoning by default and shows duration", () => {
    render(<MessageThinking message={thinking("completed", "分析完成", { duration_ms: 2400 })} />);

    expect(screen.getByRole("button", { name: /已完成思考/ }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("2.4 秒")).not.toBeNull();
    expect(screen.queryByText("分析完成")).toBeNull();
  });

  it("preserves user expansion after message updates", () => {
    const { rerender } = render(<MessageThinking message={thinking("completed", "第一段")} />);

    fireEvent.click(screen.getByRole("button", { name: /已完成思考/ }));
    expect(screen.getByText("第一段")).not.toBeNull();

    rerender(<MessageThinking message={thinking("completed", "第一段\n第二段")} />);
    expect(screen.getByText(/第二段/)).not.toBeNull();
    expect(screen.getByRole("button", { name: /已完成思考/ }).getAttribute("aria-expanded")).toBe("true");
  });

  it("uses reasoning kind labels and does not render empty completed panels", () => {
    const { rerender } = render(
      <MessageThinking message={thinking("running", "正在扫描依赖", { reasoning_kind: "progress_fact" })} />,
    );

    expect(screen.getByRole("button", { name: /进展事实中/ })).not.toBeNull();

    rerender(<MessageThinking message={thinking("completed", "")} />);
    expect(screen.queryByTestId("message-thinking")).toBeNull();
  });

  it("is used by MessageList for thinking messages", () => {
    render(<MessageList messages={[thinking("running", "推理增量")]} />);

    expect(screen.getByTestId("message-thinking")).not.toBeNull();
    expect(screen.queryByText("推理增量")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /正在思考/ }));
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
