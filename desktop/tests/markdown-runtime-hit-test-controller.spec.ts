import { describe, expect, it, vi } from "vitest";

import { MarkdownHitTestController } from "@/renderer/markdownRuntime/interaction";
import { MarkdownPositionMapper } from "@/renderer/markdownRuntime/mapping";
import { FILE_MARKDOWN_RENDERER_PROFILE } from "@/renderer/markdownRuntime/renderers";
import { DocumentViewRuntime } from "@/renderer/markdownRuntime/view/DocumentViewRuntime";
import { parseCanonicalMarkdownSnapshot } from "@/renderer/markdownRuntime/worker/parser";

const SOURCE = [
  "Plain [nested link](https://example.test) text.",
  "",
  "```ts",
  "const value = 1;",
  "```",
  "",
  "| Head A | Head B |",
  "| --- | --- |",
  "| Cell A | Cell B |",
  "",
  "![Alt](image.png)",
].join("\n");

function harness() {
  const snapshot = parseCanonicalMarkdownSnapshot({
    surface: "file",
    documentId: "file:hit-test.md",
    revision: "r1",
    source: SOURCE,
    rendererProfile: "file-preview",
  });
  const host = document.createElement("div");
  document.body.append(host);
  const runtime = new DocumentViewRuntime(host, {
    profile: FILE_MARKDOWN_RENDERER_PROFILE,
    interactions: { onCodeCopy: vi.fn() },
    viewport: { defaultOverscanPx: 0 },
  });
  runtime.publish(snapshot, snapshot.blocks.map(() => 100), { scrollTop: 0, viewportHeight: 1_000 });
  const mapper = new MarkdownPositionMapper(SOURCE, snapshot, {
    heightIndex: runtime.getHeightIndex(),
    mounted: runtime,
  });
  const controller = new MarkdownHitTestController({ root: runtime.canvas, mapper, mounted: runtime });
  return {
    snapshot,
    host,
    runtime,
    mapper,
    controller,
    destroy() { controller.destroy(); runtime.destroy(); host.remove(); },
  };
}

