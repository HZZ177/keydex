import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  KeydexDiffAnnotationSlot,
  keydexHunkActionAnnotation,
  reduceKeydexDiffAnnotations,
  toPierreDiffAnnotations,
  type KeydexDiffAnnotation,
} from "@/renderer/components/diff/DiffAnnotations";
import { pierrePatchDiffProps } from "@/renderer/components/diff/engine/PierrePatchDiff";
import { normalizeUnifiedPatch } from "@/renderer/components/diff/normalizers/unifiedPatch";

const file = normalizeUnifiedPatch(
  "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
  { source: "git", sourceVersion: "v1" },
).files[0]!;

afterEach(cleanup);

describe("Keydex Diff annotations", () => {
  it("maps stable side/line metadata through Pierre's official annotation props", () => {
    const annotation = diagnostic({ id: "diagnostic-1", side: "new", line: 1 });
    expect(toPierreDiffAnnotations(file, [annotation])).toEqual([
      { side: "additions", lineNumber: 1, metadata: annotation },
    ]);
    const props = pierrePatchDiffProps(file, {
      profile: "git",
      theme: "light",
      annotations: [annotation],
    });
    expect(props.lineAnnotations).toHaveLength(1);
    expect(props.renderAnnotation).toBeTypeOf("function");
    expect(props.options).toMatchObject({ useTokenTransformer: false });
  });

  it("filters annotations for old versions, other files and invisible lines", () => {
    expect(toPierreDiffAnnotations(file, [
      diagnostic({ id: "old", fileCacheKey: `${file.cacheKey}:old` }),
      diagnostic({ id: "other", fileId: "other" }),
      diagnostic({ id: "missing", line: 999 }),
    ])).toEqual([]);
  });

  it("supports file-level diagnostics at line zero", () => {
    const annotation = diagnostic({ id: "file-error", line: 0, tone: "error" });
    expect(toPierreDiffAnnotations(file, [annotation])[0]).toMatchObject({ lineNumber: 0 });
  });

  it("anchors hunk actions to a visible side and forwards the Keydex action", () => {
    const onAction = vi.fn();
    const annotation = keydexHunkActionAnnotation(file, file.hunks[0]!.id, {
      id: "stage-hunk",
      message: "可暂存这个变更块",
      tone: "neutral",
      actionId: "stage",
      actionLabel: "暂存变更块",
    });
    render(<KeydexDiffAnnotationSlot annotation={annotation} onAction={onAction} />);
    fireEvent.click(screen.getByRole("button", { name: "暂存变更块" }));
    expect(onAction).toHaveBeenCalledWith(annotation);
    expect(annotation).toMatchObject({ kind: "hunk_action", side: "new", line: 1 });
  });

  it("uses icon feedback for queued, success, and error hunk actions without inline processing text", () => {
    const base = keydexHunkActionAnnotation(file, file.hunks[0]!.id, {
      id: "stage-hunk-state",
      message: "可暂存这个变更块",
      tone: "neutral",
      actionId: "stage",
      actionLabel: "暂存变更块",
    });
    const { rerender } = render(
      <KeydexDiffAnnotationSlot
        annotation={{ ...base, actionState: "queued" }}
        onAction={vi.fn()}
      />,
    );
    const queued = screen.getByRole("button", { name: "暂存变更块中" });
    expect(queued.getAttribute("aria-busy")).toBe("true");
    expect(queued.textContent).toBe("暂存变更块");
    expect(screen.queryByText("处理中…")).toBeNull();

    rerender(<KeydexDiffAnnotationSlot annotation={{ ...base, actionState: "success" }} onAction={vi.fn()} />);
    expect(screen.getByRole("button", { name: "暂存变更块成功" })).toBeTruthy();
    rerender(<KeydexDiffAnnotationSlot annotation={{ ...base, actionState: "error" }} onAction={vi.fn()} />);
    expect(screen.getByRole("button", { name: "暂存变更块失败" })).toBeTruthy();
  });

  it("updates and removes annotations by stable id", () => {
    const initial = reduceKeydexDiffAnnotations([], {
      type: "upsert",
      annotation: diagnostic({ id: "same", message: "第一次" }),
    });
    const updated = reduceKeydexDiffAnnotations(initial, {
      type: "upsert",
      annotation: diagnostic({ id: "same", message: "第二次" }),
    });
    expect(updated).toHaveLength(1);
    expect(updated[0]?.message).toBe("第二次");
    expect(reduceKeydexDiffAnnotations(updated, { type: "remove", id: "same" })).toEqual([]);
  });

  it("renders diagnostic and future comment placeholders without persistence behavior", () => {
    const { rerender } = render(<KeydexDiffAnnotationSlot annotation={diagnostic({ id: "error", tone: "error" })} />);
    expect(screen.getByRole("alert")).not.toBeNull();
    rerender(<KeydexDiffAnnotationSlot annotation={diagnostic({
      id: "comment",
      kind: "comment_placeholder",
      message: "评论能力预留位置",
    })} />);
    expect(screen.getByRole("note").getAttribute("data-keydex-diff-annotation"))
      .toBe("comment_placeholder");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("uses only semantic tokens and rectangular Keydex controls", () => {
    const css = readFileSync(resolve(process.cwd(), "src/renderer/components/diff/DiffAnnotations.module.css"), "utf8");
    expect(css).toContain("var(--diff-annotation-bg)");
    expect(css).toContain("border-radius: var(--radius-sm)");
    expect(css).not.toContain("var(--radius-pill)");
    expect(css).not.toMatch(/#[\da-f]{3,8}/iu);
  });
});

function diagnostic(overrides: Partial<KeydexDiffAnnotation>): KeydexDiffAnnotation {
  return {
    id: "diagnostic",
    fileId: file.id,
    fileCacheKey: file.cacheKey,
    kind: "diagnostic",
    side: "new",
    line: 1,
    message: "差异诊断提示",
    tone: "warning",
    ...overrides,
  };
}
