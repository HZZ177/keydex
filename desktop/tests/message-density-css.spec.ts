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
    expect(cssRule(messageListCss, ".scroller")).toContain(
      "padding-inline: var(--message-list-inline-padding)",
    );
    expect(cssRule(messageListCss, '.root[data-message-list-variant="compact"]')).toContain(
      "--message-list-inline-padding: 18px",
    );
    expect(cssRule(messageListCss, ".list")).toContain(
      "--message-list-content-width: min(var(--composer-width), var(--message-list-max-width), 100%)",
    );
    expect(cssRule(messageListCss, ".list")).toContain(
      "width: calc(var(--message-list-content-width) - var(--turn-navigator-content-reserved))",
    );
    expect(cssRule(messageListCss, ".list")).toContain(
      "margin-inline-start: max(0px, calc((100% - var(--message-list-content-width)) / 2))",
    );
    expect(cssRule(messageListCss, '.root[data-turn-navigator="true"]')).toContain(
      "--turn-navigator-content-reserved: var(--turn-navigator-reserved)",
    );
    expect(messageListCss).not.toMatch(/@media \(max-width: 860px\)\s*\{\s*\.list,/u);
    expect(messageListCss).toContain("--message-user-bubble-max-width");
    expect(messageListCss).toContain("--message-tool-detail-width");
    expect(messageTextCss).toContain("var(--message-user-bubble-max-width");
    expect(messageTextCss).toContain("var(--message-context-chip-max-width");
    expect(cssRule(messageTextCss, ".userMessage .bubble")).toContain("width: fit-content");
    expect(cssRule(messageTextCss, ".userMessage .bubble")).toContain("max-width: min(50%");
    expect(cssRule(messageTextCss, ".userContextItems")).toContain("width: 100%");
    expect(cssRule(messageTextCss, ".userContextItems")).toContain("justify-self: end");
    expect(cssRule(messageTextCss, ".userContextItems .contextItems")).toContain("width: 100%");
    expect(cssRule(messageTextCss, ".contextItemWrapper")).toContain(
      "max-width: var(--message-context-chip-max-width",
    );
    expect(cssRule(messageTextCss, ".contextItemChip")).toContain("max-width: 100%");
    expect(cssRule(messageTextCss, ".contextItemLabel")).toContain("text-overflow: ellipsis");
    expect(cssRule(messageTextCss, ".contextItemLabel")).toContain("white-space: nowrap");
    expect(cssRule(messageTextCss, ".contextItemPathMeta")).toContain("overflow-wrap: anywhere");
    expect(cssRule(messageTextCss, ".contextItemPathMeta")).toContain("white-space: normal");
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

  it("keeps tool file rows on one line and truncates only the file path", () => {
    const toolCallCss = readCss("../src/renderer/pages/conversation/messages/ToolCallBlock.module.css");

    expect(cssRule(toolCallCss, ".header")).toContain("width: fit-content");
    expect(cssRule(toolCallCss, ".header")).toContain("min-width: 0");
    expect(cssRule(toolCallCss, ".header")).toContain(
      "max-width: var(--message-inline-tool-detail-width, min(760px, 100%))",
    );
    expect(cssRule(toolCallCss, ".titleGroup")).toContain("flex: 0 1 auto");
    expect(cssRule(toolCallCss, ".titleGroup")).toContain("overflow: hidden");
    expect(cssRule(toolCallCss, ".title")).toContain("flex: 0 1 auto");
    expect(cssRule(toolCallCss, ".title")).toContain("flex-wrap: nowrap");
    expect(cssRule(toolCallCss, ".title")).toContain("white-space: nowrap");
    expect(cssRule(toolCallCss, ".fileTargetButton")).toContain("overflow: hidden");
    expect(cssRule(toolCallCss, ".fileTargetButton")).toContain("white-space: nowrap");
    expect(cssRule(toolCallCss, ".fileTargetLabel")).toContain("overflow: hidden");
    expect(cssRule(toolCallCss, ".fileTargetLabel")).toContain("text-overflow: ellipsis");
    expect(cssRule(toolCallCss, ".fileTargetLabel")).toContain("white-space: nowrap");
  });

  it("keeps expanded tool groups inside the message column", () => {
    const groupCss = readCss("../src/renderer/pages/conversation/messages/MessageGroupBlock.module.css");

    expect(cssRule(groupCss, ".block")).toContain("width: 100%");
    expect(cssRule(groupCss, ".block")).toContain("min-width: 0");
    expect(cssRule(groupCss, ".children")).toContain("width: calc(100% - 10px)");
    expect(cssRule(groupCss, ".children")).toContain("min-width: 0");
    expect(cssRule(groupCss, ".childrenInner")).toContain("min-width: 0");
  });

  it("keeps tool and command result scrollbars visible", () => {
    const toolCallCss = readCss("../src/renderer/pages/conversation/messages/ToolCallBlock.module.css");
    const commandCss = readCss("../src/renderer/pages/conversation/messages/CommandExecutionBlock.module.css");

    [toolCallCss, commandCss].forEach((css) => {
      expect(cssRule(css, ".codeViewport")).toContain("overflow-y: auto");
      expect(cssRule(css, ".codeViewport")).toContain("scrollbar-width: thin");
      expect(cssRule(css, ".codeViewport::-webkit-scrollbar")).toContain("width: 9px");
      expect(cssRule(css, ".codeViewport::-webkit-scrollbar")).toContain("height: 9px");
      expect(cssRule(css, ".codeViewport::-webkit-scrollbar-thumb")).toContain("background-clip: padding-box");
    });
  });
});

function readCss(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

function cssRule(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`${escaped}\\s*\\{[^}]*\\}`, "s"))?.[0] ?? "";
}
