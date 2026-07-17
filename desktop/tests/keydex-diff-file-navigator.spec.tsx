import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  KeydexDiffFileNavigator,
  resolveKeydexDiffFileWindow,
} from "@/renderer/components/diff/KeydexDiffFileNavigator";
import { normalizeUnifiedPatch } from "@/renderer/components/diff/normalizers/unifiedPatch";

const files = Array.from({ length: 500 }, (_, index) => normalizeUnifiedPatch(
  `diff --git a/src/file-${index}.ts b/src/file-${index}.ts\n--- a/src/file-${index}.ts\n+++ b/src/file-${index}.ts\n@@ -1 +1 @@\n-old\n+new\n`,
  { source: "preview", sourceVersion: `v-${index}` },
).files[0]!);

describe("KeydexDiffFileNavigator", () => {
  it.each([
    [1, 0, 0, 1],
    [50, 0, 0, 12],
    [500, 34 * 250, 246, 262],
  ])("bounds the virtual window for %i files", (count, top, start, end) => {
    expect(resolveKeydexDiffFileWindow(count, top)).toMatchObject({ start, end });
  });

  it("filters files without changing their source order", () => {
    renderNavigator(files.slice(0, 50));
    fireEvent.click(screen.getByRole("button", { name: /50 个变更文件/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "筛选变更文件" }), { target: { value: "file-4" } });
    expect(screen.getAllByRole("option").map((item) => item.textContent)).toEqual([
      expect.stringContaining("file-4.ts"),
      expect.stringContaining("file-40.ts"),
      expect.stringContaining("file-41.ts"),
      expect.stringContaining("file-42.ts"),
      expect.stringContaining("file-43.ts"),
      expect.stringContaining("file-44.ts"),
      expect.stringContaining("file-45.ts"),
      expect.stringContaining("file-46.ts"),
      expect.stringContaining("file-47.ts"),
      expect.stringContaining("file-48.ts"),
      expect.stringContaining("file-49.ts"),
    ]);
  });

  it("selects and folds files through controlled callbacks", () => {
    const onActiveFileChange = vi.fn();
    const onExpandedFilesChange = vi.fn();
    render(
      <KeydexDiffFileNavigator
        files={files.slice(0, 2)}
        activeFileId={files[0]!.id}
        expandedFileIds={[files[0]!.id]}
        defaultOpen
        onActiveFileChange={onActiveFileChange}
        onExpandedFilesChange={onExpandedFilesChange}
      />,
    );
    fireEvent.click(screen.getByRole("option", { name: /file-1.ts/ }));
    expect(onActiveFileChange).toHaveBeenCalledWith(files[1]!.id);
    fireEvent.click(screen.getByRole("button", { name: /收起 src\/file-0.ts/ }));
    expect(onExpandedFilesChange).toHaveBeenCalledWith([]);
  });

  it("renders only the virtualized window for 500 files", () => {
    renderNavigator(files);
    fireEvent.click(screen.getByRole("button", { name: /500 个变更文件/ }));
    expect(screen.getAllByRole("option")).toHaveLength(12);
  });

  it("exposes stable Chinese names for the disclosure and filter controls", () => {
    renderNavigator(files.slice(0, 2));
    const disclosure = screen.getByRole("button", { name: /展开差异文件导航，2 个变更文件/ });
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(disclosure);
    expect(screen.getByRole("textbox", { name: "筛选变更文件" })).toBeTruthy();
  });
});

function renderNavigator(items = files.slice(0, 2)) {
  return render(
    <KeydexDiffFileNavigator
      files={items}
      activeFileId={items[0]?.id ?? null}
      onActiveFileChange={vi.fn()}
    />,
  );
}
