export interface DiffPerformanceMeasurement {
  initialEntryRawBytes: number;
  initialEntryGzipBytes: number;
  javascriptRawBytes: number;
  javascriptGzipBytes: number;
  buildDurationMs: number;
  parse20kMs: number;
  render1kMs: number;
  render20kMs: number;
  mountedRows20k: number;
}

export type DiffPerformanceMetric = keyof DiffPerformanceMeasurement;

export interface DiffPerformanceViolation {
  metric: DiffPerformanceMetric;
  actual: number;
  maximum: number;
}

export const DIFF_PERFORMANCE_BASELINE = {
  schemaVersion: 1,
  capturedAt: "2026-07-17",
  revision: "ebbe30efbebc9c23d9e60328d8c63cfc18c5f80a",
  environment: {
    operatingSystem: "Windows",
    packageManager: "pnpm",
    buildCommand: "pnpm exec vite build --logLevel error",
    bundleMeasureCommand: "pnpm run measure:diff-build",
    rendererMeasureCommand: "pnpm test -- diff-legacy-performance-baseline.spec.tsx",
  },
  lockfilePolicy: {
    canonical: "pnpm-lock.yaml",
    nonCanonical: "package-lock.json",
    decision: "remove-with-dependency-cutover",
    reason: "The repository declares pnpm and all root dependency scripts use pnpm.",
  },
  buildSamples: [
    { durationMs: 49_775, javascriptRawBytes: 12_729_651 },
    { durationMs: 47_624, javascriptRawBytes: 12_729_347 },
    { durationMs: 49_886, javascriptRawBytes: 12_731_596 },
  ],
  bundleSample: {
    initialEntryRawBytes: 5_250_585,
    initialEntryGzipBytes: 1_568_482,
    javascriptFiles: 1_542,
    javascriptRawBytes: 12_731_596,
    javascriptGzipBytes: 4_084_434,
    pierreImportedByProduction: false,
  },
  legacyRendererSamples: [
    { rows: 1_000, parseMs: 0.9981, renderMs: 215.4764, mountedRows: 1_000 },
    { rows: 20_000, parseMs: 21.8821, renderMs: 3_307.038, mountedRows: 20_000 },
  ],
} as const;

export const ALIGNED_DIFF_PERFORMANCE_BASELINE = Object.freeze({
  schemaVersion: 1,
  capturedAt: "2026-07-19",
  environment: Object.freeze({
    operatingSystem: "Windows x64",
    browser: "Playwright Chromium",
    buildMode: "Vite development",
    sampleCount: 3,
    command: "pnpm exec playwright test e2e/aligned-diff-performance.spec.ts",
  }),
  fixture: Object.freeze({
    ordinaryChangedLines: 20_000,
    stressIndexedRowsPerPane: 100_000,
    scrollDurationSeconds: 5,
  }),
  policy: Object.freeze({
    scrollStatistic: "p95",
    connectorStatistic: "p95",
    productionInstrumentation: "none",
  }),
  referenceRun: Object.freeze({
    modelPreparationMedianMs: 311.27,
    firstRenderMedianMs: 311.27,
    scrollInputToPaintP95Ms: 17.3,
    resizeInteractionP95Ms: 66.3,
    wrapInteractionP95Ms: 165.19,
    syncInteractionP95Ms: 192.67,
    maxLongTaskMs: 0,
    maxMountedRows: 178,
    heapGrowthBytes: 189_837_542,
  }),
});

// These ceilings are derived from the recorded measurements. Bundle ceilings allow a five
// percent migration margin; build time allows twenty percent; renderer ceilings include the
// observed jsdom run-to-run variance, while the 20k view must still virtualize to a bounded DOM.
export const DIFF_PERFORMANCE_BUDGET: Readonly<DiffPerformanceMeasurement> = {
  initialEntryRawBytes: 5_513_115,
  initialEntryGzipBytes: 1_646_907,
  javascriptRawBytes: 13_366_134,
  javascriptGzipBytes: 4_288_656,
  buildDurationMs: 59_730,
  parse20kMs: 30,
  render1kMs: 360,
  render20kMs: 3_650,
  mountedRows20k: 2_000,
};

export function compareDiffPerformanceBudget(
  measurement: DiffPerformanceMeasurement,
  budget: Readonly<DiffPerformanceMeasurement> = DIFF_PERFORMANCE_BUDGET,
): DiffPerformanceViolation[] {
  return (Object.keys(budget) as DiffPerformanceMetric[]).flatMap((metric) => {
    const actual = measurement[metric];
    const maximum = budget[metric];
    return actual > maximum ? [{ metric, actual, maximum }] : [];
  });
}
