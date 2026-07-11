import { describe, expect, it } from "vitest";

import {
  buildMarkdownDocumentModel,
  buildMarkdownFindIndex,
  createMarkdownLineMap,
  markdownSourceRangeFromDomRange,
  MarkdownDocumentModelCache,
  markdownLineColumnAtOffset,
  markdownRangeForLineSpan,
  markdownPreviewContentHash,
  parseMarkdownTokens,
  sourceRangeForFindMatch,
  sourceRangeForOutlineItem,
} from "@/renderer/components/workspace/markdownPreviewEngine";
import {
  createLargeMarkdownPreviewFixture,
  E2E_MARKDOWN_PREVIEW_ENGINE_PREFIX,
  markdownPreviewLineEndingsCrLfFixture,
  markdownPreviewLineEndingsLfFixture,
  markdownPreviewRendererParityFixture,
} from "./fixtures/markdownPreviewEngine";

describe("markdown preview engine", () => {
  it("exposes a markdown-it token adapter without enabling raw HTML execution", () => {
    const tokens = parseMarkdownTokens(markdownPreviewRendererParityFixture);

    expect(tokens.some((token) => token.type === "heading_open")).toBe(true);
    expect(tokens.some((token) => token.type === "fence" && token.info.trim() === "ts")).toBe(true);
    expect(tokens.some((token) => token.type === "table_open")).toBe(true);
    expect(tokens.some((token) => token.type === "html_block")).toBe(false);
    expect(tokens.map((token) => token.content).join("\n")).toContain(
      "window.__markdownPreviewUnsafeHtmlExecuted",
    );
  });

  it("builds a document model with stable top-level blocks and outline entries", () => {
    const model = buildMarkdownDocumentModel(markdownPreviewRendererParityFixture, {
      idPrefix: E2E_MARKDOWN_PREVIEW_ENGINE_PREFIX,
    });

    expect(model.version).toBe(1);
    expect(model.source).toBe(markdownPreviewRendererParityFixture);
    expect(model.blocks.length).toBeGreaterThan(10);
    expect(model.blocks[0]).toMatchObject({
      id: `${E2E_MARKDOWN_PREVIEW_ENGINE_PREFIX}-block-heading-${markdownPreviewContentHash("heading\n# E2E Large Markdown Title\n")}-1`,
      lineStart: 1,
      sourceStart: 0,
      textContent: "E2E Large Markdown Title",
      type: "heading",
    });
    expect(model.blocks.some((block) => block.type === "table" && block.textContent.includes("Table Cell Unique Target"))).toBe(true);
    expect(model.blocks.some((block) => block.type === "fence" && block.metadata.language === "mermaid")).toBe(true);
    expect(model.outline.map((item) => item.title)).toContain("E2E Large Markdown Title");
    expect(model.outline.map((item) => item.title)).toContain("Tail Section");
  });

  it("keeps unchanged block ids stable across local edits and caches by content hash", () => {
    const before = ["# Title", "", "Alpha block", "", "Stable target block", ""].join("\n");
    const after = ["# Title", "", "Alpha block edited", "", "Stable target block", ""].join("\n");
    const beforeModel = buildMarkdownDocumentModel(before);
    const afterModel = buildMarkdownDocumentModel(after);
    const beforeStableBlock = beforeModel.blocks.find((block) => block.textContent === "Stable target block");
    const afterStableBlock = afterModel.blocks.find((block) => block.textContent === "Stable target block");

    expect(afterStableBlock?.id).toBe(beforeStableBlock?.id);

    const cache = new MarkdownDocumentModelCache(2);
    const first = cache.getOrCreate({ cacheKey: "README.md", source: before });
    const second = cache.getOrCreate({ cacheKey: "README.md", source: before });
    const changed = cache.getOrCreate({ cacheKey: "README.md", source: after });
    expect(second).toBe(first);
    expect(changed).not.toBe(first);
    expect(cache.size).toBe(2);
  });

  it("keeps source ranges in original JS string offsets for LF and CRLF content", () => {
    const lfTarget = markdownPreviewLineEndingsLfFixture.indexOf("three");
    const crlfTarget = markdownPreviewLineEndingsCrLfFixture.indexOf("three");

    expect(markdownLineColumnAtOffset(markdownPreviewLineEndingsLfFixture, lfTarget).line).toBe(5);
    expect(markdownLineColumnAtOffset(markdownPreviewLineEndingsCrLfFixture, crlfTarget).line).toBe(5);

    const lfModel = buildMarkdownDocumentModel(markdownPreviewLineEndingsLfFixture);
    const crlfModel = buildMarkdownDocumentModel(markdownPreviewLineEndingsCrLfFixture);
    expect(lfModel.blocks.at(-1)?.sourceText).toBe("three target\n");
    expect(crlfModel.blocks.at(-1)?.sourceText).toBe("three target\r\n");
  });

  it("maps markdown-it line spans back to source slices without normalizing line endings", () => {
    const source = ["# A", "", "paragraph one", "paragraph two", ""].join("\r\n");
    const lineMap = createMarkdownLineMap(source);
    const range = markdownRangeForLineSpan(source, lineMap, 2, 4);

    expect(range).toMatchObject({
      lineStart: 3,
      lineEnd: 4,
      sourceStart: source.indexOf("paragraph one"),
    });
    expect(source.slice(range.sourceStart, range.sourceEnd)).toBe("paragraph one\r\nparagraph two\r\n");
  });

  it("provides a shared large fixture with every required markdown preview anchor", () => {
    const large = createLargeMarkdownPreviewFixture(16);

    expect(large).toContain(E2E_MARKDOWN_PREVIEW_ENGINE_PREFIX);
    expect(large).toContain("中文段落");
    expect(large).toContain("Table Cell Unique Target");
    expect(large).toContain("const quoteCodeSelection = true;");
    expect(large).toContain("```mermaid");
    expect(large).toContain("![Workspace Image]");
    expect(large).toContain("tail-search-target");
    expect(buildMarkdownDocumentModel(large).blocks.length).toBeGreaterThan(60);
  });

  it("builds an outline index for atx and setext headings while ignoring code fences", () => {
    const source = [
      "# Duplicate",
      "",
      "Duplicate",
      "---------",
      "",
      "```md",
      "# Not Outline",
      "```",
      "",
      "## Duplicate",
    ].join("\n");
    const model = buildMarkdownDocumentModel(source);

    expect(model.outline.map((item) => item.title)).toEqual(["Duplicate", "Duplicate", "Duplicate"]);
    expect(model.outline.map((item) => item.level)).toEqual([1, 2, 2]);
    expect(new Set(model.outline.map((item) => item.id)).size).toBe(3);
    expect(model.outline.some((item) => item.title === "Not Outline")).toBe(false);
    expect(model.outline[1]).toMatchObject({
      blockIndex: 1,
      lineStart: 3,
      lineEnd: 4,
    });
  });

  it("builds literal case-insensitive preview find matches with source ranges", () => {
    const source = ["# Find", "", "Alpha target.", "", "中文 Target，alpha target!", ""].join("\n");
    const model = buildMarkdownDocumentModel(source);
    const index = buildMarkdownFindIndex(model, "TARGET");

    expect(index.matches).toHaveLength(3);
    expect(index.matches.map((match) => source.slice(match.sourceStart, match.sourceEnd))).toEqual([
      "target",
      "Target",
      "target",
    ]);
    expect(index.matches[2]).toMatchObject({
      blockIndex: 2,
      matchText: "target",
    });
    expect(index.matches[1].snippet).toContain("中文 Target");
  });

  it("maps DOM selections in visible source segments back to markdown source ranges", () => {
    const source = "alpha beta\n\ngamma delta";
    const boundary = document.createElement("div");
    const alpha = sourceSegment("alpha beta", source.indexOf("alpha"), source.indexOf("alpha") + "alpha beta".length);
    const gamma = sourceSegment("gamma delta", source.indexOf("gamma"), source.indexOf("gamma") + "gamma delta".length);
    boundary.append(alpha, gamma);
    document.body.appendChild(boundary);

    const single = document.createRange();
    single.setStart(alpha.firstChild as Text, "alpha ".length);
    single.setEnd(alpha.firstChild as Text, "alpha beta".length);
    expect(markdownSourceRangeFromDomRange(source, single, boundary)).toMatchObject({
      range: {
        lineStart: 1,
        lineEnd: 1,
        selectedText: "beta",
        sourceStart: source.indexOf("beta"),
        sourceEnd: source.indexOf("beta") + "beta".length,
        sourceText: "beta",
      },
      reason: null,
    });

    const cross = document.createRange();
    cross.setStart(alpha.firstChild as Text, "alpha ".length);
    cross.setEnd(gamma.firstChild as Text, "gamma".length);
    expect(markdownSourceRangeFromDomRange(source, cross, boundary)).toMatchObject({
      range: {
        lineStart: 1,
        lineEnd: 3,
        sourceStart: source.indexOf("beta"),
        sourceEnd: source.indexOf("gamma") + "gamma".length,
        sourceText: "beta\n\ngamma",
      },
      reason: null,
    });

    boundary.remove();
  });

  it("supports legacy preview source attributes and rejects selections without source metadata", () => {
    const source = "legacy target";
    const boundary = document.createElement("div");
    const legacy = document.createElement("span");
    legacy.dataset.previewSourceStart = "0";
    legacy.dataset.previewSourceEnd = String(source.length);
    legacy.textContent = source;
    const plain = document.createElement("span");
    plain.textContent = "plain";
    boundary.append(legacy, plain);
    document.body.appendChild(boundary);

    const legacyRange = document.createRange();
    legacyRange.setStart(legacy.firstChild as Text, 0);
    legacyRange.setEnd(legacy.firstChild as Text, "legacy".length);
    expect(markdownSourceRangeFromDomRange(source, legacyRange, boundary)).toMatchObject({
      range: {
        sourceStart: 0,
        sourceEnd: "legacy".length,
      },
      reason: null,
    });

    const plainRange = document.createRange();
    plainRange.setStart(plain.firstChild as Text, 0);
    plainRange.setEnd(plain.firstChild as Text, "plain".length);
    expect(markdownSourceRangeFromDomRange(source, plainRange, boundary)).toEqual({
      range: null,
      reason: "missing-source-segment",
    });

    boundary.remove();
  });

});

function sourceSegment(text: string, sourceStart: number, sourceEnd: number): HTMLSpanElement {
  const element = document.createElement("span");
  element.dataset.markdownSourceStart = String(sourceStart);
  element.dataset.markdownSourceEnd = String(sourceEnd);
  element.textContent = text;
  return element;
}
