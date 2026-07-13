import { describe, expect, it } from "vitest";

import { serializeMarkdownLogicalText } from "@/renderer/features/annotations/document/markdownLogicalText";
import type { MarkdownSnapshotBlock } from "@/renderer/markdownRuntime/document/MarkdownSnapshot";
import {
  MarkdownParserCancelledError,
  parseCanonicalMarkdownSnapshot,
  type MarkdownParserDiagnostics,
} from "@/renderer/markdownRuntime/worker/parser";
import {
  generateMarkdownRuntimeFixture,
  markdownRuntimeFixtureSpec,
} from "./fixtures/markdown-runtime";
import { markdownPreviewRendererParityFixture } from "./fixtures/markdownRuntimeParity";

const CONTRACT_CORPUS = [
  ["renderer parity", markdownPreviewRendererParityFixture],
  ["nested and malformed", [
    "# Title",
    "",
    "> Quote with **bold**",
    ">",
    "> - nested one",
    ">   - nested two",
    "",
    "Setext title",
    "------------",
    "",
    "    const indented = true;",
    "",
    "- [x] done",
    "- [ ] pending",
    "",
    "<b onclick=\"unsafe()\">escaped html</b>",
    "",
    "Inline $x+y$ and [safe](https://example.com).",
    "",
    "```unknown",
    "unclosed fence",
  ].join("\n")],
  ["line endings and unicode", "# 标题\r\n\r\nemoji 👨‍👩‍👧‍👦 and é.\r\n\r\n| 列 | 值 |\r\n| - | - |\r\n| 甲 | 乙 |\r\n"],
] as const;

describe("Parser and MarkdownSnapshot cross-module contract", () => {
  it.each(CONTRACT_CORPUS)("keeps canonical source, outline, logical text and block ranges aligned: %s", (_name, source) => {
    const snapshot = parse(source, "contract-r1");
    const runtimeLogical = serializeMarkdownLogicalText(source, snapshot);

    expect(runtimeLogical.logicalText).toBe(snapshot.logical_text);
    expect(snapshot.blocks.every((block) => source.slice(block.source_start, block.source_end).length > 0)).toBe(true);
    expect(snapshot.outline.every((item) => snapshot.blocks.some((block) => block.id === item.block_id && block.kind === "heading"))).toBe(true);
    if (snapshot.logical_text !== runtimeLogical.logicalText) {
      expect(classifyLogicalProjectionDifferences(snapshot.blocks)).not.toEqual([]);
    }
    assertSnapshotRanges(snapshot.blocks, source.length);
  });

  it("classifies every canonical rich block-kind specialization", () => {
    const source = [
      "```ts", "const code = true;", "```", "",
      "```mermaid", "flowchart TD", "A-->B", "```", "",
      "![image](asset.png)", "",
      "$$", "x^2", "$$", "",
      "<script>unsafe()</script>", "",
      "---",
    ].join("\n");
    const snapshot = parse(source, "classification-r1");

    expect(snapshot.blocks.map((block) => block.kind)).toEqual([
      "code", "mermaid", "image", "math", "html", "thematic-break",
    ]);
  });

  it("preserves stable block identity across a local edit without retaining parser tokens", () => {
    const beforeSource = "# Title\n\nEdited later\n\nStable target\n";
    const afterSource = "# Title\n\nEdited now\n\nStable target\n";
    const before = parse(beforeSource, "r1");
    const after = parseCanonicalMarkdownSnapshot({
      surface: "file",
      documentId: "file:contract.md",
      revision: "r2",
      source: afterSource,
      rendererProfile: "file-preview",
    }, { previousSnapshot: before });
    const stableBefore = before.blocks.find((block) => before.logical_text.slice(block.logical_start, block.logical_end) === "Stable target");
    const stableAfter = after.blocks.find((block) => after.logical_text.slice(block.logical_start, block.logical_end) === "Stable target");

    expect(stableAfter?.id).toBe(stableBefore?.id);
    expect(stableAfter?.identity_key).toBe(stableBefore?.identity_key);
    expect("source" in after).toBe(false);
    expect(after.blocks.every((block) => !("tokens" in block) && !("sourceText" in block))).toBe(true);
    expect(JSON.stringify(after)).not.toContain('"tokens"');
    expect(JSON.stringify(after)).not.toContain('"sourceText"');
  });

  it.each(["mixed-1m", "mixed-5m", "mixed-10m"])(
    "parses the exact %s fixture into one bounded valid Snapshot",
    (fixtureId) => {
      const generated = generateMarkdownRuntimeFixture(markdownRuntimeFixtureSpec(fixtureId));
      let diagnostics: MarkdownParserDiagnostics | null = null;
      const snapshot = parseCanonicalMarkdownSnapshot({
        surface: "file",
        documentId: `file:${fixtureId}.md`,
        revision: generated.metadata.hash,
        source: generated.source,
        rendererProfile: "file-preview",
      }, { onDiagnostics: (value) => { diagnostics = value; } });

      expect(snapshot.source_bytes).toBe(generated.metadata.bytes);
      expect(snapshot.source_characters).toBe(generated.source.length);
      expect(generated.metadata.lines - snapshot.line_count).toBe(generated.source.endsWith("\n") ? 1 : 0);
      expect(snapshot.blocks.length).toBeGreaterThan(1_000);
      expect(snapshot.blocks[0]?.source_start).toBeGreaterThanOrEqual(0);
      expect(snapshot.blocks.at(-1)?.source_end).toBeLessThanOrEqual(generated.source.length);
      // Object-backed JS tables are intentionally bounded here; the tighter process-memory budget is ZMDR-065.
      expect(snapshot.estimated_bytes).toBeLessThan(generated.metadata.bytes * 40);
      expect(diagnostics).toMatchObject({ parseCalls: 1, blockCount: snapshot.blocks.length });
      assertSnapshotRanges(snapshot.blocks, generated.source.length);
    },
    120_000,
  );

  it("cancels before publication and never emits a partial Snapshot", () => {
    const source = generateMarkdownRuntimeFixture(markdownRuntimeFixtureSpec("mixed-1m")).source;
    let checkpoints = 0;
    expect(() => parseCanonicalMarkdownSnapshot({
      surface: "file",
      documentId: "file:cancelled.md",
      revision: "cancelled",
      source,
      rendererProfile: "file-preview",
    }, {
      checkpointEveryTokens: 1,
      shouldCancel: () => ++checkpoints > 3,
    })).toThrow(MarkdownParserCancelledError);
    expect(checkpoints).toBeGreaterThan(3);
  });
});

