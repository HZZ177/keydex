import { describe, expect, it } from "vitest";

import {
  diffFixture,
  loadDiffFixtureCatalog,
  materializeDiffFixturePatch,
} from "./fixtures/diffCatalog";

describe("cross-source Diff fixture catalog", () => {
  it("covers every required semantic category with unique ids", () => {
    const catalog = loadDiffFixtureCatalog();
    const ids = catalog.fixtures.map(({ id }) => id);
    expect(catalog.schema_version).toBe(1);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      "standard-modified",
      "relaxed-apply-patch",
      "multi-file",
      "content-only-added",
      "rename-with-edit",
      "mode-only",
      "binary-file",
      "truncated-file",
      "unicode-path",
      "crlf-lines",
      "no-newline-marker",
      "large-generated",
      "unsafe-parent-path",
    ]);
  });

  it("keeps expected counts and diagnostics explicit", () => {
    for (const fixture of loadDiffFixtureCatalog().fixtures) {
      expect(fixture.expected.file_count).toBeGreaterThanOrEqual(0);
      expect(fixture.expected.statuses).toHaveLength(fixture.expected.file_count);
      expect(fixture.expected.additions).toBeGreaterThanOrEqual(0);
      expect(fixture.expected.deletions).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(fixture.expected.diagnostics)).toBe(true);
    }
  });

  it("generates the large patch deterministically without storing a 20k-line artifact", () => {
    const fixture = diffFixture("large-generated");
    const first = materializeDiffFixturePatch(fixture);
    const second = materializeDiffFixturePatch(fixture);
    expect(first).toBe(second);
    expect(first.split("\n").length).toBe(25_005);
    expect(first.match(/^\+after /gmu)).toHaveLength(5_000);
    expect(first.match(/^-before /gmu)).toHaveLength(5_000);
  });

  it("contains no user workspace path or credential-shaped test data", () => {
    const serialized = JSON.stringify(loadDiffFixtureCatalog());
    expect(serialized).not.toMatch(/C:\\\\Users|D:\\\\|password|api[_-]?key|token/iu);
  });
});
