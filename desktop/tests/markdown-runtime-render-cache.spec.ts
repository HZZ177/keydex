import { describe, expect, it, vi } from "vitest";

import {
  MarkdownRenderCache,
  type MarkdownMeasurementEnvironment,
  type MarkdownResourceEnvironment,
} from "@/renderer/markdownRuntime/cache";
import type {
  MarkdownSnapshot,
  MarkdownSnapshotBlock,
  MarkdownSnapshotResource,
} from "@/renderer/markdownRuntime/document/MarkdownSnapshot";
import { parseCanonicalMarkdownSnapshot } from "@/renderer/markdownRuntime/worker/parser";

const SOURCE = [
  "# Cache fixture",
  "",
  "A paragraph with ![preview](https://example.test/image.png).",
  "",
  "```mermaid",
  "graph TD",
  "  A --> B",
  "```",
  "",
  "Final paragraph.",
].join("\n");

function snapshot(
  surface: "file" | "message" = "file",
  revision = "r1",
  previousSnapshot: MarkdownSnapshot | null = null,
) {
  return parseCanonicalMarkdownSnapshot({
    surface,
    documentId: surface === "file" ? "file:cache.md" : "message:turn-1",
    revision,
    source: SOURCE,
    rendererProfile: surface === "file" ? "file-preview" : "conversation",
  }, { previousSnapshot });
}

function measurement(
  overrides: Partial<MarkdownMeasurementEnvironment> = {},
): MarkdownMeasurementEnvironment {
  return {
    profile: "file-preview",
    viewportWidth: 800,
    themeKey: "light",
    fontRevision: "font-1",
    resourceRevision: "resources-1",
    ...overrides,
  };
}

function resourceEnvironment(
  overrides: Partial<MarkdownResourceEnvironment> = {},
): MarkdownResourceEnvironment {
  return {
    profile: "file-preview",
    themeKey: "light",
    resourceRevision: "resources-1",
    ...overrides,
  };
}

function fixture() {
  const value = snapshot();
  const block = value.blocks.find((candidate) => candidate.kind === "paragraph")!;
  const otherBlock = value.blocks.find((candidate) => candidate.id !== block.id)!;
  const image = value.resources.find((candidate) => candidate.kind === "image")!;
  const mermaid = value.resources.find((candidate) => candidate.kind === "mermaid")!;
  return { snapshot: value, block, otherBlock, image, mermaid };
}

