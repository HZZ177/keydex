import { describe, expect, it } from "vitest";

import { MarkdownMeasurementScheduler } from "@/renderer/markdownRuntime/layout/MeasurementScheduler";
import { FILE_MARKDOWN_RENDERER_PROFILE } from "@/renderer/markdownRuntime/renderers";
import { DocumentViewRuntime } from "@/renderer/markdownRuntime/view/DocumentViewRuntime";
import { parseCanonicalMarkdownSnapshot } from "@/renderer/markdownRuntime/worker/parser";

class TestResizeObserver implements ResizeObserver {
  readonly observed = new Set<Element>();

  constructor(private readonly callback: ResizeObserverCallback) {}

  observe(target: Element): void {
    this.observed.add(target);
  }

  unobserve(target: Element): void {
    this.observed.delete(target);
  }

  disconnect(): void {
    this.observed.clear();
  }

  emit(values: readonly { target: Element; height: number }[]): void {
    const entries = values.map(({ target, height }) => ({
      target,
      borderBoxSize: [{ blockSize: height, inlineSize: 100 }],
      contentBoxSize: [{ blockSize: height, inlineSize: 100 }],
      devicePixelContentBoxSize: [],
      contentRect: { height },
    })) as unknown as ResizeObserverEntry[];
    this.callback(entries, this);
  }
}

describe("HeightIndex, Viewport and Anchor cross-module gate", () => {
  it("coalesces resource and resize measurements into one anchored viewport patch", () => {
    let now = 0;
    const snapshot = parse(200, "r1");
    const host = document.createElement("div");
    const imageProbe = document.createElement("div");
    const mermaidProbe = document.createElement("div");
    document.body.append(host, imageProbe, mermaidProbe);
    const runtime = new DocumentViewRuntime(host, {
      profile: FILE_MARKDOWN_RENDERER_PROFILE,
      viewport: { defaultOverscanPx: 80 },
      scrollAnchor: { userScrollQuietMs: 120 },
      now: () => now,
    });
    runtime.publish(snapshot, new Array(snapshot.blocks.length).fill(40), {
      scrollTop: 4000,
      viewportHeight: 400,
    });

    let observer!: TestResizeObserver;
    const frames: FrameRequestCallback[] = [];
    const patches: Array<ReturnType<DocumentViewRuntime["updateMeasuredHeights"]>> = [];
    let batches = 0;
    const scheduler = new MarkdownMeasurementScheduler({
      revision: "r1",
      epoch: 1,
      observerFactory: (callback) => (observer = new TestResizeObserver(callback)),
      scheduleFrame: (callback) => {
        frames.push(callback);
        return frames.length;
      },
      cancelFrame: () => undefined,
      onMeasurements: (batch) => {
        batches += 1;
        patches.push(runtime.updateMeasuredHeights(batch.updates, batch.revision));
      },
    });
    scheduler.observe(imageProbe, { index: 0, blockId: snapshot.blocks[0].id, initialHeight: 40 });
    scheduler.observe(mermaidProbe, { index: 1, blockId: snapshot.blocks[1].id, initialHeight: 40 });

    for (let index = 0; index < 50; index += 1) {
      observer.emit([
        { target: imageProbe, height: 91 + index },
        { target: mermaidProbe, height: 41 + index },
      ]);
    }
    expect(frames).toHaveLength(1);
    frames.shift()!(0);
    expect(batches).toBe(1);
    expect(patches[0]?.viewport.scrollTop).toBe(4150);
    expect(runtime.getHeightIndex()?.heightAt(0)).toBe(140);
    expect(runtime.getHeightIndex()?.heightAt(1)).toBe(90);

    now = 10;
    runtime.updateViewport({ scrollTop: 4200, viewportHeight: 400 }, { origin: "user" });
    observer.emit([{ target: imageProbe, height: 160 }]);
    expect(frames).toHaveLength(1);
    frames.shift()!(16);
    expect(batches).toBe(2);
    expect(patches[1]?.viewport.scrollTop).toBe(4200);
    expect(runtime.scrollAnchorDiagnostics()).toMatchObject({ applied: 1, suppressed: 1 });

    scheduler.setContext({ revision: "r2", epoch: 2 });
    observer.emit([{ target: imageProbe, height: 300 }]);
    expect(frames).toHaveLength(0);
    expect(batches).toBe(2);
    expect(() => runtime.updateMeasuredHeights([{ index: 0, height: 300 }], "stale"))
      .toThrow(/Stale height revision/u);

    scheduler.dispose();
    runtime.destroy();
    host.remove();
    imageProbe.remove();
    mermaidProbe.remove();
  });

  it("keeps the retained DOM bounded across middle, tail, selection pinning, and a giant block", () => {
    const snapshot = parse(20_000, "large-r1");
    const host = document.createElement("div");
    document.body.append(host);
    const runtime = new DocumentViewRuntime(host, {
      profile: FILE_MARKDOWN_RENDERER_PROFILE,
      viewport: { defaultOverscanPx: 200 },
    });
    const heights = new Array(snapshot.blocks.length).fill(20);
    const middle = runtime.publish(snapshot, heights, { scrollTop: 200_000, viewportHeight: 400 });
    const pinnedIndex = middle.viewport.visibleRange.start;
    const pinnedBlock = snapshot.blocks[pinnedIndex];
    const pinnedElement = runtime.getBlockElement(pinnedBlock.id)!;
    const text = firstTextNode(pinnedElement);
    const range = document.createRange();
    range.selectNodeContents(text);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    const tail = runtime.updateViewport({ scrollTop: Number.MAX_SAFE_INTEGER, viewportHeight: 400 });
    expect(tail.viewport.visibleRange.end).toBe(snapshot.blocks.length);
    expect(tail.protectedIndices).toContain(pinnedIndex);
    expect(tail.mountedBlockRoots).toBeLessThanOrEqual(43);
    expect(runtime.getBlockElement(pinnedBlock.id)).toBe(pinnedElement);
    selection.removeAllRanges();
    runtime.updateViewport({ scrollTop: Number.MAX_SAFE_INTEGER, viewportHeight: 400 });
    expect(runtime.getBlockElement(pinnedBlock.id)).toBeNull();

    const giant = parse(3, "giant-r1");
    const giantPatch = runtime.publish(giant, [1_000_000, 20, 20], {
      scrollTop: 500_000,
      viewportHeight: 10_000,
    });
    expect(giantPatch.viewport.visibleRange).toEqual({ start: 0, end: 1 });
    expect(giantPatch.mountedBlockRoots).toBe(1);
    expect(host.querySelectorAll("[data-markdown-block-id]")).toHaveLength(1);

    runtime.destroy();
    host.remove();
  }, 30_000);
});

function parse(blocks: number, revision: string) {
  return parseCanonicalMarkdownSnapshot({
    surface: "file",
    documentId: "file:viewport-gate.md",
    revision,
    source: Array.from({ length: blocks }, (_, index) => `Paragraph ${index}`).join("\n\n"),
    rendererProfile: "file-preview",
  });
}

function firstTextNode(root: Node): Text {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const value = walker.nextNode();
  if (!(value instanceof Text)) throw new Error("Expected a text node");
  return value;
}
