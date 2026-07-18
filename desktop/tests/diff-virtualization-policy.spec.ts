import { describe, expect, it, vi } from "vitest";

import { createKeydexDiffDocument, createKeydexDiffFile } from "@/renderer/components/diff/model";
import {
  applyPierreCodeViewVirtualization,
  resolveKeydexDiffVirtualizationPolicy,
} from "@/renderer/components/diff/virtualizationPolicy";
import { pierreCodeViewProps } from "@/renderer/components/diff/engine/PierreCodeView";

describe("Keydex Diff CodeView virtualization policy", () => {
  it("keeps an ordinary single-file diff on the direct renderer", () => {
    const policy = resolveKeydexDiffVirtualizationPolicy(document(1, 20), "preview", false);
    expect(policy).toMatchObject({
      strategy: "single",
      level: "none",
      virtualized: false,
      reason: "single_small",
    });
  });

  it("keeps an ordinary single Git file on the direct renderer", () => {
    expect(resolveKeydexDiffVirtualizationPolicy(document(1, 20), "git", false)).toMatchObject({
      strategy: "single",
      level: "none",
      virtualized: false,
      reason: "single_small",
    });
  });

  it.each([
    ["files", document(500, 1), "large_file_count"],
    ["lines", document(1, 20_000), "large_line_count"],
    ["bytes", document(1, 20, "x".repeat(800 * 1024)), "large_bytes"],
  ] as const)("uses bounded aggressive virtualization for large %s", (_kind, input, reason) => {
    const policy = resolveKeydexDiffVirtualizationPolicy(input, "git", false);
    expect(policy).toMatchObject({
      strategy: "code_view",
      level: "aggressive",
      virtualized: true,
      reason,
      maxMountedItems: 48,
    });
    expect(policy.maxMountedItems).toBeLessThan(2_000);
  });

  it("uses standard CodeView virtualization for a small multi-file document", () => {
    expect(resolveKeydexDiffVirtualizationPolicy(document(2, 5), "preview", false)).toMatchObject({
      strategy: "code_view",
      level: "standard",
      reason: "multi_file",
      maxMountedItems: 32,
    });
  });

  it("adjusts metrics for wrapping so resized rows can correct their measured height", () => {
    const plain = resolveKeydexDiffVirtualizationPolicy(document(20, 100), "review", false);
    const wrapped = resolveKeydexDiffVirtualizationPolicy(document(20, 100), "review", true);
    expect(wrapped.itemMetrics.lineHeight).toBeGreaterThan(plain.itemMetrics.lineHeight!);
    expect(wrapped.itemMetrics).toMatchObject({ hunkSeparatorHeight: 30, diffHeaderHeight: 36 });
  });

  it("passes calibrated metrics to controlled CodeView options", () => {
    const policy = resolveKeydexDiffVirtualizationPolicy(document(500, 1), "git", false);
    const props = pierreCodeViewProps([], {
      profile: "git",
      theme: "light",
      className: "consumer-class",
      virtualizationPolicy: policy,
    });
    expect(props.className).toContain("consumer-class");
    expect(props.className).not.toBe("consumer-class");
    expect(props.options?.itemMetrics).toEqual(policy.itemMetrics);
    expect(props.options?.__devOnlyValidateItemHeights).toBe(false);
  });

  it("applies public overscan config while keeping resize debugging test-only", () => {
    const config = { overscrollSize: 0, intersectionObserverMargin: 0, resizeDebugging: false };
    const handle = { getInstance: vi.fn(() => ({ config })) };
    const policy = resolveKeydexDiffVirtualizationPolicy(document(500, 1), "git", false);
    expect(applyPierreCodeViewVirtualization(handle as never, policy, {
      resizeDebugging: true,
      testEnvironment: false,
    })).toBe(true);
    expect(config).toMatchObject({
      overscrollSize: policy.overscrollSize,
      intersectionObserverMargin: policy.intersectionObserverMargin,
      resizeDebugging: false,
    });
    applyPierreCodeViewVirtualization(handle as never, policy, {
      resizeDebugging: true,
      testEnvironment: true,
    });
    expect(config.resizeDebugging).toBe(true);
  });

  it("keeps policy immutable across fast top/middle/bottom navigation calculations", () => {
    const policy = resolveKeydexDiffVirtualizationPolicy(document(500, 40), "preview", true);
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.itemMetrics)).toBe(true);
    expect([0, 250, 499].map((index) => Math.min(policy.fileCount - 1, index)))
      .toEqual([0, 250, 499]);
  });
});

function document(fileCount: number, linesPerFile: number, content = "line") {
  return createKeydexDiffDocument({
    id: `document-${fileCount}-${linesPerFile}-${content.length}`,
    source: "git",
    sourceVersion: "v1",
    files: Array.from({ length: fileCount }, (_, index) => createKeydexDiffFile({
      id: `file-${index}`,
      oldPath: `src/file-${index}.ts`,
      newPath: `src/file-${index}.ts`,
      status: "modified",
      patch: `@@ -1,${linesPerFile} +1,${linesPerFile} @@\n${Array.from({ length: linesPerFile }, () => ` ${content}`).join("\n")}\n`,
      hunks: [{
        id: `hunk-${index}`,
        header: `@@ -1,${linesPerFile} +1,${linesPerFile} @@`,
        oldStart: 1,
        oldLines: linesPerFile,
        newStart: 1,
        newLines: linesPerFile,
        lines: Array.from({ length: linesPerFile }, () => ` ${content}`),
      }],
      cacheKey: `file-${index}:v1`,
    })),
  });
}
