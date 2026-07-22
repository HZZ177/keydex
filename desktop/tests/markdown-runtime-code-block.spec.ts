import { describe, expect, it, vi } from "vitest";

import { MarkdownAnnotationOverlayController } from "@/renderer/markdownRuntime/annotations";
import { MarkdownPositionMapper } from "@/renderer/markdownRuntime/mapping/MarkdownPositionMapper";
import {
  createCodeBlockRenderer,
  FILE_MARKDOWN_RENDERER_PROFILE,
  MarkdownCodeHighlighter,
  RetainedMarkdownDocumentRenderer,
  SemanticMarkdownRendererRegistry,
  defaultSemanticMarkdownRenderers,
  type MarkdownCodeHighlightResult,
  type MarkdownCodeHighlightService,
  type MarkdownCodeHighlightTask,
} from "@/renderer/markdownRuntime/renderers";
import { MarkdownRenderCache } from "@/renderer/markdownRuntime/cache/MarkdownRenderCache";
import { parseCanonicalMarkdownSnapshot } from "@/renderer/markdownRuntime/worker/parser";

describe("retained Markdown code block runtime", () => {
  it("paints plain semantic code immediately and upgrades known languages asynchronously", async () => {
    const service = new ControlledHighlighter();
    const harness = renderCode("const value = 42;", "ts", { highlighter: service });
    const frame = harness.frame();

    expect(frame.dataset.markdownCodeHighlightState).toBe("pending");
    expect(frame.querySelector("code")?.textContent).toBe("const value = 42;");
    expect(frame.querySelector("[data-code-token-kind]")).toBeNull();
    service.resolve(0, [{ start: 0, end: 5, kind: "keyword" }, { start: 14, end: 16, kind: "number" }]);
    await flushMicrotasks();

    expect(frame.dataset.markdownCodeHighlightState).toBe("ready");
    expect(frame.querySelectorAll("[data-code-token-kind]")).toHaveLength(2);
    expect(frame.querySelector("code")?.textContent).toBe("const value = 42;");
    harness.destroy();
  });

  it.each([[null, "plain"], ["unknown-lang", "unsupported"]] as const)(
    "keeps %s language as plain code without scheduling highlighter work",
    (language, state) => {
      const service = new ControlledHighlighter();
      const harness = renderCode("plain value", language, { highlighter: service });
      expect(harness.frame().dataset.markdownCodeHighlightState).toBe(state);
      expect(service.tasks).toHaveLength(0);
      harness.destroy();
    },
  );

  it.each(["sql", "bash", "go", "rust", "java", "cpp", "csharp", "php", "kotlin", "swift"])(
    "schedules grammar highlighting for %s code fences",
    async (language) => {
      const service = new ControlledHighlighter();
      const harness = renderCode("select value from records", language, { highlighter: service });
      expect(harness.frame().dataset.markdownCodeHighlightState).toBe("pending");
      expect(service.tasks).toHaveLength(1);
      service.resolve(0, [{ start: 0, end: 6, kind: "keyword" }]);
      await flushMicrotasks();
      expect(harness.frame().dataset.markdownCodeHighlightState).toBe("ready");
      harness.destroy();
    },
  );

  it("does not let separate mounted blocks cancel one another", async () => {
    const source = "```ts\nconst a = 1\n```\n\n```js\nconst b = 2\n```";
    const service = new ControlledHighlighter();
    const harness = renderDocument(source, service);
    expect(service.tasks).toHaveLength(2);
    expect(service.tasks.every((task) => !task.controller.signal.aborted)).toBe(true);

    service.resolve(0, [{ start: 0, end: 5, kind: "keyword" }]);
    service.resolve(1, [{ start: 0, end: 5, kind: "keyword" }]);
    await flushMicrotasks();
    expect(harness.root.querySelectorAll("[data-markdown-code-highlight-state='ready']")).toHaveLength(2);
    harness.destroy();
  });

  it("cancels obsolete and destroyed block tasks while ignoring late results", async () => {
    const service = new ControlledHighlighter();
    const harness = renderCode("const oldValue = 1", "ts", { highlighter: service });
    harness.renderer.destroy();
    expect(service.tasks[0].controller.signal.aborted).toBe(true);
    service.resolve(0, [{ start: 0, end: 5, kind: "keyword" }]);
    await flushMicrotasks();
    expect(harness.root.children).toHaveLength(0);
    harness.root.remove();
  });

  it("falls back to unchanged plain code when highlighting fails", async () => {
    const service = new ControlledHighlighter();
    const harness = renderCode("const safe = true", "typescript", { highlighter: service });
    service.reject(0, new Error("highlight failed"));
    await flushMicrotasks();
    expect(harness.frame().dataset.markdownCodeHighlightState).toBe("failed");
    expect(harness.frame().querySelector("code")?.textContent).toBe("const safe = true");
    harness.destroy();
  });

  it("reuses descriptor cache without retaining DOM or scheduling a second task", async () => {
    const cache = new MarkdownRenderCache({ maxEntries: 8, maxBytes: 1024 * 1024 });
    const service = new ControlledHighlighter();
    const first = renderCode("const cached = 1", "ts", { cache, highlighter: service });
    service.resolve(0, [{ start: 0, end: 5, kind: "keyword" }]);
    await flushMicrotasks();
    first.destroy();
    const second = renderCode("const cached = 1", "ts", { cache, highlighter: service });

    expect(service.tasks).toHaveLength(1);
    expect(second.frame().dataset.markdownCodeHighlightState).toBe("ready");
    expect(cache.diagnostics().layers.descriptor.hits).toBeGreaterThan(0);
    second.destroy();
  });

  it("copies the complete original code independent of highlight truncation", async () => {
    const onCodeCopy = vi.fn();
    const value = "const x = 1;\n".repeat(20_000).trimEnd();
    const harness = renderCode(value, "ts", {
      highlighter: new MarkdownCodeHighlighter({ maxHighlightCharacters: 32, yieldToMain: async () => undefined }),
      onCodeCopy,
    });
    const copyButton = harness.frame().querySelector<HTMLButtonElement>("[data-markdown-code-copy]")!;
    expect(copyButton.querySelector("svg[data-markdown-action-icon='copy']")).not.toBeNull();
    copyButton.click();
    await flushMicrotasks();
    expect(onCodeCopy).toHaveBeenCalledWith(expect.objectContaining({ code: value, language: "ts" }));
    expect(copyButton.querySelector("svg[data-markdown-action-icon='check']")).not.toBeNull();
    expect(harness.frame().dataset.markdownCodeHighlightTruncated).toBe("true");
    harness.destroy();
  });

  it("segments a 100k-line block and an ultra-long line with bounded DOM nodes", () => {
    const lines = Array.from({ length: 100_000 }, (_, index) => `line ${index}`).join("\n");
    const service = new ControlledHighlighter();
    const many = renderCode(lines, "ts", { highlighter: service, plainTextChunkCharacters: 65_536 });
    const long = renderCode("x".repeat(2_000_000), null, { highlighter: service, plainTextChunkCharacters: 65_536 });

    expect(many.frame().querySelector("code")?.childNodes.length).toBeLessThan(32);
    expect(long.frame().querySelector("code")?.childNodes.length).toBeLessThan(32);
    expect(many.frame().querySelector("code")?.textContent?.length).toBe(lines.length);
    expect(long.frame().querySelector("code")?.textContent?.length).toBe(2_000_000);
    many.destroy();
    long.destroy();
  });

  it("preserves native selection, block-local source mapping, and annotation overlay", () => {
    const harness = renderCode("const target = true", "unknown-lang");
    const block = harness.snapshot.blocks.find((item) => item.kind === "code")!;
    const mapper = new MarkdownPositionMapper(harness.source, harness.snapshot, { mounted: harness.renderer });
    const start = harness.snapshot.logical_text.indexOf("target") - block.logical_start;
    const mapped = mapper.blockLocal(block.id, start);
    expect(mapped.status).toBe("exact");
    const selection = document.getSelection()!;
    const range = document.createRange();
    range.setStart(mapped.dom!.node, mapped.dom!.offset);
    const end = mapper.blockLocal(block.id, start + 6);
    range.setEnd(end.dom!.node, end.dom!.offset);
    selection.removeAllRanges();
    selection.addRange(range);
    const overlay = new MarkdownAnnotationOverlayController({
      snapshot: harness.snapshot,
      mapper,
      mounted: harness.renderer,
      rectProvider: () => [{ left: 0, top: 0, right: 40, bottom: 16, width: 40, height: 16 } as DOMRect],
    });
    overlay.publish({
      revision: harness.snapshot.revision,
      annotationSetRevision: "a1",
      activeAnnotationId: null,
      hoveredAnnotationId: null,
      flashAnnotationId: null,
      markers: [{
        annotationId: "ann",
        blockId: block.id,
        blockIndex: block.index,
        blockLocalStart: start,
        blockLocalEnd: start + 6,
        logicalStart: block.logical_start + start,
        logicalEnd: block.logical_start + start + 6,
      }],
    });
    overlay.syncMountedBlocks([block.id]);

    expect(selection.toString()).toBe("target");
    expect(harness.frame().querySelector("[data-annotation-id='ann']")).not.toBeNull();
    overlay.destroy();
    selection.removeAllRanges();
    harness.destroy();
  });
});

