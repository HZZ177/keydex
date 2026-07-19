import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { KEYDEX_DIFF_DESIGN_TOKENS } from "@/renderer/components/diff/diffTokens";

describe("aligned split theme token consumption", () => {
  it("keeps aligned component styles semantic and free of hard-coded colors", () => {
    const alignedDir = resolve(process.cwd(), "src/renderer/components/diff/aligned");
    const css = [
      "KeydexAlignedSplitDiff.module.css",
      "AlignedDiffPane.module.css",
      "AlignedDiffRow.module.css",
      "AlignedDiffHunkChrome.module.css",
    ].map((name) => readFileSync(resolve(alignedDir, name), "utf8")).join("\n");
    expect(css).not.toMatch(/#[\da-f]{3,8}\b/iu);
    expect(css).not.toMatch(/rgba?\(/iu);
    expect(css).toContain("background: var(--diff-surface-bg)");
    expect(css).not.toContain("border-inline:");
    expect(css).toContain("var(--diff-aligned-change-edge)");
  });

  it("registers every aligned semantic role in the design-token manifest", () => {
    const alignedTokens = KEYDEX_DIFF_DESIGN_TOKENS.filter((token) => token.startsWith("--diff-aligned-"));
    expect(alignedTokens).toEqual(expect.arrayContaining([
      "--diff-aligned-connector-width",
      "--diff-aligned-change-fill",
      "--diff-aligned-added-fill",
      "--diff-aligned-removed-fill",
      "--diff-aligned-pane-active-edge",
      "--diff-aligned-hunk-action-hover",
    ]));
    expect(new Set(alignedTokens).size).toBe(alignedTokens.length);
    expect(KEYDEX_DIFF_DESIGN_TOKENS).toEqual(expect.arrayContaining([
      "--diff-modified-bg",
      "--diff-modified-text",
      "--diff-modified-border",
      "--diff-modified-word-bg",
    ]));
  });

  it("allows runtime token mutation without touching model or renderer code", () => {
    const host = document.createElement("div");
    host.style.setProperty("--diff-aligned-change-fill", "rgb(1 2 3 / 10%)");
    document.body.append(host);
    expect(getComputedStyle(host).getPropertyValue("--diff-aligned-change-fill").trim())
      .toBe("rgb(1 2 3 / 10%)");
    host.remove();
  });
});
