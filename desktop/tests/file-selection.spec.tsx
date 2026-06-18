import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SendBox } from "@/renderer/components/chat/SendBox";
import {
  fileSelectionReducer,
  initialFileSelectionState,
  selectedFileFromFile,
} from "@/renderer/components/chat/SendBox/fileSelection";

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
        path: "src/main.ts",
      }).files,
    ).toEqual([]);
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

  it("adds dropped files as removable chips", () => {
    render(<FileSendBox />);
    const form = screen.getByRole("form", { name: "继续对话输入" });
    const file = new File(["content is not read"], "main.ts");
    Object.defineProperty(file, "path", { value: "src/main.ts" });

    fireEvent.dragOver(form, { dataTransfer: { types: ["Files"], files: [file] } });
    expect(form.getAttribute("data-dragging")).toBe("true");
    fireEvent.drop(form, { dataTransfer: { types: ["Files"], files: [file] } });

    expect(screen.getByRole("button", { name: "移除文件 src/main.ts" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "移除文件 src/main.ts" }));
    expect(screen.queryByRole("button", { name: "移除文件 src/main.ts" })).toBeNull();
  });

  it("shows an error for pasted files without a usable path", () => {
    render(<FileSendBox />);
    const file = new File(["content is not read"], "");

    fireEvent.paste(screen.getByLabelText("继续输入"), {
      clipboardData: { files: [file] },
    });

    expect(screen.getByText("不支持的文件，无法获取路径")).not.toBeNull();
  });
});

function FileSendBox() {
  return (
    <SendBox
      value=""
      runtimeState="idle"
      canSend={false}
      canStop={false}
      onChange={vi.fn()}
      onSend={vi.fn()}
      onStop={vi.fn()}
    />
  );
}
