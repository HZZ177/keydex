import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const stylesDir = resolve(dirname(fileURLToPath(import.meta.url)), "../src/renderer/styles");

describe("style foundation", () => {
  it("keeps the app style foundation tied to semantic tokens", () => {
    const layout = readFileSync(resolve(stylesDir, "layout.css"), "utf8");
    const themeBase = readFileSync(resolve(stylesDir, "themes/base.css"), "utf8");
    const themeScheme = readFileSync(resolve(stylesDir, "themes/default-color-scheme.css"), "utf8");
    const themes = `${themeBase}\n${themeScheme}`;

    [".codex-app-shell", ".codex-scrollable", ".codex-inline-block"].forEach(
      (selector) => expect(layout).toContain(selector),
    );

    ["--radius-sm", "--surface-bg", "--color-primary-6"].forEach((token) =>
      expect(themes).toContain(token),
    );
  });

  it("defines layout, scrollbar and markdown primitives", () => {
    const layout = readFileSync(resolve(stylesDir, "layout.css"), "utf8");
    const markdown = readFileSync(resolve(stylesDir, "markdown.css"), "utf8");

    expect(layout).toContain(".codex-app-shell");
    expect(layout).toContain(".codex-scrollable::-webkit-scrollbar-thumb");
    expect(layout).toContain(".codex-inline-block");
    expect(markdown).toContain(".codex-markdown");
    expect(markdown).toContain("var(--font-mono)");
    expect(markdown).toContain("overflow-x: auto");
    expect(markdown).toContain("overflow-y: visible");
  });

  it("keeps conversation vertical scrolling delegated to the app shell", () => {
    const layout = readSource("renderer/components/layout/Layout.module.css");
    const chatLayout = readSource("renderer/pages/conversation/ChatLayout/ChatLayout.module.css");
    const messageList = readSource("renderer/pages/conversation/messages/MessageList.module.css");
    const commandBlock = readSource("renderer/pages/conversation/messages/CommandExecutionBlock.module.css");
    const toolBlock = readSource("renderer/pages/conversation/messages/ToolCallBlock.module.css");
    const fileChangeBlock = readSource("renderer/pages/conversation/messages/FileChangeBlock.module.css");
    const errorBlock = readSource("renderer/pages/conversation/messages/ErrorItem.module.css");

    expect(layout).toContain("overflow-y: auto");
    expect(layout).toContain("overflow-x: hidden");
    expect(layout).toContain("scrollbar-gutter: stable");
    expect(chatLayout).toMatch(/\.composerDock\s*{[^}]*position:\s*fixed/s);
    expect(chatLayout).toContain("bottom: 0");
    expect(chatLayout).toContain("--conversation-composer-reserved-height");
    expect(messageList).toMatch(/\.scroller\s*{[^}]*overflow:\s*visible/s);
    expect(messageList).not.toMatch(/\.scroller\s*{[^}]*overflow-y\s*:\s*(auto|scroll)/s);
    expect(messageList).toMatch(/\.list\s*{[^}]*display:\s*grid/s);
    expect(messageList).not.toMatch(/\.list\s*{[^}]*justify-content:\s*flex-end/s);

    [commandBlock, toolBlock, fileChangeBlock, errorBlock].forEach((css) => {
      expect(css).not.toMatch(/overflow-y\s*:\s*(auto|scroll)/);
      expect(css).toContain("overflow-y: visible");
    });
    expect(commandBlock).not.toContain("max-height: 280px");
    expect(fileChangeBlock).not.toContain("max-height: 320px");
  });

  it("does not scale font sizes with viewport units", () => {
    for (const filePath of collectCssFiles(srcDir)) {
      const css = readFileSync(filePath, "utf8");
      expect(css, filePath).not.toMatch(/font-size\s*:[^;]*(?:vw|vh|vmin|vmax)/);
    }
  });
});

function readSource(relativePath: string): string {
  return readFileSync(resolve(srcDir, relativePath), "utf8");
}

function collectCssFiles(root: string): string[] {
  const entries = readdirSync(root);
  const files: string[] = [];
  for (const entry of entries) {
    const path = resolve(root, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...collectCssFiles(path));
    } else if (entry.endsWith(".css")) {
      files.push(path);
    }
  }
  return files;
}
