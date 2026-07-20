import { afterEach, describe, expect, it, vi } from "vitest";

import { MarkdownAnnotationOverlayController } from "@/renderer/markdownRuntime/annotations";
import { createMarkdownSnapshot, type MarkdownSnapshot } from "@/renderer/markdownRuntime/document/MarkdownSnapshot";
import { MarkdownPositionMapper } from "@/renderer/markdownRuntime/mapping/MarkdownPositionMapper";
import {
  CONVERSATION_MARKDOWN_RENDERER_PROFILE,
  createTableBlockRenderer,
  defaultSemanticMarkdownRenderers,
  FILE_MARKDOWN_RENDERER_PROFILE,
  RetainedMarkdownDocumentRenderer,
  SemanticMarkdownRendererRegistry,
} from "@/renderer/markdownRuntime/renderers";
import { parseCanonicalMarkdownSnapshot } from "@/renderer/markdownRuntime/worker/parser";

const roots: HTMLElement[] = [];

afterEach(() => {
  document.getSelection()?.removeAllRanges();
  roots.splice(0).forEach((root) => root.remove());
  vi.restoreAllMocks();
});

describe("retained semantic Markdown table runtime", () => {
  it("keeps table semantics and lets ordinary tables wrap within the container", () => {
    const harness = renderTable([
      "| Left | Center | Right | Empty |",
      "| :--- | :---: | ---: | --- |",
      "| a | b | c | |",
    ].join("\n"));

    expect(harness.wrapper.dataset.scrollAxis).toBe("x");
    expect(harness.wrapper.style.overflowX).toBe("auto");
    expect(harness.wrapper.dataset.markdownTableColumns).toBe("4");
    expect(harness.wrapper.dataset.markdownTableLayout).toBe("wrap");
    expect(harness.wrapper.querySelectorAll("thead th")).toHaveLength(4);
    expect(harness.wrapper.querySelectorAll("tbody td")).toHaveLength(4);
    expect(harness.wrapper.querySelectorAll("tbody td")[3]?.textContent).toBe("");
    expect(harness.wrapper.querySelectorAll<HTMLElement>("thead th")[0]?.style.textAlign).toBe("left");
    expect(harness.wrapper.querySelectorAll<HTMLElement>("thead th")[1]?.style.textAlign).toBe("center");
    expect(harness.wrapper.querySelectorAll<HTMLElement>("thead th")[2]?.style.textAlign).toBe("right");
    expect(harness.wrapper.querySelector("canvas")).toBeNull();
    harness.destroy();
  });

  it("renders inline Markdown and delegates links without losing exact source spans", () => {
    const onLinkActivate = vi.fn();
    const harness = renderTable([
      "| Name | Docs |",
      "| --- | --- |",
      "| **Bold** and `code` | [guide](guide.md) |",
    ].join("\n"), { onLinkActivate });
    const link = harness.wrapper.querySelector<HTMLAnchorElement>("a")!;

    expect(harness.wrapper.querySelector("strong")?.textContent).toBe("Bold");
    expect(harness.wrapper.querySelector("code")?.textContent).toBe("code");
    expect(link.textContent).toBe("guide");
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(onLinkActivate).toHaveBeenCalledWith(expect.any(MouseEvent), expect.objectContaining({ href: "guide.md" }));

    const sourceMap = harness.renderer.sourceMap(harness.block.id)!;
    expect(sourceMap.inline.some((entry) => entry.span.kind === "strong" && entry.element?.tagName === "STRONG")).toBe(true);
    expect(sourceMap.inline.some((entry) => entry.span.kind === "link" && entry.element === link)).toBe(true);
    const cell = link.closest("td")!;
    expect(Number(cell.dataset.markdownSourceStart)).toBeLessThan(Number(cell.dataset.markdownSourceEnd));
    harness.destroy();
  });

  it("switches to scrolling only after the wrapped-column threshold", () => {
    const wrapped = renderSnapshot(syntheticTable(1, 6));
    const wide = renderSnapshot(syntheticTable(1, 7));

    expect(wrapped.wrapper.dataset.markdownTableLayout).toBe("wrap");
    expect(wide.wrapper.dataset.markdownTableLayout).toBe("scroll");

    wrapped.destroy();
    wide.destroy();
  });

  it("preserves native selection and annotation overlays inside cells", () => {
    const harness = renderTable("| Key | Value |\n| --- | --- |\n| target | selectable |", { source: true });
    const mapper = new MarkdownPositionMapper(harness.source, harness.snapshot, { mounted: harness.renderer });
    const localStart = harness.snapshot.logical_text.indexOf("target") - harness.block.logical_start;
    const start = mapper.blockLocal(harness.block.id, localStart);
    const end = mapper.blockLocal(harness.block.id, localStart + 6);
    expect(start.status).toBe("exact");
    expect(end.status).toBe("exact");

    const range = document.createRange();
    range.setStart(start.dom!.node, start.dom!.offset);
    range.setEnd(end.dom!.node, end.dom!.offset);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    expect(selection.toString()).toBe("target");

    const overlay = new MarkdownAnnotationOverlayController({
      snapshot: harness.snapshot,
      mapper,
      mounted: harness.renderer,
      rectProvider: () => [{ left: 0, top: 0, right: 42, bottom: 16, width: 42, height: 16 } as DOMRect],
    });
    overlay.publish({
      revision: harness.snapshot.revision,
      annotationSetRevision: "table-a1",
      activeAnnotationId: null,
      hoveredAnnotationId: null,
      flashAnnotationId: null,
      markers: [{
        annotationId: "table-ann",
        blockId: harness.block.id,
        blockIndex: harness.block.index,
        blockLocalStart: localStart,
        blockLocalEnd: localStart + 6,
        logicalStart: harness.block.logical_start + localStart,
        logicalEnd: harness.block.logical_start + localStart + 6,
      }],
    });
    overlay.syncMountedBlocks([harness.block.id]);
    expect(harness.wrapper.querySelector("[data-annotation-id='table-ann']")).not.toBeNull();
    overlay.destroy();
    harness.destroy();
  });

  it("bounds a 100,000-row table independently of the document viewport", () => {
    const snapshot = syntheticTable(100_000, 3);
    const harness = renderSnapshot(snapshot, { maxVisibleRows: 48, overscanRows: 4, maxViewportHeight: 280 });

    expect(harness.wrapper.dataset.markdownTableVirtual).toBe("true");
    expect(harness.wrapper.dataset.markdownTableLayout).toBe("scroll");
    expect(Number(harness.wrapper.dataset.markdownTableMountedRows)).toBeLessThanOrEqual(48);
    expect(harness.wrapper.querySelectorAll("tbody tr").length).toBeLessThanOrEqual(50);
    expect(harness.wrapper.querySelector("[data-markdown-table-spacer='bottom']")).not.toBeNull();
    expect(harness.wrapper.querySelectorAll("td").length).toBeLessThan(160);
    expect(harness.wrapper.querySelector("canvas")).toBeNull();
    harness.destroy();
  }, 20_000);

  it("moves the internal row window, reports stable row indices, and reuses overlapping rows", async () => {
    const harness = renderSnapshot(syntheticTable(1_000, 2), {
      maxVisibleRows: 30,
      overscanRows: 1,
      maxViewportHeight: 84,
    });
    Object.defineProperty(harness.wrapper, "clientHeight", { configurable: true, value: 84 });
    const retained = harness.wrapper.querySelector<HTMLTableRowElement>("tr[data-markdown-table-row-index='2']")!;
    harness.wrapper.scrollTop = 56;
    harness.wrapper.dispatchEvent(new Event("scroll"));
    await nextFrame();

    expect(Number(harness.wrapper.dataset.markdownTableFirstRow)).toBe(1);
    expect(harness.wrapper.querySelector("tr[data-markdown-table-row-index='2']")).toBe(retained);
    expect(harness.wrapper.querySelector("tr[data-markdown-table-row-index='1']")).toBeNull();
    const visibleCell = harness.wrapper.querySelector<HTMLTableCellElement>("tbody tr[data-markdown-table-row-index='4'] td")!;
    expect(visibleCell.closest("tr")?.dataset.markdownTableRowIndex).toBe("4");

    harness.wrapper.scrollTop = 28 * 999;
    harness.wrapper.dispatchEvent(new Event("scroll"));
    await nextFrame();
    expect(Number(harness.wrapper.dataset.markdownTableLastRow)).toBe(999);
    expect(harness.wrapper.querySelectorAll("tbody tr").length).toBeLessThanOrEqual(7);
    harness.destroy();
  });

  it("recomputes the bounded window after resize", async () => {
    const callbacks: ResizeObserverCallback[] = [];
    const Original = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) { callbacks.push(callback); }
      observe() { /* test observer */ }
      unobserve() { /* test observer */ }
      disconnect() { /* test observer */ }
    } as typeof ResizeObserver;
    try {
      const harness = renderSnapshot(syntheticTable(1_000, 2), {
        maxVisibleRows: 50,
        overscanRows: 1,
        maxViewportHeight: 84,
      });
      const before = Number(harness.wrapper.dataset.markdownTableMountedRows);
      Object.defineProperty(harness.wrapper, "clientHeight", { configurable: true, value: 280 });
      callbacks[0]!([], {} as ResizeObserver);
      await nextFrame();
      expect(Number(harness.wrapper.dataset.markdownTableMountedRows)).toBeGreaterThan(before);
      harness.destroy();
    } finally {
      globalThis.ResizeObserver = Original;
    }
  });

  it("reuses unchanged table roots and replaces only changed table content", () => {
    const first = parse("| A | B |\n| --- | --- |\n| 1 | 2 |", "r1");
    const second = parse("Intro\n\n| A | B |\n| --- | --- |\n| 1 | 2 |", "r2", first);
    const third = parse("Intro\n\n| A | B |\n| --- | --- |\n| 1 | changed |", "r3", second);
    const harness = renderSnapshot(first);
    const tableId = first.blocks.find((block) => block.kind === "table")!.id;
    const original = harness.renderer.getBlockElement(tableId);
    expect(harness.renderer.render(second)).toMatchObject({ reused: 1 });
    expect(harness.renderer.getBlockElement(tableId)).toBe(original);
    const changedId = third.blocks.find((block) => block.kind === "table")!.id;
    harness.renderer.render(third);
    expect(harness.renderer.getBlockElement(changedId)?.textContent).toContain("changed");
    expect(harness.renderer.getBlockElement(changedId)).not.toBe(original);
    harness.destroy();
  });

  it("uses the same table kernel for file preview and conversation profiles", () => {
    const source = "| Surface | Value |\n| --- | --- |\n| shared | runtime |";
    const file = renderSnapshot(parse(source, "file", undefined, "file"));
    const message = renderSnapshot(parse(source, "message", undefined, "message"), {}, "conversation");
    expect(file.wrapper.querySelector("table")?.textContent).toBe(message.wrapper.querySelector("table")?.textContent);
    expect(file.wrapper.querySelectorAll("th,td").length).toBe(message.wrapper.querySelectorAll("th,td").length);
    expect(file.wrapper.dataset.markdownRendererProfile).toBe("file-preview");
    expect(message.wrapper.dataset.markdownRendererProfile).toBe("conversation");
    file.destroy();
    message.destroy();
  });

  it("keeps wide tables semantic and bounded without truncating columns", () => {
    const columns = 64;
    const header = `| ${Array.from({ length: columns }, (_, index) => `H${index}`).join(" | ")} |`;
    const divider = `| ${Array.from({ length: columns }, () => "---").join(" | ")} |`;
    const row = `| ${Array.from({ length: columns }, (_, index) => `V${index}`).join(" | ")} |`;
    const harness = renderTable([header, divider, row].join("\n"));
    expect(harness.wrapper.querySelectorAll("thead th")).toHaveLength(columns);
    expect(harness.wrapper.querySelectorAll("tbody td")).toHaveLength(columns);
    expect(harness.wrapper.querySelector("tbody td:last-child")?.textContent).toBe("V63");
    expect(harness.wrapper.style.overflowX).toBe("auto");
    expect(harness.wrapper.dataset.markdownTableColumns).toBe(String(columns));
    expect(harness.wrapper.dataset.markdownTableLayout).toBe("scroll");
    harness.destroy();
  });
});

