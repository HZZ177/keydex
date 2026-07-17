import { describe, expect, it } from "vitest";

import { normalizeContentOnlyAddedFile } from "@/renderer/components/diff/normalizers/contentOnly";
import { diffFixture } from "./fixtures/diffCatalog";

describe("content-only added file normalizer", () => {
  it("synthesizes the shared content-only fixture as a standard added-file patch", () => {
    const fixture = diffFixture("content-only-added");
    const document = normalizeContentOnlyAddedFile({
      path: String(fixture.payload.path),
      content: String(fixture.payload.content),
      operation: "add",
    });
    expect(document.files[0]).toEqual(
      expect.objectContaining({
        oldPath: null,
        newPath: "docs/new.md",
        status: "added",
        additions: fixture.expected.additions,
        deletions: 0,
        newContent: fixture.payload.content,
        selectableForPatch: false,
      }),
    );
    expect(document.files[0]?.patch).toContain("--- /dev/null\n+++ b/docs/new.md");
    expect(document.diagnostics.map(({ code }) => code)).toContain("content_synthesized");
  });

  it("keeps empty files distinct from malformed or missing inputs", () => {
    const document = normalizeContentOnlyAddedFile({
      path: "empty.txt",
      content: "",
      operation: "write",
    });
    expect(document.files).toHaveLength(1);
    expect(document.files[0]).toEqual(
      expect.objectContaining({ status: "added", additions: 0, newContent: "", hunks: [] }),
    );
    expect(document.diagnostics.map(({ code }) => code)).not.toContain("unparseable_patch");
  });

  it("normalizes CRLF for the patch while preserving the original copy source", () => {
    const document = normalizeContentOnlyAddedFile({
      path: "windows.txt",
      content: "one\r\ntwo\r\n",
      operation: "add",
    });
    expect(document.files[0]?.patch).toContain("+one\n+two\n");
    expect(document.files[0]?.patch).not.toContain("\r");
    expect(document.files[0]?.newContent).toBe("one\r\ntwo\r\n");
    expect(document.files[0]?.additions).toBe(2);
  });

  it("adds a no-newline marker for single and multi-line content without a trailing newline", () => {
    for (const content of ["one", "one\ntwo"]) {
      const document = normalizeContentOnlyAddedFile({ path: "note.txt", content, operation: "add" });
      expect(document.files[0]?.patch).toContain("\\ No newline at end of file");
      expect(document.diagnostics.map(({ code }) => code)).toContain("no_newline");
    }
  });

  it("generates a deterministic large patch without dropping lines", () => {
    const content = Array.from({ length: 20_000 }, (_, index) => `line ${index + 1}`).join("\n");
    const first = normalizeContentOnlyAddedFile({ path: "large.txt", content, operation: "add" });
    const second = normalizeContentOnlyAddedFile({ path: "large.txt", content, operation: "add" });
    expect(first.files[0]?.additions).toBe(20_000);
    expect(first.files[0]?.patch).toBe(second.files[0]?.patch);
    expect(first.files[0]?.cacheKey).toBe(second.files[0]?.cacheKey);
  });
});
