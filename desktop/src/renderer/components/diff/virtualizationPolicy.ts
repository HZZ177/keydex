import type { VirtualFileMetrics } from "@pierre/diffs";
import type { CodeViewHandle } from "@pierre/diffs/react";

import type { KeydexDiffDocument } from "./model";
import type { KeydexDiffProfileName } from "./profiles";
import { keydexDiffTypography } from "./diffTypography";

export type KeydexDiffRenderStrategy = "single" | "code_view";
export type KeydexDiffVirtualizationLevel = "none" | "standard" | "aggressive";

export interface KeydexDiffVirtualizationPolicy {
  readonly strategy: KeydexDiffRenderStrategy;
  readonly level: KeydexDiffVirtualizationLevel;
  readonly virtualized: boolean;
  readonly reason: "single_small" | "multi_file" | "large_file_count" | "large_line_count" | "large_bytes";
  readonly fileCount: number;
  readonly lineCount: number;
  readonly bytes: number;
  readonly overscrollSize: number;
  readonly intersectionObserverMargin: number;
  readonly maxMountedItems: number;
  readonly itemMetrics: Readonly<Partial<VirtualFileMetrics>>;
}

export const KEYDEX_DIFF_VIRTUALIZATION_THRESHOLDS = Object.freeze({
  compact: Object.freeze({ files: 8, lines: 600, bytes: 256 * 1024 }),
  review: Object.freeze({ files: 12, lines: 1_000, bytes: 512 * 1024 }),
  git: Object.freeze({ files: 20, lines: 1_500, bytes: 768 * 1024 }),
  preview: Object.freeze({ files: 20, lines: 1_500, bytes: 768 * 1024 }),
} satisfies Record<KeydexDiffProfileName, { files: number; lines: number; bytes: number }>);

export interface KeydexAlignedVirtualizationPolicy {
  readonly enabled: boolean;
  readonly level: KeydexDiffVirtualizationLevel;
  readonly overscanPx: number;
  readonly maxMountedRows: number;
  readonly estimatedRowHeight: number;
}

export const KEYDEX_ALIGNED_VIRTUALIZATION_THRESHOLDS = Object.freeze({
  standardRows: 600,
  aggressiveRows: 20_000,
  standardOverscanPx: 480,
  aggressiveOverscanPx: 320,
  standardMaxMountedRows: 1_000,
  aggressiveMaxMountedRows: 800,
});

export function resolveKeydexAlignedVirtualizationPolicy(
  rowCount: number,
  profile: KeydexDiffProfileName,
  wrap: boolean,
): KeydexAlignedVirtualizationPolicy {
  if (!Number.isInteger(rowCount) || rowCount < 0) {
    throw new TypeError("rowCount must be a non-negative integer");
  }
  const typography = keydexDiffTypography(profile);
  const enabled = rowCount >= KEYDEX_ALIGNED_VIRTUALIZATION_THRESHOLDS.standardRows;
  const aggressive = rowCount >= KEYDEX_ALIGNED_VIRTUALIZATION_THRESHOLDS.aggressiveRows;
  return Object.freeze({
    enabled,
    level: !enabled ? "none" : aggressive ? "aggressive" : "standard",
    overscanPx: aggressive
      ? KEYDEX_ALIGNED_VIRTUALIZATION_THRESHOLDS.aggressiveOverscanPx
      : KEYDEX_ALIGNED_VIRTUALIZATION_THRESHOLDS.standardOverscanPx,
    maxMountedRows: aggressive
      ? KEYDEX_ALIGNED_VIRTUALIZATION_THRESHOLDS.aggressiveMaxMountedRows
      : KEYDEX_ALIGNED_VIRTUALIZATION_THRESHOLDS.standardMaxMountedRows,
    estimatedRowHeight: typography.lineHeight * (wrap ? 1.35 : 1),
  });
}

export function resolveKeydexDiffVirtualizationPolicy(
  document: KeydexDiffDocument,
  profile: KeydexDiffProfileName,
  wrap: boolean,
): KeydexDiffVirtualizationPolicy {
  const fileCount = document.files.length;
  const lineCount = document.files.reduce(
    (total, file) => total + file.hunks.reduce((count, hunk) => count + hunk.lines.length, 0),
    0,
  );
  const bytes = document.files.reduce((total, file) => total + utf8Bytes(file.patch), 0);
  const threshold = KEYDEX_DIFF_VIRTUALIZATION_THRESHOLDS[profile];
  const largeFileCount = fileCount >= threshold.files;
  const largeLineCount = lineCount >= threshold.lines;
  const largeBytes = bytes >= threshold.bytes;
  const aggressive = largeFileCount || largeLineCount || largeBytes;
  const strategy: KeydexDiffRenderStrategy = fileCount === 1 && !aggressive
    ? "single"
    : "code_view";
  const virtualized = strategy === "code_view";
  const reason = largeFileCount
    ? "large_file_count"
    : largeLineCount
      ? "large_line_count"
      : largeBytes
        ? "large_bytes"
        : fileCount > 1
          ? "multi_file"
          : "single_small";
  const typography = keydexDiffTypography(profile);
  const wrappedLineFactor = wrap ? 1.35 : 1;
  const itemMetrics = Object.freeze({
    hunkLineCount: typography.hunkLineCount,
    lineHeight: typography.lineHeight * wrappedLineFactor,
    diffHeaderHeight: typography.headerHeight,
    hunkSeparatorHeight: 30,
    spacing: typography.itemGap,
    paddingTop: 0,
    paddingBottom: typography.paddingBlock,
  });

  return Object.freeze({
    strategy,
    level: !virtualized ? "none" : aggressive ? "aggressive" : "standard",
    virtualized,
    reason,
    fileCount,
    lineCount,
    bytes,
    overscrollSize: aggressive ? 420 : 280,
    intersectionObserverMargin: aggressive ? 120 : 80,
    maxMountedItems: aggressive ? 48 : 32,
    itemMetrics,
  });
}

export function applyPierreCodeViewVirtualization(
  handle: Pick<CodeViewHandle<undefined>, "getInstance"> | null,
  policy: KeydexDiffVirtualizationPolicy,
  options: { readonly resizeDebugging?: boolean; readonly testEnvironment?: boolean } = {},
): boolean {
  const instance = handle?.getInstance();
  if (!instance) return false;
  instance.config.overscrollSize = policy.overscrollSize;
  instance.config.intersectionObserverMargin = policy.intersectionObserverMargin;
  instance.config.resizeDebugging = options.testEnvironment === true && options.resizeDebugging === true;
  return true;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
