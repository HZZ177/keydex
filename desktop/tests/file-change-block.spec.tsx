import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { FileChangeBlock, MessageList } from "@/renderer/pages/conversation/messages";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";

describe("FileChangeBlock", () => {
  it("summarizes multiple files and expands a diff on demand", () => {
    render(<FileChangeBlock message={fileChangeMessage("completed", true)} />);

    expect(screen.getByText("2 个文件变更")).not.toBeNull();
    expect(screen.getByText("+2")).not.toBeNull();
    expect(screen.getByText("-1")).not.toBeNull();
    expect(screen.queryByLabelText("文件 diff")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /src\/main.py/ }));
    expect(screen.getByLabelText("文件 diff").textContent).toContain("+print('new')");
  });

  it("shows applied and failed states", () => {
    const { rerender } = render(<FileChangeBlock message={fileChangeMessage("completed", true)} />);
    expect(screen.getByText("已应用")).not.toBeNull();

    rerender(<FileChangeBlock message={fileChangeMessage("failed", false)} />);
    expect(screen.getByText("变更失败")).not.toBeNull();
  });

  it("is used by MessageList for file change messages", () => {
    render(<MessageList messages={[fileChangeMessage("completed", true)]} />);

    expect(screen.getByTestId("file-change-block")).not.toBeNull();
  });

  it("notifies preview target from file change rows", () => {
    const onPreviewFile = vi.fn();
    render(<FileChangeBlock message={fileChangeMessage("completed", true)} onPreviewFile={onPreviewFile} />);

    fireEvent.click(screen.getAllByRole("button", { name: "预览" })[0]);

    expect(onPreviewFile).toHaveBeenCalledWith({
      path: "src/main.py",
      diff: "--- a/src/main.py\n+++ b/src/main.py\n@@\n-print('old')\n+print('new')",
    });
  });
});

function fileChangeMessage(status: ConversationMessage["status"], applied: boolean): ConversationMessage {
  return {
    id: "file-change-1",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    kind: "file_change",
    itemType: "file_change",
    status,
    content: "src/main.py",
    payload: {
      applied,
      files: [
        {
          path: "src/main.py",
          additions: 1,
          deletions: 1,
          diff: "--- a/src/main.py\n+++ b/src/main.py\n@@\n-print('old')\n+print('new')",
        },
        {
          path: "README.md",
          additions: 1,
          deletions: 0,
          diff: "--- a/README.md\n+++ b/README.md\n@@\n+hello",
        },
      ],
    },
    createdAt: "2026-06-17T10:00:00Z",
    updatedAt: "2026-06-17T10:00:02Z",
  };
}
