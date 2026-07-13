import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { summarizeMarkdownPerformance } from "@/renderer/markdownRuntime/diagnostics/performanceMetrics";

import {
  MIB,
  generateMarkdownRuntimeFixture,
  markdownRuntimeFixtureSpec,
  type MarkdownFixtureSpec,
} from "./markdown-runtime";

export const ZED_BASELINE_SCHEMA_VERSION = "zed-keydex-baseline/v1";

export const zedComparableMetrics = Object.freeze([
  "open.first_visible_ms",
  "open.first_paint_ms",
  "reveal.stable_ms",
  "scroll.presented_frame_interval_ms",
  "scroll.visible_stall_ms",
] as const);

export const rendererInternalOnlyMetrics = Object.freeze([
  "keydex.main_thread.long_task_ms",
  "keydex.dom.node_count",
  "keydex.memory.js_heap_bytes",
  "zed.gpui.scene_build_ms",
  "zed.gpui.element_cache_bytes",
  "zed.gpu.frame_ms",
] as const);

export type ZedComparableMetric = (typeof zedComparableMetrics)[number];
export type ZedBaselineProduct = "zed" | "keydex";
export type ZedBaselineOperation = "open" | "reveal" | "scroll";
export type ZedBaselineCacheMode = "cold" | "warm";
export type ZedBaselineCaptureMethod = "screen-frame-analysis" | "instrumented-keydex";

export interface ZedBaselineRun {
  readonly schemaVersion: string;
  readonly runId: string;
  readonly product: ZedBaselineProduct;
  readonly productRevision: string;
  readonly capturedAt: string;
  readonly captureMethod: ZedBaselineCaptureMethod;
  readonly machineFingerprint: string;
  readonly environment: {
    readonly os: string;
    readonly cpu: string;
    readonly memoryBytes: number;
    readonly gpu: string;
    readonly driver: string;
    readonly webviewRuntime?: string;
  };
  readonly viewport: {
    readonly width: number;
    readonly height: number;
    readonly devicePixelRatio: number;
  };
  readonly fixture: {
    readonly id: string;
    readonly generatorVersion: string;
    readonly hash: string;
    readonly bytes: number;
  };
  readonly cacheMode: ZedBaselineCacheMode;
  readonly operation: ZedBaselineOperation;
  readonly metric: ZedComparableMetric;
  readonly rawSamples: readonly number[];
}

export interface ZedBaselineMatrixCase {
  readonly fixtureId: string;
  readonly cacheMode: ZedBaselineCacheMode;
  readonly operation: ZedBaselineOperation;
  readonly minimumSamples: number;
}

