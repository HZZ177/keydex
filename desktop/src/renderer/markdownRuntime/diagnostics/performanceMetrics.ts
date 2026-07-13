export const MARKDOWN_PERFORMANCE_PROTOCOL_VERSION = "markdown-performance/v1";

export const MARKDOWN_PERFORMANCE_MARKS = [
  "request_start",
  "file_read_start",
  "file_read_end",
  "transport_start",
  "transport_end",
  "worker_queue_enter",
  "worker_queue_exit",
  "parse_start",
  "parse_end",
  "snapshot_published",
  "viewport_patch_start",
  "viewport_patch_end",
  "first_visible_content",
  "first_paint",
  "resource_settled",
  "conversation_ingress_first",
  "conversation_display_batch_first",
  "conversation_tail_parse_first",
  "conversation_tail_patch_first",
  "conversation_first_visible_token",
  "session_restore_start",
  "visible_hydration_complete",
] as const;

export const MARKDOWN_PERFORMANCE_EVENTS = [
  "reveal_requested",
  "reveal_stable",
  "annotation_reveal_requested",
  "annotation_reveal_stable",
  "turn_navigation_requested",
  "turn_navigation_stable",
  "workbench_capsule_navigation_requested",
  "workbench_capsule_navigation_stable",
  "conversation_content_ingress",
  "conversation_display_batch",
  "conversation_tail_parse",
  "conversation_tail_patch",
  "conversation_stream_frame",
  "bottom_follow_stable",
  "history_prepend_start",
  "history_anchor_restored",
] as const;

export const MARKDOWN_PERFORMANCE_SAMPLES = [
  "main_thread.long_task_ms",
  "main_thread.frame_interval_ms",
  "worker.queue_ms",
  "worker.parse_ms",
  "viewport.patch_ms",
  "reveal.latency_ms",
  "navigation.latency_ms",
  "dom.node_count",
  "dom.mounted_block_count",
  "cache.document_bytes",
  "cache.resource_bytes",
  "memory.js_heap_bytes",
  "memory.worker_heap_bytes",
  "memory.python_rss_bytes",
  "memory.webview_rss_bytes",
  "conversation.stable_message_rerenders",
  "conversation.timeline_dom_count",
] as const;

export type MarkdownPerformanceMarkName = (typeof MARKDOWN_PERFORMANCE_MARKS)[number];
export type MarkdownPerformanceEventName = (typeof MARKDOWN_PERFORMANCE_EVENTS)[number];
export type MarkdownPerformanceSampleName = (typeof MARKDOWN_PERFORMANCE_SAMPLES)[number];
export type MarkdownPerformanceSurface = "file" | "conversation";
export type MarkdownPerformanceCacheMode = "cold" | "warm";
export type MarkdownPerformanceDetailLevel = "marks" | "full";

export interface MarkdownPerformanceEnvironment {
  readonly os: string;
  readonly appVersion: string;
  readonly webviewRuntime: string;
  readonly pythonRuntime: string;
  readonly cpu: string;
  readonly logicalCpuCount: number;
  readonly memoryBytes: number;
  readonly gpu: string;
  readonly driver: string;
  readonly windowWidth: number;
  readonly windowHeight: number;
  readonly devicePixelRatio: number;
}

export interface MarkdownPerformanceFixtureIdentity {
  readonly id: string;
  readonly generatorVersion: string;
  readonly hash: string;
  readonly bytes: number;
  readonly lines: number;
  readonly blocks: number;
}

export interface MarkdownPerformanceContext {
  readonly runId: string;
  readonly surface: MarkdownPerformanceSurface;
  readonly cacheMode: MarkdownPerformanceCacheMode;
  readonly fixture: MarkdownPerformanceFixtureIdentity;
  readonly environment: MarkdownPerformanceEnvironment;
}

