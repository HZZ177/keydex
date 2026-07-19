import { describe, expect, it } from "vitest";

import {
  resolveDualVirtualDiffWindows,
  shouldApplyVirtualMeasurementCorrection,
} from "@/renderer/components/diff/aligned/dualVirtualWindows";
import { DiffRowHeightIndex } from "@/renderer/components/diff/aligned/rowHeightIndex";

describe("dual aligned virtual windows", () => {
  it("keeps a 20k by 20k split inside the combined mount budget", () => {
    const oldHeights = new DiffRowHeightIndex(20_000, 21);
    const newHeights = new DiffRowHeightIndex(20_000, 24);
    const windows = resolveDualVirtualDiffWindows(
      { heights: oldHeights, scrollTop: 200_000, viewportHeight: 600 },
      { heights: newHeights, scrollTop: 310_000, viewportHeight: 600 },
      { maxMountedRows: 2_000, overscanPx: 400 },
    );
    expect(windows.mountedRowCount).toBeLessThanOrEqual(2_000);
    expect(windows.old.startIndex).toBeGreaterThan(0);
    expect(windows.new.startIndex).toBeGreaterThan(0);
    expect(windows.old.topSpacerHeight + windows.old.bottomSpacerHeight).toBeGreaterThan(0);
    expect(windows.new.topSpacerHeight + windows.new.bottomSpacerHeight).toBeGreaterThan(0);
  });

  it("keeps a 100k by 100k stress fixture bounded without materializing rows", () => {
    const oldHeights = new DiffRowHeightIndex(100_000, 20);
    const newHeights = new DiffRowHeightIndex(100_000, 24);
    const samples = [0, 500_000, 1_500_000].map((scrollTop) => resolveDualVirtualDiffWindows(
      { heights: oldHeights, scrollTop, viewportHeight: 900 },
      { heights: newHeights, scrollTop: scrollTop * 1.1, viewportHeight: 900 },
      { maxMountedRows: 2_000, overscanPx: 320 },
    ));
    expect(samples.every(({ mountedRowCount }) => mountedRowCount <= 2_000)).toBe(true);
    expect(samples.at(-1)?.old.startIndex).toBeGreaterThan(samples[0]!.old.startIndex);
    expect(samples.at(-1)?.new.startIndex).toBeGreaterThan(samples[0]!.new.startIndex);
  });

  it("supports asymmetric panes and rapid remote jumps without sharing a window", () => {
    const oldHeights = new DiffRowHeightIndex(20_000, 20);
    const newHeights = new DiffRowHeightIndex(500, 36);
    const first = resolveDualVirtualDiffWindows(
      { heights: oldHeights, scrollTop: 0, viewportHeight: 400 },
      { heights: newHeights, scrollTop: 0, viewportHeight: 400 },
    );
    const jumped = resolveDualVirtualDiffWindows(
      { heights: oldHeights, scrollTop: 350_000, viewportHeight: 400 },
      { heights: newHeights, scrollTop: 12_000, viewportHeight: 400 },
    );
    expect(jumped.old.startIndex).toBeGreaterThan(first.old.startIndex);
    expect(jumped.new.startIndex).toBeGreaterThan(first.new.startIndex);
    expect(jumped.old.endIndex).toBeLessThanOrEqual(20_000);
    expect(jumped.new.endIndex).toBeLessThanOrEqual(500);
  });

  it("only requests a measured correction outside the one-pixel tolerance", () => {
    const base = { epoch: 2, targetSide: "new" as const, estimatedOffset: 120 };
    expect(shouldApplyVirtualMeasurementCorrection({ ...base, measuredOffset: 120.8 })).toBe(false);
    expect(shouldApplyVirtualMeasurementCorrection({ ...base, measuredOffset: 121.01 })).toBe(true);
    expect(shouldApplyVirtualMeasurementCorrection({ ...base, measuredOffset: Number.NaN })).toBe(false);
    expect(() => shouldApplyVirtualMeasurementCorrection({ ...base, measuredOffset: 125 }, -1)).toThrow(TypeError);
  });

  it("validates an impossible shared mount budget", () => {
    const heights = new DiffRowHeightIndex(1, 20);
    expect(() => resolveDualVirtualDiffWindows(
      { heights, scrollTop: 0, viewportHeight: 20 },
      { heights, scrollTop: 0, viewportHeight: 20 },
      { maxMountedRows: 1 },
    )).toThrow(TypeError);
  });
});
