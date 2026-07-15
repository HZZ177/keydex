import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  useRef,
  useState,
  type ComponentProps,
  type MutableRefObject,
} from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FileMarkdownRuntimeHost,
  resolveFileMarkdownScrollAnchorBlockIndex,
  type FileMarkdownRuntimeHostHandle,
  type FileMarkdownRuntimeSnapshotLoader,
} from "@/renderer/components/workspace/FileMarkdownRuntimeHost";
import { FilePreview } from "@/renderer/components/workspace/FilePreview";
import type { MarkdownSnapshot } from "@/renderer/markdownRuntime/document/MarkdownSnapshot";
import type { MarkdownFindIndex } from "@/renderer/markdownRuntime/find";
import type { AnnotationRenderState } from "@/renderer/features/annotations/navigation/types";
import type { MarkdownAnnotationBinding } from "@/renderer/features/annotations/adapters/MarkdownAnnotationAdapter";
import { parseCanonicalMarkdownSnapshot } from "@/renderer/markdownRuntime/worker/parser";
import { markdownRuntimeDiagnostics } from "@/renderer/markdownRuntime/diagnostics";
import { APP_FIND_SHORTCUT_EVENT } from "@/renderer/events/findShortcut";
import type { MarkdownViewDescriptor } from "@/renderer/markdownRuntime/view";
import { resetFileMarkdownRuntimeStoreForTests } from "@/renderer/components/workspace/fileMarkdownRuntime";

class FakeResizeObserver {
  static readonly instances: FakeResizeObserver[] = [];
  readonly targets = new Set<Element>();
  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this);
  }
  observe(target: Element) { this.targets.add(target); }
  unobserve(target: Element) { this.targets.delete(target); }
  disconnect() { this.targets.clear(); }
  resize(target: Element, height: number) {
    this.callback([{ target, contentRect: new DOMRect(0, 0, 900, height) } as ResizeObserverEntry], this as unknown as ResizeObserver);
  }
}

let restoreMetrics: (() => void) | null = null;
let restoreScrollTo: (() => void) | null = null;
let restoreRangeMetrics: (() => void) | null = null;

beforeEach(() => {
  FakeResizeObserver.instances.length = 0;
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  restoreMetrics = mockElementMetrics({ clientHeight: 400, clientWidth: 900 });
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn(function scrollTo(this: HTMLElement, options: ScrollToOptions | number) {
      this.scrollTop = typeof options === "number" ? options : options.top ?? this.scrollTop;
    }),
  });
  restoreScrollTo = () => {
    if (original) Object.defineProperty(HTMLElement.prototype, "scrollTo", original);
    else delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
  };
  const rangeRect = Object.getOwnPropertyDescriptor(Range.prototype, "getBoundingClientRect");
  const rangeRects = Object.getOwnPropertyDescriptor(Range.prototype, "getClientRects");
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect(0, 0, 48, 18),
  });
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => [new DOMRect(0, 0, 48, 18)],
  });
  restoreRangeMetrics = () => {
    if (rangeRect) Object.defineProperty(Range.prototype, "getBoundingClientRect", rangeRect);
    else delete (Range.prototype as { getBoundingClientRect?: unknown }).getBoundingClientRect;
    if (rangeRects) Object.defineProperty(Range.prototype, "getClientRects", rangeRects);
    else delete (Range.prototype as { getClientRects?: unknown }).getClientRects;
  };
});

