import { describe, expect, it } from "vitest";

import {
  KEYDEX_ALIGNED_DIFF_MODEL_VERSION,
  KeydexAlignedDiffModelError,
  createAlignedDiffStableId,
  createKeydexAlignedDiffModel,
  type DiffAlignmentSegment,
  type DiffPaneRow,
} from "@/renderer/components/diff/aligned/alignedDiffModel";

const range = (startRow: number, endRow: number, startLine: number | null, endLine: number | null) => ({
  startRow,
  endRow,
  startLine,
  endLine,
});

function row(side: "old" | "new", id: string, segmentId: string, lineNumber = 1): DiffPaneRow {
  return {
    id,
    fileId: "file:one",
    side,
    kind: side === "old" ? "removed" : "added",
    lineNumber,
    sourceIndex: 0,
    segmentId,
    changeId: "change:one",
    hunkId: "hunk:one",
    text: side,
    tokens: [{ type: "span", classNames: ["token-keyword"], children: [{ type: "text", value: side }] }],
    noTrailingNewline: false,
    estimatedHeight: 20,
  };
}

function modelInput() {
  const segment: DiffAlignmentSegment = {
    id: "segment:one",
    kind: "change",
    left: range(0, 1, 1, 1),
    right: range(0, 1, 1, 1),
    hunkId: "hunk:one",
    changeId: "change:one",
  };
  return {
    fileId: "file:one",
    fileCacheKey: "cache:one",
    sourceVersion: "source:v1",
    cacheKey: "aligned:cache:v1",
    partial: false,
    leftRows: [row("old", "row:old", segment.id)],
    rightRows: [row("new", "row:new", segment.id)],
    segments: [segment],
    changes: [{
      id: "change:one",
      segmentId: segment.id,
      kind: "modified" as const,
      left: segment.left,
      right: segment.right,
    }],
  };
}

describe("aligned Diff domain model", () => {
  it("creates an immutable Pierre-free model with stable identities", () => {
    const first = createKeydexAlignedDiffModel(modelInput());
    const second = createKeydexAlignedDiffModel(modelInput());

    expect(first).toEqual(second);
    expect(first.modelVersion).toBe(KEYDEX_ALIGNED_DIFF_MODEL_VERSION);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.leftRows)).toBe(true);
    expect(Object.isFrozen(first.leftRows[0]?.tokens[0])).toBe(true);
    expect(JSON.stringify(first)).not.toMatch(/Pierre|HAST|FileDiffMetadata/u);
  });

  it("keeps IDs stable for a rebuild and invalidates them with cache identity", () => {
    expect(createAlignedDiffStableId("row", "cache:v1", 3, "old:8")).toBe(
      createAlignedDiffStableId("row", "cache:v1", 3, "old:8"),
    );
    expect(createAlignedDiffStableId("row", "cache:v1", 3, "old:8")).not.toBe(
      createAlignedDiffStableId("row", "cache:v2", 3, "old:8"),
    );
    expect(createAlignedDiffStableId("segment", "cache:v1", 3, "old:8")).not.toBe(
      createAlignedDiffStableId("change", "cache:v1", 3, "old:8"),
    );
  });

  it("expresses a zero-width side for a pure addition", () => {
    const input = modelInput();
    const segment = {
      ...input.segments[0]!,
      left: range(0, 0, null, null),
    };
    const model = createKeydexAlignedDiffModel({
      ...input,
      leftRows: [],
      segments: [segment],
      changes: [{ ...input.changes[0]!, kind: "added", left: segment.left }],
    });
    expect(model.changes[0]?.left).toEqual(range(0, 0, null, null));
  });

  it.each([
    ["negative line", () => createKeydexAlignedDiffModel({
      ...modelInput(),
      leftRows: [{ ...modelInput().leftRows[0]!, lineNumber: -1 }],
    })],
    ["duplicate row", () => createKeydexAlignedDiffModel({
      ...modelInput(),
      rightRows: [{ ...modelInput().rightRows[0]!, id: "row:old" }],
    })],
    ["out-of-range segment", () => createKeydexAlignedDiffModel({
      ...modelInput(),
      segments: [{ ...modelInput().segments[0]!, left: range(0, 2, 1, 2) }],
    })],
    ["unknown segment", () => createKeydexAlignedDiffModel({
      ...modelInput(),
      leftRows: [{ ...modelInput().leftRows[0]!, segmentId: "segment:missing" }],
    })],
    ["duplicate change", () => createKeydexAlignedDiffModel({
      ...modelInput(),
      changes: [modelInput().changes[0]!, modelInput().changes[0]!],
    })],
  ])("rejects %s invariants", (_name, create) => {
    expect(create).toThrow(KeydexAlignedDiffModelError);
  });
});
