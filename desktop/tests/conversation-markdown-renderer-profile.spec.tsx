import { act, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { StreamingTailParser, StreamingTailView } from "@/renderer/markdownRuntime/streaming";
import { createConversationMarkdownRendererRegistry } from "@/renderer/pages/conversation/messages/ConversationMarkdownRendererProfile";

const parserOptions = {
  surface: "message" as const,
  documentId: "message:conversation-profile",
  rendererProfile: "conversation" as const,
};

describe("Conversation Markdown renderer profile", () => {
  it("keeps the existing streaming code component mounted while tail content grows", async () => {
    const parser = new StreamingTailParser(parserOptions);
    const root = document.createElement("div");
    document.body.append(root);
    const view = new StreamingTailView(root, { registry: createConversationMarkdownRendererRegistry() });
    const first = parser.update({ source: "```ts\nconst first = 1", revision: "c1", epoch: 1 }).snapshot;
    act(() => { view.publish(first); });
    await waitFor(() => expect(root.querySelector('[data-testid="markdown-code-viewport"]')).not.toBeNull());
    const viewport = root.querySelector('[data-testid="markdown-code-viewport"]');

    const second = parser.update({
      source: "```ts\nconst first = 1;\nconst second = 2;",
      revision: "c2",
      epoch: 1,
    }).snapshot;
    act(() => { view.publish(second); });
    await waitFor(() => expect(root.textContent).toContain("const second = 2"));
    expect(root.querySelector('[data-testid="markdown-code-viewport"]')).toBe(viewport);
    expect(root.querySelector('[data-testid="streaming-cursor"]')).not.toBeNull();
    act(() => { view.destroy(); });
    root.remove();
  });

  it("enhances file links with Keydex identity, icon, line badge, and host navigation", () => {
    const onLinkActivate = vi.fn();
    const source = "See [MessageText.tsx](<desktop/src/renderer/pages/conversation/messages/MessageText.tsx:120>)";
    const parser = new StreamingTailParser(parserOptions);
    const root = document.createElement("div");
    const view = new StreamingTailView(root, {
      registry: createConversationMarkdownRendererRegistry(),
      interactions: { onLinkActivate },
    });
    const snapshot = parser.update({ source, revision: "l1", epoch: 1, final: true }).snapshot;
    view.publish(snapshot, { showCursor: false });
    const link = root.querySelector<HTMLAnchorElement>("a")!;

    expect(link.dataset.keydexFileLink).toBe("true");
    expect(link.dataset.keydexFilePath).toBe("desktop/src/renderer/pages/conversation/messages/MessageText.tsx");
    const icon = link.querySelector<HTMLImageElement>('[data-keydex-file-link-icon="true"]')!;
    expect(icon.getAttribute("data-icon-id")).toBe("react_ts");
    expect(icon.style.width).toBe("16px");
    expect(icon.style.height).toBe("16px");
    expect(icon.style.maxWidth).toBe("16px");
    expect(icon.style.margin).toBe("0px");
    expect(link.style.display).toBe("inline-flex");
    expect(link.querySelector('[data-keydex-file-link-line-badge="true"]')?.textContent).toBe("L120");
    fireEvent.click(link);
    expect(onLinkActivate).toHaveBeenCalledWith(expect.any(MouseEvent), expect.objectContaining({
      href: "desktop/src/renderer/pages/conversation/messages/MessageText.tsx:120",
    }));
  });

  it("keeps table overflow and remote image metadata in the conversation profile", () => {
    const source = [
      "| A | B |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "![remote](https://example.test/a.png)",
    ].join("\n");
    const parser = new StreamingTailParser(parserOptions);
    const root = document.createElement("div");
    const view = new StreamingTailView(root, { registry: createConversationMarkdownRendererRegistry() });
    const snapshot = parser.update({ source, revision: "media", epoch: 1, final: true }).snapshot;
    view.publish(snapshot, { showCursor: false });
    const table = root.querySelector<HTMLElement>('[data-markdown-table-scroll="true"]')!;
    const image = root.querySelector<HTMLImageElement>("img[data-markdown-resource-id]")!;

    expect(table.classList.contains("keydex-markdown-table-scroll")).toBe(true);
    expect(image.getAttribute("src")).toBe("https://example.test/a.png");
    expect(image.loading).toBe("lazy");
    expect(image.decoding).toBe("async");
    expect(image.referrerPolicy).toBe("no-referrer");
  });

  it("renders display math directly and fenced math through the existing code preview", async () => {
    const parser = new StreamingTailParser(parserOptions);
    const root = document.createElement("div");
    const view = new StreamingTailView(root, { registry: createConversationMarkdownRendererRegistry() });
    const display = parser.update({ source: "$$\nE=mc^2\n$$", revision: "math-1", epoch: 1, final: true }).snapshot;
    view.publish(display, { showCursor: false });
    expect(root.querySelector(".katex-display")).not.toBeNull();

    const fenced = parser.update({ source: "```latex\nx^2+y^2=z^2\n```", revision: "math-2", epoch: 2, final: true }).snapshot;
    act(() => { view.publish(fenced, { showCursor: false }); });
    await waitFor(() => expect(root.querySelector('[data-testid="math-preview"]')).not.toBeNull());
    expect(root.textContent).toContain("x^2+y^2=z^2");
  });
});
