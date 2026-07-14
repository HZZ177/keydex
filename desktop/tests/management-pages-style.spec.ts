import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const css = readFileSync(
  resolve(process.cwd(), "src/renderer/pages/settings/ManagementPages.module.css"),
  "utf8",
);

describe("project and archive management responsive style contract", () => {
  it("keeps names and actions inside the 1024, 800 and narrow settings layouts", () => {
    expect(css).toContain("width: min(900px, calc(100% - 72px))");
    expect(css).toMatch(/@media \(max-width: 900px\)[\s\S]*grid-template-columns: 30px minmax\(0, 1fr\)/);
    expect(css).toMatch(/@media \(max-width: 640px\)[\s\S]*\.toolbar[\s\S]*grid-template-columns: minmax\(0, 1fr\) auto/);
    expect(css).toMatch(/\.rowMain strong,[\s\S]*text-overflow: ellipsis;[\s\S]*white-space: nowrap;/);
    expect(css).toMatch(/\.actions[\s\S]*flex-wrap: wrap;/);
  });

  it("uses theme tokens and removes non-essential motion for reduced-motion users", () => {
    expect(css).toContain("color: var(--color-text-primary)");
    expect(css).toContain("box-shadow: var(--settings-focus-ring)");
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*transition-duration: 0\.01ms !important/);
  });

  it("separates project placeholders and nests each session list in its own surface", () => {
    expect(css).toMatch(/\.dialogBody\s*\{[\s\S]*padding:/);
    expect(css).toMatch(/\.dialogFooter\s*\{[\s\S]*padding:/);
    expect(css).toMatch(/\.archiveGroupList\s*\{[\s\S]*gap: 22px;[\s\S]*border: 0;/);
    expect(css).toMatch(/\.archiveGroupHeader\s*\{[\s\S]*grid-template-columns:/);
    expect(css).toMatch(/\.archiveSessionList\s*\{[\s\S]*border: 1px solid[\s\S]*border-radius: 15px/);
    expect(css).toMatch(/\.archiveSessionRow:first-child\s*\{[\s\S]*border-top: 0/);
  });

  it("keeps the project multi-select aligned with the archive search toolbar", () => {
    expect(css).toMatch(/\.toolbar\s*\{[\s\S]*grid-template-columns: auto minmax\(240px, 1fr\) auto/);
    expect(css).toMatch(/\.projectFilter\s*\{[\s\S]*width: 300px;[\s\S]*max-width: calc\(100vw - 72px\)/);
    expect(css).toMatch(/\.search\s*\{[\s\S]*height: 32px;[\s\S]*cursor: default/);
    expect(css).toMatch(/\.projectFilterTrigger\s*\{[\s\S]*height: 32px;[\s\S]*border-radius: var\(--radius-md\)/);
    expect(css).toMatch(/\.iconButton\s*\{[\s\S]*width: 32px;[\s\S]*height: 32px;[\s\S]*min-height: 32px/);
    expect(css).toMatch(/\.projectFilterOption\s*\{[\s\S]*font-size: 12px !important/);
    expect(css).toMatch(/\.projectFilterMenu\s*\{[\s\S]*animation: projectFilterMenuEnter 150ms/);
    expect(css).toMatch(/\.projectFilterMenu\[data-state="closing"\][\s\S]*animation-duration: 120ms/);
    expect(css).toMatch(/\.projectFilterOptions\s*\{[\s\S]*max-height: min\(var\(--floating-max-height, 238px\), 34vh\)/);
  });
});
