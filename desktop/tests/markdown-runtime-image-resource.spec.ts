import { afterEach, describe, expect, it, vi } from "vitest";

import type { MarkdownSnapshot } from "@/renderer/markdownRuntime/document/MarkdownSnapshot";
import {
  ImageResourceRuntime,
  resolveMarkdownImageLocation,
  type MarkdownDecodedImage,
} from "@/renderer/markdownRuntime/resources";
import {
  CONVERSATION_MARKDOWN_RENDERER_PROFILE,
  FILE_MARKDOWN_RENDERER_PROFILE,
  RetainedMarkdownDocumentRenderer,
} from "@/renderer/markdownRuntime/renderers";
import {
  DocumentViewRuntime,
  type DocumentViewPatchResult,
} from "@/renderer/markdownRuntime/view/DocumentViewRuntime";
import { parseCanonicalMarkdownSnapshot } from "@/renderer/markdownRuntime/worker/parser";

const roots: HTMLElement[] = [];

afterEach(() => {
  roots.splice(0).forEach((root) => root.remove());
  vi.restoreAllMocks();
});

describe("shared Markdown image Resource Runtime", () => {
  it("resolves direct, relative, root-workspace, and unsafe locations without bypassing policy", () => {
    expect(resolveMarkdownImageLocation("https://example.test/a.png")).toMatchObject({
      kind: "direct", src: "https://example.test/a.png",
    });
    expect(resolveMarkdownImageLocation("data:image/png;base64,AA==")).toMatchObject({ kind: "direct" });
    expect(resolveMarkdownImageLocation("blob:keydex-image")).toMatchObject({ kind: "direct" });
    expect(resolveMarkdownImageLocation("../assets/a.png", "docs/guide/readme.md", "ws-1")).toMatchObject({
      kind: "workspace", path: "docs/assets/a.png",
    });
    expect(resolveMarkdownImageLocation("/assets/a.png", "docs/readme.md", "ws-1")).toMatchObject({
      kind: "workspace", path: "assets/a.png",
    });
    expect(resolveMarkdownImageLocation("../../escape.png", "readme.md", "ws-1")).toMatchObject({ kind: "blocked" });
    expect(resolveMarkdownImageLocation("relative.png", "readme.md", null)).toMatchObject({ kind: "blocked" });
    expect(resolveMarkdownImageLocation("javascript:alert(1)", null, "ws-1")).toMatchObject({ kind: "blocked" });
    expect(resolveMarkdownImageLocation("file:///C:/secret.png", null, "ws-1")).toMatchObject({ kind: "blocked" });
    expect(resolveMarkdownImageLocation("C:\\secret.png", null, "ws-1")).toMatchObject({ kind: "blocked" });
    expect(resolveMarkdownImageLocation("data:text/html,unsafe", null, "ws-1")).toMatchObject({ kind: "blocked" });
    expect(resolveMarkdownImageLocation("bad%ZZ.png", "docs/readme.md", "ws-1")).toMatchObject({ kind: "blocked" });
  });

  it("loads and decodes once across file-preview and conversation surfaces", async () => {
    const decode = vi.fn(async () => ({ width: 640, height: 360 }));
    const states = vi.fn();
    const dimensions = vi.fn();
    const runtime = new ImageResourceRuntime({ decodeImage: decode, onStateChange: states, onDimensions: dimensions });
    const source = "![shared](https://example.test/shared.png)";
    const file = render(parse(source, "file-r1", "file"), runtime, "file-preview");
    await settled();
    const message = render(parse(source, "message-r1", "message"), runtime, "conversation");

    const fileImage = file.root.querySelector<HTMLImageElement>("img")!;
    const messageImage = message.root.querySelector<HTMLImageElement>("img")!;
    expect(decode).toHaveBeenCalledTimes(1);
    expect(fileImage.dataset.markdownImageState).toBe("ready");
    expect(messageImage.dataset.markdownImageState).toBe("ready");
    expect(messageImage.width).toBe(640);
    expect(messageImage.height).toBe(360);
    expect(dimensions.mock.calls[1]?.[0]).toMatchObject({ fromCache: true, width: 640, height: 360 });
    expect(runtime.diagnostics()).toMatchObject({ entries: 1, ready: 1, referenced: 1, hits: 1, misses: 1 });
    expect(states).toHaveBeenCalledWith(expect.objectContaining({ state: "ready" }));
    file.destroy();
    message.destroy();
    runtime.destroy();
  });

  it("resolves workspace paths, caches returned dimensions, and opens the resolved image", async () => {
    const read = vi.fn(async (path: string) => ({
      dataUrl: "data:image/png;base64,AA==",
      mediaType: "image/png",
      bytes: 1,
      revision: "asset-r7",
      path,
    }));
    const activate = vi.fn();
    const runtime = new ImageResourceRuntime({
      sourcePathFor: () => "docs/readme.md",
      workspaceKeyFor: () => "workspace-7",
      resourceRevisionFor: () => "workspace-revision-7",
      readWorkspaceImage: read,
      decodeImage: async () => ({ width: 2, height: 3 }),
    });
    const harness = render(parse("![diagram](assets/diagram.png)"), runtime, "file-preview", activate);
    await settled();
    const image = harness.root.querySelector<HTMLImageElement>("img")!;
    image.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(read).toHaveBeenCalledWith("docs/assets/diagram.png", expect.anything(), expect.any(AbortSignal));
    expect(image.getAttribute("src")).toBe("data:image/png;base64,AA==");
    expect(image.style.aspectRatio).toBe("2 / 3");
    expect(activate).toHaveBeenCalledWith(expect.any(MouseEvent), expect.objectContaining({
      src: "data:image/png;base64,AA==",
      alt: "diagram",
    }));
    const descriptor = runtime.diagnostics();
    expect(descriptor).toMatchObject({ entries: 1, ready: 1, failures: 0 });
    harness.destroy();
    expect(runtime.sweepUnreferenced()).toBe(1);
    runtime.destroy();
  });

  it("shows a stable placeholder, publishes late dimensions, and keeps sibling DOM retained", async () => {
    const decoder = new ControlledDecoder();
    const dimensions = vi.fn();
    const runtime = new ImageResourceRuntime({ decodeImage: decoder.decode, onDimensions: dimensions });
    const harness = render(parse("![late](https://example.test/late.png)\n\nSibling paragraph"), runtime);
    const image = harness.root.querySelector<HTMLImageElement>("img")!;
    const sibling = [...harness.root.children].find((element) => element.textContent === "Sibling paragraph");
    expect(image.dataset.markdownImageState).toBe("pending");
    expect(image.getAttribute("aria-busy")).toBe("true");
    expect(image.style.minHeight).toBe("160px");
    expect(image.hasAttribute("src")).toBe(false);

    decoder.resolve(0, { width: 800, height: 600 });
    await settled();
    expect(image.dataset.markdownImageState).toBe("ready");
    expect(image.style.minHeight).toBe("");
    expect(dimensions).toHaveBeenCalledWith(expect.objectContaining({ width: 800, height: 600, fromCache: false }));
    expect([...harness.root.children].find((element) => element.textContent === "Sibling paragraph")).toBe(sibling);
    harness.destroy();
    runtime.destroy();
  });

  it("isolates failures to an alt fallback and retries without caching the error", async () => {
    const decode = vi.fn()
      .mockRejectedValueOnce(new Error("decode failed"))
      .mockResolvedValueOnce({ width: 320, height: 180 });
    const runtime = new ImageResourceRuntime({ decodeImage: decode });
    const harness = render(parse("![Readable alt](https://example.test/retry.png)"), runtime);
    await settled();
    const image = harness.root.querySelector<HTMLImageElement>("img")!;
    const fallback = harness.root.querySelector<HTMLElement>("[data-markdown-image-fallback]")!;
    expect(image.dataset.markdownImageState).toBe("failed");
    expect(fallback.getAttribute("aria-label")).toBe("Readable alt");
    expect(harness.root.querySelector("figure")?.dataset.markdownBlockError).toBeUndefined();

    fallback.querySelector<HTMLButtonElement>("[data-markdown-image-retry]")!.click();
    await settled();
    expect(decode).toHaveBeenCalledTimes(2);
    expect(image.dataset.markdownImageState).toBe("ready");
    expect(harness.root.querySelector("[data-markdown-image-fallback]")).toBeNull();
    expect(runtime.diagnostics()).toMatchObject({ failures: 1, ready: 1 });
    harness.destroy();
    runtime.destroy();
  });

  it("aborts unreferenced inflight work and ignores its late completion", async () => {
    const decoder = new ControlledDecoder();
    const runtime = new ImageResourceRuntime({ decodeImage: decoder.decode });
    const harness = render(parse("![late](https://example.test/cancel.png)"), runtime);
    await Promise.resolve();
    expect(decoder.tasks).toHaveLength(1);
    harness.destroy();
    expect(decoder.tasks[0]!.signal.aborted).toBe(true);
    decoder.resolve(0, { width: 1, height: 1 });
    await settled();
    expect(runtime.diagnostics()).toMatchObject({ entries: 0, aborts: 1, ready: 0 });
    expect(harness.root.children).toHaveLength(0);
    runtime.destroy();
  });

  it("keys by normalized URL, content, and resource revision", async () => {
    const decode = vi.fn(async () => ({ width: 10, height: 10 }));
    let revision = "asset-r1";
    const runtime = new ImageResourceRuntime({
      decodeImage: decode,
      resourceRevisionFor: () => revision,
    });
    const first = render(parse("![same](https://example.test/versioned.png)", "doc-r1"), runtime);
    await settled();
    first.destroy();
    const same = render(parse("![same](https://example.test/versioned.png)", "doc-r2"), runtime);
    expect(decode).toHaveBeenCalledTimes(1);
    same.destroy();

    revision = "asset-r2";
    const revised = render(parse("![same](https://example.test/versioned.png)", "doc-r3"), runtime);
    await settled();
    expect(decode).toHaveBeenCalledTimes(2);
    revised.destroy();
    const changedContent = render(parse("![changed alt](https://example.test/versioned.png)", "doc-r4"), runtime);
    await settled();
    expect(decode).toHaveBeenCalledTimes(3);
    changedContent.destroy();
    runtime.destroy();
  });

  it("evicts only unreferenced ready entries under entry and byte pressure", async () => {
    const runtime = new ImageResourceRuntime({
      maxEntries: 1,
      maxBytes: 700,
      decodeImage: async () => ({ width: 20, height: 20 }),
    });
    const first = render(parse("![one](data:image/png;base64,AAAA)", "one"), runtime);
    await settled();
    const second = render(parse("![two](data:image/png;base64,BBBB)", "two"), runtime);
    await settled();
    expect(runtime.diagnostics()).toMatchObject({ entries: 2, referenced: 2, evictions: 0 });
    first.destroy();
    const third = render(parse("![three](data:image/png;base64,CCCC)", "three"), runtime);
    await settled();
    expect(runtime.diagnostics()).toMatchObject({ entries: 2, referenced: 2, evictions: 1 });
    second.destroy();
    expect(runtime.diagnostics()).toMatchObject({ entries: 1, referenced: 1, evictions: 2 });
    third.destroy();
    expect(runtime.sweepUnreferenced()).toBe(1);
    expect(runtime.diagnostics()).toMatchObject({ entries: 0, bytes: 0 });
    runtime.destroy();
  });

  it("feeds late image height into DocumentViewRuntime scroll-anchor correction", async () => {
    const decoder = new ControlledDecoder();
    let runtimeView!: DocumentViewRuntime;
    const corrections: DocumentViewPatchResult[] = [];
    const imageRuntime = new ImageResourceRuntime({
      decodeImage: decoder.decode,
      onDimensions: (event) => {
        const result = runtimeView.updateMeasuredHeights([{ index: event.blockIndex, height: 320 }], event.snapshotRevision);
        if (result) corrections.push(result);
      },
    });
    const snapshot = parse("![anchor](https://example.test/anchor.png)\n\nReading position");
    const host = document.createElement("div");
    document.body.append(host);
    roots.push(host);
    runtimeView = new DocumentViewRuntime(host, {
      profile: FILE_MARKDOWN_RENDERER_PROFILE,
      resourceLifecycle: imageRuntime,
      viewport: { defaultOverscanPx: 500 },
    });
    const initial = runtimeView.publish(snapshot, [160, 100], { scrollTop: 200, viewportHeight: 100 });
    const paragraph = runtimeView.getBlockElement(snapshot.blocks[1]!.id);
    expect(initial.viewport.scrollTop).toBe(160);
    decoder.resolve(0, { width: 640, height: 640 });
    await settled();

    expect(corrections[0]?.viewport.scrollTop).toBe(320);
    expect(corrections[0]?.viewport.totalHeight).toBe(420);
    expect(runtimeView.getBlockElement(snapshot.blocks[1]!.id)).toBe(paragraph);
    expect(runtimeView.scrollAnchorDiagnostics()).toMatchObject({ applied: 1 });
    runtimeView.destroy();
    imageRuntime.destroy();
  });
});

