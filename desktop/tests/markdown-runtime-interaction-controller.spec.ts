import { describe, expect, it, vi } from "vitest";

import {
  MarkdownInteractionController,
  resolveMarkdownLinkTarget,
} from "@/renderer/markdownRuntime/interaction";
import { FILE_MARKDOWN_RENDERER_PROFILE } from "@/renderer/markdownRuntime/renderers";
import { DocumentViewRuntime } from "@/renderer/markdownRuntime/view/DocumentViewRuntime";
import { parseCanonicalMarkdownSnapshot } from "@/renderer/markdownRuntime/worker/parser";

function root() {
  const element = document.createElement("div");
  document.body.append(element);
  return element;
}

describe("Markdown retained DOM copy interaction", () => {
  it("copies native multi-block selection including Chinese and emoji without reconstructing it", async () => {
    const element = root();
    element.innerHTML = "<p>First 中文</p><pre><code>const emoji = '😀';</code></pre><table><tbody><tr><td>Cell</td></tr></tbody></table>";
    const first = element.querySelector("p")!.firstChild!;
    const cell = element.querySelector("td")!.firstChild!;
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    const range = document.createRange();
    range.setStart(first, 0);
    range.setEnd(cell, 4);
    selection.addRange(range);
    const selectedText = selection.toString();
    const writeText = vi.fn().mockResolvedValue(undefined);
    const controller = new MarkdownInteractionController({ root: element, clipboard: { writeText } });

    await expect(controller.copySelection(selection)).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith(selectedText);
    expect(selectedText).toContain("😀");
    selection.removeAllRanges();
    controller.destroy();
    element.remove();
  });

  it("copies code and table text exactly and reports clipboard errors", async () => {
    const element = root();
    const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("denied"));
    const feedback = vi.fn();
    const controller = new MarkdownInteractionController({
      root: element,
      clipboard: { writeText },
      onCopyFeedback: feedback,
    });
    await controller.copyText("const x = 1;\n", "code:b1");
    await expect(controller.copyText("A\tB\n1\t2", "table:b2")).rejects.toThrow("denied");

    expect(writeText.mock.calls).toEqual([["const x = 1;\n"], ["A\tB\n1\t2"]]);
    expect(controller.feedbackFor("code:b1").status).toBe("success");
    expect(controller.feedbackFor("table:b2")).toMatchObject({ status: "error", error: "denied" });
    expect(feedback).toHaveBeenCalledWith(expect.objectContaining({ targetId: "table:b2", status: "error" }));
    controller.destroy();
    element.remove();
  });

  it("resets per-target copy feedback after the shared 1400ms contract", async () => {
    const element = root();
    const callbacks: Array<() => void> = [];
    const delays: number[] = [];
    const cancelled: unknown[] = [];
    const feedback = vi.fn();
    const controller = new MarkdownInteractionController({
      root: element,
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
      onCopyFeedback: feedback,
      scheduleReset: (callback, delay) => {
        callbacks.push(callback);
        delays.push(delay);
        return callbacks.length as unknown as ReturnType<typeof setTimeout>;
      },
      cancelReset: (handle) => { cancelled.push(handle); },
    });
    await controller.copyText("first", "code:a");
    await controller.copyText("second", "code:a");
    expect(delays).toEqual([1400, 1400]);
    expect(cancelled).toEqual([1]);
    callbacks[1]!();
    expect(controller.feedbackFor("code:a").status).toBe("idle");
    expect(feedback).toHaveBeenLastCalledWith({ targetId: "code:a", status: "idle", error: null });
    controller.destroy();
    element.remove();
  });
});

