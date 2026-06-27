import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

describe("workspace file browser layout", () => {
  it("keeps the file tree and preview panes contained without resize skeleton masking", () => {
    const browser = readSource("renderer/components/workspace/WorkspaceFileBrowser.module.css");
    const layout = readSource("renderer/components/layout/Layout.module.css");

    expect(browser).toMatch(/\.browser\s*{[^}]*height:\s*100%/s);
    expect(browser).toMatch(/\.browser\s*{[^}]*min-height:\s*0/s);
    expect(browser).toMatch(/\.browser\s*{[^}]*overflow:\s*hidden/s);
    expect(browser).toMatch(/\.browser\s*{[^}]*contain:\s*layout paint style/s);
    expect(browser).toMatch(/\.treePane,\s*\n\.previewPane\s*{[^}]*contain:\s*layout paint style/s);
    expect(browser).not.toContain("previewResizeSkeleton");
    expect(browser).not.toMatch(/\.browser\[data-resizing="true"\]\s+\.previewPane\s+\[data-file-preview-root="true"\]/s);
    expect(layout).not.toContain("rightSidebarResizeSkeleton");
    expect(layout).not.toMatch(
      /\.shell\[data-right-sidebar-resizing="true"\]\s+\.rightSidebarBody\[data-content="preview"\]\s+\[data-file-preview-root="true"\]/s,
    );
  });

  it("styles markdown outline navigation as a slider with collapsible rows", () => {
    const browser = readSource("renderer/components/workspace/WorkspaceFileBrowser.module.css");

    expect(browser).toMatch(/\.navigationTabs::before\s*{[^}]*transition:\s*transform/s);
    expect(browser).toMatch(/\.navigationTabs\[data-mode="outline"\]::before\s*{[^}]*translateX\(100%\)/s);
    expect(browser).toMatch(/\.outlineItem\s*{[^}]*max-height:\s*30px/s);
    expect(browser).toMatch(/\.outlineItem\s*{[^}]*transition:[^}]*max-height/s);
    expect(browser).toMatch(/\.outlineItem\[data-visible="false"\]\s*{[^}]*max-height:\s*0/s);
  });

  it("keeps the directory tree scrollbar aligned with the main sidebar", () => {
    const panel = readSource("renderer/components/workspace/WorkspacePanel.module.css");

    expect(panel).toMatch(/\.tree\s*{[^}]*scrollbar-width:\s*auto/s);
    expect(panel).toMatch(/\.tree::-webkit-scrollbar\s*{[^}]*width:\s*10px/s);
    expect(panel).toMatch(/\.tree::-webkit-scrollbar\s*{[^}]*height:\s*10px/s);
  });
});

function readSource(relativePath: string): string {
  return readFileSync(resolve(srcDir, relativePath), "utf8");
}
