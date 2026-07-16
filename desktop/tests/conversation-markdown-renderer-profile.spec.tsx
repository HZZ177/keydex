import { useEffect, useRef } from "react";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
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

  it("defers nested code-root disposal beyond the parent passive unmount", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { unmount } = render(<MarkdownLifecycleHost />);
    try {
      await waitFor(() => expect(document.querySelector('[data-testid="markdown-code-viewport"]')).not.toBeNull());

      unmount();
      await act(async () => {
        await Promise.resolve();
      });

      expect(consoleError.mock.calls.flat().join(" ")).not.toContain("Attempted to synchronously unmount a root");
    } finally {
      consoleError.mockRestore();
    }
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

  it("adds real color swatches after inline hexadecimal color values without duplicating them", () => {
    const parser = new StreamingTailParser(parserOptions);
    const root = document.createElement("div");
    const view = new StreamingTailView(root, { registry: createConversationMarkdownRendererRegistry() });
    const source = "绿色 `#63A665`，紫色 `#8B63A6`，短色值 `#abc`，透明色 `#11223380`，黑色 `#000000`，白色 `#FFFFFF`，无效值 `#12345`";
    const first = parser.update({ source, revision: "colors-1", epoch: 1 }).snapshot;
    view.publish(first, { showCursor: false });

    const swatches = root.querySelectorAll<HTMLElement>('[data-keydex-color-swatch="true"]');
    expect(Array.from(swatches, (swatch) => swatch.dataset.keydexColorValue)).toEqual([
      "#63A665",
      "#8B63A6",
      "#abc",
      "#11223380",
      "#000000",
      "#FFFFFF",
    ]);
    expect(Array.from(swatches).every((swatch) => swatch.style.backgroundColor !== "")).toBe(true);
    expect(root.querySelector<HTMLElement>('[data-keydex-color-value="#000000"]')?.dataset.keydexColorSwatchOutline).toBeUndefined();
    expect(root.querySelector<HTMLElement>('[data-keydex-color-value="#FFFFFF"]')?.dataset.keydexColorSwatchOutline).toBe("true");
    expect(root.querySelector('code[data-markdown-inline-kind="code"]:last-of-type')?.nextSibling).toBeNull();

    const second = parser.update({ source, revision: "colors-2", epoch: 1, final: true }).snapshot;
    view.publish(second, { showCursor: false });
    expect(root.querySelectorAll('[data-keydex-color-swatch="true"]')).toHaveLength(6);
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

function MarkdownLifecycleHost() {
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const parser = new StreamingTailParser(parserOptions);
    const view = new StreamingTailView(host, { registry: createConversationMarkdownRendererRegistry() });
    const snapshot = parser.update({
      source: "```ts\nconst navigation = 'rapid';\n```",
      revision: "passive-unmount",
      epoch: 1,
      final: true,
    }).snapshot;
    view.publish(snapshot, { showCursor: false });
    return () => view.destroy();
  }, []);
  return <div ref={hostRef} />;
}