afterEach(() => {
  restoreMetrics?.();
  restoreMetrics = null;
  restoreScrollTo?.();
  restoreScrollTo = null;
  restoreRangeMetrics?.();
  restoreRangeMetrics = null;
  resetFileMarkdownRuntimeStoreForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("FileMarkdownRuntimeHost", () => {
  it("remeasures mounted blocks and moves following blocks after responsive reflow", async () => {
    render(<RuntimeHarness source={"First paragraph\n\nSecond paragraph\n\nThird paragraph"} revision="measure-r1" loader={snapshotLoader()} />);
    const canvas = await readyRuntimeCanvas();
    const blocks = [...canvas.querySelectorAll<HTMLElement>("[data-markdown-block-id]")];
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    const first = blocks[0]!;
    const second = blocks[1]!;
    const before = Number(second.dataset.markdownBlockTop);
    const observer = FakeResizeObserver.instances.find((candidate) => candidate.targets.has(first));
    expect(observer).toBeTruthy();

    act(() => observer!.resize(first, 180));

    await waitFor(() => expect(Number(second.dataset.markdownBlockTop)).toBeGreaterThan(before + 100));
    expect(Number(first.dataset.markdownBlockHeight)).toBe(192);
  });

  it("keeps a live resource reflow authoritative over an older observer measurement", async () => {
    render(<RuntimeHarness source={"First paragraph\n\nSecond paragraph\n\nThird paragraph"} revision="resource-r1" loader={snapshotLoader()} />);
    const canvas = await readyRuntimeCanvas();
    const blocks = [...canvas.querySelectorAll<HTMLElement>("[data-markdown-block-id]")];
    const first = blocks[0]!;
    const second = blocks[1]!;
    vi.spyOn(first, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 760, 80));
    vi.spyOn(canvas, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 760, 400));
    const environmentObserver = FakeResizeObserver.instances.find((candidate) => candidate.targets.has(canvas));
    const measurementObserver = FakeResizeObserver.instances.find((candidate) => candidate.targets.has(first));
    expect(environmentObserver).toBeTruthy();
    expect(measurementObserver).toBeTruthy();

    act(() => {
      environmentObserver!.resize(canvas, 400);
      measurementObserver!.resize(first, 500);
    });

    await waitFor(() => expect(Number(second.dataset.markdownBlockTop)).toBe(92));
    expect(Number(first.dataset.markdownBlockHeight)).toBe(92);
  });

  it("publishes semantic content and keeps the mounted DOM bounded", async () => {
    const source = Array.from({ length: 500 }, (_, index) => `## Heading ${index}\n\nParagraph ${index}`).join("\n\n");
    const loader = snapshotLoader();
    const handle = { current: null } as MutableRefObject<FileMarkdownRuntimeHostHandle | null>;

    render(<RuntimeHarness source={source} revision="r1" loader={loader} runtimeRef={handle} />);

    const canvas = await readyRuntimeCanvas();
    expect(loader).toHaveBeenCalledTimes(1);
    expect(canvas.querySelector("h2")?.textContent).toContain("Heading 0");
    expect(Number(canvas.dataset.markdownMountedBlockCount)).toBeGreaterThan(0);
    expect(Number(canvas.dataset.markdownMountedBlockCount)).toBeLessThan(80);
    expect(canvas.querySelectorAll("[data-markdown-block-id]").length).toBeLessThan(80);
    expect(handle.current?.diagnostics()).toMatchObject({
      revision: "r1",
      snapshotBlocks: 1_000,
      mountedBlocks: Number(canvas.dataset.markdownMountedBlockCount),
      image: { entries: 0, referenced: 0 },
      mermaid: { entries: 0, referenced: 0 },
    });
    expect(handle.current?.diagnostics()?.domNodes).toBe(canvas.querySelectorAll("*").length);
  });

  it("coalesces scroll bursts into one retained viewport patch without rerendering React", async () => {
    const source = Array.from({ length: 300 }, (_, index) => `Paragraph ${index}`).join("\n\n");
    const renderCount = { current: 0 };
    render(<RuntimeHarness source={source} revision="r1" loader={snapshotLoader()} renderCount={renderCount} />);
    const canvas = await readyRuntimeCanvas();
    const scroll = screen.getByTestId("runtime-scroll");
    const beforeReactRenders = renderCount.current;
    const beforeRuntimePatches = Number(canvas.dataset.markdownRuntimeRenderCount);

    act(() => {
      for (let index = 1; index <= 100; index += 1) {
        scroll.scrollTop = index * 80;
        fireEvent.scroll(scroll);
      }
    });

    await waitFor(() => expect(Number(canvas.dataset.markdownRuntimeRenderCount)).toBeGreaterThan(beforeRuntimePatches));
    expect(renderCount.current).toBe(beforeReactRenders);
    expect(Number(canvas.dataset.markdownRuntimeRenderCount) - beforeRuntimePatches).toBe(1);
    expect(canvas.querySelectorAll("[data-markdown-block-id]").length).toBeLessThan(80);
  });

  it("falls back to the source offset when a visible-prefix block id is absent from the canonical snapshot", () => {
    const source = ["# Title", "", "First paragraph", "", "Second paragraph", "", "Third paragraph"].join("\n");
    const visiblePrefixSnapshot = parseCanonicalMarkdownSnapshot({
      surface: "file",
      documentId: "file:workspace-1:README.md#visible-prefix",
      revision: "visible-r1",
      source,
      rendererProfile: "file-preview",
    });
    const canonicalSnapshot = parse(source, "canonical-r1");
    const anchorBlock = visiblePrefixSnapshot.blocks[2]!;

    expect(canonicalSnapshot.blocks[anchorBlock.index]?.id).not.toBe(anchorBlock.id);
    expect(resolveFileMarkdownScrollAnchorBlockIndex(
      canonicalSnapshot,
      { blockId: anchorBlock.id, sourceOffset: anchorBlock.source_start },
      (blockId) => canonicalSnapshot.blocks.find((block) => block.id === blockId)?.index ?? null,
    )).toBe(anchorBlock.index);
  });

  it("reveals source lines and blocks through the height index", async () => {
    const handle = { current: null } as MutableRefObject<FileMarkdownRuntimeHostHandle | null>;
    const source = Array.from({ length: 200 }, (_, index) => `## Heading ${index}\n\nBody ${index}`).join("\n\n");
    render(<RuntimeHarness source={source} revision="r1" loader={snapshotLoader()} runtimeRef={handle} />);
    const canvas = await readyRuntimeCanvas();
    const scroll = screen.getByTestId("runtime-scroll");
    const snapshot = handle.current?.currentSnapshot();
    const tailHeading = snapshot?.outline.at(-1);

    expect(tailHeading).toBeTruthy();
    expect(handle.current?.revealSourceLine(tailHeading!.source_line, { behavior: "auto", align: "center" })).toBe(true);
    expect(scroll.scrollTop).toBeGreaterThan(0);
    const highlightedBlock = canvas.querySelector<HTMLElement>("[data-markdown-source-reveal-active='true'][data-markdown-block-id]");
    expect(highlightedBlock?.dataset.markdownBlockId).toBe(tailHeading!.block_id);
    expect(highlightedBlock?.dataset.markdownSourceRevealLineStart).toBe(String(tailHeading!.source_line));
    expect(canvas.querySelector("[data-markdown-preview-line-number='true'][data-markdown-source-reveal-active='true']"))
      .toBeNull();
    const revealMarker = await waitFor(() => {
      const marker = canvas.querySelector<HTMLElement>("[data-markdown-source-reveal-marker='true']");
      expect(marker).not.toBeNull();
      return marker!;
    });
    expect(revealMarker.dataset.active).toBe("true");
    expect(revealMarker.dataset.filePreviewFindMatch).toBeUndefined();
    expect(revealMarker.style.background).toBe(
      "color-mix(in srgb, var(--warning, #f0a020) 58%, transparent)",
    );
    expect(revealMarker.style.boxShadow).toBe(
      "inset 0 -2px 0 color-mix(in srgb, var(--warning, #f0a020) 95%, transparent)",
    );
    const otherBlock = [...canvas.querySelectorAll<HTMLElement>("[data-markdown-block-id]")]
      .find((element) => element !== highlightedBlock);
    expect(otherBlock).toBeTruthy();
    fireEvent.click(otherBlock!);
    expect(canvas.querySelector("[data-markdown-source-reveal-active='true']")).toBeNull();
    expect(canvas.querySelector("[data-markdown-source-reveal-marker='true']")).toBeNull();
    expect(handle.current?.revealBlock(tailHeading!.block_id, { behavior: "auto" })).toBe(true);
    expect(scroll.scrollTop).toBeGreaterThan(0);
  });

  it("maps a split-view scroll position through source offsets instead of shared pixels", async () => {
    const handle = { current: null } as MutableRefObject<FileMarkdownRuntimeHostHandle | null>;
    const source = Array.from({ length: 160 }, (_, index) => `## Heading ${index}\n\nBody ${index}`).join("\n\n");
    render(<RuntimeHarness source={source} revision="sync-r1" loader={snapshotLoader()} runtimeRef={handle} />);
    await readyRuntimeCanvas();
    const snapshot = handle.current?.currentSnapshot();
    const targetBlock = snapshot?.blocks[Math.floor((snapshot?.blocks.length ?? 0) / 2)];
    expect(targetBlock).toBeTruthy();
    const targetOffset = Math.floor((targetBlock!.source_start + targetBlock!.source_end) / 2);

    expect(handle.current?.syncViewportToSourceOffset(targetOffset)).toBe(true);

    expect(screen.getByTestId("runtime-scroll").scrollTop).toBeGreaterThan(0);
    expect(handle.current?.viewportSourceOffset()).toBe(targetOffset);
  });

  it("round-trips an uneven multiline block through a source-line anchor", async () => {
    const handle = { current: null } as MutableRefObject<FileMarkdownRuntimeHostHandle | null>;
    const prefix = Array.from({ length: 80 }, (_, index) => `## Heading ${index}\n\nBody ${index}`).join("\n\n");
    const suffix = Array.from({ length: 40 }, (_, index) => `## Tail ${index}\n\nTail body ${index}`).join("\n\n");
    const source = [
      prefix,
      "```text",
      "short",
      `TARGET ${"wide ".repeat(120)}`,
      "tail",
      "```",
      suffix,
    ].join("\n");
    const targetLine = source.split("\n").findIndex((line) => line.startsWith("TARGET ")) + 1;
    let measuredBlockId: string | null = null;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function rect(this: HTMLElement) {
      return this.dataset.markdownBlockId === measuredBlockId
        ? new DOMRect(0, 0, 900, 600)
        : new DOMRect(0, 0, 900, 0);
    });
    render(<RuntimeHarness source={source} revision="line-sync-r1" loader={snapshotLoader()} runtimeRef={handle} />);
    await readyRuntimeCanvas();
    const zeroBasedTargetLine = targetLine - 1;
    measuredBlockId = handle.current?.currentSnapshot()?.blocks.find((block) => (
      block.line_start <= zeroBasedTargetLine && zeroBasedTargetLine < block.line_end
    ))?.id ?? null;
    expect(measuredBlockId).not.toBeNull();
    const scroll = screen.getByTestId("runtime-scroll") as HTMLElement;

    expect(handle.current?.syncViewportToSourceAnchor({ line: targetLine, lineProgress: 0.35 })).toBe(true);

    expect(vi.mocked(scroll.scrollTo).mock.calls.length).toBeGreaterThanOrEqual(2);
    const roundTripped = handle.current?.viewportSourceAnchor();
    expect(roundTripped?.line).toBe(targetLine);
    expect(roundTripped?.lineProgress).toBeCloseTo(0.35, 8);
  });

  it("persists Runtime folds across preview remounts and expands a folded section for reveal", async () => {
    const descriptor: MarkdownViewDescriptor = Object.freeze({
      scopeId: "scope-fold",
      entryId: "entry-fold",
      viewId: "preview-fold",
      kind: "preview",
    });
    const source = ["# Title", "", "Intro", "", "## Child", "", "Body", "", "# Next", "", "Tail"].join("\n");
    const first = render(
      <RuntimeHarness
        source={source}
        revision="fold-r1"
        loader={snapshotLoader()}
        viewDescriptor={descriptor}
      />,
    );
    await readyRuntimeCanvas();
    const titleButton = document.querySelector<HTMLButtonElement>(
      "[data-markdown-preview-fold-button='true'][data-markdown-preview-fold-kind='section']",
    )!;
    fireEvent.click(titleButton);
    expect(document.querySelector("[data-markdown-preview-fold-motion='collapse']")).not.toBeNull();
    await waitFor(() => expect(titleButton.getAttribute("aria-expanded")).toBe("false"));
    expect(document.querySelector("[data-markdown-preview-collapsed-section='true']")).not.toBeNull();

    first.unmount();
    const handle = { current: null } as MutableRefObject<FileMarkdownRuntimeHostHandle | null>;
    render(
      <RuntimeHarness
        source={source}
        revision="fold-r1"
        loader={snapshotLoader()}
        runtimeRef={handle}
        viewDescriptor={descriptor}
      />,
    );
    await readyRuntimeCanvas();
    const restored = document.querySelector<HTMLButtonElement>(
      "[data-markdown-preview-fold-button='true'][data-markdown-preview-fold-kind='section']",
    )!;
    expect(restored.getAttribute("aria-expanded")).toBe("false");

    const child = handle.current!.currentSnapshot()!.blocks[2]!;
    expect(handle.current!.revealBlock(child.id, { behavior: "auto" })).toBe(true);
    expect(restored.getAttribute("aria-expanded")).toBe("true");
    expect(handle.current!.getBlockElement(child.id)).not.toBeNull();
  });

  it("queries the runtime index and retains block-local Find overlays", async () => {
    const handle = { current: null } as MutableRefObject<FileMarkdownRuntimeHostHandle | null>;
    const source = Array.from({ length: 240 }, (_, index) => `Paragraph ${index} runtime-target`).join("\n\n");
    const rendered = render(<RuntimeHarness source={source} revision="find-r1" loader={snapshotLoader()} runtimeRef={handle} />);
    await readyRuntimeCanvas();

    const index = await handle.current!.queryFind("runtime-target");
    expect(index.matches).toHaveLength(240);
    expect(index.matches.at(-1)?.sourceStart).toBeGreaterThan(source.length * 0.8);

    rendered.rerender(
      <RuntimeHarness
        source={source}
        revision="find-r1"
        loader={snapshotLoader()}
        runtimeRef={handle}
        findIndex={index}
        activeFindMatchId={index.matches[0]!.id}
      />,
    );
    await waitFor(() => expect(document.querySelectorAll("[data-markdown-find-match='true']").length).toBeGreaterThan(0));
    expect(document.querySelectorAll("[data-markdown-find-match='true']").length).toBeLessThan(80);
    expect(document.querySelectorAll("[data-markdown-find-match='true'][data-active='true']")).toHaveLength(1);
    expect(document.querySelector("[data-markdown-find-overlay='true'] [data-annotation-id]")).toBeNull();
  });

  it("renders runtime annotation overlays through the unified adapter binding", async () => {
    const source = "# Runtime annotations\n\nAnnotated paragraph";
    const snapshot = parse(source, "annotation-r1");
    const paragraph = snapshot.blocks.at(-1)!;
    const activate = vi.fn();
    const bind = vi.fn(() => vi.fn());
    const renderState: AnnotationRenderState = Object.freeze({
      activeAnnotationId: "annotation-1",
      flashAnnotationId: null,
      flashToken: 0,
      hoveredAnnotationId: null,
      revision: "annotations:1",
      markers: Object.freeze([Object.freeze({
        annotationId: "annotation-1",
        logicalRange: Object.freeze({ start: paragraph.logical_start, end: paragraph.logical_start + 9 }),
        sourceRanges: Object.freeze([Object.freeze({ start: paragraph.source_start, end: paragraph.source_start + 9 })]),
        blockRanges: Object.freeze([Object.freeze({
          blockKey: paragraph.id,
          range: Object.freeze({ start: 0, end: 9 }),
        })]),
      })]),
    });

    render(
      <RuntimeHarness
        source={source}
        revision="annotation-r1"
        loader={snapshotLoader()}
        annotationRenderState={renderState}
        bindAnnotation={bind}
        onAnnotationActivate={activate}
      />,
    );
    await readyRuntimeCanvas();
    await waitFor(() => expect(document.querySelector("[data-markdown-annotation-overlay-marker='true']")).not.toBeNull());
    expect(bind).toHaveBeenCalledTimes(1);
    const marker = document.querySelector<HTMLElement>("[data-markdown-annotation-overlay-marker='true']")!;
    expect(marker.dataset.annotationId).toBe("annotation-1");
    fireEvent.click(marker);
    expect(activate).toHaveBeenCalledWith("annotation-1");
  });

  it("animates annotation navigation across a long virtualized document without losing the target", async () => {
    const source = Array.from({ length: 500 }, (_, index) => `Paragraph ${index}`).join("\n\n");
    let annotationBinding: MarkdownAnnotationBinding | null = null;
    const bind = vi.fn((binding: MarkdownAnnotationBinding | null) => {
      if (binding) {
        annotationBinding = binding;
      }
      return vi.fn();
    });
    render(
      <RuntimeHarness
        source={source}
        revision="annotation-long-r1"
        loader={snapshotLoader()}
        bindAnnotation={bind}
      />,
    );
    await readyRuntimeCanvas();
    await waitFor(() => expect(annotationBinding).not.toBeNull());
    const tail = parse(source, "annotation-long-r1").blocks.at(-1)!;
    const scroll = screen.getByTestId("runtime-scroll") as HTMLElement;
    const scrollTo = vi.mocked(scroll.scrollTo);
    const callsBeforeReveal = scrollTo.mock.calls.length;

    await annotationBinding!.revealBlock(tail.id, new AbortController().signal);

    expect(scroll.scrollTop).toBeGreaterThan(0);
    const revealCalls = scrollTo.mock.calls.slice(callsBeforeReveal);
    const revealTops = revealCalls.map(([value]) => {
      const options = value as unknown as ScrollToOptions | number;
      return typeof options === "number" ? options : options.top ?? 0;
    });
    expect(revealTops.length).toBeGreaterThan(2);
    expect(new Set(revealTops).size).toBeGreaterThan(2);
    expect(revealTops.at(-1)).toBeGreaterThan(revealTops[0] ?? 0);
  });

  it("ignores a late snapshot after a rapid document revision switch", async () => {
    const pending = new Map<string, (snapshot: MarkdownSnapshot) => void>();
    const loader = vi.fn(({ source, revision }: Parameters<FileMarkdownRuntimeSnapshotLoader>[0]) =>
      new Promise<MarkdownSnapshot>((resolve) => pending.set(revision, () => resolve(parse(source, revision)))),
    );
    const rendered = render(<RuntimeHarness source="# A" revision="a" loader={loader} />);
    rendered.rerender(<RuntimeHarness source="# B" revision="b" loader={loader} />);

    await act(async () => pending.get("b")?.(parse("# B", "b")));
    expect(await screen.findByRole("heading", { name: "B" })).not.toBeNull();
    await act(async () => pending.get("a")?.(parse("# A", "a")));
    expect(screen.queryByRole("heading", { name: "A" })).toBeNull();
    expect(screen.getByRole("heading", { name: "B" })).not.toBeNull();
  });

  it("surfaces Runtime failures without mounting legacy Markdown", async () => {
    const loader = vi.fn().mockRejectedValue(new Error("worker exploded"));
    render(<RuntimeHarness source="# Broken" revision="bad" loader={loader} />);

    expect((await screen.findByRole("alert")).textContent).toContain("worker exploded");
    expect(document.querySelector("[data-markdown-runtime-error='true']")).not.toBeNull();
    expect(document.querySelector("[data-virtuoso-scroller='true']")).toBeNull();
  });

  it("publishes edited revisions without reconstructing the document runtime", async () => {
    let resolveEdited: ((snapshot: MarkdownSnapshot) => void) | null = null;
    const loader = vi.fn(({ source, revision }: Parameters<FileMarkdownRuntimeSnapshotLoader>[0]) => {
      if (revision === "r2") {
        return new Promise<MarkdownSnapshot>((resolve) => {
          resolveEdited = resolve;
        });
      }
      return Promise.resolve(parse(source, revision));
    });
    const rendered = render(
      <RuntimeHarness source={"# Stable\n\nParagraph"} revision="r1" loader={loader} />,
    );
    expect(await screen.findByRole("heading", { name: "Stable" })).not.toBeNull();
    const runtimeCanvas = document.querySelector<HTMLElement>("[data-file-markdown-runtime-canvas='true']")!;
    const documentCanvas = runtimeCanvas.querySelector<HTMLElement>("[data-markdown-document-canvas='true']")!;

    rendered.rerender(
      <RuntimeHarness source={"# Updated\n\nParagraph"} revision="r2" loader={loader} />,
    );
    await waitFor(() => expect(loader).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("heading", { name: "Stable" })).not.toBeNull();
    expect(document.querySelector("[data-file-markdown-runtime-canvas='true']")).toBe(runtimeCanvas);
    expect(runtimeCanvas.querySelector("[data-markdown-document-canvas='true']")).toBe(documentCanvas);

    await act(async () => {
      resolveEdited?.(parse("# Updated\n\nParagraph", "r2"));
      await Promise.resolve();
    });

    expect(await screen.findByRole("heading", { name: "Updated" })).not.toBeNull();
    expect(document.querySelector("[data-file-markdown-runtime-canvas='true']")).toBe(runtimeCanvas);
    expect(runtimeCanvas.querySelector("[data-markdown-document-canvas='true']")).toBe(documentCanvas);
  });

  it("keeps the last good Snapshot visible and recovers explicitly after a failed revision", async () => {
    markdownRuntimeDiagnostics.clear();
    let nextAttempts = 0;
    const loader = vi.fn(async ({ source, revision }: Parameters<FileMarkdownRuntimeSnapshotLoader>[0]) => {
      if (revision === "r2" && nextAttempts++ === 0) throw new Error("synthetic worker crash");
      return parse(source, revision);
    });
    const rendered = render(<RuntimeHarness source="# Stable" revision="r1" loader={loader} />);
    expect(await screen.findByRole("heading", { name: "Stable" })).not.toBeNull();

    rendered.rerender(<RuntimeHarness source="# Recovered" revision="r2" loader={loader} />);
    expect(await screen.findByRole("alert")).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Stable" })).not.toBeNull();
    expect(screen.queryByRole("heading", { name: "Recovered" })).toBeNull();
    expect(document.querySelector("[data-markdown-runtime-status='stale-error']")).not.toBeNull();
    expect(document.querySelector("[data-markdown-runtime-stale='true']")).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retry Runtime" }));
    expect(await screen.findByRole("heading", { name: "Recovered" })).not.toBeNull();
    await waitFor(() => expect(document.querySelector("[data-markdown-runtime-status='ready']")).not.toBeNull());
    expect(screen.queryByRole("heading", { name: "Stable" })).toBeNull();
    expect(document.querySelector("[data-markdown-runtime-stale='true']")).toBeNull();
    expect(markdownRuntimeDiagnostics.snapshot().events).toContainEqual(expect.objectContaining({
      stage: "host",
      code: "load-failed-retained",
      recovery: "retain-snapshot",
    }));
  });
});

