import type { WorkerPoolManager, WorkerStats } from "@pierre/diffs/worker";

import type { KeydexDiffTheme } from "./pierreOptions";
import {
  createPierreWorkerHighlighterOptions,
  createPierreWorkerPoolOptions,
  createPierreWorkerThemeRefresh,
} from "./pierreOptions";
import {
  loadPierreDiffs,
  type PierreDiffsReactModule,
} from "./loadPierreDiffs";

export type PierreWorkerPoolStatus = "idle" | "loading" | "ready" | "error";

export interface PierreWorkerPoolDiagnostics {
  readonly status: PierreWorkerPoolStatus;
  readonly references: number;
  readonly theme: KeydexDiffTheme;
  readonly cacheEpoch: number;
  readonly generation: number;
  readonly workers: Readonly<WorkerStats> | null;
  readonly lastError: string | null;
}

export interface PierreWorkerPoolRuntime {
  readonly module: PierreDiffsReactModule;
  readonly manager: WorkerPoolManager;
}

export interface PierreWorkerPoolLifecycleOptions {
  readonly loadModule?: () => Promise<PierreDiffsReactModule>;
  readonly releaseDelayMs?: number;
  readonly hardwareConcurrency?: number;
  readonly schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly cancelScheduled?: (handle: ReturnType<typeof setTimeout>) => void;
}

type Listener = () => void;

// A short page switch should not pay the dynamic import, worker creation and
// highlighter warmup cost again. Explicit app teardown still releases at once.
const DEFAULT_RELEASE_DELAY_MS = 10_000;

export class PierreWorkerPoolLifecycle {
  private readonly listeners = new Set<Listener>();
  private readonly loadModule: () => Promise<PierreDiffsReactModule>;
  private readonly releaseDelayMs: number;
  private readonly hardwareConcurrency: number | undefined;
  private readonly schedule: NonNullable<PierreWorkerPoolLifecycleOptions["schedule"]>;
  private readonly cancelScheduled: NonNullable<PierreWorkerPoolLifecycleOptions["cancelScheduled"]>;
  private references = 0;
  private theme: KeydexDiffTheme = "light";
  private cacheEpoch = 0;
  private generation = 0;
  private runtime: PierreWorkerPoolRuntime | null = null;
  private pending: Promise<void> | null = null;
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribeStats: (() => void) | null = null;
  private diagnostics: PierreWorkerPoolDiagnostics = freezeDiagnostics({
    status: "idle",
    references: 0,
    theme: "light",
    cacheEpoch: 0,
    generation: 0,
    workers: null,
    lastError: null,
  });

  constructor(options: PierreWorkerPoolLifecycleOptions = {}) {
    this.loadModule = options.loadModule ?? loadPierreDiffs;
    this.releaseDelayMs = options.releaseDelayMs ?? DEFAULT_RELEASE_DELAY_MS;
    this.hardwareConcurrency = options.hardwareConcurrency;
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.cancelScheduled = options.cancelScheduled ?? ((handle) => clearTimeout(handle));
  }

