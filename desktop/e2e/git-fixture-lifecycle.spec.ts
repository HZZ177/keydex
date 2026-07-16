import { expect, test } from "@playwright/test";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { startGitE2EFixture } from "./git-e2e-fixtures";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("real Git fixture owns a repository, local bare remote and isolated identity", async () => {
  const fixture = await startGitE2EFixture("fixture-lifecycle");
  try {
    expect(path.resolve(fixture.runDir).toLowerCase().startsWith(`${REPO_ROOT}${path.sep}`.toLowerCase())).toBe(false);
    expect((await fixture.git(["branch", "--show-current"])).stdout.trim()).toBe("main");
    expect((await fixture.git(["config", "user.email"])).stdout.trim()).toBe("keydex-git-e2e@example.invalid");
    expect((await fixture.git(["remote", "get-url", "origin"])).stdout.trim()).toBe(fixture.bareRemoteRoot);
    expect((await fixture.git(["rev-list", "--count", "HEAD"])).stdout.trim()).toBe("1");
    expect((await fixture.git(["ls-remote", "--heads", "origin", "main"])).stdout).toContain("refs/heads/main");
  } finally {
    await fixture.cleanup();
    await fixture.cleanup();
  }
});
