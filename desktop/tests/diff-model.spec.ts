import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createKeydexDiffDocument,
  createKeydexDiffFile,
  KeydexDiffModelError,
  type KeydexDiffFileInput,
  type KeydexDiffSource,
} from "@/renderer/components/diff/model";

function file(overrides: Partial<KeydexDiffFileInput> = {}) {
  return createKeydexDiffFile({
    id: "file:src/example.ts",
    cacheKey: "cache:example:v1",
    oldPath: "src\\example.ts",
    newPath: "src/example.ts",
    status: "modified",
    patch: "@@ -1 +1 @@\n-old\n+new",
    oldContent: "old",
    newContent: "new",
    additions: 1,
    deletions: 1,
    ...overrides,
  });
}

describe("Keydex Diff domain model", () => {
  it("represents paths, content, modes, hunks, stats and version without Pierre types", () => {
    const changed = file({
      status: "renamed",
      oldPath: "src/old.ts",
      newPath: "src/new.ts",
      oldMode: "100644",
      newMode: "100755",
      hunks: [
        {
          id: "hunk:1",
          header: "@@ -1 +1 @@",
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: ["-old", "+new"],
        },
      ],
    });
    const document = createKeydexDiffDocument({
      id: "document:git:v42",
      source: "git",
      sourceVersion: "42",
      files: [changed],
      diagnostics: [
        {
          id: "diagnostic:1",
          severity: "info",
          code: "renamed",
          message: "文件已重命名",
          fileId: changed.id,
          details: { similarity: 100 },
        },
      ],
    });

    expect(document.files[0]).toEqual(
      expect.objectContaining({
        oldPath: "src/old.ts",
        newPath: "src/new.ts",
        displayPath: "src/new.ts",
        oldMode: "100644",
        newMode: "100755",
        additions: 1,
        deletions: 1,
      }),
    );
    expect(Object.isFrozen(document)).toBe(true);
    expect(Object.isFrozen(document.files)).toBe(true);
    expect(Object.isFrozen(document.files[0]?.hunks)).toBe(true);
    expect(Object.isFrozen(document.diagnostics[0]?.details)).toBe(true);
    expect(JSON.parse(JSON.stringify(document))).toEqual(document);
  });

  it("supports empty, single and multi-file documents from every source", () => {
    const sources: KeydexDiffSource[] = ["git", "agent", "reverse", "preview", "patch_exchange"];
    for (const source of sources) {
      const document = createKeydexDiffDocument({
        id: `document:${source}`,
        source,
        sourceVersion: "v1",
        files: source === "preview" ? [] : [file({ id: `file:${source}`, cacheKey: `cache:${source}` })],
      });
      expect(document.source).toBe(source);
      expect(document.files.length).toBe(source === "preview" ? 0 : 1);
    }

    const multi = createKeydexDiffDocument({
      id: "document:multi",
      source: "agent",
      sourceVersion: "event:3",
      files: [
        file(),
        file({
          id: "file:deleted",
          cacheKey: "cache:deleted",
          status: "deleted",
          oldPath: "src/deleted.ts",
          newPath: null,
          oldContent: "old",
          newContent: undefined,
        }),
      ],
    });
    expect(multi.files.map(({ displayPath }) => displayPath)).toEqual([
      "src/example.ts",
      "src/deleted.ts",
    ]);
  });

  it("rejects invalid path, stats, binary content and duplicate identity combinations", () => {
    expect(() => file({ oldPath: null, newPath: null })).toThrow(KeydexDiffModelError);
    expect(() => file({ status: "added", newPath: null })).toThrow("added files require newPath");
    expect(() => file({ status: "renamed", oldPath: null })).toThrow(
      "renamed files require oldPath and newPath",
    );
    expect(() => file({ additions: -1 })).toThrow("additions must be a non-negative integer");
    expect(() => file({ binary: true })).toThrow("binary files cannot carry text content");

    const duplicate = file();
    expect(() =>
      createKeydexDiffDocument({
        id: "document:duplicates",
        source: "preview",
        sourceVersion: "v1",
        files: [duplicate, duplicate],
      }),
    ).toThrow("duplicate file id");
  });

  it("keeps the domain layer independent from @pierre/diffs", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/renderer/components/diff/model.ts"),
      "utf8",
    );
    expect(source).not.toContain("@pierre/diffs");
  });
});
