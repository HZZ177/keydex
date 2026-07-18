import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MessageList, ToolCallBlock } from "@/renderer/pages/conversation/messages";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";

vi.mock("@/renderer/components/diff/wrappers/CompactDiffView", () => ({
  CompactDiffView: ({ document, activeFileId, actions }: {
    document: { files: Array<{ id: string; displayPath: string; patch: string }> };
    activeFileId?: string | null;
    actions?: { copyPatch?: (patch: string) => void | Promise<void> };
  }) => {
    const activeFile = document.files.find((file) => file.id === activeFileId) ?? document.files[0];
    return (
      <section aria-label="文件差异" data-keydex-diff-wrapper="compact">
        <span>{activeFile?.displayPath}</span>
        <pre>{activeFile?.patch}</pre>
        {actions?.copyPatch && activeFile ? (
          <button type="button" aria-label="复制原始补丁" onClick={() => void actions.copyPatch?.(activeFile.patch)}>
            复制原始补丁
          </button>
        ) : null}
      </section>
    );
  },
}));

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
    expect(screen.getByText("read_file")).not.toBeNull();
    expect(screen.getByLabelText("工具入参").textContent).toContain('"path": "README.md"');
    expect(screen.getByText("工具正在执行")).not.toBeNull();
  });

  it("does not render running result envelopes as output", () => {
    render(
      <ToolCallBlock
        message={toolMessage(
          "running",
          { status: "running", model_content: "", files: [] },
          "grep_files",
          { query: "needle", regex: false },
        )}
      />,
    );

    expect(screen.getByText("正在搜索文件 needle")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "展开工具详情" }));
    const blockText = screen.getByTestId("tool-call-block").textContent ?? "";
    expect(blockText).toContain("工具正在执行");
    expect(blockText).not.toContain("model_content");
    expect(blockText).not.toContain('"files"');
  });

  it("distinguishes file search and content search labels", () => {
    const { rerender } = render(
      <ToolCallBlock
        message={toolMessage(
          "completed",
          { status: "success", model_content: "" },
          "grep_files",
          { query: "needle", regex: false },
        )}
      />,
    );

    expect(screen.getByText("已搜索文件 needle")).not.toBeNull();

    rerender(
      <ToolCallBlock
        message={toolMessage(
          "completed",
          { status: "success", model_content: "" },
          "search_files",
          { query: "needle" },
        )}
      />,
    );

    expect(screen.getByText("已搜索文件 needle")).not.toBeNull();

    rerender(
      <ToolCallBlock
        message={toolMessage(
          "completed",
          { status: "success", model_content: "" },
          "search_text",
          { query: "needle", regex: false },
        )}
      />,
    );

    expect(screen.getByText("已搜索内容 needle")).not.toBeNull();
  });

  it("copies completed tool arguments", async () => {
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
  });

  it("copies completed tool results", async () => {
    const clipboard = navigator.clipboard.writeText as unknown as ReturnType<typeof vi.fn>;
    render(<ToolCallBlock message={toolMessage("completed", { status: "success", model_content: "文件内容", duration_ms: 1250 })} />);

    fireEvent.click(screen.getByRole("button", { name: "展开工具详情" }));
    fireEvent.click(screen.getByRole("button", { name: "复制输出" }));

    await waitFor(() => {
      expect(clipboard).toHaveBeenLastCalledWith("文件内容");
      expect(screen.getByRole("button", { name: "已复制输出" })).not.toBeNull();
    });
  });

  it("formats sub-second tool durations as milliseconds", () => {
    render(<ToolCallBlock message={toolMessage("completed", { status: "success", model_content: "文件内容", duration_ms: 125 })} />);

    expect(screen.getByText("125ms")).not.toBeNull();
    expect(screen.queryByText("0.1 秒")).toBeNull();
  });

  it("keeps failed tools visible", () => {
    render(<ToolCallBlock message={toolMessage("failed", { status: "error", model_content: "", error: "读取失败" })} />);

    expect(screen.getByText("读取文件失败 README.md")).not.toBeNull();
    expect(screen.getByText("错误信息：读取失败")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "展开工具详情" }));
    expect(screen.getByRole("region", { name: "工具错误" })).not.toBeNull();
    expect(screen.getByText(/错误信息：读取失败/)).not.toBeNull();
  });

  it("renders MCP tool server, raw tool and runtime metadata", () => {
    render(<ToolCallBlock message={mcpToolMessage("completed", { status: "success", model_content: "ok", duration_ms: 240 })} />);

    const block = screen.getByTestId("tool-call-block");
    expect(block.textContent).toContain("已调用 MCP 工具 search");
    expect(block.textContent).toContain("MCP · Ticket MCP · search");

    fireEvent.click(screen.getByRole("button", { name: "展开工具详情" }));
    expect(screen.getByLabelText("MCP 工具元信息").textContent).toContain("Ticket MCP");
    expect(screen.getByLabelText("MCP 工具元信息").textContent).toContain("mcp__srv_1__search");
    expect(screen.getByLabelText("MCP 工具元信息").textContent).toContain("始终允许");
    expect(screen.getByLabelText("MCP 工具元信息").textContent).toContain("snap-1");
  });

  it("reads MCP metadata from tool ui payload and parses hashed model names", () => {
    const modelName = "mcp__20260706-045dd9_5fb1e382__read_fixture";
    render(
      <ToolCallBlock
        message={toolMessage(
          "completed",
          {
            status: "success",
            model_content: "ok",
            duration_ms: 88,
            ui_payload: {
              structured_content: {
                key: "runtime-snapshot",
                value: "fixture:run:runtime-snapshot",
              },
              metadata: {
                mcp: {
                  kind: "mcp_tool",
                  snapshot_id: "snap-hashed",
                  server_id: "srv-hashed",
                  server_name: "Hashed MCP",
                  raw_tool_name: "read_fixture",
                  model_tool_name: modelName,
                  approval_mode: "auto",
                },
              },
            },
          },
          modelName,
          { key: "runtime-snapshot" },
        )}
      />,
    );

    const block = screen.getByTestId("tool-call-block");
    expect(block.textContent).toContain("已调用 MCP 工具 read_fixture");
    expect(block.textContent).toContain("MCP · Hashed MCP · read_fixture");

    fireEvent.click(screen.getByRole("button", { name: "展开工具详情" }));
    const details = screen.getByLabelText("MCP 工具元信息").textContent ?? "";
    expect(details).toContain("Hashed MCP");
    expect(details).toContain(modelName);
    expect(details).toContain("snap-hashed");
  });

  it("reads MCP metadata from JSON model content", () => {
    const modelName = "mcp__20260706-045dd9_5fb1e382__read_fixture";
    render(
      <ToolCallBlock
        message={toolMessage(
          "completed",
          {
            status: "success",
            duration_ms: 96,
            model_content: JSON.stringify({
              structured_content: {
                key: "runtime-snapshot",
                value: "fixture:run:runtime-snapshot",
              },
              metadata: {
                mcp: {
                  kind: "mcp_tool",
                  snapshot_id: "snap-result",
                  server_id: "srv-result",
                  server_name: "Result MCP",
                  raw_tool_name: "read_fixture",
                  model_tool_name: modelName,
                  approval_mode: "auto",
                },
              },
            }),
          },
          modelName,
          { key: "runtime-snapshot" },
        )}
      />,
    );

    const block = screen.getByTestId("tool-call-block");
    expect(block.textContent).toContain("已调用 MCP 工具 read_fixture");
    expect(block.textContent).toContain("MCP · Result MCP · read_fixture");

    fireEvent.click(screen.getByRole("button", { name: "展开工具详情" }));
    const details = screen.getByLabelText("MCP 工具元信息").textContent ?? "";
    expect(details).toContain("Result MCP");
    expect(details).toContain(modelName);
    expect(details).toContain("snap-result");
  });

  it("shows readable MCP execution errors", () => {
    render(
      <ToolCallBlock
        message={mcpToolMessage("failed", {
          status: "error",
          model_content: "",
          error: {
            code: "tool_disabled_by_session",
            message: "blocked",
          },
        })}
      />,
    );

    expect(screen.getByText(/错误信息：当前会话已禁用该 MCP 工具/)).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "展开工具详情" }));
    expect(screen.getByRole("region", { name: "工具错误" }).textContent).toContain("tool_disabled_by_session");
  });

  it("renders cancelled MCP tools distinctly from failures", () => {
    render(
      <ToolCallBlock
        message={mcpToolMessage("cancelled", {
          status: "cancelled",
          model_content: "",
          error: { code: "cancelled_by_user" },
        })}
      />,
    );

    const block = screen.getByTestId("tool-call-block");
    expect(block.textContent).toContain("已取消 MCP 工具 search");
    expect(block.textContent).toContain("MCP · Ticket MCP · search");
    expect(block.textContent).not.toContain("错误信息");

    fireEvent.click(screen.getByRole("button", { name: "展开工具详情" }));
    expect(screen.getByText("已取消")).not.toBeNull();
  });

  it("shows readable previews for structured JSON tool errors", () => {
    render(
      <ToolCallBlock
        message={toolMessage("failed", {
          status: "error",
          model_content: JSON.stringify({
            tool: "read_file",
            ok: false,
            status: "failed",
            code: "file_access_disabled",
            message: "文件访问权限已关闭",
            details: { file_access_mode: "no_file_access" },
          }),
        })}
      />,
    );

    expect(screen.getByText(/错误信息：文件访问权限已关闭/)).not.toBeNull();
    expect(screen.getByText(/错误码：file_access_disabled/)).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "展开工具详情" }));
    expect(screen.getByRole("region", { name: "工具错误" }).textContent).toContain('"tool":"read_file"');
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
    expect(block.querySelector("[data-tool-file-target-icon='true']")?.getAttribute("data-icon-id")).toBe("markdown");
    expect(block.querySelector("svg.lucide-circle-x")).not.toBeNull();
  });

  it("renders file mutation rows with ticker stats and clickable filename", () => {
    const onPreviewFile = vi.fn();
    render(
      <ToolCallBlock
        message={toolMessage(
          "running",
          {
            status: "running",
            model_content: "",
            files: [
              {
                path: "src/main.py",
                operation: "update",
                added_lines: 4,
                deleted_lines: 2,
              },
            ],
          },
          "apply_patch",
          { path: "src/main.py", patch: "*** Begin Patch" },
        )}
        onPreviewFile={onPreviewFile}
      />,
    );

    expect(screen.getByText("正在编辑文件")).not.toBeNull();
    const pathButton = screen.getByRole("button", { name: "src/main.py" });
    expect(pathButton.querySelector("[data-tool-file-target-icon='true']")?.getAttribute("data-icon-id")).toBe("python");
    expect(screen.getByTestId("line-change-ticker").textContent).toContain("+4");
    expect(screen.getByTestId("line-change-ticker").textContent).toContain("-2");
    expect(screen.getByTestId("line-change-ticker").textContent).not.toContain("行");

    fireEvent.click(pathButton);
    expect(onPreviewFile).toHaveBeenCalledWith(expect.objectContaining({
      path: "src/main.py",
      diff: "",
      title: "正在编辑文件 src/main.py",
    }));
    expect(onPreviewFile.mock.calls[0][0].files).toHaveLength(1);
    expect(onPreviewFile.mock.calls[0][0].message.id).toBe("tool-1");
  });

  it("uses create wording for apply_patch add-file changes", () => {
    render(
      <ToolCallBlock
        message={toolMessage(
          "completed",
          {
            status: "success",
            model_content: "created",
            files: [
              {
                path: "docs/new.md",
                operation: "add",
                added_lines: 2,
                deleted_lines: 0,
              },
            ],
          },
          "apply_patch",
          { patch: "*** Begin Patch\n*** Add File: docs/new.md\n+hello\n*** End Patch" },
        )}
      />,
    );

    expect(screen.getByText("已创建文件")).not.toBeNull();
    expect(screen.queryByText("已编辑文件")).toBeNull();
    expect(screen.getByText("docs/new.md")).not.toBeNull();
  });

  it("renders file mutation tool details as a diff review panel", async () => {
    const clipboard = navigator.clipboard.writeText as unknown as ReturnType<typeof vi.fn>;
    const diff = "--- a/src/main.py\n+++ b/src/main.py\n@@ -1 +1 @@\n-old\n+new";
    render(
      <ToolCallBlock
        message={toolMessage(
          "completed",
          {
            status: "success",
            model_content: "patched",
            files: [
              {
                path: "src/main.py",
                operation: "update",
                added_lines: 1,
                deleted_lines: 1,
                diff,
              },
            ],
          },
          "apply_patch",
          { path: "src/main.py", patch: "*** Begin Patch" },
        )}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "展开工具详情" }));

    expect(screen.queryByText("已编辑的文件")).toBeNull();
    expect((await screen.findByLabelText("文件差异")).textContent).toContain("+new");
    expect(screen.queryByLabelText("工具入参")).toBeNull();
    expect(screen.queryByLabelText("工具输出")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "复制原始补丁" }));
    await waitFor(() => {
      expect(clipboard).toHaveBeenLastCalledWith(diff);
    });
  });

  it("renders an external absolute-path diff returned by the backend", async () => {
    const path = String.raw`D:\Pycharm Projects\kt-pm-platform\ktagent\test.md`;
    const patchPath = path.replaceAll("\\", "/");
    const diff = `--- a/${patchPath}\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-one\n-two\n`;
    render(
      <ToolCallBlock
        message={toolMessage(
          "completed",
          {
            status: "success",
            path,
            files: [{
              path,
              operation: "delete",
              old_path: path,
              new_path: null,
              added_lines: 0,
              deleted_lines: 2,
              diff,
            }],
          },
          "delete_file",
          { path },
        )}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "展开工具详情" }));

    const review = await screen.findByLabelText("文件差异");
    expect(review.textContent).toContain(patchPath);
    expect(review.textContent).toContain("-one");
    expect(review.textContent).toContain("-two");
  });

  it("renders move file mutation tools with move wording", () => {
    render(
      <ToolCallBlock
        message={toolMessage(
          "completed",
          {
            status: "success",
            model_content: "moved",
            files: [
              {
                path: "docs/new.md",
                operation: "move",
                old_path: "docs/old.md",
                new_path: "docs/new.md",
                diff: "--- a/docs/old.md\n+++ b/docs/new.md",
              },
            ],
          },
          "move_file",
          { path: "docs/old.md", new_path: "docs/new.md" },
        )}
      />,
    );

    expect(screen.getByText("已移动文件")).not.toBeNull();
    expect(screen.getByText("docs/new.md")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "展开工具详情" }));
    expect(screen.getByLabelText("已移动的文件")).not.toBeNull();
  });

  it("keeps legacy edit_file patch events as file mutation tools", () => {
    render(
      <ToolCallBlock
        message={toolMessage(
          "running",
          {
            status: "running",
            files: [
              {
                path: "docs/legacy.md",
                operation: "update",
                added_lines: 1,
                deleted_lines: 0,
              },
            ],
          },
          "edit_file",
          { patch: "*** Begin Patch\n*** Update File: docs/legacy.md\n@@\n+new\n*** End Patch" },
        )}
      />,
    );

    expect(screen.getByText("正在编辑文件")).not.toBeNull();
    expect(screen.getByText("docs/legacy.md")).not.toBeNull();
    expect(screen.getByTestId("line-change-ticker").textContent).toContain("+1");
  });

  it("passes file mutation preview clicks through MessageList", () => {
    const onPreviewFile = vi.fn();
    render(
      <MessageList
        messages={[
          toolMessage(
            "running",
            {
              status: "running",
              model_content: "",
              files: [{ path: "src/main.py", operation: "update", added_lines: 4, deleted_lines: 2 }],
            },
            "apply_patch",
            { path: "src/main.py", patch: "*** Begin Patch" },
          ),
        ]}
        onFilePreview={onPreviewFile}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "src/main.py" }));
    expect(onPreviewFile).toHaveBeenCalledWith(expect.objectContaining({
      path: "src/main.py",
      diff: "",
      title: "正在编辑文件 src/main.py",
    }));
    expect(onPreviewFile.mock.calls[0][0].files).toHaveLength(1);
    expect(onPreviewFile.mock.calls[0][0].message.id).toBe("tool-1");
  });

  it("is used by MessageList for tool messages", () => {
    render(<MessageList messages={[toolMessage("completed")]} />);

    expect(screen.getByTestId("tool-call-block")).not.toBeNull();
  });

  it("keeps delegate_subagent out of ToolCallBlock and renders its semantic capsule", () => {
    const invocation = {
      ...toolMessage(
        "running",
        { status: "running", model_content: "" },
        "delegate_subagent",
        { type: "explorer", task: "inspect the workspace" },
      ),
      kind: "subagent_invocation" as const,
    };

    render(<MessageList messages={[invocation]} />);

    expect(screen.queryByTestId("tool-call-block")).toBeNull();
    expect(screen.getByTestId("subagent-invocation-capsule").textContent).toContain("sub-explore");
    expect(screen.getByTestId("subagent-invocation-capsule").textContent).toContain("inspect the workspace");
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

function mcpToolMessage(
  status: ConversationMessage["status"],
  result: Record<string, unknown>,
): ConversationMessage {
  return {
    ...toolMessage(status, result, "mcp__srv_1__search", { query: "KT-1" }),
    payload: {
      call: {
        id: "call-mcp-1",
        name: "mcp__srv_1__search",
        arguments: { query: "KT-1" },
      },
      result,
      metadata: {
        mcp: {
          kind: "mcp_tool",
          snapshot_id: "snap-1",
          server_id: "srv-1",
          server_name: "Ticket MCP",
          raw_tool_name: "search",
          model_tool_name: "mcp__srv_1__search",
          approval_mode: "auto",
        },
      },
    },
  };
}
