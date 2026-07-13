import type {
  ConversationMarkdownAdapter,
  ConversationMarkdownInput,
  ConversationMarkdownProjection,
} from "../adapters/ConversationMarkdownAdapter";
import type { MarkdownRuntimeStore } from "../MarkdownRuntimeStore";

export interface ConversationHydrationCandidate extends ConversationMarkdownInput {
  readonly order: number;
  readonly unitId: string;
}

export interface ConversationHydrationWindow {
  readonly sessionId: string;
  readonly candidates: readonly ConversationHydrationCandidate[];
  readonly mountedUnitIds: readonly string[];
  readonly navigationUnitIds?: readonly string[];
}

export interface ConversationHydrationDiagnostics {
  readonly sessionId: string | null;
  readonly generation: number;
  readonly candidates: number;
  readonly selected: number;
  readonly queued: number;
  readonly running: number;
  readonly hydrated: number;
  readonly cacheHits: number;
  readonly failures: number;
  readonly cancelled: number;
  readonly evicted: number;
  readonly knownProjections: number;
  readonly suspended: boolean;
  readonly hydratedMessageIds: readonly string[];
}

export interface ConversationHydrationSchedulerOptions {
  readonly store: MarkdownRuntimeStore;
  readonly adapter: ConversationMarkdownAdapter;
  readonly maxConcurrent?: number;
  readonly preheatUnits?: number;
  readonly maxWarmEntries?: number;
}

interface Task {
  readonly generation: number;
  readonly candidate: ConversationHydrationCandidate;
  readonly projection: ConversationMarkdownProjection;
  readonly priority: number;
  readonly distance: number;
  readonly key: string;
}

interface WarmEntry {
  readonly projection: ConversationMarkdownProjection;
  touchedAt: number;
}

/** Visible-first, bounded pre-hydration for settled conversation Markdown. */
export class ConversationHydrationScheduler {
  private readonly store: MarkdownRuntimeStore;
  private readonly adapter: ConversationMarkdownAdapter;
  private readonly maxConcurrent: number;
  private readonly preheatUnits: number;
  private readonly maxWarmEntries: number;
  private sessionId: string | null = null;
  private generation = 0;
  private sequence = 0;
  private candidateCount = 0;
  private selectedCount = 0;
  private queue: Task[] = [];
  private readonly running = new Map<string, AbortController>();
  private readonly warm = new Map<string, WarmEntry>();
  private readonly knownProjections = new Map<string, ConversationMarkdownProjection>();
  private hydrated = 0;
  private cacheHits = 0;
  private failures = 0;
  private cancelled = 0;
  private evicted = 0;
  private suspended = false;
  private disposed = false;

  constructor(options: ConversationHydrationSchedulerOptions) {
    this.store = options.store;
    this.adapter = options.adapter;
    this.maxConcurrent = positiveInteger(options.maxConcurrent ?? 2, "maxConcurrent");
    this.preheatUnits = nonNegativeInteger(options.preheatUnits ?? 8, "preheatUnits");
    this.maxWarmEntries = positiveInteger(options.maxWarmEntries ?? 64, "maxWarmEntries");
  }

  update(window: ConversationHydrationWindow): void {
    this.assertActive();
    this.suspended = false;
    if (this.sessionId !== window.sessionId) this.switchSession(window.sessionId);
    this.candidateCount = window.candidates.length;
    const selected = selectCandidates(window, this.preheatUnits);
    this.selectedCount = selected.length;
    const nextKeys = new Set<string>();
    const tasks: Task[] = [];
    for (const selection of selected) {
      const projection = this.adapter.project(selection.candidate);
      const key = `${projection.documentId}\u0000${projection.revision}`;
      // Streaming revisions are transient. Retaining by revision keeps one
      // progressively larger source string per update and eventually OOMs the
      // WebView. Adapter cleanup only needs the newest projection per document.
      this.knownProjections.set(projection.documentId, projection);
      nextKeys.add(key);
      if (this.warm.has(key) || this.running.has(key)) {
        const entry = this.warm.get(key);
        if (entry) entry.touchedAt = ++this.sequence;
        continue;
      }
      tasks.push({
        generation: this.generation,
        candidate: selection.candidate,
        projection,
        priority: selection.priority,
        distance: selection.distance,
        key,
      });
    }
    this.queue = [
      ...this.queue.filter((task) => task.generation === this.generation && nextKeys.has(task.key)),
      ...tasks,
    ];
    this.queue = uniqueTasks(this.queue).sort(compareTasks);
    this.pruneKnownProjections(new Set(selected.map((entry) => entry.candidate.message.id)));
    this.pump();
  }

