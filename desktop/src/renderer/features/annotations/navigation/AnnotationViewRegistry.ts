import type { AnnotationViewAdapter, AnnotationViewId } from "./types";

interface MountWaiter {
  reject: (reason: unknown) => void;
  resolve: (adapter: AnnotationViewAdapter) => void;
}

export class AnnotationViewRegistry {
  private readonly adapters = new Map<AnnotationViewId, AnnotationViewAdapter>();
  private readonly waiters = new Map<AnnotationViewId, Set<MountWaiter>>();
  private disposed = false;

  register(adapter: AnnotationViewAdapter): () => void {
    this.assertOpen();
    this.adapters.set(adapter.id, adapter);
    const waiters = this.waiters.get(adapter.id);
    if (waiters) {
      this.waiters.delete(adapter.id);
      for (const waiter of waiters) {
        waiter.resolve(adapter);
      }
    }
    return () => {
      if (this.adapters.get(adapter.id) === adapter) {
        this.adapters.delete(adapter.id);
      }
    };
  }

  get(viewId: AnnotationViewId): AnnotationViewAdapter | null {
    return this.adapters.get(viewId) ?? null;
  }

  mountedViewIds(): readonly AnnotationViewId[] {
    return Object.freeze([...this.adapters.keys()]);
  }

  async waitUntilReady(
    viewId: AnnotationViewId,
    signal: AbortSignal,
  ): Promise<AnnotationViewAdapter> {
    this.assertOpen();
    const adapter = this.adapters.get(viewId) ?? await this.waitForMount(viewId, signal);
    await adapter.whenReady(signal);
    if (signal.aborted) {
      throw abortError(`Annotation view ${viewId} readiness aborted`);
    }
    if (this.adapters.get(viewId) !== adapter) {
      throw new Error(`Annotation view ${viewId} was replaced before it became ready`);
    }
    return adapter;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.adapters.clear();
    for (const waiters of this.waiters.values()) {
      for (const waiter of waiters) {
        waiter.reject(abortError("Annotation view registry disposed"));
      }
    }
    this.waiters.clear();
  }

  private waitForMount(
    viewId: AnnotationViewId,
    signal: AbortSignal,
  ): Promise<AnnotationViewAdapter> {
    if (signal.aborted) {
      return Promise.reject(abortError(`Annotation view ${viewId} mount aborted`));
    }
    return new Promise((resolve, reject) => {
      const waiters = this.waiters.get(viewId) ?? new Set<MountWaiter>();
      const waiter: MountWaiter = {
        resolve: (adapter) => {
          signal.removeEventListener("abort", onAbort);
          resolve(adapter);
        },
        reject: (reason) => {
          signal.removeEventListener("abort", onAbort);
          reject(reason);
        },
      };
      const onAbort = () => {
        waiters.delete(waiter);
        if (waiters.size === 0) {
          this.waiters.delete(viewId);
        }
        reject(abortError(`Annotation view ${viewId} mount aborted`));
      };
      waiters.add(waiter);
      this.waiters.set(viewId, waiters);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private assertOpen(): void {
    if (this.disposed) {
      throw new Error("Annotation view registry is disposed");
    }
  }
}

function abortError(message: string): DOMException {
  return new DOMException(message, "AbortError");
}
