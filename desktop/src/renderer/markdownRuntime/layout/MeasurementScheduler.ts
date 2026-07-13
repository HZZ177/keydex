import type { MarkdownHeightUpdate } from "./HeightIndex";

export interface MarkdownMeasurementContext {
  readonly revision: string;
  readonly epoch: number;
}

export interface MarkdownMeasurementBatch extends MarkdownMeasurementContext {
  readonly updates: readonly MarkdownHeightUpdate[];
}

export interface MarkdownMeasurementSchedulerOptions {
  readonly revision: string;
  readonly epoch: number;
  readonly epsilon?: number;
  readonly onMeasurements: (batch: MarkdownMeasurementBatch) => void;
  readonly onError?: (error: unknown) => void;
  readonly observerFactory?: (callback: ResizeObserverCallback) => ResizeObserver;
  readonly scheduleFrame?: (callback: FrameRequestCallback) => number;
  readonly cancelFrame?: (handle: number) => void;
}

interface MeasurementRecord {
  readonly element: Element;
  readonly index: number;
  readonly blockId: string;
  readonly revision: string;
  readonly epoch: number;
  lastHeight: number;
}

interface PendingMeasurement {
  readonly element: Element;
  readonly height: number;
  readonly revision: string;
  readonly epoch: number;
}

export class MarkdownMeasurementScheduler {
  private readonly observer: ResizeObserver;
  private readonly epsilon: number;
  private readonly onMeasurements: (batch: MarkdownMeasurementBatch) => void;
  private readonly onError?: (error: unknown) => void;
  private readonly scheduleFrame: (callback: FrameRequestCallback) => number;
  private readonly cancelFrame: (handle: number) => void;
  private readonly records = new Map<Element, MeasurementRecord>();
  private readonly elementsByIndex = new Map<number, Element>();
  private readonly pending = new Map<Element, PendingMeasurement>();
  private revision: string;
  private epoch: number;
  private frame: number | null = null;
  private disposed = false;

  constructor(options: MarkdownMeasurementSchedulerOptions) {
    this.revision = requiredRevision(options.revision);
    this.epoch = nonNegativeInteger(options.epoch, "epoch");
    this.epsilon = finiteNonNegative(options.epsilon ?? 0.5, "epsilon");
    this.onMeasurements = options.onMeasurements;
    this.onError = options.onError;
    this.scheduleFrame = options.scheduleFrame ?? ((callback) => requestAnimationFrame(callback));
    this.cancelFrame = options.cancelFrame ?? ((handle) => cancelAnimationFrame(handle));
    const factory = options.observerFactory ?? ((callback) => new ResizeObserver(callback));
    this.observer = factory((entries) => this.onResize(entries));
  }

  setContext(context: MarkdownMeasurementContext): void {
    this.assertActive();
    this.revision = requiredRevision(context.revision);
    this.epoch = nonNegativeInteger(context.epoch, "epoch");
    this.cancelScheduledFrame();
    this.pending.clear();
    this.observer.disconnect();
    this.records.clear();
    this.elementsByIndex.clear();
  }

  observe(
    element: Element,
    input: { readonly index: number; readonly blockId: string; readonly initialHeight: number },
  ): void {
    this.assertActive();
    const index = nonNegativeInteger(input.index, "index");
    if (!input.blockId.trim()) throw new Error("blockId is required");
    const initialHeight = finiteNonNegative(input.initialHeight, "initialHeight");
    const previousElement = this.elementsByIndex.get(index);
    if (previousElement && previousElement !== element) this.unobserve(previousElement);
    if (this.records.has(element)) this.unobserve(element);
    const record: MeasurementRecord = {
      element,
      index,
      blockId: input.blockId,
      revision: this.revision,
      epoch: this.epoch,
      lastHeight: initialHeight,
    };
    this.records.set(element, record);
    this.elementsByIndex.set(index, element);
    try {
      this.observer.observe(element);
    } catch (error) {
      this.records.delete(element);
      this.elementsByIndex.delete(index);
      this.reportError(error);
    }
  }

