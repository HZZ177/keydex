import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, test, vi } from "vitest";

import { ToolCallBlock } from "@/renderer/pages/conversation/messages/ToolCallBlock";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";

let compactProps: Record<string, unknown> | null = null;
let compactRenderCount = 0;

vi.mock("@/renderer/components/diff/wrappers/CompactDiffView", () => ({
  CompactDiffView: (props: Record<string, unknown>) => {
    compactProps = props;
    compactRenderCount += 1;
    const document = props.document as { files: Array<{ displayPath: string }> };
    return <div data-testid="tool-pierre-diff">{document.files.map((file) => file.displayPath).join(",")}</div>;
  },
}));

describe("ToolCallBlock Pierre migration", () => {
  beforeEach(() => {
    compactProps = null;
    compactRenderCount = 0;
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it("loads the compact viewer only after file-tool details are expanded", async () => {
    render(<ToolCallBlock message={toolMessage("apply_patch", "update")} />);
    expect(compactRenderCount).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "展开工具详情" }));
    await screen.findByTestId("tool-pierre-diff");

    expect(compactRenderCount).toBeGreaterThan(0);
    const props = compactProps as { document: { source: string; files: unknown[] } };
    expect(props.document.source).toBe("agent");
    expect(props.document.files).toHaveLength(1);
  });

  test.each([
    ["apply_patch", "update", "src/app.ts"],
    ["edit_file", "update", "src/app.ts"],
    ["write_file", "write", "src/new.ts"],
    ["delete_file", "delete", "src/old.ts"],
    ["move_file", "move", "src/moved.ts"],
  ])("normalizes %s/%s into the shared document", async (tool, operation, path) => {
    render(<ToolCallBlock message={toolMessage(tool, operation, path)} />);
    fireEvent.click(screen.getByRole("button", { name: "展开工具详情" }));
    expect((await screen.findByTestId("tool-pierre-diff")).textContent).toBe(path);
  });

  it("keeps metadata-only successful changes in the unified empty-content state", async () => {
    render(<ToolCallBlock message={toolMessage("write_file", "write", "src/empty.ts", "")} />);
    fireEvent.click(screen.getByRole("button", { name: "展开工具详情" }));
    await screen.findByTestId("tool-pierre-diff");
    const props = compactProps as {
      document: { files: Array<{ displayPath: string; patch: string; hunks: unknown[] }> };
    };
    expect(props.document.files[0]).toMatchObject({ displayPath: "src/empty.ts", hunks: [] });
    expect(props.document.files[0]?.patch).not.toContain("@@");
  });

  it("does not expose raw JSON or load the viewer for failed file tools", () => {
    render(<ToolCallBlock message={toolMessage("apply_patch", "update", "src/app.ts", "", "failed")} />);
    fireEvent.click(screen.getByRole("button", { name: "展开工具详情" }));
    expect(screen.getByLabelText("文件编辑错误").textContent).toContain("patch failed");
    expect(screen.queryByLabelText("工具入参")).toBeNull();
    expect(screen.queryByLabelText("工具输出")).toBeNull();
    expect(compactRenderCount).toBe(0);
  });

  it("does not load the Pierre surface for ordinary tools", () => {
    render(<ToolCallBlock message={ordinaryToolMessage()} />);
    fireEvent.click(screen.getByRole("button", { name: "展开工具详情" }));
    expect(screen.getByLabelText("工具入参")).not.toBeNull();
    expect(compactRenderCount).toBe(0);
  });

  it("forwards exact copy and open actions through the host contract", async () => {
    const onPreviewFile = vi.fn();
    render(<ToolCallBlock message={toolMessage("apply_patch", "update")} onPreviewFile={onPreviewFile} />);
    fireEvent.click(screen.getByRole("button", { name: "展开工具详情" }));
    await waitFor(() => expect(compactProps).not.toBeNull());
    const props = compactProps as {
      actions: { copyPatch: (patch: string) => Promise<void>; openFile: (path: string) => void };
    };

    await props.actions.copyPatch("exact patch");
    props.actions.openFile("src/app.ts");

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("exact patch");
    expect(onPreviewFile).toHaveBeenCalledWith(expect.objectContaining({
      path: "src/app.ts",
      files: expect.any(Array),
      message: expect.objectContaining({ id: "tool-pierre" }),
    }));
  });
});

function toolMessage(
  tool: string,
  operation: string,
  path = "src/app.ts",
  diff = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`,
  state: "completed" | "failed" = "completed",
): ConversationMessage {
  return {
    id: "tool-pierre",
    threadId: "thread",
    turnId: "turn",
    itemId: "item",
    kind: "tool",
    itemType: "tool_call",
    status: state,
    content: tool,
    payload: {
      call: {
        name: tool,
        arguments: { path, new_path: path, ...(diff ? { content: "new", patch: diff } : {}) },
      },
      result: {
        status: state === "failed" ? "error" : "success",
        ...(state === "failed" ? { error: "patch failed" } : {}),
        files: [{ path, operation, added_lines: 1, deleted_lines: 1, diff }],
      },
    },
    createdAt: "2026-07-17T00:00:00Z",
    updatedAt: "2026-07-17T00:00:01Z",
  };
}

function ordinaryToolMessage(): ConversationMessage {
  return {
    id: "ordinary",
    threadId: "thread",
    turnId: "turn",
    itemId: "item-ordinary",
    kind: "tool",
    itemType: "tool_call",
    status: "completed",
    content: "read_file",
    payload: {
      call: { name: "read_file", arguments: { path: "README.md" } },
      result: { status: "success", model_content: "content" },
    },
    createdAt: "2026-07-17T00:00:00Z",
    updatedAt: "2026-07-17T00:00:01Z",
  };
}
