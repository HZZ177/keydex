import { describe, expect, it, vi } from "vitest";

import { MarkdownHeightIndex } from "@/renderer/markdownRuntime/layout/HeightIndex";
import {
  MarkdownOutlineController,
  buildMarkdownOutline,
} from "@/renderer/markdownRuntime/navigation";
import { parseCanonicalMarkdownSnapshot } from "@/renderer/markdownRuntime/worker/parser";
import type { MarkdownSnapshot } from "@/renderer/markdownRuntime/document/MarkdownSnapshot";

const SOURCE = [
  "# Same",
  "Root paragraph",
  "",
  "## Same",
  "Level two paragraph",
  "",
  "### Three",
  "Level three paragraph",
  "",
  "#### Four",
  "Level four paragraph",
  "",
  "##### Five",
  "Level five paragraph",
  "",
  "###### Six",
  "Level six paragraph",
  "",
  "# Next",
  "Tail paragraph",
].join("\n\n");

function parse(source = SOURCE, revision = "r1", previousSnapshot?: MarkdownSnapshot) {
  return parseCanonicalMarkdownSnapshot({
    surface: "file",
    documentId: "file:outline.md",
    revision,
    source,
    rendererProfile: "file-preview",
  }, { previousSnapshot });
}

function harness(options: ConstructorParameters<typeof MarkdownOutlineController>[3] = {}) {
  const snapshot = parse();
  const heights = snapshot.blocks.map(() => 100);
  const index = new MarkdownHeightIndex(snapshot.revision, heights);
  const controller = new MarkdownOutlineController(snapshot, index, heights, options);
  return { snapshot, heights, index, controller };
}

describe("Snapshot-backed Markdown outline", () => {
  it("builds all six heading levels, stable parents, sections, and duplicate titles without DOM", () => {
    const snapshot = parse();
    const nodes = buildMarkdownOutline(snapshot);

    expect(nodes.map((node) => node.level)).toEqual([1, 2, 3, 4, 5, 6, 1]);
    expect(nodes.filter((node) => node.title === "Same")).toHaveLength(2);
    expect(new Set(nodes.map((node) => node.id)).size).toBe(nodes.length);
    expect(nodes[1]).toMatchObject({ parentBlockId: nodes[0].blockId });
    expect(nodes[5]).toMatchObject({ parentBlockId: nodes[4].blockId });
    expect(nodes[0].sectionEnd).toBe(nodes[6].blockIndex);
    expect(nodes[1].sectionEnd).toBe(nodes[6].blockIndex);
  });

  it("returns an empty outline for heading-free Markdown", () => {
    const snapshot = parse("Alpha\n\nBeta");
    expect(buildMarkdownOutline(snapshot)).toEqual([]);
  });
});

describe("view-local Markdown fold state", () => {
  it("hides only the heading section descendants and updates HeightIndex locally", () => {
    const run = harness();
    const root = run.controller.nodes()[0]!;
    const beforeTotal = run.index.totalHeight;
    const folded = run.controller.toggleFold(root.blockId, { scrollTop: 0, viewportHeight: 300 });

    expect(folded.collapsed).toBe(true);
    expect(folded.hiddenIndices).toEqual(
      Array.from({ length: root.sectionEnd - root.sectionStart }, (_, offset) => root.sectionStart + offset),
    );
    expect(folded.changedIndices).toEqual(folded.hiddenIndices);
    expect(run.index.heightAt(root.blockIndex)).toBe(100);
    folded.hiddenIndices.forEach((index) => expect(run.index.heightAt(index)).toBe(0));
    expect(run.index.totalHeight).toBe(beforeTotal - folded.hiddenIndices.length * 100);

    const expanded = run.controller.toggleFold(root.blockId, { scrollTop: 0, viewportHeight: 300 });
    expect(expanded.collapsed).toBe(false);
    folded.hiddenIndices.forEach((index) => expect(run.index.heightAt(index)).toBe(100));
    expect(run.index.totalHeight).toBe(beforeTotal);
  });

  it("keeps the same reading block stable when a section above is folded", () => {
    const run = harness();
    const root = run.controller.nodes()[0]!;
    const nextHeading = run.controller.nodes().at(-1)!;
    const scrollTop = run.index.offsetOf(nextHeading.blockIndex) + 20;
    const folded = run.controller.toggleFold(root.blockId, { scrollTop, viewportHeight: 50 });

    expect(folded.correction).toMatchObject({ status: "applied" });
    const after = run.index.queryY(folded.correction!.scrollTop)!;
    expect(run.snapshot.blocks[after.index].id).toBe(nextHeading.blockId);
    expect(after.offsetWithinBlock).toBe(20);
  });

  it("keeps nested folded headings folded when their parent expands", () => {
    const run = harness();
    const [root, nested] = run.controller.nodes();
    run.controller.toggleFold(nested.blockId, { scrollTop: 0, viewportHeight: 300 });
    run.controller.toggleFold(root.blockId, { scrollTop: 0, viewportHeight: 300 });
    const expandedParent = run.controller.toggleFold(root.blockId, { scrollTop: 0, viewportHeight: 300 });

    expect(expandedParent.foldedBlockIds).toEqual([nested.blockId]);
    expect(expandedParent.hiddenIndices).toEqual(
      Array.from({ length: nested.sectionEnd - nested.sectionStart }, (_, offset) => nested.sectionStart + offset),
    );
  });

  it("keeps two views independent and publishes serializable fold state", () => {
    const firstEvents: Array<readonly string[]> = [];
    const first = harness({ onFoldedBlockIdsChanged: (ids) => firstEvents.push(ids) });
    const second = harness();
    const rootId = first.controller.nodes()[0].blockId;
    first.controller.toggleFold(rootId, { scrollTop: 0, viewportHeight: 300 });

    expect(first.controller.foldedBlockIds()).toEqual([rootId]);
    expect(second.controller.foldedBlockIds()).toEqual([]);
    expect(firstEvents).toEqual([[rootId]]);
    expect(JSON.parse(JSON.stringify(first.controller.foldedBlockIds()))).toEqual([rootId]);
  });

  it("restores measured height changes made while a block is folded", () => {
    const run = harness();
    const root = run.controller.nodes()[0];
    run.controller.toggleFold(root.blockId, { scrollTop: 0, viewportHeight: 300 });
    const hiddenIndex = root.sectionStart;
    expect(run.controller.updateBaseHeight(hiddenIndex, 175)).toBe(0);
    expect(run.index.heightAt(hiddenIndex)).toBe(0);
    run.controller.toggleFold(root.blockId, { scrollTop: 0, viewportHeight: 300 });
    expect(run.index.heightAt(hiddenIndex)).toBe(175);
    expect(run.index.kindAt(hiddenIndex)).toBe("measured");
  });
});

