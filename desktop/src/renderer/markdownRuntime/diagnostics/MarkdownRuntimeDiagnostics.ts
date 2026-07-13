export type MarkdownRuntimeDiagnosticStage =
  | "ingress"
  | "transport"
  | "worker"
  | "parser"
  | "snapshot"
  | "renderer"
  | "measurement"
  | "resource"
  | "cache"
  | "host";

export type MarkdownRuntimeDiagnosticSeverity = "info" | "warning" | "error" | "fatal";
export type MarkdownRuntimeRecovery = "none" | "retain-snapshot" | "retry" | "restart-worker" | "isolate-block";

export interface MarkdownRuntimeDiagnosticEvent {
  readonly id: number;
  readonly timestamp: number;
  readonly stage: MarkdownRuntimeDiagnosticStage;
  readonly severity: MarkdownRuntimeDiagnosticSeverity;
  readonly code: string;
  readonly documentId: string | null;
  readonly revision: string | null;
  readonly recovery: MarkdownRuntimeRecovery;
  readonly detail: string | null;
  readonly blockId: string | null;
  readonly resourceId: string | null;
}

export interface MarkdownRuntimeDiagnosticInput extends Omit<MarkdownRuntimeDiagnosticEvent, "id" | "timestamp" | "detail"> {
  readonly detail?: unknown;
}

export interface MarkdownRuntimeDiagnosticsSnapshot {
  readonly events: readonly MarkdownRuntimeDiagnosticEvent[];
  readonly total: number;
  readonly dropped: number;
  readonly byStage: Readonly<Record<MarkdownRuntimeDiagnosticStage, number>>;
  readonly bySeverity: Readonly<Record<MarkdownRuntimeDiagnosticSeverity, number>>;
}

export interface MarkdownRuntimeDiagnosticsOptions {
  readonly maxEvents?: number;
  readonly sampleInfoEvery?: number;
  readonly now?: () => number;
}

type Subscriber = (event: MarkdownRuntimeDiagnosticEvent) => void;

const STAGES: readonly MarkdownRuntimeDiagnosticStage[] = [
  "ingress", "transport", "worker", "parser", "snapshot", "renderer", "measurement", "resource", "cache", "host",
];
const SEVERITIES: readonly MarkdownRuntimeDiagnosticSeverity[] = ["info", "warning", "error", "fatal"];

export class MarkdownRuntimeDiagnostics {
  private readonly events: MarkdownRuntimeDiagnosticEvent[] = [];
  private readonly subscribers = new Set<Subscriber>();
  private readonly maxEvents: number;
  private readonly sampleInfoEvery: number;
  private readonly now: () => number;
  private sequence = 0;
  private total = 0;
  private dropped = 0;
  private infoSequence = 0;

  constructor(options: MarkdownRuntimeDiagnosticsOptions = {}) {
    this.maxEvents = positiveInteger(options.maxEvents ?? 256, "maxEvents");
    this.sampleInfoEvery = positiveInteger(options.sampleInfoEvery ?? 20, "sampleInfoEvery");
    this.now = options.now ?? Date.now;
  }

  record(input: MarkdownRuntimeDiagnosticInput): MarkdownRuntimeDiagnosticEvent | null {
    this.total += 1;
    if (input.severity === "info" && ++this.infoSequence % this.sampleInfoEvery !== 1) {
      this.dropped += 1;
      return null;
    }
    const event = Object.freeze({
      ...input,
      id: ++this.sequence,
      timestamp: this.now(),
      documentId: safeIdentity(input.documentId),
      revision: safeIdentity(input.revision),
      code: safeCode(input.code),
      detail: safeDetail(input.detail),
      blockId: safeIdentity(input.blockId),
      resourceId: safeIdentity(input.resourceId),
    });
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
      this.dropped += 1;
    }
    for (const subscriber of this.subscribers) {
      try {
        subscriber(event);
      } catch {
        // Diagnostics observers cannot affect Runtime behavior.
      }
    }
    return event;
  }

  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  snapshot(): MarkdownRuntimeDiagnosticsSnapshot {
    const byStage = Object.fromEntries(STAGES.map((stage) => [stage, 0])) as Record<MarkdownRuntimeDiagnosticStage, number>;
    const bySeverity = Object.fromEntries(SEVERITIES.map((severity) => [severity, 0])) as Record<MarkdownRuntimeDiagnosticSeverity, number>;
    for (const event of this.events) {
      byStage[event.stage] += 1;
      bySeverity[event.severity] += 1;
    }
    return Object.freeze({
      events: Object.freeze([...this.events]),
      total: this.total,
      dropped: this.dropped,
      byStage: Object.freeze(byStage),
      bySeverity: Object.freeze(bySeverity),
    });
  }

  clear(): void {
    this.events.splice(0);
    this.total = 0;
    this.dropped = 0;
    this.infoSequence = 0;
  }
}

export const markdownRuntimeDiagnostics = new MarkdownRuntimeDiagnostics();

function safeDetail(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const message = value instanceof Error ? value.message : typeof value === "string" ? value : String(value);
  return message.replace(/[\r\n\t]+/gu, " ").replace(/\s{2,}/gu, " ").slice(0, 256) || null;
}

function safeIdentity(value: string | null): string | null {
  if (!value) return null;
  return value.replace(/[\r\n\t]/gu, "").slice(0, 256) || null;
}

function safeCode(value: string): string {
  const code = value.trim().replace(/[^a-z0-9._-]/giu, "-").slice(0, 80);
  return code || "unknown";
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}
