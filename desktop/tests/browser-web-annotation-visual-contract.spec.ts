import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const cssPath = path.resolve(
  process.cwd(),
  "src/renderer/features/browser/annotations/ui/WebAnnotationDrawer.module.css",
);
const composerCssPath = path.resolve(
  process.cwd(),
  "src/renderer/components/chat/SendBox/SendBox.module.css",
);

describe("web annotation visual contract", () => {
  it("reuses Keydex semantic theme, radius, shadow, and motion tokens", () => {
    const css = fs.readFileSync(cssPath, "utf8");

    expect(css).toContain("var(--annotation-accent)");
    expect(css).toContain("var(--color-bg-elevated)");
    expect(css).toContain("var(--surface-muted)");
    expect(css).toContain("var(--radius-md)");
    expect(css).toContain("var(--shadow-popover)");
    expect(css).toContain("var(--motion-fast)");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("@container (max-width: 430px)");
    expect(css).not.toMatch(/#[0-9a-f]{3,8}/iu);
  });

  it("renders composer references through the existing chip system and semantic status colors", () => {
    const css = fs.readFileSync(composerCssPath, "utf8");

    expect(css).toMatch(/\.quoteChipWrapper,[\s\S]*\.webAnnotationChipWrapper\s*\{/u);
    expect(css).toMatch(/\.quoteInputChip,[\s\S]*\.webAnnotationChip\s*\{[\s\S]*var\(--radius-pill\)/u);
    expect(css).toMatch(/\.webAnnotationChip\[data-status="changed"\][\s\S]*var\(--color-warning\)/u);
    expect(css).toMatch(/\.webAnnotationChip\[data-status="orphaned"\][\s\S]*var\(--color-danger\)/u);
    expect(css).toMatch(/\.webAnnotationChipRemove:focus-visible/u);
  });
});
