import { describe, expect, it, vi } from "vitest";

import { parseCanonicalMarkdownSnapshot } from "@/renderer/markdownRuntime/worker/parser";
import type {
  MarkdownSnapshot,
  MarkdownSnapshotBlock,
} from "@/renderer/markdownRuntime/document/MarkdownSnapshot";
import {
  CONVERSATION_MARKDOWN_RENDERER_PROFILE,
  FILE_MARKDOWN_RENDERER_PROFILE,
  RetainedMarkdownDocumentRenderer,
  SemanticMarkdownRendererRegistry,
  defaultSemanticMarkdownRenderers,
  type MarkdownBlockDomInstance,
  type MarkdownBlockRendererContext,
  type MarkdownBlockRendererDefinition,
} from "@/renderer/markdownRuntime/renderers";

function parse(
  source: string,
  revision = "r1",
  previousSnapshot?: MarkdownSnapshot,
  surface: "file" | "message" = "file",
) {
  return parseCanonicalMarkdownSnapshot({
    surface,
    documentId: `${surface}:semantic.md`,
    revision,
    source,
    rendererProfile: surface === "file" ? "file-preview" : "conversation",
  }, { previousSnapshot });
}

function root(): HTMLDivElement {
  const element = document.createElement("div");
  document.body.append(element);
  return element;
}

