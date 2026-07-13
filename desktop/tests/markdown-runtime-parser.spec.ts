import MarkdownIt from "markdown-it";
import { describe, expect, it, vi } from "vitest";

import {
  MarkdownParserCancelledError,
  parseCanonicalMarkdownSnapshot,
} from "@/renderer/markdownRuntime/worker/parser";
import {
  markdownPreviewLineEndingsCrLfFixture,
  markdownPreviewRendererParityFixture,
} from "./fixtures/markdownRuntimeParity";

function parse(source: string, surface: "file" | "message" = "file") {
  return parseCanonicalMarkdownSnapshot({
    surface,
    documentId: `${surface}:fixture.md`,
    revision: "sha256:fixture",
    source,
    rendererProfile: surface === "file" ? "file-preview" : "conversation",
  });
}

describe("single-pass Markdown Worker parser", () => {
  it("calls markdown-it exactly once and emits no retained token tree", () => {
    const engine = new MarkdownIt({ breaks: true, html: false, linkify: true, typographer: false });
    const parseSpy = vi.spyOn(engine, "parse");
    const diagnostics = vi.fn();

    const snapshot = parseCanonicalMarkdownSnapshot({
      surface: "file",
      documentId: "file:README.md",
      revision: "sha256:single-pass",
      source: markdownPreviewRendererParityFixture,
      rendererProfile: "file-preview",
    }, {
      markdownIt: engine,
      onDiagnostics: diagnostics,
    });

    expect(parseSpy).toHaveBeenCalledTimes(1);
    expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({
      parseCalls: 1,
      blockCount: snapshot.blocks.length,
      resourceCount: snapshot.resources.length,
    }));
    expect(JSON.stringify(snapshot)).not.toMatch(/"tokens"|"token_tree"|"parser"/u);
  });

  it("keeps top-level source ranges and outline deterministic across canonical parses", () => {
    const snapshot = parse(markdownPreviewRendererParityFixture);
    const repeated = parse(markdownPreviewRendererParityFixture);

    expect(snapshot.blocks.map((block) => [block.source_start, block.source_end])).toEqual(
      repeated.blocks.map((block) => [block.source_start, block.source_end]),
    );
    expect(snapshot.outline.map((entry) => entry.title)).toEqual(
      repeated.outline.map((entry) => entry.title),
    );
  });

  it("captures all current special syntax and resources in the Snapshot", () => {
    const snapshot = parse(markdownPreviewRendererParityFixture);
    const kinds = new Set(snapshot.blocks.map((block) => block.kind));

    expect([...kinds]).toEqual(expect.arrayContaining([
      "heading", "paragraph", "list", "table", "code", "mermaid", "math", "html",
    ]));
    expect(snapshot.blocks.find((block) => block.kind === "list")?.metadata).toMatchObject({
      list: { item_count: 2, ordered: false },
      task: { checked: null },
    });
    expect(snapshot.blocks.find((block) => block.kind === "table")?.metadata.table).toMatchObject({
      columns: 3,
    });
    expect(snapshot.resources.filter((resource) => resource.kind === "image")).toHaveLength(2);
    expect(snapshot.resources.filter((resource) => resource.kind === "mermaid")).toHaveLength(2);
    expect(snapshot.resources.some((resource) => resource.kind === "math")).toBe(true);
    expect(snapshot.resources.some((resource) => resource.kind === "html")).toBe(true);
    expect(snapshot.resources.some((resource) => resource.kind === "link"
      && resource.url === "https://example.com/autolink-target")).toBe(true);
    expect(snapshot.blocks.flatMap((block) => block.inline_spans).some((span) => (
      span.kind === "link" && span.attributes.href === "https://example.com/autolink-target"
    ))).toBe(true);
    expect(snapshot.blocks.flatMap((block) => block.inline_spans).some((span) => (
      span.kind === "image" && typeof span.attributes.src === "string"
    ))).toBe(true);
  });

  it("preserves CRLF source offsets and complex Unicode logical text", () => {
    const source = `${markdownPreviewLineEndingsCrLfFixture}\r\n中文 👩🏽‍💻 עברית`;
    const snapshot = parse(source);

    expect(snapshot.blocks.at(-1)).toMatchObject({
      source_start: source.indexOf("中文"),
      source_end: source.length,
    });
    expect(snapshot.logical_text).toContain("中文 👩🏽‍💻 עברית");
    expect(snapshot.source_bytes).toBe(new TextEncoder().encode(source).byteLength);
  });

  it("extracts frontmatter once without overlapping canonical blocks", () => {
    const source = [
      "---",
      "title: Guide",
      "tags: [a, b]",
      "---",
      "# Guide",
      "",
      "Body",
    ].join("\n");
    const snapshot = parse(source);

    expect(snapshot.blocks[0]).toMatchObject({
      kind: "frontmatter",
      source_start: 0,
      metadata: { frontmatter_language: "yaml" },
    });
    expect(snapshot.blocks[1]).toMatchObject({ kind: "heading" });
    expect(snapshot.blocks[0].source_end).toBeLessThanOrEqual(snapshot.blocks[1].source_start);
  });

  it("tolerates malformed Markdown, a giant block, and deep nesting", () => {
    const malformed = "[broken](\n```unknown\nunclosed\n<div><span>\n";
    const nested = `${"> ".repeat(120)}deep target`;
    const giant = "x".repeat(500_000);

    expect(() => parse(malformed)).not.toThrow();
    expect(parse(nested).logical_text).toContain("deep target");
    expect(parse(giant)).toMatchObject({ source_characters: 500_000, blocks: [{ kind: "paragraph" }] });
  });

  it("cancels before parse and at a post-parse checkpoint without publishing a Snapshot", () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => parseCanonicalMarkdownSnapshot({
      surface: "file",
      documentId: "file:cancel.md",
      revision: "r1",
      source: "# Cancel",
      rendererProfile: "file-preview",
    }, { signal: controller.signal })).toThrowError(MarkdownParserCancelledError);

    const engine = new MarkdownIt();
    const parseSpy = vi.spyOn(engine, "parse");
    let checks = 0;
    expect(() => parseCanonicalMarkdownSnapshot({
      surface: "message",
      documentId: "message:cancel",
      revision: "r2",
      source: "# Parsed but obsolete",
      rendererProfile: "conversation",
    }, {
      markdownIt: engine,
      shouldCancel: () => ++checks > 1,
    })).toThrowError(MarkdownParserCancelledError);
    expect(parseSpy).toHaveBeenCalledTimes(1);
  });

  it.each([1024 * 1024, 5 * 1024 * 1024, 10 * 1024 * 1024])(
    "parses a %i-byte single block with bounded retained Snapshot memory",
    (size) => {
      const source = "x".repeat(size);
      const snapshot = parse(source);

      expect(snapshot.source_bytes).toBe(size);
      expect(snapshot.blocks).toHaveLength(1);
      expect(snapshot.blocks[0]).toMatchObject({
        source_start: 0,
        source_end: size,
        logical_start: 0,
        logical_end: size,
      });
      expect(snapshot.estimated_bytes).toBeLessThan(size * 3);
    },
    30_000,
  );
});
