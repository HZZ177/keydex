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
