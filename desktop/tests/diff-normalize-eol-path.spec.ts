import { describe, expect, it } from "vitest";

import { normalizeUnifiedPatch } from "@/renderer/components/diff/normalizers/unifiedPatch";
import { diffFixture, materializeDiffFixturePatch } from "./fixtures/diffCatalog";

describe("Diff EOL, no-newline and path normalization", () => {
  it("normalizes CRLF for parsing while retaining the original patch and EOL metadata", () => {
    const patch = materializeDiffFixturePatch(diffFixture("crlf-lines"));
    const document = normalizeUnifiedPatch(patch);
    expect(document.files[0]).toEqual(
      expect.objectContaining({ patch, patchEol: "crlf", additions: 1, deletions: 1 }),
    );
    expect(document.files[0]?.hunks[0]?.lines).toEqual(["-old", "+new"]);
    expect(document.files[0]?.cacheKey).toBe(
      normalizeUnifiedPatch(patch.replace(/\r\n/gu, "\n")).files[0]?.cacheKey,
    );
  });

  it("preserves no-newline markers as metadata without counting them as changes", () => {
    const document = normalizeUnifiedPatch(
      materializeDiffFixturePatch(diffFixture("no-newline-marker")),
    );
    expect(document.files[0]).toEqual(
      expect.objectContaining({
        additions: 1,
        deletions: 1,
        oldHasTrailingNewline: false,
        newHasTrailingNewline: false,
      }),
    );
    expect(document.files[0]?.hunks[0]?.lines.filter((line) => line.startsWith("\\"))).toHaveLength(2);
  });

  it("supports readable Unicode, emoji, spaces and quoted paths", () => {
    const unicode = normalizeUnifiedPatch(
      materializeDiffFixturePatch(diffFixture("unicode-path")),
    );
    expect(unicode.files[0]?.displayPath).toBe("文档/说明.md");

    const quoted = normalizeUnifiedPatch(
      'diff --git "a/emoji 😀 and \\"quote\\".txt" "b/emoji 😀 and \\"quote\\".txt"\n' +
        '--- "a/emoji 😀 and \\"quote\\".txt"\n' +
        '+++ "b/emoji 😀 and \\"quote\\".txt"\n' +
        "@@ -1 +1 @@\n-old\n+new\n",
    );
    expect(quoted.files[0]?.displayPath).toBe('emoji 😀 and "quote".txt');
  });

  it("decodes Git octal UTF-8 quoted paths", () => {
    const encoded = "\\346\\226\\207\\346\\241\\243/\\350\\257\\264\\346\\230\\216.md";
    const patch =
      `diff --git "a/${encoded}" "b/${encoded}"\n` +
      `--- "a/${encoded}"\n` +
      `+++ "b/${encoded}"\n` +
      "@@ -1 +1 @@\n-old\n+new\n";
    expect(normalizeUnifiedPatch(patch).files[0]?.displayPath).toBe("文档/说明.md");
  });

  it("uses slash-normalized display paths but retains operation paths and accepts a BOM", () => {
    const patch =
      "\uFEFFdiff --git a/src\\folder\\file.ts b/src\\folder\\file.ts\n" +
      "--- a/src\\folder\\file.ts\n" +
      "+++ b/src\\folder\\file.ts\n" +
      "@@ -1 +1 @@\n-old\n+new\n";
    const file = normalizeUnifiedPatch(patch).files[0];
    expect(file?.displayPath).toBe("src/folder/file.ts");
    expect(file?.oldOperationPath).toBe("src\\folder\\file.ts");
    expect(file?.newOperationPath).toBe("src\\folder\\file.ts");
  });

  it("trusts backend diff paths instead of enforcing workspace scope in the renderer", () => {
    const absolutePath = "D:/Pycharm Projects/kt-pm-platform/ktagent/test.md";
    const absolute = normalizeUnifiedPatch(
      `--- a/${absolutePath}\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-one\n-two\n`,
    );
    const parentRelative = normalizeUnifiedPatch(
      "--- a/../shared/note.md\n+++ b/../shared/note.md\n@@ -1 +1 @@\n-old\n+new\n",
    );

    expect(absolute.diagnostics).toEqual([]);
    expect(absolute.files[0]).toEqual(expect.objectContaining({
      oldPath: absolutePath,
      newPath: null,
      status: "deleted",
      deletions: 2,
    }));
    expect(parentRelative.diagnostics).toEqual([]);
    expect(parentRelative.files[0]).toEqual(expect.objectContaining({
      oldPath: "../shared/note.md",
      newPath: "../shared/note.md",
    }));
  });
});
