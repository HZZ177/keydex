import { describe, expect, it, vi } from "vitest";

import {
  MarkdownMeasurementScheduler,
  type MarkdownMeasurementBatch,
} from "@/renderer/markdownRuntime/layout/MeasurementScheduler";
import { MarkdownHeightIndex } from "@/renderer/markdownRuntime/layout/HeightIndex";

class FakeResizeObserver implements ResizeObserver {
  readonly observed = new Set<Element>();
  disconnected = false;
  throwOnObserve = false;

  constructor(private readonly callback: ResizeObserverCallback) {}

  observe(target: Element): void {
    if (this.throwOnObserve) throw new Error("observe failed");
    this.observed.add(target);
  }

  unobserve(target: Element): void {
    this.observed.delete(target);
  }

  disconnect(): void {
    this.disconnected = true;
    this.observed.clear();
  }

  emit(...entries: ResizeObserverEntry[]): void {
    this.callback(entries, this);
  }
}

function harness(options: Partial<ConstructorParameters<typeof MarkdownMeasurementScheduler>[0]> = {}) {
  let observer!: FakeResizeObserver;
  let nextFrame = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const batches: MarkdownMeasurementBatch[] = [];
  const errors: unknown[] = [];
  const scheduler = new MarkdownMeasurementScheduler({
    revision: "r1",
    epoch: 1,
    onMeasurements: (batch) => batches.push(batch),
    onError: (error) => errors.push(error),
    observerFactory: (callback) => (observer = new FakeResizeObserver(callback)),
    scheduleFrame: (callback) => {
      const id = ++nextFrame;
      frames.set(id, callback);
      return id;
    },
    cancelFrame: (id) => { frames.delete(id); },
    ...options,
  });
  return {
    scheduler,
    observer,
    batches,
    errors,
    flushFrame() {
      const pending = [...frames.entries()];
      frames.clear();
      pending.forEach(([, callback]) => callback(performance.now()));
    },
    get frameCount() { return frames.size; },
  };
}

function element(): HTMLDivElement {
  const value = document.createElement("div");
  document.body.append(value);
  return value;
}

function entry(target: Element, height: number, borderBox = false): ResizeObserverEntry {
  return {
    target,
    contentRect: { height } as DOMRectReadOnly,
    borderBoxSize: borderBox ? [{ blockSize: height, inlineSize: 100 }] : [],
    contentBoxSize: [],
    devicePixelContentBoxSize: [],
  };
}