function renderTable(
  source: string,
  options: { onLinkActivate?: ReturnType<typeof vi.fn>; source?: boolean } = {},
) {
  return renderSnapshot(parse(source), {}, "file-preview", options.onLinkActivate, source);
}

function renderSnapshot(
  snapshot: MarkdownSnapshot,
  tableOptions: Parameters<typeof createTableBlockRenderer>[0] = {},
  profile: "file-preview" | "conversation" = "file-preview",
  onLinkActivate?: ReturnType<typeof vi.fn>,
  source = snapshot.logical_text,
) {
  const root = document.createElement("div");
  document.body.append(root);
  roots.push(root);
  const registry = new SemanticMarkdownRendererRegistry(defaultSemanticMarkdownRenderers, {
    table: createTableBlockRenderer(tableOptions),
  });
  const renderer = new RetainedMarkdownDocumentRenderer(root, {
    profile: profile === "file-preview" ? FILE_MARKDOWN_RENDERER_PROFILE : CONVERSATION_MARKDOWN_RENDERER_PROFILE,
    registry,
    interactions: { onLinkActivate },
  });
  renderer.render(snapshot);
  const block = snapshot.blocks.find((entry) => entry.kind === "table")!;
  const wrapper = renderer.getBlockElement(block.id)!;
  return {
    source: typeof source === "string" ? source : snapshot.logical_text,
    snapshot,
    block,
    root,
    renderer,
    wrapper,
    destroy() {
      renderer.destroy();
      root.remove();
      const index = roots.indexOf(root);
      if (index >= 0) roots.splice(index, 1);
    },
  };
}

