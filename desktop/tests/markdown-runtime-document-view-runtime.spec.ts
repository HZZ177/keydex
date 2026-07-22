import { describe, expect, it, vi } from "vitest";

import { parseCanonicalMarkdownSnapshot } from "@/renderer/markdownRuntime/worker/parser";
import {
  DocumentViewRuntime,
} from "@/renderer/markdownRuntime/view/DocumentViewRuntime";
import { FILE_MARKDOWN_RENDERER_PROFILE } from "@/renderer/markdownRuntime/renderers";
import type { MarkdownSnapshot } from "@/renderer/markdownRuntime/document/MarkdownSnapshot";

function parse(source: string, revision = "r1", previousSnapshot?: MarkdownSnapshot) {
  return parseCanonicalMarkdownSnapshot({
    surface: "file",
    documentId: "file:view-runtime.md",
    revision,
    source,
    rendererProfile: "file-preview",
  }, { previousSnapshot });
}

function host(): HTMLDivElement {
  const element = document.createElement("div");
  document.body.append(element);
  return element;
}

describe("DocumentViewRuntime keyed DOM patch", () => {
  it("mounts, reuses, reorders, updates, and unmounts only viewport blocks", () => {
    const snapshot = parse(Array.from({ length: 100 }, (_, index) => `Paragraph ${index}`).join("\n\n"));
    const element = host();
    const runtime = new DocumentViewRuntime(element, {
      profile: FILE_MARKDOWN_RENDERER_PROFILE,
      viewport: { defaultOverscanPx: 0 },
    });
    const first = runtime.publish(snapshot, new Array(100).fill(20), { scrollTop: 0, viewportHeight: 100 });
    const retained = runtime.canvas.querySelector<HTMLElement>(`[data-markdown-block-id='${snapshot.blocks[4].id}']`);
    const second = runtime.updateViewport({ scrollTop: 20, viewportHeight: 100 });

    expect(first).toMatchObject({ mountedBlockRoots: 5, render: { created: 5 } });
    expect(second.viewport).toMatchObject({ mount: [5], unmount: [0], retained: [1, 2, 3, 4] });
    expect(second.render).toMatchObject({ created: 1, reused: 4, destroyed: 1 });
    expect(runtime.canvas.querySelector(`[data-markdown-block-id='${snapshot.blocks[4].id}']`)).toBe(retained);
    expect(runtime.canvas.children).toHaveLength(5);
    expect(runtime.canvas.style.height).toBe("2000px");
    expect(retained?.style.minHeight).toBe("");
    expect(runtime.topSpacer.dataset.markdownSpacerHeight).toBe("20");
    expect(runtime.bottomSpacer.dataset.markdownSpacerHeight).toBe("1880");
    runtime.destroy();
    element.remove();
  });

  it("preserves stable nodes across revision insertion and updates absolute offsets", () => {
    const firstSnapshot = parse("Alpha\n\nBeta\n\nGamma", "r1");
    const secondSnapshot = parse("Inserted\n\nAlpha\n\nBeta\n\nGamma", "r2", firstSnapshot);
    const element = host();
    const runtime = new DocumentViewRuntime(element, {
      profile: FILE_MARKDOWN_RENDERER_PROFILE,
      viewport: { defaultOverscanPx: 0 },
    });
    runtime.publish(firstSnapshot, [30, 30, 30], { scrollTop: 0, viewportHeight: 200 });
    const previous = new Map(firstSnapshot.blocks.map((block) => [
      block.id,
      runtime.canvas.querySelector(`[data-markdown-block-id='${block.id}']`),
    ]));
    const result = runtime.publish(secondSnapshot, [30, 30, 30, 30], { scrollTop: 0, viewportHeight: 200 });

    expect(result.render).toMatchObject({ created: 1, reused: 3, destroyed: 0 });
    for (const block of secondSnapshot.blocks.slice(1)) {
      expect(runtime.canvas.querySelector(`[data-markdown-block-id='${block.id}']`)).toBe(previous.get(block.id));
    }
    expect(runtime.canvas.querySelector<HTMLElement>(`[data-markdown-block-id='${secondSnapshot.blocks[1].id}']`)?.style.top)
      .toBe("30px");
    runtime.destroy();
    element.remove();
  });

  it("keeps measured block geometry stable while publishing an edited revision", () => {
    const firstSnapshot = parse("Alpha\n\nBeta\n\nGamma", "r1");
    const secondSnapshot = parse("Alpha\n\nBeta edited\n\nGamma", "r2", firstSnapshot);
    const element = host();
    const runtime = new DocumentViewRuntime(element, {
      profile: FILE_MARKDOWN_RENDERER_PROFILE,
      viewport: { defaultOverscanPx: 0 },
    });
    runtime.publish(firstSnapshot, [30, 80, 40], { scrollTop: 0, viewportHeight: 200 });
    const alpha = runtime.getBlockElement(firstSnapshot.blocks[0]!.id);
    const oldBeta = runtime.getBlockElement(firstSnapshot.blocks[1]!.id);
    const gamma = runtime.getBlockElement(firstSnapshot.blocks[2]!.id);

    const result = runtime.publish(
      secondSnapshot,
      [12, 12, 12],
      { scrollTop: 0, viewportHeight: 200 },
      { preserveRevisionGeometry: true },
    );

    expect(result.render).toMatchObject({ created: 1, reused: 2, destroyed: 1 });
    expect(runtime.getBlockElement(secondSnapshot.blocks[0]!.id)).toBe(alpha);
    expect(runtime.getBlockElement(secondSnapshot.blocks[1]!.id)).not.toBe(oldBeta);
    expect(runtime.getBlockElement(secondSnapshot.blocks[2]!.id)).toBe(gamma);
    expect(runtime.getBlockElement(secondSnapshot.blocks[1]!.id)?.style.top).toBe("30px");
    expect(runtime.getBlockElement(secondSnapshot.blocks[2]!.id)?.style.top).toBe("110px");
    expect(runtime.canvas.style.height).toBe("150px");
    runtime.destroy();
    element.remove();
  });

  it("pins the focused block outside overscan and releases it after focus moves", () => {
    const snapshot = parse([
      "```ts",
      "const x = 1",
      "```",
      "",
      ...Array.from({ length: 100 }, (_, index) => `Paragraph ${index}\n`),
    ].join("\n"));
    const element = host();
    const runtime = new DocumentViewRuntime(element, {
      profile: FILE_MARKDOWN_RENDERER_PROFILE,
      interactions: { onCodeCopy: vi.fn() },
      viewport: { defaultOverscanPx: 0 },
    });
    runtime.publish(snapshot, new Array(snapshot.blocks.length).fill(30), { scrollTop: 0, viewportHeight: 120 });
    const codeId = snapshot.blocks[0].id;
    const codeElement = runtime.canvas.querySelector<HTMLElement>(`[data-markdown-block-id='${codeId}']`)!;
    codeElement.querySelector<HTMLButtonElement>("button")!.focus();
    const scrolled = runtime.updateViewport({ scrollTop: 2000, viewportHeight: 120 });

    expect(scrolled.protectedIndices).toContain(0);
    expect(scrolled.viewport.items.find((item) => item.index === 0)).toMatchObject({ pinned: true, visible: false });
    expect(runtime.canvas.querySelector(`[data-markdown-block-id='${codeId}']`)).toBe(codeElement);
    (document.activeElement as HTMLElement).blur();
    runtime.updateViewport({ scrollTop: 2000, viewportHeight: 120 });
    expect(runtime.canvas.querySelector(`[data-markdown-block-id='${codeId}']`)).toBeNull();
    runtime.destroy();
    element.remove();
  });

  it("pins every currently selected block while scrolling away", () => {
    const snapshot = parse(Array.from({ length: 50 }, (_, index) => `Paragraph ${index}`).join("\n\n"));
    const element = host();
    const runtime = new DocumentViewRuntime(element, {
      profile: FILE_MARKDOWN_RENDERER_PROFILE,
      viewport: { defaultOverscanPx: 0 },
    });
    runtime.publish(snapshot, new Array(50).fill(30), { scrollTop: 0, viewportHeight: 150 });
    const first = runtime.canvas.children[0] as HTMLElement;
    const third = runtime.canvas.children[2] as HTMLElement;
    const range = document.createRange();
    range.setStart(first.firstChild!, 0);
    range.setEnd(third.firstChild!, third.firstChild!.textContent!.length);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const scrolled = runtime.updateViewport({ scrollTop: 900, viewportHeight: 150 });

    expect(scrolled.protectedIndices).toEqual([0, 1, 2]);
    expect(scrolled.viewport.items.filter((item) => item.pinned).map((item) => item.index))
      .toEqual([0, 1, 2]);
    selection.removeAllRanges();
    runtime.updateViewport({ scrollTop: 900, viewportHeight: 150 });
    expect(runtime.canvas.querySelector(`[data-markdown-block-id='${snapshot.blocks[0].id}']`)).toBeNull();
    runtime.destroy();
    element.remove();
  });

  it("repositions mounted blocks after measured height updates", () => {
    const snapshot = parse("Alpha\n\nBeta\n\nGamma");
    const element = host();
    const runtime = new DocumentViewRuntime(element, {
      profile: FILE_MARKDOWN_RENDERER_PROFILE,
      viewport: { defaultOverscanPx: 0 },
    });
    runtime.publish(snapshot, [20, 20, 20], { scrollTop: 0, viewportHeight: 100 });
    const result = runtime.updateMeasuredHeights([{ index: 0, height: 50, kind: "measured" }], "r1");

    expect(result).not.toBeNull();
    expect(runtime.canvas.style.height).toBe("90px");
    expect(runtime.canvas.querySelector<HTMLElement>(`[data-markdown-block-id='${snapshot.blocks[1].id}']`)?.style.top)
      .toBe("50px");
    expect(runtime.updateMeasuredHeights([{ index: 0, height: 50 }], "r1")).toBeNull();
    runtime.destroy();
    element.remove();
  });

  it("keeps a virtualized source-line gutter aligned with mounted file blocks", () => {
    const source = ["# Title", "", "first line", "second line", "", "tail"].join("\n");
    const snapshot = parse(source);
    const element = host();
    const runtime = new DocumentViewRuntime(element, {
      profile: FILE_MARKDOWN_RENDERER_PROFILE,
      viewport: { defaultOverscanPx: 0 },
    });
    runtime.publish(snapshot, [30, 42, 30], { scrollTop: 0, viewportHeight: 72 });

    const gutter = element.querySelector<HTMLElement>("[data-markdown-preview-source-gutter='true']");
    expect(gutter).not.toBeNull();
    expect(gutter?.getAttribute("aria-hidden")).toBeNull();
    expect(gutter?.dataset.markdownPreviewLineCount).toBe("6");
    expect(gutter?.querySelectorAll("[data-markdown-preview-line-number='true']")).toHaveLength(2);
    expect(gutter?.querySelector("pre")).toBeNull();
    expect(gutter?.querySelectorAll("[data-markdown-preview-fold-button='true']").length).toBeGreaterThan(0);
    expect(gutter?.textContent).toContain("1");
    expect(gutter?.textContent).toContain("3\n4");
    expect(runtime.getBlockElement(snapshot.blocks[0].id)?.style.insetInlineStart).toBe("74px");

    runtime.updateViewport({ scrollTop: 72, viewportHeight: 30 });
    expect(gutter?.querySelectorAll("[data-markdown-preview-line-number='true']")).toHaveLength(1);
    expect(gutter?.textContent).toBe("6");
    runtime.destroy();
    element.remove();
  });

  it("folds and restores a multiline block without retaining its semantic DOM", () => {
    vi.useFakeTimers();
    const snapshot = parse(["Intro", "", "line one", "line two", "", "Tail"].join("\n"));
    const element = host();
    const runtime = new DocumentViewRuntime(element, {
      profile: FILE_MARKDOWN_RENDERER_PROFILE,
      viewport: { defaultOverscanPx: 0 },
    });
    runtime.publish(snapshot, [30, 60, 30], { scrollTop: 0, viewportHeight: 200 });
    const block = snapshot.blocks[1]!;
    const button = element.querySelector<HTMLButtonElement>(
      `[data-markdown-preview-fold-block-id='${block.id}']`,
    )!;

    expect(button.getAttribute("aria-expanded")).toBe("true");
    button.click();

    expect(runtime.getBlockElement(block.id)?.dataset.markdownPreviewFoldMotion).toBe("collapse");
    expect(button.dataset.markdownPreviewFoldPending).toBe("true");
    vi.advanceTimersByTime(180);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(runtime.getBlockElement(block.id)).toBeNull();
    const collapsedSummary = element.querySelector<HTMLElement>("[data-markdown-preview-collapsed-block='true']");
    expect(collapsedSummary?.textContent).toBe("已折叠 2 行");
    expect(collapsedSummary?.style.insetInlineStart).toBe("74px");
    expect(runtime.canvas.style.height).toBe("98px");

    button.click();
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(runtime.getBlockElement(block.id)).not.toBeNull();
    expect(element.querySelector("[data-markdown-preview-collapsed-summary='true']")).toBeNull();
    expect(runtime.canvas.style.height).toBe("120px");
    runtime.destroy();
    element.remove();
    vi.useRealTimers();
  });

  it("folds a heading section, skips all hidden children, and expands it for reveal", () => {
    vi.useFakeTimers();
    const snapshot = parse(["# Title", "", "Intro", "", "## Child", "", "Body", "", "# Next", "", "Tail"].join("\n"));
    const element = host();
    const runtime = new DocumentViewRuntime(element, {
      profile: FILE_MARKDOWN_RENDERER_PROFILE,
      viewport: { defaultOverscanPx: 0 },
    });
    runtime.publish(snapshot, new Array(snapshot.blocks.length).fill(30), { scrollTop: 0, viewportHeight: 500 });
    const title = snapshot.blocks[0]!;
    const hiddenChild = snapshot.blocks[2]!;
    const next = snapshot.blocks[4]!;
    const button = element.querySelector<HTMLButtonElement>(
      `[data-markdown-preview-fold-block-id='${title.id}']`,
    )!;

    button.click();
    expect(runtime.getBlockElement(hiddenChild.id)?.dataset.markdownPreviewFoldMotion).toBe("collapse");
    vi.advanceTimersByTime(180);

    expect(runtime.mountedBlockIds()).toEqual([title.id, next.id, snapshot.blocks[5]!.id]);
    expect(runtime.getBlockElement(hiddenChild.id)).toBeNull();
    expect(runtime.getBlockElement(next.id)?.style.top).toBe("72px");
    expect(element.querySelector("[data-markdown-preview-collapsed-section='true']")?.textContent)
      .toBe("已折叠 6 行");

    runtime.expandForBlock(hiddenChild.id);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(runtime.getBlockElement(hiddenChild.id)).not.toBeNull();
    expect(runtime.getBlockElement(hiddenChild.id)?.dataset.markdownPreviewFoldMotion).toBe("expand");
    expect(runtime.getBlockElement(next.id)?.style.top).toBe("120px");
    vi.advanceTimersByTime(160);
    expect(runtime.getBlockElement(hiddenChild.id)?.dataset.markdownPreviewFoldMotion).toBeUndefined();
    runtime.destroy();
    element.remove();
    vi.useRealTimers();
  });

  it("bounds gutter text for a giant mounted source block", () => {
    const snapshot = parse(`\`\`\`text\n${"line\n".repeat(20_000)}\`\`\``);
    const element = host();
    const runtime = new DocumentViewRuntime(element, {
      profile: FILE_MARKDOWN_RENDERER_PROFILE,
      viewport: { defaultOverscanPx: 0 },
    });
    runtime.publish(snapshot, [360_000], { scrollTop: 180_000, viewportHeight: 600 });

    const numbers = element.querySelector<HTMLElement>("[data-markdown-preview-line-number='true']");
    expect(numbers).not.toBeNull();
    expect(numbers?.textContent?.split("\n").length).toBeLessThan(100);
    expect(element.querySelectorAll("[data-markdown-preview-gutter-block-id]")).toHaveLength(1);
    runtime.destroy();
    element.remove();
  });

  it("positions adjacent measured blocks with explicit owned spacing and no trailing minimum", () => {
    const snapshot = parse("Alpha\n\nBeta");
    const element = host();
    const runtime = new DocumentViewRuntime(element, {
      profile: FILE_MARKDOWN_RENDERER_PROFILE,
      viewport: { defaultOverscanPx: 0 },
    });
    runtime.publish(snapshot, [34, 22], { scrollTop: 0, viewportHeight: 100 });

    const first = runtime.getBlockElement(snapshot.blocks[0].id)!;
    const second = runtime.getBlockElement(snapshot.blocks[1].id)!;
    expect(first.style.minHeight).toBe("");
    expect(first.style.marginBlockStart).toBe("0");
    expect(first.style.marginBlockEnd).toBe("0");
    expect(second.style.top).toBe("34px");
    expect(second.style.transform).toBe("");
    expect(runtime.canvas.style.height).toBe("56px");
    runtime.destroy();
    element.remove();
  });

  it("cleans block resources when scrolling unmounts them", () => {
    const snapshot = parse("![logo](logo.png)\n\n" + Array.from({ length: 20 }, (_, index) => `P ${index}`).join("\n\n"));
    const cleanup = vi.fn();
    const mount = vi.fn(() => cleanup);
    const element = host();
    const runtime = new DocumentViewRuntime(element, {
      profile: FILE_MARKDOWN_RENDERER_PROFILE,
      resourceLifecycle: { mount },
      viewport: { defaultOverscanPx: 0 },
    });
    runtime.publish(snapshot, new Array(snapshot.blocks.length).fill(50), { scrollTop: 0, viewportHeight: 100 });
    expect(mount).toHaveBeenCalled();
    runtime.updateViewport({ scrollTop: 500, viewportHeight: 100 });
    expect(cleanup).toHaveBeenCalledTimes(1);
    runtime.destroy();
    element.remove();
  });

  it("keeps rapid-scroll DOM work bounded and never mounts intermediate blocks", () => {
    const snapshot = parse(Array.from({ length: 5000 }, (_, index) => `P ${index}`).join("\n\n"));
    const element = host();
    const runtime = new DocumentViewRuntime(element, {
      profile: FILE_MARKDOWN_RENDERER_PROFILE,
      viewport: { defaultOverscanPx: 100 },
    });
    const heights = new Array(snapshot.blocks.length).fill(20);
    runtime.publish(snapshot, heights, { scrollTop: 0, viewportHeight: 400 });
    let maxRoots = 0;
    for (const scrollTop of [50_000, 10_000, 90_000, 20_000, 70_000]) {
      const patch = runtime.updateViewport({ scrollTop, viewportHeight: 400 });
      maxRoots = Math.max(maxRoots, patch.mountedBlockRoots);
      expect(patch.render.created).toBeLessThanOrEqual(30);
    }
    expect(maxRoots).toBeLessThanOrEqual(30);
    expect(runtime.canvas.children.length).toBeLessThanOrEqual(30);
    runtime.destroy();
    element.remove();
  });

  it("validates publication and releases every node on destroy", () => {
    const snapshot = parse("Alpha");
    const element = host();
    const runtime = new DocumentViewRuntime(element, { profile: FILE_MARKDOWN_RENDERER_PROFILE });
    expect(() => runtime.updateViewport({ scrollTop: 0, viewportHeight: 10 })).toThrow(/no published/u);
    expect(() => runtime.publish(snapshot, [], { scrollTop: 0, viewportHeight: 10 })).toThrow(/Height count/u);
    runtime.publish(snapshot, [20], { scrollTop: 0, viewportHeight: 10 });
    expect(() => runtime.updateMeasuredHeights([{ index: 0, height: 30 }], "stale")).toThrow(/Stale/u);
    runtime.destroy();
    expect(element.children).toHaveLength(0);
    expect(() => runtime.updateViewport({ scrollTop: 0, viewportHeight: 10 })).toThrow(/destroyed/u);
    element.remove();
  });
});
