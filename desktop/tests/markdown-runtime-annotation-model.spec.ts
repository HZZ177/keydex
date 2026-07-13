import { describe, expect, it } from "vitest";

import { resolveAnnotationPayload } from "@/renderer/features/annotations/anchoring/annotationResolverProtocol";
import { resolveDocumentAnnotations } from "@/renderer/features/annotations/anchoring/resolveDocumentAnnotations";
import {
  createMarkdownTextModel,
  createMarkdownTextModelFromProjection,
} from "@/renderer/features/annotations/document/MarkdownTextModel";
import { createPlainTextModel } from "@/renderer/features/annotations/document/PlainTextModel";
import { serializeMarkdownLogicalText } from "@/renderer/features/annotations/document/markdownLogicalText";
import type {
  MarkdownLogicalBlock,
  MarkdownLogicalSegment,
} from "@/renderer/features/annotations/document/markdownLogicalText";
import { parseCanonicalMarkdownSnapshot } from "@/renderer/markdownRuntime/worker/parser";
import type { MarkdownSnapshot } from "@/renderer/markdownRuntime/document/MarkdownSnapshot";
import type { AnnotationRecord } from "@/runtime/annotations";
import { markdownPreviewRendererParityFixture } from "./fixtures/markdownRuntimeParity";

function snapshot(source: string, revision = "r1", previousSnapshot?: MarkdownSnapshot) {
  return parseCanonicalMarkdownSnapshot({
    surface: "file",
    documentId: "file:annotation-runtime.md",
    revision,
    source,
    rendererProfile: "file-preview",
  }, { previousSnapshot });
}

