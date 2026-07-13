import { describe, expect, it } from "vitest";

import { MarkdownHeightIndex } from "@/renderer/markdownRuntime/layout/HeightIndex";
import {
  MarkdownScrollAnchorController,
} from "@/renderer/markdownRuntime/view/ScrollAnchorController";
import { DocumentViewRuntime } from "@/renderer/markdownRuntime/view/DocumentViewRuntime";
import { FILE_MARKDOWN_RENDERER_PROFILE } from "@/renderer/markdownRuntime/renderers";
import { parseCanonicalMarkdownSnapshot } from "@/renderer/markdownRuntime/worker/parser";

function controller(
  heights = [100, 100, 100, 100, 100],
  options: ConstructorParameters<typeof MarkdownScrollAnchorController>[2] = {},
) {
  const index = new MarkdownHeightIndex("r1", heights);
  const ids = heights.map((_, position) => `block-${position}`);
  return { index, ids, controller: new MarkdownScrollAnchorController(index, ids, options) };
}

function capture(
  value: MarkdownScrollAnchorController,
  scrollTop = 250,
  viewportHeight = 100,
) {
  return value.capture({ scrollTop, viewportHeight })!;
}

describe("Markdown logical scroll anchor", () => {
  it("keeps the same block-local reading point stable when images and Mermaid above finish", () => {
    const run = controller();
    const firstAnchor = capture(run.controller);
    const image = run.controller.applyHeightUpdates(firstAnchor, [{ index: 0, height: 180 }], {
      revision: "r1",
      currentScrollTop: 250,
      viewportHeight: 100,
    });
    const secondAnchor = capture(run.controller, image.scrollTop);
    const mermaid = run.controller.applyHeightUpdates(secondAnchor, [{ index: 1, height: 140 }], {
      revision: "r1",
      currentScrollTop: image.scrollTop,
      viewportHeight: 100,
    });

    expect(firstAnchor).toMatchObject({ blockId: "block-2", blockLocalOffset: 50 });
    expect(image).toMatchObject({ status: "applied", scrollTop: 330, delta: 80, heightDelta: 80 });
    expect(mermaid).toMatchObject({ status: "applied", scrollTop: 370, delta: 40, heightDelta: 40 });
    expect(capture(run.controller, mermaid.scrollTop)).toMatchObject({
      blockId: "block-2",
      blockLocalOffset: 50,
    });
  });

  it("does not move for changes below the anchor and clamps a folded anchor-local offset", () => {
    const below = controller();
    const unchanged = below.controller.applyHeightUpdates(capture(below.controller), [{ index: 4, height: 240 }], {
      revision: "r1",
      currentScrollTop: 250,
      viewportHeight: 100,
    });
    expect(unchanged).toMatchObject({ status: "unchanged", scrollTop: 250, heightChanged: true });

    const folded = controller();
    const correction = folded.controller.applyHeightUpdates(capture(folded.controller), [{ index: 2, height: 30 }], {
      revision: "r1",
      currentScrollTop: 250,
      viewportHeight: 100,
    });
    expect(correction).toMatchObject({ status: "applied", scrollTop: 230, delta: -20 });
  });

  it("preserves the anchor for resize, theme, zoom, and font batches even when total delta cancels", () => {
    const run = controller();
    const resized = run.controller.applyHeightUpdates(capture(run.controller), [
      { index: 0, height: 120 },
      { index: 1, height: 120 },
      { index: 2, height: 120 },
      { index: 3, height: 120 },
      { index: 4, height: 120 },
    ], { revision: "r1", currentScrollTop: 250, viewportHeight: 100 });
    expect(resized).toMatchObject({ status: "applied", scrollTop: 290, delta: 40, heightDelta: 100 });

    const anchor = capture(run.controller, resized.scrollTop);
    const cancelling = run.controller.applyHeightUpdates(anchor, [
      { index: 0, height: 170 },
      { index: 4, height: 70 },
    ], { revision: "r1", currentScrollTop: resized.scrollTop, viewportHeight: 100 });
    expect(cancelling).toMatchObject({
      status: "applied",
      scrollTop: 340,
      delta: 50,
      heightDelta: 0,
      heightChanged: true,
    });
  });

  it("lets active user scrolling and newer jumps supersede automatic corrections", () => {
    let now = 0;
    const run = controller(undefined, { now: () => now, userScrollQuietMs: 120 });
    const staleInteraction = capture(run.controller);
    now = 10;
    run.controller.recordUserScroll(400);
    const superseded = run.controller.applyHeightUpdates(staleInteraction, [{ index: 0, height: 150 }], {
      revision: "r1",
      currentScrollTop: 400,
      viewportHeight: 100,
    });
    expect(superseded).toMatchObject({ status: "superseded-interaction", scrollTop: 400, shouldApply: false });

    const liveAnchor = capture(run.controller, 400);
    const active = run.controller.applyHeightUpdates(liveAnchor, [{ index: 1, height: 150 }], {
      revision: "r1",
      currentScrollTop: 400,
      viewportHeight: 100,
    });
    expect(active).toMatchObject({ status: "suppressed-user-scroll", scrollTop: 400, shouldApply: false });

    now = 200;
    const settledAnchor = capture(run.controller, 400);
    const settled = run.controller.applyHeightUpdates(settledAnchor, [{ index: 0, height: 200 }], {
      revision: "r1",
      currentScrollTop: 400,
      viewportHeight: 100,
    });
    expect(settled).toMatchObject({ status: "applied", scrollTop: 450, shouldApply: true });
  });

  it("ignores stale revision work without mutating heights", () => {
    const run = controller();
    const anchor = capture(run.controller);
    const stale = run.controller.applyHeightUpdates(anchor, [{ index: 0, height: 999 }], {
      revision: "r0",
      currentScrollTop: 250,
      viewportHeight: 100,
    });

    expect(stale).toMatchObject({ status: "stale-revision", shouldApply: false, heightChanged: false });
    expect(run.index.heightAt(0)).toBe(100);
  });

  it("reconciles an updated target block across revisions using stable ids or an explicit remap", () => {
    const run = controller([100, 100, 100, 100]);
    const anchor = capture(run.controller, 150, 100);
    const nextIndex = new MarkdownHeightIndex("r2", [50, 120, 100, 100, 100]);
    const remap = new Map([[anchor.blockId, "updated-block"]]);
    const replaced = run.controller.replaceIndex(
      nextIndex,
      ["inserted", "block-0", "updated-block", "block-2", "block-3"],
      anchor,
      { currentScrollTop: 150, viewportHeight: 100, blockIdRemap: remap },
    );

    expect(anchor).toMatchObject({ blockId: "block-1", blockLocalOffset: 50 });
    expect(replaced).toMatchObject({ revision: "r2", status: "applied", scrollTop: 220, delta: 70 });
    expect(run.controller.diagnostics()).toMatchObject({ captures: 1, applied: 1, missing: 0, stale: 0 });
  });

  it("returns a diagnosable missing-anchor result instead of jumping to an unrelated block", () => {
    const run = controller([100, 100]);
    const anchor = capture(run.controller, 50, 50);
    const result = run.controller.replaceIndex(
      new MarkdownHeightIndex("r2", [100]),
      ["different"],
      anchor,
      { currentScrollTop: 50, viewportHeight: 50 },
    );
    expect(result).toMatchObject({ status: "missing-anchor", scrollTop: 50, shouldApply: false });
  });

  it("validates block identities and dimensions", () => {
    const index = new MarkdownHeightIndex("r1", [10, 10]);
    expect(() => new MarkdownScrollAnchorController(index, ["only-one"])).toThrow(/count/u);
    expect(() => new MarkdownScrollAnchorController(index, ["same", "same"])).toThrow(/unique/u);
    const run = controller();
    expect(() => run.controller.capture({ scrollTop: 0, viewportHeight: -1 })).toThrow(/viewportHeight/u);
  });
});

