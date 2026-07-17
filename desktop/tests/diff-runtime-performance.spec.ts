import { describe, expect, it } from "vitest";

import {
  DIFF_RUNTIME_PERFORMANCE_BUDGET,
  evaluateDiffRuntimePerformance,
  medianPerformanceSample,
  summarizeDiffRuntimePerformance,
} from "@/renderer/components/diff/diffRuntimePerformance";
import { DIFF_PERFORMANCE_BUDGET } from "@/renderer/components/diff/diffPerformanceBaseline";

describe("Diff runtime performance gate", () => {
  it("uses a deterministic median for odd, even and empty samples", () => {
    expect(medianPerformanceSample([])).toBe(0);
    expect(medianPerformanceSample([30, 10, 20])).toBe(20);
    expect(medianPerformanceSample([40, 10, 30, 20])).toBe(25);
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
});
