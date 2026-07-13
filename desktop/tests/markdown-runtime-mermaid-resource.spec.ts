import { afterEach, describe, expect, it, vi } from "vitest";

import type { MarkdownSnapshot } from "@/renderer/markdownRuntime/document/MarkdownSnapshot";
import {
  MermaidResourceRuntime,
  sanitizeMermaidSvg,
  type MarkdownMermaidRenderInput,
  type MarkdownMermaidRenderService,
} from "@/renderer/markdownRuntime/resources";
import {
  CONVERSATION_MARKDOWN_RENDERER_PROFILE,
  FILE_MARKDOWN_RENDERER_PROFILE,
  RetainedMarkdownDocumentRenderer,
} from "@/renderer/markdownRuntime/renderers";
import { DocumentViewRuntime, type DocumentViewPatchResult } from "@/renderer/markdownRuntime/view/DocumentViewRuntime";
import { parseCanonicalMarkdownSnapshot } from "@/renderer/markdownRuntime/worker/parser";

const roots: HTMLElement[] = [];

afterEach(() => {
  roots.splice(0).forEach((root) => root.remove());
  vi.restoreAllMocks();
});

describe("shared Markdown Mermaid Resource Runtime", () => {
  it("keeps source visible while pending, then publishes normalized safe SVG and dimensions", async () => {
    const service = new ControlledMermaidService();
    const dimensions = vi.fn();
    const runtime = new MermaidResourceRuntime({ renderService: service, onDimensions: dimensions });
    const harness = render(parse(mermaid("flowchart TD\nA-->B")), runtime);
    const block = harness.root.querySelector<HTMLElement>("[data-markdown-mermaid-block]")!;
    expect(block.dataset.markdownMermaidState).toBe("rendering");
    expect(block.querySelector("pre")?.hidden).toBe(false);
    expect(block.textContent).toContain("flowchart TD");

    service.resolve(0, [
      '<svg viewBox="0 0 100 50" style="max-width:100%;color:red">',
      '<script>alert(1)</script>',
      '<g onclick="alert(1)"><a href="javascript:bad"><text>A</text></a></g>',
      "</svg>",
    ].join(""));
    await settled();
    const output = block.querySelector<HTMLElement>("[data-markdown-mermaid-output]")!;
    expect(block.dataset.markdownMermaidState).toBe("ready");
    expect(block.querySelector("pre")?.hidden).toBe(true);
    expect(output.dataset.markdownMermaidWidth).toBe("100");
    expect(output.dataset.markdownMermaidHeight).toBe("50");
    expect(output.innerHTML).not.toContain("script");
    expect(output.innerHTML).not.toContain("onclick");
    expect(output.innerHTML).not.toContain("javascript:");
    expect(output.querySelector("svg")?.getAttribute("width")).toBe("100");
    expect(dimensions).toHaveBeenCalledWith(expect.objectContaining({ width: 100, height: 50 }));
    harness.destroy();
    runtime.destroy();
  });

  it("deduplicates the same content/theme/config across file and conversation surfaces", async () => {
    const service = new ControlledMermaidService();
    const runtime = new MermaidResourceRuntime({ renderService: service, themeFor: () => "light" });
    const source = mermaid("flowchart LR\nA-->B");
    const file = render(parse(source, "file-r1", "file"), runtime, "file-preview");
    const message = render(parse(source, "message-r1", "message"), runtime, "conversation");
    expect(service.tasks).toHaveLength(1);
    expect(runtime.diagnostics()).toMatchObject({ hits: 1, misses: 1, referenced: 1 });
    service.resolve(0, svg("shared"));
    await settled();
    expect(file.root.querySelector("[data-markdown-mermaid-output]")?.textContent).toContain("shared");
    expect(message.root.querySelector("[data-markdown-mermaid-output]")?.textContent).toContain("shared");
    file.destroy();
    message.destroy();
    runtime.destroy();
  });

  it("keeps the old success atomically while theme and config variants render", async () => {
    const service = new ControlledMermaidService();
    let theme: "light" | "dark" = "light";
    let configVersion = "one";
    const runtime = new MermaidResourceRuntime({
      renderService: service,
      themeFor: () => theme,
      configFor: () => ({ securityLevel: "strict", theme: "neutral", deterministicIDSeed: configVersion }),
    });
    const harness = render(parse(mermaid("flowchart TD\nA-->B")), runtime);
    service.resolve(0, svg("light-v1"));
    await settled();
    const output = harness.root.querySelector<HTMLElement>("[data-markdown-mermaid-output]")!;

    theme = "dark";
    runtime.refresh();
    expect(service.tasks).toHaveLength(2);
    expect(output.dataset.markdownMermaidStale).toBe("true");
    expect(output.textContent).toContain("light-v1");
    expect(harness.root.querySelector("pre")?.hidden).toBe(true);
    service.resolve(1, svg("dark-v1"));
    await settled();
    expect(output.dataset.markdownMermaidStale).toBe("false");
    expect(output.dataset.markdownMermaidTheme).toBe("dark");
    expect(output.textContent).toContain("dark-v1");

    configVersion = "two";
    runtime.refresh();
    expect(service.tasks).toHaveLength(3);
    expect(output.textContent).toContain("dark-v1");
    service.resolve(2, svg("dark-v2"));
    await settled();
    expect(output.textContent).toContain("dark-v2");
    harness.destroy();
    runtime.destroy();
  });

  it("carries the old diagram across a changed block identity until the new content succeeds", async () => {
    const service = new ControlledMermaidService();
    const runtime = new MermaidResourceRuntime({ renderService: service });
    const first = parse(mermaid("flowchart TD\nA-->B"), "r1");
    const second = parse(mermaid("flowchart TD\nA-->C"), "r2", "file", first);
    const harness = render(first, runtime);
    service.resolve(0, svg("old-result"));
    await settled();
    const originalRoot = harness.root.firstElementChild;
    harness.renderer.render(second);
    const replacement = harness.root.firstElementChild;
    const output = replacement?.querySelector<HTMLElement>("[data-markdown-mermaid-output]")!;
    expect(replacement).not.toBe(originalRoot);
    expect(output.dataset.markdownMermaidStale).toBe("true");
    expect(output.textContent).toContain("old-result");
    expect(service.tasks).toHaveLength(2);
    service.resolve(1, svg("new-result"));
    await settled();
    expect(output.dataset.markdownMermaidStale).toBe("false");
    expect(output.textContent).toContain("new-result");
    harness.destroy();
    runtime.destroy();
  });

  it("keeps invalid diagrams local, leaves source readable, and retries failures", async () => {
    const service = new ControlledMermaidService();
    const runtime = new MermaidResourceRuntime({ renderService: service });
    const harness = render(parse(mermaid("broken -->")), runtime);
    service.reject(0, new Error("parse failed"));
    await settled();
    const block = harness.root.querySelector<HTMLElement>("[data-markdown-mermaid-block]")!;
    expect(block.dataset.markdownMermaidState).toBe("failed");
    expect(block.querySelector("pre")?.hidden).toBe(false);
    expect(block.querySelector("[role='alert']")?.textContent).toContain("Mermaid render failed");
    expect(harness.root.querySelector("[data-markdown-block-error]")).toBeNull();
    block.querySelector<HTMLButtonElement>("[data-markdown-mermaid-retry]")!.click();
    expect(service.tasks).toHaveLength(2);
    service.resolve(1, svg("recovered"));
    await settled();
    expect(block.dataset.markdownMermaidState).toBe("ready");
    expect(block.textContent).toContain("recovered");
    expect(runtime.diagnostics()).toMatchObject({ failures: 1, ready: 1 });
    harness.destroy();
    runtime.destroy();
  });

  it("bounds concurrency, drains queued diagrams, and reports peak work", async () => {
    const service = new ControlledMermaidService();
    const runtime = new MermaidResourceRuntime({ renderService: service, maxConcurrent: 2, maxQueue: 8 });
    const source = Array.from({ length: 5 }, (_, index) => mermaid(`flowchart TD\nA${index}-->B${index}`)).join("\n\n");
    const harness = render(parse(source), runtime);
    expect(service.tasks).toHaveLength(2);
    expect(runtime.diagnostics()).toMatchObject({ active: 2, queued: 3, peakActive: 2 });
    service.resolve(0, svg("zero"));
    await settled();
    expect(service.tasks).toHaveLength(3);
    service.resolve(1, svg("one"));
    service.resolve(2, svg("two"));
    await settled();
    expect(service.tasks).toHaveLength(5);
    service.resolve(3, svg("three"));
    service.resolve(4, svg("four"));
    await settled();
    expect(harness.root.querySelectorAll("[data-markdown-mermaid-state='ready']")).toHaveLength(5);
    expect(runtime.diagnostics()).toMatchObject({ active: 0, queued: 0, peakActive: 2, ready: 5 });
    harness.destroy();
    runtime.destroy();
  });

  it("cancels unmounted queued/inflight work and ignores late results", async () => {
    const service = new ControlledMermaidService();
    const runtime = new MermaidResourceRuntime({ renderService: service, maxConcurrent: 1 });
    const snapshot = parse([
      mermaid("flowchart TD\nA-->B"),
      mermaid("flowchart TD\nC-->D"),
    ].join("\n\n"));
    const harness = render(snapshot, runtime);
    expect(service.tasks).toHaveLength(1);
    harness.renderer.render(snapshot, { blockIndices: [] });
    expect(service.tasks[0]!.input.signal.aborted).toBe(true);
    service.resolve(0, svg("late"));
    await settled();
    expect(harness.root.children).toHaveLength(0);
    expect(runtime.diagnostics()).toMatchObject({ entries: 0, cancellations: 2, ready: 0 });
    harness.destroy();
    runtime.destroy();
  });

  it("defers overscan work until explicitly refreshed or visible", () => {
    const service = new ControlledMermaidService();
    let visible = false;
    const runtime = new MermaidResourceRuntime({
      renderService: service,
      shouldRender: () => visible,
    });
    const harness = render(parse(mermaid("flowchart TD\nA-->B")), runtime);
    expect(service.tasks).toHaveLength(0);
    expect(harness.root.querySelector("[data-markdown-mermaid-block]")?.getAttribute("data-markdown-mermaid-state"))
      .toBe("deferred");
    visible = true;
    runtime.refresh();
    expect(service.tasks).toHaveLength(1);
    harness.destroy();
    runtime.destroy();
  });

  it("evicts unreferenced large SVG descriptors under cache pressure", async () => {
    const service = new ControlledMermaidService();
    const runtime = new MermaidResourceRuntime({
      renderService: service,
      maxEntries: 1,
      maxBytes: 4_000,
    });
    const first = render(parse(mermaid("flowchart TD\nA-->B"), "one"), runtime);
    service.resolve(0, `<svg width="100" height="100"><text>${"x".repeat(1_000)}</text></svg>`);
    await settled();
    first.destroy();
    const second = render(parse(mermaid("flowchart TD\nC-->D"), "two"), runtime);
    service.resolve(1, `<svg width="100" height="100"><text>${"y".repeat(1_000)}</text></svg>`);
    await settled();
    expect(runtime.diagnostics()).toMatchObject({ entries: 1, ready: 1, evictions: 1 });
    second.destroy();
    expect(runtime.sweepUnreferenced()).toBe(1);
    expect(runtime.diagnostics()).toMatchObject({ entries: 0, bytes: 0 });
    runtime.destroy();
  });

  it("feeds Mermaid dimensions into anchored local height correction without replacing text blocks", async () => {
    const service = new ControlledMermaidService();
    const corrections: DocumentViewPatchResult[] = [];
    let view!: DocumentViewRuntime;
    const runtime = new MermaidResourceRuntime({
      renderService: service,
      onDimensions: (event) => {
        const result = view.updateMeasuredHeights([{ index: event.blockIndex, height: 300 }], event.snapshotRevision);
        if (result) corrections.push(result);
      },
    });
    const snapshot = parse(`${mermaid("flowchart TD\nA-->B")}\n\nReading position`);
    const host = document.createElement("div");
    document.body.append(host);
    roots.push(host);
    view = new DocumentViewRuntime(host, {
      profile: FILE_MARKDOWN_RENDERER_PROFILE,
      resourceLifecycle: runtime,
      viewport: { defaultOverscanPx: 500 },
    });
    const initial = view.publish(snapshot, [200, 100], { scrollTop: 250, viewportHeight: 100 });
    const paragraph = view.getBlockElement(snapshot.blocks[1]!.id);
    expect(initial.viewport.scrollTop).toBe(200);
    service.resolve(0, '<svg viewBox="0 0 600 400"></svg>');
    await settled();
    expect(corrections[0]?.viewport.scrollTop).toBe(300);
    expect(corrections[0]?.viewport.totalHeight).toBe(400);
    expect(view.getBlockElement(snapshot.blocks[1]!.id)).toBe(paragraph);
    view.destroy();
    runtime.destroy();
  });

  it("rejects malformed SVG and unsafe global concurrency configuration", () => {
    expect(() => sanitizeMermaidSvg("<div>not svg</div>")).toThrow(/not SVG/u);
    expect(() => sanitizeMermaidSvg("<svg><broken></svg>")).toThrow(/malformed/u);
    expect(() => new MermaidResourceRuntime({ maxConcurrent: 2 })).toThrow(/global/u);
  });
});

