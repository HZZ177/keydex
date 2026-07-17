import { describe, expect, it } from "vitest";

import {
  normalizeUnifiedPatch,
  splitUnifiedPatch,
} from "@/renderer/components/diff/normalizers/unifiedPatch";
import { diffFixture, materializeDiffFixturePatch } from "./fixtures/diffCatalog";

function patchFor(path: string, before = "old", after = "new") {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1 +1 @@",
    `-${before}`,
    `+${after}`,
    "",
  ].join("\n");
}

describe("multi-file unified patch normalizer", () => {
  it("splits the shared multi-file fixture without leaking lines across files", () => {
    const fixture = diffFixture("multi-file");
    const patch = materializeDiffFixturePatch(fixture);
    const document = normalizeUnifiedPatch(patch, { source: "preview" });

    expect(document.files).toHaveLength(fixture.expected.file_count);
    expect(document.files.map(({ displayPath }) => displayPath)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(document.files.map(({ additions, deletions }) => [additions, deletions])).toEqual([
      [1, 1],
      [1, 0],
    ]);
    expect(document.files[0]?.patch).toContain("a/src/a.ts");
    expect(document.files[0]?.patch).not.toContain("b/src/b.ts");
    expect(document.files[1]?.patch).toContain("b/src/b.ts");
    expect(document.files.reduce((sum, file) => sum + (file.additions ?? 0), 0)).toBe(
      fixture.expected.additions,
    );
  });

  it("keeps deterministic input order for 50 files", () => {
    const paths = Array.from({ length: 50 }, (_, index) => `src/file-${String(index).padStart(2, "0")}.ts`);
    const document = normalizeUnifiedPatch(paths.map((path) => patchFor(path)).join(""));
    expect(document.files).toHaveLength(50);
    expect(document.files.map(({ displayPath }) => displayPath)).toEqual(paths);
  });

  it("separates a format-patch mail header and records an informational diagnostic", () => {
    const mailHeader = [
      "From abcdef Mon Sep 17 00:00:00 2001",
      "From: Example <example@example.test>",
      "Subject: [PATCH] update files",
      "",
      "---",
      " 2 files changed",
      "",
    ].join("\n");
    const document = normalizeUnifiedPatch(`${mailHeader}${patchFor("a.ts")}${patchFor("b.ts")}`);
    expect(document.files.map(({ displayPath }) => displayPath)).toEqual(["a.ts", "b.ts"]);
    expect(document.diagnostics.map(({ code }) => code)).toContain("format_patch_preamble");
    expect(document.files[0]?.patch.startsWith("diff --git")).toBe(true);
  });

  it("supports repeated paths and empty file sections with unique stable ids", () => {
    const repeated = `${patchFor("same.ts", "one", "two")}${patchFor("same.ts", "two", "three")}`;
    const document = normalizeUnifiedPatch(repeated);
    expect(document.files).toHaveLength(2);
    expect(new Set(document.files.map(({ id }) => id)).size).toBe(2);

    const emptySection = normalizeUnifiedPatch(
      `${patchFor("first.ts")}diff --git a/empty.txt b/empty.txt\n--- a/empty.txt\n+++ b/empty.txt\n`,
    );
    expect(emptySection.files[1]).toEqual(
      expect.objectContaining({ displayPath: "empty.txt", additions: 0, deletions: 0, hunks: [] }),
    );
  });

  it("recognizes repeated ---/+++ file pairs without splitting hunk content on --- alone", () => {
    const withoutGitHeaders = [
      "--- a/first.txt",
      "+++ b/first.txt",
      "@@ -1 +1 @@",
      "---literal deleted text",
      "+first",
      "--- a/second.txt",
      "+++ b/second.txt",
      "@@ -1 +1 @@",
      "-second",
      "+SECOND",
      "",
    ].join("\n");
    const split = splitUnifiedPatch(withoutGitHeaders);
    const document = normalizeUnifiedPatch(withoutGitHeaders);
    expect(split.sections).toHaveLength(2);
    expect(document.files.map(({ displayPath }) => displayPath)).toEqual(["first.txt", "second.txt"]);
    expect(document.files[0]?.hunks[0]?.lines).toContain("---literal deleted text");
  });
});
