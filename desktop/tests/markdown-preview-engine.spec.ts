import { describe, expect, it } from "vitest";

import {
  buildMarkdownAnnotationIndex,
  buildMarkdownDocumentModel,
  buildMarkdownFindIndex,
  createMarkdownLineMap,
  markdownSourceRangeFromDomRange,
  MarkdownDocumentModelCache,
  markdownLineColumnAtOffset,
  markdownRangeForLineSpan,
  markdownPreviewContentHash,
  markdownSelectionAnchorFromDomRange,
  parseMarkdownTokens,
  sourceRangeForAnnotation,
  sourceRangeForFindMatch,
  sourceRangeForOutlineItem,
} from "@/renderer/components/workspace/markdownPreviewEngine";
import {
  createSourceRangeAnchor,
  sourceLineColumnAtOffset,
} from "@/renderer/components/workspace/filePreviewAnnotations";
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

    expect(markdownLineColumnAtOffset(markdownPreviewLineEndingsLfFixture, lfTarget)).toEqual(
      sourceLineColumnAtOffset(markdownPreviewLineEndingsLfFixture, lfTarget),
    );
    expect(markdownLineColumnAtOffset(markdownPreviewLineEndingsCrLfFixture, crlfTarget)).toEqual(
      sourceLineColumnAtOffset(markdownPreviewLineEndingsCrLfFixture, crlfTarget),
    );

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

  it("maps valid, cross-block, stale, and unsupported annotations into block-local ranges", () => {
    const source = ["# Notes", "", "alpha target", "", "beta target", ""].join("\n");
    const model = buildMarkdownDocumentModel(source);
    const alphaStart = source.indexOf("alpha");
    const betaEnd = source.indexOf("target", source.indexOf("beta")) + "target".length;
    const validAnchor = createSourceRangeAnchor(source, alphaStart, alphaStart + "alpha".length, "preview");
    const crossBlockAnchor = createSourceRangeAnchor(source, alphaStart, betaEnd, "preview", "alpha target beta target");
    const staleAnchor = { ...validAnchor, contentHash: "stale" };

    const index = buildMarkdownAnnotationIndex(model, [
      { anchor_json: validAnchor, anchor_type: "selection", id: "ann-valid" },
      { anchor_json: crossBlockAnchor, anchor_type: "selection", id: "ann-cross" },
      { anchor_json: staleAnchor, anchor_type: "selection", id: "ann-stale" },
      { anchor_json: null, anchor_type: "file", id: "ann-file" },
    ]);

    expect(index.find((item) => item.annotation.id === "ann-valid")).toMatchObject({
      status: "valid",
      ranges: [{ blockIndex: 1, blockLocalStart: 0, blockLocalEnd: 5 }],
    });
    expect(index.find((item) => item.annotation.id === "ann-cross")?.ranges.map((range) => range.blockIndex)).toEqual([
      1,
      2,
    ]);
    expect(index.find((item) => item.annotation.id === "ann-stale")).toMatchObject({
      reason: "content-hash-mismatch",
      status: "content-hash-mismatch",
    });
    expect(index.find((item) => item.annotation.id === "ann-file")).toMatchObject({
      reason: "unsupported",
      status: "unsupported",
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

  it("maps outline annotation and find active states to source ranges for split sync", () => {
    const source = ["# Guide", "", "alpha target", "", "## Setup", "", "beta target", ""].join("\n");
    const model = buildMarkdownDocumentModel(source);
    const alphaStart = source.indexOf("alpha");
    const annotationIndex = buildMarkdownAnnotationIndex(model, [
      {
        anchor_json: createSourceRangeAnchor(source, alphaStart, alphaStart + "alpha".length, "preview"),
        anchor_type: "selection",
        id: "ann-alpha",
      },
    ]);
    const findIndex = buildMarkdownFindIndex(model, "beta");
    const setup = model.outline.find((item) => item.title === "Setup");

    expect(sourceRangeForOutlineItem(model, setup?.id ?? "")).toMatchObject({
      lineStart: 5,
      sourceStart: source.indexOf("## Setup"),
    });
    expect(sourceRangeForAnnotation(annotationIndex, "ann-alpha")).toMatchObject({
      lineStart: 3,
      sourceStart: alphaStart,
      sourceEnd: alphaStart + "alpha".length,
    });
    expect(sourceRangeForFindMatch(findIndex, findIndex.matches[0].id)).toMatchObject({
      lineStart: 7,
      sourceStart: source.indexOf("beta"),
      sourceEnd: source.indexOf("beta") + "beta".length,
    });
    expect(sourceRangeForAnnotation(annotationIndex, "missing")).toBeNull();
    expect(sourceRangeForFindMatch(findIndex, "missing")).toBeNull();
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

  it("creates annotation anchors from visible DOM selections and rejects mismatched source text", () => {
    const source = "alpha beta";
    const boundary = document.createElement("div");
    const segment = sourceSegment("alpha beta", 0, source.length);
    boundary.append(segment);
    document.body.appendChild(boundary);

    const range = document.createRange();
    range.setStart(segment.firstChild as Text, "alpha ".length);
    range.setEnd(segment.firstChild as Text, "alpha beta".length);
    const result = markdownSelectionAnchorFromDomRange(source, range, boundary);
    expect(result.reason).toBeNull();
    expect(result.anchor).toMatchObject({
      kind: "source-range",
      selectedText: "beta",
      sourceStart: source.indexOf("beta"),
      sourceText: "beta",
      version: 2,
    });

    segment.textContent = "rendered beta";
    const mismatchRange = document.createRange();
    mismatchRange.setStart(segment.firstChild as Text, "rendered ".length);
    mismatchRange.setEnd(segment.firstChild as Text, "rendered beta".length);
    expect(markdownSelectionAnchorFromDomRange(source, mismatchRange, boundary)).toMatchObject({
      anchor: null,
      reason: "source-text-mismatch",
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