class ControlledHighlighter implements MarkdownCodeHighlightService {
  readonly tasks: Array<{
    block: ReturnType<typeof parse>["blocks"][number];
    controller: AbortController;
    resolve(value: MarkdownCodeHighlightResult): void;
    reject(error: unknown): void;
  }> = [];

  highlight(block: ReturnType<typeof parse>["blocks"][number], _code: string): MarkdownCodeHighlightTask {
    const controller = new AbortController();
    let resolve!: (value: MarkdownCodeHighlightResult) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<MarkdownCodeHighlightResult>((yes, no) => { resolve = yes; reject = no; });
    this.tasks.push({ block, controller, resolve, reject });
    return {
      signal: controller.signal,
      promise,
      cancel: (reason?: string) => controller.abort(new DOMException(reason ?? "cancelled", "AbortError")),
    };
  }

  resolve(index: number, tokens: MarkdownCodeHighlightResult["tokens"]): void {
    const task = this.tasks[index];
    task.resolve({
      blockId: task.block.id,
      contentHash: task.block.content_hash,
      language: task.block.metadata.language ?? null,
      tokens,
      truncated: false,
    });
  }

  reject(index: number, error: unknown): void { this.tasks[index].reject(error); }
}

function renderCode(
  value: string,
  language: string | null,
  options: Parameters<typeof createCodeBlockRenderer>[0] & { onCodeCopy?: ReturnType<typeof vi.fn> } = {},
) {
  const fence = language ? `\`\`\`${language}` : "```";
  return renderDocument(`${fence}\n${value}\n\`\`\``, options.highlighter, options);
}

function renderDocument(
  source: string,
  highlighter?: MarkdownCodeHighlightService,
  options: Parameters<typeof createCodeBlockRenderer>[0] & { onCodeCopy?: ReturnType<typeof vi.fn> } = {},
) {
  const snapshot = parse(source);
  const root = document.createElement("div");
  document.body.append(root);
  const registry = new SemanticMarkdownRendererRegistry(defaultSemanticMarkdownRenderers, {
    code: createCodeBlockRenderer({ ...options, highlighter }),
  });
  const renderer = new RetainedMarkdownDocumentRenderer(root, {
    profile: FILE_MARKDOWN_RENDERER_PROFILE,
    registry,
    interactions: { onCodeCopy: options.onCodeCopy },
  });
  renderer.render(snapshot);
  return {
    source,
    snapshot,
    root,
    renderer,
    frame: () => root.querySelector<HTMLElement>("[data-markdown-code-frame]")!,
    destroy() { renderer.destroy(); root.remove(); },
  };
}

function parse(source: string) {
  return parseCanonicalMarkdownSnapshot({
    surface: "file",
    documentId: "file:code-runtime.md",
    revision: "code-r1",
    source,
    rendererProfile: "file-preview",
  });
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
