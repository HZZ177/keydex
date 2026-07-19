import { render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { AlignedDiffRow } from "@/renderer/components/diff/aligned/AlignedDiffRow";
import { DiffConnectorLane } from "@/renderer/components/diff/aligned/DiffConnectorLane";
import { KeydexAlignedSplitDiff } from "@/renderer/components/diff/aligned/KeydexAlignedSplitDiff";
import type { DiffPaneRow } from "@/renderer/components/diff/aligned/alignedDiffModel";
import { keydexDiffScrollBehavior } from "@/renderer/components/diff/diffKeyboard";

describe("aligned split accessibility and motion contract", () => {
  it("exposes two labelled grids, semantic rows and a concise live change status", () => {
    render(
      <KeydexAlignedSplitDiff
        left={<AlignedDiffRow row={row("old", "removed")} wrap={false} active />}
        right={<AlignedDiffRow row={row("new", "added")} wrap={false} />}
        syncScroll
        activeChangeIndex={0}
        changeCount={2}
      />,
    );
    const group = screen.getByRole("group", { name: "并排差异" });
    expect(group.getAttribute("aria-describedby")).toBeTruthy();
    expect(screen.getByRole("region", { name: "修改前" }).tabIndex).toBe(0);
    expect(screen.getByRole("region", { name: "修改后" }).tabIndex).toBe(0);
    expect(screen.getByRole("grid", { name: "修改前代码" })).toBeTruthy();
    expect(screen.getByRole("grid", { name: "修改后代码" })).toBeTruthy();
    const rows = screen.getAllByRole("row");
    expect(rows[0]!.getAttribute("aria-label")).toContain("删除");
    expect(rows[0]!.getAttribute("aria-selected")).toBe("true");
    expect(rows[1]!.getAttribute("aria-label")).toContain("新增");
    expect(group.textContent).toContain("左右代码窗格已同步滚动");
    expect(group.textContent).toContain("当前是第 1 个差异，共 2 个");
  });

  it("keeps connector graphics out of the accessibility tree", () => {
    const { container } = render(
      <KeydexAlignedSplitDiff
        left={null}
        right={null}
        connector={<DiffConnectorLane geometry={[]} height={120} />}
      />,
    );
    const visual = container.querySelector<HTMLElement>("[data-keydex-aligned-connector-visual]")!;
    expect(visual.getAttribute("aria-hidden")).toBe("true");
    expect(within(visual).queryByRole("img")).toBeNull();
    expect(container.querySelector("svg")?.getAttribute("focusable")).toBe("false");
  });

  it("uses non-color row indicators and avoids native title tooltips", () => {
    const { container } = render(
      <KeydexAlignedSplitDiff
        left={<AlignedDiffRow row={row("old", "removed")} wrap={false} />}
        right={<AlignedDiffRow row={row("new", "added")} wrap={false} />}
      />,
    );
    const indicators = Array.from(container.querySelectorAll("[class*='indicator']"), (node) => node.textContent);
    expect(indicators).toEqual(["−", "+"]);
    expect(container.querySelector("[title]")).toBeNull();
  });

  it("disables non-essential animation and smooth scroll for reduced motion", () => {
    expect(keydexDiffScrollBehavior("smooth", true)).toBe("instant");
    expect(keydexDiffScrollBehavior("smooth", false)).toBe("smooth");
    const alignedDir = resolve(process.cwd(), "src/renderer/components/diff/aligned");
    for (const name of ["DiffConnectorLane.module.css", "DiffHunkActionLayer.module.css"]) {
      const css = readFileSync(resolve(alignedDir, name), "utf8");
      expect(css).toContain("@media (prefers-reduced-motion: reduce)");
      expect(css).toMatch(/transition:\s*none/u);
    }
  });

  it("retains scalable layout primitives for 200 percent zoom", () => {
    const splitCss = readFileSync(
      resolve(process.cwd(), "src/renderer/components/diff/aligned/KeydexAlignedSplitDiff.module.css"),
      "utf8",
    );
    const rowCss = readFileSync(
      resolve(process.cwd(), "src/renderer/components/diff/aligned/AlignedDiffRow.module.css"),
      "utf8",
    );
    expect(splitCss).toContain("minmax(0, 1fr)");
    expect(splitCss).toContain("var(--diff-aligned-connector-width)");
    expect(rowCss).toContain("minmax(0, 1fr)");
    expect(rowCss).toContain("overflow-wrap: anywhere");
  });
});

function row(side: "old" | "new", kind: "added" | "removed"): DiffPaneRow {
  return Object.freeze({
    id: `${side}:${kind}`,
    fileId: "file:1",
    side,
    kind,
    lineNumber: 3,
    sourceIndex: 2,
    segmentId: "segment:1",
    changeId: "change:1",
    hunkId: "hunk:1",
    text: kind === "added" ? "new line" : "old line",
    tokens: Object.freeze([{ type: "text" as const, value: kind === "added" ? "new line" : "old line" }]),
    noTrailingNewline: false,
    estimatedHeight: 20,
  });
}
