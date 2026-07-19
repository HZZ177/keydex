import { describe, expect, it } from "vitest";

import { resolveAlignedDiffCapability } from "@/renderer/components/diff/aligned/alignedDiffCapability";
import { normalizeUnifiedPatch } from "@/renderer/components/diff/normalizers/unifiedPatch";
import { KEYDEX_DIFF_PROFILES } from "@/renderer/components/diff/profiles";
import type { KeydexDiffFile } from "@/renderer/components/diff/model";

const document = normalizeUnifiedPatch(
  "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
  { source: "git", sourceVersion: "v1" },
);
const base = document.files[0]!;

describe("aligned split capability decision", () => {
  it("enables the worker-backed aligned renderer for supported text", () => {
    expect(decide(base)).toMatchObject({
      renderer: "aligned",
      reason: "available",
      connector: true,
      syncScroll: true,
      allowPatchSelection: true,
    });
  });

  it.each([
    ["binary", { binary: true, contentKind: "binary" }],
    ["unsupported_encoding", { contentKind: "unknown_encoding" }],
    ["truncated", {
      truncated: true,
      selectableForPatch: false,
      truncation: {
        state: "unrecoverable",
        reason: "producer_limit",
        canLoadMore: false,
        continuationToken: null,
        loadedBytes: 10,
        totalBytes: 20,
        loadedLines: 1,
        totalLines: 2,
      },
    }],
  ] as const)("falls back to readable stacked content for %s input", (reason, overrides) => {
    expect(decide({ ...base, ...overrides } as KeydexDiffFile)).toMatchObject({
      renderer: "stacked",
      reason,
      connector: false,
      syncScroll: false,
      allowPatchSelection: false,
    });
  });

  it("falls back when the worker is unavailable or the responsive line budget is exceeded", () => {
    expect(decide(base, false)).toMatchObject({ renderer: "stacked", reason: "worker_unavailable" });
    const oversized = {
      ...base,
      hunks: [{ ...base.hunks[0]!, lines: Array.from({ length: 100_001 }, () => " context") }],
    } as KeydexDiffFile;
    expect(decide(oversized)).toMatchObject({ renderer: "stacked", reason: "responsive_limit" });
  });

  it("keeps approximate text readable but never upgrades its write precision", () => {
    expect(decide({ ...base, precision: "approximate", selectableForPatch: false })).toMatchObject({
      renderer: "aligned",
      reason: "available",
      allowPatchSelection: false,
    });
  });

  it("keeps compact surfaces outside the aligned engine", () => {
    expect(resolveAlignedDiffCapability(base, KEYDEX_DIFF_PROFILES.compact, true)).toMatchObject({
      renderer: "stacked",
      reason: "profile_disabled",
    });
  });
});

function decide(file: KeydexDiffFile, workerAvailable = true) {
  return resolveAlignedDiffCapability(file, KEYDEX_DIFF_PROFILES.git, workerAvailable);
}
