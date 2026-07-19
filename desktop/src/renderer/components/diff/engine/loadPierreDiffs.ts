import {
  KEYDEX_DIFF_CSS_VARIABLE_DEFAULTS,
  KEYDEX_DIFF_THEME_NAMES,
} from "./pierreThemes";

type PierreDiffsCoreModule = Pick<
  typeof import("@pierre/diffs"),
  | "parsePatchFiles"
  | "parseDiffFromFile"
  | "registerCustomCSSVariableTheme"
  | "renderDiffWithHighlighter"
  | "getSharedHighlighter"
  | "getFiletypeFromFileName"
>;

export type PierreDiffsReactModule = typeof import("@pierre/diffs/react") &
  PierreDiffsCoreModule & {
    readonly pierreWorkerFactory: () => Worker;
    readonly getOrCreateWorkerPoolSingleton: typeof import("@pierre/diffs/worker")["getOrCreateWorkerPoolSingleton"];
    readonly terminateWorkerPoolSingleton: typeof import("@pierre/diffs/worker")["terminateWorkerPoolSingleton"];
  };

export type PierreEngineLoadStatus = "idle" | "loading" | "ready" | "error";

export interface PierreEngineLoadSnapshot {
  readonly status: PierreEngineLoadStatus;
  readonly module: PierreDiffsReactModule | null;
  readonly error: Error | null;
  readonly attempt: number;
}

type PierreImporter = () => Promise<PierreDiffsReactModule>;
type PierreLoadListener = (snapshot: PierreEngineLoadSnapshot) => void;

const productionImporter: PierreImporter = async () => {
  const [react, core, worker, workerFactory] = await Promise.all([
    import("@pierre/diffs/react"),
    import("@pierre/diffs"),
    import("@pierre/diffs/worker"),
    import("./pierreWorkerFactory"),
  ]);
  Object.values(KEYDEX_DIFF_THEME_NAMES).forEach((name) => {
    core.registerCustomCSSVariableTheme(name, KEYDEX_DIFF_CSS_VARIABLE_DEFAULTS, true);
  });
  return Object.freeze({
    ...react,
    parsePatchFiles: core.parsePatchFiles,
    parseDiffFromFile: core.parseDiffFromFile,
    registerCustomCSSVariableTheme: core.registerCustomCSSVariableTheme,
    renderDiffWithHighlighter: core.renderDiffWithHighlighter,
    getSharedHighlighter: core.getSharedHighlighter,
    getFiletypeFromFileName: core.getFiletypeFromFileName,
    pierreWorkerFactory: workerFactory.pierreWorkerFactoryController.create,
    getOrCreateWorkerPoolSingleton: worker.getOrCreateWorkerPoolSingleton,
    terminateWorkerPoolSingleton: worker.terminateWorkerPoolSingleton,
  });
};

export class PierreEngineLoader {
  private current: PierreEngineLoadSnapshot = Object.freeze({
    status: "idle",
    module: null,
    error: null,
    attempt: 0,
  });
  private pending: Promise<PierreDiffsReactModule> | null = null;
  private readonly listeners = new Set<PierreLoadListener>();

  constructor(private readonly importer: PierreImporter) {}

  snapshot(): PierreEngineLoadSnapshot {
    return this.current;
  }

  subscribe(listener: PierreLoadListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  load(): Promise<PierreDiffsReactModule> {
    if (this.current.module) return Promise.resolve(this.current.module);
    if (this.pending) return this.pending;
    const attempt = this.current.attempt + 1;
    this.publish({ status: "loading", module: null, error: null, attempt });
    const pending = this.importer()
      .then((module) => {
        if (this.pending === pending) {
          this.pending = null;
          this.publish({ status: "ready", module, error: null, attempt });
        }
        return module;
      })
      .catch((reason: unknown) => {
        const error = reason instanceof Error ? reason : new Error(String(reason));
        if (this.pending === pending) {
          this.pending = null;
          this.publish({ status: "error", module: null, error, attempt });
        }
        throw error;
      });
    this.pending = pending;
    return pending;
  }

  preload(): void {
    void this.load().catch(() => undefined);
  }

  retry(): Promise<PierreDiffsReactModule> {
    if (this.current.status === "ready") return Promise.resolve(this.current.module!);
    return this.load();
  }

  private publish(next: PierreEngineLoadSnapshot) {
    this.current = Object.freeze(next);
    this.listeners.forEach((listener) => listener(this.current));
  }
}

const loader = new PierreEngineLoader(productionImporter);

export const loadPierreDiffs = () => loader.load();
export const preloadPierreDiffs = () => loader.preload();
export const retryPierreDiffs = () => loader.retry();
export const pierreEngineLoadSnapshot = () => loader.snapshot();
export const subscribePierreEngineLoad = (listener: PierreLoadListener) => loader.subscribe(listener);
