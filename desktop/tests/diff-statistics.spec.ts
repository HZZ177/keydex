import { describe, expect, it } from "vitest";

import { normalizeUnifiedPatch } from "@/renderer/components/diff/normalizers/unifiedPatch";
import { reconcileDiffStatistics, summarizeDiffStatistics } from "@/renderer/components/diff/statistics";

const patch = [
  "diff --git a/a.ts b/a.ts",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -1,2 +1,3 @@",
  "-old",
  "+new",
  "+next",
  " context",
  "",
].join("\n");

describe("diff statistic reconciliation", () => {
  it("uses parsed statistics when the producer omits them and ignores metadata lines", () => {
    const document = normalizeUnifiedPatch(patch, { source: "git", sourceVersion: "v1" });
    expect(document.files[0]).toMatchObject({ additions: 2, deletions: 1 });
    expect(reconcileDiffStatistics(document, []).summary).toEqual({
      additions: 2,
      deletions: 1,
      filesWithUnknownStatistics: 0,
    });
  });

  it("preserves trusted producer statistics and records mismatch diagnostics", () => {
    const document = normalizeUnifiedPatch(patch, { source: "git", sourceVersion: "v1" });
    const result = reconcileDiffStatistics(document, [{ path: "a.ts", additions: 8, deletions: 3 }]);
    expect(result.document.files[0]).toMatchObject({ additions: 8, deletions: 3 });
    expect(result.document.diagnostics.filter((item) => item.code === "producer_stat_mismatch")).toHaveLength(2);
  });

  it("keeps binary null statistics instead of inventing zero", () => {
    const document = normalizeUnifiedPatch(
      "diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n",
      { source: "git", sourceVersion: "v1" },
    );
    const result = reconcileDiffStatistics(document, [{ path: "logo.png", additions: null, deletions: null }]);
    expect(result.document.files[0]).toMatchObject({ additions: null, deletions: null, binary: true });
    expect(result.summary).toEqual({ additions: null, deletions: null, filesWithUnknownStatistics: 1 });
  });

  it.each([
    ["renamed", "diff --git a/old.ts b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to new.ts\n"],
    ["type_changed", "diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n"],
  ])("keeps zero line counts for %s metadata-only changes", (_status, input) => {
    const file = normalizeUnifiedPatch(input, { source: "git", sourceVersion: "v1" }).files[0];
    expect(file).toMatchObject({ additions: 0, deletions: 0 });
  });

  it("falls back to parsed values and diagnoses invalid producer values", () => {
    const document = normalizeUnifiedPatch(patch, { source: "git", sourceVersion: "v1" });
    const result = reconcileDiffStatistics(document, [{ path: "a.ts", additions: -1 }]);
    expect(result.document.files[0]?.additions).toBe(2);
    expect(result.document.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "invalid_producer_stat" })]),
    );
  });

  it("returns an unknown aggregate when any file has unknown statistics", () => {
    const text = normalizeUnifiedPatch(patch, { source: "git", sourceVersion: "v1" }).files[0]!;
    const binary = reconcileDiffStatistics(
      normalizeUnifiedPatch(
        "diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n",
        { source: "git", sourceVersion: "v2" },
      ),
      [{ path: "logo.png", additions: null, deletions: null }],
    ).document.files[0]!;
    expect(summarizeDiffStatistics([text, binary])).toEqual({
      additions: null,
      deletions: null,
      filesWithUnknownStatistics: 1,
    });
  });
});