describe("Snapshot-backed annotation MarkdownTextModel", () => {
  it("keeps the Snapshot-backed logical/source projection internally consistent", () => {
    const source = markdownPreviewRendererParityFixture;
    const runtimeSnapshot = snapshot(source);
    const snapshotProjection = serializeMarkdownLogicalText(source, runtimeSnapshot);

    expect(createMarkdownTextModel(source, "r1", runtimeSnapshot).logicalText).toBe(snapshotProjection.logicalText);
    expect(runtimeSnapshot.blocks.every((block) => (
      block.logical_start >= 0
      && block.logical_end >= block.logical_start
      && block.logical_end <= runtimeSnapshot.logical_text.length
    ))).toBe(true);
    expect(snapshotProjection.blocks.map(stripBlockKey)).toHaveLength(runtimeSnapshot.blocks.length);
    expect(snapshotProjection.segments.map(stripSegmentKey).length).toBeGreaterThan(0);
    expect(snapshotProjection.blocks.every((block) => block.sourceStart >= 0 && block.sourceEnd <= source.length)).toBe(true);
  });

  it("consumes a Snapshot or existing projection without reparsing raw Markdown", () => {
    const source = "# Guide\n\nUse **target** and [link](README.md).";
    const runtimeSnapshot = snapshot(source);

    const fromSnapshot = createMarkdownTextModel(source, "r1", runtimeSnapshot);
    const fromProjection = createMarkdownTextModelFromProjection(source, "r1", fromSnapshot.logicalDocument());

    expect(fromSnapshot.logicalText).toBe(fromProjection.logicalText);
    expect(fromSnapshot.revision.textRevision).toBe(fromProjection.revision.textRevision);
  });

  it("keeps source-only lines unmapped and repeated visible text structurally distinct", () => {
    const source = "# Repeat\n\n\nRepeat repeat\n\n<!-- comment -->\n\nRepeat";
    const model = createMarkdownTextModel(source, "r1", snapshot(source));
    const first = model.logicalText.indexOf("Repeat");
    const second = model.logicalText.indexOf("Repeat", first + 1);
    const third = model.logicalText.indexOf("repeat", second + 1);
    const ranges = [first, second, third].map((start) => model.toSourceRanges({ start, end: start + 6 }));

    expect(ranges.every((range) => range.length === 1)).toBe(true);
    expect(new Set(ranges.map((range) => range[0].start)).size).toBe(3);
    const blankLineStart = source.indexOf("\n\n\n") + 1;
    expect(model.toLogicalRange({ start: blankLineStart, end: blankLineStart + 1 })).toBeNull();
  });

  it("reuses stable Snapshot block ids and logical revision across document revisions", () => {
    const source = "# Title\n\nAlpha\n\nBeta";
    const firstSnapshot = snapshot(source, "r1");
    const secondSnapshot = snapshot(source, "r2", firstSnapshot);
    const first = createMarkdownTextModel(source, "r1", firstSnapshot);
    const second = createMarkdownTextModel(source, "r2", secondSnapshot);

    expect(second.blocks.map((block) => block.key)).toEqual(first.blocks.map((block) => block.key));
    expect(second.revision).toEqual({ documentRevision: "r2", textRevision: first.revision.textRevision });
  });

  it.each([1, 5])("builds a %iMiB annotation model without another parse", (sizeMiB) => {
    const target = sizeMiB * 1024 * 1024;
    const parts: string[] = [];
    let length = 0;
    while (length < target) {
      const part = `Paragraph ${parts.length} **target** ${"payload ".repeat(60)}`;
      parts.push(part);
      length += part.length + 2;
    }
    const source = parts.join("\n\n");
    const runtimeSnapshot = snapshot(source, `r-${sizeMiB}`);
    const startedAt = performance.now();
    const model = createMarkdownTextModel(source, `r-${sizeMiB}`, runtimeSnapshot);
    const durationMs = performance.now() - startedAt;

    expect(model.blocks).toHaveLength(runtimeSnapshot.blocks.length);
    expect(model.logicalText.length).toBeGreaterThan(target * 0.8);
    expect(durationMs).toBeLessThan(2_000);
  });

  it("reconstructs the resolver Worker model from a projection without parsing raw Markdown", () => {
    const source = "# Guide\n\nalpha target omega";
    const model = createMarkdownTextModel(source, "r1", snapshot(source));
    const start = model.logicalText.indexOf("target");
    const records = [record("ann", "target", start)];
    const expected = resolveDocumentAnnotations(model, records);
    const clonedProjection = structuredClone(model.logicalDocument());
    const reconstructed = createMarkdownTextModelFromProjection(source, "r1", clonedProjection);
    const actual = resolveAnnotationPayload({
      document: {
        kind: "markdown",
        rawSource: source,
        documentRevision: "r1",
        markdownProjection: clonedProjection,
      },
      records,
    });

    expect(reconstructed.logicalText).toBe(model.logicalText);
    expect(actual).toEqual(expected);
  });

  it("leaves PlainTextModel behavior unchanged", () => {
    const source = "Alpha\r\n中文 😀";
    const model = createPlainTextModel(source, "plain-r1");
    expect(model.logicalText).toBe(source);
    expect(model.toSourceRanges({ start: 2, end: 8 })).toEqual([{ start: 2, end: 8 }]);
    expect(model.projectSelection({ coordinateSpace: "source", range: { start: 0, end: 5 } }))
      .toMatchObject({ logicalRange: { start: 0, end: 5 } });
  });
});

function stripBlockKey(block: MarkdownLogicalBlock) {
  const { key: _key, ...rest } = block;
  return rest;
}

function stripSegmentKey(segment: MarkdownLogicalSegment) {
  const { blockKey: _blockKey, ...rest } = segment;
  return rest;
}

function record(id: string, exact: string, start: number): AnnotationRecord {
  return {
    id,
    workspace_id: "ws",
    document_path: "README.md",
    target: {
      type: "text",
      selector: {
        position: { start, end: start + exact.length },
        quote: { exact, prefix: "alpha ", suffix: " omega" },
        context: { containerType: "paragraph", headingPath: ["Guide"] },
        textRevision: "old",
        documentRevision: "old",
      },
    },
    body: "note",
    created_at: "2026-01-01",
    updated_at: "2026-01-01",
  };
}
