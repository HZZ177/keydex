import { describe, expect, it } from "vitest";

import {
  createMarkdownHeightEstimateContext,
  estimateMarkdownBlockHeight,
  estimateMarkdownBlockHeights,
  estimateMarkdownRenderUnitHeight,
  estimateMarkdownSnapshotHeights,
  measuredMarkdownBlockOccupiedHeight,
} from "@/renderer/markdownRuntime/layout/heightEstimate";
import { subdivideMarkdownBlock } from "@/renderer/markdownRuntime/document/blockSubdivision";
import { createMarkdownSnapshot } from "@/renderer/markdownRuntime/document/MarkdownSnapshot";
import { parseCanonicalMarkdownSnapshot } from "@/renderer/markdownRuntime/worker/parser";

function parse(source: string) {
  return parseCanonicalMarkdownSnapshot({
    surface: "file",
    documentId: "file:height.md",
    revision: `height:${source.length}`,
    source,
    rendererProfile: "file-preview",
  });
}

function oneBlock(kind: "code" | "paragraph" | "table", text: string) {
  return createMarkdownSnapshot({
    surface: "file",
    document_id: `file:${kind}.md`,
    revision: `${kind}:${text.length}`,
    renderer_profile: "file-preview",
    mode: "canonical",
    source_bytes: text.length,
    source_characters: text.length,
    logical_text: text,
    line_count: text.split("\n").length,
    blocks: [{
      id: `block-${kind}`,
      identity_key: `identity-${kind}`,
      content_hash: `hash-${kind}`,
      index: 0,
      kind,
      parent_id: null,
      depth: 0,
      source_start: 0,
      source_end: text.length,
      logical_start: 0,
      logical_end: text.length,
      line_start: 0,
      line_end: text.split("\n").length,
      inline_spans: [],
      metadata: kind === "table"
        ? { table: { columns: 4, alignments: [null, null, null, null] } }
        : kind === "code"
          ? { language: "text" }
          : {},
    }],
    outline: [],
    resources: [],
    stream: { kind: "canonical", finalized: true },
    indexes: {
      line_map_revision: "line",
      logical_projection_revision: "logical",
      source_index_revision: "source",
      find_index_revision: null,
      annotation_index_revision: null,
    },
  });
}

