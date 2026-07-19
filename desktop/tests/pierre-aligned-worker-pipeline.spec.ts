import * as pierre from "@pierre/diffs";
import { describe, expect, it, vi } from "vitest";

import { createKeydexDiffFile } from "@/renderer/components/diff/model";
import {
  PierreAlignedPreparationCache,
  pierreAlignedPreparationCacheKey,
  type PierreAlignedWorkerManager,
} from "@/renderer/components/diff/engine/pierreAlignedWorkerPipeline";
import type { PierreAlignedPublicApi } from "@/renderer/components/diff/engine/pierreAlignedAdapter";

const patch = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n";

function file(cacheKey = "cache:a") {
  return createKeydexDiffFile({
    id: "file:a",
    cacheKey,
    oldPath: "a.ts",
    newPath: "a.ts",
    status: "modified",
    patch,
    language: "typescript",
  });
}

const api: PierreAlignedPublicApi = {
  parsePatchFiles: pierre.parsePatchFiles,
  getFiletypeFromFileName: pierre.getFiletypeFromFileName,
  getSharedHighlighter: pierre.getSharedHighlighter,
  renderDiffWithHighlighter: pierre.renderDiffWithHighlighter,
};

function harness(delay = 0) {
  const manager: PierreAlignedWorkerManager = {
    getDiffResultCache: vi.fn(() => undefined),
    cleanUpTasks: vi.fn(),
    highlightDiffAST: vi.fn((instance, metadata) => {
      setTimeout(() => instance.onHighlightSuccess(metadata, {
        code: {
          deletionLines: metadata.deletionLines.map((line: string) => ({ type: "text", value: line })),
          additionLines: metadata.additionLines.map((line: string) => ({ type: "text", value: line })),
        },
        themeStyles: "",
        baseThemeType: "light",
      }, {
        theme: "keydex-diff-light",
        useTokenTransformer: false,
        tokenizeMaxLineLength: 1_000,
        lineDiffType: "word-alt",
        maxLineDiffLength: 1_000,
      }), delay);
    }),
  };
  return manager;
}

function request(manager: PierreAlignedWorkerManager, overrides: Record<string, unknown> = {}) {
  return {
    file: file(),
    sourceVersion: "v1",
    theme: "light" as const,
    api,
    manager,
    ...overrides,
  };
}

describe("Pierre aligned Worker preparation cache", () => {
  it("deduplicates concurrent work and reuses the prepared result", async () => {
    const cache = new PierreAlignedPreparationCache();
    const manager = harness();
    const [first, second] = await Promise.all([
      cache.prepare(request(manager)),
      cache.prepare(request(manager)),
    ]);
    expect(first).toBe(second);
    expect(manager.highlightDiffAST).toHaveBeenCalledTimes(1);
    expect(await cache.prepare(request(manager))).toBe(first);
  });

  it("does not include wrap, pane width or sync state in cache identity", () => {
    const base = request(harness());
    expect(pierreAlignedPreparationCacheKey(base)).toBe(
      pierreAlignedPreparationCacheKey({ ...base, wrap: true, width: 300, syncScroll: false } as never),
    );
    expect(pierreAlignedPreparationCacheKey(base)).not.toBe(
      pierreAlignedPreparationCacheKey({ ...base, theme: "dark" }),
    );
    expect(pierreAlignedPreparationCacheKey(base)).not.toBe(
      pierreAlignedPreparationCacheKey({ ...base, sourceVersion: "v2" }),
    );
  });

  it("cancels orphaned worker work and rejects the consumer", async () => {
    const cache = new PierreAlignedPreparationCache();
    const manager = harness(20);
    const controller = new AbortController();
    const pending = cache.prepare(request(manager, { signal: controller.signal }));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    expect(manager.cleanUpTasks).toHaveBeenCalledTimes(1);
    expect(cache.size()).toBe(0);
  });

  it("drops stale consumers without poisoning the shared cache", async () => {
    const cache = new PierreAlignedPreparationCache();
    const manager = harness();
    await expect(cache.prepare(request(manager, { isCurrent: () => false }))).rejects.toMatchObject({
      code: "stale",
    });
    await expect(cache.prepare(request(manager, { isCurrent: () => true }))).resolves.toMatchObject({
      fileId: "file:a",
      sourceVersion: "v1",
    });
    expect(manager.highlightDiffAST).toHaveBeenCalledTimes(1);
  });

  it("aborting one deduplicated consumer keeps work alive for another", async () => {
    const cache = new PierreAlignedPreparationCache();
    const manager = harness(10);
    const controller = new AbortController();
    const first = cache.prepare(request(manager, { signal: controller.signal }));
    const second = cache.prepare(request(manager));
    controller.abort();
    await expect(first).rejects.toMatchObject({ code: "aborted" });
    await expect(second).resolves.toMatchObject({ fileId: "file:a" });
    expect(manager.cleanUpTasks).not.toHaveBeenCalled();
  });
});
