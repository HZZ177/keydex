import { DIFF_PERFORMANCE_BUDGET } from "./diffPerformanceBaseline";

export interface DiffRuntimePerformanceSamples {
  readonly render20kMs: readonly number[];
  readonly interactionMs: readonly number[];
  readonly scrollMs: readonly number[];
  readonly longTaskMs: readonly number[];
  readonly mountedElements20k: number;
  readonly heapGrowthBytes: number;
}

export interface DiffRuntimePerformanceSummary {
  readonly render20kMedianMs: number;
  readonly interactionMedianMs: number;
  readonly scrollMedianMs: number;
  readonly maxLongTaskMs: number;
  readonly totalLongTaskMs: number;
  readonly mountedElements20k: number;
  readonly heapGrowthBytes: number;
}

export type DiffRuntimePerformanceMetric = keyof DiffRuntimePerformanceSummary;

export interface DiffRuntimePerformanceViolation {
  readonly metric: DiffRuntimePerformanceMetric;
  readonly actual: number;
  readonly maximum: number;
}

// Browser E2E runs against Vite's development transform pipeline. The first-render ceiling is
// therefore the DIFF-003 legacy 20k renderer budget with an explicit 4x development multiplier;
// interaction, long-task, mounted-element and heap limits protect the responsive user contract.
export const DIFF_RUNTIME_PERFORMANCE_BUDGET: Readonly<DiffRuntimePerformanceSummary> = Object.freeze({
  render20kMedianMs: DIFF_PERFORMANCE_BUDGET.render20kMs * 4,
  interactionMedianMs: 500,
  scrollMedianMs: 250,
  maxLongTaskMs: 1_500,
  totalLongTaskMs: 8_000,
  mountedElements20k: 12_000,
  heapGrowthBytes: 128 * 1024 * 1024,
});

