import { describe, expect, it, vi } from "vitest";

import { createMarkdownTextModel } from "./fixtures/annotationMarkdown";
import { MarkdownSelectionController } from "@/renderer/markdownRuntime/interaction";
import { MarkdownPositionMapper } from "@/renderer/markdownRuntime/mapping";
import { FILE_MARKDOWN_RENDERER_PROFILE } from "@/renderer/markdownRuntime/renderers";
import { DocumentViewRuntime } from "@/renderer/markdownRuntime/view/DocumentViewRuntime";
import { parseCanonicalMarkdownSnapshot } from "@/renderer/markdownRuntime/worker/parser";
import type { MarkdownSnapshot } from "@/renderer/markdownRuntime/document/MarkdownSnapshot";

const SOURCE = "Alpha 😀 e\u0301\n\nمرحبا بالعالم\n\n中文 ending";

function parse(source = SOURCE, revision = "r1", previousSnapshot?: MarkdownSnapshot) {
  return parseCanonicalMarkdownSnapshot({
    surface: "file",
    documentId: "file:selection.md",
    revision,
    source,
    rendererProfile: "file-preview",
  }, { previousSnapshot });
}

function harness(source = SOURCE, blockHeight = 100) {
  const snapshot = parse(source);
  const host = document.createElement("div");
  document.body.append(host);
  const runtime = new DocumentViewRuntime(host, {
    profile: FILE_MARKDOWN_RENDERER_PROFILE,
    viewport: { defaultOverscanPx: 0, maxPinnedBlocks: 256 },
  });
  runtime.publish(snapshot, snapshot.blocks.map(() => blockHeight), {
    scrollTop: 0,
    viewportHeight: Math.max(500, snapshot.blocks.length * blockHeight),
  });
  const mapper = new MarkdownPositionMapper(source, snapshot, {
    heightIndex: runtime.getHeightIndex(),
    mounted: runtime,
  });
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  return {
    source,
    snapshot,
    host,
    runtime,
    mapper,
    selection,
    text(blockIndex: number) {
      const root = runtime.getBlockElement(snapshot.blocks[blockIndex].id)!;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      return walker.nextNode() as Text;
    },
    destroy() {
      selection.removeAllRanges();
      runtime.destroy();
      host.remove();
    },
  };
}

function select(
  selection: Selection,
  startNode: Node,
  startOffset: number,
  endNode: Node,
  endOffset: number,
  backward = false,
) {
  selection.removeAllRanges();
  if (backward && typeof selection.setBaseAndExtent === "function") {
    selection.setBaseAndExtent(endNode, endOffset, startNode, startOffset);
    return;
  }
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  selection.addRange(range);
}