function parse(
  source: string,
  revision = "table-r1",
  previousSnapshot?: MarkdownSnapshot,
  surface: "file" | "message" = "file",
) {
  return parseCanonicalMarkdownSnapshot({
    surface,
    documentId: `${surface}:table-runtime.md`,
    revision,
    source,
    rendererProfile: surface === "file" ? "file-preview" : "conversation",
  }, { previousSnapshot });
}

function syntheticTable(bodyRows: number, columns: number): MarkdownSnapshot {
  const values = [
    ...Array.from({ length: columns }, (_, index) => `H${index}`),
    ...Array.from({ length: bodyRows }, (_, row) => (
      Array.from({ length: columns }, (_, column) => `R${row}C${column}`)
    )).flat(),
  ];
  const logical = values.join("\n");
  return createMarkdownSnapshot({
    surface: "file",
    document_id: "file:synthetic-large-table.md",
    revision: `table:${bodyRows}:${columns}`,
    renderer_profile: "file-preview",
    mode: "canonical",
    source_bytes: logical.length,
    source_characters: logical.length,
    logical_text: logical,
    line_count: bodyRows + 2,
    blocks: [{
      id: "large-table",
      identity_key: "large-table",
      content_hash: `large-table:${bodyRows}:${columns}`,
      index: 0,
      kind: "table",
      parent_id: null,
      depth: 0,
      source_start: 0,
      source_end: logical.length,
      logical_start: 0,
      logical_end: logical.length,
      line_start: 0,
      line_end: bodyRows + 2,
      inline_spans: [],
      metadata: { table: { columns, alignments: Array.from({ length: columns }, () => null) } },
    }],
    outline: [],
    resources: [],
    stream: { kind: "canonical", finalized: true },
    indexes: {
      line_map_revision: "line",
      logical_projection_revision: "logical",
      source_index_revision: "source",
      find_index_revision: null,
      annotation_index_revision: null,
    },
  });
}

async function nextFrame(): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await Promise.resolve();
}
