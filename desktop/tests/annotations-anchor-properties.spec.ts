import { describe, expect, it } from "vitest";

import { createTextSelector } from "@/renderer/features/annotations/anchoring/createTextSelector";
import { resolveTextAnchor } from "@/renderer/features/annotations/anchoring/resolveTextAnchor";
import { createMarkdownTextModel } from "./fixtures/annotationMarkdown";
import { createPlainTextModel } from "@/renderer/features/annotations/document/PlainTextModel";

const SEED = 0x5eed_2026;

describe("annotation anchor deterministic properties", () => {
  it("keeps exact anchors resolved across 200 seeded surrounding edits", () => {
    const random = seededRandom(SEED);
    const exact = "target-😀-文字";
    const base = createPlainTextModel(`left context ${exact} right context`, "sha256:base");
    const start = base.logicalText.indexOf(exact);
    const selector = createTextSelector(base, { start, end: start + exact.length });
    for (let index = 0; index < 200; index += 1) {
      const before = randomText(random, index % 17);
      const after = randomText(random, (index * 7) % 19);
      const current = createPlainTextModel(`${before}${base.logicalText}${after}`, `sha256:outer-${index}`);
      const resolution = resolveTextAnchor(current, selector);
      expect(resolution.status, `seed=${SEED} case=${index}`).toBe("resolved");
      if (resolution.status === "resolved") {
        expect(current.logicalText.slice(resolution.range.start, resolution.range.end)).toBe(exact);
      }
    }
  });

  it("marks 100 seeded internal exact mutations as changed", () => {
    const random = seededRandom(SEED + 1);
    for (let index = 0; index < 100; index += 1) {
      const exact = `unique-${index}-${randomText(random, 12)}`;
      const base = createPlainTextModel(`before ${exact} after`, `sha256:base-${index}`);
      const start = base.logicalText.indexOf(exact);
      const selector = createTextSelector(base, { start, end: start + exact.length });
      const mutated = `${exact.slice(0, 3)}X${exact.slice(4)}`;
      const current = createPlainTextModel(`before ${mutated} after`, `sha256:inner-${index}`);
      expect(resolveTextAnchor(current, selector).status, `seed=${SEED + 1} case=${index}`).toBe("changed");
    }
  });

  it("is ambiguous for duplicate exact text without a unique context", () => {
    const base = createPlainTextModel("target", "sha256:base");
    const selector = createTextSelector(base, { start: 0, end: 6 });
    const current = createPlainTextModel("x target / target", "sha256:duplicate");
    expect(resolveTextAnchor(current, selector).status).toBe("ambiguous");
  });

  it("survives Markdown syntax-only changes because logical exact is unchanged", () => {
    const base = createMarkdownTextModel("# Title\n\nUse **target** here.", "sha256:bold");
    const start = base.logicalText.indexOf("target");
    const selector = createTextSelector(base, { start, end: start + 6 });
    const current = createMarkdownTextModel("# Title\n\nUse _target_ here.", "sha256:italic");
    expect(resolveTextAnchor(current, selector).status).toBe("resolved");
  });
});

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function randomText(random: () => number, length: number): string {
  const points = Array.from("abcdefXYZ012中文😀");
  return Array.from({ length }, () => points[Math.floor(random() * points.length)]).join("");
}
