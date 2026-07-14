import { describe, expect, it, vi } from "vitest";

import { MarkdownHeightIndex } from "@/renderer/markdownRuntime/layout/HeightIndex";
import { MarkdownPositionMapper } from "@/renderer/markdownRuntime/mapping";
import { FILE_MARKDOWN_RENDERER_PROFILE } from "@/renderer/markdownRuntime/renderers";
import { DocumentViewRuntime } from "@/renderer/markdownRuntime/view/DocumentViewRuntime";
import { parseCanonicalMarkdownSnapshot } from "@/renderer/markdownRuntime/worker/parser";

const SOURCE = [
  "# 标题 👩‍💻 e\u0301",
  "",
  "<!-- source comment -->",
  "",
  "- repeat repeat",
  "- repeat",
  "",
  "```ts",
  "const emoji = \"😀\";",
  "```",
  "",
  "Tail repeat.",
].join("\n");

function parse(source = SOURCE) {
  return parseCanonicalMarkdownSnapshot({
    surface: "file",
    documentId: "file:mapping.md",
    revision: "r1",
    source,
    rendererProfile: "file-preview",
  });
}

function unmounted(source = SOURCE) {
  const snapshot = parse(source);
  const heightIndex = new MarkdownHeightIndex(snapshot.revision, snapshot.blocks.map((_, index) => 40 + index));
  return { snapshot, heightIndex, mapper: new MarkdownPositionMapper(source, snapshot, { heightIndex }) };
}

function mounted() {
  const snapshot = parse();
  const host = document.createElement("div");
  document.body.append(host);
  const runtime = new DocumentViewRuntime(host, {
    profile: FILE_MARKDOWN_RENDERER_PROFILE,
    interactions: { onCodeCopy: vi.fn() },
    viewport: { defaultOverscanPx: 0 },
  });
  const heights = snapshot.blocks.map(() => 100);
  runtime.publish(snapshot, heights, { scrollTop: 0, viewportHeight: 10_000 });
  const mapper = new MarkdownPositionMapper(SOURCE, snapshot, {
    heightIndex: new MarkdownHeightIndex(snapshot.revision, heights),
    mounted: runtime,
  });
  return { snapshot, host, runtime, mapper };
}

describe("Markdown Source/Logical/Block mapping", () => {
  it("maps heading and fence markers to stable block boundaries without pretending glyph precision", () => {
    const { snapshot, mapper } = unmounted();
    const heading = mapper.sourceOffset(0);
    const fenceStart = SOURCE.indexOf("```ts");
    const fenceEnd = SOURCE.indexOf("```", fenceStart + 3);
    const codeBlock = snapshot.blocks.find((block) => block.kind === "code")!;

    expect(heading).toMatchObject({
      status: "estimated",
      blockId: snapshot.blocks[0].id,
      logicalOffset: snapshot.blocks[0].logical_start,
      blockLocalLogicalOffset: 0,
      affinity: "inside",
      estimatedY: 0,
      reason: "block-not-mounted",
    });
    expect(mapper.sourceOffset(fenceStart)).toMatchObject({ blockId: codeBlock.id, logicalOffset: codeBlock.logical_start });
    expect(mapper.sourceOffset(fenceEnd + 2)).toMatchObject({ blockId: codeBlock.id, logicalOffset: codeBlock.logical_end });
  });

  it("uses a deterministic next-block affinity for empty source-only lines and comments", () => {
    const { snapshot, mapper } = unmounted();
    const blankLine = mapper.sourceLine(2);
    const commentLine = mapper.sourceLine(3);

    expect(blankLine).toMatchObject({
      affinity: "next-block",
      blockId: snapshot.blocks[1].id,
      blockLocalLogicalOffset: 0,
    });
    expect(commentLine).toMatchObject({ affinity: "inside", blockId: snapshot.blocks[1].id });
  });

  it("round-trips repeated text by structural spans rather than a document-wide text search", () => {
    const { mapper } = unmounted();
    const first = SOURCE.indexOf("repeat");
    const second = SOURCE.indexOf("repeat", first + 1);
    const third = SOURCE.indexOf("repeat", second + 1);
    const positions = [first, second, third].map((offset) => mapper.sourceOffset(offset));

    expect(positions.map((position) => position.sourceOffset)).toEqual([first, second, third]);
    expect(positions[0].logicalOffset).not.toBe(positions[1].logicalOffset);
    expect(positions[1].logicalOffset).not.toBe(positions[2].logicalOffset);
    for (const position of positions) {
      expect(mapper.logicalOffset(position.logicalOffset!).sourceOffset).toBe(position.sourceOffset);
    }
  });

  it("preserves UTF-16 offsets for Chinese, emoji ZWJ sequences, and combining characters", () => {
    const { mapper } = unmounted();
    for (const value of ["标题", "👩‍💻", "e\u0301", "😀"]) {
      const sourceOffset = SOURCE.indexOf(value);
      const mapped = mapper.sourceOffset(sourceOffset);
      expect(mapped.sourceOffset).toBe(sourceOffset);
      expect(mapper.logicalOffset(mapped.logicalOffset!).sourceOffset).toBe(sourceOffset);
    }
  });

  it("handles CRLF line/column and source-only line boundaries", () => {
    const source = "# One\r\n\r\nTwo 😀\r\n\r\nThree";
    const { mapper, snapshot } = unmounted(source);

    expect(mapper.sourceLine(1, 3)).toMatchObject({ sourceLine: 1, sourceColumn: 3, blockId: snapshot.blocks[0].id });
    expect(mapper.sourceLine(2)).toMatchObject({ sourceLine: 2, sourceColumn: 1, affinity: "next-block" });
    expect(mapper.sourceLine(3, 5)).toMatchObject({ sourceLine: 3, sourceColumn: 5, blockId: snapshot.blocks[1].id });
  });

  it("returns explicit failures for invalid input and an empty document", () => {
    const { mapper } = unmounted();
    expect(mapper.sourceOffset(-1)).toMatchObject({ status: "unmapped", reason: "source-out-of-range" });
    expect(mapper.logicalOffset(Number.NaN)).toMatchObject({ status: "unmapped", reason: "logical-out-of-range" });
    expect(mapper.sourceLine(0)).toMatchObject({ status: "unmapped", reason: "line-out-of-range" });

    const emptySnapshot = parse("");
    expect(new MarkdownPositionMapper("", emptySnapshot).sourceOffset(0))
      .toMatchObject({ status: "unmapped", reason: "empty-document" });
  });
});

