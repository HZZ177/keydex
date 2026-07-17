import { describe, expect, it } from "vitest";

import {
  normalizeApplyPatch,
  parseApplyPatchBlocks,
} from "@/renderer/components/diff/normalizers/applyPatch";
import { diffFixture, materializeDiffFixturePatch } from "./fixtures/diffCatalog";

describe("legacy Apply Patch normalizer", () => {
  it("converts a bare @@ update into an approximate non-selectable document", () => {
    const fixture = diffFixture("relaxed-apply-patch");
    const document = normalizeApplyPatch(materializeDiffFixturePatch(fixture));
    expect(document.files).toHaveLength(1);
    expect(document.files[0]).toEqual(
      expect.objectContaining({
        displayPath: "src/app.py",
        status: "modified",
        additions: 1,
        deletions: 1,
        precision: "approximate",
        selectableForPatch: false,
      }),
    );
    expect(document.files[0]?.patch).toContain("@@ -1,1 +1,1 @@");
    expect(document.diagnostics.map(({ code }) => code)).toContain("approximate_hunk");
  });

  it("supports Add, Update, Delete and Move blocks in one envelope", () => {
    const input = [
      "*** Begin Patch",
      "*** Add File: docs/new.md",
      "+one",
      "+two",
      "*** Update File: docs/old.md",
      "*** Move to: docs/moved.md",
      "@@",
      "-old",
      "+new",
      "*** Delete File: docs/deleted.md",
      "*** End Patch",
    ].join("\n");
    const document = normalizeApplyPatch(input);
    expect(document.files.map(({ status, oldPath, newPath }) => ({ status, oldPath, newPath }))).toEqual([
      { status: "added", oldPath: null, newPath: "docs/new.md" },
      { status: "renamed", oldPath: "docs/old.md", newPath: "docs/moved.md" },
      { status: "deleted", oldPath: "docs/deleted.md", newPath: null },
    ]);
    expect(document.files.every(({ selectableForPatch }) => !selectableForPatch)).toBe(true);
  });

  it("keeps multiple relaxed hunks separate with deterministic approximate coordinates", () => {
    const document = normalizeApplyPatch(
      "*** Begin Patch\n*** Update File: a.txt\n@@\n-a\n+A\n@@ section\n b\n-c\n+C\n*** End Patch",
    );
    expect(document.files[0]?.hunks).toHaveLength(2);
    expect(document.files[0]?.hunks.map(({ oldStart, newStart }) => [oldStart, newStart])).toEqual([
      [1, 1],
      [2, 2],
    ]);
  });

  it("renders partial streaming and mixed line endings with an incomplete diagnostic", () => {
    const partial = "*** Begin Patch\r\n*** Update File: a.txt\n@@\r\n-old\n+new";
    expect(() => normalizeApplyPatch(partial)).not.toThrow();
    const document = normalizeApplyPatch(partial);
    expect(document.files[0]?.hunks[0]?.lines).toEqual(["-old", "+new"]);
    expect(document.diagnostics.map(({ code }) => code)).toContain("incomplete_apply_patch");
  });

  it("exposes parsed blocks for historical message adapters without retaining UI code", () => {
    const blocks = parseApplyPatchBlocks(
      "*** Begin Patch\n*** Add File: a.txt\n+one\n*** Delete File: b.txt\n*** End Patch",
    );
    expect(blocks).toEqual([
      { operation: "add", path: "a.txt", moveTo: null, lines: ["+one"] },
      { operation: "delete", path: "b.txt", moveTo: null, lines: [] },
    ]);
  });
});