describe("Markdown ResizeObserver MeasurementScheduler", () => {
  it("batches multiple visible block measurements into one sorted frame commit", () => {
    const run = harness();
    const first = element();
    const second = element();
    run.scheduler.observe(first, { index: 3, blockId: "b3", initialHeight: 20 });
    run.scheduler.observe(second, { index: 1, blockId: "b1", initialHeight: 30 });
    run.observer.emit(entry(first, 25), entry(second, 40, true));

    expect(run.batches).toEqual([]);
    expect(run.frameCount).toBe(1);
    run.flushFrame();
    expect(run.batches).toEqual([{
      revision: "r1",
      epoch: 1,
      updates: [
        { index: 1, height: 40, kind: "measured" },
        { index: 3, height: 25, kind: "measured" },
      ],
    }]);
    first.remove();
    second.remove();
    run.scheduler.dispose();
  });

  it("coalesces repeated entries and ignores unchanged heights within epsilon", () => {
    const run = harness({ epsilon: 0.5 });
    const block = element();
    run.scheduler.observe(block, { index: 0, blockId: "b0", initialHeight: 20 });
    run.observer.emit(entry(block, 20.2), entry(block, 25), entry(block, 26));
    run.flushFrame();
    expect(run.batches[0].updates).toEqual([{ index: 0, height: 26, kind: "measured" }]);

    run.observer.emit(entry(block, 26.4));
    run.flushFrame();
    expect(run.batches).toHaveLength(1);
    run.observer.emit(entry(block, 26.6));
    run.flushFrame();
    expect(run.batches[1].updates).toEqual([{ index: 0, height: 26.6, kind: "measured" }]);
    block.remove();
    run.scheduler.dispose();
  });

  it("drops unmounted and disconnected late measurements", () => {
    const run = harness();
    const block = element();
    run.scheduler.observe(block, { index: 0, blockId: "b0", initialHeight: 20 });
    run.observer.emit(entry(block, 50));
    run.scheduler.unobserve(block);
    run.flushFrame();
    expect(run.batches).toEqual([]);

    run.scheduler.observe(block, { index: 0, blockId: "b0", initialHeight: 20 });
    run.observer.emit(entry(block, 60));
    block.remove();
    run.flushFrame();
    expect(run.batches).toEqual([]);
    run.scheduler.dispose();
  });

  it("lets an explicit live measurement supersede a queued resource fallback height", () => {
    const run = harness();
    const block = element();
    run.scheduler.observe(block, { index: 0, blockId: "mermaid", initialHeight: 560 });
    run.observer.emit(entry(block, 1_640));
    expect(run.frameCount).toBe(1);

    run.scheduler.synchronize(block, 432);
    run.flushFrame();

    expect(run.batches).toEqual([]);
    expect(run.scheduler.diagnostics()).toMatchObject({ pending: 0, frameScheduled: false });
    run.observer.emit(entry(block, 440));
    run.flushFrame();
    expect(run.batches[0].updates).toEqual([{ index: 0, height: 440, kind: "measured" }]);
    block.remove();
    run.scheduler.dispose();
  });

  it("invalidates queued results across revision and view epoch changes", () => {
    const run = harness();
    const block = element();
    run.scheduler.observe(block, { index: 0, blockId: "old", initialHeight: 20 });
    run.observer.emit(entry(block, 40));
    run.scheduler.setContext({ revision: "r2", epoch: 2 });
    run.flushFrame();
    expect(run.batches).toEqual([]);
    expect(run.scheduler.diagnostics()).toEqual({
      revision: "r2",
      epoch: 2,
      observed: 0,
      pending: 0,
      frameScheduled: false,
    });

    run.scheduler.observe(block, { index: 0, blockId: "new", initialHeight: 20 });
    run.observer.emit(entry(block, 45));
    run.flushFrame();
    expect(run.batches[0]).toMatchObject({ revision: "r2", epoch: 2 });
    block.remove();
    run.scheduler.dispose();
  });

  it("handles image, Mermaid, font, and window resize waves without a synchronous loop", () => {
    const run = harness();
    const image = element();
    const mermaid = element();
    run.scheduler.observe(image, { index: 1, blockId: "image", initialHeight: 100 });
    run.scheduler.observe(mermaid, { index: 2, blockId: "mermaid", initialHeight: 200 });

    run.observer.emit(entry(image, 150));
    run.observer.emit(entry(mermaid, 260));
    run.observer.emit(entry(image, 175));
    expect(run.frameCount).toBe(1);
    run.flushFrame();
    expect(run.batches[0].updates).toEqual([
      { index: 1, height: 175, kind: "measured" },
      { index: 2, height: 260, kind: "measured" },
    ]);

    run.observer.emit(entry(image, 180), entry(mermaid, 270));
    expect(run.frameCount).toBe(1);
    run.flushFrame();
    expect(run.batches).toHaveLength(2);
    image.remove();
    mermaid.remove();
    run.scheduler.dispose();
  });

  it("feeds one batch into HeightIndex with the signed revision", () => {
    const index = new MarkdownHeightIndex("r1", [20, 30]);
    const block = element();
    const run = harness({
      onMeasurements: (batch) => index.updateBatch(batch.updates, { revision: batch.revision }),
    });
    run.scheduler.observe(block, { index: 1, blockId: "b1", initialHeight: 30 });
    run.observer.emit(entry(block, 55));
    run.flushFrame();

    expect(index.cloneHeights()).toEqual(new Float64Array([20, 55]));
    expect(index.kindAt(1)).toBe("measured");
    block.remove();
    run.scheduler.dispose();
  });

  it("never calls getBoundingClientRect during observe or flush", () => {
    const run = harness();
    const block = element();
    const getBoundingClientRect = vi.spyOn(block, "getBoundingClientRect");
    run.scheduler.observe(block, { index: 0, blockId: "b0", initialHeight: 20 });
    run.observer.emit(entry(block, 40));
    run.flushFrame();
    expect(getBoundingClientRect).not.toHaveBeenCalled();
    block.remove();
    run.scheduler.dispose();
  });

  it("isolates observer and consumer errors and disposes pending work", () => {
    const onError = vi.fn();
    const run = harness({
      onMeasurements: () => { throw new Error("consumer failed"); },
      onError,
    });
    const block = element();
    run.observer.throwOnObserve = true;
    expect(() => run.scheduler.observe(block, { index: 0, blockId: "b0", initialHeight: 20 })).not.toThrow();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "observe failed" }));

    run.observer.throwOnObserve = false;
    run.scheduler.observe(block, { index: 0, blockId: "b0", initialHeight: 20 });
    run.observer.emit(entry(block, 50));
    run.flushFrame();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "consumer failed" }));
    run.scheduler.dispose();
    expect(run.observer.disconnected).toBe(true);
    expect(() => run.scheduler.flushNow()).toThrow(/disposed/u);
    block.remove();
  });
});
