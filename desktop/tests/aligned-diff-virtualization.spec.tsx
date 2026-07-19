import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useMemo } from "react";
import { describe, expect, it } from "vitest";

import { DiffRowHeightIndex } from "@/renderer/components/diff/aligned/rowHeightIndex";
import { resolveAlignedPaneVirtualWindow } from "@/renderer/components/diff/aligned/alignedPaneWindow";
import type { DiffScrollMappingMetrics } from "@/renderer/components/diff/aligned/hunkScrollMapping";
import {
  resolveVirtualDiffWindow,
  useVirtualDiffRows,
} from "@/renderer/components/diff/aligned/useVirtualDiffRows";
import {
  KEYDEX_ALIGNED_VIRTUALIZATION_THRESHOLDS,
  resolveKeydexAlignedVirtualizationPolicy,
} from "@/renderer/components/diff/virtualizationPolicy";

describe("aligned single-pane row virtualization", () => {
  it("resolves empty, first, middle and exact-end windows with blank spacers", () => {
    expect(resolveVirtualDiffWindow(new DiffRowHeightIndex(0, 20), 0, 200)).toMatchObject({
      startIndex: 0,
      endIndex: 0,
      totalHeight: 0,
    });
    const index = new DiffRowHeightIndex(100, 20);
    const first = resolveVirtualDiffWindow(index, 0, 100, 40, 20);
    expect(first).toMatchObject({ startIndex: 0, visibleStartIndex: 0, topSpacerHeight: 0 });
    expect(first.bottomSpacerHeight).toBeGreaterThan(0);

    const middle = resolveVirtualDiffWindow(index, 900, 100, 40, 20);
    expect(middle.startIndex).toBeLessThanOrEqual(middle.visibleStartIndex);
    expect(middle.endIndex).toBeGreaterThanOrEqual(middle.visibleEndIndex);
    expect(middle.topSpacerHeight).toBeGreaterThan(0);
    expect(middle.bottomSpacerHeight).toBeGreaterThan(0);
    expect(middle.mountedRowCount).toBeLessThanOrEqual(20);

    const end = resolveVirtualDiffWindow(index, 1_900, 100, 40, 20);
    expect(end.endIndex).toBe(100);
    expect(end.visibleEndIndex).toBe(100);
    expect(end.bottomSpacerHeight).toBe(0);
  });

  it("keeps fast jumps contiguous, unique and inside the mount budget", () => {
    const index = new DiffRowHeightIndex(20_000, 22);
    for (const scrollTop of [0, 12_000, 220_000, 439_500]) {
      const window = resolveVirtualDiffWindow(index, scrollTop, 520, 360, 800);
      const rows = Array.from(
        { length: window.endIndex - window.startIndex },
        (_, offset) => window.startIndex + offset,
      );
      expect(rows.length).toBeLessThanOrEqual(800);
      expect(new Set(rows).size).toBe(rows.length);
      expect(rows.at(0)).toBe(window.startIndex);
      expect(rows.at(-1)).toBe(window.endIndex - 1);
    }
  });

  it("recalculates offsets after dynamic measured heights without blank or duplicate rows", () => {
    const index = new DiffRowHeightIndex(50, 20);
    const before = resolveVirtualDiffWindow(index, 400, 120, 40, 20);
    index.setMeasuredHeights([
      { rowIndex: 18, height: 55 },
      { rowIndex: 19, height: 35 },
      { rowIndex: 20, height: 60 },
    ]);
    const after = resolveVirtualDiffWindow(index, 400, 120, 40, 20);
    expect(after.totalHeight).toBe(before.totalHeight + 90);
    expect(after.topSpacerHeight).toBe(index.rowToOffset(after.startIndex));
    expect(after.bottomSpacerHeight).toBe(index.totalHeight - index.rowToOffset(after.endIndex));
    expect(after.endIndex).toBeGreaterThan(after.startIndex);
  });

  it("keeps native row offsets continuous without a shorter-side alignment hole", () => {
    const heights = new DiffRowHeightIndex(4, 20);
    const metrics = {
      segments: [],
      leftTotalHeight: 80,
      rightTotalHeight: 80,
      leftRowOffsets: [0, 20, 40, 60],
      rightRowOffsets: [0, 20, 40, 60],
    } satisfies DiffScrollMappingMetrics;
    expect(resolveAlignedPaneVirtualWindow(metrics, heights, "old", 30, 20, true, 0, 10).rowIndexes)
      .toEqual([1, 2]);
    expect(resolveAlignedPaneVirtualWindow(metrics, heights, "old", 50, 30, true, 0, 10).rowIndexes)
      .toEqual([2, 3]);
  });

  it("mounts only the virtual window for a 20k row pane and responds to scrollbar jumps", async () => {
    const scrollElement = document.createElement("div");
    Object.defineProperty(scrollElement, "clientHeight", { configurable: true, value: 440 });
    scrollElement.scrollTop = 0;
    render(<VirtualHarness scrollElement={scrollElement} rowCount={20_000} />);
    await waitFor(() => expect(Number(screen.getByTestId("mounted").textContent)).toBeGreaterThan(0));
    expect(Number(screen.getByTestId("mounted").textContent)).toBeLessThanOrEqual(800);
    expect(screen.getAllByTestId("virtual-row").length).toBeLessThanOrEqual(800);

    act(() => {
      scrollElement.scrollTop = 250_000;
      fireEvent.scroll(scrollElement);
    });
    await waitFor(() => expect(Number(screen.getByTestId("start").textContent)).toBeGreaterThan(1_000));
    expect(Number(screen.getByTestId("top-spacer").textContent)).toBeGreaterThan(0);
    expect(Number(screen.getByTestId("bottom-spacer").textContent)).toBeGreaterThan(0);
  });

  it("selects none, standard and aggressive policy budgets and accounts for wrapping", () => {
    const small = resolveKeydexAlignedVirtualizationPolicy(599, "git", false);
    const standard = resolveKeydexAlignedVirtualizationPolicy(600, "git", false);
    const aggressive = resolveKeydexAlignedVirtualizationPolicy(20_000, "git", true);
    expect(small).toMatchObject({ enabled: false, level: "none" });
    expect(standard).toMatchObject({ enabled: true, level: "standard" });
    expect(aggressive).toMatchObject({
      enabled: true,
      level: "aggressive",
      maxMountedRows: KEYDEX_ALIGNED_VIRTUALIZATION_THRESHOLDS.aggressiveMaxMountedRows,
    });
    expect(aggressive.estimatedRowHeight).toBeGreaterThan(standard.estimatedRowHeight);
    expect(() => resolveKeydexAlignedVirtualizationPolicy(-1, "git", false)).toThrow(TypeError);
  });

  it("validates invalid virtual window inputs", () => {
    const index = new DiffRowHeightIndex(10, 20);
    expect(() => resolveVirtualDiffWindow(index, Number.NaN, 20)).toThrow(TypeError);
    expect(() => resolveVirtualDiffWindow(index, 0, -1)).toThrow(RangeError);
    expect(() => resolveVirtualDiffWindow(index, 0, 20, 10, 0)).toThrow(TypeError);
  });
});

function VirtualHarness({
  scrollElement,
  rowCount,
}: {
  readonly scrollElement: HTMLElement;
  readonly rowCount: number;
}) {
  const estimates = useMemo(() => 22, []);
  const virtual = useVirtualDiffRows({
    rowCount,
    estimatedHeight: estimates,
    scrollElement,
    enabled: true,
    overscanPx: 320,
    maxMountedRows: 800,
  });
  return (
    <div>
      <output data-testid="start">{virtual.window.startIndex}</output>
      <output data-testid="mounted">{virtual.window.mountedRowCount}</output>
      <output data-testid="top-spacer">{virtual.window.topSpacerHeight}</output>
      <output data-testid="bottom-spacer">{virtual.window.bottomSpacerHeight}</output>
      {virtual.rowIndexes.map((rowIndex) => (
        <div key={rowIndex} data-testid="virtual-row">{rowIndex}</div>
      ))}
    </div>
  );
}
