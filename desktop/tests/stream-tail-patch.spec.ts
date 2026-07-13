import { describe, expect, it } from "vitest";

import { parseCanonicalMarkdownSnapshot } from "@/renderer/markdownRuntime/worker/parser";
import {
  StreamingTailParser,
  applyMarkdownStreamTailPatch,
  createMarkdownStreamTailPatch,
} from "@/renderer/markdownRuntime/streaming";

const identity = {
  surface: "message" as const,
  documentId: "message:patch-contract",
  rendererProfile: "conversation" as const,
};

describe("incremental streaming Markdown patch", () => {
  it("transports only the append for a growing MiB plain paragraph", () => {
    const baseSource = "# Title\n\n" + "x".repeat(128 * 1024);
    const base = new StreamingTailParser(identity).update({ source: baseSource, revision: "r1", epoch: 1 }).snapshot;
    const parser = new StreamingTailParser({ ...identity, initialSource: baseSource, initialSnapshot: base, initialEpoch: 1 });
    const append = "中".repeat(1024);
    const result = parser.update({ source: baseSource + append, append, revision: "r2", epoch: 1 });
    const patch = createMarkdownStreamTailPatch(base, result.snapshot, {
      logicalPrefixCharacters: result.logicalPrefixCharacters,
      logicalAppend: result.logicalAppend,
    });

    expect(result.diagnostics.parsedCharacters).toBe(append.length);
    expect(result.logicalPrefixCharacters).toBe(base.logical_text.length);
    expect(patch.logical_append).toBe(append);
    expect(patch.logical_append.length).toBeLessThan(result.snapshot.logical_text.length / 100);
    expect(applyMarkdownStreamTailPatch(base, "r2", patch)).toEqual(result.snapshot);
  });

  it("keeps 1000 append responses bounded instead of retransmitting cumulative text", () => {
    let source = "# Title\n\nx";
    const parser = new StreamingTailParser(identity);
    let workerSnapshot = parser.update({ source, revision: "r0", epoch: 1 }).snapshot;
    let hostSnapshot = workerSnapshot;
    let patchLogicalCharacters = 0;
    let cumulativeSnapshotCharacters = 0;

    for (let index = 1; index <= 1000; index += 1) {
      source += "x";
      const result = parser.update({ source, append: "x", revision: `r${index}`, epoch: 1 });
      const patch = createMarkdownStreamTailPatch(workerSnapshot, result.snapshot, {
        logicalPrefixCharacters: result.logicalPrefixCharacters,
        logicalAppend: result.logicalAppend,
      });
      patchLogicalCharacters += patch.logical_append.length;
      cumulativeSnapshotCharacters += result.snapshot.logical_text.length;
      hostSnapshot = applyMarkdownStreamTailPatch(hostSnapshot, result.snapshot.revision, patch);
      workerSnapshot = result.snapshot;
    }

    expect(patchLogicalCharacters).toBe(1000);
    expect(cumulativeSnapshotCharacters).toBeGreaterThan(500_000);
    expect(patchLogicalCharacters).toBeLessThan(cumulativeSnapshotCharacters / 500);
    expect(hostSnapshot).toEqual(workerSnapshot);
    expect(hostSnapshot.logical_text).toBe("Title\n" + "x".repeat(1001));
  });

  it("replaces semantic tail content and preserves Unicode surrogate pairs", () => {
    const base = parseCanonicalMarkdownSnapshot({ ...identity, revision: "base", source: "Alpha 😀", });
    const next = parseCanonicalMarkdownSnapshot({ ...identity, revision: "next", source: "Alpha 😀 **bold**", });
    const patch = createMarkdownStreamTailPatch(base, next);
    const restored = applyMarkdownStreamTailPatch(base, "next", patch);

    expect(restored.logical_text).toBe(next.logical_text);
    expect(restored.blocks).toEqual(next.blocks);
    expect(patch.logical_prefix_characters === 0
      || !/[\uD800-\uDBFF]/u.test(base.logical_text.charAt(patch.logical_prefix_characters - 1))).toBe(true);
  });

  it("rejects a stale base revision instead of corrupting the current document", () => {
    const base = parseCanonicalMarkdownSnapshot({ ...identity, revision: "base", source: "Alpha" });
    const next = parseCanonicalMarkdownSnapshot({ ...identity, revision: "next", source: "Alpha Beta" });
    const patch = createMarkdownStreamTailPatch(base, next);
    const stale = { ...base, revision: "other" };

    expect(() => applyMarkdownStreamTailPatch(stale, "next", patch)).toThrow(/requires base base/);
  });

  it("leaves the plain append fast path when Markdown syntax can change semantics", () => {
    const firstSource = "plain";
    const first = new StreamingTailParser(identity).update({ source: firstSource, revision: "r1", epoch: 1 }).snapshot;
    const parser = new StreamingTailParser({ ...identity, initialSource: firstSource, initialSnapshot: first, initialEpoch: 1 });
    const append = " **bold**";
    const result = parser.update({ source: firstSource + append, append, revision: "r2", epoch: 1 });

    expect(result.logicalPrefixCharacters).toBeUndefined();
    expect(result.snapshot.logical_text).toContain("bold");
    expect(result.snapshot.blocks[0].inline_spans.some((span) => span.kind === "strong")).toBe(true);
  });
});