export interface MarkdownPerformanceEntry<Name extends string = string> {
  readonly name: Name;
  readonly atMs: number;
  readonly details?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface MarkdownPerformanceSample extends MarkdownPerformanceEntry<MarkdownPerformanceSampleName> {
  readonly value: number;
  readonly unit: "ms" | "count" | "bytes";
}

export type MarkdownPerformanceIssueCode =
  | "duplicate_mark"
  | "missing_mark"
  | "clock_reversed"
  | "invalid_first_visible_content"
  | "invalid_sample"
  | "invalid_resource_state";

export interface MarkdownPerformanceIssue {
  readonly code: MarkdownPerformanceIssueCode;
  readonly message: string;
  readonly entryName?: string;
}

export interface MarkdownPerformanceSnapshot {
  readonly protocolVersion: string;
  readonly enabled: boolean;
  readonly detailLevel: MarkdownPerformanceDetailLevel;
  readonly context: MarkdownPerformanceContext;
  readonly marks: readonly MarkdownPerformanceEntry<MarkdownPerformanceMarkName>[];
  readonly events: readonly MarkdownPerformanceEntry<MarkdownPerformanceEventName>[];
  readonly samples: readonly MarkdownPerformanceSample[];
  readonly issues: readonly MarkdownPerformanceIssue[];
  readonly valid: boolean;
}

export interface MarkdownPerformanceRecorderOptions {
  readonly enabled?: boolean;
  readonly detailLevel?: MarkdownPerformanceDetailLevel;
  readonly now?: () => number;
}

export interface MarkdownPerformancePercentiles {
  readonly count: number;
  readonly min: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
}

export class MarkdownPerformanceRecorder {
  readonly enabled: boolean;
  readonly detailLevel: MarkdownPerformanceDetailLevel;

  private readonly now: () => number;
  private readonly marks: MarkdownPerformanceEntry<MarkdownPerformanceMarkName>[] = [];
  private readonly events: MarkdownPerformanceEntry<MarkdownPerformanceEventName>[] = [];
  private readonly samples: MarkdownPerformanceSample[] = [];
  private readonly issues: MarkdownPerformanceIssue[] = [];
  private readonly markNames = new Set<MarkdownPerformanceMarkName>();
  private lastTimestamp = Number.NEGATIVE_INFINITY;

  constructor(
    readonly context: MarkdownPerformanceContext,
    options: MarkdownPerformanceRecorderOptions = {},
  ) {
    this.enabled = options.enabled ?? false;
    this.detailLevel = options.detailLevel ?? "marks";
    this.now = options.now ?? defaultNow;
  }

  mark(
    name: MarkdownPerformanceMarkName,
    details?: MarkdownPerformanceEntry["details"],
  ): boolean {
    if (!this.enabled) {
      return false;
    }
    const atMs = this.readTimestamp(name);
    if (atMs === null) {
      return false;
    }
    if (this.markNames.has(name)) {
      this.addIssue("duplicate_mark", `Duplicate performance mark: ${name}`, name);
      return false;
    }
    if (name === "first_visible_content" && details?.contentKind !== "text") {
      this.addIssue(
        "invalid_first_visible_content",
        "first_visible_content requires contentKind=text; skeleton, loading, and empty states are not accepted",
        name,
      );
      return false;
    }
    this.markNames.add(name);
    this.marks.push(freezeEntry({ name, atMs, details }));
    return true;
  }

  event(
    name: MarkdownPerformanceEventName,
    details?: MarkdownPerformanceEntry["details"],
  ): boolean {
    if (!this.enabled) {
      return false;
    }
    const atMs = this.readTimestamp(name);
    if (atMs === null) {
      return false;
    }
    this.events.push(freezeEntry({ name, atMs, details }));
    return true;
  }

