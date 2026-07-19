import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  AlignedDiffRow,
  diffPaneRowCopyText,
  diffPaneRowPresentation,
  diffChangeRowBoundary,
} from "@/renderer/components/diff/aligned/AlignedDiffRow";
import type { DiffPaneRow } from "@/renderer/components/diff/aligned/alignedDiffModel";
import {
  diffPhysicalPixelWidth,
  isAlignedDiffRowActive,
  widestDiffLineColumns,
} from "@/renderer/components/diff/aligned/AlignedDiffFileView";

function row(overrides: Partial<DiffPaneRow> = {}): DiffPaneRow {
  return {
    id: "row:1",
    fileId: "file:1",
    side: "new",
    kind: "added",
    lineNumber: 12,
    sourceIndex: 0,
    segmentId: "segment:1",
    changeId: "change:1",
    hunkId: "hunk:1",
    text: "\tconst value = '新内容';",
    tokens: [{
      type: "span",
      classNames: ["token", "inserted-word"],
      attributes: { "data-diff-span": "" },
      children: [{ type: "text", value: "\tconst value = '新内容';" }],
    }],
    noTrailingNewline: false,
    estimatedHeight: 20,
    ...overrides,
  };
}

describe("AlignedDiffRow", () => {
  it("renders stable line number, semantic indicator and syntax tokens", () => {
    const current = row();
    const { container } = render(<AlignedDiffRow row={current} wrap={false} lineNumberDigits={4} />);
    const element = container.querySelector<HTMLElement>('[data-keydex-aligned-row="row:1"]')!;
    expect(element.getAttribute("data-kind")).toBe("added");
    expect(element.getAttribute("data-change-kind")).toBe("added");
    expect(element.getAttribute("data-change-id")).toBe("change:1");
    expect(element.getAttribute("data-copy-text")).toBe(current.text);
    expect(element.style.getPropertyValue("--keydex-diff-line-number-digits")).toBe("4");
    expect(screen.getByRole("row", { name: "第 12 行，新增" })).toBeTruthy();
    expect(screen.getByRole("gridcell").textContent).toBe(current.text);
    expect(screen.getByRole("gridcell").querySelector("[data-diff-span]")).toBeTruthy();
  });

  it("keeps the whole change block modified while preserving a surplus added row", () => {
    const current = row({ kind: "added", side: "new" });
    const { container } = render(
      <AlignedDiffRow row={current} wrap={false} changeKind="modified" />,
    );
    const element = container.querySelector<HTMLElement>('[data-keydex-aligned-row="row:1"]')!;
    expect(element.getAttribute("data-change-kind")).toBe("modified");
    expect(element.getAttribute("data-kind")).toBe("added");
  });

  it("marks only the outer rows of a change block as visual boundaries", () => {
    const rows = [
      row({ id: "context", changeId: null }),
      row({ id: "change:1", changeId: "change:1" }),
      row({ id: "change:2", changeId: "change:1" }),
      row({ id: "single", changeId: "change:2" }),
    ];
    expect(diffChangeRowBoundary(rows, 0)).toEqual({ start: false, end: false });
    expect(diffChangeRowBoundary(rows, 1)).toEqual({ start: true, end: false });
    expect(diffChangeRowBoundary(rows, 2)).toEqual({ start: false, end: false });
    expect(diffChangeRowBoundary(rows, 3)).toEqual({ start: true, end: true });
  });

  it("uses one physical device pixel for change edges", () => {
    expect(diffPhysicalPixelWidth(1)).toBe(1);
    expect(diffPhysicalPixelWidth(1.25)).toBe(0.8);
    expect(diffPhysicalPixelWidth(1.5)).toBe(0.6667);
    expect(diffPhysicalPixelWidth(2)).toBe(0.5);
    expect(diffPhysicalPixelWidth(Number.NaN)).toBe(1);
  });

  it("uses row text as a safe fallback and exposes wrap without changing copy text", () => {
    const current = row({ kind: "context", tokens: [], changeId: null, text: "  plain\ttext" });
    const { container } = render(<AlignedDiffRow row={current} wrap />);
    const element = container.querySelector<HTMLElement>('[data-keydex-aligned-row]')!;
    expect(element.getAttribute("data-wrap")).toBe("true");
    expect(screen.getByRole("gridcell").textContent).toBe("  plain\ttext");
    expect(diffPaneRowCopyText(current)).toBe("  plain\ttext");
  });

  it("removes per-row sticky gutters when the pane owns an external fixed gutter", () => {
    const current = row({ side: "old", kind: "removed" });
    const { container } = render(
      <AlignedDiffRow row={current} wrap={false} gutterMode="external" />,
    );
    const element = container.querySelector<HTMLElement>('[data-keydex-aligned-row]')!;
    expect(element.getAttribute("data-gutter-mode")).toBe("external");
    expect(element.querySelector('[class*="lineNumber"]')).toBeNull();
    expect(element.querySelector('[class*="indicator"]')).toBeNull();
    expect(screen.getByRole("gridcell").textContent).toBe(current.text);
  });

  it("presents added, removed, modified and context semantics without relying only on color", () => {
    expect(diffPaneRowPresentation(row({ kind: "added" }))).toEqual({ indicator: "+", label: "第 12 行，新增" });
    expect(diffPaneRowPresentation(row({ kind: "removed", side: "old" }))).toEqual({ indicator: "−", label: "第 12 行，删除" });
    expect(diffPaneRowPresentation(row({ kind: "modified" }))).toEqual({ indicator: "", label: "第 12 行，修改" });
    expect(diffPaneRowPresentation(row({ kind: "context" }))).toEqual({ indicator: "", label: "第 12 行，上下文" });
  });

  it("does not mark context rows active when no change is selected", () => {
    expect(isAlignedDiffRowActive(null, null)).toBe(false);
    expect(isAlignedDiffRowActive("change:1", null)).toBe(false);
    expect(isAlignedDiffRowActive("change:1", "change:1")).toBe(true);
    expect(isAlignedDiffRowActive("change:1", "change:2")).toBe(false);
  });

  it("derives a stable virtual-canvas width from tabs and wide code characters", () => {
    expect(widestDiffLineColumns([
      { text: "12345" },
      { text: "\t1234" },
      { text: "中文代码" },
      { text: "e\u0301" },
    ])).toBe(8);
  });

  it("uses only design tokens for semantic colors", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const css = readFileSync(resolve(process.cwd(), "src/renderer/components/diff/aligned/AlignedDiffRow.module.css"), "utf8");
    expect(css).not.toMatch(/#[0-9a-f]{3,8}|rgba?\(/iu);
    expect(css).toContain("var(--diff-added-bg)");
    expect(css).toContain("var(--diff-modified-bg)");
    expect(css).toContain("var(--diff-modified-word-bg)");
    expect(css).toContain("var(--diff-removed-word-bg)");
    expect(css).toMatch(/\.row\[data-change-kind="modified"\]\s*{[^}]*var\(--diff-modified-bg\)/s);
    expect(css).toContain("min-inline-size: 100cqi");
    expect(css).toMatch(/\.row\[data-positioned="true"\]\s*{[^}]*inset-inline-start:\s*0[^}]*inset-inline-end:\s*0[^}]*inline-size:\s*auto[^}]*min-inline-size:\s*100%/s);
    expect(css).toMatch(/\.row\[data-positioned="true"\]\[data-wrap="true"\]\s*{[^}]*min-inline-size:\s*100%/s);
    expect(css).not.toMatch(/\.row\[data-kind="(?:added|removed|modified)"\] \.code\s*{[^}]*background:/s);
    expect(css).toMatch(/\.row\[data-change-kind="added"\] \.code :global\(\[data-diff-span\]\)\s*{[^}]*var\(--diff-added-word-bg\)/s);
    expect(css).toMatch(/\.row\[data-change-kind="removed"\] \.code :global\(\[data-diff-span\]\)\s*{[^}]*var\(--diff-removed-word-bg\)/s);
    expect(css).toMatch(/\.row\[data-change-kind="modified"\] \.code :global\(\[data-diff-span\]\)\s*{[^}]*var\(--diff-modified-word-bg\)/s);
    expect(css).toMatch(/\.row\[data-change-start="true"\]::before,[\s\S]*?\.row\[data-change-end="true"\]::after\s*{[^}]*height:\s*var\(--keydex-diff-edge-width,\s*1px\)[^}]*background:\s*var\(--diff-change-edge\)/s);
    expect(css).toMatch(/\.row\[data-change-start="true"\]::before\s*{[^}]*top:\s*0/s);
    expect(css).toMatch(/\.row\[data-change-end="true"\]::after\s*{[^}]*bottom:\s*0/s);
    expect(css).not.toMatch(/translateY\(/s);
    expect(css).not.toMatch(/\.row\[data-change-kind="(?:added|removed|modified)"\]\s*{[^}]*box-shadow/s);
    expect(css).not.toMatch(/data-side="(?:old|new)"\]\[data-kind="modified"\][\s\S]*?var\(--diff-(?:added|removed)-word-bg\)/s);
    expect(css).toMatch(/\.row\[data-change-kind="modified"\] \.lineNumber,[\s\S]*?background-color:\s*var\(--diff-gutter-bg\)[\s\S]*?background-image:\s*linear-gradient\(var\(--diff-modified-bg\)/s);
    expect(css).not.toMatch(/\.row\[data-change-id\][\s\S]*?background:\s*transparent/s);
    expect(css).toMatch(/\.lineNumber,\s*\.indicator\s*{[^}]*z-index:\s*3/s);
    expect(css).toMatch(/\.row\[data-side="old"\] \.lineNumber\s*{[^}]*right:\s*0/s);
    expect(css).toMatch(/\.row\[data-side="old"\] \.indicator\s*{[^}]*right:\s*calc\(/s);
    expect(css).toMatch(/\.row\[data-gutter-mode="external"\]\s*{[^}]*display:\s*block/s);
    expect(css).not.toContain("100cqw");
    expect(css).not.toMatch(/\.row\[data-kind="(?:added|removed|modified)"\] \.indicator\s*{[^}]*box-shadow/s);
  });
});
