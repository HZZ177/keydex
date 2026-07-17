import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  PIERRE_WORKER_CSP_REQUIREMENT,
  PierreWorkerFactoryController,
  PierreWorkerFactoryError,
} from "@/renderer/components/diff/engine/pierreWorkerFactory";

describe("Pierre Vite module Worker factory", () => {
  it("creates distinct module workers with stable Keydex names", () => {
    const workers: FakeWorker[] = [];
    const WorkerConstructor = class extends FakeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        workers.push(this);
      }
    };
    const controller = new PierreWorkerFactoryController({
      workerUrl: "/assets/pierre-worker.js",
      workerConstructor: WorkerConstructor as never,
    });
    expect(controller.create()).not.toBe(controller.create());
    expect(workers.map((worker) => worker.options)).toEqual([
      { type: "module", name: "keydex-pierre-diff-1" },
      { type: "module", name: "keydex-pierre-diff-2" },
    ]);
    expect(controller.snapshot()).toMatchObject({ status: "ready", createdWorkers: 2 });
  });

  it("publishes constructor failures and throws an observable typed error", () => {
    const listener = vi.fn();
    const controller = new PierreWorkerFactoryController({
      workerUrl: "/assets/pierre-worker.js",
      workerConstructor: class {
        constructor() { throw new Error("worker construction failed"); }
      } as never,
    });
    controller.subscribe(listener);
    expect(() => controller.create()).toThrow(PierreWorkerFactoryError);
    expect(controller.snapshot()).toMatchObject({
      status: "error",
      failedWorkers: 1,
      lastError: "worker construction failed",
    });
    expect(listener).toHaveBeenCalledOnce();
  });

  it("observes worker runtime errors after construction", () => {
    const workers: FakeWorker[] = [];
    const WorkerConstructor = class extends FakeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        workers.push(this);
      }
    };
    const controller = new PierreWorkerFactoryController({
      workerUrl: "/assets/pierre-worker.js",
      workerConstructor: WorkerConstructor as never,
    });
    controller.create();
    workers[0]?.emitError("worker runtime failed");
    expect(controller.snapshot()).toMatchObject({
      status: "error",
      createdWorkers: 1,
      failedWorkers: 1,
      lastError: "worker runtime failed",
    });
  });

  it.each([
    "blob:http://localhost/worker",
    "data:text/javascript,postMessage(1)",
    "https://cdn.example.com/pierre-worker.js",
  ])("rejects non-local worker source %s", (workerUrl) => {
    const constructor = vi.fn();
    const controller = new PierreWorkerFactoryController({
      workerUrl,
      workerConstructor: constructor as never,
    });
    expect(() => controller.create()).toThrow(PierreWorkerFactoryError);
    expect(constructor).not.toHaveBeenCalled();
  });

  it("uses the official Vite worker URL import and documents future CSP", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/renderer/components/diff/engine/pierreWorkerFactory.ts"),
      "utf8",
    );
    expect(source).toContain('@pierre/diffs/worker/worker-portable.js?worker&url');
    expect(source).toContain('type: "module"');
    expect(source).not.toMatch(/https:\/\/(?!keydex\.local)/u);
    expect(PIERRE_WORKER_CSP_REQUIREMENT).toBe("worker-src 'self'; child-src 'self'");
  });
});

class FakeWorker {
  readonly url: string;
  readonly options?: WorkerOptions;
  private errorListener?: (event: ErrorEvent) => void;

  constructor(url: string | URL, options?: WorkerOptions) {
    this.url = String(url);
    this.options = options;
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    if (type === "error") this.errorListener = listener as (event: ErrorEvent) => void;
  }

  emitError(message: string) {
    this.errorListener?.({ message } as ErrorEvent);
  }
}
