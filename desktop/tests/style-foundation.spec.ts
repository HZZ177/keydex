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
    const globalStyles = readFileSync(resolve(srcDir, "styles.css"), "utf8");

    expect(layout).toContain(".codex-app-shell");
    expect(layout).toContain(".codex-scrollable::-webkit-scrollbar-thumb");
    expect(layout).toContain(".codex-inline-block");
    expect(globalStyles).toContain(":where(button, input, textarea, select, a, [role=\"button\"], [tabindex]):focus");
    expect(globalStyles).toContain("outline: none");
    expect(markdown).toContain(".codex-markdown");
    expect(markdown).toContain("var(--font-mono)");
    expect(markdown).toContain("overflow-x: auto");
    expect(markdown).toContain("overflow-y: visible");
  });

  it("does not define blue focus rings on interactive controls", () => {
    for (const filePath of collectCssFiles(srcDir)) {
      const css = readFileSync(filePath, "utf8");
      expect(css, filePath).not.toMatch(/outline\s*:\s*[^;]*(?:color-primary|color-accent|#1677ff|#1890ff)/i);
      expect(css, filePath).not.toMatch(
        /box-shadow\s*:\s*[^;]*(?:color-primary|color-accent|#1677ff|#1890ff)/i,
      );
    }
  });

  it("keeps conversation vertical scrolling inside the message document area", () => {
    const layout = readSource("renderer/components/layout/Layout.module.css");
    const sider = readSource("renderer/components/layout/Sider/Sider.module.css");
    const chatLayout = readSource("renderer/pages/conversation/ChatLayout/ChatLayout.module.css");
    const messageList = readSource("renderer/pages/conversation/messages/MessageList.module.css");
    const messageGroup = readSource("renderer/pages/conversation/messages/MessageGroupBlock.module.css");
    const commandBlock = readSource("renderer/pages/conversation/messages/CommandExecutionBlock.module.css");
    const toolBlock = readSource("renderer/pages/conversation/messages/ToolCallBlock.module.css");
    const fileChangeBlock = readSource("renderer/pages/conversation/messages/FileChangeBlock.module.css");
    const errorBlock = readSource("renderer/pages/conversation/messages/ErrorItem.module.css");
    const sendBox = readSource("renderer/components/chat/SendBox/SendBox.module.css");

    expect(layout).toContain("overflow-y: auto");
    expect(layout).toContain("overflow-x: hidden");
    expect(layout).toContain("scrollbar-gutter: stable");
    expect(layout).toMatch(/\.readingColumn\[data-content="full"\]\s*{[^}]*height:\s*100%/s);
    expect(chatLayout).toMatch(/\.chatLayout\s*{[^}]*grid-template-rows:\s*auto minmax\(0,\s*1fr\) auto/s);
    expect(chatLayout).toMatch(/\.document\s*{[^}]*overflow-y:\s*auto/s);
    expect(chatLayout).toMatch(/\.document\s*{[^}]*scrollbar-width:\s*auto/s);
    expect(chatLayout).toMatch(/\.document::-webkit-scrollbar\s*{[^}]*width:\s*11px/s);
    expect(chatLayout).toMatch(/\.composerDock\s*{[^}]*position:\s*relative/s);
    expect(chatLayout).not.toMatch(/\.composerDock\s*{[^}]*position:\s*fixed/s);
    expect(chatLayout).not.toContain("--conversation-composer-reserved-height");
    expect(messageList).toMatch(/\.scroller\s*{[^}]*overflow:\s*visible/s);
    expect(messageList).not.toMatch(/\.scroller\s*{[^}]*overflow-y\s*:\s*(auto|scroll)/s);
    expect(messageList).toMatch(/\.list\s*{[^}]*display:\s*grid/s);
    expect(messageList).not.toMatch(/\.list\s*{[^}]*justify-content:\s*flex-end/s);
    expect(sider).toMatch(/\.historyMeta\s*{[^}]*white-space:\s*nowrap/s);
    expect(sider).toMatch(/\.historyItem\[data-active="true"\]::after\s*{[^}]*position:\s*absolute/s);
    expect(sendBox).toMatch(/\.root\[data-variant="codex"\]\s*{[^}]*overflow:\s*visible/s);

    [commandBlock, toolBlock, fileChangeBlock, errorBlock].forEach((css) => {
      expect(css).not.toMatch(/overflow-y\s*:\s*(auto|scroll)/);
      expect(css).toContain("overflow-y: visible");
    });
    expect(commandBlock).not.toContain("max-height: 280px");
    expect(fileChangeBlock).not.toContain("max-height: 320px");
    expect(messageGroup).toContain("border-left");
    [messageGroup, commandBlock, toolBlock].forEach((css) => {
      expect(css).not.toContain("background: var(--inline-block-bg)");
      expect(css).toContain("animation:");
    });
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
