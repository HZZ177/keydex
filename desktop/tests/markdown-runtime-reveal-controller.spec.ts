import { describe, expect, it, vi } from "vitest";

import { MarkdownPositionMapper } from "@/renderer/markdownRuntime/mapping";
import { FILE_MARKDOWN_RENDERER_PROFILE } from "@/renderer/markdownRuntime/renderers";
import { DocumentViewRuntime } from "@/renderer/markdownRuntime/view/DocumentViewRuntime";
import {
  MarkdownRevealController,
  MarkdownRevealError,
  type MarkdownRevealContext,
} from "@/renderer/markdownRuntime/view/RevealController";
import { parseCanonicalMarkdownSnapshot } from "@/renderer/markdownRuntime/worker/parser";

function createHarness(blockCount = 200) {
  const source = Array.from({ length: blockCount }, (_, index) => `Paragraph ${index} repeat`).join("\n\n");
  const snapshot = parseCanonicalMarkdownSnapshot({
    surface: "file",
    documentId: "file:reveal.md",
    revision: "r1",
    source,
    rendererProfile: "file-preview",
  });
  const host = document.createElement("div");
  document.body.append(host);
  const runtime = new DocumentViewRuntime(host, {
    profile: FILE_MARKDOWN_RENDERER_PROFILE,
    viewport: { defaultOverscanPx: 0 },
  });
  runtime.publish(snapshot, snapshot.blocks.map(() => 100), { scrollTop: 0, viewportHeight: 200 });
  const heightIndex = runtime.getHeightIndex()!;
  const mapper = new MarkdownPositionMapper(source, snapshot, { heightIndex, mounted: runtime });
  let scrollTop = 0;
  const scrolls: Array<{ phase: string; scrollTop: number; behavior: string; requestId: number }> = [];
  const mounts: number[] = [];
  const highlights: number[] = [];
  let mountHook: ((input: Parameters<MarkdownRevealContext["mount"]>[0], mount: () => void) => void | Promise<void>) | null = null;
  const mount = (input: Parameters<MarkdownRevealContext["mount"]>[0]) => {
    const render = () => {
      mounts.push(input.blockIndex);
      runtime.updateViewport({
        scrollTop: input.scrollTop,
        viewportHeight: 200,
        pinnedIndices: input.pinnedIndices,
      }, { origin: "automatic" });
      for (const blockId of runtime.mountedBlockIds()) {
        const element = runtime.getBlockElement(blockId)!;
        const index = snapshot.blocks.find((block) => block.id === blockId)!.index;
        element.getBoundingClientRect = () => domRect(
          heightIndex.offsetOf(index) - scrollTop + 50 + 13,
          heightIndex.heightAt(index),
        );
      }
    };
    return mountHook ? mountHook(input, render) : render();
  };
  const context: MarkdownRevealContext = {
    snapshot,
    mapper,
    heightIndex,
    viewport: () => ({ scrollTop, viewportHeight: 200, viewportTop: 50 }),
    scrollTo: (input) => {
      scrollTop = input.scrollTop;
      scrolls.push(input);
    },
    mount,
    highlight: ({ requestId }) => { highlights.push(requestId); },
    resolveTarget: (target) => {
      if (target.kind === "annotation") return { sourceOffset: source.indexOf("Paragraph 50") };
      if (target.kind === "turn") return { blockId: snapshot.blocks[75]?.id };
      if (target.kind === "capsule") return { sourceOffset: source.indexOf("Paragraph 100") };
      return null;
    },
  };
  return {
    source,
    snapshot,
    host,
    runtime,
    heightIndex,
    mapper,
    context,
    scrolls,
    mounts,
    highlights,
    setMountHook(value: typeof mountHook) { mountHook = value; },
    get scrollTop() { return scrollTop; },
    destroy() { runtime.destroy(); host.remove(); },
  };
}

