import { describe, expect, it } from "vitest";

import {
  normalizePastedTextFragments,
  rebasePastedTextFragments,
  shouldCollapsePastedText,
  type PastedTextFragment,
} from "@/renderer/components/chat/SendBox/collapsiblePaste";

describe("collapsible pasted text", () => {
  it("starts folding at exactly 200 Unicode characters", () => {
    expect(shouldCollapsePastedText("字".repeat(199))).toBe(false);
    expect(shouldCollapsePastedText("字".repeat(200))).toBe(true);
    expect(shouldCollapsePastedText("😀".repeat(200))).toBe(true);
  });

  it("rebases an intact fragment around programmatic text edits", () => {
    const raw = "x".repeat(200);
    const previous = `prefix:${raw}:suffix`;
    const fragment: PastedTextFragment = {
      id: "paste-1",
      start: 7,
      end: 207,
      collapsed: true,
    };

    expect(rebasePastedTextFragments(previous, `new:${previous}`, [fragment])).toEqual([
      { ...fragment, start: 11, end: 211 },
    ]);
    expect(rebasePastedTextFragments(previous, `${previous}:new`, [fragment])).toEqual([fragment]);
  });

  it("drops a fragment when a text replacement overlaps its raw content", () => {
    const previous = "x".repeat(200);
    const fragment: PastedTextFragment = {
      id: "paste-1",
      start: 0,
      end: previous.length,
      collapsed: true,
    };

    expect(rebasePastedTextFragments(previous, `${previous.slice(0, 50)}changed${previous.slice(60)}`, [fragment])).toEqual([]);
  });

  it("filters invalid and overlapping persisted ranges", () => {
    expect(normalizePastedTextFragments("abcdefghij", [
      { id: "valid", start: 1, end: 5, collapsed: true },
      { id: "overlap", start: 4, end: 7, collapsed: true },
      { id: "outside", start: 8, end: 12, collapsed: true },
    ])).toEqual([{ id: "valid", start: 1, end: 5, collapsed: true }]);
  });
});
