import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("A2UI content layout contract", () => {
  it("does not cap or internally scroll business component content", () => {
    const chartCss = readSource("renderer/pages/conversation/messages/a2ui/A2ChartBlock.module.css");
    const blockCss = readSource("renderer/pages/conversation/messages/a2ui/A2UIBlock.module.css");
    const formCss = readSource("renderer/pages/conversation/messages/a2ui/A2FormBlock.module.css");
    const chartSource = readSource("renderer/pages/conversation/messages/a2ui/A2ChartBlock.tsx");

    expect(chartCss).not.toContain("max-height:");
    expect(chartCss).not.toMatch(/\.pointList\s*{[^}]*overflow:\s*auto/s);
    expect(blockCss).not.toMatch(/\.streamPreview\s*{[^}]*(max-height|overflow:\s*auto)/s);
    expect(formCss).not.toMatch(/\.valueItem\s+dd\s*{[^}]*(overflow:\s*hidden|text-overflow|white-space:\s*nowrap)/s);
    expect(chartSource).not.toContain("truncate(");
  });

  it("renders chart captions as centered text below the chart surface", () => {
    const chartCss = readSource("renderer/pages/conversation/messages/a2ui/A2ChartBlock.module.css");

    expect(chartCss).toMatch(/\.panelTitle\s*{[^}]*justify-self:\s*center/s);
    expect(chartCss).toMatch(/\.panelTitle\s*{[^}]*text-align:\s*center/s);
    expect(chartCss).toMatch(/\.summary\s*{[^}]*justify-self:\s*center/s);
    expect(chartCss).toMatch(/\.summary\s*{[^}]*text-align:\s*center/s);
  });

  it("keeps form A2UI as a compact canvas with inline field headers", () => {
    const formCss = readSource("renderer/pages/conversation/messages/a2ui/A2FormBlock.module.css");

    expect(formCss).toMatch(/\.workspace\s*{[^}]*border-radius:\s*18px/s);
    expect(formCss).toMatch(/\.workspace\s*{[^}]*isolation:\s*isolate/s);
    expect(formCss).toMatch(/\.fields\s*{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/s);
    expect(formCss).toMatch(/\.field\s*{[^}]*min-height:\s*86px/s);
    expect(formCss).toMatch(/\.field\s*{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s);
    expect(formCss).toMatch(/\.fieldBrief\s*{[^}]*grid-template-columns:\s*auto auto minmax\(0, 1fr\)/s);
    expect(formCss).toMatch(/\.fieldIcon\s*{[^}]*width:\s*15px/s);
    expect(formCss).not.toContain(".fieldDots");
    expect(formCss).not.toMatch(/\.field\s*{[^}]*grid-template-columns:\s*52px minmax\(148px/s);
    expect(formCss).not.toMatch(/\.field\s*{[^}]*grid-template-columns:\s*24px minmax\(0, 1fr\)/s);
  });

  it("keeps choice gallery card text padded against transform clipping", () => {
    const choiceCss = readSource("renderer/pages/conversation/messages/a2ui/A2ChoiceBlock.module.css");

    expect(choiceCss).toMatch(/\.optionDescription\s*{[^}]*box-sizing:\s*border-box/s);
    expect(choiceCss).toMatch(/\.optionDescription\s*{[^}]*padding:\s*1px 2px/s);
    expect(choiceCss).toMatch(/\.optionDescription\[data-detail-expanded="true"\]\s*{[^}]*padding:\s*1px 6px 1px 2px/s);
  });

  it("keeps choice gallery cards visually separated from the white page background", () => {
    const choiceCss = readSource("renderer/pages/conversation/messages/a2ui/A2ChoiceBlock.module.css");

    expect(choiceCss).toMatch(/--a2ui-choice-card-bg-top:\s*color-mix\(in srgb, var\(--surface-muted\) 38%, var\(--color-bg-elevated\)\)/s);
    expect(choiceCss).toMatch(/--a2ui-choice-card-bg-bottom:\s*color-mix\(in srgb, var\(--surface-muted\) 58%, var\(--color-bg-elevated\)\)/s);
    expect(choiceCss).toMatch(/--a2ui-choice-card-bg-base:\s*color-mix\(in srgb, var\(--surface-muted\) 46%, var\(--color-bg-elevated\)\)/s);
    expect(choiceCss).toMatch(/\.optionFace\s*{[^}]*background:[^}]*var\(--a2ui-choice-card-bg-top\)[^}]*var\(--a2ui-choice-card-bg-bottom\)[^}]*var\(--a2ui-choice-card-bg-base\)/s);
  });

  it("does not fade the entire historical unselected choice card", () => {
    const choiceCss = readSource("renderer/pages/conversation/messages/a2ui/A2ChoiceBlock.module.css");
    const dimmedRule = choiceCss.match(/\.option\[data-dimmed="true"\]\s*{(?<body>[^}]*)}/s)?.groups?.body ?? "";

    expect(dimmedRule).not.toMatch(/^\s*opacity\s*:/m);
    expect(dimmedRule).not.toMatch(/^\s*filter\s*:/m);
    expect(dimmedRule).toContain("--a2ui-choice-card-filter: saturate(0.88)");
    expect(dimmedRule).toContain("--a2ui-choice-card-text-opacity: 0.74");
  });

  it("keeps selected choice gallery cards as subtle green double frames", () => {
    const choiceCss = readSource("renderer/pages/conversation/messages/a2ui/A2ChoiceBlock.module.css");

    expect(choiceCss).not.toContain("a2ui-choice-vine");
    expect(choiceCss).not.toMatch(/\.option\[data-selected="true"\]\s+\.optionFace::before\s*{[^}]*radial-gradient/s);
    expect(choiceCss).toMatch(/\.option\[data-selected="true"\]\s*{[^}]*--a2ui-choice-selected-frame-outer:/s);
    expect(choiceCss).toMatch(/\.option\[data-selected="true"\]\s*{[^}]*--a2ui-choice-selected-frame-inner:/s);
    expect(choiceCss).toMatch(/\.option\[data-selected="true"\]\s+\.optionFace::before\s*{[^}]*border:\s*1px solid var\(--a2ui-choice-selected-frame-outer\)/s);
    expect(choiceCss).toMatch(/\.option\[data-selected="true"\]\s+\.optionFace::after\s*{[^}]*border:\s*1px solid var\(--a2ui-choice-selected-frame-inner\)/s);
    expect(choiceCss).toMatch(/\.option:not\(\[data-selected="true"\]\):hover\s+\.optionFace::before\s*{[^}]*content:\s*none/s);
    expect(choiceCss).toMatch(/\.option\[data-readonly="true"\]:not\(\[data-selected="true"\]\):hover\s+\.optionFace::before\s*{[^}]*opacity:\s*0/s);
  });

  it("keeps the A2UI debug panel header actions inside the panel with long ids", () => {
    const debugCss = readSource("renderer/pages/conversation/messages/a2ui/A2UIDebugPanel.module.css");

    expect(debugCss).toMatch(/\.titleArea\s*{[^}]*min-width:\s*0/s);
    expect(debugCss).toMatch(/\.titleArea\s*{[^}]*flex:\s*1 1 auto/s);
    expect(debugCss).toMatch(/\.actions\s*{[^}]*flex:\s*0 0 auto/s);
    expect(debugCss).toMatch(/\.actions\s*{[^}]*margin-left:\s*auto/s);
    expect(debugCss).toMatch(/\.subtitle\s*{[^}]*text-overflow:\s*ellipsis/s);
  });

  it("keeps A2UI status metadata hidden and the debug trigger visually neutral", () => {
    const blockCss = readSource("renderer/pages/conversation/messages/a2ui/A2UIBlock.module.css");
    const debugCss = readSource("renderer/pages/conversation/messages/a2ui/A2UIDebugPanel.module.css");

    expect(blockCss).toContain(".statusMeta");
    expect(blockCss).not.toContain(".status {");
    expect(debugCss).toMatch(/\.debugButton:focus-visible\s*{[^}]*outline:\s*1px solid color-mix\(in srgb, var\(--color-border-default\)/s);
    expect(debugCss).not.toMatch(/\.debugButton:focus-visible\s*{[^}]*color-info-6/s);
  });
});

function readSource(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), "src", relativePath), "utf8");
}