describe("surface-neutral semantic Markdown DOM registry", () => {
  it("creates real semantic DOM for all ordinary block families and native inline content", () => {
    const snapshot = parse([
      "# Heading",
      "",
      "Paragraph with **bold**, *emphasis*, `code`, [link](https://example.com), and ![logo](logo.png).",
      "",
      "> Quote",
      "",
      "- one",
      "- two",
      "",
      "| A | B |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "```ts",
      "const value = 1;",
      "```",
      "",
      "---",
    ].join("\n"));
    const container = root();
    const onLinkActivate = vi.fn();
    const renderer = new RetainedMarkdownDocumentRenderer(container, {
      profile: FILE_MARKDOWN_RENDERER_PROFILE,
      interactions: { onLinkActivate },
    });
    const stats = renderer.render(snapshot);

    expect(stats).toMatchObject({ created: snapshot.blocks.length, reused: 0, failed: 0 });
    expect(container.querySelector("h1")?.textContent).toBe("Heading");
    expect(container.querySelector("p strong")?.textContent).toBe("bold");
    expect(container.querySelector("p em")?.textContent).toBe("emphasis");
    expect(container.querySelector("p code")?.textContent).toBe("code");
    expect(container.querySelector("a")?.getAttribute("href")).toBe("https://example.com");
    expect(container.querySelector("img")?.getAttribute("src")).toBe("logo.png");
    expect(container.querySelector("blockquote p")?.textContent).toContain("Quote");
    expect(container.querySelectorAll("ul > li")).toHaveLength(2);
    expect(container.querySelectorAll("table thead th")).toHaveLength(2);
    expect(container.querySelectorAll("table tbody td")).toHaveLength(2);
    expect(container.querySelector("pre code.language-ts")?.textContent).toContain("const value");
    expect(container.querySelector("hr")).not.toBeNull();
    container.querySelector("a")?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(onLinkActivate).toHaveBeenCalledWith(expect.any(MouseEvent), expect.objectContaining({
      href: "https://example.com",
    }));
    renderer.destroy();
    container.remove();
  });

  it("reuses exact HTMLElement identities and updates source attributes after insertions", () => {
    const first = parse("Alpha\n\nBeta\n\nGamma", "r1");
    const second = parse("Inserted\n\nAlpha\n\nBeta\n\nGamma", "r2", first);
    const container = root();
    const renderer = new RetainedMarkdownDocumentRenderer(container, { profile: FILE_MARKDOWN_RENDERER_PROFILE });
    renderer.render(first);
    const previousElements = new Map(first.blocks.map((block) => [block.id, renderer.getBlockElement(block.id)]));
    const stats = renderer.render(second);

    expect(stats).toMatchObject({ created: 1, reused: 3, destroyed: 0, failed: 0 });
    for (const block of second.blocks.filter((entry) => previousElements.has(entry.id))) {
      const element = renderer.getBlockElement(block.id);
      expect(element).toBe(previousElements.get(block.id));
      expect(element?.dataset.markdownSourceStart).toBe(String(block.source_start));
      expect(element?.dataset.markdownBlockIndex).toBe(String(block.index));
    }
    expect([...container.children].map((element) => element.textContent)).toEqual([
      "Inserted", "Alpha", "Beta", "Gamma",
    ]);
    renderer.destroy();
    container.remove();
  });

  it("replaces only changed blocks and destroys removed instances", () => {
    const first = parse("Alpha\n\nBeta\n\nGamma", "r1");
    const second = parse("Alpha\n\nBeta changed\n\nGamma", "r2", first);
    const container = root();
    const renderer = new RetainedMarkdownDocumentRenderer(container, { profile: FILE_MARKDOWN_RENDERER_PROFILE });
    renderer.render(first);
    const alpha = renderer.getBlockElement(first.blocks[0].id);
    const gamma = renderer.getBlockElement(first.blocks[2].id);
    const stats = renderer.render(second);

    expect(stats).toMatchObject({ created: 1, reused: 2, destroyed: 1 });
    expect(renderer.getBlockElement(second.blocks[0].id)).toBe(alpha);
    expect(renderer.getBlockElement(second.blocks[2].id)).toBe(gamma);
    expect(container.textContent).toBe("AlphaBeta changedGamma");
    renderer.destroy();
    container.remove();
  });

  it("supports renderer registration and create/update/destroy lifecycle", () => {
    const calls = { create: vi.fn(), update: vi.fn(), destroy: vi.fn() };
    const definition = lifecycleRenderer(calls);
    const registry = new SemanticMarkdownRendererRegistry(defaultSemanticMarkdownRenderers, { paragraph: definition });
    const first = parse("Custom", "r1");
    const second = parse("Inserted\n\nCustom", "r2", first);
    const container = root();
    const renderer = new RetainedMarkdownDocumentRenderer(container, {
      profile: FILE_MARKDOWN_RENDERER_PROFILE,
      registry,
    });
    renderer.render(first);
    renderer.render(second);
    renderer.destroy();

    expect(calls.create).toHaveBeenCalledTimes(2);
    expect(calls.update).toHaveBeenCalledTimes(1);
    expect(calls.destroy).toHaveBeenCalledTimes(2);
    container.remove();
  });

  it("keeps viewport-only patches proportional to mounted blocks without updating retained DOM", () => {
    const calls = { create: vi.fn(), update: vi.fn(), destroy: vi.fn() };
    const registry = new SemanticMarkdownRendererRegistry(defaultSemanticMarkdownRenderers, {
      paragraph: lifecycleRenderer(calls),
    });
    const snapshot = parse(Array.from({ length: 2_000 }, (_, index) => `Paragraph ${index}`).join("\n\n"));
    const container = root();
    const renderer = new RetainedMarkdownDocumentRenderer(container, {
      profile: FILE_MARKDOWN_RENDERER_PROFILE,
      registry,
    });

    renderer.render(snapshot, { blockIndices: Array.from({ length: 20 }, (_, index) => index) });
    calls.update.mockClear();
    const stats = renderer.render(snapshot, {
      blockIndices: Array.from({ length: 20 }, (_, index) => index + 10),
    });

    expect(stats).toMatchObject({ created: 10, reused: 10, updated: 0, destroyed: 10, failed: 0 });
    expect(calls.update).not.toHaveBeenCalled();
    expect(container.children).toHaveLength(20);
    renderer.destroy();
    container.remove();
  });

  it("isolates a renderer exception to one fallback block", () => {
    const throwing: MarkdownBlockRendererDefinition = {
      create(context) {
        if (context.logicalText.slice(context.block.logical_start, context.block.logical_end) === "Broken") {
          throw new Error("synthetic block failure");
        }
        return lifecycleRenderer({ create: vi.fn(), update: vi.fn(), destroy: vi.fn() }).create(context);
      },
    };
    const registry = new SemanticMarkdownRendererRegistry(defaultSemanticMarkdownRenderers, { paragraph: throwing });
    const snapshot = parse("# Healthy\n\nBroken\n\nAlso healthy");
    const container = root();
    const renderer = new RetainedMarkdownDocumentRenderer(container, {
      profile: FILE_MARKDOWN_RENDERER_PROFILE,
      registry,
    });
    const stats = renderer.render(snapshot);

    expect(stats.failed).toBe(1);
    expect(container.querySelector("h1")?.textContent).toBe("Healthy");
    expect(container.querySelector("[data-markdown-block-error='true']")?.textContent).toContain("Broken");
    expect(container.textContent).toContain("Also healthy");
    renderer.destroy();
    container.remove();
  });

  it("mounts and cleans resources on block replacement and document destroy", () => {
    const mount = vi.fn(() => vi.fn());
    const first = parse("![logo](a.png)\n\n[docs](https://example.com)", "r1");
    const second = parse("![logo](b.png)\n\n[docs](https://example.com)", "r2", first);
    const container = root();
    const renderer = new RetainedMarkdownDocumentRenderer(container, {
      profile: FILE_MARKDOWN_RENDERER_PROFILE,
      resourceLifecycle: { mount },
    });
    renderer.render(first);
    const firstCleanups = mount.mock.results.map((result) => result.value as ReturnType<typeof vi.fn>);
    renderer.render(second);

    expect(mount).toHaveBeenCalled();
    expect(firstCleanups.some((cleanup) => cleanup.mock.calls.length > 0)).toBe(true);
    const allCleanups = mount.mock.results.map((result) => result.value as ReturnType<typeof vi.fn>);
    renderer.destroy();
    expect(allCleanups.every((cleanup) => cleanup.mock.calls.length === 1)).toBe(true);
    expect(container.children).toHaveLength(0);
    container.remove();
  });

  it("exposes block-local source maps without an accessibility mirror", () => {
    const snapshot = parse("Text with **strong** and [link](guide.md).");
    const container = root();
    const renderer = new RetainedMarkdownDocumentRenderer(container, { profile: FILE_MARKDOWN_RENDERER_PROFILE });
    renderer.render(snapshot);
    const block = snapshot.blocks[0];
    const sourceMap = renderer.sourceMap(block.id);

    expect(sourceMap).toMatchObject({
      blockId: block.id,
      sourceStart: block.source_start,
      sourceEnd: block.source_end,
    });
    expect(sourceMap?.inline.some((entry) => entry.span.kind === "strong" && entry.element?.tagName === "STRONG"))
      .toBe(true);
    expect(sourceMap?.inline.some((entry) => entry.span.kind === "link" && entry.element?.tagName === "A"))
      .toBe(true);
    expect(container.querySelector("[aria-hidden='true'][data-markdown-accessibility-mirror]")).toBeNull();
    expect(renderer.measure(block.id)).toEqual({ width: 0, height: 0 });
    renderer.destroy();
    container.remove();
  });

  it("uses one registry contract for file and message profiles", () => {
    const source = "# Same\n\n[docs](https://example.com)";
    const fileSnapshot = parse(source, "file-r1", undefined, "file");
    const messageSnapshot = parse(source, "message-r1", undefined, "message");
    const fileRoot = root();
    const messageRoot = root();
    const registry = new SemanticMarkdownRendererRegistry(defaultSemanticMarkdownRenderers);
    const fileRenderer = new RetainedMarkdownDocumentRenderer(fileRoot, {
      registry,
      profile: FILE_MARKDOWN_RENDERER_PROFILE,
    });
    const messageRenderer = new RetainedMarkdownDocumentRenderer(messageRoot, {
      registry,
      profile: CONVERSATION_MARKDOWN_RENDERER_PROFILE,
    });
    fileRenderer.render(fileSnapshot);
    messageRenderer.render(messageSnapshot);

    expect([...fileRoot.children].map((entry) => entry.tagName)).toEqual(
      [...messageRoot.children].map((entry) => entry.tagName),
    );
    expect(fileRoot.dataset.markdownRendererProfile).toBe("file-preview");
    expect(messageRoot.dataset.markdownRendererProfile).toBe("conversation");
    fileRenderer.destroy();
    messageRenderer.destroy();
    fileRoot.remove();
    messageRoot.remove();
  });

  it("renders unknown blocks as semantic paragraphs and rejects profile mismatches", () => {
    const snapshot = structuredClone(parse("Unknown"));
    (snapshot.blocks as MarkdownSnapshotBlock[])[0] = { ...snapshot.blocks[0], kind: "unknown" };
    const container = root();
    const renderer = new RetainedMarkdownDocumentRenderer(container, { profile: FILE_MARKDOWN_RENDERER_PROFILE });
    renderer.render(snapshot);
    expect(container.querySelector("p")?.textContent).toBe("Unknown");

    const message = parse("Message", "message-r1", undefined, "message");
    expect(() => renderer.render(message)).toThrow(/does not match/u);
    renderer.destroy();
    expect(() => renderer.render(snapshot)).toThrow(/destroyed/u);
    container.remove();
  });

  it("does not assign unsafe image schemes before a Resource Runtime can validate them", () => {
    const snapshot = parse([
      "![file](file:///C:/secret.png)",
      "",
      "![ftp](ftp://example.test/image.png)",
      "",
      "![unsafe](data:text/html,bad)",
    ].join("\n"));
    const container = root();
    const renderer = new RetainedMarkdownDocumentRenderer(container, { profile: FILE_MARKDOWN_RENDERER_PROFILE });
    renderer.render(snapshot);
    expect([...container.querySelectorAll("img")].every((image) => !image.hasAttribute("src"))).toBe(true);
    renderer.destroy();
    container.remove();
  });

  it("reuses a large many-block document without replacing nodes", () => {
    const source = Array.from({ length: 500 }, (_, index) => `Paragraph ${index}`).join("\n\n");
    const snapshot = parse(source);
    const container = root();
    const renderer = new RetainedMarkdownDocumentRenderer(container, { profile: FILE_MARKDOWN_RENDERER_PROFILE });
    renderer.render(snapshot);
    const firstElement = renderer.getBlockElement(snapshot.blocks[0].id);
    const stats = renderer.render(snapshot);

    expect(stats).toMatchObject({ created: 0, reused: 500, updated: 0, destroyed: 0, failed: 0 });
    expect(renderer.getBlockElement(snapshot.blocks[0].id)).toBe(firstElement);
    expect(container.children).toHaveLength(500);
    renderer.destroy();
    container.remove();
  });
});

function lifecycleRenderer(calls: {
  create: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
}): MarkdownBlockRendererDefinition {
  return {
    create(context: MarkdownBlockRendererContext): MarkdownBlockDomInstance {
      calls.create(context.block.id);
      let current = context;
      const element = context.ownerDocument.createElement("aside");
      element.dataset.markdownBlockId = context.block.id;
      element.textContent = text(context);
      return {
        element,
        update(next) {
          calls.update(next.block.id);
          current = next;
          element.textContent = text(next);
          return "reused";
        },
        sourceMap() {
          return {
            blockId: current.block.id,
            sourceStart: current.block.source_start,
            sourceEnd: current.block.source_end,
            logicalStart: current.block.logical_start,
            logicalEnd: current.block.logical_end,
            inline: [],
          };
        },
        measure: () => ({ width: 0, height: 0 }),
        destroy() {
          calls.destroy(current.block.id);
          element.remove();
        },
      };
    },
  };
}

function text(context: MarkdownBlockRendererContext): string {
  return context.logicalText.slice(context.block.logical_start, context.block.logical_end);
}
