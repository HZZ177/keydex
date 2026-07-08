import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("A2UI content layout contract", () => {
  it("does not cap or internally scroll business component content", () => {
    const chartCss = readSource("renderer/pages/conversation/messages/a2ui/A2ChartBlock.module.css");
    const blockCss = readSource("renderer/pages/conversation/messages/a2ui/A2UIBlock.module.css");
    const confirmCss = readSource("renderer/pages/conversation/messages/a2ui/A2ConfirmBlock.module.css");
    const formCss = readSource("renderer/pages/conversation/messages/a2ui/A2FormBlock.module.css");
    const chartSource = readSource("renderer/pages/conversation/messages/a2ui/A2ChartBlock.tsx");

    expect(chartCss).not.toContain("max-height:");
    expect(chartCss).not.toMatch(/\.pointList\s*{[^}]*overflow:\s*auto/s);
    expect(blockCss).not.toMatch(/\.streamPreview\s*{[^}]*(max-height|overflow:\s*auto)/s);
    expect(confirmCss).not.toMatch(/\.riskTag\s*{[^}]*(overflow:\s*hidden|text-overflow|white-space:\s*nowrap)/s);
    expect(formCss).not.toMatch(/\.valueItem\s+dd\s*{[^}]*(overflow:\s*hidden|text-overflow|white-space:\s*nowrap)/s);
    expect(chartSource).not.toContain("truncate(");
  });

  it("keeps the A2UI debug panel header actions inside the panel with long ids", () => {
    const debugCss = readSource("renderer/pages/conversation/messages/a2ui/A2UIDebugPanel.module.css");

    expect(debugCss).toMatch(/\.titleArea\s*{[^}]*min-width:\s*0/s);
    expect(debugCss).toMatch(/\.titleArea\s*{[^}]*flex:\s*1 1 auto/s);
    expect(debugCss).toMatch(/\.actions\s*{[^}]*flex:\s*0 0 auto/s);
    expect(debugCss).toMatch(/\.actions\s*{[^}]*margin-left:\s*auto/s);
    expect(debugCss).toMatch(/\.subtitle\s*{[^}]*text-overflow:\s*ellipsis/s);
  });
});

function readSource(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), "src", relativePath), "utf8");
}