  sample(
    name: MarkdownPerformanceSampleName,
    value: number,
    unit: MarkdownPerformanceSample["unit"],
    details?: MarkdownPerformanceEntry["details"],
  ): boolean {
    if (!this.enabled || this.detailLevel !== "full") {
      return false;
    }
    const atMs = this.readTimestamp(name);
    if (atMs === null) {
      return false;
    }
    if (!Number.isFinite(value) || value < 0) {
      this.addIssue("invalid_sample", `Invalid ${name} sample: ${value}`, name);
      return false;
    }
    this.samples.push(Object.freeze({ name, atMs, value, unit, details: freezeDetails(details) }));
    return true;
  }

  markResourcesSettled(total: number, failed: number): boolean {
    if (!this.enabled) {
      return false;
    }
    if (!Number.isSafeInteger(total) || !Number.isSafeInteger(failed) || total < 0 || failed < 0 || failed > total) {
      this.addIssue(
        "invalid_resource_state",
        `Invalid resource settlement: total=${total}, failed=${failed}`,
        "resource_settled",
      );
      return false;
    }
    return this.mark("resource_settled", { total, failed, contentKind: total === 0 ? "no-resources" : "resources" });
  }

  duration(start: MarkdownPerformanceMarkName, end: MarkdownPerformanceMarkName): number | null {
    const startEntry = this.marks.find((entry) => entry.name === start);
    const endEntry = this.marks.find((entry) => entry.name === end);
    return startEntry && endEntry ? endEntry.atMs - startEntry.atMs : null;
  }

  finalize(requiredMarks: readonly MarkdownPerformanceMarkName[] = []): MarkdownPerformanceSnapshot {
    const finalIssues = [...this.issues];
    for (const required of requiredMarks) {
      if (!this.markNames.has(required)) {
        finalIssues.push(
          Object.freeze({
            code: "missing_mark" as const,
            message: `Missing required performance mark: ${required}`,
            entryName: required,
          }),
        );
      }
    }
    return Object.freeze({
      protocolVersion: MARKDOWN_PERFORMANCE_PROTOCOL_VERSION,
      enabled: this.enabled,
      detailLevel: this.detailLevel,
      context: this.context,
      marks: Object.freeze([...this.marks]),
      events: Object.freeze([...this.events]),
      samples: Object.freeze([...this.samples]),
      issues: Object.freeze(finalIssues),
      valid: this.enabled && finalIssues.length === 0,
    });
  }

  private readTimestamp(entryName: string): number | null {
    const current = this.now();
    if (!Number.isFinite(current) || current < this.lastTimestamp) {
      this.addIssue(
        "clock_reversed",
        `Non-monotonic performance clock at ${entryName}: ${current} < ${this.lastTimestamp}`,
        entryName,
      );
      return null;
    }
    this.lastTimestamp = current;
    return current;
  }

  private addIssue(code: MarkdownPerformanceIssueCode, message: string, entryName?: string): void {
    this.issues.push(Object.freeze({ code, message, entryName }));
  }
}

export function summarizeMarkdownPerformance(values: readonly number[]): MarkdownPerformancePercentiles | null {
  const sorted = values.filter((value) => Number.isFinite(value) && value >= 0).sort((left, right) => left - right);
  if (!sorted.length) {
    return null;
  }
  return Object.freeze({
    count: sorted.length,
    min: sorted[0],
    p50: nearestRank(sorted, 0.5),
    p95: nearestRank(sorted, 0.95),
    p99: nearestRank(sorted, 0.99),
    max: sorted[sorted.length - 1],
  });
}

function nearestRank(sorted: readonly number[], percentile: number): number {
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)];
}

function freezeEntry<Name extends string>(
  entry: MarkdownPerformanceEntry<Name>,
): MarkdownPerformanceEntry<Name> {
  return Object.freeze({ ...entry, details: freezeDetails(entry.details) });
}

function freezeDetails(
  details: MarkdownPerformanceEntry["details"],
): MarkdownPerformanceEntry["details"] {
  return details ? Object.freeze({ ...details }) : undefined;
}

function defaultNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

