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

    const block = screen.getByTestId("tool-call-block");
    expect(block.textContent).toContain("正在读取文件 README.md");
    expect(block.querySelectorAll("svg")).toHaveLength(2);
    expect(screen.getByText("正在读取文件 README.md")).not.toBeNull();
    expect(screen.queryByText("read_file")).toBeNull();
    expect(screen.queryByText(/"path": "README.md"/)).toBeNull();
    expect(screen.queryByText("工具正在执行")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "展开工具详情" }));
    expect(screen.getByLabelText("工具入参").textContent).toContain('"path": "README.md"');
    expect(screen.getByText("工具正在执行")).not.toBeNull();
  });

  it("copies completed tool results", async () => {
    const clipboard = navigator.clipboard.writeText as unknown as ReturnType<typeof vi.fn>;
    render(<ToolCallBlock message={toolMessage("completed", { status: "success", model_content: "文件内容", duration_ms: 1250 })} />);

    expect(screen.getByTestId("tool-call-block").textContent).toMatch(/已读取文件 README\.md.*1\.3s/);
    expect(screen.getByText("1.3s")).not.toBeNull();
    expect(screen.queryByText("文件内容")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "展开工具详情" }));

    fireEvent.click(screen.getByRole("button", { name: "复制入参" }));
    await waitFor(() => {
      expect(clipboard).toHaveBeenLastCalledWith('{\n  "path": "README.md"\n}');
    });
    expect(screen.getByRole("button", { name: "已复制入参" })).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "复制输出" }));

    await waitFor(() => {
      expect(clipboard).toHaveBeenLastCalledWith("文件内容");
    });
    expect(screen.getByRole("button", { name: "已复制输出" })).not.toBeNull();
  });

  it("formats sub-second tool durations as milliseconds", () => {
    render(<ToolCallBlock message={toolMessage("completed", { status: "success", model_content: "文件内容", duration_ms: 125 })} />);

    expect(screen.getByText("125ms")).not.toBeNull();
    expect(screen.queryByText("0.1 秒")).toBeNull();
  });

  it("keeps failed tools visible", () => {
    render(<ToolCallBlock message={toolMessage("failed", { status: "error", model_content: "", error: "读取失败" })} />);

    expect(screen.getByText("读取文件失败 README.md")).not.toBeNull();
    expect(screen.queryByText("读取失败")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "展开工具详情" }));
    expect(screen.getByRole("region", { name: "工具错误" })).not.toBeNull();
    expect(screen.getByText("读取失败")).not.toBeNull();
  });

  it("renders failed file mutation tools with file-change style target", () => {
    render(
      <ToolCallBlock
        message={toolMessage(
          "failed",
          { status: "error", error: "patch failed" },
          "apply_patch",
          {
            patch: "*** Begin Patch\n*** Update File: docs/project-structure.md\n@@\n+intro\n*** End Patch",
          },
        )}
      />,
    );

    const block = screen.getByTestId("tool-call-block");
    expect(block.textContent).toContain("编辑文件失败 docs/project-structure.md");
    expect(screen.getByText("docs/project-structure.md")).not.toBeNull();
    expect(block.querySelector("svg.lucide-circle-x")).not.toBeNull();
  });

  it("is used by MessageList for tool messages", () => {
    render(<MessageList messages={[toolMessage("completed")]} />);

    expect(screen.getByTestId("tool-call-block")).not.toBeNull();
  });
});

function toolMessage(
  status: ConversationMessage["status"],
  result: Record<string, unknown> | null = { status: "success", model_content: "文件内容" },
  name = "read_file",
  args: Record<string, unknown> = { path: "README.md" },
): ConversationMessage {
  return {
    id: "tool-1",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    kind: "tool",
    itemType: "tool_call",
    status,
    content: name,
    payload: {
      call: {
        id: "call-1",
        name,
        arguments: args,
      },
      ...(result ? { result } : {}),
    },
    createdAt: "2026-06-17T10:00:00Z",
    updatedAt: "2026-06-17T10:00:02Z",
  };
}