export function medianPerformanceSample(samples: readonly number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function percentilePerformanceSample(
  samples: readonly number[],
  percentile: number,
): number {
  if (samples.length === 0) return 0;
  if (!Number.isFinite(percentile) || percentile < 0 || percentile > 1) {
    throw new RangeError("percentile must be between zero and one");
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(percentile * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

export function summarizeDiffRuntimePerformance(
  samples: DiffRuntimePerformanceSamples,
): DiffRuntimePerformanceSummary {
  return Object.freeze({
    render20kMedianMs: medianPerformanceSample(samples.render20kMs),
    interactionMedianMs: medianPerformanceSample(samples.interactionMs),
    scrollMedianMs: medianPerformanceSample(samples.scrollMs),
    maxLongTaskMs: samples.longTaskMs.length > 0 ? Math.max(...samples.longTaskMs) : 0,
    totalLongTaskMs: samples.longTaskMs.reduce((total, duration) => total + duration, 0),
    mountedElements20k: samples.mountedElements20k,
    heapGrowthBytes: samples.heapGrowthBytes,
  });
}

export function evaluateDiffRuntimePerformance(
  summary: DiffRuntimePerformanceSummary,
  budget: Readonly<DiffRuntimePerformanceSummary> = DIFF_RUNTIME_PERFORMANCE_BUDGET,
): DiffRuntimePerformanceViolation[] {
  return (Object.keys(budget) as DiffRuntimePerformanceMetric[]).flatMap((metric) => {
    const actual = summary[metric];
    const maximum = budget[metric];
    return actual > maximum ? [{ metric, actual, maximum }] : [];
  });
}

export interface AlignedDiffRuntimePerformanceSamples {
  readonly modelPreparationMs: readonly number[];
  readonly firstRenderMs: readonly number[];
  readonly scrollInputToPaintMs: readonly number[];
  readonly connectorGeometryMs: readonly number[];
  readonly resizeInteractionMs: readonly number[];
  readonly wrapInteractionMs: readonly number[];
  readonly syncInteractionMs: readonly number[];
  readonly longTaskMs: readonly number[];
  readonly mountedRows: readonly number[];
  readonly heapGrowthBytes: number;
  readonly resizeRehighlightCount: number;
  readonly wrapRehighlightCount: number;
  readonly syncRehighlightCount: number;
}

export interface AlignedDiffRuntimePerformanceSummary {
  readonly modelPreparationMedianMs: number;
  readonly firstRenderMedianMs: number;
  readonly scrollInputToPaintP95Ms: number;
  readonly connectorGeometryP95Ms: number;
  readonly resizeInteractionP95Ms: number;
  readonly wrapInteractionP95Ms: number;
  readonly syncInteractionP95Ms: number;
  readonly maxLongTaskMs: number;
  readonly maxMountedRows: number;
  readonly heapGrowthBytes: number;
  readonly resizeRehighlightCount: number;
  readonly wrapRehighlightCount: number;
  readonly syncRehighlightCount: number;
}

export type AlignedDiffRuntimePerformanceMetric = keyof AlignedDiffRuntimePerformanceSummary;

export interface AlignedDiffRuntimePerformanceViolation {
  readonly metric: AlignedDiffRuntimePerformanceMetric;
  readonly actual: number;
  readonly maximum: number;
}

/**
 * Aligned split budgets intentionally use input-to-paint P95 instead of an average. The model
 * and first-render ceilings retain the measured legacy development allowance, while the hot-path
 * limits are the product contract recorded by ASD-040. Theme changes are excluded from the
 * rehighlight counters because the canonical token cache deliberately includes the syntax theme.
 */
export const ALIGNED_DIFF_RUNTIME_PERFORMANCE_BUDGET: Readonly<AlignedDiffRuntimePerformanceSummary> = Object.freeze({
  modelPreparationMedianMs: DIFF_PERFORMANCE_BUDGET.render20kMs * 4,
  firstRenderMedianMs: DIFF_PERFORMANCE_BUDGET.render20kMs * 4,
  scrollInputToPaintP95Ms: 32,
  connectorGeometryP95Ms: 4,
  resizeInteractionP95Ms: 250,
  wrapInteractionP95Ms: 500,
  syncInteractionP95Ms: 250,
  maxLongTaskMs: 50,
  maxMountedRows: 2_000,
  // A 20k split retains the source patch, Pierre metadata, two token models and two height indexes.
  // The first aligned Chromium baseline retained ~191 MiB before browser GC, so the ceiling keeps
  // a bounded 192 MiB allowance while still catching duplicate full-model/DOM regressions.
  heapGrowthBytes: 192 * 1024 * 1024,
  resizeRehighlightCount: 0,
  wrapRehighlightCount: 0,
  syncRehighlightCount: 0,
});

export function summarizeAlignedDiffRuntimePerformance(
  samples: AlignedDiffRuntimePerformanceSamples,
): AlignedDiffRuntimePerformanceSummary {
  return Object.freeze({
    modelPreparationMedianMs: medianPerformanceSample(samples.modelPreparationMs),
    firstRenderMedianMs: medianPerformanceSample(samples.firstRenderMs),
    scrollInputToPaintP95Ms: percentilePerformanceSample(samples.scrollInputToPaintMs, 0.95),
    connectorGeometryP95Ms: percentilePerformanceSample(samples.connectorGeometryMs, 0.95),
    resizeInteractionP95Ms: percentilePerformanceSample(samples.resizeInteractionMs, 0.95),
    wrapInteractionP95Ms: percentilePerformanceSample(samples.wrapInteractionMs, 0.95),
    syncInteractionP95Ms: percentilePerformanceSample(samples.syncInteractionMs, 0.95),
    maxLongTaskMs: samples.longTaskMs.length > 0 ? Math.max(...samples.longTaskMs) : 0,
    maxMountedRows: samples.mountedRows.length > 0 ? Math.max(...samples.mountedRows) : 0,
    heapGrowthBytes: samples.heapGrowthBytes,
    resizeRehighlightCount: samples.resizeRehighlightCount,
    wrapRehighlightCount: samples.wrapRehighlightCount,
    syncRehighlightCount: samples.syncRehighlightCount,
  });
}

export function evaluateAlignedDiffRuntimePerformance(
  summary: AlignedDiffRuntimePerformanceSummary,
  budget: Readonly<AlignedDiffRuntimePerformanceSummary> = ALIGNED_DIFF_RUNTIME_PERFORMANCE_BUDGET,
): AlignedDiffRuntimePerformanceViolation[] {
  return (Object.keys(budget) as AlignedDiffRuntimePerformanceMetric[]).flatMap((metric) => {
    const actual = summary[metric];
    const maximum = budget[metric];
    return actual > maximum ? [{ metric, actual, maximum }] : [];
  });
}