class ControlledDecoder {
  readonly tasks: Array<{
    signal: AbortSignal;
    resolve(value: MarkdownDecodedImage): void;
    reject(error: unknown): void;
  }> = [];

  readonly decode = (_src: string, signal: AbortSignal): Promise<MarkdownDecodedImage> => new Promise((resolve, reject) => {
    this.tasks.push({ signal, resolve, reject });
  });

  resolve(index: number, value: MarkdownDecodedImage): void {
    this.tasks[index]!.resolve(value);
  }
}

function render(
  snapshot: MarkdownSnapshot,
  resourceLifecycle: ImageResourceRuntime,
  profile: "file-preview" | "conversation" = "file-preview",
  onImageActivate?: ReturnType<typeof vi.fn>,
) {
  const root = document.createElement("div");
  document.body.append(root);
  roots.push(root);
  const renderer = new RetainedMarkdownDocumentRenderer(root, {
    profile: profile === "file-preview" ? FILE_MARKDOWN_RENDERER_PROFILE : CONVERSATION_MARKDOWN_RENDERER_PROFILE,
    resourceLifecycle,
    interactions: { onImageActivate },
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
  revision = "image-r1",
  surface: "file" | "message" = "file",
) {
  return parseCanonicalMarkdownSnapshot({
    surface,
    documentId: `${surface}:image-runtime.md`,
    revision,
    source,
    rendererProfile: surface === "file" ? "file-preview" : "conversation",
  });
}

async function settled(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
