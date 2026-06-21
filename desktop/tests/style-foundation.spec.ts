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
    expect(sendBox).toMatch(/\.contextBar\s*{[^}]*overflow:\s*visible/s);
    expect(sendBox).toMatch(/\.contextBar\s*{[^}]*border-bottom-left-radius:\s*19px/s);
    expect(sendBox).toMatch(/\.contextBar\s*{[^}]*inset 0 -1px 0/s);

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

  it("keeps settings workspace on its own Codex-like layout baseline", () => {
    const mainLayout = readSource("renderer/components/layout/Layout.module.css");
    const sider = readSource("renderer/components/layout/Sider/Sider.module.css");
    const resizeHandle = readSource("renderer/components/layout/SidebarResizeHandle.module.css");
    const titlebar = readSource("renderer/components/layout/Titlebar/Titlebar.module.css");
    const shell = readSource("renderer/pages/settings/SettingsShell.module.css");
    const model = readSource("renderer/pages/settings/model/ModelSettingsPage.module.css");
    const usage = readSource("renderer/pages/settings/usage/UsageStatsPage.module.css");

    expect(mainLayout).toMatch(/\.body\s*{[^}]*display:\s*flex/s);
    expect(mainLayout).toMatch(/\.content\s*{[^}]*border-top-left-radius:\s*12px/s);
    expect(mainLayout).toMatch(/\.content\s*{[^}]*border-bottom-left-radius:\s*12px/s);
    expect(titlebar).toMatch(/\.titlebar\s*{[^}]*border-bottom:\s*1px solid var\(--color-border-1\)/s);
    expect(sider).toMatch(/\.sider\s*{[^}]*width:\s*var\(--sidebar-width\)/s);
    expect(sider).toMatch(/\.sider\s*{[^}]*flex:\s*0 0 var\(--sidebar-width\)/s);
    expect(sider).not.toContain("border-right:");
    expect(resizeHandle).toMatch(/\.handle::before\s*{[^}]*top:\s*12px/s);
    expect(resizeHandle).toMatch(/\.handle::before\s*{[^}]*bottom:\s*12px/s);
    expect(shell).toMatch(/\.shell\s*{[^}]*grid-template-rows:\s*var\(--titlebar-height\) minmax\(0,\s*1fr\)/s);
    expect(shell).toMatch(/\.body\s*{[^}]*display:\s*flex/s);
    expect(shell).toMatch(/\.sidebar\s*{[^}]*width:\s*var\(--sidebar-width\)/s);
    expect(shell).toMatch(/\.sidebar\s*{[^}]*flex:\s*0 0 var\(--sidebar-width\)/s);
    expect(shell).toMatch(/\.sidebar\s*{[^}]*padding:\s*12px 7px 10px/s);
    expect(shell).not.toMatch(/\.sidebar\s*{[^}]*border-right/s);
    expect(shell).toMatch(/\.backButton\s*{[^}]*height:\s*30px/s);
    expect(shell).toMatch(/\.searchBox\s*{[^}]*height:\s*30px/s);
    expect(shell).toMatch(/\.groupLabel\s*{[^}]*font-size:\s*12px/s);
    expect(shell).toMatch(/\.menuItem\s*{\s*width:\s*100%;[^}]*height:\s*30px/s);
    expect(shell).toMatch(/\.menuItem\s*{\s*width:\s*100%;[^}]*font-size:\s*14px/s);
    expect(shell).toMatch(/\.content\s*{[^}]*overflow:\s*auto/s);
    expect(shell).toMatch(/\.content\s*{[^}]*border-top-left-radius:\s*12px/s);
    expect(shell).toMatch(/\.content\s*{[^}]*border-bottom-left-radius:\s*12px/s);
    expect(shell).toMatch(/\.menuItem\[data-active="true"\]\s*{[^}]*surface-active/s);
    expect(shell).not.toContain("暂未开放");
    expect(model).toContain("width: min(960px, calc(100% - 136px))");
    expect(model).toContain("padding: 92px 0 128px");
    expect(usage).toContain("width: min(1180px, calc(100% - 136px))");
    expect(usage).toContain("padding: 92px 0 128px");
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
