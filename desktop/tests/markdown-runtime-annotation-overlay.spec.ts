import { describe, expect, it, vi } from "vitest";

import { createTextSelector } from "@/renderer/features/annotations/anchoring/createTextSelector";
import { resolveDocumentAnnotations } from "@/renderer/features/annotations/anchoring/resolveDocumentAnnotations";
import { createMarkdownTextModel } from "@/renderer/features/annotations/document/MarkdownTextModel";
import {
  createMarkdownAnnotationOverlayState,
  MarkdownAnnotationOverlayController,
  type MarkdownAnnotationOverlayMarker,
  type MarkdownAnnotationOverlayState,
} from "@/renderer/markdownRuntime/annotations";
import { MarkdownPositionMapper } from "@/renderer/markdownRuntime/mapping/MarkdownPositionMapper";
import {
  FILE_MARKDOWN_RENDERER_PROFILE,
  RetainedMarkdownDocumentRenderer,
} from "@/renderer/markdownRuntime/renderers";
import { parseCanonicalMarkdownSnapshot } from "@/renderer/markdownRuntime/worker/parser";
import type { AnnotationRecord } from "@/runtime/annotations";

describe("MarkdownAnnotationOverlayController", () => {
  it("materializes only mounted block-local markers and keeps distant markers logical", () => {
    const harness = setup("Alpha target\n\nBeta\n\nGamma target", [0]);
    const state = overlayState(harness, [
      markerForText(harness, "ann-alpha", "target", 0),
      markerForText(harness, "ann-gamma", "target", 1),
    ]);
    harness.controller.publish(state);
    const stats = harness.controller.syncMountedBlocks([harness.snapshot.blocks[0].id]);

    expect(stats).toMatchObject({
      mountedBlocks: 1,
      logicalMarkers: 2,
      unmountedMarkers: 1,
      markerFragments: 1,
    });
    expect(harness.root.querySelectorAll("[data-markdown-annotation-overlay]")).toHaveLength(1);
    expect(harness.root.querySelectorAll("[data-annotation-id='ann-alpha']")).toHaveLength(1);
    expect(harness.root.querySelector("[data-annotation-id='ann-gamma']")).toBeNull();
    harness.destroy();
  });

  it("builds overlay state directly from the shared resolved annotation index", () => {
    const harness = setup("# Guide\n\nUse **target** here.", [0, 1]);
    const model = createMarkdownTextModel(harness.source, harness.snapshot.revision, harness.snapshot);
    const start = model.logicalText.indexOf("target");
    const records = [record("ann", createTextSelector(model, { start, end: start + 6 }))];
    const index = resolveDocumentAnnotations(model, records);
    const state = createMarkdownAnnotationOverlayState(harness.snapshot, index, {
      activeAnnotationId: "ann",
      flashAnnotationId: "ann",
    });
    harness.controller.publish(state);
    harness.controller.syncMountedBlocks(harness.snapshot.blocks.map((block) => block.id));

    expect(state.markers).toHaveLength(1);
    expect(state.markers[0]).toMatchObject({ annotationId: "ann", blockId: harness.snapshot.blocks[1].id });
    expect(harness.root.querySelector("[data-annotation-id='ann']")).toMatchObject({
      dataset: expect.objectContaining({ active: "true", flash: "true" }),
    });
    harness.destroy();
  });

  it("re-renders only blocks whose ranges or active/hover/flash state changed", () => {
    const harness = setup("Alpha target\n\nBeta target", [0, 1]);
    const markers = [
      markerForText(harness, "alpha", "target", 0),
      markerForText(harness, "beta", "target", 1),
    ];
    harness.controller.syncMountedBlocks(harness.snapshot.blocks.map((block) => block.id));
    const initial = harness.controller.publish(overlayState(harness, markers));
    const unchanged = harness.controller.publish(overlayState(harness, markers));
    const active = harness.controller.publish(overlayState(harness, markers, { activeAnnotationId: "beta" }));
    const hovered = harness.controller.publish(overlayState(harness, markers, {
      activeAnnotationId: "beta",
      hoveredAnnotationId: "alpha",
    }));

    expect(initial.renderedBlocks).toBe(2);
    expect(unchanged).toMatchObject({ renderedBlocks: 0, changedBlocks: [] });
    expect(active).toMatchObject({ renderedBlocks: 1, changedBlocks: [harness.snapshot.blocks[1].id] });
    expect(hovered).toMatchObject({ renderedBlocks: 1, changedBlocks: [harness.snapshot.blocks[0].id] });
    expect(harness.root.querySelector("[data-annotation-id='beta']")?.getAttribute("data-active")).toBe("true");
    expect(harness.root.querySelector("[data-annotation-id='alpha']")?.getAttribute("data-hovered")).toBe("true");
    harness.destroy();
  });

  it("renders overlapping annotations as independent layered fragments", () => {
    const harness = setup("overlapping target text", [0]);
    const target = markerForText(harness, "target", "target", 0);
    const overlap = Object.freeze({
      ...target,
      annotationId: "overlap",
      blockLocalStart: target.blockLocalStart + 2,
      logicalStart: target.logicalStart + 2,
    });
    harness.controller.publish(overlayState(harness, [target, overlap], { activeAnnotationId: "overlap" }));
    harness.controller.syncMountedBlocks([target.blockId]);

    const elements = harness.root.querySelectorAll<HTMLElement>("[data-markdown-annotation-overlay-marker]");
    expect(elements).toHaveLength(2);
    expect(elements[0].style.zIndex).toBe("1");
    expect(elements[1].style.zIndex).toBe("3");
    harness.destroy();
  });

  it("uses block-local event delegation and can reveal an unmounted active annotation", async () => {
    const activate = vi.fn();
    const hover = vi.fn();
    const reveal = vi.fn();
    const harness = setup("Alpha target\n\nRemote target", [0], { onActivate: activate, onHover: hover, reveal });
    const local = markerForText(harness, "local", "target", 0);
    const remote = markerForText(harness, "remote", "target", 1);
    harness.controller.publish(overlayState(harness, [local, remote]));
    harness.controller.syncMountedBlocks([local.blockId]);
    const element = harness.root.querySelector<HTMLElement>("[data-annotation-id='local']")!;

    element.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    element.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
    await expect(harness.controller.revealAnnotation("remote")).resolves.toBe(true);

    expect(activate).toHaveBeenCalledWith("local");
    expect(hover).toHaveBeenNthCalledWith(1, "local");
    expect(hover).toHaveBeenLastCalledWith(null);
    expect(reveal).toHaveBeenCalledWith({ annotationId: "remote", blockId: remote.blockId, blockIndex: remote.blockIndex });
    harness.destroy();
  });

  it("removes overlays on viewport unmount and reconstructs them after block recycling", () => {
    const harness = setup("Alpha target\n\nBeta target", [0]);
    const alpha = markerForText(harness, "alpha", "target", 0);
    const beta = markerForText(harness, "beta", "target", 1);
    harness.controller.publish(overlayState(harness, [alpha, beta]));
    harness.controller.syncMountedBlocks([alpha.blockId]);
    const firstRoot = harness.renderer.getBlockElement(alpha.blockId)!;
    expect(firstRoot.querySelector("[data-annotation-id='alpha']")).not.toBeNull();

    harness.renderer.render(harness.snapshot, { blockIndices: [1] });
    const stats = harness.controller.syncMountedBlocks([beta.blockId]);

    expect(firstRoot.isConnected).toBe(false);
    expect(stats).toMatchObject({ mountedBlocks: 1, unmountedMarkers: 1, markerFragments: 1 });
    expect(harness.renderer.getBlockElement(beta.blockId)?.querySelector("[data-annotation-id='beta']")).not.toBeNull();
    harness.destroy();
  });

  it.each([
    ["paragraph", "Use **target** and [docs](README.md)."],
    ["list", "- alpha\n- target\n- omega"],
    ["table", "| name | value |\n| --- | --- |\n| target | 1 |"],
    ["code", "```ts\nconst target = true\n```"],
    ["link", "Read [target](README.md) now"],
  ])("maps a DOM Range inside mounted %s blocks without text search across the canvas", (_kind, source) => {
    const seenText: string[] = [];
    const harness = setup(source, undefined, {
      rectProvider: (range) => {
        seenText.push(range.toString());
        return [rect(5, 8, 42, 16)];
      },
    });
    const marker = markerForText(harness, "ann", "target", 0);
    harness.controller.publish(overlayState(harness, [marker]));
    harness.controller.syncMountedBlocks([marker.blockId]);

    expect(seenText).toEqual(["target"]);
    expect(harness.root.querySelector("[data-annotation-id='ann']")).not.toBeNull();
    harness.destroy();
  });

  it("does not disturb native selection or adjacent find highlight DOM", () => {
    const harness = setup("Alpha target and find", [0]);
    const block = harness.renderer.getBlockElement(harness.snapshot.blocks[0].id)!;
    const text = block.firstChild as Text;
    const nativeRange = document.createRange();
    nativeRange.setStart(text, 0);
    nativeRange.setEnd(text, 5);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(nativeRange);
    const find = document.createElement("mark");
    find.dataset.markdownFindHighlight = "true";
    find.textContent = "find-overlay";
    block.append(find);
    const marker = markerForText(harness, "ann", "target", 0);
    harness.controller.publish(overlayState(harness, [marker]));
    harness.controller.syncMountedBlocks([marker.blockId]);

    expect(selection.toString()).toBe("Alpha");
    expect(find.isConnected).toBe(true);
    expect(block.querySelector("[data-markdown-annotation-overlay]")?.textContent).toBe("");
    const annotationMarker = block.querySelector<HTMLElement>("[data-markdown-annotation-overlay-marker]");
    expect(annotationMarker?.style.pointerEvents).toBe("auto");
    expect(annotationMarker?.style.cursor).toBe("pointer");
    selection.removeAllRanges();
    harness.destroy();
  });

  it("rejects stale revisions and discards old overlay roots during Snapshot reconciliation", () => {
    const harness = setup("Alpha target", [0]);
    const marker = markerForText(harness, "ann", "target", 0);
    expect(() => harness.controller.publish({ ...overlayState(harness, [marker]), revision: "stale" }))
      .toThrow("Stale annotation overlay revision");
    harness.controller.publish(overlayState(harness, [marker]));
    harness.controller.syncMountedBlocks([marker.blockId]);

    const nextSnapshot = parse(harness.source, "r2", harness.snapshot);
    harness.renderer.render(nextSnapshot);
    const nextMapper = new MarkdownPositionMapper(harness.source, nextSnapshot, { mounted: harness.renderer });
    harness.controller.reconcileSnapshot(nextSnapshot, nextMapper);

    expect(harness.root.querySelector("[data-markdown-annotation-overlay]")).toBeNull();
    expect(harness.controller.mountedBlockIds()).toEqual([]);
    harness.destroy();
  });

  it("builds large marker indexes cooperatively and cancels obsolete publications", async () => {
    const harness = setup("Alpha target\n\nBeta target", [0]);
    const alpha = markerForText(harness, "alpha", "target", 0);
    const beta = markerForText(harness, "beta", "target", 1);
    const yielded = vi.fn(async () => Promise.resolve());
    const obsolete = harness.controller.publishAsync(
      overlayState(harness, [alpha, beta]),
      { yieldEvery: 1, yieldToMain: yielded },
    );
    const rejected = expect(obsolete).rejects.toMatchObject({ name: "AbortError" });
    const latest = harness.controller.publishAsync(
      { ...overlayState(harness, [beta]), annotationSetRevision: "annotations:latest" },
      { yieldEvery: 1, yieldToMain: yielded },
    );

    await rejected;
    await expect(latest).resolves.toMatchObject({ logicalMarkers: 1 });
    expect(yielded).toHaveBeenCalled();
    expect(harness.controller.markersForBlock(beta.blockId)).toEqual([beta]);
    harness.destroy();
  });

  it("indexes 10k logical markers but measures only the one mounted block", () => {
    const source = Array.from({ length: 10_000 }, (_, index) => `Block ${index} target`).join("\n\n");
    const rectProvider = vi.fn(() => [rect(0, 0, 40, 16)]);
    const harness = setup(source, [0], { rectProvider });
    const markers = harness.snapshot.blocks.map((block, index) => markerForBlock(block, `ann-${index}`, 8, 14));
    harness.controller.publish(overlayState(harness, markers));
    const stats = harness.controller.syncMountedBlocks([harness.snapshot.blocks[0].id]);
    rectProvider.mockClear();
    const remoteActive = harness.controller.updateInteractionState({ activeAnnotationId: "ann-9999" });
    const localActive = harness.controller.updateInteractionState({ activeAnnotationId: "ann-0" });

    expect(stats).toMatchObject({ logicalMarkers: 10_000, unmountedMarkers: 9_999, markerFragments: 1 });
    expect(remoteActive).toMatchObject({ renderedBlocks: 0, changedBlocks: [harness.snapshot.blocks[9_999].id] });
    expect(localActive).toMatchObject({ renderedBlocks: 1 });
    expect(rectProvider).toHaveBeenCalledTimes(1);
    expect(harness.root.querySelectorAll("[data-markdown-block-id]")).toHaveLength(1);
    harness.destroy();
  });
});