export interface ZedBaselineValidation {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

export interface ZedBaselineComparison {
  readonly zed: ZedBaselineRun;
  readonly keydex: ZedBaselineRun;
  readonly zedSummary: NonNullable<ReturnType<typeof summarizeMarkdownPerformance>>;
  readonly keydexSummary: NonNullable<ReturnType<typeof summarizeMarkdownPerformance>>;
}

const baselineFixtureIds = Object.freeze(["mixed-250k", "mixed-1m", "mixed-5m", "mixed-10m"]);
const cacheModes: readonly ZedBaselineCacheMode[] = Object.freeze(["cold", "warm"]);
const operations: readonly ZedBaselineOperation[] = Object.freeze(["open", "reveal", "scroll"]);

export function createZedBaselineMatrix(): readonly ZedBaselineMatrixCase[] {
  return Object.freeze(
    baselineFixtureIds.flatMap((fixtureId) =>
      cacheModes.flatMap((cacheMode) =>
        operations.map((operation) =>
          Object.freeze({
            fixtureId,
            cacheMode,
            operation,
            minimumSamples: minimumSamplesForOperation(operation),
          }),
        ),
      ),
    ),
  );
}

export function validateZedBaselineRun(run: ZedBaselineRun): ZedBaselineValidation {
  const errors: string[] = [];
  if (run.schemaVersion !== ZED_BASELINE_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${ZED_BASELINE_SCHEMA_VERSION}`);
  }
  if (!run.runId.trim() || !run.productRevision.trim() || !run.machineFingerprint.trim()) {
    errors.push("runId, productRevision, and machineFingerprint are required");
  }
  if (!Number.isFinite(Date.parse(run.capturedAt))) {
    errors.push("capturedAt must be an ISO timestamp");
  }
  if (run.product === "zed" && run.captureMethod !== "screen-frame-analysis") {
    errors.push("Zed comparable runs must use external screen-frame-analysis");
  }
  if (!zedComparableMetrics.includes(run.metric)) {
    errors.push(`metric is not comparable across Zed and Keydex: ${run.metric}`);
  }
  if (!baselineFixtureIds.includes(run.fixture.id)) {
    errors.push(`fixture is outside the baseline matrix: ${run.fixture.id}`);
  }
  if (!run.fixture.hash.trim() || !run.fixture.generatorVersion.trim() || run.fixture.bytes <= 0) {
    errors.push("fixture generatorVersion, hash, and positive bytes are required");
  }
  if (
    !Number.isSafeInteger(run.viewport.width)
    || !Number.isSafeInteger(run.viewport.height)
    || run.viewport.width <= 0
    || run.viewport.height <= 0
    || !Number.isFinite(run.viewport.devicePixelRatio)
    || run.viewport.devicePixelRatio <= 0
  ) {
    errors.push("viewport width, height, and devicePixelRatio must be positive");
  }
  const minimumSamples = minimumSamplesForOperation(run.operation);
  if (run.rawSamples.length < minimumSamples) {
    errors.push(`${run.operation} requires at least ${minimumSamples} raw samples`);
  }
  if (run.rawSamples.some((sample) => !Number.isFinite(sample) || sample < 0)) {
    errors.push("rawSamples must contain only finite non-negative values");
  }
  return Object.freeze({ valid: errors.length === 0, errors: Object.freeze(errors) });
}

export function compareZedAndKeydexRuns(left: ZedBaselineRun, right: ZedBaselineRun): ZedBaselineComparison {
  const zed = left.product === "zed" ? left : right;
  const keydex = left.product === "keydex" ? left : right;
  if (zed.product !== "zed" || keydex.product !== "keydex") {
    throw new Error("Comparison requires one Zed run and one Keydex run");
  }
  const zedValidation = validateZedBaselineRun(zed);
  const keydexValidation = validateZedBaselineRun(keydex);
  if (!zedValidation.valid || !keydexValidation.valid) {
    throw new Error(`Invalid baseline run: ${[...zedValidation.errors, ...keydexValidation.errors].join("; ")}`);
  }

  assertEqual("machineFingerprint", zed.machineFingerprint, keydex.machineFingerprint);
  assertEqual("fixture.id", zed.fixture.id, keydex.fixture.id);
  assertEqual("fixture.generatorVersion", zed.fixture.generatorVersion, keydex.fixture.generatorVersion);
  assertEqual("fixture.hash", zed.fixture.hash, keydex.fixture.hash);
  assertEqual("fixture.bytes", zed.fixture.bytes, keydex.fixture.bytes);
  assertEqual("viewport.width", zed.viewport.width, keydex.viewport.width);
  assertEqual("viewport.height", zed.viewport.height, keydex.viewport.height);
  assertEqual("viewport.devicePixelRatio", zed.viewport.devicePixelRatio, keydex.viewport.devicePixelRatio);
  assertEqual("cacheMode", zed.cacheMode, keydex.cacheMode);
  assertEqual("operation", zed.operation, keydex.operation);
  assertEqual("metric", zed.metric, keydex.metric);

  const zedSummary = summarizeMarkdownPerformance(zed.rawSamples);
  const keydexSummary = summarizeMarkdownPerformance(keydex.rawSamples);
  if (!zedSummary || !keydexSummary) {
    throw new Error("Comparison has no valid raw samples");
  }
  return Object.freeze({ zed, keydex, zedSummary, keydexSummary });
}

export function materializeZedOneMiBFixture(
  outputPath: string,
  options: { readonly optIn: boolean; readonly spec?: MarkdownFixtureSpec },
): { readonly markdownPath: string; readonly manifestPath: string; readonly hash: string } {
  if (!options.optIn) {
    throw new Error("Zed fixture materialization requires explicit optIn=true");
  }
  const spec = options.spec ?? markdownRuntimeFixtureSpec("mixed-1m");
  if (spec.targetBytes !== MIB) {
    throw new Error(`Zed opt-in fixture must be exactly 1 MiB, got ${spec.targetBytes}`);
  }
  const generated = generateMarkdownRuntimeFixture(spec);
  const manifestPath = `${outputPath}.fixture.json`;
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, generated.source, "utf8");
  writeFileSync(manifestPath, `${JSON.stringify(generated.metadata, null, 2)}\n`, "utf8");
  return Object.freeze({ markdownPath: outputPath, manifestPath, hash: generated.metadata.hash });
}

function minimumSamplesForOperation(operation: ZedBaselineOperation): number {
  return operation === "scroll" ? 300 : 10;
}

function assertEqual(label: string, left: string | number, right: string | number): void {
  if (left !== right) {
    throw new Error(`${label} mismatch: ${left} !== ${right}`);
  }
}