function domRect(top: number, height: number): DOMRect {
  return {
    x: 0,
    y: top,
    width: 100,
    height,
    top,
    right: 100,
    bottom: top + height,
    left: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

describe("two-stage Markdown reveal", () => {
  it("reveals top, middle, and tail with one direct coarse mount and local fine correction", async () => {
    const run = createHarness();
    const controller = new MarkdownRevealController();
    controller.publish(run.context);
    for (const index of [0, 100, 199]) {
      const result = await controller.request(
        { kind: "block", blockId: run.snapshot.blocks[index]!.id },
        { align: "start", behavior: "smooth" },
      ).promise;
      expect(result).toMatchObject({ blockIndex: index, position: { status: "exact" } });
      expect(run.mounts.at(-1)).toBe(index);
    }
    expect(run.scrolls.filter((entry) => entry.phase === "coarse")).toHaveLength(3);
    expect(run.scrolls.every((entry) => entry.phase !== "coarse" || entry.behavior === "instant")).toBe(true);
    expect(run.highlights).toHaveLength(3);
    run.destroy();
  });

  it("maps source-only blank lines to the next stable block before mounting", async () => {
    const run = createHarness(20);
    const controller = new MarkdownRevealController();
    controller.publish(run.context);
    const result = await controller.request({ kind: "source-line", line: 2 }, { align: "start" }).promise;

    expect(result).toMatchObject({ blockIndex: 1, position: { affinity: "next-block", status: "exact" } });
    expect(run.mounts).toEqual([1]);
    run.destroy();
  });

  it("uses the source offset inside a giant block for the coarse jump", async () => {
    const source = `${"large content ".repeat(20_000)}TAIL`;
    const snapshot = parseCanonicalMarkdownSnapshot({
      surface: "file",
      documentId: "file:giant.md",
      revision: "r1",
      source,
      rendererProfile: "file-preview",
    });
    const host = document.createElement("div");
    document.body.append(host);
    const runtime = new DocumentViewRuntime(host, { profile: FILE_MARKDOWN_RENDERER_PROFILE });
    runtime.publish(snapshot, [20_000], { scrollTop: 0, viewportHeight: 200 });
    const heightIndex = runtime.getHeightIndex()!;
    const mapper = new MarkdownPositionMapper(source, snapshot, { heightIndex, mounted: runtime });
    let scrollTop = 0;
    const controller = new MarkdownRevealController();
    controller.publish({
      snapshot,
      mapper,
      heightIndex,
      viewport: () => ({ scrollTop, viewportHeight: 200, viewportTop: 0 }),
      scrollTo: (input) => { scrollTop = input.scrollTop; },
      mount: () => {
        runtime.getBlockElement(snapshot.blocks[0].id)!.getBoundingClientRect = () => domRect(0, 20_000);
      },
    });
    const result = await controller.request({ kind: "source-offset", sourceOffset: source.indexOf("TAIL") }, { align: "start" }).promise;

    expect(result.coarseScrollTop).toBeGreaterThan(19_000);
    expect(result.position.status).toBe("exact");
    runtime.destroy();
    host.remove();
  });

  it("queues a pre-parse request and guarantees that only the latest request wins", async () => {
    const run = createHarness();
    const controller = new MarkdownRevealController();
    const first = controller.request({ kind: "block", blockId: run.snapshot.blocks[1].id });
    const latest = controller.request({ kind: "block", blockId: run.snapshot.blocks[150].id });
    await expect(first.promise).rejects.toMatchObject({ code: "superseded" });
    expect(run.scrolls).toHaveLength(0);

    controller.publish(run.context);
    await expect(latest.promise).resolves.toMatchObject({ blockIndex: 150 });
    expect(run.mounts).toEqual([150]);
    expect(controller.diagnostics()).toMatchObject({ requested: 2, completed: 1, superseded: 1, pending: false });
    run.destroy();
  });

  it("recomputes local geometry after resource reflow between coarse mount and fine correction", async () => {
    const run = createHarness();
    run.setMountHook((_input, mount) => {
      run.heightIndex.update(0, 200, { revision: "r1" });
      mount();
    });
    const controller = new MarkdownRevealController();
    controller.publish(run.context);
    const result = await controller.request(
      { kind: "block", blockId: run.snapshot.blocks[100].id },
      { align: "start" },
    ).promise;

    expect(result.fineAdjusted).toBe(true);
    expect(result.fineScrollTop - result.coarseScrollTop).toBe(113);
    expect(run.scrolls.map((entry) => entry.phase)).toEqual(["coarse", "fine"]);
    run.destroy();
  });

  it("lets user scrolling cancel a reveal that is waiting for the mount event", async () => {
    const run = createHarness();
    let release!: () => void;
    run.setMountHook((_input, mount) => new Promise<void>((resolve) => {
      release = () => { mount(); resolve(); };
    }));
    const controller = new MarkdownRevealController();
    controller.publish(run.context);
    const handle = controller.request({ kind: "block", blockId: run.snapshot.blocks[100].id });
    await Promise.resolve();
    controller.recordUserScroll();
    await expect(handle.promise).rejects.toMatchObject({ code: "user-interrupted" });
    release();
    await Promise.resolve();
    expect(run.scrolls.filter((entry) => entry.phase === "fine")).toHaveLength(0);
    run.destroy();
  });

  it("resolves annotation, turn, and capsule targets through the same mapper", async () => {
    const run = createHarness();
    const controller = new MarkdownRevealController();
    controller.publish(run.context);
    await expect(controller.request({ kind: "annotation", annotationId: "ann" }).promise)
      .resolves.toMatchObject({ blockIndex: 50 });
    await expect(controller.request({ kind: "turn", turnId: "turn" }).promise)
      .resolves.toMatchObject({ blockIndex: 75 });
    await expect(controller.request({ kind: "capsule", capsuleId: "capsule" }).promise)
      .resolves.toMatchObject({ blockIndex: 100 });
    run.destroy();
  });

  it("fails explicitly if the mount callback does not mount the target", async () => {
    const run = createHarness();
    const controller = new MarkdownRevealController();
    controller.publish({ ...run.context, mount: () => undefined });
    const target = run.snapshot.blocks[100].id;
    await expect(controller.request({ kind: "block", blockId: target }).promise)
      .rejects.toEqual(expect.objectContaining<Partial<MarkdownRevealError>>({ code: "target-not-mounted" }));
    run.destroy();
  });

  it("uses direct block handles and never scans the document globally", async () => {
    const run = createHarness();
    const globalQuery = vi.spyOn(document, "querySelectorAll");
    const controller = new MarkdownRevealController();
    controller.publish(run.context);
    await controller.request({ kind: "source-offset", sourceOffset: run.source.indexOf("Paragraph 150") }).promise;

    expect(globalQuery).not.toHaveBeenCalled();
    globalQuery.mockRestore();
    run.destroy();
  });
});