  unobserve(element: Element): void {
    const record = this.records.get(element);
    if (!record) return;
    this.records.delete(element);
    if (this.elementsByIndex.get(record.index) === element) this.elementsByIndex.delete(record.index);
    this.pending.delete(element);
    try {
      this.observer.unobserve(element);
    } catch (error) {
      this.reportError(error);
    }
  }

  /**
   * Keeps an explicit live DOM measurement authoritative over a ResizeObserver
   * entry that may already be queued for the same element. Resource renderers
   * use an explicit measurement after replacing their temporary source
   * fallback, so an older observer entry must not restore the fallback height
   * on the next animation frame.
   */
  synchronize(element: Element, height: number): void {
    this.assertActive();
    const record = this.records.get(element);
    if (!record) return;
    record.lastHeight = finiteNonNegative(height, "height");
    this.pending.delete(element);
    if (!this.pending.size) this.cancelScheduledFrame();
  }

  flushNow(): void {
    this.assertActive();
    this.cancelScheduledFrame();
    this.flush();
  }

  diagnostics(): {
    readonly revision: string;
    readonly epoch: number;
    readonly observed: number;
    readonly pending: number;
    readonly frameScheduled: boolean;
  } {
    return Object.freeze({
      revision: this.revision,
      epoch: this.epoch,
      observed: this.records.size,
      pending: this.pending.size,
      frameScheduled: this.frame !== null,
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelScheduledFrame();
    this.pending.clear();
    this.records.clear();
    this.elementsByIndex.clear();
    this.observer.disconnect();
  }

  private onResize(entries: readonly ResizeObserverEntry[]): void {
    if (this.disposed) return;
    try {
      for (const entry of entries) {
        const record = this.records.get(entry.target);
        if (!record || record.revision !== this.revision || record.epoch !== this.epoch) continue;
        const height = resizeEntryHeight(entry);
        if (height === null) continue;
        this.pending.set(entry.target, {
          element: entry.target,
          height,
          revision: record.revision,
          epoch: record.epoch,
        });
      }
      if (this.pending.size && this.frame === null) {
        this.frame = this.scheduleFrame(() => {
          this.frame = null;
          this.flush();
        });
      }
    } catch (error) {
      this.reportError(error);
    }
  }

  private flush(): void {
    if (this.disposed || !this.pending.size) return;
    const updatesByIndex = new Map<number, MarkdownHeightUpdate>();
    for (const pending of this.pending.values()) {
      const record = this.records.get(pending.element);
      if (!record
        || record.revision !== this.revision
        || record.epoch !== this.epoch
        || pending.revision !== this.revision
        || pending.epoch !== this.epoch
        || !pending.element.isConnected) {
        continue;
      }
      if (Math.abs(pending.height - record.lastHeight) <= this.epsilon) continue;
      record.lastHeight = pending.height;
      updatesByIndex.set(record.index, {
        index: record.index,
        height: pending.height,
        kind: "measured",
      });
    }
    this.pending.clear();
    if (!updatesByIndex.size) return;
    const updates = Object.freeze([...updatesByIndex.values()].sort((left, right) => left.index - right.index));
    try {
      this.onMeasurements(Object.freeze({ revision: this.revision, epoch: this.epoch, updates }));
    } catch (error) {
      this.reportError(error);
    }
  }

  private cancelScheduledFrame(): void {
    if (this.frame === null) return;
    this.cancelFrame(this.frame);
    this.frame = null;
  }

  private reportError(error: unknown): void {
    try {
      this.onError?.(error);
    } catch {
      // Diagnostics must not enter the resize lifecycle.
    }
  }

  private assertActive(): void {
    if (this.disposed) throw new Error("Markdown Measurement Scheduler is disposed");
  }
}

function resizeEntryHeight(entry: ResizeObserverEntry): number | null {
  const borderSize = Array.isArray(entry.borderBoxSize)
    ? entry.borderBoxSize[0]
    : entry.borderBoxSize as unknown as ResizeObserverSize | undefined;
  const height = borderSize?.blockSize ?? entry.contentRect?.height;
  return typeof height === "number" && Number.isFinite(height) && height >= 0 ? height : null;
}

function requiredRevision(value: string): string {
  if (!value.trim()) throw new Error("measurement revision is required");
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function finiteNonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and non-negative`);
  return value;
}
