import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { markdownRuntimeFixtureSpec } from "./fixtures/markdown-runtime";
import {
  ZED_BASELINE_SCHEMA_VERSION,
  compareZedAndKeydexRuns,
  createZedBaselineMatrix,
  materializeZedOneMiBFixture,
  rendererInternalOnlyMetrics,
  validateZedBaselineRun,
  zedComparableMetrics,
  type ZedBaselineRun,
} from "./fixtures/zedBaseline";

function run(overrides: Partial<ZedBaselineRun> = {}): ZedBaselineRun {
  return {
    schemaVersion: ZED_BASELINE_SCHEMA_VERSION,
    runId: "zed-cold-open-001",
    product: "zed",
    productRevision: "65e1c5af258d4c80036467d583691f3f9ded0897",
    capturedAt: "2026-07-12T02:00:00+08:00",
    captureMethod: "screen-frame-analysis",
    machineFingerprint: "same-machine-hash",
    environment: {
      os: "Windows 11",
      cpu: "test-cpu",
      memoryBytes: 32 * 1024 ** 3,
      gpu: "test-gpu",
      driver: "test-driver",
    },
    viewport: { width: 1440, height: 900, devicePixelRatio: 1.25 },
    fixture: {
      id: "mixed-1m",
      generatorVersion: "markdown-runtime-fixtures/v1",
      hash: "same-fixture-sha256",
      bytes: 1024 ** 2,
    },
    cacheMode: "cold",
    operation: "open",
    metric: "open.first_visible_ms",
    rawSamples: Array.from({ length: 10 }, (_value, index) => 100 + index),
    ...overrides,
  };
}

describe("Zed and Keydex same-machine baseline contract", () => {
  it("covers four fixture sizes, cold/warm, and open/reveal/scroll", () => {
    const matrix = createZedBaselineMatrix();
    expect(matrix).toHaveLength(4 * 2 * 3);
    expect(new Set(matrix.map((item) => item.fixtureId))).toEqual(
      new Set(["mixed-250k", "mixed-1m", "mixed-5m", "mixed-10m"]),
    );
    expect(new Set(matrix.map((item) => item.cacheMode))).toEqual(new Set(["cold", "warm"]));
    expect(new Set(matrix.map((item) => item.operation))).toEqual(new Set(["open", "reveal", "scroll"]));
    expect(matrix.find((item) => item.operation === "scroll")?.minimumSamples).toBe(300);
  });

  it("accepts repeated cold and warm runs with retained raw samples", () => {
    const cold = run();
    const warm = run({ cacheMode: "warm", runId: "zed-warm-open-001" });
    expect(validateZedBaselineRun(cold)).toEqual({ valid: true, errors: [] });
    expect(validateZedBaselineRun(warm)).toEqual({ valid: true, errors: [] });
    expect(cold.rawSamples).toHaveLength(10);
  });

  it("rejects comparison when window or DPR differs", () => {
    const zed = run();
    const keydex = run({
      product: "keydex",
      productRevision: "keydex-revision",
      captureMethod: "instrumented-keydex",
      viewport: { width: 1440, height: 900, devicePixelRatio: 1.5 },
    });
    expect(() => compareZedAndKeydexRuns(zed, keydex)).toThrow("viewport.devicePixelRatio mismatch");
  });

  it("rejects comparison when the fixture hash differs", () => {
    const zed = run();
    const keydex = run({
      product: "keydex",
      productRevision: "keydex-revision",
      captureMethod: "instrumented-keydex",
      fixture: { ...zed.fixture, hash: "different-fixture" },
    });
    expect(() => compareZedAndKeydexRuns(zed, keydex)).toThrow("fixture.hash mismatch");
  });

  it("keeps user-visible metrics comparable and renderer internals separate", () => {
    expect(zedComparableMetrics).toContain("reveal.stable_ms");
    expect(rendererInternalOnlyMetrics).toContain("keydex.dom.node_count");
    expect(rendererInternalOnlyMetrics).toContain("zed.gpui.scene_build_ms");
    expect(zedComparableMetrics).not.toContain(rendererInternalOnlyMetrics[0] as never);
  });

  it("builds p50/p95/p99 only for matching Zed and Keydex runs", () => {
    const zed = run();
    const keydex = run({
      product: "keydex",
      productRevision: "keydex-revision",
      captureMethod: "instrumented-keydex",
      rawSamples: Array.from({ length: 10 }, (_value, index) => 110 + index),
    });
    const comparison = compareZedAndKeydexRuns(zed, keydex);
    expect(comparison.zedSummary).toMatchObject({ count: 10, p50: 104, p95: 109, p99: 109 });
    expect(comparison.keydexSummary).toMatchObject({ count: 10, p50: 114, p95: 119, p99: 119 });
  });

  it("materializes the exact 1 MiB Zed fixture only with explicit opt-in", () => {
    const directory = mkdtempSync(join(tmpdir(), "keydex-zed-fixture-"));
    const outputPath = join(directory, "mixed-1m.md");
    try {
      expect(() => materializeZedOneMiBFixture(outputPath, { optIn: false })).toThrow("optIn=true");
      const result = materializeZedOneMiBFixture(outputPath, {
        optIn: true,
        spec: markdownRuntimeFixtureSpec("mixed-1m"),
      });
      expect(statSync(result.markdownPath).size).toBe(1024 ** 2);
      expect(existsSync(result.manifestPath)).toBe(true);
      expect(JSON.parse(readFileSync(result.manifestPath, "utf8"))).toMatchObject({
        id: "mixed-1m",
        bytes: 1024 ** 2,
        hash: result.hash,
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