describe("FilePreview Markdown Runtime boundary", () => {
  it("uses only the new host with no legacy mode selector", async () => {
    const loader = snapshotLoader();
    render(<FilePreview request={contentRequest("# Runtime only")} markdownRuntimeSnapshotLoader={loader} />);

    expect(await screen.findByRole("heading", { name: "Runtime only" })).not.toBeNull();
    expect(document.querySelector("[data-file-markdown-engine='runtime']")).not.toBeNull();
    expect(document.querySelector("[data-file-markdown-runtime-host='true']")).not.toBeNull();
    expect(document.querySelector("[data-file-markdown-engine='legacy']")).toBeNull();
    expect(document.querySelector("[data-file-markdown-engine='shadow']")).toBeNull();
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("uses only the new host in runtime mode and preserves preview/source mode switching", async () => {
    const loader = snapshotLoader();
    render(
      <FilePreview
        request={contentRequest("# Runtime\n\nBody")}
        markdownRuntimeSnapshotLoader={loader}
      />,
    );

    expect(await screen.findByRole("heading", { name: "Runtime" })).not.toBeNull();
    expect(document.querySelector("[data-file-markdown-engine='runtime']")).not.toBeNull();
    expect(document.querySelector("[data-file-markdown-runtime-host='true']")).not.toBeNull();
    expect(document.querySelector("[data-file-markdown-engine='legacy']")).toBeNull();

    const modeGroup = document.querySelector<HTMLElement>("[aria-label][class*='segmented']");
    const modeButtons = modeGroup?.querySelectorAll("button") ?? [];
    expect(modeButtons).toHaveLength(3);
    fireEvent.click(modeButtons[1]!);
    expect(document.querySelector("[data-file-markdown-runtime-host='true']")).toBeNull();
    fireEvent.click(modeButtons[0]!);
    expect(await screen.findByRole("heading", { name: "Runtime" })).not.toBeNull();
  });

  it("keeps runtime Find functional through the FilePreview toolbar and reveal path", async () => {
    const source = Array.from({ length: 300 }, (_, index) => `Paragraph ${index} product-find-target`).join("\n\n");
    render(
      <FilePreview
        request={contentRequest(source)}
        markdownRuntimeSnapshotLoader={snapshotLoader()}
      />,
    );
    const canvas = await readyRuntimeCanvas();
    act(() => {
      document.dispatchEvent(new CustomEvent(APP_FIND_SHORTCUT_EVENT, {
        detail: { sourceTarget: canvas },
      }));
    });
    const search = await waitFor(() => {
      const element = document.querySelector<HTMLElement>("[data-file-preview-search='true']");
      expect(element).not.toBeNull();
      return element!;
    });
    const input = search.querySelector<HTMLInputElement>("input")!;
    fireEvent.change(input, { target: { value: "product-find-target" } });

    await waitFor(() => expect(search.textContent).toContain("1/300"));
    await waitFor(() => expect(document.querySelectorAll("[data-markdown-find-match='true']").length).toBeGreaterThan(0));
    const firstActive = document.querySelector<HTMLElement>("[data-markdown-find-match='true'][data-active='true']")
      ?.dataset.markdownFindMatchId;
    const buttons = search.querySelectorAll("button");
    fireEvent.click(buttons[1]!);
    await waitFor(() => {
      const nextActive = document.querySelector<HTMLElement>("[data-markdown-find-match='true'][data-active='true']")
        ?.dataset.markdownFindMatchId;
      expect(nextActive).toBeTruthy();
      expect(nextActive).not.toBe(firstActive);
    });
  });

  it("does not route non-Markdown previews through the Markdown Runtime", async () => {
    const loader = snapshotLoader();
    render(
      <FilePreview
        request={{ type: "content", title: "plain.txt", content: "plain text", contentType: "text" }}
        markdownRuntimeSnapshotLoader={loader}
      />,
    );

    expect(await screen.findByText("plain text")).not.toBeNull();
    expect(loader).not.toHaveBeenCalled();
    expect(document.querySelector("[data-file-markdown-runtime-host='true']")).toBeNull();
  });
});

function RuntimeHarness({
  source,
  revision,
  loader,
  runtimeRef,
  renderCount,
  findIndex,
  activeFindMatchId,
  annotationRenderState,
  bindAnnotation,
  onAnnotationActivate,
  viewDescriptor,
}: {
  source: string;
  revision: string;
  loader: FileMarkdownRuntimeSnapshotLoader;
  runtimeRef?: MutableRefObject<FileMarkdownRuntimeHostHandle | null>;
  renderCount?: { current: number };
  findIndex?: MarkdownFindIndex | null;
  activeFindMatchId?: string | null;
  annotationRenderState?: AnnotationRenderState | null;
  bindAnnotation?: ComponentProps<typeof FileMarkdownRuntimeHost>["bindAnnotation"];
  onAnnotationActivate?: (annotationId: string) => void;
  viewDescriptor?: MarkdownViewDescriptor;
}) {
  renderCount && (renderCount.current += 1);
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);
  const localRef = useRef<FileMarkdownRuntimeHostHandle | null>(null);
  return (
    <div ref={setScrollElement} data-testid="runtime-scroll" style={{ height: 400, overflowY: "auto" }}>
      {scrollElement ? (
        <FileMarkdownRuntimeHost
          activeFindMatchId={activeFindMatchId}
          annotationRenderState={annotationRenderState}
          bindAnnotation={bindAnnotation}
          findIndex={findIndex}
          ref={runtimeRef ?? localRef}
          workspaceId="workspace-1"
          path="README.md"
          source={source}
          revision={revision}
          scrollElement={scrollElement}
          snapshotLoader={loader}
          viewDescriptor={viewDescriptor}
          onAnnotationActivate={onAnnotationActivate}
        />
      ) : null}
    </div>
  );
}

function snapshotLoader(): ReturnType<typeof vi.fn<FileMarkdownRuntimeSnapshotLoader>> {
  return vi.fn(async ({ source, revision, signal }) => {
    if (signal.aborted) throw signal.reason;
    return parse(source, revision);
  });
}

function parse(source: string, revision: string): MarkdownSnapshot {
  return parseCanonicalMarkdownSnapshot({
    surface: "file",
    documentId: "file:workspace-1:README.md",
    revision,
    source,
    rendererProfile: "file-preview",
  });
}

function contentRequest(content: string) {
  return {
    type: "content" as const,
    title: "README.md",
    content,
    contentType: "markdown" as const,
    sourcePath: "README.md",
  };
}

function readyRuntimeCanvas(): Promise<HTMLElement> {
  return waitFor(() => {
    const canvas = document.querySelector<HTMLElement>("[data-file-markdown-runtime-canvas='true']");
    expect(canvas?.dataset.markdownRuntimeStatus).toBe("ready");
    return canvas!;
  });
}

function mockElementMetrics(metrics: { clientHeight: number; clientWidth: number }): () => void {
  const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
  const width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => metrics.clientHeight });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => metrics.clientWidth });
  return () => {
    if (height) Object.defineProperty(HTMLElement.prototype, "clientHeight", height);
    else delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight;
    if (width) Object.defineProperty(HTMLElement.prototype, "clientWidth", width);
    else delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
  };
}
