import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { FileChangeBlock, MessageList } from "@/renderer/pages/conversation/messages";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";

vi.mock("@/renderer/components/diff/wrappers/CompactDiffView", () => ({
  CompactDiffView: ({ document }: {
    document: {
      files: Array<{ displayPath: string; patch: string; newContent?: string }>;
    };
  }) => (
    <section aria-label="文件差异" data-keydex-diff-wrapper="compact">
      {document.files.map((file) => (
        <div key={file.displayPath}>
          <span>{file.displayPath}</span>
          <pre>
            {file.patch
              ? file.patch.split("\n").filter((line) => !/^(diff --git |--- |\+\+\+ |@@)/.test(line)).join("\n")
              : file.newContent?.split("\n").filter(Boolean).map((line) => `+${line}`).join("\n") || ""}
          </pre>
        </div>
      ))}
    </section>
  ),
}));

describe("FileChangeBlock", () => {
  it("summarizes multiple files and expands a diff on demand", () => {
    render(<FileChangeBlock message={fileChangeMessage("completed", true)} />);

    expect(screen.getByText("编辑了 2 个文件")).not.toBeNull();
    expect(screen.queryByTestId("line-change-ticker")).toBeNull();
    expect(screen.queryByLabelText("文件差异")).toBeNull();
    expect(screen.queryByLabelText("变更文件")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "展开文件变更详情" }));
    const fileButton = screen.getByRole("button", { name: /src\/main.py/ });
    expect(fileButton.querySelector("[data-file-change-path-icon='true']")?.getAttribute("data-icon-id")).toBe("python");
    fireEvent.click(fileButton);
    expect(screen.getByLabelText("文件差异").textContent).toContain("+print('new')");
  });

  it("shows applied and failed states", () => {
    const { rerender } = render(<FileChangeBlock message={fileChangeMessage("completed", true)} />);
    expect(screen.getByText("已编辑文件")).not.toBeNull();

    rerender(<FileChangeBlock message={fileChangeMessage("failed", false)} />);
    expect(screen.getByText("编辑文件失败")).not.toBeNull();
  });

  it("shows tool error details instead of a diff panel when file changes fail", () => {
    render(
      <FileChangeBlock
        message={singleFileChangeMessage("failed", "write", true, "", "write_file", "error", "无法写入文件")}
      />,
    );

    expect(screen.getByText("创建失败")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "展开文件变更详情" }));

    expect(screen.getByLabelText("文件变更错误").textContent).toContain("无法写入文件");
    expect(screen.getByLabelText("文件变更错误").textContent).toContain('"path": "src/main.py"');
    expect(screen.getByLabelText("失败文件").textContent).toContain("src/main.py");
    expect(screen.queryByLabelText("文件差异")).toBeNull();
  });

  it("does not show line-change stats for failed single-file changes", () => {
    render(<FileChangeBlock message={singleFileChangeMessage("failed", "update", true, "", "apply_patch", "error", "patch failed")} />);

    const block = screen.getByTestId("file-change-block");
    expect(screen.queryByTestId("line-change-ticker")).toBeNull();
    expect(block.textContent).not.toContain("+4");
    expect(block.textContent).not.toContain("-2");
  });

  it("is used by MessageList for file change messages", () => {
    render(<MessageList messages={[fileChangeMessage("completed", true)]} />);

    expect(screen.getByTestId("file-change-block")).not.toBeNull();
  });

  it("notifies preview target from file change rows", () => {
    const onPreviewFile = vi.fn();
    render(<FileChangeBlock message={fileChangeMessage("completed", true)} onPreviewFile={onPreviewFile} />);

    fireEvent.click(screen.getByRole("button", { name: "展开文件变更详情" }));
    fireEvent.click(screen.getAllByRole("button", { name: "预览" })[0]);

    expect(onPreviewFile).toHaveBeenCalledWith(expect.objectContaining({
      path: "src/main.py",
      diff: "--- a/src/main.py\n+++ b/src/main.py\n@@\n-print('old')\n+print('new')",
      title: "编辑了 2 个文件",
    }));
    expect(onPreviewFile.mock.calls[0][0].files).toHaveLength(2);
    expect(onPreviewFile.mock.calls[0][0].message.id).toBe("file-change-1");
  });

  it("renders single-file edit rows with ticker stats and clickable filename", () => {
    const onPreviewFile = vi.fn();
    render(<FileChangeBlock message={singleFileChangeMessage("running")} onPreviewFile={onPreviewFile} />);

    expect(screen.getByText("正在编辑")).not.toBeNull();
    const pathButton = screen.getByRole("button", { name: "src/main.py" });
    expect(pathButton.querySelector("[data-file-change-path-icon='true']")?.getAttribute("data-icon-id")).toBe("python");
    expect(screen.getByTestId("line-change-ticker").textContent).toContain("+4");
    expect(screen.getByTestId("line-change-ticker").textContent).toContain("-2");
    expect(screen.getByTestId("line-change-ticker").textContent).not.toContain("行");
    const blockText = screen.getByTestId("file-change-block").textContent ?? "";
    expect(blockText.indexOf("正在编辑")).toBeLessThan(blockText.indexOf("src/main.py"));
    expect(blockText.indexOf("src/main.py")).toBeLessThan(blockText.indexOf("+4"));
    expect(blockText.indexOf("+4")).toBeLessThan(blockText.indexOf("-2"));

    fireEvent.click(pathButton);
    expect(onPreviewFile).toHaveBeenCalledWith(expect.objectContaining({
      path: "src/main.py",
      diff: "",
      title: "正在编辑文件 1 个文件",
    }));
    expect(onPreviewFile.mock.calls[0][0].files).toHaveLength(1);
    expect(onPreviewFile.mock.calls[0][0].message.id).toBe("file-change-single");
  });

  it("uses the whole single-file row for expansion while filename opens preview", () => {
    const onPreviewFile = vi.fn();
    const { unmount } = render(<FileChangeBlock message={singleFileChangeMessage("completed")} onPreviewFile={onPreviewFile} />);

    fireEvent.click(screen.getByRole("button", { name: "展开文件变更详情" }));
    expect(screen.getByLabelText("文件差异")).not.toBeNull();
    expect(screen.queryByText("暂无 diff")).toBeNull();
    expect(screen.queryByLabelText("变更文件")).toBeNull();

    unmount();
    render(<FileChangeBlock message={singleFileChangeMessage("completed")} onPreviewFile={onPreviewFile} />);

    fireEvent.click(screen.getByRole("button", { name: "src/main.py" }));
    expect(onPreviewFile).toHaveBeenCalledWith(expect.objectContaining({
      path: "src/main.py",
      diff: "",
      title: "编辑了 1 个文件",
    }));
    expect(onPreviewFile.mock.calls[0][0].files).toHaveLength(1);
    expect(screen.queryByLabelText("变更文件")).toBeNull();
  });

  it("renders a single-file diff preview without unified diff file headers", () => {
    render(<FileChangeBlock message={singleFileChangeMessage("completed", "update", true)} />);

    fireEvent.click(screen.getByRole("button", { name: "展开文件变更详情" }));

    const diff = screen.getByLabelText("文件差异");
    expect(diff.textContent).toContain("print('new')");
    expect(diff.textContent).not.toContain("--- a/src/main.py");
    expect(diff.textContent).not.toContain("+++ b/src/main.py");
  });

  it("renders created file content as added lines when the payload includes content", () => {
    render(<FileChangeBlock message={singleFileChangeMessage("completed", "add", false, "first\nsecond\n")} />);

    fireEvent.click(screen.getByRole("button", { name: "展开文件变更详情" }));

    const diff = screen.getByLabelText("文件差异");
    expect(diff.textContent).toContain("+first");
    expect(diff.textContent).toContain("+second");
    expect(screen.queryByText("暂无 diff")).toBeNull();
  });

  it("does not render the empty diff placeholder for created files without diff content", () => {
    render(<FileChangeBlock message={singleFileChangeMessage("completed", "add")} />);

    fireEvent.click(screen.getByRole("button", { name: "展开文件变更详情" }));

    expect(screen.getByLabelText("文件差异")).not.toBeNull();
    expect(screen.queryByText("暂无 diff")).toBeNull();
  });

  it("treats successful completed tool file changes as applied", () => {
    render(<FileChangeBlock message={singleFileChangeMessage("completed")} />);

    expect(screen.getByText("已编辑")).not.toBeNull();
    expect(screen.queryByText("等待编辑文件")).toBeNull();
  });

  it("labels created file changes separately from edits", () => {
    const { rerender } = render(<FileChangeBlock message={singleFileChangeMessage("running", "add")} />);

    expect(screen.getByText("正在创建")).not.toBeNull();
    expect(screen.queryByText("正在编辑")).toBeNull();
    expect(screen.getByTestId("file-change-block").querySelector('[data-operation="add"] svg')).not.toBeNull();

    rerender(<FileChangeBlock message={singleFileChangeMessage("completed", "add")} />);

    expect(screen.getByText("已创建")).not.toBeNull();
    expect(screen.queryByText("已编辑")).toBeNull();
  });

  it("shows write-file streaming progress as file creation wording", () => {
    const { rerender } = render(<FileChangeBlock message={singleFileChangeMessage("running", "write")} />);

    expect(screen.getByText("正在创建")).not.toBeNull();
    expect(screen.queryByText("正在编辑")).toBeNull();
    expect(screen.queryByText(/写入/)).toBeNull();

    rerender(<FileChangeBlock message={singleFileChangeMessage("completed", "write")} />);

    expect(screen.getByText("已创建")).not.toBeNull();
    expect(screen.queryByText("已编辑")).toBeNull();
    expect(screen.queryByText(/写入/)).toBeNull();
  });

  it("keeps running status wording even when the result payload is optimistic success", () => {
    render(<FileChangeBlock message={singleFileChangeMessage("running", "write", false, "", "", "success")} />);

    expect(screen.getByText("正在创建")).not.toBeNull();
    expect(screen.queryByText("已创建")).toBeNull();
  });

  it("uses concrete add operation for apply_patch file creation", () => {
    render(<FileChangeBlock message={singleFileChangeMessage("running", "add", false, "", "apply_patch")} />);

    expect(screen.getByText("正在创建")).not.toBeNull();
    expect(screen.queryByText("正在编辑")).toBeNull();
  });

  it("renders move operations with move wording", () => {
    render(<FileChangeBlock message={singleFileChangeMessage("completed", "move", false, "", "move_file")} />);

    expect(screen.getByText("已移动")).not.toBeNull();
    expect(screen.queryByText("已编辑")).toBeNull();
  });

  it("renders write-file diffs directly in the expanded single-file preview", () => {
    render(<FileChangeBlock message={singleFileChangeMessage("completed", "write", true)} />);

    fireEvent.click(screen.getByRole("button", { name: "展开文件变更详情" }));

    const diff = screen.getByLabelText("文件差异");
    expect(diff.textContent).toContain("print('new')");
    expect(screen.queryByText("暂无 diff")).toBeNull();
  });

  it("loads deferred file diff on expansion", async () => {
    const onLoadDetails = vi.fn().mockResolvedValue({
      payload: {
        call: { name: "apply_patch", arguments: { path: "src/main.py" } },
        result: {
          status: "success",
          files: [
            {
              path: "src/main.py",
              operation: "update",
              added_lines: 4,
              deleted_lines: 2,
              diff: "--- a/src/main.py\n+++ b/src/main.py\n@@\n-old\n+lazy new",
            },
          ],
        },
        files: [
          {
            path: "src/main.py",
            operation: "update",
            added_lines: 4,
            deleted_lines: 2,
            diff: "--- a/src/main.py\n+++ b/src/main.py\n@@\n-old\n+lazy new",
          },
        ],
      },
      status: "completed",
    });
    render(
      <FileChangeBlock
        message={{
          ...singleFileChangeMessage("completed", "update", false, "", "apply_patch"),
          payload: {
            call: { name: "apply_patch", arguments: { path: "src/main.py" } },
            toolDetailsDeferred: true,
            result: {
              status: "success",
              files: [{ path: "src/main.py", operation: "update", added_lines: 4, deleted_lines: 2 }],
            },
            files: [{ path: "src/main.py", operation: "update", added_lines: 4, deleted_lines: 2 }],
          },
        }}
        onLoadDetails={onLoadDetails}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "展开文件变更详情" }));

    await waitFor(() => {
      expect(onLoadDetails).toHaveBeenCalledTimes(1);
      expect(screen.getByLabelText("文件差异").textContent).toContain("lazy new");
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

function singleFileChangeMessage(
  status: ConversationMessage["status"],
  operation = "update",
  withDiff = false,
  content = "",
  toolName = "",
  resultStatus = "",
  errorMessage = "",
): ConversationMessage {
  return {
    id: "file-change-single",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-single",
    kind: "file_change",
    itemType: "tool_call",
    status,
    content: "src/main.py",
    payload: {
      ...(toolName
        ? { call: { name: toolName, arguments: { path: "src/main.py", content: "print('new')" } }, tool: toolName }
        : {}),
      result: {
        ...(status === "completed" ? { status: "success" } : {}),
        ...(resultStatus ? { status: resultStatus } : {}),
        ...(errorMessage ? { error: errorMessage } : {}),
        files: [
          {
            path: "src/main.py",
            operation,
            added_lines: 4,
            deleted_lines: 2,
            ...(content ? { content } : {}),
            ...(withDiff
              ? {
                  diff: "--- a/src/main.py\n+++ b/src/main.py\n@@ -1,2 +1,2 @@\n print('old')\n-print('old')\n+print('new')",
                }
              : {}),
          },
        ],
      },
    },
    createdAt: "2026-06-17T10:00:00Z",
    updatedAt: "2026-06-17T10:00:02Z",
  };
}