function parse(source: string, revision: string) {
  return parseCanonicalMarkdownSnapshot({
    surface: "file",
    documentId: "file:contract.md",
    revision,
    source,
    rendererProfile: "file-preview",
  });
}

function normalizedRuntimeKind(
  block: MarkdownSnapshotBlock,
  source: string,
): "blockquote" | "code" | "fence" | "heading" | "html" | "list" | "paragraph" | "table" | "thematic_break" | "unknown" {
  if (block.kind === "mermaid") return "fence";
  if (block.kind === "code") return source.slice(block.source_start, block.source_end).trimStart().startsWith("```") ? "fence" : "code";
  if (block.kind === "image" || block.kind === "math" || block.kind === "html") return "paragraph";
  if (block.kind === "thematic-break") return "thematic_break";
  if (block.kind === "frontmatter") return "unknown";
  return block.kind;
}

function assertSnapshotRanges(blocks: readonly MarkdownSnapshotBlock[], sourceLength: number): void {
  let previousSourceEnd = 0;
  let previousLogicalEnd = 0;
  for (const [index, block] of blocks.entries()) {
    if (block.index !== index
      || block.source_start < previousSourceEnd
      || block.source_end < block.source_start
      || block.source_end > sourceLength
      || block.logical_start < previousLogicalEnd
      || block.logical_end < block.logical_start) {
      throw new Error(`Invalid Snapshot block range at index ${index}`);
    }
    for (const span of block.inline_spans) {
      if (span.source_start < block.source_start
        || span.source_end > block.source_end
        || span.logical_start < block.logical_start
        || span.logical_end > block.logical_end) {
        throw new Error(`Invalid inline span range in block ${block.id}`);
      }
    }
    previousSourceEnd = block.source_end;
    previousLogicalEnd = block.logical_end;
  }
}

function classifyLogicalProjectionDifferences(blocks: readonly MarkdownSnapshotBlock[]): readonly string[] {
  const differences = new Set<string>();
  if (blocks.length > 1) differences.add("block-separator-canonicalization");
  if (blocks.some((block) => block.kind === "list")) differences.add("list-marker-elision");
  if (blocks.some((block) => block.kind === "table")) differences.add("table-cell-separators");
  if (blocks.some((block) => block.kind === "math" || block.inline_spans.some((span) => span.kind === "math"))) {
    differences.add("math-delimiter-elision");
  }
  return Object.freeze([...differences]);
}
