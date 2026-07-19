import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  ALIGNED_DIFF_RUNTIME_PERFORMANCE_BUDGET,
  DIFF_RUNTIME_PERFORMANCE_BUDGET,
  evaluateAlignedDiffRuntimePerformance,
  evaluateDiffRuntimePerformance,
  medianPerformanceSample,
  percentilePerformanceSample,
  summarizeAlignedDiffRuntimePerformance,
  summarizeDiffRuntimePerformance,
} from "@/renderer/components/diff/diffRuntimePerformance";
import {
  ALIGNED_DIFF_PERFORMANCE_BASELINE,
  DIFF_PERFORMANCE_BUDGET,
} from "@/renderer/components/diff/diffPerformanceBaseline";

describe("Diff runtime performance gate", () => {
  it("uses a deterministic median for odd, even and empty samples", () => {
    expect(medianPerformanceSample([])).toBe(0);
    expect(medianPerformanceSample([30, 10, 20])).toBe(20);
    expect(medianPerformanceSample([40, 10, 30, 20])).toBe(25);
  });

  it("uses nearest-rank percentiles for tail-latency gates", () => {
    expect(percentilePerformanceSample([], 0.95)).toBe(0);
    expect(percentilePerformanceSample([9, 1, 4, 3, 2], 0.5)).toBe(3);
    expect(percentilePerformanceSample(Array.from({ length: 20 }, (_, index) => index + 1), 0.95)).toBe(19);
    expect(() => percentilePerformanceSample([1], 1.01)).toThrow(RangeError);
  });

  it("derives the development render ceiling from the recorded DIFF-003 baseline", () => {
    expect(DIFF_RUNTIME_PERFORMANCE_BUDGET.render20kMedianMs)
      .toBe(DIFF_PERFORMANCE_BUDGET.render20kMs * 4);
    expect(DIFF_RUNTIME_PERFORMANCE_BUDGET.mountedElements20k).toBeLessThan(20_000);
  });

  it("summarizes three-sample interaction and long-task measurements", () => {
    expect(summarizeDiffRuntimePerformance({
      render20kMs: [3_000, 2_000, 4_000],
      interactionMs: [60, 40, 50],
      scrollMs: [30, 10, 20],
      longTaskMs: [55, 80, 65],
      mountedElements20k: 1_200,
      heapGrowthBytes: 32 * 1024 * 1024,
    })).toEqual({
      render20kMedianMs: 3_000,
      interactionMedianMs: 50,
      scrollMedianMs: 20,
      maxLongTaskMs: 80,
      totalLongTaskMs: 200,
      mountedElements20k: 1_200,
      heapGrowthBytes: 32 * 1024 * 1024,
    });
  });

  it("reports exact metrics instead of collapsing failures into one boolean", () => {
    const summary = summarizeDiffRuntimePerformance({
      render20kMs: [20_000, 20_000, 20_000],
      interactionMs: [600, 600, 600],
      scrollMs: [10, 10, 10],
      longTaskMs: [],
      mountedElements20k: 1_000,
      heapGrowthBytes: 0,
    });
    expect(evaluateDiffRuntimePerformance(summary).map((violation) => violation.metric)).toEqual([
      "render20kMedianMs",
      "interactionMedianMs",
    ]);
  });

  it("summarizes aligned split tail latency, mount bounds and cache stability", () => {
    const summary = summarizeAlignedDiffRuntimePerformance({
      modelPreparationMs: [900, 700, 800],
      firstRenderMs: [1_100, 900, 1_000],
      scrollInputToPaintMs: [8, 12, 16, 24, 31],
      connectorGeometryMs: [0.4, 0.8, 1.2],
      resizeInteractionMs: [20, 24, 28],
      wrapInteractionMs: [80, 100, 120],
      syncInteractionMs: [10, 12, 14],
      longTaskMs: [22, 40],
      mountedRows: [120, 160, 140],
      heapGrowthBytes: 16 * 1024 * 1024,
      resizeRehighlightCount: 0,
      wrapRehighlightCount: 0,
      syncRehighlightCount: 0,
    });
    expect(summary).toMatchObject({
      modelPreparationMedianMs: 800,
      firstRenderMedianMs: 1_000,
      scrollInputToPaintP95Ms: 31,
      connectorGeometryP95Ms: 1.2,
      maxLongTaskMs: 40,
      maxMountedRows: 160,
    });
    expect(evaluateAlignedDiffRuntimePerformance(summary)).toEqual([]);
  });

  it("reports each aligned split budget violation with its exact ceiling", () => {
    const summary = summarizeAlignedDiffRuntimePerformance({
      modelPreparationMs: [1],
      firstRenderMs: [1],
      scrollInputToPaintMs: [33],
      connectorGeometryMs: [4.1],
      resizeInteractionMs: [1],
      wrapInteractionMs: [1],
      syncInteractionMs: [1],
      longTaskMs: [51],
      mountedRows: [2_001],
      heapGrowthBytes: 0,
      resizeRehighlightCount: 1,
      wrapRehighlightCount: 0,
      syncRehighlightCount: 0,
    });
    expect(evaluateAlignedDiffRuntimePerformance(summary)).toEqual([
      { metric: "scrollInputToPaintP95Ms", actual: 33, maximum: 32 },
      { metric: "connectorGeometryP95Ms", actual: 4.1, maximum: 4 },
      { metric: "maxLongTaskMs", actual: 51, maximum: 50 },
      { metric: "maxMountedRows", actual: 2_001, maximum: 2_000 },
      { metric: "resizeRehighlightCount", actual: 1, maximum: 0 },
    ]);
  });

  it("records the machine, build mode and three-sample policy for reproducible gates", () => {
    expect(ALIGNED_DIFF_PERFORMANCE_BASELINE.environment).toMatchObject({
      operatingSystem: "Windows x64",
      browser: "Playwright Chromium",
      buildMode: "Vite development",
      sampleCount: 3,
    });
    expect(ALIGNED_DIFF_RUNTIME_PERFORMANCE_BUDGET).toMatchObject({
      scrollInputToPaintP95Ms: 32,
      connectorGeometryP95Ms: 4,
      maxLongTaskMs: 50,
      maxMountedRows: 2_000,
    });
  });

  it("keeps performance observers and sampling out of the production aligned scroll hot path", () => {
    const source = readFileSync(resolve(
      process.cwd(),
      "src/renderer/components/diff/aligned/AlignedDiffFileView.tsx",
    ), "utf8");
    expect(source).not.toContain("diffRuntimePerformance");
    expect(source).not.toContain("PerformanceObserver");
    expect(source).not.toContain("performance.mark");
  });
});
