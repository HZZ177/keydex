import { describe, expect, it, vi } from "vitest";

import { buildMarkdownFindIndex, MarkdownFindController } from "@/renderer/markdownRuntime/find";
import { MarkdownPositionMapper } from "@/renderer/markdownRuntime/mapping";
import { MarkdownOutlineController } from "@/renderer/markdownRuntime/navigation";
import { FILE_MARKDOWN_RENDERER_PROFILE } from "@/renderer/markdownRuntime/renderers";
import { DocumentViewRuntime } from "@/renderer/markdownRuntime/view/DocumentViewRuntime";
import { MarkdownNavigationIntentController } from "@/renderer/markdownRuntime/view/NavigationIntent";
import { MarkdownRevealController, type MarkdownRevealContext } from "@/renderer/markdownRuntime/view/RevealController";
import type { MarkdownViewRevealTarget } from "@/renderer/markdownRuntime/view/types";
import { parseCanonicalMarkdownSnapshot } from "@/renderer/markdownRuntime/worker/parser";
import {
  MARKDOWN_WORKER_PROTOCOL_VERSION,
  type MarkdownFindMatchPayload,
  type MarkdownWorkerRequest,
  type MarkdownWorkerResponse,
} from "@/renderer/markdownRuntime/worker/protocol";
import { parseMarkdownFileLinkExpression } from "@/renderer/utils/fileLinks";

const DESCRIPTOR = Object.freeze({
  scopeId: "workspace:navigation",
  entryId: "file:D:/repo/navigation.md",
  viewId: "preview-main",
  kind: "preview" as const,
});

describe("Mapping, Reveal and Navigation cross-module gate", () => {
  it("keeps path+line, source-only lines, same-file capsules, reflow and user interruption in one state machine", async () => {
    const run = createHarness();
    const executed: Array<{ target: MarkdownViewRevealTarget; result?: { blockIndex: number } }> = [];
    const navigation = bindNavigation(run, executed);
    const parsed = parseMarkdownFileLinkExpression(`[tail](<D:/repo/navigation.md:${run.tailLine}>)`)!;
    const globalScan = vi.spyOn(document, "querySelectorAll");

    await navigation.requestReveal({ kind: "source-line", line: parsed.line! }).promise;
    const tailIndex = run.snapshot.blocks.findIndex((block) => (
      block.source_start <= run.tailOffset && run.tailOffset < block.source_end
    ));
    expect(executed.at(-1)?.result?.blockIndex).toBe(tailIndex);
    expect(run.runtime.mountedBlockIds()).toContain(run.snapshot.blocks[tailIndex].id);

    await navigation.requestReveal({ kind: "source-line", line: run.commentLine }).promise;
    expect(executed.at(-1)?.result?.blockIndex).toBeGreaterThan(0);
    await navigation.requestReveal({
      kind: "capsule",
      capsuleId: "context-tail",
      sourceOffset: run.tailOffset,
    }).promise;
    expect(executed.at(-1)?.result?.blockIndex).toBe(tailIndex);
    expect(new Set(run.intents.map((intent) => intent.descriptor.entryId))).toEqual(new Set([DESCRIPTOR.entryId]));
    expect(run.highlights.at(-1)).toMatchObject({ blockIndex: tailIndex });
    expect(run.scrolls.some((entry) => entry.phase === "fine")).toBe(true);
    expect(globalScan).not.toHaveBeenCalled();
    globalScan.mockRestore();

    let release!: () => void;
    run.setMountGate((mount) => new Promise<void>((resolve) => {
      release = () => { mount(); resolve(); };
    }));
    const interrupted = navigation.requestReveal({ kind: "source-line", line: 3 });
    await Promise.resolve();
    navigation.recordUserScroll();
    await expect(interrupted.promise).rejects.toMatchObject({ code: "user-interrupted" });
    release();
    await Promise.resolve();
    expect(navigation.diagnostics()).toMatchObject({ userInterrupted: 1, pending: false });

    navigation.destroy();
    run.destroy();
  });

  it("expands a folded outline target and wraps find navigation through the same reveal path", async () => {
    const run = createHarness();
    const executed: Array<{ target: MarkdownViewRevealTarget; result?: { blockIndex: number } }> = [];
    const navigation = bindNavigation(run, executed);
    const heights = run.snapshot.blocks.map(() => 100);
    const outline = new MarkdownOutlineController(
      run.snapshot,
      run.heightIndex,
      heights,
      { reveal: (target) => navigation.requestReveal(target).promise },
    );
    const [root, nested] = outline.nodes();
    outline.toggleFold(root.blockId, { scrollTop: run.scrollTop, viewportHeight: 240 });
    expect(outline.hiddenIndices()).toContain(nested.blockIndex);
    const outlineResult = await outline.navigateOutline(nested.id, {
      scrollTop: run.scrollTop,
      viewportHeight: 240,
    });
    expect(outlineResult.expandedHeadingBlockIds).toContain(root.blockId);
    expect(outline.hiddenIndices()).not.toContain(nested.blockIndex);
    expect(run.runtime.mountedBlockIds()).toContain(nested.blockId);

    const findIndex = buildMarkdownFindIndex(run.snapshot, "repeat");
    const find = new MarkdownFindController({
      snapshot: run.snapshot,
      reveal: (target) => navigation.requestReveal(target).promise,
      attachment: {
        request: async (request) => findResponse(request, findIndex.matches.map(findPayload)),
      },
    });
    await find.query("repeat");
    expect(find.current().activeIndex).toBe(0);
    await find.previous();
    expect(find.current().activeIndex).toBe(findIndex.matches.length - 1);
    const lastMatch = findIndex.matches.at(-1)!;
    expect(run.runtime.mountedBlockIds()).toContain(lastMatch.blockId);
    expect(run.highlights.at(-1)).toMatchObject({ blockIndex: lastMatch.blockIndex });
    await find.next();
    expect(find.current().activeIndex).toBe(0);
    expect(executed.filter((entry) => entry.target.kind === "source-offset").length).toBeGreaterThanOrEqual(2);

    navigation.destroy();
    run.destroy();
  });
});

