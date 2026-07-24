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

    [".keydex-app-shell", ".keydex-scrollable", ".keydex-inline-block"].forEach(
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

    expect(layout).toContain(".keydex-app-shell");
    expect(layout).toContain(".keydex-scrollable::-webkit-scrollbar-thumb");
    expect(layout).toContain(".keydex-inline-block");
    expect(globalStyles).toContain(":where(button, input, textarea, select, a, [role=\"button\"], [tabindex]):focus");
    expect(globalStyles).toContain("outline: none");
    expect(markdown).toContain(".keydex-markdown");
    expect(markdown).toContain("var(--font-mono)");
    expect(markdown).toContain("overflow-x: auto");
    expect(markdown).toContain("overflow-y: visible");
  });

  it("wraps ordinary Markdown tables while preserving wide-table scrolling", () => {
    const markdown = readFileSync(resolve(stylesDir, "markdown.css"), "utf8");
    const baseTable = markdown.match(/\.keydex-markdown :where\(table\)\s*{(?<body>[^}]*)}/s)?.groups?.body ?? "";
    const scrollTable = markdown.match(/\[data-markdown-table-layout="scroll"\] > table\)\s*{(?<body>[^}]*)}/s)?.groups?.body ?? "";
    const wrappedCells = markdown.match(/\[data-markdown-table-layout="wrap"\] th,[^}]*\)\s*{(?<body>[^}]*)}/s)?.groups?.body ?? "";

    expect(baseTable).toContain("width: 100%");
    expect(baseTable).toContain("min-width: 0");
    expect(baseTable).toContain("table-layout: auto");
    expect(scrollTable).toContain("min-width: max-content");
    expect(wrappedCells).toContain("overflow-wrap: anywhere");
    expect(wrappedCells).toContain("white-space: normal");
    expect(wrappedCells).toContain("word-break: break-word");
  });

  it("keeps the Git workbench aligned with the Keydex visual foundation", () => {
    const gitHost = readSource("renderer/features/git/components/GitToolWindow.module.css");
    const diffTheme = readSource("renderer/styles/themes/default-color-scheme.css");
    const gitHistory = readSource("renderer/features/git/components/GitHistoryView.module.css");
    const gitMenu = readSource("renderer/components/layout/Titlebar/ProjectGitMenu.module.css");
    const gitComponentStyles = collectCssFiles(resolve(srcDir, "renderer/features/git/components"))
      .map((filePath) => readFileSync(filePath, "utf8"))
      .join("\n");

    expect(gitHost).toContain("--git-control-height: 30px");
    expect(gitHost).toContain("--git-emphasis-color: var(--color-text-1)");
    expect(gitHost).toContain("--git-emphasis-contrast: var(--color-text-inverse)");
    expect(gitHost).toContain("--color-accent-1: var(--git-emphasis-color)");
    expect(gitHost).not.toContain("--color-accent-1: var(--color-accent)");
    expect(gitHost).toMatch(/\.root \.tab\s*{[^}]*border-radius:\s*var\(--radius-pill\)/s);
    expect(gitHost).toMatch(/\.root \*::-webkit-scrollbar-thumb\s*{[^}]*border-radius:\s*var\(--radius-pill\)/s);
    expect(gitHost).toMatch(/\.root \*::-webkit-scrollbar\s*{[^}]*width:\s*10px[^}]*height:\s*10px/s);
    expect(gitHost).toMatch(/\.root,[\s\S]*?\.root \*\s*{[^}]*scrollbar-width:\s*auto/s);
    expect(gitHistory).toMatch(/\.scroller\s*{[^}]*scrollbar-width:\s*auto/s);
    expect(gitComponentStyles).not.toContain("scrollbar-width: thin");
    expect(gitHost).toMatch(/\.separator:hover::before,[\s\S]*?\.separator\[data-dragging="true"\]::before\s*{[^}]*background:\s*color-mix\(in srgb, var\(--color-text-3\) 42%, transparent\)/s);
    expect(gitMenu).toContain("--color-accent-1: var(--color-text-1)");
    expect(gitMenu).not.toContain("--color-accent-1: var(--color-accent)");
    expect(gitMenu).toMatch(/\.refTree::-webkit-scrollbar-track,[\s\S]*?\.helpBody::-webkit-scrollbar-track\s*{[^}]*background:\s*transparent/s);
    expect(gitMenu).toMatch(/\.refTree::-webkit-scrollbar,[\s\S]*?\.helpBody::-webkit-scrollbar\s*{[^}]*width:\s*10px[^}]*height:\s*10px/s);
    expect(gitHost).toContain("background: var(--color-bg-elevated)");
    expect(diffTheme).toContain("--diff-added-bg");
    expect(diffTheme).toContain("--diff-removed-bg");
    expect(diffTheme).not.toContain("color-mix(in srgb, #2b8a57");
    expect(diffTheme).not.toContain("color-mix(in srgb, #d14343");
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

  it("keeps collapsed workbench history scrollbar outside session buttons", () => {
    const sider = readSource("renderer/components/layout/Sider/Sider.module.css");

    expect(sider).toMatch(/\.sider\[data-collapsed="true"\]\s+\.workbenchHistory\s*{[^}]*width:\s*100%/s);
    expect(sider).toMatch(/\.sider\[data-collapsed="true"\]\s+\.workbenchHistory\s*{[^}]*justify-self:\s*stretch/s);
  });

  it("covers full collapsed session buttons with the footer feather", () => {
    const sider = readSource("renderer/components/layout/Sider/Sider.module.css");

    expect(sider).toMatch(/\.footer::before\s*{[^}]*right:\s*12px/s);
    expect(sider).toMatch(/\.sider\[data-collapsed="true"\]\s+\.footer::before\s*{[^}]*right:\s*0/s);
  });

  it("keeps project actions inside the project row and reveals them on hover or focus", () => {
    const sider = readSource("renderer/components/layout/Sider/Sider.module.css");
    const siderComponent = readSource("renderer/components/layout/Sider/Sider.tsx");

    expect(sider).toMatch(/\.sectionTitleRow\s*{[^}]*position:\s*relative[^}]*grid-template-columns:\s*minmax\(0, 1fr\)[^}]*border-radius:\s*var\(--radius-pill\)/s);
    expect(sider).toMatch(/\.sectionHeaderActions\s*{[^}]*position:\s*absolute[^}]*right:\s*8px[^}]*opacity:\s*0[^}]*pointer-events:\s*none/s);
    expect(sider).toMatch(/\.sectionTitleRow:hover \.sectionHeaderActions,[\s\S]*\.sectionTitleRow:focus-within \.sectionHeaderActions,[\s\S]*\.sectionTitleRow\[data-menu-open="true"\] \.sectionHeaderActions\s*{[^}]*opacity:\s*1[^}]*pointer-events:\s*auto/s);
    expect(sider).toMatch(/\.sectionTitle\.projectSectionTitle\s*{[^}]*box-sizing:\s*border-box[^}]*max-width:\s*100%[^}]*padding:\s*2px 9px/s);
    expect(sider).toMatch(/\.sectionTitleRow:hover \.projectSectionTitle,[\s\S]*\.sectionTitleRow:focus-within \.projectSectionTitle,[\s\S]*\.sectionTitleRow\[data-menu-open="true"\] \.projectSectionTitle\s*{[^}]*padding-right:\s*60px/s);
    expect(sider).toMatch(/\.sectionTitle\.projectSectionTitle\s*>\s*span\s*{[^}]*flex:\s*1 1 auto/s);
    expect(siderComponent).not.toContain("styles.sectionChevron");
  });

  it("keeps workbench preview tabs scrollable without a visible native scrollbar", () => {
    const workbench = readSource("renderer/pages/workbench/WorkbenchModePage.module.css");

    expect(workbench).toMatch(/\.previewTabStrip\s*{[^}]*overflow-x:\s*auto/s);
    expect(workbench).toMatch(/\.previewTabStrip\s*{[^}]*overflow-y:\s*hidden/s);
    expect(workbench).toMatch(/\.previewTabStrip\s*{[^}]*scrollbar-width:\s*none/s);
    expect(workbench).toMatch(/\.previewTabStrip::-webkit-scrollbar\s*{[^}]*display:\s*none/s);
  });

  it("keeps all composer context capsules tightly wrapped in a three-row scroll viewport", () => {
    const sendBox = readSource("renderer/components/chat/SendBox/SendBox.module.css");
    const workbenchAssistant = readSource("renderer/pages/workbench/WorkbenchAssistantSurface.module.css");

    expect(sendBox).toMatch(/\.fileChips\s*{[^}]*display:\s*flex/s);
    expect(sendBox).toMatch(/\.fileChips\s*{[^}]*flex-wrap:\s*wrap/s);
    expect(sendBox).toMatch(/\.fileChips\s*{[^}]*align-content:\s*flex-start/s);
    expect(sendBox).toMatch(/\.fileChips\s*{[^}]*--sendbox-context-chip-viewport-max-height:\s*100px/s);
    expect(sendBox).toMatch(
      /\.fileChips\s*{[^}]*max-height:\s*var\(--sendbox-context-chip-viewport-max-height\)/s,
    );
    expect(sendBox).toMatch(/\.fileChips\s*{[^}]*overflow-y:\s*auto/s);
    expect(sendBox).toMatch(/\.fileChips\s*{[^}]*scrollbar-gutter:\s*stable/s);
    expect(sendBox).toMatch(
      /\.quoteChipWrapper,\s*\.fileChipWrapper,\s*\.skillChipWrapper\s*{[^}]*width:\s*auto[^}]*flex:\s*0 1 auto/s,
    );
    expect(sendBox).toMatch(
      /\.root\[data-variant="keydex"\]\s+\.input\s*{[^}]*flex:\s*0 0 auto/s,
    );
    expect(workbenchAssistant).toMatch(/--sendbox-keydex-input-min-height:\s*44px/);
    expect(workbenchAssistant).toMatch(/--sendbox-keydex-input-max-height:\s*188px/);
    expect(workbenchAssistant).toMatch(/--workbench-assistant-input-open-max-height:\s*348px/);
    expect(workbenchAssistant).toMatch(
      /\.composerFrame\[data-compose-open="true"\]\s*{[^}]*minmax\([^)]*--workbench-assistant-input-open-height[^)]*\),\s*auto\s*\)/s,
    );
    expect(workbenchAssistant).toMatch(
      /\.inputSurface\[data-compose-open="true"\]\s*{[^}]*height:\s*auto[^}]*max-height:\s*var\(--workbench-assistant-input-open-max-height\)/s,
    );
    expect(workbenchAssistant).toMatch(
      /\.composerFrame\[data-compose-open="true"\]\s+\.composerShell,\s*\.composerFrame\[data-compose-open="true"\]\s+\.composer\s*{[^}]*height:\s*auto/s,
    );
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
    const messageText = readSource("renderer/pages/conversation/messages/MessageText.module.css");
    const sendBox = readSource("renderer/components/chat/SendBox/SendBox.module.css");
    const filePreview = readSource("renderer/components/workspace/FilePreview.module.css");
    const diffSurface = readSource("renderer/components/diff/DiffSurface.module.css");

    expect(layout).toContain("overflow-y: auto");
    expect(layout).toContain("overflow-x: hidden");
    expect(layout).toContain("scrollbar-gutter: stable");
    expect(layout).toMatch(/\.content\[data-content="full"\]\s*{[^}]*overflow:\s*hidden/s);
    expect(layout).toMatch(/\.content\[data-content="full"\]\s*{[^}]*min-width:\s*var\(--content-min-width,\s*420px\)/s);
    expect(layout).toMatch(/\.readingColumn\[data-content="full"\]\s*{[^}]*height:\s*100%/s);
    expect(chatLayout).toMatch(/\.chatLayout\s*{[^}]*grid-template-rows:\s*auto minmax\(0,\s*1fr\) auto/s);
    expect(chatLayout).toMatch(/\.document\s*{[^}]*overflow:\s*hidden/s);
    expect(chatLayout).not.toMatch(/\.document\s*{[^}]*scrollbar-width:\s*auto/s);
    expect(chatLayout).not.toContain(".document::-webkit-scrollbar");
    expect(chatLayout).toMatch(/\.messageSurface\s*{[^}]*height:\s*100%/s);
    expect(chatLayout).toMatch(/\.messageSurface\s*{[^}]*display:\s*grid/s);
    expect(chatLayout).not.toMatch(/\.messageSurface\s*{[^}]*padding/s);
    expect(chatLayout).toMatch(/\.composerDock\s*{[^}]*position:\s*relative/s);
    expect(chatLayout).toMatch(/\.composerDock::before\s*{[^}]*bottom:\s*100%/s);
    expect(chatLayout).toMatch(/\.composerDock::before\s*{[^}]*right:\s*var\(--conversation-scrollbar-gutter-width\)/s);
    expect(chatLayout).toMatch(/\.composerDock::before\s*{[^}]*linear-gradient/s);
    expect(chatLayout).toMatch(/--composer-fade-height:\s*44px/);
    expect(chatLayout).toMatch(/\.composerDock\s*{[^}]*grid-template-rows:\s*auto auto/s);
    expect(chatLayout).toMatch(/\.composerAccessory\s*{[^}]*position:\s*relative/s);
    expect(chatLayout).not.toMatch(/\.composerAccessory\s*{[^}]*bottom:\s*calc\(100%/s);
    expect(chatLayout).not.toMatch(/\.composerDock\s*{[^}]*position:\s*fixed/s);
    expect(chatLayout).not.toContain("--conversation-composer-reserved-height");
    expect(messageList).toMatch(/\.root\s*{[^}]*height:\s*100%/s);
    expect(messageList).toMatch(/\.scroller\s*{[^}]*overflow-y:\s*auto/s);
    expect(messageList).toMatch(/\.scroller\s*{[^}]*scrollbar-gutter:\s*stable both-edges/s);
    expect(messageList).toMatch(/\.scroller\s*{[^}]*scrollbar-width:\s*auto/s);
    expect(messageList).toMatch(/\.scroller::-webkit-scrollbar\s*{[^}]*width:\s*11px/s);
    expect(messageList).not.toMatch(/\.scroller\s*{[^}]*overflow:\s*visible/s);
    expect(messageList).toMatch(/\.list\s*{[^}]*display:\s*block/s);
    expect(messageList).toMatch(/\.list\s*{[^}]*width:\s*min\(var\(--composer-width\)/s);
    expect(messageList).toMatch(/\.root\s*{[^}]*--message-list-bottom-buffer:\s*80px/s);
    expect(messageList).toMatch(
      /\.list\s*{[^}]*padding:\s*22px var\(--turn-navigator-list-padding-right,\s*0px\) var\(--message-list-bottom-buffer\) 0/s,
    );
    expect(messageList).toMatch(/--turn-navigator-edge:\s*clamp\(8px/s);
    expect(messageList).toMatch(/--turn-navigator-gap:\s*clamp\(8px/s);
    expect(messageList).toMatch(/--turn-navigator-right:\s*max\(\s*var\(--turn-navigator-edge\)/s);
    expect(messageList).not.toContain("@container (max-width: 1052px)");
    expect(messageList).toMatch(/\.virtualList\s*{[^}]*padding-bottom:\s*0/s);
    expect(messageList).toMatch(/\.virtualBottomSpacer\s*{[^}]*height:\s*var\(--message-list-bottom-buffer\)/s);
    expect(messageList).toMatch(/\.item\[data-kind="a2ui"\]\s*{[^}]*content-visibility:\s*auto/s);
    expect(messageList).toMatch(/\.item\[data-kind="a2ui"\]\s*{[^}]*contain-intrinsic-size:\s*auto 560px/s);
    expect(messageList).not.toMatch(/\.list\s*{[^}]*justify-content:\s*flex-end/s);
    expect(messageList).not.toContain("scrollSeekPlaceholder");
    expect(messageText).not.toMatch(/\.codeViewport\s*{[^}]*transition:\s*[^}]*max-height/s);
    expect(messageText).toMatch(/\.codeViewport\s*{[^}]*contain:\s*layout paint style/s);
    expect(messageText).not.toMatch(/content-visibility:\s*auto/);
    expect(messageText).not.toContain("contain-intrinsic-size");
    expect(messageText).toMatch(/\.codeViewport\[data-animating="true"\]\s*{[^}]*will-change:\s*height/s);
    expect(messageText).toContain("--message-code-panel-bg: var(--surface-muted)");
    expect(messageText).toContain("--message-code-content-bg: var(--color-bg-elevated)");
    expect(messageText).toContain("--message-code-border: color-mix(in srgb, var(--color-border-default) 84%, transparent)");
    expect(messageText).toContain("--message-code-inner-edge");
    expect(messageText).toMatch(/\.codeHeader\s*{[^}]*background:\s*var\(--message-code-panel-bg\)/s);
    expect(messageText).toMatch(/\.codeBlock\s*{[^}]*background:\s*var\(--message-code-content-bg\)/s);
    expect(messageText).toMatch(/\.codeViewport\s*{[^}]*background:\s*var\(--message-code-content-bg\)/s);
    expect(messageText).toMatch(/\.codeFooter\s*{[^}]*width:\s*fit-content/s);
    expect(messageText).toMatch(/\.codeFooter\s*{[^}]*border:\s*0/s);
    expect(messageText).toMatch(/\.codeFooter\s*{[^}]*background:\s*transparent/s);
    expect(messageText).toMatch(/\.codeFooter\s*{[^}]*box-shadow:\s*none/s);
    expect(messageText).not.toMatch(/\.codeFooter\s*{[^}]*background:\s*var\(--message-code-panel-bg\)/s);
    expect(messageText).toMatch(/\.codeGenerationFooter\s*{[^}]*width:\s*fit-content/s);
    expect(messageText).toMatch(/\.codeGenerationFooter\s*{[^}]*border:\s*0/s);
    expect(messageText).toMatch(/\.codeGenerationFooter\s*{[^}]*background:\s*transparent/s);
    expect(messageText).not.toMatch(/\.codeGenerationFooter\s*{[^}]*border-top:/s);
    expect(messageText).not.toMatch(/\.codeGenerationFooter\s*{[^}]*background:\s*var\(--message-code-panel-bg\)/s);
    expect(messageText).toMatch(
      /\.codeBlock\[data-has-text-footer="true"\]\s+\.codeViewport\s*{[^}]*inset 1px 0 0 var\(--message-code-inner-edge\)[^}]*inset -1px 0 0 var\(--message-code-inner-edge\)/s,
    );
    expect(messageText).toMatch(/\.codeViewport\s*{[^}]*inset 0 0 0 1px var\(--message-code-inner-edge\)/s);
    [".htmlPreview", ".mathPreview", ".mermaidPreview"].forEach((selector) => {
      expect(messageText).toMatch(new RegExp(`${escapeRegExp(selector)}\\s*{[^}]*background:\\s*var\\(--color-bg-elevated\\)`, "s"));
      expect(messageText).toMatch(new RegExp(`${escapeRegExp(selector)}\\s*{[^}]*inset 0 0 0 1px var\\(--message-code-inner-edge\\)`, "s"));
    });
    expect(messageText).toContain(".codeViewLoading");
    expect(messageText).toMatch(/\.codeViewSwitch\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\) minmax\(0,\s*1fr\)/s);
    expect(messageText).toMatch(/\.codeViewSwitch::before\s*{[^}]*transition:\s*transform 160ms var\(--motion-ease-standard\)/s);
    expect(messageText).toMatch(/\.mermaidFullscreenShell\s*{[^}]*position:\s*relative/s);
    expect(messageText).toMatch(/\.mermaidFullscreenShell\s+\.mermaidControls\s*{[^}]*position:\s*absolute/s);
    expect(messageText).toMatch(/\.mermaidPreview\[data-size="fullscreen"\]\s*{[^}]*--mermaid-canvas-padding-x:\s*160px/s);
    expect(messageText).toMatch(
      /\.mermaidPreview\[data-size="fullscreen"\]\s+\.mermaidSvg\s*{[^}]*padding:\s*var\(--mermaid-canvas-padding-y\) var\(--mermaid-canvas-padding-x\)/s,
    );
    expect(messageText).not.toContain(".codeTextButton");
    expect(messageText).not.toContain('data-placement="detached"');
    expect(messageText).toMatch(/\.actions\[data-message-kind="assistant"\]\s+\.actionButton\s*{[^}]*width:\s*24px/s);
    expect(messageText).toMatch(/\.actions\[data-message-kind="assistant"\]\s+\.actionButton span\s*{[^}]*display:\s*none/s);
    expect(messageList).toMatch(
      /\.turnGroup:hover\s+\.turnActionRow\s+\[data-turn-footer-details="true"\],[^{]+\.runtimeTurnFooter:focus-within\s+\.turnActionRow\s+\[data-turn-footer-details="true"\]\s*{[^}]*opacity:\s*1/s,
    );
    expect(filePreview).toMatch(/\.mermaidPane\s*{[^}]*place-items:\s*stretch/s);
    expect(filePreview).toMatch(/\.mermaidPane\s*{[^}]*box-sizing:\s*border-box/s);
    expect(filePreview).toMatch(
      /\.body\[data-chrome="panel"\]\s+\.documentCanvas,\s*\.body\[data-chrome="panel"\]\s+\.documentColumn\s*{[^}]*height:\s*100%/s,
    );
    expect(filePreview).toMatch(
      /\.body\[data-chrome="panel"\]\s+\.documentColumn\s*>\s*\.previewScrollShell,[^{]+\.body\[data-chrome="panel"\]\s+\.documentColumn\s*>\s*\.mermaidPane,[^{]+\.body\[data-chrome="panel"\]\s+\.documentColumn\s*>\s*\.imagePane\s*{[^}]*height:\s*100%/s,
    );
    expect(filePreview).toMatch(
      /\.body\[data-chrome="panel"\]\s+\.documentColumn\s*>\s*\.previewScrollShell\s*>\s*\.markdownPane,[^{]+\.body\[data-chrome="panel"\]\s+\.documentColumn\s*>\s*\.previewScrollShell\s*>\s*\.htmlPane,[^{]+\.body\[data-chrome="panel"\]\s+\.documentColumn\s*>\s*\.previewScrollShell\s*>\s*\.imagePane\s*{[^}]*height:\s*100%/s,
    );
    expect(filePreview).toMatch(/\.mermaidSvg\s*{[^}]*place-items:\s*start center/s);
    expect(filePreview).toMatch(/\.mermaidSvg\s*{[^}]*align-items:\s*safe center/s);
    expect(filePreview).toMatch(/\.mermaidSvg\s*{[^}]*justify-items:\s*safe center/s);
    expect(filePreview).toMatch(/\.mermaidSvg\s*{[^}]*--mermaid-canvas-padding-x:\s*160px/s);
    expect(filePreview).toMatch(/\.mermaidSvg\s*{[^}]*scroll-padding:\s*var\(--mermaid-canvas-padding-y\) var\(--mermaid-canvas-padding-x\)/s);
    expect(filePreview).toMatch(/\.mermaidSvg\[data-interactive="true"\]\s*{[^}]*cursor:\s*grab/s);
    expect(filePreview).toMatch(/\.mermaidSvg\[data-interactive="true"\]\s*{[^}]*touch-action:\s*none/s);
    expect(filePreview).toMatch(/\.mermaidSvg\[data-dragging="true"\]\s*{[^}]*cursor:\s*grabbing/s);
    expect(filePreview).not.toMatch(/\.mermaidSvgContent\s*{[^}]*zoom:\s*var\(--mermaid-scale,\s*1\)/s);
    expect(filePreview).toMatch(
      /\.mermaidSvgContent\s*{[^}]*margin:\s*var\(--mermaid-canvas-padding-y\) var\(--mermaid-canvas-padding-x\)/s,
    );
    expect(filePreview).toMatch(/\.mermaidSvgContent\[data-sized="false"\]\s*{[^}]*zoom:\s*var\(--mermaid-scale,\s*1\)/s);
    expect(filePreview).toMatch(/\.mermaidSvgContent\[data-sized="true"\]\s*{[^}]*width:\s*var\(--mermaid-render-width\)/s);
    expect(filePreview).toMatch(/\.mermaidSvgContent\[data-sized="true"\]\s+svg\s*{[^}]*width:\s*100% !important/s);
    expect(filePreview).not.toMatch(/\.mermaidSvgContent svg\s*{[^}]*width:\s*auto !important/s);
    expect(filePreview).toMatch(/\.mermaidSvgContent svg\s*{[^}]*max-width:\s*none !important/s);
    expect(filePreview).toMatch(/\.mermaidControls\s*{[^}]*position:\s*absolute/s);
    expect(filePreview).toMatch(
      /\.markdownPane\s+\[data-markdown-code-frame="true"\]\s*{[^}]*background:\s*var\(--surface-muted\)/s,
    );
    expect(filePreview).toMatch(
      /\.markdownPane\s+\[data-markdown-code-frame="true"\]\s+pre\[data-testid="markdown-code-viewport"\]\s*{[^}]*background:\s*var\(--color-bg-elevated\)/s,
    );
    expect(filePreview).toMatch(/\.sourceViewer\s*{[^}]*background:\s*var\(--color-bg-elevated\)/s);
    expect(filePreview).toMatch(/\.sourceLineNumbers\s*{[^}]*background:\s*var\(--surface-muted\)/s);
    expect(filePreview).not.toMatch(/\.diff(?:Pane|Line)/s);
    expect(diffSurface).toMatch(/\.surface\[data-profile="preview"\]\s*{[^}]*background:\s*var\(--diff-surface-bg\)/s);
    expect(filePreview).not.toContain("background: var(--code-bg)");
    expect(filePreview).not.toContain("background: #fff");
    expect(sider).toMatch(/\.historyMeta\s*{[^}]*white-space:\s*nowrap/s);
    expect(sider).toMatch(/\.historyRow\s*{[^}]*position:\s*relative/s);
    expect(sider).toMatch(/\.historyRow\[data-active="true"\]\s*{[^}]*background:\s*var\(--sidebar-pill-active\)/s);
    expect(sider).not.toContain(".sectionChevron");
    expect(sider).toMatch(/\.sectionItems\s*{[^}]*grid-template-rows:\s*1fr/s);
    expect(sider).toMatch(/\.sectionItems\[data-expanded="false"\]\s*{[^}]*grid-template-rows:\s*0fr/s);
    expect(sider).toMatch(
      /\.section\[data-kind="workspace"\]\s+\.historyItem,[\s\S]*?\.section\[data-kind="pinned"\]\s+\.historyItem\s*{[^}]*padding-left:\s*31px/s,
    );
    expect(sider).toMatch(/--sidebar-footer-feather-height:\s*38px/);
    expect(sider).not.toMatch(/\.history\s*{[^}]*mask-image/s);
    expect(sider).toMatch(/\.sider\[data-collapsed="true"\]\s+\.history\s*{[^}]*overflow-x:\s*hidden/s);
    expect(sider).toMatch(/\.sider\[data-collapsed="true"\]\s+\.history\s*{[^}]*scrollbar-gutter:\s*auto/s);
    expect(sider).toMatch(/\.footer\s*{[^}]*margin-top:\s*-6px/s);
    expect(sider).toMatch(/\.footer::before\s*{[^}]*right:\s*12px/s);
    expect(sider).toMatch(/\.footer::before\s*{[^}]*bottom:\s*100%/s);
    expect(sider).toMatch(/\.footer::before\s*{[^}]*linear-gradient/s);
    expect(sider).toMatch(/\.footer::before\s*{[^}]*opacity:\s*0/s);
    expect(sider).toMatch(/\.sider\[data-footer-feather="true"\]\s+\.footer::before\s*{[^}]*opacity:\s*1/s);
    expect(sendBox).toMatch(/\.root\[data-variant="keydex"\]\s*{[^}]*overflow:\s*visible/s);
    expect(sendBox).toMatch(/\.contextBar\s*{[^}]*overflow:\s*visible/s);
    expect(sendBox).toMatch(/\.contextBar\s*{[^}]*border-bottom-left-radius:\s*19px/s);
    expect(sendBox).toMatch(/\.contextBar\s*{[^}]*inset 0 -1px 0/s);

    [fileChangeBlock, errorBlock].forEach((css) => {
      expect(css).not.toMatch(/overflow-y\s*:\s*(auto|scroll)/);
      expect(css).toContain("overflow-y: visible");
    });
    [commandBlock, toolBlock].forEach((css) => {
      expect(css).toMatch(/\.codeViewport\s*{[^}]*max-height:\s*144px/s);
      expect(css).toMatch(/\.sectionHeader\[data-kind="output"\]\s+\+\s+\.codeViewport\s*{[^}]*max-height:\s*260px/s);
      expect(css).toMatch(/\.sectionHeader\s*{[^}]*background:\s*transparent/s);
      expect(css).toMatch(
        /\.outputHeader\s*{[^}]*color:\s*color-mix\(in srgb, var\(--color-text-secondary\) 82%, transparent\)/s,
      );
      expect(css).not.toContain("var(--color-accent) 54%");
      expect(css).not.toContain("var(--color-success-6) 56%");
      expect(css).toMatch(/\.codeViewport\s*{[^}]*overflow-y:\s*auto/s);
      expect(css).toMatch(/\.codeViewport\s*{[^}]*background:\s*transparent/s);
      expect(css).toMatch(/\.codeViewport\s*{[^}]*box-shadow:\s*none/s);
      expect(css).toContain("overflow: visible");
      expect(css).not.toContain("background: var(--code-bg)");
    });
    expect(commandBlock).toMatch(
      /\.outputInner\s*{[^}]*background:\s*color-mix\(in srgb, var\(--surface-muted\) 72%, var\(--color-bg-elevated\)\)/s,
    );
    expect(toolBlock).toMatch(
      /\.detailsInner\s*{[^}]*background:\s*color-mix\(in srgb, var\(--surface-muted\) 72%, var\(--color-bg-elevated\)\)/s,
    );
    expect(commandBlock).toMatch(/\.outputInner\s*{[^}]*box-shadow:\s*none/s);
    expect(toolBlock).toMatch(/\.detailsInner\s*{[^}]*box-shadow:\s*none/s);
    expect(fileChangeBlock).toMatch(/\.previewHeader\s*{[^}]*background:\s*var\(--surface-muted\)/s);
    expect(fileChangeBlock).toMatch(/\.errorHeader\s*{[^}]*background:\s*var\(--surface-muted\)/s);
    expect(fileChangeBlock).toMatch(/\.diff,\s*\.diffPreview\s*{[^}]*background:\s*var\(--color-bg-elevated\)/s);
    expect(fileChangeBlock).toMatch(/\.previewBlock\s*{[^}]*0 8px 22px rgb\(15 23 42 \/ 5%\)/s);
    expect(fileChangeBlock).toMatch(/\.diff,\s*\.diffPreview\s*{[^}]*inset 0 0 0 1px color-mix\(in srgb, var\(--color-border-default\) 34%, transparent\)/s);
    expect(commandBlock).not.toContain("max-height: 280px");
    expect(fileChangeBlock).not.toContain("max-height: 320px");
    expect(messageGroup).toContain("border: 0");
    [messageGroup, commandBlock, toolBlock].forEach((css) => {
      expect(css).not.toContain("background: var(--inline-block-bg)");
      expect(css).toContain("animation:");
    });
  });

  it("keeps conversation local scroll owners visibly scrollable", () => {
    const messageText = readSource("renderer/pages/conversation/messages/MessageText.module.css");
    const jsonTree = readSource("renderer/components/json/JsonTreeViewer.module.css");
    const composerAccessory = readSource("renderer/pages/conversation/ComposerAccessory.module.css");
    const compactDiff = readSource("renderer/components/diff/wrappers/CompactDiffView.module.css");
    const diffView = readSource("renderer/components/diff/KeydexDiffView.module.css");
    const pierreCodeView = readSource("renderer/components/diff/engine/PierreCodeView.module.css");

    expect(messageText).toMatch(/\.codeViewport\s*{[^}]*overflow-x:\s*auto;[^}]*overflow-y:\s*hidden/s);
    expect(messageText).toMatch(
      /\.codeViewport\[data-collapsed="true"\]\s*{[^}]*overflow-x:\s*auto;[^}]*overflow-y:\s*hidden/s,
    );
    expect(messageText).toMatch(
      /\.codeViewport::-webkit-scrollbar,[\s\S]*?\.mermaidPreview\[data-size="fullscreen"\]::-webkit-scrollbar\s*{[^}]*width:\s*9px;[^}]*height:\s*9px/s,
    );
    expect(messageText).toMatch(/\.fullscreenMarkdown\s*{[^}]*overflow:\s*auto/s);
    expect(jsonTree).toMatch(
      /\.treeViewport::-webkit-scrollbar,[\s\S]*?\.primitiveValue::-webkit-scrollbar\s*{[^}]*width:\s*9px;[^}]*height:\s*9px/s,
    );
    expect(composerAccessory).toMatch(
      /\.fileChangeCardList\s*{[^}]*overflow-y:\s*auto;[^}]*scrollbar-gutter:\s*stable;[^}]*scrollbar-width:\s*thin/s,
    );
    expect(composerAccessory).toMatch(
      /\.fileChangeCardList::-webkit-scrollbar\s*{[^}]*width:\s*9px;[^}]*height:\s*9px/s,
    );
    expect(compactDiff).toMatch(
      /\.viewer\s*\{[^}]*height:\s*clamp\(180px, 35vh, 420px\);[^}]*overflow:\s*hidden/s,
    );
    expect(compactDiff).toMatch(
      /\.viewer\s+:global\(\[data-keydex-diff-surface\]\[data-profile="compact"\]\)\s*\{[^}]*height:\s*100%;[^}]*min-height:\s*0;[^}]*overflow:\s*hidden/s,
    );
    expect(diffView).toMatch(
      /\.patchViewport\s*\{[^}]*overflow-y:\s*auto;[^}]*scrollbar-gutter:\s*stable/s,
    );
    expect(diffView).not.toMatch(
      /\.patchViewport\s*\{[^}]*scrollbar-(?:width|color):/s,
    );
    expect(diffView).toMatch(
      /\.patchViewport::-webkit-scrollbar\s*\{[^}]*width:\s*12px;[^}]*height:\s*12px/s,
    );
    expect(diffView).toMatch(
      /\.patchViewport::-webkit-scrollbar-thumb\s*\{[^}]*border:\s*2px solid transparent;/s,
    );
    expect(pierreCodeView).toMatch(
      /\.scrollViewport\s*\{[^}]*overflow:\s*auto;[^}]*scrollbar-gutter:\s*stable;[^}]*scrollbar-width:\s*thin/s,
    );
    expect(pierreCodeView).toMatch(
      /\.scrollViewport::-webkit-scrollbar\s*\{[^}]*width:\s*9px;[^}]*height:\s*9px/s,
    );
  });

  it("keeps settings workspace on its own Keydex-like layout baseline", () => {
    const mainLayout = readSource("renderer/components/layout/Layout.module.css");
    const sider = readSource("renderer/components/layout/Sider/Sider.module.css");
    const resizeHandle = readSource("renderer/components/layout/SidebarResizeHandle.module.css");
    const rightResizeHandle = readSource("renderer/components/layout/RightSidebarResizeHandle.module.css");
    const titlebar = readSource("renderer/components/layout/Titlebar/Titlebar.module.css");
    const workspaceSelector = readSource("renderer/components/workspace/WorkspaceSelector.module.css");
    const shell = readSource("renderer/pages/settings/SettingsShell.module.css");
    const model = readSource("renderer/pages/settings/model/ModelSettingsPage.module.css");
    const usage = readSource("renderer/pages/settings/usage/UsageStatsPage.module.css");

    expect(mainLayout).toMatch(/\.body\s*{[^}]*display:\s*flex/s);
    expect(mainLayout).toMatch(/\.content\s*{[^}]*border:\s*1px solid var\(--color-border-2\)/s);
    expect(mainLayout).toMatch(/\.content\s*{[^}]*border-radius:\s*12px 0 0 12px/s);
    expect(mainLayout).not.toMatch(/\.content\s*{[^}]*border-top-right-radius/s);
    expect(mainLayout).not.toMatch(/\.content\s*{[^}]*border-bottom-right-radius/s);
    expect(mainLayout).toMatch(/\.rightSidebar\s*{[^}]*background:\s*var\(--surface-bg\)/s);
    expect(mainLayout).toMatch(/\.rightSidebar\s*{[^}]*border:\s*1px solid var\(--color-border-2\)/s);
    expect(mainLayout).toMatch(/\.rightSidebar\s*{[^}]*border-left:\s*0/s);
    expect(mainLayout).toMatch(/\.shell\[data-right-sidebar-motion="true"\]\s+\.content\s*{[^}]*flex-grow 220ms var\(--motion-ease-standard\)/s);
    expect(mainLayout).toMatch(/\.shell\[data-right-sidebar-motion="true"\]\s+\.rightSidebar\s*{[^}]*width 220ms var\(--motion-ease-standard\)/s);
    expect(mainLayout).toMatch(/\.shell\[data-right-sidebar-motion="true"\]\s+\.rightSidebar\s*{[^}]*flex-grow 220ms var\(--motion-ease-standard\)/s);
    expect(mainLayout).toMatch(/\.shell\[data-right-sidebar-motion="true"\]\s+\.rightSidebar\s*{[^}]*flex-basis 220ms var\(--motion-ease-standard\)/s);
    expect(mainLayout).toMatch(/\.shell\[data-right-sidebar="closed"\]\s+\.rightSidebar\s*{[^}]*width:\s*0/s);
    expect(mainLayout).toMatch(/\.shell\[data-right-sidebar="closed"\]\s+\.rightSidebar\s*{[^}]*flex-basis:\s*0/s);
    expect(mainLayout).toMatch(/\.shell\[data-right-sidebar="open"\]\[data-right-sidebar-mode="maximized"\]\s+\.rightSidebar\s*{[^}]*width:\s*var\(--right-sidebar-width\)/s);
    expect(mainLayout).toMatch(/\.shell\[data-right-sidebar="open"\]\[data-right-sidebar-mode="maximized"\]\s+\.rightSidebar\s*{[^}]*flex-grow:\s*1/s);
    expect(mainLayout).not.toMatch(/\.shell\[data-right-sidebar="open"\]\[data-right-sidebar-mode="maximized"\]\s+\.rightSidebar\s*{[^}]*width:\s*auto/s);
    expect(mainLayout).not.toMatch(/\.shell\[data-right-sidebar="open"\]\[data-right-sidebar-mode="maximized"\]\s+\.rightSidebar\s*{[^}]*flex:\s*1 1 auto/s);
    expect(mainLayout).not.toContain("rightSidebarEnter");
    expect(titlebar).not.toMatch(/\.titlebar\s*{[^}]*border-bottom/s);
    expect(titlebar).toMatch(/\.titlebar\s*{[^}]*background:\s*var\(--sidebar-bg\)/s);
    expect(titlebar).toMatch(
      /--titlebar-mode-switch-width:\s*calc\(\s*var\(--sidebar-default-width\)\s*-\s*var\(--sidebar-collapsed-width\)\s*\)/s,
    );
    expect(titlebar).toMatch(
      /\.modeSwitch\s*{[^}]*width:\s*max\(\s*248px,\s*var\(--titlebar-mode-switch-width\)\s*\)/s,
    );
    expect(titlebar).toMatch(
      /\.modeSwitch\s*{[^}]*background:\s*color-mix\([^}]*var\(--control-pill-bg\)/s,
    );
    expect(titlebar).toMatch(/\.modeSwitch::before\s*{[^}]*box-shadow:[^}]*0 3px 10px[^}]*inset 0 1px 0/s);
    expect(workspaceSelector).toMatch(
      /\.root\[data-variant="titlebar"\]\s+\.trigger\s*{[^}]*background:\s*var\(--control-pill-bg\)/s,
    );
    expect(workspaceSelector).toMatch(
      /\.root\[data-variant="titlebar"\]\s+\.trigger\s*{[^}]*color:\s*var\(--color-text-1\)/s,
    );
    expect(workspaceSelector).toMatch(
      /\.root\[data-variant="titlebar"\]\s+\.trigger svg:first-child\s*{[^}]*var\(--color-primary-6\) 44%/s,
    );
    expect(sider).toMatch(/\.sider\s*{[^}]*width:\s*var\(--sidebar-width\)/s);
    expect(sider).toMatch(/\.sider\s*{[^}]*flex:\s*0 0 var\(--sidebar-width\)/s);
    expect(sider).not.toContain("border-right:");
    expect(resizeHandle).toMatch(/\.handle::before\s*{[^}]*top:\s*12px/s);
    expect(resizeHandle).toMatch(/\.handle::before\s*{[^}]*bottom:\s*12px/s);
    expect(resizeHandle).toMatch(/\.handle:hover::before,[^{]+\.handle:focus-visible::before,[^{]+\.handle\[data-dragging="true"\]::before\s*{[^}]*background:/s);
    expect(resizeHandle).not.toMatch(/\.handle:hover::before,[^{]+\.handle:focus-visible::before,[^{]+\.handle\[data-dragging="true"\]::before\s*{[^}]*width:\s*3px/s);
    expect(rightResizeHandle).toMatch(/\.handle::before\s*{[^}]*top:\s*0/s);
    expect(rightResizeHandle).toMatch(/\.handle::before\s*{[^}]*bottom:\s*0/s);
    expect(rightResizeHandle).toMatch(
      /\.root\s*{[^}]*flex:\s*0 0 0;[^}]*width:\s*0;[^}]*min-width:\s*0;[^}]*overflow:\s*visible;[^}]*background:\s*transparent/s,
    );
    expect(rightResizeHandle).toMatch(
      /\.handle\s*{[^}]*position:\s*absolute;[^}]*left:\s*-8px;[^}]*width:\s*16px/s,
    );
    expect(rightResizeHandle).toMatch(/\.handle:hover::before,[^{]+\.handle:focus-visible::before,[^{]+\.handle\[data-dragging="true"\]::before\s*{[^}]*background:/s);
    expect(rightResizeHandle).not.toMatch(/\.handle:hover::before,[^{]+\.handle:focus-visible::before,[^{]+\.handle\[data-dragging="true"\]::before\s*{[^}]*width:\s*3px/s);
    expect(shell).toMatch(/\.shell\s*{[^}]*grid-template-rows:\s*var\(--titlebar-height\) minmax\(0,\s*1fr\)/s);
    expect(shell).toMatch(/\.body\s*{[^}]*display:\s*flex/s);
    expect(shell).toMatch(/\.sidebar\s*{[^}]*width:\s*var\(--sidebar-width\)/s);
    expect(shell).toMatch(/\.sidebar\s*{[^}]*flex:\s*0 0 var\(--sidebar-width\)/s);
    expect(shell).toMatch(/\.sidebar\s*{[^}]*padding:\s*12px 7px 10px/s);
    expect(shell).not.toMatch(/\.sidebar\s*{[^}]*border-right/s);
    expect(shell).toMatch(/\.backButton\s*{[^}]*height:\s*30px/s);
    expect(shell).toMatch(/\.searchBox\s*{[^}]*height:\s*30px/s);
    expect(shell).toMatch(/\.groupLabel\s*{[^}]*font-size:\s*11px/s);
    expect(shell).toMatch(/\.menuItem\s*{\s*width:\s*100%;[^}]*height:\s*30px/s);
    expect(shell).toMatch(/\.menuItem\s*{\s*width:\s*100%;[^}]*font-size:\s*13px/s);
    expect(shell).toMatch(/\.content\s*{[^}]*overflow:\s*auto/s);
    expect(shell).toMatch(/\.content\s*{[^}]*border-radius:\s*12px 0 0 12px/s);
    expect(shell).toMatch(/\.menuItem\[data-active="true"\]\s*{[^}]*settings-selected-bg/s);
    expect(shell).not.toContain("暂未开放");
    expect(model).toContain("width: min(860px, calc(100% - 96px))");
    expect(model).toContain("padding: 76px 0 116px");
    expect(usage).toContain("width: min(826px, calc(100% - 136px))");
    expect(usage).toContain("padding: 92px 0 128px");
  });

  it("does not scale font sizes with viewport units", () => {
    for (const filePath of collectCssFiles(srcDir)) {
      const css = readFileSync(filePath, "utf8");
      expect(css, filePath).not.toMatch(/font-size\s*:[^;]*(?:vw|vh|vmin|vmax)/);
    }
  });

  it("keeps file preview source and rendered content on the same inline spacing", () => {
    const filePreview = readSource("renderer/components/workspace/FilePreview.module.css");
    const filePreviewComponent = readSource("renderer/components/workspace/FilePreview.tsx");
    const markdownDocumentRuntime = readSource("renderer/markdownRuntime/view/DocumentViewRuntime.ts");

    expect(filePreview).toMatch(/\.markdownPane\s*{[^}]*padding:\s*14px 24px 14px 8px/s);
    expect(filePreviewComponent).toContain('padding: "0 24px"');
    expect(markdownDocumentRuntime).toContain("const FILE_PREVIEW_SOURCE_GUTTER_GAP = 24;");
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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
