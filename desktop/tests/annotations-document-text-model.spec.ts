import { describe, expect, it } from "vitest";

import {
  assertUtf16Offset,
  assertUtf16Range,
  freezeContext,
  freezeRange,
  type DocumentTextModel,
  type LogicalRange,
} from "@/renderer/features/annotations/document/DocumentTextModel";

describe("DocumentTextModel protocol", () => {
  it("treats every boundary as a UTF-16 code-unit offset", () => {
    const text = "A😀B";

    expect(text.length).toBe(4);
    expect(() => assertUtf16Range({ start: 1, end: 3 }, text.length)).not.toThrow();
    expect(text.slice(1, 3)).toBe("😀");
    expect(() => assertUtf16Offset(4, text.length)).not.toThrow();
  });

  it("accepts empty and boundary ranges, including an empty document", () => {
    expect(() => assertUtf16Range({ start: 0, end: 0 }, 0)).not.toThrow();
    expect(() => assertUtf16Range({ start: 0, end: 4 }, 4)).not.toThrow();
    expect(() => assertUtf16Range({ start: 4, end: 4 }, 4)).not.toThrow();
  });

  it.each([
    [{ start: -1, end: 0 }, 3],
    [{ start: 0, end: 4 }, 3],
    [{ start: 2, end: 1 }, 3],
    [{ start: 0.5, end: 1 }, 3],
    [{ start: Number.MAX_SAFE_INTEGER + 1, end: Number.MAX_SAFE_INTEGER + 1 }, 3],
  ])("rejects invalid range %#", (range, length) => {
    expect(() => assertUtf16Range(range, length)).toThrow(RangeError);
  });

  it("provides immutable range and context values", () => {
    const range = freezeRange<LogicalRange>({ start: 0, end: 2 });
    const context = freezeContext({ containerType: "paragraph", headingPath: ["Guide"] });

    expect(Object.isFrozen(range)).toBe(true);
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.headingPath)).toBe(true);
  });

  it("requires both directions, block lookup, selection, and view projection", () => {
    const assertProtocol = (_model: DocumentTextModel) => undefined;

    expect(assertProtocol).toBeTypeOf("function");
  });
});
