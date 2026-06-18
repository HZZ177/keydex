import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MessageList, ToolCallBlock } from "@/renderer/pages/conversation/messages";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";

describe("ToolCallBlock", () => {
  beforeEach(() => {
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
  });

  it("renders tool name and status with details collapsed by default", () => {
    render(<ToolCallBlock message={toolMessage("running", null)} />);

    expect(screen.getByText("read_file")).not.toBeNull();
    expect(screen.getByText("正在执行")).not.toBeNull();
    expect(screen.queryByText(/README.md/)).toBeNull();
    expect(screen.queryByText("工具正在执行")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "展开工具详情" }));
    expect(screen.getByText(/README.md/)).not.toBeNull();
    expect(screen.getByText("工具正在执行")).not.toBeNull();
  });

  it("copies completed tool results", async () => {
    const clipboard = navigator.clipboard.writeText as unknown as ReturnType<typeof vi.fn>;
    render(<ToolCallBlock message={toolMessage("completed", { status: "success", model_content: "文件内容", duration_ms: 1250 })} />);

    expect(screen.getByText("1.3 秒")).not.toBeNull();
    expect(screen.queryByText("文件内容")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "展开工具详情" }));
    fireEvent.click(screen.getByRole("button", { name: "复制工具结果" }));

    await waitFor(() => {
      expect(clipboard).toHaveBeenCalledWith("文件内容");
    });
    await waitFor(() => {
      expect(screen.getByText("已复制")).not.toBeNull();
    });
  });

  it("keeps failed tools visible", () => {
    render(<ToolCallBlock message={toolMessage("failed", { status: "error", model_content: "", error: "读取失败" })} />);

    expect(screen.getByText("执行失败")).not.toBeNull();
    expect(screen.queryByText("读取失败")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "展开工具详情" }));
    expect(screen.getByRole("region", { name: "工具错误" })).not.toBeNull();
    expect(screen.getByText("读取失败")).not.toBeNull();
  });

  it("is used by MessageList for tool messages", () => {
    render(<MessageList messages={[toolMessage("completed")]} />);

    expect(screen.getByTestId("tool-call-block")).not.toBeNull();
  });
});

function toolMessage(
  status: ConversationMessage["status"],
  result: Record<string, unknown> | null = { status: "success", model_content: "文件内容" },
): ConversationMessage {
  return {
    id: "tool-1",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    kind: "tool",
    itemType: "tool_call",
    status,
    content: "read_file",
    payload: {
      call: {
        id: "call-1",
        name: "read_file",
        arguments: { path: "README.md" },
      },
      ...(result ? { result } : {}),
    },
    createdAt: "2026-06-17T10:00:00Z",
    updatedAt: "2026-06-17T10:00:02Z",
  };
}
