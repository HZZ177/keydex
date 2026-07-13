import { describe, expect, it } from "vitest";

import {
  MARKDOWN_SNAPSHOT_CODEC_SELECTION,
  MarkdownSnapshotCodecCancelledError,
  decodeMarkdownSnapshotCandidate,
  decodeSelectedMarkdownSnapshot,
  encodeMarkdownSnapshotCandidate,
  encodeSelectedMarkdownSnapshot,
  isMarkdownSnapshotCodecBenchmarkCurrent,
  type MarkdownSnapshotCodecCandidate,
} from "@/renderer/markdownRuntime/worker/codec";
import { parseCanonicalMarkdownSnapshot } from "@/renderer/markdownRuntime/worker/parser";

const codecs: readonly MarkdownSnapshotCodecCandidate[] = [
  "structured-clone",
  "json-transferable",
  "columnar-transferable",
];

function snapshot(source: string) {
  return parseCanonicalMarkdownSnapshot({
    surface: "file",
    documentId: "file:codec.md",
    revision: `revision:${source.length}`,
    source,
    rendererProfile: "file-preview",
  });
}

describe("Markdown Worker Snapshot codec selection", () => {
  it.each(codecs)("round-trips mixed syntax through %s", (codec) => {
    const value = snapshot([
      "# Codec",
      "",
      "Paragraph with [link](https://example.com) and ![image](image.png).",
      "",
      "- one",
      "- two",
      "",
      "```mermaid",
      "graph TD; A-->B",
      "```",
    ].join("\n"));
    const encoded = encodeMarkdownSnapshotCandidate(value, codec);
    const decoded = decodeMarkdownSnapshotCandidate(encoded.wire);

    expect(decoded).toEqual(value);
    expect(decoded.blocks.map((block) => block.id)).toEqual(value.blocks.map((block) => block.id));
    expect(decoded.resources).toEqual(value.resources);
    expect(encoded.transfer).toHaveLength(codec === "structured-clone" ? 0 : codec === "json-transferable" ? 1 : 6);
  });

  it.each(codecs)("handles a 1 MiB single block through %s", (codec) => {
    const value = snapshot("x".repeat(1024 * 1024));
    const encoded = encodeMarkdownSnapshotCandidate(value, codec);
    const decoded = decodeMarkdownSnapshotCandidate(encoded.wire);

    expect(decoded.source_bytes).toBe(1024 * 1024);
    expect(decoded.blocks).toHaveLength(1);
    expect(decoded.logical_text).toHaveLength(1024 * 1024);
  }, 20_000);

  it("keeps the production protocol on raw structured clone", () => {
    const value = snapshot("# Selected");
    const encoded = encodeSelectedMarkdownSnapshot(value);

    expect(MARKDOWN_SNAPSHOT_CODEC_SELECTION).toBe("structured-clone/v1");
    expect(encoded.payload).toBe(value);
    expect(encoded.transfer).toEqual([]);
    expect(decodeSelectedMarkdownSnapshot(structuredClone(encoded.payload))).toEqual(value);
    expect(isMarkdownSnapshotCodecBenchmarkCurrent("150.0.0.0")).toBe(true);
    expect(isMarkdownSnapshotCodecBenchmarkCurrent("149.0.0.0")).toBe(false);
    expect(isMarkdownSnapshotCodecBenchmarkCurrent("151.0.0.0")).toBe(false);
    expect(isMarkdownSnapshotCodecBenchmarkCurrent("unknown")).toBe(false);
  });

  it("rejects cancellation and non-contract renderer fields", () => {
    const value = snapshot("# Cancel");
    const controller = new AbortController();
    controller.abort();

    expect(() => encodeMarkdownSnapshotCandidate(value, "json-transferable", controller.signal))
      .toThrowError(MarkdownSnapshotCodecCancelledError);
    const encoded = encodeMarkdownSnapshotCandidate(value, "json-transferable");
    expect(() => decodeMarkdownSnapshotCandidate(encoded.wire, controller.signal))
      .toThrowError(MarkdownSnapshotCodecCancelledError);

    const invalid = structuredClone(value) as typeof value & { dom?: object };
    invalid.dom = {};
    expect(() => encodeMarkdownSnapshotCandidate(invalid, "structured-clone")).toThrow();
  });
});
