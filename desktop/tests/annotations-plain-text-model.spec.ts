import { describe, expect, it } from "vitest";

import { createPlainTextModel } from "@/renderer/features/annotations/document/PlainTextModel";

describe("PlainTextModel", () => {
  it.each([
    ["text", "plain text\nsecond line"],
    ["code", "const value = 1;\r\nexport { value };"],
    ["json", "{\"users\":[{\"name\":\"Ada\"}]}"],
    ["yaml", "enabled: true\nitems:\n  - one"],
    ["sql", "select *  from users;"],
    ["html", "<p>Hello <strong>world</strong></p>"],
    ["mermaid", "flowchart LR\n  A-->B"],
  ])("keeps %s raw source as the canonical logical text", (_kind, source) => {
    const model = createPlainTextModel(source, "sha256:source");

    expect(model.logicalText).toBe(source);
    expect(model.rawSource).toBe(source);
    expect(model.revision).toEqual({
      documentRevision: "sha256:source",
      textRevision: "sha256:source",
    });
  });

  it("uses an exact identity mapping across Unicode and line boundaries", () => {
    const source = "first 😀 line\r\nsecond 行";
    const model = createPlainTextModel(source, "sha256:unicode");
    const range = { start: 6, end: source.length - 1 };

    expect(model.toSourceRanges(range)).toEqual([range]);
    expect(model.toLogicalRange(range)).toEqual(range);
    expect(model.projectSelection({ coordinateSpace: "source", range })).toEqual({
      logicalRange: range,
      sourceRanges: [range],
      blockRanges: [{ blockKey: "source", range }],
    });
    expect(model.projectView(range).sourceRanges).toEqual([range]);
  });

  it("does not inject placeholder text into an empty model", () => {
    const model = createPlainTextModel("", "sha256:empty");

    expect(model.logicalText).toBe("");
    expect(model.blocks).toEqual([]);
    expect(model.blockAt(0)).toBeNull();
    expect(model.projectView({ start: 0, end: 0 })).toEqual({
      logicalRange: { start: 0, end: 0 },
      sourceRanges: [{ start: 0, end: 0 }],
      blockRanges: [],
    });
  });

  it("is immutable and rejects out-of-bounds projections", () => {
    const model = createPlainTextModel("abc", "sha256:abc");

    expect(Object.isFrozen(model)).toBe(true);
    expect(Object.isFrozen(model.blocks)).toBe(true);
    expect(() => model.toSourceRanges({ start: 0, end: 4 })).toThrow(RangeError);
    expect(model.projectSelection({
      coordinateSpace: "block",
      blockKey: "missing",
      range: { start: 0, end: 1 },
    })).toBeNull();
  });
});
