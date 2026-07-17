import { describe, expect, it } from "vitest";
import { parsePatchFiles } from "@pierre/diffs";

import {
  createPierreCodeViewItems,
  pierreCodeViewProps,
  pierreCodeViewScrollTarget,
} from "@/renderer/components/diff/engine/PierreCodeView";
import {
  keydexCodeViewItemMetrics,
  keydexCodeViewLayout,
} from "@/renderer/components/diff/engine/pierreOptions";
import { createKeydexDiffDocument } from "@/renderer/components/diff/model";
import { normalizeUnifiedPatch } from "@/renderer/components/diff/normalizers/unifiedPatch";

function patch(count: number) {
  return Array.from({ length: count }, (_, index) => [
    `diff --git a/src/file-${index}.ts b/src/file-${index}.ts`,
    `--- a/src/file-${index}.ts`,
    `+++ b/src/file-${index}.ts`,
    "@@ -1 +1 @@",
    `-old-${index}`,
    `+new-${index}`,
    "",
  ].join("\n")).join("");
}

describe("Pierre CodeView adapter", () => {
  it.each([1, 50, 500])("maps %i files into ordered controlled items", (count) => {
    const document = normalizeUnifiedPatch(patch(count), {
      source: "preview",
      sourceVersion: `v-${count}`,
    });
    const result = createPierreCodeViewItems(document, parsePatchFiles);

    expect(result.unavailable).toEqual([]);
    expect(result.items).toHaveLength(count);
    expect(result.items.map((item) => item.id)).toEqual(
      document.files.map((file) => file.id),
    );
    expect(result.items[0]).toMatchObject({
      type: "diff",
      version: expect.any(Number),
      fileDiff: { name: "src/file-0.ts", lang: "typescript" },
    });
  });

  it("keeps controlled ownership and shared layout metrics", () => {
    const document = normalizeUnifiedPatch(patch(1), { sourceVersion: "v1" });
    const result = createPierreCodeViewItems(document, parsePatchFiles);
    const props = pierreCodeViewProps(result.items, {
      profile: "preview",
      theme: "dark",
      layout: "split",
      wrap: true,
    });

    expect(props).toHaveProperty("items", result.items);
    expect(props).not.toHaveProperty("initialItems");
    expect(props.options).toMatchObject({
      themeType: "dark",
      diffStyle: "split",
      overflow: "wrap",
      stickyHeaders: true,
      layout: keydexCodeViewLayout("preview"),
      itemMetrics: keydexCodeViewItemMetrics("preview"),
    });
    expect(props.options).not.toHaveProperty("unsafeCSS");
  });

  it("keeps stable item ids while versioning controlled content updates", () => {
    const first = normalizeUnifiedPatch(patch(1), { sourceVersion: "v1" });
    const second = createKeydexDiffDocument({
      ...first,
      sourceVersion: "v2",
      files: first.files,
    });
    const firstItem = createPierreCodeViewItems(first, parsePatchFiles).items[0]!;
    const secondItem = createPierreCodeViewItems(second, parsePatchFiles).items[0]!;

    expect(secondItem.id).toBe(firstItem.id);
    expect(secondItem.version).not.toBe(firstItem.version);
  });

  it("versions expansion changes so Pierre refreshes controlled collapsed items", () => {
    const document = normalizeUnifiedPatch(patch(2), { sourceVersion: "expansion" });
    const firstId = document.files[0]!.id;
    const collapsed = createPierreCodeViewItems(document, parsePatchFiles, []).items[0]!;
    const expanded = createPierreCodeViewItems(document, parsePatchFiles, [firstId]).items[0]!;

    expect(collapsed.id).toBe(expanded.id);
    expect(collapsed.collapsed).toBe(true);
    expect(expanded.collapsed).toBe(false);
    expect(collapsed.version).not.toBe(expanded.version);
  });

  it("isolates malformed, binary and truncated files without resetting valid items", () => {
    const valid = normalizeUnifiedPatch(patch(2), { sourceVersion: "mixed" });
    const template = valid.files[0]!;
    const mixed = createKeydexDiffDocument({
      ...valid,
      files: [
        valid.files[0]!,
        {
          ...template,
          id: "malformed",
          cacheKey: "malformed-cache",
          oldPath: "broken.ts",
          newPath: "broken.ts",
          displayPath: "broken.ts",
          patch: "diff --git a/broken.ts b/broken.ts\n@@ broken @@\n",
        },
        {
          ...template,
          id: "binary",
          cacheKey: "binary-cache",
          oldPath: "image.png",
          newPath: "image.png",
          displayPath: "image.png",
          contentKind: "binary",
          binary: true,
          selectableForPatch: false,
        },
        {
          ...template,
          id: "truncated",
          cacheKey: "truncated-cache",
          oldPath: "partial.ts",
          newPath: "partial.ts",
          displayPath: "partial.ts",
          truncated: true,
          truncation: {
            state: "unrecoverable",
            reason: "producer_limit",
            canLoadMore: false,
            continuationToken: null,
            loadedBytes: 12,
            totalBytes: null,
            loadedLines: 1,
            totalLines: null,
          },
          selectableForPatch: false,
        },
        valid.files[1]!,
      ],
    });
    const result = createPierreCodeViewItems(mixed, parsePatchFiles);

    expect(result.items.map((item) => item.id)).toEqual([
      valid.files[0]!.id,
      valid.files[1]!.id,
    ]);
    expect(result.unavailable.map((item) => [item.file.id, item.reason])).toEqual([
      ["malformed", "parse_failed"],
      ["binary", "non_text"],
      ["truncated", "truncated"],
    ]);
  });

  it("creates an item scroll target only for a visible controlled file", () => {
    const document = normalizeUnifiedPatch(patch(2), { sourceVersion: "scroll" });
    const items = createPierreCodeViewItems(document, parsePatchFiles).items;

    expect(pierreCodeViewScrollTarget(items, items[1]!.id, "smooth")).toEqual({
      type: "item",
      id: items[1]!.id,
      align: "start",
      behavior: "smooth",
    });
    expect(pierreCodeViewScrollTarget(items, "missing")).toBeNull();
  });
});