describe("DocumentViewRuntime scroll anchoring integration", () => {
  it("keeps the visible block-local point stable and yields to active scrolling", () => {
    let now = 0;
    const snapshot = parseCanonicalMarkdownSnapshot({
      surface: "file",
      documentId: "file:anchor.md",
      revision: "r1",
      source: Array.from({ length: 6 }, (_, index) => `Paragraph ${index}`).join("\n\n"),
      rendererProfile: "file-preview",
    });
    const host = document.createElement("div");
    document.body.append(host);
    const runtime = new DocumentViewRuntime(host, {
      profile: FILE_MARKDOWN_RENDERER_PROFILE,
      viewport: { defaultOverscanPx: 0 },
      scrollAnchor: { userScrollQuietMs: 120 },
      now: () => now,
    });
    runtime.publish(snapshot, [100, 100, 100, 100, 100, 100], { scrollTop: 250, viewportHeight: 100 });
    const image = runtime.updateMeasuredHeights([{ index: 0, height: 180 }], "r1")!;
    expect(image.viewport.scrollTop).toBe(330);

    now = 10;
    runtime.updateViewport({ scrollTop: 350, viewportHeight: 100 });
    const duringScroll = runtime.updateMeasuredHeights([{ index: 0, height: 200 }], "r1")!;
    expect(duringScroll.viewport.scrollTop).toBe(350);

    now = 200;
    const settled = runtime.updateMeasuredHeights([{ index: 1, height: 150 }], "r1")!;
    expect(settled.viewport.scrollTop).toBe(400);
    expect(runtime.scrollAnchorDiagnostics()).toMatchObject({ applied: 2, suppressed: 1 });
    runtime.destroy();
    host.remove();
  });
});