describe("native Markdown Selection pinning and projection", () => {
  it("projects a forward cross-block native Range into logical/source/block coordinates", () => {
    const run = harness();
    select(run.selection, run.text(0), 6, run.text(2), 2);
    const pinned = vi.fn();
    const controller = new MarkdownSelectionController({
      mapper: run.mapper,
      boundary: run.host,
      onPinnedIndicesChanged: pinned,
    });
    const result = controller.update();

    expect(result.reason).toBeNull();
    expect(result.selection).toMatchObject({
      revision: "r1",
      direction: "forward",
      blockRanges: [{ blockIndex: 0 }, { blockIndex: 1 }, { blockIndex: 2 }],
      pinnedBlockIds: run.snapshot.blocks.map((block) => block.id),
      annotationSelection: { coordinateSpace: "logical" },
    });
    expect([...result.selection!.pinnedIndices]).toEqual([0, 1, 2]);
    expect(result.selection!.logicalText).toContain("مرحبا بالعالم");
    expect(pinned).toHaveBeenLastCalledWith(new Set([0, 1, 2]));
    run.destroy();
  });

  it("preserves backward direction for RTL text", () => {
    const run = harness();
    const rtl = run.text(1);
    select(run.selection, rtl, 1, rtl, rtl.data.length - 1, true);
    const controller = new MarkdownSelectionController({ mapper: run.mapper, boundary: run.host });
    const result = controller.update();

    expect(result.selection).toMatchObject({ direction: "backward", pinnedBlockIds: [run.snapshot.blocks[1].id] });
    expect(result.selection!.logicalText).toBe(rtl.data.slice(1, -1));
    run.destroy();
  });

  it("pins selected blocks while scrolling and releases them after native selection clears", () => {
    const source = Array.from({ length: 100 }, (_, index) => `Paragraph ${index}`).join("\n\n");
    const run = harness(source, 30);
    select(run.selection, run.text(0), 0, run.text(2), 5);
    const controller = new MarkdownSelectionController({ mapper: run.mapper, boundary: run.host });
    controller.update();
    const scrolled = run.runtime.updateViewport({
      scrollTop: 2_000,
      viewportHeight: 120,
      pinnedIndices: controller.pinnedIndices(),
    });
    expect(scrolled.viewport.items.filter((item) => item.pinned).map((item) => item.index)).toEqual([0, 1, 2]);

    run.selection.removeAllRanges();
    expect(controller.update()).toMatchObject({ selection: null, reason: "no-selection" });
    run.runtime.updateViewport({ scrollTop: 2_000, viewportHeight: 120, pinnedIndices: controller.pinnedIndices() });
    expect(run.runtime.getBlockElement(run.snapshot.blocks[0].id)).toBeNull();
    run.destroy();
  });

  it("handles emoji and combining characters while rejecting split-surrogate boundaries", () => {
    const run = harness();
    const text = run.text(0);
    const emoji = text.data.indexOf("😀");
    const combining = text.data.indexOf("e\u0301");
    const controller = new MarkdownSelectionController({ mapper: run.mapper, boundary: run.host });

    select(run.selection, text, emoji, text, emoji + "😀".length);
    expect(controller.update().selection?.logicalText).toBe("😀");
    select(run.selection, text, combining, text, combining + "e\u0301".length);
    expect(controller.update().selection?.logicalText).toBe("e\u0301");
    select(run.selection, text, emoji + 1, text, emoji + 2);
    expect(controller.update()).toMatchObject({ selection: null, reason: "split-surrogate" });
    run.destroy();
  });

  it("produces a logical annotation selection accepted by the current MarkdownTextModel", () => {
    const run = harness();
    const first = run.text(0);
    select(run.selection, first, 0, first, 5);
    const controller = new MarkdownSelectionController({ mapper: run.mapper, boundary: run.host });
    const projected = controller.update().selection!;
    const model = createMarkdownTextModel(run.source, "r1");

    expect(model.projectSelection(projected.annotationSelection)).toMatchObject({
      logicalRange: { start: projected.logicalStart, end: projected.logicalEnd },
      blockRanges: [{ blockKey: expect.any(String), range: { start: 0, end: 5 } }],
    });
    run.destroy();
  });

  it("projects a selection that starts on a rendered list marker onto the item text", () => {
    const source = "- Workbench mode\n- workspace resources\n- Agent mode";
    const run = harness(source);
    const listBlock = run.snapshot.blocks.find((block) => block.kind === "list")!;
    const root = run.runtime.getBlockElement(listBlock.id)!;
    const secondItem = root.querySelectorAll("li")[1]!;
    const markerText = secondItem.querySelector<HTMLElement>("[data-markdown-list-marker]")!.firstChild as Text;
    const contentRoot = secondItem.querySelector<HTMLElement>("[data-markdown-list-content]")!;
    const contentWalker = document.createTreeWalker(contentRoot, NodeFilter.SHOW_TEXT);
    let contentText = contentWalker.nextNode() as Text;
    for (let next = contentWalker.nextNode() as Text | null; next; next = contentWalker.nextNode() as Text | null) {
      contentText = next;
    }
    select(run.selection, markerText, 0, contentText, contentText.data.length);
    const controller = new MarkdownSelectionController({ mapper: run.mapper, boundary: run.host });

    const result = controller.update();

    expect(result.reason).toBeNull();
    expect(result.selection?.logicalText).toBe("workspace resources");
    expect(result.selection?.annotationSelection).toEqual({
      coordinateSpace: "logical",
      range: {
        start: listBlock.logical_start + listBlock.metadata.list!.items![1]!.logical_start,
        end: listBlock.logical_start + listBlock.metadata.list!.items![1]!.logical_end,
      },
    });
    run.destroy();
  });

  it("restores a safe selection after same-content revision publication", () => {
    const run = harness();
    select(run.selection, run.text(0), 2, run.text(1), 4);
    const controller = new MarkdownSelectionController({ mapper: run.mapper, boundary: run.host });
    const previous = controller.update().selection!;
    const next = parse(run.source, "r2", run.snapshot);
    run.runtime.publish(next, next.blocks.map(() => 100), { scrollTop: 0, viewportHeight: 500 });
    const nextMapper = new MarkdownPositionMapper(run.source, next, {
      heightIndex: run.runtime.getHeightIndex(),
      mounted: run.runtime,
    });
    const restored = controller.reconcileMapper(nextMapper);

    expect(restored.selection).toMatchObject({ revision: "r2", logicalText: previous.logicalText });
    expect(run.selection.rangeCount).toBe(1);
    run.destroy();
  });

  it("does not restore if the target block identity or selected text changed", () => {
    const run = harness();
    select(run.selection, run.text(0), 0, run.text(0), 5);
    const controller = new MarkdownSelectionController({ mapper: run.mapper, boundary: run.host });
    controller.update();
    const changedSource = run.source.replace("Alpha", "Changed");
    const changed = parse(changedSource, "r2", run.snapshot);
    run.runtime.publish(changed, changed.blocks.map(() => 100), { scrollTop: 0, viewportHeight: 500 });
    const nextMapper = new MarkdownPositionMapper(changedSource, changed, {
      heightIndex: run.runtime.getHeightIndex(),
      mounted: run.runtime,
    });

    expect(controller.reconcileMapper(nextMapper)).toMatchObject({
      selection: null,
      reason: expect.stringMatching(/restore/u),
    });
    expect(run.selection.rangeCount).toBe(0);
    run.destroy();
  });

  it("clears pins on focus loss but can preserve an explicitly trusted toolbar", () => {
    const run = harness();
    const toolbar = document.createElement("button");
    document.body.append(toolbar);
    select(run.selection, run.text(0), 0, run.text(0), 5);
    const controller = new MarkdownSelectionController({
      mapper: run.mapper,
      boundary: run.host,
      preserveFocusTarget: (target) => target === toolbar || (target !== null && run.host.contains(target)),
    });
    controller.attach();
    run.host.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: toolbar }));
    expect(controller.currentSelection()).not.toBeNull();
    const outside = document.createElement("button");
    document.body.append(outside);
    run.host.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: outside }));
    expect(controller.currentSelection()).toBeNull();
    expect(controller.pinnedIndices().size).toBe(0);
    toolbar.remove();
    outside.remove();
    controller.destroy();
    run.destroy();
  });

  it("fails explicitly for outside selections and oversized pinned ranges without adding hidden DOM", () => {
    const run = harness(Array.from({ length: 5 }, (_, index) => `P${index}`).join("\n\n"));
    const beforeChildren = run.host.querySelectorAll("*").length;
    select(run.selection, run.text(0), 0, run.text(4), 1);
    const limited = new MarkdownSelectionController({ mapper: run.mapper, boundary: run.host, maxPinnedBlocks: 2 });
    expect(limited.update()).toMatchObject({ selection: null, reason: "pin-limit" });
    expect(run.host.querySelectorAll("*").length).toBe(beforeChildren);

    const outside = document.createTextNode("outside");
    document.body.append(outside);
    select(run.selection, outside, 0, outside, 3);
    expect(limited.update()).toMatchObject({ selection: null, reason: "outside-document" });
    outside.remove();
    run.destroy();
  });
});
