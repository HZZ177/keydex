import { describe, expect, it } from "vitest";

import { normalizeUnifiedPatch } from "@/renderer/components/diff/normalizers/unifiedPatch";
import {
  fromPierreSelectedLineRange,
  keydexDiffSelectablePoints,
  keydexDiffSelectionText,
  reduceKeydexDiffSelection,
  toPierreSelectedLineRange,
  type KeydexDiffSelectionPoint,
} from "@/renderer/components/diff/selectionBridge";

const file = normalizeUnifiedPatch(
  [
    "diff --git a/a.ts b/a.ts",
    "--- a/a.ts",
    "+++ b/a.ts",
    "@@ -1,2 +1,2 @@",
    "-old one",
    "+new one",
    " context",
    "@@ -20 +20 @@",
    "-old twenty",
    "+new twenty",
    "",
  ].join("\n"),
  { source: "git", sourceVersion: "v1" },
).files[0]!;

describe("Keydex Diff stable selection bridge", () => {
  it("maps old/new and cross-hunk ranges without storing DOM objects", () => {
    const selection = fromPierreSelectedLineRange(file, {
      start: 1,
      end: 20,
      side: "deletions",
      endSide: "additions",
    });
    expect(selection).toEqual({
      anchor: { fileId: file.id, fileCacheKey: file.cacheKey, side: "old", line: 1 },
      focus: { fileId: file.id, fileCacheKey: file.cacheKey, side: "new", line: 20 },
    });
    expect(toPierreSelectedLineRange(file, selection)).toEqual({
      start: 1,
      end: 20,
      side: "deletions",
      endSide: "additions",
    });
    expect(JSON.stringify(selection)).not.toContain("HTMLElement");
  });

  it("lists selectable coordinates for additions, deletions and both context sides", () => {
    const points = keydexDiffSelectablePoints(file);
    expect(points).toEqual(expect.arrayContaining([
      point("old", 1),
      point("new", 1),
      point("old", 2),
      point("new", 2),
      point("old", 20),
      point("new", 20),
    ]));
  });

  it("copies canonical selected code without reading syntax-highlighted DOM", () => {
    expect(keydexDiffSelectionText(file, {
      anchor: point("old", 1),
      focus: point("new", 2),
    })).toBe("old one\nnew one\ncontext");
    expect(keydexDiffSelectionText(file, {
      anchor: point("new", 20),
      focus: point("new", 20),
    })).toBe("new twenty");
    expect(keydexDiffSelectionText({ ...file, cacheKey: "new-version" }, {
      anchor: point("new", 1),
      focus: point("new", 1),
    })).toBe("");
  });

  it("supports single selection, shift extension and clicking the same point to clear", () => {
    const first = point("old", 1);
    const last = point("new", 20);
    const single = reduceKeydexDiffSelection(null, { type: "select", point: first });
    expect(single).toEqual({ anchor: first, focus: first });
    const range = reduceKeydexDiffSelection(single, { type: "select", point: last, shift: true });
    expect(range).toEqual({ anchor: first, focus: last });
    expect(reduceKeydexDiffSelection(single, { type: "select", point: first })).toBeNull();
  });

  it("clears on file version change and keeps selection for the same immutable file", () => {
    const selection = reduceKeydexDiffSelection(null, { type: "select", point: point("new", 1) });
    expect(reduceKeydexDiffSelection(selection, { type: "file_changed", file })).toBe(selection);
    expect(reduceKeydexDiffSelection(selection, {
      type: "file_changed",
      file: { ...file, cacheKey: `${file.cacheKey}:v2` },
    })).toBeNull();
  });

  it("rejects missing, truncated and approximate coordinates", () => {
    expect(fromPierreSelectedLineRange(file, { start: 999, end: 999, side: "additions" })).toBeNull();
    expect(fromPierreSelectedLineRange({ ...file, selectableForPatch: false }, {
      start: 1,
      end: 1,
      side: "additions",
    })).toBeNull();
    expect(toPierreSelectedLineRange({ ...file, selectableForPatch: false }, {
      anchor: point("new", 1),
      focus: point("new", 1),
    })).toBeNull();
  });
});

function point(side: "old" | "new", line: number): KeydexDiffSelectionPoint {
  return { fileId: file.id, fileCacheKey: file.cacheKey, side, line };
}