  switchSession(sessionId: string): void {
    this.assertActive();
    if (this.sessionId === sessionId) return;
    const previous = this.sessionId;
    this.generation += 1;
    this.sessionId = sessionId;
    this.queue = [];
    for (const controller of this.running.values()) controller.abort("session-switch");
    this.running.clear();
    for (const projection of this.knownProjections.values()) {
      this.adapter.forget(projection.sessionId, projection.messageId);
    }
    this.warm.clear();
    this.knownProjections.clear();
    if (previous) this.evicted += this.store.evictDetachedMessageSession(previous);
  }

  /** User input preempts speculative parsing; visible message hosts still load themselves. */
  suspend(): void {
    this.assertActive();
    if (this.suspended) return;
    this.suspended = true;
    for (const controller of this.running.values()) controller.abort("user-scroll");
    this.running.clear();
  }

  diagnostics(): ConversationHydrationDiagnostics {
    return Object.freeze({
      sessionId: this.sessionId,
      generation: this.generation,
      candidates: this.candidateCount,
      selected: this.selectedCount,
      queued: this.queue.length,
      running: this.running.size,
      hydrated: this.hydrated,
      cacheHits: this.cacheHits,
      failures: this.failures,
      cancelled: this.cancelled,
      evicted: this.evicted,
      knownProjections: this.knownProjections.size,
      suspended: this.suspended,
      hydratedMessageIds: Object.freeze([...this.warm.values()].map((entry) => entry.projection.messageId)),
    });
  }

  destroy(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.queue = [];
    for (const controller of this.running.values()) controller.abort("scheduler-destroy");
    this.running.clear();
    for (const entry of this.warm.values()) {
      this.store.evict(entry.projection.identity);
    }
    for (const projection of this.knownProjections.values()) {
      this.adapter.forget(projection.sessionId, projection.messageId);
    }
    this.warm.clear();
    this.knownProjections.clear();
  }

  private pump(): void {
    while (!this.disposed && !this.suspended && this.running.size < this.maxConcurrent && this.queue.length) {
      const task = this.queue.shift()!;
      if (task.generation !== this.generation || this.warm.has(task.key) || this.running.has(task.key)) continue;
      const controller = new AbortController();
      this.running.set(task.key, controller);
      const attachment = this.adapter.attach(
        this.store,
        task.candidate,
        `conversation-hydration:${this.generation}:${++this.sequence}`,
      );
      if (attachment.runtime.current()?.revision === task.projection.revision) this.cacheHits += 1;
      void attachment.load(controller.signal).then(() => {
        if (task.generation !== this.generation || controller.signal.aborted) {
          this.cancelled += 1;
          return;
        }
        this.hydrated += 1;
        this.dropSupersededWarmRevisions(task.projection.documentId, task.key);
        this.warm.set(task.key, { projection: task.projection, touchedAt: ++this.sequence });
        this.enforceWarmBudget();
      }).catch((error: unknown) => {
        if (controller.signal.aborted || isAbort(error)) this.cancelled += 1;
        else this.failures += 1;
      }).finally(() => {
        attachment.detach();
        if (this.running.get(task.key) === controller) this.running.delete(task.key);
        this.pump();
      });
    }
  }