class ControlledMermaidService implements MarkdownMermaidRenderService {
  readonly tasks: Array<{
    input: MarkdownMermaidRenderInput;
    resolve(svg: string): void;
    reject(error: unknown): void;
  }> = [];

  render(input: MarkdownMermaidRenderInput): Promise<string> {
    return new Promise((resolve, reject) => this.tasks.push({ input, resolve, reject }));
  }

  resolve(index: number, value: string): void { this.tasks[index]!.resolve(value); }
  reject(index: number, error: unknown): void { this.tasks[index]!.reject(error); }
}

function render(
  snapshot: MarkdownSnapshot,
  resourceLifecycle: MermaidResourceRuntime,
  profile: "file-preview" | "conversation" = "file-preview",
) {
  const root = document.createElement("div");
  document.body.append(root);
  roots.push(root);
  const renderer = new RetainedMarkdownDocumentRenderer(root, {
    profile: profile === "file-preview" ? FILE_MARKDOWN_RENDERER_PROFILE : CONVERSATION_MARKDOWN_RENDERER_PROFILE,
    resourceLifecycle,
  });
  renderer.render(snapshot);
  return {
    root,
    renderer,
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
  revision = "mermaid-r1",
  surface: "file" | "message" = "file",
  previousSnapshot?: MarkdownSnapshot,
) {
  return parseCanonicalMarkdownSnapshot({
    surface,
    documentId: `${surface}:mermaid-runtime.md`,
    revision,
    source,
    rendererProfile: surface === "file" ? "file-preview" : "conversation",
  }, { previousSnapshot });
}

function mermaid(code: string): string {
  return `\`\`\`mermaid\n${code}\n\`\`\``;
}

function svg(label: string): string {
  return `<svg viewBox="0 0 100 50"><text>${label}</text></svg>`;
}

async function settled(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
