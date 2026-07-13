import { describe, expect, it, vi } from "vitest";

import {
  MarkdownInteractionController,
  MarkdownSelectionController,
} from "@/renderer/markdownRuntime/interaction";
import { MarkdownPositionMapper } from "@/renderer/markdownRuntime/mapping";
import { FILE_MARKDOWN_RENDERER_PROFILE } from "@/renderer/markdownRuntime/renderers";
import { DocumentViewRuntime } from "@/renderer/markdownRuntime/view/DocumentViewRuntime";
import { parseCanonicalMarkdownSnapshot } from "@/renderer/markdownRuntime/worker/parser";

describe("Markdown native semantics and accessibility gate", () => {
  it("renders one semantic tree and routes link/focus/keyboard behavior without an accessibility mirror", async () => {
    const source = [
      "# Heading",
      "",
      "中文 😀 é and مرحبا بالعالم",
      "",
      "- first",
      "- second",
      "",
      "| Name | Value |",
      "|---|---|",
      "| 中文 | 😀 |",
      "",
      "![diagram alt](diagram.png)",
      "",
      "[external](https://example.test) [file](README.md:42) [anchor](#heading) [unsafe](javascript:alert(1))",
      "",
      "```ts",
      "const value = '😀';",
      "```",
    ].join("\n");
    const snapshot = parse(source);
    const host = document.createElement("main");
    document.body.append(host);
    const openExternal = vi.fn();
    const openFilePreview = vi.fn();
    const revealAnchor = vi.fn();
    const unsafe = vi.fn();
    const interaction = new MarkdownInteractionController({
      root: host,
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
      openExternal,
      openFilePreview,
      revealAnchor,
      onUnsafeLink: unsafe,
    });
    const runtime = new DocumentViewRuntime(host, {
      profile: FILE_MARKDOWN_RENDERER_PROFILE,
      interactions: interaction.rendererHandlers(),
      viewport: { defaultOverscanPx: 0 },
    });
    runtime.publish(snapshot, snapshot.blocks.map(() => 80), {
      scrollTop: 0,
      viewportHeight: snapshot.blocks.length * 80,
    });
    interaction.attach();

    expect(host.querySelector("h1")?.textContent).toBe("Heading");
    expect(host.querySelectorAll("ul > li")).toHaveLength(2);
    expect(host.querySelectorAll("table thead th")).toHaveLength(2);
    expect(host.querySelectorAll("table tbody td")).toHaveLength(2);
    expect(host.querySelector("img")?.getAttribute("alt")).toBe("diagram alt");
    expect(host.querySelector("pre code")?.textContent).toContain("const value");
    expect(host.querySelector("button")?.getAttribute("aria-label")).toBeTruthy();
    expect(host.textContent).toContain("مرحبا بالعالم");
    expect(host.querySelector("[data-markdown-accessibility-mirror]")).toBeNull();
    expect(host.querySelector("[aria-hidden='true'][data-markdown-block-id]")).toBeNull();

    const links = [...host.querySelectorAll<HTMLAnchorElement>("a")];
    links.find((link) => link.textContent === "external")!.click();
    links.find((link) => link.textContent === "file")!.click();
    links.find((link) => link.textContent === "anchor")!.click();
    await Promise.resolve();
    expect(openExternal).toHaveBeenCalledWith("https://example.test");
    expect(openFilePreview).toHaveBeenCalledWith({
      request: { type: "file", path: "README.md" },
      revealTarget: { lineStart: 42, lineEnd: 42 },
    });
    expect(revealAnchor).toHaveBeenCalledWith("heading");
    await expect(interaction.activateLink("javascript:alert(1)")).resolves.toBe("rejected");
    expect(unsafe).toHaveBeenCalled();

    const codeButton = host.querySelector<HTMLButtonElement>("button")!;
    codeButton.focus();
    const firstBlockId = codeButton.closest<HTMLElement>("[data-markdown-block-id]")!.dataset.markdownBlockId!;
    const scrolled = runtime.updateViewport({ scrollTop: 10_000, viewportHeight: 160 });
    expect(scrolled.protectedIndices).toContain(snapshot.blocks.find((block) => block.id === firstBlockId)!.index);
    expect(runtime.getBlockElement(firstBlockId)).not.toBeNull();
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    host.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    codeButton.dispatchEvent(escape);
    expect(document.activeElement).not.toBe(codeButton);

    runtime.destroy();
    interaction.destroy();
    host.remove();
  });

  it("copies and pins one native cross-block selection with complex text, code and table content", async () => {
    const source = [
      "中文 😀 é",
      "",
      "مرحبا بالعالم",
      "",
      "```ts",
      "const emoji = '😀';",
      "```",
      "",
      "| A | B |",
      "|---|---|",
      "| Cell | 结束 |",
    ].join("\n") + "\n\n" + Array.from({ length: 100 }, (_, index) => `Tail ${index}`).join("\n\n");
    const snapshot = parse(source);
    const host = document.createElement("main");
    document.body.append(host);
    const writeText = vi.fn().mockResolvedValue(undefined);
    const interaction = new MarkdownInteractionController({ root: host, clipboard: { writeText } });
    const runtime = new DocumentViewRuntime(host, {
      profile: FILE_MARKDOWN_RENDERER_PROFILE,
      interactions: interaction.rendererHandlers(),
      viewport: { defaultOverscanPx: 0, maxPinnedBlocks: 256 },
    });
    runtime.publish(snapshot, snapshot.blocks.map(() => 40), {
      scrollTop: 0,
      viewportHeight: 400,
    });
    const mapper = new MarkdownPositionMapper(source, snapshot, {
      heightIndex: runtime.getHeightIndex(),
      mounted: runtime,
    });
    const first = firstText(host.querySelector("p")!);
    const cell = firstText(host.querySelector("tbody td:last-child")!);
    const range = document.createRange();
    range.setStart(first, 0);
    range.setEnd(cell, cell.data.length);
    const nativeSelection = document.getSelection()!;
    nativeSelection.removeAllRanges();
    nativeSelection.addRange(range);
    const selectedText = nativeSelection.toString();
    const selection = new MarkdownSelectionController({ mapper, boundary: host, maxPinnedBlocks: 256 });
    const projected = selection.update().selection!;

    expect(projected.logicalText).toContain("中文 😀 é");
    expect(projected.logicalText).toContain("مرحبا بالعالم");
    expect(projected.logicalText).toContain("const emoji = '😀';");
    expect(projected.logicalText).toContain("结束");
    expect(projected.pinnedIndices.size).toBeGreaterThanOrEqual(4);
    await expect(interaction.copySelection(nativeSelection)).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith(selectedText);

    const far = runtime.updateViewport({
      scrollTop: Number.MAX_SAFE_INTEGER,
      viewportHeight: 160,
      pinnedIndices: selection.pinnedIndices(),
    });
    expect(far.viewport.items.filter((item) => item.pinned)).toHaveLength(projected.pinnedIndices.size);
    expect(host.querySelector("[data-markdown-accessibility-mirror]")).toBeNull();
    nativeSelection.removeAllRanges();
    selection.update();
    runtime.updateViewport({ scrollTop: Number.MAX_SAFE_INTEGER, viewportHeight: 160 });
    expect(runtime.getBlockElement(snapshot.blocks[0].id)).toBeNull();

    selection.destroy();
    runtime.destroy();
    interaction.destroy();
    host.remove();
  });
});

function parse(source: string) {
  return parseCanonicalMarkdownSnapshot({
    surface: "file",
    documentId: "file:accessibility.md",
    revision: "r1",
    source,
    rendererProfile: "file-preview",
  });
}

function firstText(root: Node): Text {
  const value = document.createTreeWalker(root, NodeFilter.SHOW_TEXT).nextNode();
  if (!(value instanceof Text)) throw new Error("Expected text node");
  return value;
}
