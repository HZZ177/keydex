import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("conversation message density CSS contract", () => {
  it("defines compact and overlay variables on MessageList and consumes them in message blocks", () => {
    const messageListCss = readCss("../src/renderer/pages/conversation/messages/MessageList.module.css");
    const messageTextCss = readCss("../src/renderer/pages/conversation/messages/MessageText.module.css");
    const toolCallCss = readCss("../src/renderer/pages/conversation/messages/ToolCallBlock.module.css");
    const fileChangeCss = readCss("../src/renderer/pages/conversation/messages/FileChangeBlock.module.css");

    expect(messageListCss).toContain('.root[data-message-list-variant="compact"]');
    expect(messageListCss).toContain('.root[data-message-list-variant="overlay"]');
    expect(messageListCss).toContain("--message-user-bubble-max-width");
    expect(messageListCss).toContain("--message-tool-detail-width");
    expect(messageTextCss).toContain("var(--message-user-bubble-max-width");
    expect(messageTextCss).toContain("var(--message-context-chip-max-width");
    expect(cssRule(messageTextCss, ".userMessage .bubble")).toContain("width: fit-content");
    expect(cssRule(messageTextCss, ".userMessage .bubble")).toContain("max-width: min(50%");
    expect(toolCallCss).toContain("var(--message-tool-detail-width");
    expect(fileChangeCss).toContain("var(--message-tool-detail-width");
  });

  it("keeps retained file-link icons at inline UI size without constraining Markdown images", () => {
    const markdownCss = readCss("../src/renderer/styles/markdown.css");
    const iconRule = cssRule(markdownCss, '.keydex-markdown :where(img[data-keydex-file-link-icon="true"])');

    expect(iconRule).toContain("width: 16px");
    expect(iconRule).toContain("height: 16px");
    expect(iconRule).toContain("max-width: 16px");
    expect(cssRule(markdownCss, ".keydex-markdown :where(img)")).toContain("max-width: 100%");
  });

  it("contains inline Mermaid output instead of exposing an intrinsic-size scroll canvas", () => {
    const markdownCss = readCss("../src/renderer/styles/markdown.css");
    const outputRule = cssRule(markdownCss, '.keydex-markdown :where([data-markdown-mermaid-output="true"])');
    const svgRule = cssRule(markdownCss, '.keydex-markdown :where([data-markdown-mermaid-output="true"] > svg)');

    expect(outputRule).toContain("display: grid");
    expect(outputRule).toContain("place-items: center");
    expect(outputRule).toContain("overflow: hidden");
    expect(outputRule).not.toContain("max-height: min(720px, 72vh)");
    expect(svgRule).toContain("max-width: 100%");
    expect(svgRule).toContain("max-height: min(560px, 56vh)");
    expect(svgRule).toContain("width: auto");
    expect(svgRule).toContain("height: auto");
  });

  it("keeps the file-preview gutter split into fold and line-number columns with bounded fold motion", () => {
    const markdownCss = readCss("../src/renderer/styles/markdown.css");
    const gutterBlock = cssRule(markdownCss, '.keydex-markdown :where([data-markdown-preview-gutter-block-id])');
    const lineNumbers = cssRule(markdownCss, '.keydex-markdown :where([data-markdown-preview-line-number="true"])');
    const foldButton = cssRule(markdownCss, '.keydex-markdown :where([data-markdown-preview-fold-button="true"])');
    const collapseMotion = cssRule(markdownCss, '.keydex-markdown :where([data-markdown-preview-fold-motion="collapse"])');
    const expandMotion = cssRule(markdownCss, '.keydex-markdown :where([data-markdown-preview-fold-motion="expand"])');

    expect(gutterBlock).toContain("grid-template-columns: 18px minmax(0, 1fr)");
    expect(gutterBlock).toContain("column-gap: 4px");
    expect(lineNumbers).toContain("white-space: pre");
    expect(foldButton).toContain("pointer-events: auto");
    expect(collapseMotion).toContain("180ms");
    expect(expandMotion).toContain("160ms");
    expect(markdownCss).toContain("@keyframes keydexMarkdownFoldContentOut");
    expect(markdownCss).toContain("@keyframes keydexMarkdownFoldContentIn");
  });

  it("keeps single-line ghost rows centered without shifting the whole title group", () => {
    const toolCallCss = readCss("../src/renderer/pages/conversation/messages/ToolCallBlock.module.css");
    const commandCss = readCss("../src/renderer/pages/conversation/messages/CommandExecutionBlock.module.css");
    const fileChangeCss = readCss("../src/renderer/pages/conversation/messages/FileChangeBlock.module.css");
    const groupCss = readCss("../src/renderer/pages/conversation/messages/MessageGroupBlock.module.css");

    expect(cssRule(toolCallCss, ".titleGroup")).not.toContain("transform:");
    expect(cssRule(commandCss, ".titleGroup")).not.toContain("transform:");
    expect(cssRule(fileChangeCss, ".titleGroup")).not.toContain("transform:");
    expect(cssRule(toolCallCss, ".header")).toContain("display: inline-flex");
    expect(cssRule(commandCss, ".header")).toContain("display: inline-flex");
    expect(cssRule(fileChangeCss, ".header")).toContain("display: inline-flex");
    expect(cssRule(toolCallCss, ".header")).not.toContain("grid-template-columns");
    expect(cssRule(commandCss, ".header")).not.toContain("grid-template-columns");
    expect(cssRule(fileChangeCss, ".header")).not.toContain("grid-template-columns");
    expect(cssRule(groupCss, ".title")).toContain("transform: translateY(var(--ghost-text-offset-y))");
  });
});

function readCss(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

function cssRule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`${escaped}\\s*\\{[^}]*\\}`, "s"))?.[0] ?? "";
}
