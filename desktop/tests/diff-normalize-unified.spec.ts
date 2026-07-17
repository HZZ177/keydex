import { describe, expect, it } from "vitest";

import { normalizeUnifiedPatch } from "@/renderer/components/diff/normalizers/unifiedPatch";
import { diffFixture, materializeDiffFixturePatch } from "./fixtures/diffCatalog";

describe("standard unified patch normalizer", () => {
  it("preserves paths, raw patch, hunk coordinates, lines and stats", () => {
    const fixture = diffFixture("standard-modified");
    const patch = materializeDiffFixturePatch(fixture);
    const document = normalizeUnifiedPatch(patch, {
      source: "preview",
      workspaceId: "workspace-1",
      sourceVersion: "revision-1",
    });

    expect(document.diagnostics).toEqual([]);
    expect(document.files).toHaveLength(1);
    expect(document.files[0]).toEqual(
      expect.objectContaining({
        oldPath: "src/example.ts",
        newPath: "src/example.ts",
        status: "modified",
        patch,
        additions: fixture.expected.additions,
        deletions: fixture.expected.deletions,
      }),
    );
    expect(document.files[0]?.hunks[0]).toEqual(
      expect.objectContaining({
        header: "@@ -1,2 +1,2 @@",
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 2,
        lines: ["-const value = 1;", "+const value = 2;", " export default value;"],
      }),
    );
  });

  it("supports ---/+++ input without diff or index headers", () => {
    const patch = "--- a/readme.txt\n+++ b/readme.txt\n@@ -4 +4 @@\n-old\n+new\n";
    const document = normalizeUnifiedPatch(patch);
    expect(document.files[0]).toEqual(
      expect.objectContaining({ oldPath: "readme.txt", newPath: "readme.txt" }),
    );
    expect(document.files[0]?.hunks[0]).toEqual(
      expect.objectContaining({ oldStart: 4, oldLines: 1, newStart: 4, newLines: 1 }),
    );
  });

  it("supports zero and multiple hunk inputs", () => {
    const zero = normalizeUnifiedPatch(
      "diff --git a/scripts/run.sh b/scripts/run.sh\n--- a/scripts/run.sh\n+++ b/scripts/run.sh\n",
    );
    expect(zero.files[0]?.hunks).toEqual([]);
    expect(zero.files[0]?.additions).toBe(0);

    const multiple = normalizeUnifiedPatch(
      "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+A\n@@ -10,2 +10,3 @@\n x\n-y\n+Y\n+z\n",
    );
    expect(multiple.files[0]?.hunks).toHaveLength(2);
    expect(multiple.files[0]).toEqual(expect.objectContaining({ additions: 3, deletions: 2 }));
  });

  it("returns diagnostics rather than throwing malformed input into the page", () => {
    expect(() => normalizeUnifiedPatch("not a patch")).not.toThrow();
    const missingPath = normalizeUnifiedPatch("not a patch");
    expect(missingPath.files).toEqual([]);
    expect(missingPath.diagnostics.map(({ code }) => code)).toContain("unparseable_patch");

    const malformedHunk = normalizeUnifiedPatch(
      "--- a/a.txt\n+++ b/a.txt\n@@ invalid @@\n-old\n+new",
    );
    expect(malformedHunk.diagnostics.map(({ code }) => code)).toContain("malformed_hunk");
  });
});
