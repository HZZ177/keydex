import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SendBox } from "@/renderer/components/chat/SendBox";
import {
  composeMessageWithSelectedFiles,
  fileSelectionReducer,
  initialFileSelectionState,
  selectedFileKey,
  selectedFileFromFile,
} from "@/renderer/components/chat/SendBox/fileSelection";
import type { DesktopFileDragDropEvent, DesktopFileDragDropListener, RuntimeBridge } from "@/runtime";

describe("SendBox file selection", () => {
  it("adds and removes file chips through the reducer", () => {
    const state = fileSelectionReducer(initialFileSelectionState, {
      type: "add",
      file: { path: "src/main.ts", name: "main.ts", type: "file", source: "workspace" },
    });

    expect(state.files.map((file) => file.path)).toEqual(["src/main.ts"]);
    expect(
      fileSelectionReducer(state, {
        type: "remove",
        id: selectedFileKey(state.files[0]),
      }).files,
    ).toEqual([]);
  });

  it("keeps selected files out of the visible user message text", () => {
    expect(
      composeMessageWithSelectedFiles("analyze this", [
        { path: "src/main.ts", name: "main.ts", type: "file", source: "workspace" },
      ]),
    ).toBe("analyze this");
  });

  it("keeps same-path annotation files separate while preserving normal file dedupe", () => {
    const first = {
      id: "annotation:ann-1",
      path: "README.md",
      name: "README.md",
      type: "file" as const,
      source: "workspace" as const,
      annotationReference: { annotationId: "ann-1", workspaceId: "ws-1", path: "README.md" },
    };
    const second = {
      id: "annotation:ann-2",
      path: "README.md",
      name: "README.md",
      type: "file" as const,
      source: "workspace" as const,
      annotationReference: { annotationId: "ann-2", workspaceId: "ws-1", path: "README.md" },
    };
    const state = fileSelectionReducer(initialFileSelectionState, {
      type: "addMany",
      files: [first, second],
    });

    expect(state.files).toHaveLength(2);
    expect(
      fileSelectionReducer(state, {
        type: "add",
        file: first,
      }).files,
    ).toHaveLength(2);
    expect(
      fileSelectionReducer(state, {
        type: "remove",
        id: selectedFileKey(first),
      }).files,
    ).toEqual([second]);
  });

  it("extracts file references without reading file content", () => {
    const file = new File(["secret content"], "main.ts");
    Object.defineProperty(file, "path", { value: "src/main.ts" });

    expect(selectedFileFromFile(file, "dropped")).toEqual({
      path: "src/main.ts",
      name: "main.ts",
      type: "file",
      source: "dropped",
    });
  });

  it("does not use a bare browser filename as a file path", () => {
    const file = new File(["secret content"], "main.ts");

    expect(selectedFileFromFile(file, "pasted")).toBeNull();
  });

  it("adds dropped files as removable chips", () => {
    render(<FileSendBox />);
    const form = screen.getByRole("form", { name: "继续对话输入" });
    const file = new File(["content is not read"], "main.ts");
    Object.defineProperty(file, "path", { value: "src/main.ts" });

    fireEvent.dragOver(form, { dataTransfer: { types: ["Files"], files: [file] } });
    expect(form.getAttribute("data-dragging")).toBe("true");
    expect(screen.getByRole("status").textContent).toContain("松开以添加文件");
    fireEvent.drop(form, { dataTransfer: { types: ["Files"], files: [file] } });

    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByLabelText("已添加上下文").textContent).toContain("main.ts");
    fireEvent.click(screen.getByRole("button", { name: "移除文件引用 src/main.ts" }));
    expect(screen.queryByLabelText("移除文件引用 src/main.ts")).toBeNull();
  });

  it("adds native desktop drops by absolute path only when they target this send box", async () => {
    const fixture = nativeDropRuntime();
    const { unmount } = render(<FileSendBox runtime={fixture.runtime} fileAccessMode="full_access" />);
    const form = screen.getByRole("form", { name: "继续对话输入" });
    vi.spyOn(form, "getBoundingClientRect").mockReturnValue({
      bottom: 160,
      height: 120,
      left: 20,
      right: 320,
      top: 40,
      width: 300,
      x: 20,
      y: 40,
      toJSON: () => ({}),
    });
    await waitFor(() => expect(fixture.listenForFileDragDrop).toHaveBeenCalledTimes(1));

    fixture.emit({ type: "over", position: { x: 400, y: 300 } });
    expect(form.getAttribute("data-dragging")).toBe("false");
    fixture.emit({
      type: "drop",
      paths: ["D:\\outside\\ignored.txt"],
      position: { x: 400, y: 300 },
    });
    expect(screen.queryByLabelText("移除文件引用 D:\\outside\\ignored.txt")).toBeNull();

    fixture.emit({ type: "over", position: { x: 120, y: 80 } });
    expect(form.getAttribute("data-dragging")).toBe("true");
    fixture.emit({
      type: "drop",
      paths: ["D:\\outside\\notes.txt"],
      position: { x: 120, y: 80 },
    });

    expect(await screen.findByLabelText("移除文件引用 D:\\outside\\notes.txt")).not.toBeNull();
    unmount();
    expect(fixture.unlisten).toHaveBeenCalledTimes(1);
  });

  it("rejects pasted files without a native path instead of creating temporary file chips", async () => {
    const runtime = fileRuntime();
    render(<FileSendBox runtime={runtime} />);
    const file = new File(["content is not read"], "notes.txt", { type: "text/plain" });

    fireEvent.paste(screen.getByLabelText("继续输入"), {
      clipboardData: { files: [file] },
    });

    expect(await screen.findByText(/无法获取源文件路径/)).not.toBeNull();
    expect(runtime.attachments.uploadLocalFile).not.toHaveBeenCalled();
  });
});

function FileSendBox({
  runtime,
  fileAccessMode,
}: {
  runtime?: RuntimeBridge;
  fileAccessMode?: "no_file_access" | "workspace_read_only" | "workspace_trusted" | "full_access";
}) {
  return (
    <SendBox
      value=""
      runtimeState="idle"
      canSend={false}
      canStop={false}
      onChange={vi.fn()}
      onSend={vi.fn()}
      onStop={vi.fn()}
      runtime={runtime}
      fileAccessMode={fileAccessMode}
    />
  );
}

function nativeDropRuntime(): {
  runtime: RuntimeBridge;
  listenForFileDragDrop: ReturnType<typeof vi.fn>;
  unlisten: ReturnType<typeof vi.fn>;
  emit(event: DesktopFileDragDropEvent): void;
} {
  let listener: DesktopFileDragDropListener | null = null;
  const unlisten = vi.fn();
  const listenForFileDragDrop = vi.fn(async (nextListener: DesktopFileDragDropListener) => {
    listener = nextListener;
    return unlisten;
  });
  return {
    runtime: {
      desktopPicker: {
        listenForFileDragDrop,
      },
    } as unknown as RuntimeBridge,
    listenForFileDragDrop,
    unlisten,
    emit(event) {
      act(() => listener?.(event));
    },
  };
}

function fileRuntime(): RuntimeBridge {
  return {
    attachments: {
      uploadLocalFile: vi.fn().mockResolvedValue({
        id: "local-file-1",
        source: "pasted",
        name: "notes.txt",
        path: "D:/keydex/local-files/notes.txt",
        mime_type: "text/plain",
        size: 19,
      }),
    },
    desktopPicker: {
      isFilePickerAvailable: vi.fn().mockReturnValue(false),
    },
  } as unknown as RuntimeBridge;
}
