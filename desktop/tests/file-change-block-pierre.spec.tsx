import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { FileChangeBlock } from "@/renderer/pages/conversation/messages/FileChangeBlock";
import type { ConversationMessage } from "@/renderer/stores/conversationStore";

let compactProps: Record<string, unknown> | null = null;
vi.mock("@/renderer/components/diff/wrappers/CompactDiffView", () => ({
  CompactDiffView: (props: Record<string, unknown>) => {
    compactProps = props;
    const document = props.document as { files: Array<{ displayPath: string }> };
    return <div data-testid="file-change-pierre">{document.files.map((file) => file.displayPath).join(",")}</div>;
  },
}));

describe("FileChangeBlock unified Diff", () => {
  it("uses one compact document for a single final file", () => {
    render(<FileChangeBlock message={message([file("src/a.ts")])} />);
    fireEvent.click(screen.getByRole("button", { name: "展开文件变更详情" }));
    expect(screen.getByTestId("file-change-pierre").textContent).toBe("src/a.ts");
    expect(screen.queryByTestId("file-review-diff")).toBeNull();
  });

  it("uses one multi-file document and focuses the selected middle file", () => {
    render(<FileChangeBlock message={message([file("src/a.ts"), file("src/b.ts"), file("src/c.ts")])} />);
    fireEvent.click(screen.getByRole("button", { name: "展开文件变更详情" }));
    fireEvent.click(screen.getByRole("button", { name: /src\/b.ts/ }));
    expect(screen.getByTestId("file-change-pierre").textContent).toBe("src/a.ts,src/b.ts,src/c.ts");
    const props = compactProps as { document: { files: Array<{ id: string; displayPath: string }> }; activeFileId: string };
    expect(props.document.files.find((item) => item.id === props.activeFileId)?.displayPath).toBe("src/b.ts");
  });

  it("replaces streaming metadata with deferred final details without duplicate files", async () => {
    const initial = message([{ ...file("src/a.ts"), diff: "" }]);
    initial.payload.toolDetailsDeferred = true;
    const onLoadDetails = vi.fn().mockResolvedValue(message([file("src/a.ts"), file("src/b.ts")]));
    render(<FileChangeBlock message={initial} onLoadDetails={onLoadDetails} />);
    fireEvent.click(screen.getByRole("button", { name: "展开文件变更详情" }));
    await waitFor(() => expect(screen.getByTestId("file-change-pierre").textContent).toBe("src/a.ts,src/b.ts"));
    const props = compactProps as { document: { files: unknown[] } };
    expect(props.document.files).toHaveLength(2);
  });

  it("keeps preview callbacks on file rows while Diff rendering remains local", () => {
    const onPreviewFile = vi.fn();
    render(<FileChangeBlock message={message([file("src/a.ts"), file("src/b.ts")])} onPreviewFile={onPreviewFile} />);
    fireEvent.click(screen.getByRole("button", { name: "展开文件变更详情" }));
    fireEvent.click(screen.getAllByRole("button", { name: "预览" })[1]!);
    expect(onPreviewFile).toHaveBeenCalledWith(expect.objectContaining({ path: "src/b.ts" }));
  });

  it("routes the compact header open action to the conversation sidebar preview", () => {
    const onPreviewFile = vi.fn();
    render(<FileChangeBlock message={message([file("src/a.ts")])} onPreviewFile={onPreviewFile} />);
    fireEvent.click(screen.getByRole("button", { name: "展开文件变更详情" }));
    const actions = (compactProps as { actions: { openFile?: (path: string) => void } }).actions;
    actions.openFile?.("src/a.ts");
    expect(onPreviewFile).toHaveBeenCalledWith(expect.objectContaining({
      path: "src/a.ts",
      document: expect.objectContaining({ files: expect.any(Array) }),
    }));
  });
});

function file(path: string) {
  return {
    path,
    operation: "update",
    added_lines: 1,
    deleted_lines: 1,
    diff: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`,
  };
}

function message(files: ReturnType<typeof file>[]): ConversationMessage {
  return {
    id: "change",
    threadId: "thread",
    turnId: "turn",
    itemId: "item",
    kind: "file_change",
    itemType: "file_change",
    status: "completed",
    content: "",
    payload: { result: { status: "success", files } },
    createdAt: "2026-07-17T00:00:00Z",
    updatedAt: "2026-07-17T00:00:01Z",
  };
}
