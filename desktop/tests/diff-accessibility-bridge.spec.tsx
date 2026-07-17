import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  KeydexDiffAccessibilityBridge,
  keydexDiffAccessibleName,
  keydexDiffDocumentSummary,
  keydexDiffFileAccessibleName,
  keydexDiffLineAccessibleName,
  keydexDiffSelectionAccessibleName,
} from "@/renderer/components/diff/DiffAccessibility";
import { KeydexDiffLoadingState } from "@/renderer/components/diff/DiffBoundary";
import {
  KeydexDiffFileHeaderChrome,
  keydexDiffFileHeaderPresentation,
} from "@/renderer/components/diff/DiffChrome";
import { normalizeUnifiedPatch } from "@/renderer/components/diff/normalizers/unifiedPatch";

const document = normalizeUnifiedPatch(
  "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n-old\n+new\n+next\n",
  { source: "git", sourceVersion: "v1" },
);
const file = document.files[0]!;

describe("Keydex Diff accessibility bridge", () => {
  it("generates stable Chinese names for viewer, document and file statistics", () => {
    expect(keydexDiffDocumentSummary(document)).toBe("共 1 个文件，新增 2 行，删除 1 行");
    expect(keydexDiffFileAccessibleName(file)).toContain("src/a.ts，修改文件，新增 2 行，删除 1 行");
    expect(keydexDiffAccessibleName({ profile: "git", document })).toContain("Git 差异：共 1 个文件");
  });

  it.each([
    ["added", null, 7, "+const ready = true", "新增行 7：const ready = true"],
    ["removed", 4, null, "-old", "删除行 4：old"],
    ["context", 5, 5, " same", "未更改行 5：same"],
  ] as const)("describes %s lines without reading decorative signs twice", (
    kind,
    oldLine,
    newLine,
    content,
    expected,
  ) => {
    expect(keydexDiffLineAccessibleName({ kind, oldLine, newLine, content })).toBe(expected);
  });

  it("describes a cross-side controlled selection", () => {
    expect(keydexDiffSelectionAccessibleName({
      anchor: { fileId: file.id, fileCacheKey: file.cacheKey, side: "old", line: 2 },
      focus: { fileId: file.id, fileCacheKey: file.cacheKey, side: "new", line: 4 },
    })).toBe("已选择原文件第 2 行到新文件第 4 行");
  });

  it("owns a public region, busy state and polite live announcement", () => {
    render(
      <KeydexDiffAccessibilityBridge profile="review" document={document} busy>
        <div>公开差异容器</div>
      </KeydexDiffAccessibilityBridge>,
    );
    const region = screen.getByRole("region", { name: /文件审阅差异/ });
    expect(region.getAttribute("aria-busy")).toBe("true");
    const live = region.querySelector("[aria-live='polite']");
    expect(live?.textContent).toBe("正在更新差异内容");
    expect(screen.getByText("公开差异容器")).toBeTruthy();
  });

  it("marks visible statistic signs decorative while exposing one Chinese summary", () => {
    const presentation = keydexDiffFileHeaderPresentation(file);
    render(<KeydexDiffFileHeaderChrome presentation={presentation} />);
    const header = screen.getByRole("group", { name: /src\/a.ts/ });
    const stats = header.querySelector("[aria-label='新增 2 行，删除 1 行']");
    expect(stats).toBeTruthy();
    expect(stats?.querySelectorAll("[aria-hidden='true']").length).toBe(2);
  });

  it("announces loading without depending on Pierre shadow content", () => {
    render(<KeydexDiffLoadingState profile="preview" />);
    const status = screen.getByRole("status", { name: "正在准备差异" });
    expect(status.getAttribute("aria-busy")).toBe("true");
  });
});