function createHarness() {
  const parts = ["# Root", "", "Root repeat"];
  for (let index = 0; index < 120; index += 1) parts.push("", `Paragraph ${index} repeat`);
  parts.push("", "## Nested", "", "Nested repeat", "", "<!-- source-only comment -->");
  const commentLine = parts.join("\n").split("\n").length;
  for (let index = 120; index < 260; index += 1) parts.push("", `Paragraph ${index} repeat`);
  parts.push("", "TAIL repeat target");
  const source = parts.join("\n");
  const tailOffset = source.indexOf("TAIL repeat target");
  const tailLine = source.slice(0, tailOffset).split("\n").length;
  const snapshot = parseCanonicalMarkdownSnapshot({
    surface: "file",
    documentId: "file:D:/repo/navigation.md",
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
  runtime.publish(snapshot, snapshot.blocks.map(() => 100), { scrollTop: 0, viewportHeight: 240 });
  const heightIndex = runtime.getHeightIndex()!;
  const mapper = new MarkdownPositionMapper(source, snapshot, { heightIndex, mounted: runtime });
  let scrollTop = 0;
  let reflowed = false;
  let mountGate: ((mount: () => void) => void | Promise<void>) | null = null;
  const scrolls: Array<{ phase: string; scrollTop: number }> = [];
  const highlights: Array<{ blockIndex: number; target: MarkdownViewRevealTarget }> = [];
  const intents: Array<{ descriptor: typeof DESCRIPTOR }> = [];
  const context: MarkdownRevealContext = {
    snapshot,
    mapper,
    heightIndex,
    viewport: () => ({ scrollTop, viewportHeight: 240, viewportTop: 20 }),
    scrollTo: (input) => {
      scrollTop = input.scrollTop;
      scrolls.push({ phase: input.phase, scrollTop: input.scrollTop });
    },
    mount: (input) => {
      const mount = () => {
        if (!reflowed && input.blockIndex > 100) {
          heightIndex.update(0, 180, { revision: snapshot.revision });
          reflowed = true;
        }
        runtime.updateViewport({
          scrollTop: input.scrollTop,
          viewportHeight: 240,
          pinnedIndices: input.pinnedIndices,
        }, { origin: "automatic" });
        const element = runtime.getBlockElement(input.blockId)!;
        element.getBoundingClientRect = () => rect(
          heightIndex.offsetOf(input.blockIndex) - scrollTop + 27,
          heightIndex.heightAt(input.blockIndex),
        );
      };
      return mountGate ? mountGate(mount) : mount();
    },
    highlight: ({ target, position }) => {
      highlights.push({ blockIndex: position.blockIndex!, target });
    },
  };
  return {
    source,
    snapshot,
    runtime,
    heightIndex,
    context,
    scrolls,
    highlights,
    intents,
    tailOffset,
    tailLine,
    commentLine,
    get scrollTop() { return scrollTop; },
    setMountGate(value: typeof mountGate) { mountGate = value; },
    destroy() { runtime.destroy(); host.remove(); },
  };
}

function bindNavigation(
  run: ReturnType<typeof createHarness>,
  executed: Array<{ target: MarkdownViewRevealTarget; result?: { blockIndex: number } }>,
) {
  const reveal = new MarkdownRevealController();
  reveal.publish(run.context);
  const navigation = new MarkdownNavigationIntentController(DESCRIPTOR, run.snapshot.document_id);
  navigation.publishRuntime({
    revision: run.snapshot.revision,
    epoch: 1,
    execute: async (intent, signal) => {
      run.intents.push(intent as unknown as { descriptor: typeof DESCRIPTOR });
      if (intent.payload.type !== "reveal") return;
      const entry: { target: MarkdownViewRevealTarget; result?: { blockIndex: number } } = {
        target: intent.payload.target,
      };
      executed.push(entry);
      const result = await reveal.request(intent.payload.target, { signal }).promise;
      entry.result = { blockIndex: result.blockIndex };
    },
  });
  const destroy = navigation.destroy.bind(navigation);
  navigation.destroy = () => {
    reveal.destroy();
    destroy();
  };
  return navigation;
}

function findPayload(match: ReturnType<typeof buildMarkdownFindIndex>["matches"][number]): MarkdownFindMatchPayload {
  return {
    id: match.id,
    block_id: match.blockId,
    block_index: match.blockIndex,
    block_local_start: match.blockLocalStart,
    block_local_end: match.blockLocalEnd,
    logical_start: match.logicalStart,
    logical_end: match.logicalEnd,
    source_start: match.sourceStart,
    source_end: match.sourceEnd,
    match_text: match.matchText,
    snippet: match.snippet,
  };
}

function findResponse(request: MarkdownWorkerRequest, matches: MarkdownFindMatchPayload[]): MarkdownWorkerResponse {
  return {
    protocol_version: MARKDOWN_WORKER_PROTOCOL_VERSION,
    surface: request.surface,
    document_id: request.document_id,
    revision: request.revision,
    request_id: request.request_id,
    type: "find-result",
    payload: { query: request.type === "query-find" ? request.payload.query : "", matches },
  };
}

function rect(top: number, height: number): DOMRect {
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