function setup(
  source: string,
  selectedIndices?: readonly number[],
  options: {
    rectProvider?: (range: Range, block: HTMLElement) => readonly DOMRectReadOnly[];
    reveal?: (target: { annotationId: string; blockId: string; blockIndex: number }) => void | Promise<void>;
    onActivate?: (annotationId: string) => void;
    onHover?: (annotationId: string | null) => void;
  } = {},
) {
  const snapshot = parse(source);
  const root = document.createElement("div");
  document.body.append(root);
  const renderer = new RetainedMarkdownDocumentRenderer(root, { profile: FILE_MARKDOWN_RENDERER_PROFILE });
  renderer.render(snapshot, { blockIndices: selectedIndices ?? snapshot.blocks.map((block) => block.index) });
  const mapper = new MarkdownPositionMapper(source, snapshot, { mounted: renderer });
  const controller = new MarkdownAnnotationOverlayController({
    snapshot,
    mapper,
    mounted: renderer,
    rectProvider: options.rectProvider ?? (() => [rect(10, 20, 60, 18)]),
    reveal: options.reveal,
    onActivate: options.onActivate,
    onHover: options.onHover,
  });
  return {
    source,
    snapshot,
    root,
    renderer,
    controller,
    destroy() {
      controller.destroy();
      renderer.destroy();
      root.remove();
    },
  };
}

