import { describe, expect, it } from "vitest";

import { normalizeUnifiedPatch } from "@/renderer/components/diff/normalizers/unifiedPatch";
import { diffFixture, materializeDiffFixturePatch } from "./fixtures/diffCatalog";

describe("Diff file status and path normalization", () => {
  it("represents rename-only and rename-with-edit without inventing stats", () => {
    const renameOnly = normalizeUnifiedPatch(
      "diff --git a/old.txt b/new.txt\nsimilarity index 100%\nrename from old.txt\nrename to new.txt\n",
    );
    expect(renameOnly.files[0]).toEqual(
      expect.objectContaining({
        status: "renamed",
        oldPath: "old.txt",
        newPath: "new.txt",
        displayPath: "new.txt",
        additions: 0,
        deletions: 0,
        hunks: [],
      }),
    );

    const edited = normalizeUnifiedPatch(materializeDiffFixturePatch(diffFixture("rename-with-edit")));
    expect(edited.files[0]).toEqual(
      expect.objectContaining({
        status: "renamed",
        oldPath: "src/old name.ts",
        newPath: "src/new name.ts",
        additions: 1,
        deletions: 1,
      }),
    );
  });

  it("represents copy metadata independently from rename", () => {
    const document = normalizeUnifiedPatch(
      "diff --git a/source.txt b/copy.txt\nsimilarity index 100%\ncopy from source.txt\ncopy to copy.txt\n",
    );
    expect(document.files[0]).toEqual(
      expect.objectContaining({
        status: "copied",
        oldPath: "source.txt",
        newPath: "copy.txt",
        additions: 0,
        deletions: 0,
      }),
    );
  });

  it("preserves mode-only metadata as a type change with zero hunks", () => {
    const document = normalizeUnifiedPatch(materializeDiffFixturePatch(diffFixture("mode-only")));
    expect(document.files[0]).toEqual(
      expect.objectContaining({
        status: "type_changed",
        oldMode: "100644",
        newMode: "100755",
        additions: 0,
        deletions: 0,
        hunks: [],
      }),
    );
  });

  it("keeps an empty deletion distinct from an empty or malformed document", () => {
    const document = normalizeUnifiedPatch(
      "diff --git a/empty.txt b/empty.txt\ndeleted file mode 100644\n--- a/empty.txt\n+++ /dev/null\n",
    );
    expect(document.files).toHaveLength(1);
    expect(document.files[0]).toEqual(
      expect.objectContaining({
        status: "deleted",
        oldPath: "empty.txt",
        newPath: null,
        oldMode: "100644",
        additions: 0,
        deletions: 0,
      }),
    );
  });

  it("uses authoritative rename headers for quoted paths", () => {
    const document = normalizeUnifiedPatch(
      'diff --git "a/old name.txt" "b/new name.txt"\nrename from "old name.txt"\nrename to "new name.txt"\n',
    );
    expect(document.files[0]).toEqual(
      expect.objectContaining({ oldPath: "old name.txt", newPath: "new name.txt" }),
    );
  });
});