describe("Markdown link protocol routing", () => {
  it.each([
    ["https://example.test/a", { kind: "external", scheme: "https" }],
    ["mailto:user@example.test", { kind: "external", scheme: "mailto" }],
    ["README.md:12", { kind: "file", path: "README.md", line: 12, absolute: false }],
    ["D:/Docs/README.md:8", { kind: "file", path: "D:/Docs/README.md", line: 8, absolute: true }],
    ["file:///D:/Docs/My%20Note.md:9", { kind: "file", path: "D:/Docs/My Note.md", line: 9, absolute: true }],
    ["#installation", { kind: "anchor", fragment: "installation" }],
    ["javascript:alert(1)", { kind: "unsafe", reason: "unsafe-scheme:javascript" }],
    ["data:text/html,bad", { kind: "unsafe", reason: "unsafe-scheme:data" }],
  ])("classifies %s", (href, expected) => {
    expect(resolveMarkdownLinkTarget(href)).toMatchObject(expected);
  });

  it("routes external, file, and anchor links through host callbacks and rejects unsafe links", async () => {
    const element = root();
    const openExternal = vi.fn();
    const openFilePreview = vi.fn();
    const revealAnchor = vi.fn();
    const onUnsafeLink = vi.fn();
    const controller = new MarkdownInteractionController({
      root: element,
      clipboard: null,
      openExternal,
      openFilePreview,
      revealAnchor,
      onUnsafeLink,
    });
    const event = () => ({ preventDefault: vi.fn(), stopPropagation: vi.fn() });
    await expect(controller.activateLink("https://example.test", event())).resolves.toBe("handled");
    await expect(controller.activateLink("README.md:42", event())).resolves.toBe("handled");
    await expect(controller.activateLink("#guide", event())).resolves.toBe("handled");
    await expect(controller.activateLink("vbscript:bad", event())).resolves.toBe("rejected");

    expect(openExternal).toHaveBeenCalledWith("https://example.test");
    expect(openFilePreview).toHaveBeenCalledWith({
      request: { type: "file", path: "README.md" },
      revealTarget: { lineStart: 42, lineEnd: 42 },
    });
    expect(revealAnchor).toHaveBeenCalledWith("guide");
    expect(onUnsafeLink).toHaveBeenCalledWith(expect.objectContaining({ kind: "unsafe" }));
    controller.destroy();
    element.remove();
  });

  it("integrates renderer code-copy and file links with no React DOM rebuild", async () => {
    const source = "[README](README.md:12)\n\n```ts\nconst x = 1;\n```";
    const snapshot = parseCanonicalMarkdownSnapshot({
      surface: "file",
      documentId: "file:interaction.md",
      revision: "r1",
      source,
      rendererProfile: "file-preview",
    });
    const element = root();
    const writeText = vi.fn().mockResolvedValue(undefined);
    const openFilePreview = vi.fn();
    const controller = new MarkdownInteractionController({ root: element, clipboard: { writeText }, openFilePreview });
    const runtime = new DocumentViewRuntime(element, {
      profile: FILE_MARKDOWN_RENDERER_PROFILE,
      interactions: controller.rendererHandlers(),
      viewport: { defaultOverscanPx: 0 },
    });
    runtime.publish(snapshot, snapshot.blocks.map(() => 100), { scrollTop: 0, viewportHeight: 500 });
    const codeRoot = runtime.getBlockElement(snapshot.blocks.find((block) => block.kind === "code")!.id)!;
    const codeNode = codeRoot.querySelector("code")!;
    const link = element.querySelector<HTMLAnchorElement>("a")!;
    const retainedLink = link;
    codeRoot.querySelector<HTMLButtonElement>("button")!.click();
    link.click();
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith(codeNode.textContent);
    expect(openFilePreview).toHaveBeenCalledWith({
      request: { type: "file", path: "README.md" },
      revealTarget: { lineStart: 12, lineEnd: 12 },
    });
    expect(element.querySelector("a")).toBe(retainedLink);
    runtime.destroy();
    controller.destroy();
    element.remove();
  });
});

describe("Markdown keyboard and focus interaction", () => {
  it("supports Home/End/PageUp/PageDown/Enter/Escape while leaving Tab, Space, and shortcuts native", async () => {
    const element = root();
    element.innerHTML = '<a href="#first">First</a><button>Middle</button><a href="#last">Last</a>';
    const revealAnchor = vi.fn();
    const scrollPage = vi.fn();
    const controller = new MarkdownInteractionController({ root: element, clipboard: null, revealAnchor, scrollPage });
    controller.attach();
    const middle = element.querySelector("button")!;
    middle.focus();

    const home = new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true });
    middle.dispatchEvent(home);
    expect(document.activeElement?.textContent).toBe("First");
    expect(home.defaultPrevented).toBe(true);
    const end = new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true });
    document.activeElement!.dispatchEvent(end);
    expect(document.activeElement?.textContent).toBe("Last");
    const enter = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    document.activeElement!.dispatchEvent(enter);
    await Promise.resolve();
    expect(revealAnchor).toHaveBeenCalledWith("last");
    for (const key of ["PageUp", "PageDown"] as const) {
      document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    }
    expect(scrollPage.mock.calls).toEqual([["up"], ["down"]]);

    for (const event of [
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
      new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }),
      new KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true, cancelable: true }),
    ]) {
      element.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    }
    const contextMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    element.dispatchEvent(contextMenu);
    expect(contextMenu.defaultPrevented).toBe(false);
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.activeElement!.dispatchEvent(escape);
    expect(document.activeElement).not.toBe(element.querySelector("a[href='#last']"));
    controller.destroy();
    element.remove();
  });

  it("reports focused block and lets DocumentViewRuntime retain it outside the viewport", async () => {
    const source = ["```ts", "const x = 1;", "```", "", ...Array.from({ length: 100 }, (_, index) => `P${index}\n`)].join("\n");
    const snapshot = parseCanonicalMarkdownSnapshot({
      surface: "file",
      documentId: "file:focus.md",
      revision: "r1",
      source,
      rendererProfile: "file-preview",
    });
    const element = root();
    const focused = vi.fn();
    const controller = new MarkdownInteractionController({
      root: element,
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
      onFocusedBlockChanged: focused,
    });
    const runtime = new DocumentViewRuntime(element, {
      profile: FILE_MARKDOWN_RENDERER_PROFILE,
      interactions: controller.rendererHandlers(),
      viewport: { defaultOverscanPx: 0 },
    });
    runtime.publish(snapshot, snapshot.blocks.map(() => 30), { scrollTop: 0, viewportHeight: 120 });
    controller.attach();
    const firstId = snapshot.blocks[0].id;
    runtime.getBlockElement(firstId)!.querySelector<HTMLButtonElement>("button")!.focus();
    await Promise.resolve();
    const scrolled = runtime.updateViewport({ scrollTop: 2_000, viewportHeight: 120 });

    expect(focused).toHaveBeenCalledWith(firstId, 0);
    expect(scrolled.viewport.items.find((item) => item.index === 0)).toMatchObject({ pinned: true });
    expect(runtime.getBlockElement(firstId)).not.toBeNull();
    runtime.destroy();
    controller.destroy();
    element.remove();
  });
});
