import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("right sidebar platform contract", () => {
  it("keeps Layout generic across registered panel kinds and initial actions", () => {
    const layout = readFileSync(
      resolve(process.cwd(), "src/renderer/components/layout/Layout.tsx"),
      "utf8",
    );
    const initialPage = readFileSync(
      resolve(process.cwd(), "src/renderer/components/layout/RightSidebarInitialPage.tsx"),
      "utf8",
    );

    expect(layout).toContain("rightSidebarDefinitionRegistry.listInitialActions()");
    expect(layout).toContain("RightSidebarRegisteredPanelHost");
    expect(layout).toContain("openDefaultRegisteredPanel(action.kind)");
    expect(layout).not.toMatch(/action\.id\s*===/u);
    expect(layout).not.toMatch(/(?:panel|activeRegisteredPanel)\.kind\s*===/u);
    expect(layout).not.toMatch(/case\s+["'](?:files|conversation|review|browser)["']/u);
    expect(initialPage).not.toContain("canOpenFiles");
    expect(initialPage).not.toContain("canOpenReview");
  });
});