describe("Markdown outline navigation", () => {
  it("expands folded ancestors before delegating to RevealController", async () => {
    const reveal = vi.fn();
    const run = harness({ reveal });
    const [root, nested] = run.controller.nodes();
    run.controller.toggleFold(root.blockId, { scrollTop: 0, viewportHeight: 300 });
    const result = await run.controller.navigateOutline(nested.id, { scrollTop: 0, viewportHeight: 300 });

    expect(result).toMatchObject({
      targetBlockId: nested.blockId,
      expandedHeadingBlockIds: [root.blockId],
      foldResult: { collapsed: false },
    });
    expect(reveal).toHaveBeenCalledWith({ kind: "block", blockId: nested.blockId });
    expect(run.controller.hiddenIndices()).not.toContain(nested.blockIndex);
  });

  it("expands every folded ancestor for an arbitrary block target", async () => {
    const reveal = vi.fn();
    const run = harness({ reveal });
    const [root, levelTwo] = run.controller.nodes();
    run.controller.toggleFold(levelTwo.blockId, { scrollTop: 0, viewportHeight: 300 });
    run.controller.toggleFold(root.blockId, { scrollTop: 0, viewportHeight: 300 });
    const targetIndex = levelTwo.sectionStart;
    const target = run.snapshot.blocks[targetIndex];
    const result = await run.controller.navigateBlock(target.id, { scrollTop: 0, viewportHeight: 300 });

    expect(new Set(result.expandedHeadingBlockIds)).toEqual(new Set([root.blockId, levelTwo.blockId]));
    expect(run.controller.foldedBlockIds()).toEqual([]);
    expect(reveal).toHaveBeenCalledWith({ kind: "block", blockId: target.id });
  });

  it("preserves valid folded stable ids and prunes removed headings on revision", () => {
    const run = harness();
    const rootId = run.controller.nodes()[0].blockId;
    run.controller.toggleFold(rootId, { scrollTop: 0, viewportHeight: 300 });
    const same = parse(SOURCE, "r2", run.snapshot);
    const sameHeights = same.blocks.map(() => 100);
    run.controller.reconcile(same, new MarkdownHeightIndex("r2", sameHeights), sameHeights);
    expect(run.controller.foldedBlockIds()).toEqual([rootId]);

    const removedSource = SOURCE.replace("# Same", "Root without heading");
    const removed = parse(removedSource, "r3", same);
    const removedHeights = removed.blocks.map(() => 100);
    run.controller.reconcile(removed, new MarkdownHeightIndex("r3", removedHeights), removedHeights);
    expect(run.controller.foldedBlockIds()).not.toContain(rootId);
  });

  it("fails explicitly for missing outline and block targets", async () => {
    const run = harness();
    await expect(run.controller.navigateOutline("missing", { scrollTop: 0, viewportHeight: 100 })).rejects.toThrow(/missing/u);
    await expect(run.controller.navigateBlock("missing", { scrollTop: 0, viewportHeight: 100 })).rejects.toThrow(/missing/u);
  });
});
