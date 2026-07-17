import pierreWorkerUrl from "@pierre/diffs/worker/worker-portable.js?worker&url";
import { resolvePierreWorkerEnvironment } from "./pierreWorkerEnvironment";

export interface PierreWorkerFactorySnapshot {
  readonly status: "idle" | "ready" | "error";
  readonly createdWorkers: number;
  readonly failedWorkers: number;
  readonly lastError: string | null;
}

export interface PierreWorkerFactoryOptions {
  readonly workerUrl?: string;
  readonly workerConstructor?: WorkerConstructor;
  readonly workerNamePrefix?: string;
  readonly pageUrl?: string;
  readonly tauriRuntime?: boolean;
}

export type WorkerConstructor = new (
  scriptURL: string | URL,
  options?: WorkerOptions,
) => Worker;

export const PIERRE_WORKER_CSP_REQUIREMENT = "worker-src 'self'; child-src 'self'";

export class PierreWorkerFactoryController {
  private readonly listeners = new Set<() => void>();
  private readonly workerUrl: string;
  private readonly workerConstructor: WorkerConstructor | undefined;
  private readonly workerNamePrefix: string;
  private readonly pageUrl: string | undefined;
  private readonly tauriRuntime: boolean | undefined;
  private state: PierreWorkerFactorySnapshot = Object.freeze({
    status: "idle",
    createdWorkers: 0,
    failedWorkers: 0,
    lastError: null,
  });

  constructor(options: PierreWorkerFactoryOptions = {}) {
    this.workerUrl = options.workerUrl ?? pierreWorkerUrl;
    this.workerConstructor = options.workerConstructor
      ?? (typeof Worker === "undefined" ? undefined : Worker);
    this.workerNamePrefix = options.workerNamePrefix ?? "keydex-pierre-diff";
    this.pageUrl = options.pageUrl;
    this.tauriRuntime = options.tauriRuntime;
  }

  readonly create = (): Worker => {
    try {
      const environment = resolvePierreWorkerEnvironment(this.workerUrl, {
        ...(this.pageUrl ? { pageUrl: this.pageUrl } : {}),
        ...(this.tauriRuntime === undefined ? {} : { tauriRuntime: this.tauriRuntime }),
      });
      if (!this.workerConstructor) throw new Error("当前环境不支持 Web Worker");
      const sequence = this.state.createdWorkers + this.state.failedWorkers + 1;
      const worker = new this.workerConstructor(environment.workerUrl, {
        type: "module",
        name: `${this.workerNamePrefix}-${sequence}`,
      });
      worker.addEventListener("error", this.handleRuntimeError);
      this.publish({
        status: "ready",
        createdWorkers: this.state.createdWorkers + 1,
        failedWorkers: this.state.failedWorkers,
        lastError: null,
      });
      return worker;
    } catch (reason: unknown) {
      const message = errorMessage(reason);
      this.publish({
        status: "error",
        createdWorkers: this.state.createdWorkers,
        failedWorkers: this.state.failedWorkers + 1,
        lastError: message,
      });
      throw new PierreWorkerFactoryError(message, { cause: reason });
    }
  };

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly snapshot = (): PierreWorkerFactorySnapshot => this.state;

  private readonly handleRuntimeError = (event: ErrorEvent) => {
    this.publish({
      status: "error",
      createdWorkers: this.state.createdWorkers,
      failedWorkers: this.state.failedWorkers + 1,
      lastError: event.message || "Pierre Diff Worker 运行失败",
    });
  };

  private publish(next: PierreWorkerFactorySnapshot) {
    this.state = Object.freeze(next);
    this.listeners.forEach((listener) => listener());
  }
}

export class PierreWorkerFactoryError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PierreWorkerFactoryError";
  }
}

export const pierreWorkerFactoryController = new PierreWorkerFactoryController();

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}