function parse(source: string, revision = "r1", previousSnapshot?: ReturnType<typeof parseCanonicalMarkdownSnapshot>) {
  return parseCanonicalMarkdownSnapshot({
    surface: "file",
    documentId: "file:annotation-overlay.md",
    revision,
    source,
    rendererProfile: "file-preview",
  }, { previousSnapshot });
}

function markerForText(
  harness: ReturnType<typeof setup>,
  annotationId: string,
  exact: string,
  occurrence: number,
): MarkdownAnnotationOverlayMarker {
  let logicalStart = -1;
  for (let index = 0; index <= occurrence; index += 1) {
    logicalStart = harness.snapshot.logical_text.indexOf(exact, logicalStart + 1);
  }
  if (logicalStart < 0) throw new Error(`Missing ${exact}`);
  const block = harness.snapshot.blocks.find((entry) =>
    logicalStart >= entry.logical_start && logicalStart + exact.length <= entry.logical_end)!;
  return markerForBlock(
    block,
    annotationId,
    logicalStart - block.logical_start,
    logicalStart - block.logical_start + exact.length,
  );
}

function markerForBlock(
  block: ReturnType<typeof parseCanonicalMarkdownSnapshot>["blocks"][number],
  annotationId: string,
  blockLocalStart: number,
  blockLocalEnd: number,
): MarkdownAnnotationOverlayMarker {
  return Object.freeze({
    annotationId,
    blockId: block.id,
    blockIndex: block.index,
    blockLocalStart,
    blockLocalEnd,
    logicalStart: block.logical_start + blockLocalStart,
    logicalEnd: block.logical_start + blockLocalEnd,
  });
}

function overlayState(
  harness: ReturnType<typeof setup>,
  markers: readonly MarkdownAnnotationOverlayMarker[],
  options: Partial<Pick<MarkdownAnnotationOverlayState, "activeAnnotationId" | "hoveredAnnotationId" | "flashAnnotationId">> = {},
): MarkdownAnnotationOverlayState {
  return {
    revision: harness.snapshot.revision,
    annotationSetRevision: `annotations:${markers.map((marker) => marker.annotationId).join("-")}`,
    activeAnnotationId: options.activeAnnotationId ?? null,
    hoveredAnnotationId: options.hoveredAnnotationId ?? null,
    flashAnnotationId: options.flashAnnotationId ?? null,
    markers,
  };
}

function record(
  id: string,
  selector: Extract<AnnotationRecord["target"], { type: "text" }>["selector"],
): AnnotationRecord {
  return {
    id,
    workspace_id: "ws",
    document_path: "README.md",
    target: { type: "text", selector },
    body: id,
    created_at: "2026-01-01",
    updated_at: "2026-01-01",
  };
}

function rect(left: number, top: number, width: number, height: number): DOMRectReadOnly {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRectReadOnly;
}