describe("visible Markdown block-local hit testing", () => {
  it("resolves nested link content and exact source/local position", () => {
    const run = harness();
    const link = run.host.querySelector<HTMLAnchorElement>("a")!;
    const text = link.firstChild as Text;
    const result = run.controller.hitTestNode(text, 3);

    expect(result).toMatchObject({
      status: "hit",
      blockIndex: 0,
      region: { kind: "link", href: "https://example.test" },
      position: { status: "exact", blockIndex: 0 },
    });
    expect(SOURCE[result.position!.sourceOffset!]).toBe("t");
    run.destroy();
  });

  it("classifies code text and code actions independently", () => {
    const run = harness();
    const code = run.host.querySelector("code")!.firstChild as Text;
    const button = run.host.querySelector<HTMLElement>("[data-markdown-code-copy]")!;

    expect(run.controller.hitTestNode(code, 6)).toMatchObject({ region: { kind: "code" }, position: { status: "exact" } });
    expect(run.controller.hitTestNode(button)).toMatchObject({ region: { kind: "code-action" } });
    run.destroy();
  });

  it("returns table row/column from only the local table", () => {
    const run = harness();
    const cells = run.host.querySelectorAll<HTMLTableCellElement>("th,td");
    const result = run.controller.hitTestNode(cells[3]!.firstChild, 2);

    expect(result).toMatchObject({ region: { kind: "table-cell", tableRow: 1, tableColumn: 1 } });
    expect(result.position).toMatchObject({ status: "exact" });
    run.destroy();
  });

  it("resolves images and their resource identity", () => {
    const run = harness();
    const image = run.host.querySelector<HTMLImageElement>("img[data-markdown-resource-id]")!;
    const result = run.controller.hitTestNode(image);

    expect(result).toMatchObject({
      status: "hit",
      region: { kind: "image", resourceId: image.dataset.markdownResourceId },
    });
    run.destroy();
  });

  it("gives annotation regions precedence over nested text and links", () => {
    const run = harness();
    const paragraph = run.runtime.getBlockElement(run.snapshot.blocks[0].id)!;
    const original = paragraph.firstChild as Text;
    const marker = document.createElement("span");
    marker.dataset.annotationId = "ann-1";
    marker.textContent = original.data.slice(0, 5);
    original.replaceWith(marker, document.createTextNode(original.data.slice(5)));
    const result = run.controller.hitTestNode(marker.firstChild, 2);

    expect(result).toMatchObject({ region: { kind: "annotation", annotationId: "ann-1" } });
    expect(result.position).toMatchObject({ status: "exact", sourceOffset: 2 });
    run.destroy();
  });

  it("does not scan the document or sibling blocks for a local text hit", () => {
    const run = harness();
    const documentScan = vi.spyOn(document, "querySelectorAll");
    const rootScan = vi.spyOn(run.runtime.canvas, "querySelectorAll");
    const text = run.runtime.getBlockElement(run.snapshot.blocks[0].id)!.firstChild as Text;
    expect(run.controller.hitTestNode(text, 1).status).toBe("hit");
    expect(documentScan).not.toHaveBeenCalled();
    expect(rootScan).not.toHaveBeenCalled();
    documentScan.mockRestore();
    rootScan.mockRestore();
    run.destroy();
  });

  it("invalidates recycled nodes and accepts current nodes after revision update", () => {
    const run = harness();
    const old = run.runtime.getBlockElement(run.snapshot.blocks[0].id)!;
    run.runtime.updateViewport({ scrollTop: 300, viewportHeight: 100 });
    run.runtime.canvas.append(old);
    expect(run.controller.hitTestNode(old)).toMatchObject({ status: "stale", reason: "recycled-node" });
    old.remove();

    const next = parseCanonicalMarkdownSnapshot({
      surface: "file",
      documentId: "file:hit-test.md",
      revision: "r2",
      source: SOURCE,
      rendererProfile: "file-preview",
    }, { previousSnapshot: run.snapshot });
    run.runtime.publish(next, next.blocks.map(() => 100), { scrollTop: 0, viewportHeight: 1_000 });
    const mapper = new MarkdownPositionMapper(SOURCE, next, {
      heightIndex: run.runtime.getHeightIndex(),
      mounted: run.runtime,
    });
    run.controller.setMapper(mapper);
    const current = run.runtime.getBlockElement(next.blocks[0].id)!;
    expect(run.controller.hitTestNode(current.firstChild, 1)).toMatchObject({ status: "hit", revision: "r2" });
    run.destroy();
  });

  it("returns explicit none results for canvas and outside targets", () => {
    const run = harness();
    const outside = document.createElement("div");
    document.body.append(outside);
    expect(run.controller.hitTestNode(run.runtime.canvas)).toMatchObject({ status: "none", reason: "no-block" });
    expect(run.controller.hitTestNode(outside)).toMatchObject({ status: "none", reason: "outside-root" });
    outside.remove();
    run.destroy();
  });

  it("delegates pointer/click events without cancelling browser defaults", () => {
    const run = harness();
    const onHit = vi.fn();
    const delegated = new MarkdownHitTestController({
      root: run.runtime.canvas,
      mapper: run.mapper,
      mounted: run.runtime,
      onHit,
    });
    delegated.attach();
    const link = run.host.querySelector<HTMLAnchorElement>("a")!;
    link.href = "#local-hit-test";
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(event);

    expect(onHit).toHaveBeenCalledWith(expect.objectContaining({ region: expect.objectContaining({ kind: "link" }) }), event);
    expect(event.defaultPrevented).toBe(false);
    expect(delegated.diagnostics()).toMatchObject({ hits: 1, misses: 0, stale: 0, attached: true });
    delegated.destroy();
    run.destroy();
  });
});
