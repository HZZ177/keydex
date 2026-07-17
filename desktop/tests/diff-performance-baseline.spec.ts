import { describe, expect, it } from "vitest";

import {
  compareDiffPerformanceBudget,
  DIFF_PERFORMANCE_BASELINE,
  DIFF_PERFORMANCE_BUDGET,
  type DiffPerformanceMeasurement,
} from "@/renderer/components/diff/diffPerformanceBaseline";

describe("Diff performance baseline contract", () => {
  it("records reproducible build, renderer and lockfile provenance", () => {
    expect(DIFF_PERFORMANCE_BASELINE.schemaVersion).toBe(1);
    expect(DIFF_PERFORMANCE_BASELINE.buildSamples).toHaveLength(3);
    expect(DIFF_PERFORMANCE_BASELINE.legacyRendererSamples.map(({ rows }) => rows)).toEqual([
      1_000,
      20_000,
    ]);
    expect(DIFF_PERFORMANCE_BASELINE.lockfilePolicy).toEqual(
      expect.objectContaining({
        canonical: "pnpm-lock.yaml",
        nonCanonical: "package-lock.json",
        decision: "remove-with-dependency-cutover",
      }),
    );
    expect(DIFF_PERFORMANCE_BASELINE.bundleSample.pierreImportedByProduction).toBe(false);
  });

  it("derives explicit ceilings above the measured migration baseline", () => {
    const baseline = DIFF_PERFORMANCE_BASELINE.bundleSample;
    expect(DIFF_PERFORMANCE_BUDGET.initialEntryRawBytes).toBeGreaterThan(
      baseline.initialEntryRawBytes,
    );
    expect(DIFF_PERFORMANCE_BUDGET.initialEntryGzipBytes).toBeGreaterThan(
      baseline.initialEntryGzipBytes,
    );
    expect(DIFF_PERFORMANCE_BUDGET.javascriptRawBytes).toBeGreaterThan(
      baseline.javascriptRawBytes,
    );
    expect(DIFF_PERFORMANCE_BUDGET.mountedRows20k).toBeLessThan(20_000);
  });

  it("reports every exceeded metric without hiding other failures", () => {
    const passing = { ...DIFF_PERFORMANCE_BUDGET } satisfies DiffPerformanceMeasurement;
    expect(compareDiffPerformanceBudget(passing)).toEqual([]);

    const failing = Object.fromEntries(
      Object.entries(DIFF_PERFORMANCE_BUDGET).map(([metric, maximum]) => [metric, maximum + 1]),
    ) as unknown as DiffPerformanceMeasurement;
    expect(compareDiffPerformanceBudget(failing).map(({ metric }) => metric)).toEqual(
      Object.keys(DIFF_PERFORMANCE_BUDGET),
    );
  });
});
