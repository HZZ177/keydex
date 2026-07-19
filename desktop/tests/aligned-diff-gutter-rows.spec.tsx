import { render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { AlignedDiffGutterRows } from "@/renderer/components/diff/aligned/AlignedDiffGutterRows";
import type { DiffPaneRow } from "@/renderer/components/diff/aligned/alignedDiffModel";

describe("AlignedDiffGutterRows", () => {
  it("uses the shared vertical model while keeping line numbers out of code rows", () => {
    const rows = [row("old", "context", 33), row("old", "removed", 34)];
    const { container } = render(
      <AlignedDiffGutterRows
        rows={rows}
        rowIndexes={[0, 1]}
        rowOffsets={[0, 20, 52]}
        totalHeight={52}
        activeChangeId="change:1"
        changeKindById={new Map([["change:1", "modified"]])}
      />,
    );
    const gutterRows = container.querySelectorAll<HTMLElement>("[data-keydex-aligned-gutter-row]");
    expect(gutterRows).toHaveLength(2);
    expect(gutterRows[0]!.textContent).toBe("33");
    expect(gutterRows[0]!.style.getPropertyValue("--keydex-diff-gutter-row-offset")).toBe("0px");
    expect(gutterRows[1]!.textContent).toContain("34");
    expect(gutterRows[1]!.getAttribute("data-change-kind")).toBe("modified");
    expect(gutterRows[1]!.getAttribute("data-change-start")).toBe("true");
    expect(gutterRows[1]!.getAttribute("data-change-end")).toBe("true");
    expect(gutterRows[1]!.getAttribute("data-active")).toBe("true");
    expect(gutterRows[1]!.style.getPropertyValue("--keydex-diff-gutter-row-height")).toBe("32px");
  });

  it("keeps one inside-aligned boundary pixel while containing gutter text", () => {
    const css = readFileSync(
      resolve(process.cwd(), "src/renderer/components/diff/aligned/AlignedDiffGutterRows.module.css"),
      "utf8",
    );
    expect(css).toMatch(/\.row\s*{[^}]*overflow:\s*visible/s);
    expect(css).toMatch(/\.lineNumber\s*{[^}]*overflow:\s*hidden/s);
    expect(css).toMatch(/\.indicator\s*{[^}]*overflow:\s*hidden/s);
    expect(css).toMatch(/height:\s*var\(--keydex-diff-edge-width,\s*1px\)/s);
    expect(css).toMatch(/data-change-start="true"\]::before\s*{[^}]*top:\s*0/s);
    expect(css).toMatch(/data-change-end="true"\]::after\s*{[^}]*bottom:\s*0/s);
    expect(css).not.toMatch(/translateY\(/s);
  });
});

function row(side: "old" | "new", kind: DiffPaneRow["kind"], lineNumber: number): DiffPaneRow {
  return {
    id: `${side}:${lineNumber}`,
    fileId: "file:1",
    side,
    kind,
    lineNumber,
    sourceIndex: lineNumber,
    segmentId: "segment:1",
    changeId: kind === "context" ? null : "change:1",
    hunkId: "hunk:1",
    text: `line ${lineNumber}`,
    tokens: [{ type: "text", value: `line ${lineNumber}` }],
    noTrailingNewline: false,
    estimatedHeight: 20,
  };
}
