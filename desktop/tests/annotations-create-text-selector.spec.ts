import { describe, expect, it } from "vitest";

import {
  createTextSelector,
  TEXT_SELECTOR_CONTEXT_CHARACTERS,
} from "@/renderer/features/annotations/anchoring/createTextSelector";
import { createMarkdownTextModel } from "./fixtures/annotationMarkdown";
import { createPlainTextModel } from "@/renderer/features/annotations/document/PlainTextModel";

describe("createTextSelector", () => {
  it("creates the single selector contract from a logical range", () => {
    const model = createMarkdownTextModel("# Guide\n\nAlpha **target** omega", "sha256:document");
    const start = model.logicalText.indexOf("target");
    const selector = createTextSelector(model, { start, end: start + "target".length });

    expect(selector).toEqual({
      position: { start, end: start + 6 },
      quote: { exact: "target", prefix: "Guide\nAlpha ", suffix: " omega" },
      context: { containerType: "paragraph", headingPath: ["Guide"] },
      textRevision: model.revision.textRevision,
      documentRevision: "sha256:document",
    });
    expect(Object.keys(selector).sort()).toEqual([
      "context",
      "documentRevision",
      "position",
      "quote",
      "textRevision",
    ]);
  });

  it("truncates prefix and suffix by code point without splitting surrogate pairs", () => {
    const prefix = "😀".repeat(80);
    const suffix = "👋".repeat(80);
    const model = createPlainTextModel(`${prefix}target${suffix}`, "sha256:unicode");
    const start = prefix.length;
    const selector = createTextSelector(model, { start, end: start + 6 });

    expect(Array.from(selector.quote.prefix)).toHaveLength(TEXT_SELECTOR_CONTEXT_CHARACTERS);
    expect(Array.from(selector.quote.suffix)).toHaveLength(TEXT_SELECTOR_CONTEXT_CHARACTERS);
    expect(selector.quote.prefix).toBe("😀".repeat(64));
    expect(selector.quote.suffix).toBe("👋".repeat(64));
  });

  it("keeps exact equal to the logical slice for cross-block selections", () => {
    const model = createMarkdownTextModel("Alpha end\n\nBeta start", "sha256:cross");
    const range = {
      start: model.logicalText.indexOf("end"),
      end: model.logicalText.indexOf("start") + "start".length,
    };
    const selector = createTextSelector(model, range);

    expect(selector.quote.exact).toBe(model.logicalText.slice(range.start, range.end));
    expect(selector.quote.exact).toBe("end\nBeta start");
  });

  it("supports document boundaries", () => {
    const model = createPlainTextModel("target", "sha256:boundary");
    const selector = createTextSelector(model, { start: 0, end: 6 });

    expect(selector.quote).toEqual({ exact: "target", prefix: "", suffix: "" });
  });

  it("rejects empty, whitespace, invalid, and split-surrogate selections", () => {
    const plain = createPlainTextModel("a  😀 z", "sha256:invalid");

    expect(() => createTextSelector(plain, { start: 1, end: 1 })).toThrow("cannot be empty");
    expect(() => createTextSelector(plain, { start: 1, end: 3 })).toThrow("only whitespace");
    expect(() => createTextSelector(plain, { start: -1, end: 1 })).toThrow(RangeError);
    expect(() => createTextSelector(plain, { start: 3, end: 4 })).toThrow("surrogate pair");
  });
});