describe("Markdown block render and measurement cache", () => {
  it("reuses stable descriptors across document revisions but isolates renderer profiles", () => {
    const first = snapshot();
    const second = snapshot("file", "r2", first);
    const block = first.blocks[0]!;
    const reconciled = second.blocks[0]!;
    const cache = new MarkdownRenderCache();
    const factory = vi.fn(() => ({ tag: "h1", text: "Cache fixture" }));

    const descriptor = cache.getOrCreateDescriptor(block, "file-preview", factory);
    expect(cache.getOrCreateDescriptor(reconciled, "file-preview", factory)).toBe(descriptor);
    expect(cache.getDescriptor(reconciled, "conversation")).toBeUndefined();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(cache.diagnostics().layers.descriptor).toMatchObject({ hits: 1, misses: 2, entries: 1 });
  });

  it("keeps descriptor, measurement, and resource invalidation layers independent", () => {
    const { block, image, mermaid } = fixture();
    const cache = new MarkdownRenderCache();
    const light = measurement({ resourceIds: [image.id] });
    cache.setDescriptor(block, "file-preview", { kind: block.kind });
    cache.setMeasurement(block, light, 120);
    cache.setResource(image, resourceEnvironment(), { naturalWidth: 640 });
    cache.setResource(mermaid, resourceEnvironment(), "<svg />");

    expect(cache.getMeasurement(block, measurement({ viewportWidth: 801, resourceIds: [image.id] }))).toBe(120);
    expect(cache.getMeasurement(block, measurement({ viewportWidth: 806, resourceIds: [image.id] }))).toBeUndefined();
    expect(cache.getDescriptor(block, "file-preview")).toBeDefined();
    expect(cache.getResource(image, resourceEnvironment({ themeKey: "dark" }))).toEqual({ naturalWidth: 640 });
    expect(cache.getResource(mermaid, resourceEnvironment({ themeKey: "dark" }))).toBeUndefined();
    expect(cache.getMeasurement(block, measurement({ themeKey: "dark", resourceIds: [image.id] }))).toBeUndefined();
    expect(cache.getMeasurement(block, measurement({ fontRevision: "font-2", resourceIds: [image.id] }))).toBeUndefined();
    expect(cache.getMeasurement(block, measurement({ resourceRevision: "resources-2", resourceIds: [image.id] }))).toBeUndefined();
    expect(cache.getDescriptor(block, "file-preview")).toBeDefined();
  });

  it("invalidates only changed blocks and preserves valid resource results on a new revision", () => {
    const { snapshot: value, block, otherBlock, image } = fixture();
    const cache = new MarkdownRenderCache();
    cache.setDescriptor(block, "file-preview", { block: block.id });
    cache.setDescriptor(otherBlock, "file-preview", { block: otherBlock.id });
    cache.setMeasurement(block, measurement({ resourceIds: [image.id] }), 88);
    cache.setResource(image, resourceEnvironment(), { decoded: true });

    const changed = { ...block, content_hash: "hash:changed" } satisfies MarkdownSnapshotBlock;
    const valid = new Map(value.blocks.map((candidate) => [
      candidate.id,
      candidate.id === block.id ? changed.content_hash : candidate.content_hash,
    ]));

    expect(cache.invalidateRevision(valid)).toBe(2);
    expect(cache.getDescriptor(block, "file-preview")).toBeUndefined();
    expect(cache.getDescriptor(otherBlock, "file-preview")).toEqual({ block: otherBlock.id });
    expect(cache.getResource(image, resourceEnvironment())).toEqual({ decoded: true });
  });

  it("performs exact width, theme, font, resource, and profile invalidation", () => {
    const { block, image, mermaid } = fixture();
    const cache = new MarkdownRenderCache();
    cache.setDescriptor(block, "file-preview", "file");
    cache.setDescriptor(block, "conversation", "message");
    cache.setMeasurement(block, measurement({ resourceIds: [image.id] }), 90);
    cache.setMeasurement(block, measurement({ viewportWidth: 900, resourceIds: [mermaid.id] }), 100);
    cache.setResource(image, resourceEnvironment(), "image");
    cache.setResource(mermaid, resourceEnvironment(), "mermaid");

    expect(cache.invalidateWidth(800)).toBe(1);
    expect(cache.invalidateResource(image.id)).toBe(1);
    expect(cache.invalidateTheme("light")).toBe(2);
    expect(cache.invalidateProfile("conversation")).toBe(1);
    expect(cache.diagnostics().entries).toBe(1);
    expect(cache.getDescriptor(block, "file-preview")).toBe("file");

    cache.setMeasurement(block, measurement({ fontRevision: "font-old" }), 90);
    cache.setMeasurement(block, measurement({ fontRevision: "font-new" }), 90);
    expect(cache.invalidateFont("font-old")).toBe(1);
    cache.setResource(image, resourceEnvironment({ resourceRevision: "old" }), "old");
    cache.setResource(image, resourceEnvironment({ resourceRevision: "new" }), "new");
    expect(cache.invalidateResourceRevision("old")).toBe(1);
  });

  it("shares cache values across attached views without sharing mutable view state", () => {
    const { block } = fixture();
    const sharedDocumentCache = new MarkdownRenderCache();
    const previewView = { cache: sharedDocumentCache, scrollY: 10 };
    const splitView = { cache: sharedDocumentCache, scrollY: 900 };
    const descriptor = previewView.cache.setDescriptor(block, "file-preview", Object.freeze({ tag: "p" }));

    expect(splitView.cache.getDescriptor(block, "file-preview")).toBe(descriptor);
    expect(splitView.scrollY).toBe(900);
    expect(previewView.scrollY).toBe(10);
    previewView.cache.clear();
    expect(splitView.cache.diagnostics().entries).toBe(0);
  });

  it("enforces global LRU entry and byte budgets with diagnosable layer totals", () => {
    const { snapshot: value } = fixture();
    const cache = new MarkdownRenderCache({ maxEntries: 8, maxBytes: 900 });
    const blocks = Array.from({ length: 10 }, (_, index) => ({
      ...value.blocks[index % value.blocks.length]!,
      id: `block-${index}`,
      content_hash: `hash-${index}`,
    } satisfies MarkdownSnapshotBlock));
    blocks.slice(0, 8).forEach((block) => cache.setDescriptor(block, "file-preview", `value-${block.id}`, 100));
    expect(cache.getDescriptor(blocks[0]!, "file-preview")).toBe("value-block-0");
    cache.setDescriptor(blocks[8]!, "file-preview", "value-block-8", 100);
    cache.setDescriptor(blocks[9]!, "file-preview", "value-block-9", 100);

    const diagnostics = cache.diagnostics();
    expect(diagnostics).toMatchObject({ entries: 8, bytes: 800, maxEntries: 8, maxBytes: 900, evictions: 2 });
    expect(cache.getDescriptor(blocks[0]!, "file-preview")).toBe("value-block-0");
    expect(cache.getDescriptor(blocks[1]!, "file-preview")).toBeUndefined();
    expect(cache.getDescriptor(blocks[2]!, "file-preview")).toBeUndefined();
    expect(diagnostics.layers.descriptor).toMatchObject({ entries: 8, bytes: 800 });
  });

  it("deduplicates successful resource work and never persists failures or invalidated inflight results", async () => {
    const { image } = fixture();
    const cache = new MarkdownRenderCache();
    const failed = vi.fn().mockRejectedValueOnce(new Error("decode failed")).mockResolvedValue({ decoded: true });
    await expect(cache.getOrCreateResource(image, resourceEnvironment(), failed)).rejects.toThrow("decode failed");
    await expect(cache.getOrCreateResource(image, resourceEnvironment(), failed)).resolves.toEqual({ decoded: true });
    expect(failed).toHaveBeenCalledTimes(2);

    let resolve!: (value: { decoded: boolean }) => void;
    const delayed = vi.fn(() => new Promise<{ decoded: boolean }>((done) => { resolve = done; }));
    const changedResource = { ...image, cache_key: `${image.cache_key}:changed` } satisfies MarkdownSnapshotResource;
    const first = cache.getOrCreateResource(changedResource, resourceEnvironment(), delayed);
    const second = cache.getOrCreateResource(changedResource, resourceEnvironment(), delayed);
    await Promise.resolve();
    expect(delayed).toHaveBeenCalledTimes(1);
    cache.invalidateResource(changedResource.id);
    resolve({ decoded: true });
    await expect(Promise.all([first, second])).resolves.toEqual([{ decoded: true }, { decoded: true }]);
    expect(cache.getResource(changedResource, resourceEnvironment())).toBeUndefined();
  });

  it("rejects live DOM and invalid measurements instead of retaining unsafe cache values", () => {
    const { block } = fixture();
    const cache = new MarkdownRenderCache();
    const node = document.createElement("div");

    expect(() => cache.setDescriptor(block, "file-preview", { nested: { node } })).toThrow(/live DOM/u);
    expect(() => cache.setMeasurement(block, measurement(), -1)).toThrow(/non-negative/u);
    expect(() => new MarkdownRenderCache({ maxEntries: 0 })).toThrow(/positive integer/u);
    expect(() => cache.getMeasurement(block, measurement({ viewportWidth: Number.NaN }))).toThrow(/viewportWidth/u);
  });
});
