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
