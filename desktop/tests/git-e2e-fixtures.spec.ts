import { describe, expect, it } from "vitest";

import { assertFixturePath, resolveFixtureChild } from "../e2e/git-e2e-fixtures";

describe("Git Playwright fixture guards", () => {
  it("allows only disposable e2e-git run roots", () => {
    expect(() => assertFixturePath("D:/tmp/e2e-git-shell-123")).not.toThrow();
    expect(() => assertFixturePath("D:/tmp/keydex")).toThrow(/Refusing to clean/);
  });

  it("rejects repository path traversal", () => {
    expect(resolveFixtureChild("D:/tmp/repo", "src/file.ts")).toMatch(/src[\\/]file\.ts$/);
    expect(() => resolveFixtureChild("D:/tmp/repo", "../sentinel.txt")).toThrow(/escapes repository root/);
  });
});