  private enforceWarmBudget(): void {
    while (this.warm.size > this.maxWarmEntries) {
      const oldest = [...this.warm.entries()].sort((left, right) => left[1].touchedAt - right[1].touchedAt)[0];
      if (!oldest) return;
      this.warm.delete(oldest[0]);
      if (this.store.evict(oldest[1].projection.identity)) this.evicted += 1;
    }
  }

  private dropSupersededWarmRevisions(documentId: string, currentKey: string): void {
    for (const [key, entry] of this.warm) {
      if (key !== currentKey && entry.projection.documentId === documentId) this.warm.delete(key);
    }
  }

  private pruneKnownProjections(selectedMessageIds: ReadonlySet<string>): void {
    const retainedDocuments = new Set<string>();
    for (const entry of this.warm.values()) retainedDocuments.add(entry.projection.documentId);
    for (const task of this.queue) retainedDocuments.add(task.projection.documentId);
    for (const key of this.running.keys()) {
      const separator = key.lastIndexOf("\u0000");
      retainedDocuments.add(separator >= 0 ? key.slice(0, separator) : key);
    }
    for (const [documentId, projection] of this.knownProjections) {
      if (selectedMessageIds.has(projection.messageId) || retainedDocuments.has(documentId)) continue;
      this.adapter.forget(projection.sessionId, projection.messageId);
      this.knownProjections.delete(documentId);
    }
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("ConversationHydrationScheduler is destroyed");
  }
}

function selectCandidates(window: ConversationHydrationWindow, preheatUnits: number): Array<{
  candidate: ConversationHydrationCandidate;
  priority: number;
  distance: number;
}> {
  const mounted = new Set(window.mountedUnitIds);
  const navigation = new Set(window.navigationUnitIds ?? []);
  const mountedOrders = window.candidates
    .filter((candidate) => mounted.has(candidate.unitId))
    .map((candidate) => candidate.order)
    .sort((left, right) => left - right);
  const selected = new Map<string, { candidate: ConversationHydrationCandidate; priority: number; distance: number }>();
  for (const candidate of window.candidates) {
    const projectionStatus = typeof candidate.message.status === "string" ? candidate.message.status : "completed";
    const streaming = candidate.message.kind === "assistant" && (projectionStatus === "pending" || projectionStatus === "running");
    // Live messages own an attached StreamingTailView and incremental Worker
    // request chain already. Canonically hydrating every transient revision in
    // parallel duplicates the full snapshot and can exhaust WebView memory.
    if (streaming) continue;
    const isMounted = mounted.has(candidate.unitId);
    const isNavigation = navigation.has(candidate.unitId);
    const distance = nearestOrderDistance(mountedOrders, candidate.order);
    if (!streaming && !isMounted && !isNavigation && distance > preheatUnits) continue;
    selected.set(candidate.message.id, {
      candidate,
      priority: isNavigation ? 1 : isMounted ? 2 : 3,
      distance,
    });
  }
  return [...selected.values()];
}

function nearestOrderDistance(sortedOrders: readonly number[], target: number): number {
  if (!sortedOrders.length) return Number.POSITIVE_INFINITY;
  let low = 0;
  let high = sortedOrders.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (sortedOrders[middle] < target) low = middle + 1;
    else high = middle;
  }
  return Math.min(
    low < sortedOrders.length ? Math.abs(sortedOrders[low] - target) : Number.POSITIVE_INFINITY,
    low > 0 ? Math.abs(sortedOrders[low - 1] - target) : Number.POSITIVE_INFINITY,
  );
}

function uniqueTasks(tasks: readonly Task[]): Task[] {
  const byKey = new Map<string, Task>();
  for (const task of tasks) {
    const current = byKey.get(task.key);
    if (!current || compareTasks(task, current) < 0) byKey.set(task.key, task);
  }
  return [...byKey.values()];
}

function compareTasks(left: Task, right: Task): number {
  return left.priority - right.priority || left.distance - right.distance || left.candidate.order - right.candidate.order;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
    || error instanceof Error && error.name === "AbortError";
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}
