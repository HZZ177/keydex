import { describe, expect, it, vi } from "vitest";

import { StreamingTailParser, StreamingTailView } from "@/renderer/markdownRuntime/streaming";
import {
  SemanticMarkdownRendererRegistry,
  createCodeBlockRenderer,
  defaultSemanticMarkdownRenderers,
  type MarkdownCodeHighlightResult,
  type MarkdownCodeHighlightTask,
} from "@/renderer/markdownRuntime/renderers";
import type { MarkdownSnapshotBlock } from "@/renderer/markdownRuntime/document/MarkdownSnapshot";

const parserOptions = {
  surface: "message" as const,
  documentId: "message:streaming-tail-view",
  rendererProfile: "conversation" as const,
};

describe("StreamingTailView", () => {
  it("keeps committed prefix DOM identity and patches only mutable/new tail blocks", () => {
    const parser = new StreamingTailParser(parserOptions);
    const root = document.createElement("div");
    const view = new StreamingTailView(root);
    const first = parser.update({ source: "Alpha\n\nBeta", revision: "r1", epoch: 1 }).snapshot;
    const firstPatch = view.publish(first, { showCursor: true });
    const alpha = view.getBlockElement(first.blocks[0].id);
    const beta = view.getBlockElement(first.blocks[1].id);

    expect(firstPatch.render).toMatchObject({ created: 2, preserved: 0 });
    expect(alpha?.textContent).toBe("Alpha");
    expect(beta?.textContent).toBe("Beta");

    const second = parser.update({ source: "Alpha\n\nBeta\n\nGamma", revision: "r2", epoch: 1 }).snapshot;
    const secondPatch = view.publish(second, { showCursor: true });
    expect(secondPatch.preservedBlockIds).toEqual([first.blocks[0].id]);
    expect(secondPatch.patchedBlockIds).toEqual(second.blocks.slice(1).map((block) => block.id));
    expect(secondPatch.render).toMatchObject({ preserved: 1, reused: 1, created: 1, destroyed: 0 });
    expect(view.getBlockElement(second.blocks[0].id)).toBe(alpha);
    expect(view.getBlockElement(second.blocks[1].id)).toBe(beta);
    expect(root.querySelectorAll("[data-markdown-block-id]")).toHaveLength(3);
  });

  it("updates one paragraph tail without touching a stable prefix", () => {
    const parser = new StreamingTailParser(parserOptions);
    const root = document.createElement("div");
    const view = new StreamingTailView(root);
    const first = parser.update({ source: "Stable\n\nTail", revision: "p1", epoch: 1 }).snapshot;
    view.publish(first);
    const stable = view.getBlockElement(first.blocks[0].id);

    const second = parser.update({ source: "Stable\n\nTail grows", revision: "p2", epoch: 1 }).snapshot;
    const patch = view.publish(second);
    expect(patch).toMatchObject({
      preservedBlockIds: [first.blocks[0].id],
      render: { preserved: 1, updated: 1, created: 0, destroyed: 0 },
    });
    expect(view.getBlockElement(second.blocks[0].id)).toBe(stable);
    expect(view.getBlockElement(second.blocks[1].id)?.textContent).toBe("Tail grows");
  });

  it("appends a giant plain paragraph tail in place instead of replacing its accumulated DOM", () => {
    const parser = new StreamingTailParser(parserOptions);
    const root = document.createElement("div");
    const view = new StreamingTailView(root);
    const firstSource = "x".repeat(128 * 1024);
    const first = parser.update({ source: firstSource, revision: "giant-1", epoch: 1 }).snapshot;
    view.publish(first);
    const paragraph = view.getBlockElement(first.blocks[0].id)!;
    const topSpacer = paragraph.querySelector("[data-markdown-plain-top-spacer='true']");

    const secondSource = `${firstSource}${"y".repeat(8 * 1024)}`;
    const second = parser.update({ source: secondSource, revision: "giant-2", epoch: 1 }).snapshot;
    view.publish(second);

    const updated = view.getBlockElement(second.blocks[0].id)!;
    expect(updated).toBe(paragraph);
    expect(updated.querySelector("[data-markdown-plain-top-spacer='true']")).toBe(topSpacer);
    expect((topSpacer as HTMLElement).style.height).toBe("0px");
    expect(updated.dataset.markdownVirtualPlainTotalCharacters).toBe(String(secondSource.length));
    expect(Number(updated.dataset.markdownVirtualPlainChunkCount)).toBe(68);
    expect(updated.querySelector<HTMLElement>("[data-markdown-plain-text-chunk='true']")?.style.position).toBe("absolute");
    expect(Number(updated.dataset.markdownVirtualPlainMountedChunks)).toBeLessThanOrEqual(6);
    expect(updated.querySelectorAll("[data-markdown-plain-text-chunk='true']").length).toBeLessThanOrEqual(6);
    expect(Math.max(...[...updated.querySelectorAll("[data-markdown-plain-text-chunk='true']")]
      .map((node) => node.textContent?.length ?? 0))).toBeLessThanOrEqual(2 * 1024);
    expect(updated.textContent).toBe(secondSource.slice(-12 * 1024));
    expect(updated.textContent).toContain("y".repeat(8 * 1024));
    expect(updated.dataset.markdownAppendPatches).toBe("1");
  });

  it("keeps cursor and active fence state correct while a fence opens and closes", () => {
    const parser = new StreamingTailParser(parserOptions);
    const root = document.createElement("div");
    const view = new StreamingTailView(root);
    const openSource = "Intro\n\n```ts\nconst x = 1";
    const open = parser.update({ source: openSource, revision: "f1", epoch: 1 }).snapshot;
    const openPatch = view.publish(open, { displayCursor: openSource.length, showCursor: true });
    const fence = open.blocks.at(-1)!;

    expect(openPatch.cursorBlockId).toBe(fence.id);
    expect(view.cursor.hidden).toBe(false);
    expect(view.cursor.style.display).toBe("");
    expect(view.cursor.querySelectorAll('[data-streaming-cursor-dot="true"]')).toHaveLength(3);
    expect(view.cursor.dataset.streamingMarkdownActiveFenceBlockId).toBe(fence.id);
    expect(view.cursor.previousElementSibling).toBe(view.getBlockElement(fence.id));

    const closedSource = `${openSource}\n\`\`\`\n\nAfter`;
    const closed = parser.update({ source: closedSource, revision: "f2", epoch: 1 }).snapshot;
    view.publish(closed, { showCursor: false });
    expect(view.cursor.hidden).toBe(true);
    expect(view.cursor.style.display).toBe("none");
    expect(view.cursor.dataset.streamingMarkdownActiveFenceBlockId).toBeUndefined();
    expect(view.cursor.dataset.streamingMarkdownCursorBlockId).toBe(closed.blocks.at(-1)?.id);
  });

  it("keeps display-only cursor updates out of the Markdown renderer", () => {
    const parser = new StreamingTailParser(parserOptions);
    const root = document.createElement("div");
    const view = new StreamingTailView(root);
    const source = "x".repeat(10_000);
    const snapshot = parser.update({ source, revision: "d1", epoch: 1 }).snapshot;
    const patch = view.publish(snapshot, { displayCursor: 0 });
    const block = view.getBlockElement(snapshot.blocks[0].id);
    for (let batch = 1; batch <= 1_000; batch += 1) {
      view.updateDisplay({ displayCursor: batch * 10, showCursor: true });
    }

    expect(root.dataset.streamingMarkdownRenderCount).toBe("1");
    expect(patch.renderCount).toBe(1);
    expect(view.getBlockElement(snapshot.blocks[0].id)).toBe(block);
    expect(view.cursor.dataset.streamingMarkdownDisplayCursor).toBe("10000");
  });

  it("windows a 10,000-block message against the one outer conversation scroller and jumps to the tail", () => {
    const parser = new StreamingTailParser(parserOptions);
    const scroller = document.createElement("div");
    scroller.dataset.messageListScroll = "true";
    const root = document.createElement("div");
    scroller.append(root);
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 600 },
      clientWidth: { configurable: true, value: 900 },
      scrollTop: { configurable: true, writable: true, value: 0 },
      getBoundingClientRect: {
        configurable: true,
        value: () => ({ top: 0, bottom: 600, left: 0, right: 900, width: 900, height: 600 }),
      },
    });
    Object.defineProperties(root, {
      clientWidth: { configurable: true, value: 900 },
      getBoundingClientRect: {
        configurable: true,
        value: () => ({
          top: -scroller.scrollTop,
          bottom: 1_000_000 - scroller.scrollTop,
          left: 0,
          right: 900,
          width: 900,
          height: 1_000_000,
        }),
      },
    });
    const source = Array.from({ length: 10_000 }, (_, index) => `paragraph-${index}`).join("\n\n");
    const snapshot = parser.update({ source, revision: "long-1", epoch: 1, final: true }).snapshot;
    const view = new StreamingTailView(root);
    view.publish(snapshot, { showCursor: false });

    expect(snapshot.blocks).toHaveLength(10_000);
    expect(Number(root.dataset.markdownMountedBlockCount)).toBeLessThan(100);
    expect(root.querySelectorAll("[data-markdown-block-id]").length).toBeLessThan(100);
    const totalHeight = Number(root.querySelector<HTMLElement>('[data-markdown-document-canvas="true"]')?.dataset.markdownTotalHeight);
    scroller.scrollTop = totalHeight - 600;
    scroller.dispatchEvent(new Event("scroll"));
    expect(view.getBlockElement(snapshot.blocks.at(-1)!.id)).not.toBeNull();
    expect(root.querySelectorAll("[data-markdown-block-id]").length).toBeLessThan(100);
  });

  it("preserves canonical-compatible prefix nodes when completing and replaces only the tail", () => {
    const parser = new StreamingTailParser(parserOptions);
    const root = document.createElement("div");
    const view = new StreamingTailView(root);
    const source = "# Heading\n\nParagraph\n\n```ts\nconst x = 1;\n```";
    const streaming = parser.update({ source, revision: "s1", epoch: 1 }).snapshot;
    view.publish(streaming);
    const heading = view.getBlockElement(streaming.blocks[0].id);
    const paragraph = view.getBlockElement(streaming.blocks[1].id);

    const canonical = parser.update({ source, revision: "final", epoch: 1, final: true }).snapshot;
    const patch = view.publish(canonical, { showCursor: false });
    expect(patch.preservedBlockIds).toEqual(expect.arrayContaining([
      streaming.blocks[0].id,
      streaming.blocks[1].id,
    ]));
    expect(view.getBlockElement(canonical.blocks[0].id)).toBe(heading);
    expect(view.getBlockElement(canonical.blocks[1].id)).toBe(paragraph);
    expect(view.cursor.hidden).toBe(true);
  });

  it("keeps code resource cleanup local across tail replacement and destroy", () => {
    const mount = vi.fn(() => vi.fn());
    const parser = new StreamingTailParser(parserOptions);
    const root = document.createElement("div");
    const view = new StreamingTailView(root, { resourceLifecycle: { mount } });
    const first = parser.update({ source: "```mermaid\ngraph TD; A-->B", revision: "m1", epoch: 1 }).snapshot;
    view.publish(first);
    const second = parser.update({ source: "```mermaid\ngraph TD; A-->B\n```\n\nAfter", revision: "m2", epoch: 1 }).snapshot;
    view.publish(second);

    expect(root.querySelector("[data-markdown-mermaid-block='true']")).not.toBeNull();
    expect(root.textContent).toContain("After");
    view.destroy();
    expect(root.childElementCount).toBe(0);
  });

  it("ignores delayed highlighting from a replaced tail and publishes only the latest code", async () => {
    const tasks: Array<{
      block: MarkdownSnapshotBlock;
      controller: AbortController;
      resolve: (result: MarkdownCodeHighlightResult) => void;
    }> = [];
    const highlighter = {
      highlight(block: MarkdownSnapshotBlock): MarkdownCodeHighlightTask {
        const controller = new AbortController();
        let resolve!: (result: MarkdownCodeHighlightResult) => void;
        const promise = new Promise<MarkdownCodeHighlightResult>((done) => { resolve = done; });
        tasks.push({ block, controller, resolve });
        return { signal: controller.signal, promise, cancel: (reason) => controller.abort(reason) };
      },
    };
    const registry = new SemanticMarkdownRendererRegistry(defaultSemanticMarkdownRenderers, {
      code: createCodeBlockRenderer({ highlighter }),
    });
    const parser = new StreamingTailParser(parserOptions);
    const root = document.createElement("div");
    const view = new StreamingTailView(root, { registry });
    const first = parser.update({ source: "```ts\nconst a = 1", revision: "h1", epoch: 1 }).snapshot;
    view.publish(first);
    const second = parser.update({ source: "```ts\nconst a = 12", revision: "h2", epoch: 1 }).snapshot;
    view.publish(second);
    const frame = root.querySelector<HTMLElement>("[data-markdown-code-frame='true']")!;

    expect(tasks).toHaveLength(2);
    expect(tasks[0].controller.signal.aborted).toBe(true);
    tasks[0].resolve(result(tasks[0].block));
    await Promise.resolve();
    expect(frame.dataset.markdownCodeHighlightState).toBe("pending");
    tasks[1].resolve(result(tasks[1].block));
    await Promise.resolve();
    expect(frame.dataset.markdownCodeHighlightState).toBe("ready");
    expect(frame.textContent).toContain("const a = 12");
  });

  it("rejects file snapshots and use after destroy", () => {
    const parser = new StreamingTailParser(parserOptions);
    const root = document.createElement("div");
    const view = new StreamingTailView(root);
    const message = parser.update({ source: "Message", revision: "r1", epoch: 1 }).snapshot;
    const file = { ...message, surface: "file", renderer_profile: "file-preview" } as const;
    expect(() => view.publish(file)).toThrow(/requires a message\/conversation/u);
    view.destroy();
    expect(() => view.publish(message)).toThrow(/destroyed/u);
  });
});

function result(block: MarkdownSnapshotBlock): MarkdownCodeHighlightResult {
  return {
    blockId: block.id,
    contentHash: block.content_hash,
    language: block.metadata.language ?? null,
    tokens: [],
    truncated: false,
  };
}
