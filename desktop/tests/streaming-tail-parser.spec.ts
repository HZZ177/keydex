import { describe, expect, it } from "vitest";

import {
  StreamingTailParser,
  StreamingTailParserStaleEpochError,
  repairStreamingMarkdownTail,
} from "@/renderer/markdownRuntime/streaming";
import type { MarkdownSnapshot } from "@/renderer/markdownRuntime/document/MarkdownSnapshot";
import { parseCanonicalMarkdownSnapshot } from "@/renderer/markdownRuntime/worker/parser";

const options = {
  surface: "message" as const,
  documentId: "message:streaming-tail-test",
  rendererProfile: "conversation" as const,
};

describe("StreamingTailParser", () => {
  it("reparses only the prior mutable root block and freezes older block identities", () => {
    const parser = new StreamingTailParser(options);
    const first = parser.update({ source: "Alpha\n\nBeta", revision: "r1", epoch: 1 });
    const alphaId = first.snapshot.blocks[0].id;
    expect(first.snapshot).toMatchObject({
      mode: "stream-tail",
      stream: { kind: "streaming", prefix_block_count: 1, tail_block_start: 1 },
    });
    expect(first.diagnostics).toMatchObject({ parsedSourceStart: 0, parsedCharacters: 11, reusedPrefixBlocks: 0 });

    const secondSource = "Alpha\n\nBeta\n\nGamma";
    const second = parser.update({ source: secondSource, revision: "r2", epoch: 1 });
    expect(second.snapshot.blocks[0]).toBe(first.snapshot.blocks[0]);
    expect(second.snapshot.blocks[0].id).toBe(alphaId);
    expect(second.snapshot.stream).toMatchObject({
      kind: "streaming",
      prefix_block_count: 2,
      tail_block_start: 2,
    });
    expect(second.diagnostics.parsedSourceStart).toBe("Alpha\n\n".length);
    expect(second.diagnostics.parsedCharacters).toBe("Beta\n\nGamma".length);
    expect(second.diagnostics.parsedCharacters).toBeLessThan(secondSource.length);
    expect(blockTexts(second.snapshot)).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("keeps an unclosed fence mutable until it closes and a later root block appears", () => {
    const parser = new StreamingTailParser(options);
    const open = parser.update({
      source: "Intro\n\n```ts\nconst value = 1",
      revision: "f1",
      epoch: 1,
    });
    const introId = open.snapshot.blocks[0].id;
    const fenceStart = open.snapshot.blocks[1].source_start;
    expect(open.snapshot.stream).toMatchObject({ kind: "streaming", tail_source_start: fenceStart });

    const growing = parser.update({
      source: "Intro\n\n```ts\nconst value = 1;\nconst next = 2;",
      revision: "f2",
      epoch: 1,
    });
    expect(growing.snapshot.blocks[0].id).toBe(introId);
    expect(growing.snapshot.stream).toMatchObject({ kind: "streaming", tail_source_start: fenceStart });

    const closed = parser.update({
      source: "Intro\n\n```ts\nconst value = 1;\nconst next = 2;\n```\n\nAfter",
      revision: "f3",
      epoch: 1,
    });
    expect(closed.snapshot.stream).toMatchObject({ kind: "streaming", prefix_block_count: 2 });
    expect(blockTexts(closed.snapshot)).toEqual(["Intro", "const value = 1;\nconst next = 2;", "After"]);
    expect(closed.snapshot.blocks[1].kind).toBe("code");
  });

  it.each([
    ["display math", "$$\na + b"],
    ["list", "- one\n- two"],
    ["blockquote", "> quote\n> continues"],
    ["table", "| A | B |\n|---|---|\n| 1 | 2 |"],
    ["HTML-like text", "<section>\ncontent"],
    ["inline delimiter", "Paragraph with **open"],
    ["nested", "> - item\n>   - nested\n>     `open"],
  ])("keeps the final %s root in the mutable tail", (_, tail) => {
    const source = `Stable\n\n${tail}`;
    const result = new StreamingTailParser(options).update({ source, revision: `path-${tail.length}`, epoch: 1 });
    expect(result.snapshot.stream).toMatchObject({
      kind: "streaming",
      prefix_block_count: 1,
      tail_block_start: 1,
      tail_source_start: "Stable\n\n".length,
      tail_complete: false,
    });
    expect(blockTexts(result.snapshot)[0]).toBe("Stable");
  });

  it("requires a new epoch for correction and discards stale epoch work", () => {
    const parser = new StreamingTailParser(options);
    parser.update({ source: "Alpha\n\nOld", revision: "r1", epoch: 2 });
    expect(() => parser.update({ source: "Alpha\n\nNew", revision: "r2", epoch: 2 }))
      .toThrow(/requires a new epoch/u);
    const corrected = parser.update({ source: "Alpha\n\nNew", revision: "r3", epoch: 3 });
    expect(corrected.diagnostics).toMatchObject({ epoch: 3, parsedSourceStart: 0, reusedPrefixBlocks: 0 });
    expect(() => parser.update({ source: "stale", revision: "r4", epoch: 2 }))
      .toThrow(StreamingTailParserStaleEpochError);
  });

  it("converges atomically to the same canonical semantics as a one-shot full parse", () => {
    const chunks = [
      "# Heading\n\nParagraph with **bold**.\n\n",
      "- one\n- two\n\n```ts\nconst x = 1;\n",
      "```\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n![alt](a.png)",
    ];
    const parser = new StreamingTailParser(options);
    let source = "";
    chunks.forEach((chunk, index) => {
      source += chunk;
      parser.update({ source, revision: `stream-${index}`, epoch: 1 });
    });
    const final = parser.update({ source, revision: "canonical-final", epoch: 1, final: true }).snapshot;
    const expected = parseCanonicalMarkdownSnapshot({
      surface: options.surface,
      documentId: options.documentId,
      revision: "canonical-final",
      source,
      rendererProfile: options.rendererProfile,
    });

    expect(final.mode).toBe("canonical");
    expect(final.stream).toEqual({ kind: "canonical", finalized: true });
    expect(semanticSignature(final)).toEqual(semanticSignature(expected));
  });

  it("bounds cumulative parsed characters for a 1 MiB append-only stream", () => {
    const unit = "Paragraph with **bold**, `code`, and [link](README.md).\n\n";
    const source = unit.repeat(Math.ceil(1_048_576 / unit.length)).slice(0, 1_048_576);
    const parser = new StreamingTailParser(options);
    const step = 65_536;
    let parsedCharacters = 0;
    let updates = 0;
    for (let end = step; end <= source.length; end += step) {
      const result = parser.update({ source: source.slice(0, end), revision: `large-${end}`, epoch: 1 });
      parsedCharacters += result.diagnostics.parsedCharacters;
      updates += 1;
    }
    if (parser.currentSource().length < source.length) {
      const result = parser.update({ source, revision: "large-tail", epoch: 1 });
      parsedCharacters += result.diagnostics.parsedCharacters;
      updates += 1;
    }

    const naiveFullParseCharacters = Array.from({ length: updates }, (_, index) => Math.min(source.length, (index + 1) * step))
      .reduce((total, value) => total + value, 0);
    expect(parser.current()?.source_characters).toBe(1_048_576);
    expect(parsedCharacters).toBeLessThan(1_300_000);
    expect(parsedCharacters).toBeLessThan(naiveFullParseCharacters / 5);
  });

  it("repairs only a display projection of unclosed fence and math tails", () => {
    const fence = "```ts\nconst x = 1";
    const math = "$$\na+b";
    expect(repairStreamingMarkdownTail(fence)).toBe("```ts\nconst x = 1\n```");
    expect(repairStreamingMarkdownTail(math)).toBe("$$\na+b\n$$");
    expect(fence).toBe("```ts\nconst x = 1");
    expect(math).toBe("$$\na+b");
  });
});

function blockTexts(snapshot: MarkdownSnapshot): string[] {
  return snapshot.blocks.map((block) => snapshot.logical_text.slice(block.logical_start, block.logical_end));
}

function semanticSignature(snapshot: MarkdownSnapshot) {
  return {
    sourceCharacters: snapshot.source_characters,
    logicalText: snapshot.logical_text,
    blocks: snapshot.blocks.map((block) => ({
      kind: block.kind,
      sourceStart: block.source_start,
      sourceEnd: block.source_end,
      logicalStart: block.logical_start,
      logicalEnd: block.logical_end,
      lineStart: block.line_start,
      lineEnd: block.line_end,
      metadata: block.metadata,
      text: snapshot.logical_text.slice(block.logical_start, block.logical_end),
    })),
    outline: snapshot.outline.map((entry) => ({ level: entry.level, title: entry.title, sourceLine: entry.source_line })),
    resources: snapshot.resources.map((resource) => ({
      kind: resource.kind,
      sourceStart: resource.source_start,
      sourceEnd: resource.source_end,
      logicalStart: resource.logical_start,
      logicalEnd: resource.logical_end,
      url: resource.url,
      alt: resource.alt,
    })),
  };
}