describe("Markdown mounted DOM-local mapping", () => {
  it("returns a local DOM Range and rect only after the target block is mounted", () => {
    const run = mounted();
    const sourceOffset = SOURCE.indexOf("标题") + 1;
    const mapped = run.mapper.sourceOffset(sourceOffset);

    expect(mapped).toMatchObject({ status: "exact", sourceOffset, reason: null });
    expect(mapped.dom?.range.collapsed).toBe(true);
    expect(mapped.dom?.node).toBeInstanceOf(Text);
    expect(mapped.dom?.localX).toBeTypeOf("number");
    run.runtime.destroy();
    run.host.remove();
  });

  it("maps a mounted DOM text position back to its exact source occurrence", () => {
    const run = mounted();
    const listBlock = run.snapshot.blocks.find((block) => block.kind === "list")!;
    const root = run.runtime.getBlockElement(listBlock.id)!;
    const text = root.querySelector("li [data-markdown-list-content]")!.firstChild as Text;
    const domOffset = text.data.indexOf("repeat") + 2;
    const mapped = run.mapper.domPosition(text, domOffset);

    expect(mapped).toMatchObject({ status: "exact", blockId: listBlock.id });
    expect(SOURCE.slice(mapped.sourceOffset!, mapped.sourceOffset! + 4)).toBe("peat");
    run.runtime.destroy();
    run.host.remove();
  });

  it("maps a rendered list marker to the zero-width start of its list item", () => {
    const run = mounted();
    const listBlock = run.snapshot.blocks.find((block) => block.kind === "list")!;
    const firstItem = listBlock.metadata.list?.items?.[0]!;
    const root = run.runtime.getBlockElement(listBlock.id)!;
    const markerText = root.querySelector<HTMLElement>("[data-markdown-list-marker]")!.firstChild as Text;

    const mapped = run.mapper.domPosition(markerText, 1);

    expect(mapped).toMatchObject({
      status: "exact",
      blockId: listBlock.id,
      logicalOffset: listBlock.logical_start + firstItem.logical_start,
    });
    run.runtime.destroy();
    run.host.remove();
  });

  it("creates an exact cross-block selection Range when both endpoints are mounted", () => {
    const run = mounted();
    const start = SOURCE.indexOf("标题");
    const end = SOURCE.indexOf("repeat") + "repeat".length;
    const mapped = run.mapper.sourceRange(start, end);

    expect(mapped).toMatchObject({ status: "exact", reason: null });
    expect(mapped.start.blockId).not.toBe(mapped.end.blockId);
    expect(mapped.range?.collapsed).toBe(false);
    run.runtime.destroy();
    run.host.remove();
  });

  it("keeps unmounted ranges estimated and rejects renderer UI as non-semantic", () => {
    const unmountedRun = unmounted();
    expect(unmountedRun.mapper.sourceRange(SOURCE.indexOf("标题"), SOURCE.indexOf("Tail")))
      .toMatchObject({ status: "estimated", reason: "block-not-mounted", range: null });

    const run = mounted();
    const buttonText = run.host.querySelector<HTMLElement>("[data-markdown-code-copy]")!.firstChild!;
    expect(run.mapper.domPosition(buttonText, 1))
      .toMatchObject({ status: "unmapped", reason: "dom-position-not-semantic" });
    run.runtime.destroy();
    run.host.remove();
  });
});

describe("Markdown mapping contract validation", () => {
  it("rejects mismatched source and HeightIndex revisions", () => {
    const snapshot = parse();
    expect(() => new MarkdownPositionMapper(`${SOURCE}!`, snapshot)).toThrow(/source length/u);
    expect(() => new MarkdownPositionMapper(SOURCE, snapshot, {
      heightIndex: new MarkdownHeightIndex("other", snapshot.blocks.map(() => 10)),
    })).toThrow(/does not match/u);
  });
});
