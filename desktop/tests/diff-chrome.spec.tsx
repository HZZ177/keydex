import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  KeydexDiffFileHeaderChrome,
  KeydexDiffHunkSeparator,
  keydexDiffFileHeaderPresentation,
  splitDisplayPath,
} from "@/renderer/components/diff/DiffChrome";
import { createKeydexDiffFile, type KeydexDiffFileInput } from "@/renderer/components/diff/model";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Keydex Diff 文件头与 hunk chrome", () => {
  it("keeps the file name before the ghost directory without attaching a tooltip to the whole row", () => {
    render(
      <KeydexDiffFileHeaderChrome
        presentation={{
          fileName: "AFileNameThatMustStayReadable.tsx",
          directoryPath: "desktop/src/renderer/a/very/long/path",
          fullPath: "desktop/src/renderer/a/very/long/path/AFileNameThatMustStayReadable.tsx",
          status: "modified",
          statusLabel: "修改",
          additions: 12,
          deletions: 3,
          metadata: [],
        }}
      />,
    );
    const header = screen.getByRole("group");
    const fileName = screen.getByText("AFileNameThatMustStayReadable.tsx");
    expect(header.textContent).toBe("AFileNameThatMustStayReadable.tsxdesktop/src/renderer/a/very/long/path修改+12-3");
    expect(header.getAttribute("title")).toBeNull();
    expect(header.getAttribute("data-tooltip-label")).toBeNull();
    expect(fileName.getAttribute("data-tooltip-label")).toBeNull();
    expect(header.querySelector("[data-status='modified']")?.textContent).toBe("修改");
  });

  it("exposes the complete file name only when the file-name element is actually truncated", () => {
    let resize: ResizeObserverCallback | null = null;
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) {
        resize = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    });
    render(
      <KeydexDiffFileHeaderChrome
        presentation={{
          fileName: "AFileNameThatIsVisuallyTruncated.tsx",
          directoryPath: "desktop/src/renderer",
          fullPath: "desktop/src/renderer/AFileNameThatIsVisuallyTruncated.tsx",
          status: "modified",
          statusLabel: "修改",
          additions: 1,
          deletions: 1,
          metadata: [],
        }}
        actions={<button type="button">审阅操作</button>}
      />,
    );
    const fileName = screen.getByText("AFileNameThatIsVisuallyTruncated.tsx");
    Object.defineProperty(fileName, "clientWidth", { configurable: true, value: 80 });
    Object.defineProperty(fileName, "scrollWidth", { configurable: true, value: 240 });
    act(() => {
      resize?.([], {} as ResizeObserver);
    });
    expect(fileName.getAttribute("data-tooltip-label")).toBe("AFileNameThatIsVisuallyTruncated.tsx");
    expect(screen.getByRole("button", { name: "审阅操作" }).getAttribute("data-tooltip-label")).toBeNull();
    expect(screen.getByRole("group").getAttribute("data-tooltip-label")).toBeNull();
  });

  it.each([
    ["added", "新增"],
    ["modified", "修改"],
    ["deleted", "删除"],
    ["copied", "复制"],
    ["type_changed", "类型变化"],
    ["unknown", "变更"],
  ] as const)("maps %s to a Chinese status", (status, label) => {
    const presentation = keydexDiffFileHeaderPresentation(file({ status }));
    expect(presentation.statusLabel).toBe(label);
  });

  it("preserves rename, mode, binary and truncation metadata as secondary information", () => {
    const renamed = file({
      status: "renamed",
      oldPath: "old/name.ts",
      newPath: "new/name.ts",
      displayPath: "new/name.ts",
      oldMode: "100644",
      newMode: "100755",
      truncated: true,
    });
    expect(keydexDiffFileHeaderPresentation(renamed).metadata).toEqual([
      "old/name.ts → new/name.ts",
      "模式 100644 → 100755",
      "内容已截断",
    ]);
    const binary = file({ binary: true, contentKind: "binary", patch: "" });
    expect(keydexDiffFileHeaderPresentation(binary).metadata).toContain("二进制");
  });

  it("splits Windows and POSIX display paths without changing their visual order", () => {
    expect(splitDisplayPath("src\\feature\\View.tsx")).toEqual({
      fileName: "View.tsx",
      directoryPath: "src/feature",
    });
    expect(splitDisplayPath("README.md")).toEqual({ fileName: "README.md", directoryPath: "" });
  });

  it("expands hidden context with a Chinese keyboard-accessible button", () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <KeydexDiffHunkSeparator label="@@ -10,4 +10,6 @@" hiddenLineCount={24} onToggle={onToggle} />,
    );
    const button = screen.getByRole("button", { name: "展开 24 行未更改内容" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledTimes(1);
    rerender(
      <KeydexDiffHunkSeparator
        label="@@ -10,4 +10,6 @@"
        hiddenLineCount={24}
        expanded
        onToggle={onToggle}
      />,
    );
    expect(screen.getByRole("button", { name: "收起 24 行上下文" }).getAttribute("aria-expanded"))
      .toBe("true");
  });

  it("distinguishes disabled and non-interactive context states", () => {
    const { rerender } = render(
      <KeydexDiffHunkSeparator label="@@ -1 +1 @@" hiddenLineCount={1} disabled onToggle={() => {}} />,
    );
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
    rerender(<KeydexDiffHunkSeparator label="@@ -1 +1 @@" hiddenLineCount={5} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("5 行未更改内容")).not.toBeNull();
  });

  it("uses semantic tokens, rectangular controls, responsive metadata hiding and no raw colors", () => {
    const css = readFileSync(resolve(process.cwd(), "src/renderer/components/diff/DiffChrome.module.css"), "utf8");
    expect(css).toContain("var(--diff-header-bg)");
    expect(css).toContain("var(--diff-hunk-bg)");
    expect(css).toContain("border-radius: var(--radius-sm)");
    expect(css).toContain(".secondary .metadata");
    expect(css).not.toMatch(/#[\da-f]{3,8}/iu);
    expect(css).not.toContain("var(--radius-pill)");
  });
});

function file(overrides: Partial<KeydexDiffFileInput> = {}) {
  return createKeydexDiffFile({
    id: "file-1",
    oldPath: "src/View.tsx",
    newPath: "src/View.tsx",
    displayPath: "src/View.tsx",
    status: "modified",
    patch: "@@ -1 +1 @@\n-old\n+new\n",
    cacheKey: "file-1:v1",
    additions: 1,
    deletions: 1,
    ...overrides,
  });
}
