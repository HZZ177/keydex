import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { normalizeDiffSafely } from "@/renderer/components/diff/diagnostics";
import { createKeydexDiffFile, type KeydexDiffDocument, type KeydexDiffSource } from "@/renderer/components/diff/model";
import { normalizeApplyPatch } from "@/renderer/components/diff/normalizers/applyPatch";
import { normalizeContentOnlyAddedFile } from "@/renderer/components/diff/normalizers/contentOnly";
import { normalizeUnifiedPatch } from "@/renderer/components/diff/normalizers/unifiedPatch";
import {
  loadDiffFixtureCatalog,
  materializeDiffFixturePatch,
  type DiffFixture,
} from "./fixtures/diffCatalog";

interface BackendProducerCase {
  id: string;
  source: KeydexDiffSource;
  patch_format: "canonical_unified" | "relaxed_apply_patch" | "content_only";
  path: string;
  raw_patch?: string;
  content?: string;
  patch_direction?: "current_to_target";
  expected: {
    status: string;
    precision: string;
    selectable: boolean;
    additions: number;
    deletions: number;
    old_trailing_newline: boolean | null;
    new_trailing_newline: boolean | null;
  };
}

function backendProducerCases(): BackendProducerCase[] {
  const catalog = JSON.parse(
    readFileSync(resolve(process.cwd(), "../test-fixtures/diff/backend-producers.json"), "utf8"),
  ) as { schema_version: number; cases: BackendProducerCase[] };
  expect(catalog.schema_version).toBe(1);
  return catalog.cases;
}

function normalizeBackendCase(entry: BackendProducerCase): KeydexDiffDocument {
  const options = {
    source: entry.source,
    sourceVersion: `golden:${entry.id}`,
    scopeFingerprint: `golden:${entry.id}`,
  } as const;
  if (entry.patch_format === "relaxed_apply_patch") {
    return normalizeApplyPatch(entry.raw_patch ?? "", options);
  }
  if (entry.patch_format === "content_only") {
    return normalizeContentOnlyAddedFile(
      { path: entry.path, content: entry.content ?? "", operation: "add" },
      options,
    );
  }
  return normalizeUnifiedPatch(entry.raw_patch ?? "", options);
}

function normalizeCatalogFixture(fixture: DiffFixture): KeydexDiffDocument {
  if (fixture.format === "apply_patch") {
    return normalizeApplyPatch(materializeDiffFixturePatch(fixture));
  }
  if (fixture.format === "content_only") {
    return normalizeContentOnlyAddedFile({
      path: String(fixture.payload.path),
      content: String(fixture.payload.content),
      operation: "add",
    });
  }
  return normalizeUnifiedPatch(materializeDiffFixturePatch(fixture), {
    source: fixture.format === "git_file" ? "git" : "preview",
    truncated: fixture.payload.truncated === true,
    contentKind: fixture.payload.binary === true ? "binary" : undefined,
    selectableForPatch: fixture.payload.binary !== true && fixture.payload.truncated !== true,
  });
}

describe("canonical Diff normalization matrix", () => {
  it("normalizes cross-language backend producer goldens without losing wire semantics", () => {
    for (const entry of backendProducerCases()) {
      const document = normalizeBackendCase(entry);
      const file = document.files[0];
      expect(file, entry.id).toBeDefined();
      expect({
        source: document.source,
        path: file?.displayPath,
        status: file?.status,
        precision: file?.precision,
        selectable: file?.selectableForPatch,
        additions: file?.additions,
        deletions: file?.deletions,
        oldTrailingNewline: file?.oldHasTrailingNewline,
        newTrailingNewline: file?.newHasTrailingNewline,
      }, entry.id).toEqual({
        source: entry.source,
        path: entry.path,
        status: entry.expected.status,
        precision: entry.expected.precision,
        selectable: entry.expected.selectable,
        additions: entry.expected.additions,
        deletions: entry.expected.deletions,
        oldTrailingNewline: entry.expected.old_trailing_newline,
        newTrailingNewline: entry.expected.new_trailing_newline,
      });
      expect(file?.patch, entry.id).toContain(entry.patch_format === "content_only" ? entry.path : "@@");
      expect(file?.cacheKey, entry.id).not.toContain(entry.path);
    }
  });

  it("normalizes every shared semantic fixture with explicit file, status and statistic results", () => {
    for (const fixture of loadDiffFixtureCatalog().fixtures) {
      const document = normalizeCatalogFixture(fixture);
      expect(document.files, fixture.id).toHaveLength(fixture.expected.file_count);
      expect(document.files.map(({ status }) => status), fixture.id).toEqual(fixture.expected.statuses);
      expect(document.files.reduce((sum, file) => sum + (file.additions ?? 0), 0), fixture.id)
        .toBe(fixture.expected.additions);
      expect(document.files.reduce((sum, file) => sum + (file.deletions ?? 0), 0), fixture.id)
        .toBe(fixture.expected.deletions);
      for (const code of fixture.expected.diagnostics) {
        if (code === "binary") {
          expect(document.files.some((file) => file.binary), fixture.id).toBe(true);
          continue;
        }
        if (code === "truncated") {
          expect(document.files.some((file) => file.truncated), fixture.id).toBe(true);
          continue;
        }
        if (code === "no_newline") {
          expect(
            document.files.some(
              (file) => file.oldHasTrailingNewline === false || file.newHasTrailingNewline === false,
            ),
            fixture.id,
          ).toBe(true);
          continue;
        }
        expect(document.diagnostics.map((diagnostic) => diagnostic.code), fixture.id).toContain(code);
      }
    }
  });

  it.each([
    ["", "empty"],
    ["plain text", "malformed"],
    ["diff --cc a.ts\n@@@ -1,1 -1,1 +1,1 @@@\n", "unsupported"],
    ["*** Begin Patch\n*** Update File: a.ts\n@@\n-a", "partial"],
  ])("returns a stable diagnostic for negative input %#", (raw, code) => {
    const result = normalizeDiffSafely(raw);
    expect(result.fallback).toBe("none");
    expect(result.document.files).toEqual([]);
    expect(result.document.diagnostics).toEqual([
      expect.objectContaining({ code, severity: code === "empty" ? "info" : "error" }),
    ]);
  });

  it("rejects an impossible approximate selectable file at the domain boundary", () => {
    expect(() => createKeydexDiffFile({
      id: "invalid",
      cacheKey: "invalid-cache",
      oldPath: "a.txt",
      newPath: "a.txt",
      status: "modified",
      patch: "--- a/a.txt\n+++ b/a.txt\n",
      precision: "approximate",
      selectableForPatch: true,
    })).toThrow(/patch selection requires exact/u);
  });
});