describe("deterministic Markdown initial height estimates", () => {
  it("returns deterministic positive minima for empty, short, and long blocks", () => {
    const snapshot = parse("# H\n\nShort\n\n\n---");
    const context = createMarkdownHeightEstimateContext(snapshot, { viewportWidth: 800 });
    const first = snapshot.blocks.map((block) => estimateMarkdownBlockHeight(block, context));
    const second = snapshot.blocks.map((block) => estimateMarkdownBlockHeight(block, context));

    expect(second).toEqual(first);
    expect(first.every((height) => height > 0)).toBe(true);
    expect(first[0]).toBeGreaterThan(first.at(-1) ?? 0);

    const long = oneBlock("paragraph", "x".repeat(20_000));
    const longHeight = estimateMarkdownSnapshotHeights(long, { viewportWidth: 800 })[0];
    expect(longHeight).toBeGreaterThan(1000);
  });

  it("estimates more wrapping in a narrow viewport", () => {
    const snapshot = oneBlock("paragraph", "word ".repeat(1000));
    const narrow = estimateMarkdownSnapshotHeights(snapshot, { viewportWidth: 240 })[0];
    const wide = estimateMarkdownSnapshotHeights(snapshot, { viewportWidth: 1440 })[0];

    expect(narrow).toBeGreaterThan(wide * 4);
  });

  it("owns inter-block spacing in the height index but never adds a trailing document gap", () => {
    const snapshot = parse("Alpha\n\nBeta");
    const heights = estimateMarkdownSnapshotHeights(snapshot, { viewportWidth: 800 });

    expect([...heights]).toEqual([34, 22]);
    expect(measuredMarkdownBlockOccupiedHeight(22, 0, 2)).toBe(34);
    expect(measuredMarkdownBlockOccupiedHeight(22, 1, 2)).toBe(22);
    expect(measuredMarkdownBlockOccupiedHeight(22, 0, 1)).toBe(22);
  });

  it("uses code line count and table row/width behavior", () => {
    const code = oneBlock("code", "line\n".repeat(200));
    const table = oneBlock("table", "a\tb\tc\td\n".repeat(100));
    const codeHeight = estimateMarkdownSnapshotHeights(code, { viewportWidth: 800 })[0];
    const narrowTable = estimateMarkdownSnapshotHeights(table, { viewportWidth: 320 })[0];
    const wideTable = estimateMarkdownSnapshotHeights(table, { viewportWidth: 1200 })[0];

    expect(codeHeight).toBeGreaterThan(3000);
    expect(narrowTable).toBeGreaterThan(wideTable);
    expect(wideTable).toBeGreaterThanOrEqual(100 * 32);
  });

  it("fits known image dimensions to available width and falls back for unknown images", () => {
    const snapshot = parse("![portrait](portrait.png)");
    const resource = snapshot.resources.find((entry) => entry.kind === "image");
    expect(resource).toBeDefined();
    const unknown = estimateMarkdownSnapshotHeights(snapshot, { viewportWidth: 500 })[0];
    const known = estimateMarkdownSnapshotHeights(snapshot, {
      viewportWidth: 500,
      knownResourceSizes: new Map([[resource!.id, { width: 800, height: 1200 }]]),
    })[0];

    expect(unknown).toBeGreaterThanOrEqual(160);
    expect(known).toBeGreaterThan(unknown);
    expect(known).toBeCloseTo(702, -1);
  });

  it("adds known inline image height to surrounding text", () => {
    const snapshot = parse("Before ![wide](wide.png) after");
    const resource = snapshot.resources.find((entry) => entry.kind === "image")!;
    const withoutSize = estimateMarkdownSnapshotHeights(snapshot, { viewportWidth: 800 })[0];
    const withSize = estimateMarkdownSnapshotHeights(snapshot, {
      viewportWidth: 800,
      knownResourceSizes: new Map([[resource.id, { width: 1000, height: 500 }]]),
    })[0];

    expect(withSize).toBeGreaterThan(withoutSize + 300);
  });

  it("estimates subdivided units without repeating inter-unit block gaps", () => {
    const snapshot = oneBlock("code", "line\n".repeat(10_000));
    const block = snapshot.blocks[0];
    const units = subdivideMarkdownBlock(snapshot, block);
    const context = createMarkdownHeightEstimateContext(snapshot, { viewportWidth: 800, blockGap: 20 });
    const heights = units.map((unit) => estimateMarkdownRenderUnitHeight(block, unit, context));

    expect(units.length).toBeGreaterThan(10);
    expect(heights.every((height) => height > 0)).toBe(true);
    const lastWithoutGap = estimateMarkdownRenderUnitHeight(block, { ...units.at(-1)!, continuationAfter: true }, context);
    expect(heights.at(-1)! - lastWithoutGap).toBe(20);
  });

  it("estimates one million blocks in a bounded linear batch without DOM APIs", () => {
    const snapshot = oneBlock("paragraph", "short text");
    const blocks = new Array(1_000_000).fill(snapshot.blocks[0]);
    const context = createMarkdownHeightEstimateContext(snapshot, { viewportWidth: 800 });
    const startedAt = performance.now();
    const heights = estimateMarkdownBlockHeights(blocks, context);
    const duration = performance.now() - startedAt;

    expect(heights).toHaveLength(1_000_000);
    expect(heights[0] - heights.at(-1)!).toBe(12);
    expect(heights[500_000]).toBe(heights[0]);
    expect(duration).toBeLessThan(2000);
  }, 10_000);

  it("validates viewport and typography inputs", () => {
    const snapshot = oneBlock("paragraph", "text");
    expect(() => createMarkdownHeightEstimateContext(snapshot, { viewportWidth: 0 })).toThrow(/viewportWidth/u);
    expect(() => createMarkdownHeightEstimateContext(snapshot, {
      viewportWidth: 800,
      averageCharacterWidth: Number.NaN,
    })).toThrow(/averageCharacterWidth/u);
  });
});
