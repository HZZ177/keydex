import { describe, expect, it } from "vitest";

import { normalizeNonTextPatch } from "@/renderer/components/diff/normalizers/nonText";
import { normalizeUnifiedPatch } from "@/renderer/components/diff/normalizers/unifiedPatch";
import { diffFixture, materializeDiffFixturePatch } from "./fixtures/diffCatalog";

describe("binary, submodule and non-text Diff normalization", () => {
  it("recognizes both Binary files and GIT binary patch markers", () => {
    const fixture = diffFixture("binary-file");
    const binary = normalizeUnifiedPatch(materializeDiffFixturePatch(fixture));
    expect(binary.files[0]).toEqual(
      expect.objectContaining({
        contentKind: "binary",
        binary: true,
        binaryReason: "binary_files_marker",
        selectableForPatch: false,
        additions: 0,
        deletions: 0,
      }),
    );
    const gitBinary = normalizeUnifiedPatch(
      "diff --git a/a.bin b/a.bin\n--- a/a.bin\n+++ b/a.bin\nGIT binary patch\nliteral 1\nAcmZQz\n",
    );
    expect(gitBinary.files[0]).toEqual(
      expect.objectContaining({ contentKind: "binary", binaryReason: "git_binary_patch" }),
    );
  });

  it("recognizes gitlink mode 160000 as a submodule without text rendering", () => {
    const document = normalizeUnifiedPatch(
      "diff --git a/vendor/lib b/vendor/lib\nindex 1111111..2222222 160000\n--- a/vendor/lib\n+++ b/vendor/lib\n@@ -1 +1 @@\n-Subproject commit 1111111\n+Subproject commit 2222222\n",
    );
    // Git may communicate gitlink mode in the index header without old/new mode lines.
    const explicit = normalizeUnifiedPatch(
      "diff --git a/vendor/lib b/vendor/lib\nold mode 160000\nnew mode 160000\n",
    );
    expect(document.files[0]?.contentKind).toBe("submodule");
    expect(explicit.files[0]).toEqual(
      expect.objectContaining({
        contentKind: "submodule",
        binary: false,
        binaryReason: "gitlink_mode_160000",
        selectableForPatch: false,
      }),
    );
  });

  it("supports an explicit unknown-encoding state with a Chinese diagnostic", () => {
    const patch = "diff --git a/data.dat b/data.dat\n--- a/data.dat\n+++ b/data.dat\n";
    const document = normalizeNonTextPatch(patch, "unknown_encoding", {
      reason: "decode_failed",
    });
    expect(document.files[0]).toEqual(
      expect.objectContaining({
        contentKind: "unknown_encoding",
        binary: false,
        binaryReason: "decode_failed",
        selectableForPatch: false,
      }),
    );
    expect(document.diagnostics[0]?.message).toContain("编码");
  });

  it("keeps Git LFS pointer files as readable text", () => {
    const document = normalizeUnifiedPatch(
      "diff --git a/model.bin b/model.bin\n--- a/model.bin\n+++ b/model.bin\n@@ -0,0 +1,3 @@\n+version https://git-lfs.github.com/spec/v1\n+oid sha256:abc\n+size 10\n",
    );
    expect(document.files[0]).toEqual(
      expect.objectContaining({ contentKind: "text", binary: false, lfsPointer: true }),
    );
  });
});
