import { describe, expect, it } from "vitest";

import {
  subdivisionSelectionSegments,
  subdivideMarkdownBlock,
  subdivideMarkdownSnapshot,
} from "@/renderer/markdownRuntime/document/blockSubdivision";
import {
  createMarkdownSnapshot,
  type MarkdownSnapshotBlockKind,
  type MarkdownSnapshotBlockMetadata,
} from "@/renderer/markdownRuntime/document/MarkdownSnapshot";
import { parseCanonicalMarkdownSnapshot } from "@/renderer/markdownRuntime/worker/parser";

function synthetic(
  kind: MarkdownSnapshotBlockKind,
  text: string,
  metadata: MarkdownSnapshotBlockMetadata = {},
) {
  return createMarkdownSnapshot({
    surface: "file",
    document_id: `file:${kind}.md`,
    revision: `${kind}:${text.length}`,
    renderer_profile: "file-preview",
    mode: "canonical",
    source_bytes: new TextEncoder().encode(text).byteLength,
    source_characters: text.length,
    logical_text: text,
    line_count: text ? text.split("\n").length : 0,
    blocks: [{
      id: `block-${kind}`,
      identity_key: `identity-${kind}`,
      content_hash: `hash-${kind}-${text.length}`,
      index: 0,
      kind,
      parent_id: null,
      depth: 0,
      source_start: 0,
      source_end: text.length,
      logical_start: 0,
      logical_end: text.length,
      line_start: 0,
      line_end: text ? text.split("\n").length : 0,
      inline_spans: [],
      metadata,
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

describe("pathological Markdown block subdivision", () => {
  it("does not split ordinary blocks", () => {
    const snapshot = parseCanonicalMarkdownSnapshot({
      surface: "file",
      documentId: "file:ordinary.md",
      revision: "ordinary",
      source: "# Heading\n\nParagraph\n\n```ts\ncode\n```\n\n| A | B |\n|---|---|\n| 1 | 2 |",
      rendererProfile: "file-preview",
    });
    const units = subdivideMarkdownSnapshot(snapshot);

    for (const block of snapshot.blocks) {
      expect(units.get(block.id)).toEqual([expect.objectContaining({
        id: `${block.id}:whole`,
        kind: "whole",
        sourceStart: block.source_start,
        sourceEnd: block.source_end,
        logicalStart: block.logical_start,
        logicalEnd: block.logical_end,
      })]);
    }
  });

  it("bounds a 1 MiB single paragraph without gaps or copied text", () => {
    const snapshot = synthetic("paragraph", "x".repeat(1024 * 1024));
    const units = subdivideMarkdownBlock(snapshot, snapshot.blocks[0]);

    expect(units.length).toBeGreaterThan(60);
    expect(units.every((unit) => unit.logicalEnd - unit.logicalStart <= 16 * 1024)).toBe(true);
    expectContinuous(snapshot, units);
  });

  it("bounds a 1 MiB single-line code block by characters", () => {
    const snapshot = synthetic("code", "x".repeat(1024 * 1024), { language: "text" });
    const units = subdivideMarkdownBlock(snapshot, snapshot.blocks[0]);

    expect(units.length).toBeGreaterThan(15);
    expect(units.every((unit) => unit.kind === "code-segment")).toBe(true);
    expect(units.every((unit) => unit.logicalEnd - unit.logicalStart <= 64 * 1024)).toBe(true);
    expectContinuous(snapshot, units);
  });

  it("bounds 100,000 code lines by line count", () => {
    const text = "x\n".repeat(100_000);
    const snapshot = synthetic("code", text, { language: "text" });
    const units = subdivideMarkdownBlock(snapshot, snapshot.blocks[0]);

    expect(units).toHaveLength(200);
    expect(units.every((unit) => unit.kind === "code-lines")).toBe(true);
    expect(units.every((unit) => unit.lineEnd - unit.lineStart <= 500)).toBe(true);
    expectContinuous(snapshot, units);
  });

  it("bounds 100,000 table rows and records repeatable header ranges", () => {
    const text = "A\tB\n" + "1\t2\n".repeat(100_000);
    const snapshot = synthetic("table", text, {
      table: { columns: 2, alignments: [null, null] },
    });
    const units = subdivideMarkdownBlock(snapshot, snapshot.blocks[0]);

    expect(units.length).toBeGreaterThanOrEqual(500);
    expect(units.every((unit) => unit.kind === "table-rows")).toBe(true);
    expect(units.every((unit) => (unit.rowEnd ?? 0) - (unit.rowStart ?? 0) <= 200)).toBe(true);
    expect(units[0].tableHeaderLogicalStart).toBeNull();
    expect(units[1]).toMatchObject({ tableHeaderLogicalStart: 0, tableHeaderLogicalEnd: 4 });
    expectContinuous(snapshot, units);
  });

  it("never splits Chinese, emoji ZWJ, skin-tone, or combining graphemes", () => {
    const text = "中文👩🏽‍💻e\u0301".repeat(100);
    const snapshot = synthetic("paragraph", text);
    const units = subdivideMarkdownBlock(snapshot, snapshot.blocks[0], { paragraphMaxCharacters: 17 });
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    const validBoundaries = new Set([...segmenter.segment(text)].map((entry) => entry.index));
    validBoundaries.add(text.length);

    expect(units.length).toBeGreaterThan(10);
    expect(units.slice(0, -1).every((unit) => validBoundaries.has(unit.logicalEnd))).toBe(true);
    expect(units.map((unit) => text.slice(unit.logicalStart, unit.logicalEnd)).join("")).toBe(text);
    expectContinuous(snapshot, units);
  });

  it("maps a cross-unit selection into continuous logical and source segments", () => {
    const text = Array.from({ length: 100 }, (_, index) => `word-${index}`).join(" ");
    const snapshot = synthetic("paragraph", text);
    const units = subdivideMarkdownBlock(snapshot, snapshot.blocks[0], { paragraphMaxCharacters: 40 });
    const start = units[1].logicalStart + 3;
    const end = units[4].logicalEnd - 2;
    const segments = subdivisionSelectionSegments(units, start, end);

    expect(segments.length).toBeGreaterThan(2);
    expect(segments[0].logicalStart).toBe(start);
    expect(segments.at(-1)?.logicalEnd).toBe(end);
    for (let index = 1; index < segments.length; index += 1) {
      expect(segments[index].logicalStart).toBe(segments[index - 1].logicalEnd);
      expect(segments[index].sourceStart).toBe(segments[index - 1].sourceEnd);
    }
    expect(segments.map((segment) => text.slice(segment.logicalStart, segment.logicalEnd)).join(""))
      .toBe(text.slice(start, end));
  });

  it("keeps decorated Markdown source ranges monotonic and edge-complete", () => {
    const source = Array.from(
      { length: 30 },
      (_, index) => `**bold ${index}** with [link ${index}](guide-${index}.md)`,
    ).join("\n");
    const snapshot = parseCanonicalMarkdownSnapshot({
      surface: "file",
      documentId: "file:decorated.md",
      revision: "decorated",
      source,
      rendererProfile: "file-preview",
    });
    const block = snapshot.blocks[0];
    const units = subdivideMarkdownBlock(snapshot, block, { paragraphMaxCharacters: 80 });

    expect(units.length).toBeGreaterThan(5);
    expect(units[0].sourceStart).toBe(block.source_start);
    expect(units.at(-1)?.sourceEnd).toBe(block.source_end);
    for (let index = 1; index < units.length; index += 1) {
      expect(units[index].sourceStart).toBe(units[index - 1].sourceEnd);
      expect(units[index].logicalStart).toBe(units[index - 1].logicalEnd);
    }
  });

  it("validates options, block ownership, and selection ranges", () => {
    const snapshot = synthetic("paragraph", "text");
    expect(() => subdivideMarkdownBlock(snapshot, { ...snapshot.blocks[0], id: "other" }))
      .toThrow(/belong/u);
    expect(() => subdivideMarkdownBlock(snapshot, snapshot.blocks[0], { paragraphMaxCharacters: 0 }))
      .toThrow(/positive/u);
    expect(() => subdivisionSelectionSegments([], 5, 4)).toThrow(/invalid/u);
  });
});

function expectContinuous(
  snapshot: ReturnType<typeof synthetic>,
  units: ReturnType<typeof subdivideMarkdownBlock>,
): void {
  const block = snapshot.blocks[0];
  expect(units[0]).toMatchObject({
    logicalStart: block.logical_start,
    sourceStart: block.source_start,
    continuationBefore: false,
  });
  expect(units.at(-1)).toMatchObject({
    logicalEnd: block.logical_end,
    sourceEnd: block.source_end,
    continuationAfter: false,
  });
  for (let index = 1; index < units.length; index += 1) {
    expect(units[index].logicalStart).toBe(units[index - 1].logicalEnd);
    expect(units[index].sourceStart).toBe(units[index - 1].sourceEnd);
    expect(units[index].index).toBe(index);
  }
}