  readonly snapshot = (): PierreWorkerPoolDiagnostics => this.diagnostics;

  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  acquire(theme: KeydexDiffTheme): () => void {
    this.cancelRelease();
    this.references += 1;
    this.updateTheme(theme);
    this.publish();
    void this.ensureStarted();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.references = Math.max(0, this.references - 1);
      this.publish();
      if (this.references === 0) this.scheduleRelease();
    };
  }

  updateTheme(theme: KeydexDiffTheme): void {
    if (this.theme === theme) return;
    this.theme = theme;
    this.cacheEpoch += 1;
    const manager = this.runtime?.manager;
    if (manager) {
      evictWorkerPoolCaches(manager);
      void manager.setRenderOptions(createPierreWorkerThemeRefresh(theme)).catch((reason: unknown) => {
        this.publishError(reason);
      });
    }
    this.publish();
  }

  runtimeSnapshot(): PierreWorkerPoolRuntime | null {
    return this.runtime;
  }

  terminateImmediately(): void {
    this.cancelRelease();
    this.generation += 1;
    this.pending = null;
    this.unsubscribeStats?.();
    this.unsubscribeStats = null;
    const runtime = this.runtime;
    this.runtime = null;
    runtime?.module.terminateWorkerPoolSingleton();
    this.cacheEpoch += 1;
    this.publish("idle", null);
  }

  async retry(): Promise<void> {
    if (this.references === 0) return;
    this.terminateImmediately();
    await this.ensureStarted();
  }

  private async ensureStarted(): Promise<void> {
    if (this.runtime || this.pending || this.references === 0) return;
    const generation = ++this.generation;
    this.publish("loading", null);
    const pending = this.loadModule()
      .then((module) => {
        if (generation !== this.generation || this.references === 0) {
          module.terminateWorkerPoolSingleton();
          return;
        }
        const manager = module.getOrCreateWorkerPoolSingleton({
          poolOptions: createPierreWorkerPoolOptions(
            module.pierreWorkerFactory,
            this.hardwareConcurrency,
          ),
          highlighterOptions: createPierreWorkerHighlighterOptions(this.theme),
        });
        this.runtime = Object.freeze({ module, manager });
        this.cacheEpoch += 1;
        this.unsubscribeStats = manager.subscribeToStatChanges(() => this.publish());
        this.publish("ready", null);
      })
      .catch((reason: unknown) => {
        if (generation === this.generation) this.publishError(reason);
      })
      .finally(() => {
        if (this.pending === pending) this.pending = null;
      });
    this.pending = pending;
    await pending;
  }

  private scheduleRelease() {
    if (this.releaseTimer !== null) return;
    this.releaseTimer = this.schedule(() => {
      this.releaseTimer = null;
      if (this.references === 0) this.terminateImmediately();
    }, this.releaseDelayMs);
  }

  private cancelRelease() {
    if (this.releaseTimer === null) return;
    this.cancelScheduled(this.releaseTimer);
    this.releaseTimer = null;
  }

  private publishError(reason: unknown) {
    const message = reason instanceof Error ? reason.message : String(reason);
    this.publish("error", message);
  }

  private publish(
    status = this.runtime ? "ready" : this.pending ? "loading" : this.diagnostics.status,
    lastError = this.diagnostics.lastError,
  ) {
    this.diagnostics = freezeDiagnostics({
      status,
      references: this.references,
      theme: this.theme,
      cacheEpoch: this.cacheEpoch,
      generation: this.generation,
      workers: this.runtime ? this.runtime.manager.getStats() : null,
      lastError,
    });
    this.listeners.forEach((listener) => listener());
  }
}

export function pierreWorkerCacheKey(
  cacheKey: string,
  diagnostics: Pick<PierreWorkerPoolDiagnostics, "theme" | "cacheEpoch">,
): string {
  return `${cacheKey}:pierre-${diagnostics.theme}-${diagnostics.cacheEpoch}`;
}

function evictWorkerPoolCaches(manager: WorkerPoolManager) {
  const { fileCache, diffCache } = manager.inspectCaches();
  const fileCacheKeys: string[] = [];
  const diffCacheKeys: string[] = [];
  fileCache.forEach((_value, cacheKey) => fileCacheKeys.push(cacheKey));
  diffCache.forEach((_value, cacheKey) => diffCacheKeys.push(cacheKey));
  fileCacheKeys.forEach((cacheKey) => manager.evictFileFromCache(cacheKey));
  diffCacheKeys.forEach((cacheKey) => manager.evictDiffFromCache(cacheKey));
}

function freezeDiagnostics(
  diagnostics: PierreWorkerPoolDiagnostics,
): PierreWorkerPoolDiagnostics {
  return Object.freeze({
    ...diagnostics,
    workers: diagnostics.workers ? Object.freeze({ ...diagnostics.workers }) : null,
  });
}

export const pierreWorkerPoolLifecycle = new PierreWorkerPoolLifecycle();
