import { describe, expect, it } from "vitest";

import { createTextSelector } from "@/renderer/features/annotations/anchoring/createTextSelector";
import { resolveTextAnchor } from "@/renderer/features/annotations/anchoring/resolveTextAnchor";
import { createMarkdownTextModel } from "@/renderer/features/annotations/document/MarkdownTextModel";
import { createPlainTextModel } from "@/renderer/features/annotations/document/PlainTextModel";
import type { TextSelector } from "@/runtime/annotations";

describe("resolveTextAnchor", () => {
  it("keeps the original position when exact still matches despite revision changes", () => {
    const before = createPlainTextModel("alpha target omega", "sha256:before");
    const selector = createTextSelector(before, { start: 6, end: 12 });
    const after = createPlainTextModel("alpha target omega", "sha256:after");

    expect(resolveTextAnchor(after, selector)).toEqual({
      status: "resolved",
      range: { start: 6, end: 12 },
      strategy: "position",
    });
  });

  it.each([
    ["insertion before", "new prefix alpha target omega"],
    ["deletion before", "target omega"],
    ["move", "omega then target after movement"],
  ])("resolves an unchanged exact after peripheral %s", (_label, changedText) => {
    const before = createPlainTextModel("alpha target omega", "sha256:before");
    const selector = createTextSelector(before, { start: 6, end: 12 });
    const after = createPlainTextModel(changedText, "sha256:after");
    const resolution = resolveTextAnchor(after, selector);

    expect(resolution.status).toBe("resolved");
    if (resolution.status === "resolved") {
      expect(after.logicalText.slice(resolution.range.start, resolution.range.end)).toBe("target");
    }
  });

  it("uses exact prefix and suffix as hard disambiguation evidence", () => {
    const selector = selectorFor("target", { prefix: "left ", suffix: " right" });
    const model = createPlainTextModel("other target value; left target right", "sha256:changed");

    expect(resolveTextAnchor(model, selector)).toEqual({
      status: "resolved",
      range: { start: model.logicalText.lastIndexOf("target"), end: model.logicalText.lastIndexOf("target") + 6 },
      strategy: "quote-context",
    });
  });

  it("uses container and heading path as exact context, never fuzzy similarity", () => {
    const model = createMarkdownTextModel(
      "# First\n\ntarget\n\n# Second\n\ntarget",
      "sha256:changed",
    );
    const selector = selectorFor("target", {
      context: { containerType: "paragraph", headingPath: ["Second"] },
    });
    const resolution = resolveTextAnchor(model, selector);

    expect(resolution.status).toBe("resolved");
    if (resolution.status === "resolved") {
      expect(model.contextAt(resolution.range).headingPath).toEqual(["Second"]);
      expect(resolution.strategy).toBe("document-context");
    }
  });

  it("returns ambiguous for repeated exact text that hard rules cannot distinguish", () => {
    const model = createPlainTextModel("target x target", "sha256:duplicate");
    const resolution = resolveTextAnchor(model, selectorFor("target"));

    expect(resolution).toEqual({
      status: "ambiguous",
      candidates: [{ start: 0, end: 6 }, { start: 9, end: 15 }],
    });
  });

  it("returns changed only when exact no longer exists", () => {
    const model = createPlainTextModel("alpha changed omega", "sha256:changed");

    expect(resolveTextAnchor(model, selectorFor("target"))).toEqual({ status: "changed" });
  });

  it("finds overlapping exact candidates without guessing", () => {
    const model = createPlainTextModel("aaa", "sha256:overlap");
    const resolution = resolveTextAnchor(model, selectorFor("aa"));

    expect(resolution).toEqual({
      status: "ambiguous",
      candidates: [{ start: 0, end: 2 }, { start: 1, end: 3 }],
    });
  });
});

function selectorFor(
  exact: string,
  overrides: {
    prefix?: string;
    suffix?: string;
    context?: TextSelector["context"];
  } = {},
): TextSelector {
  return {
    position: { start: 100, end: 100 + exact.length },
    quote: { exact, prefix: overrides.prefix ?? "", suffix: overrides.suffix ?? "" },
    context: overrides.context ?? { containerType: "source", headingPath: [] },
    textRevision: "old-text-revision",
    documentRevision: "old-document-revision",
  };
}
