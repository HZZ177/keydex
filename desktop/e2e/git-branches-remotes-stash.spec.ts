import { expect, test, type Page } from "@playwright/test";
import { access } from "node:fs/promises";
import * as path from "node:path";

import { startGitE2EFixture } from "./git-e2e-fixtures";

test.describe.configure({ mode: "serial" });

test("stash, refs, remotes, fetch, push and update use a local bare remote", async ({ page }) => {
  test.setTimeout(90_000);
  const fixture = await startGitE2EFixture("branch-remote-stash");
  try {
    await fixture.write("README.md", "# Keydex E2E workspace\n\nstash this page change\n");
    await fixture.configurePage(page);
    await page.goto(`${fixture.appBaseUrl}/#/workbench/${fixture.workspaceId}`);
    await openGitToolWindow(page);

    await page.getByRole("tab", { name: "暂存区" }).click();
    await page.getByRole("textbox", { name: "Stash message" }).fill("e2e stash from page");
    await page.getByRole("button", { name: "Create stash" }).click();
    await expect(page.getByRole("option", { name: /e2e stash from page/ })).toBeVisible({ timeout: 10_000 });
    expect((await fixture.git(["stash", "list", "--format=%s"])).stdout).toContain("e2e stash from page");

    await page.getByRole("option", { name: /e2e stash from page/ }).click();
    page.on("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Drop…" }).click();
    await expect(page.getByRole("status")).toContainText("No stashes", { timeout: 10_000 });
    expect((await fixture.git(["stash", "list"])).stdout.trim()).toBe("");

    await page.reload();
    if (!(await page.getByRole("tablist", { name: "Git 面板视图" }).isVisible().catch(() => false))) await openGitToolWindow(page);
    await expect(page.getByRole("tablist", { name: "Git 面板视图" })).toBeVisible({ timeout: 10_000 });
    await page.getByRole("tab", { name: "分支" }).click();
    const branches = page.getByRole("region", { name: "Branch actions" });
    await branches.getByLabel("New branch from main").fill("feature/e2e");
    await branches.getByRole("button", { name: "Create", exact: true }).click();
    await expect.poll(async () => (await fixture.git(["branch", "--list", "feature/e2e"])).stdout.trim()).toContain("feature/e2e");
    await expect(page.getByRole("treeitem", { name: "● feature/e2e" })).toBeVisible({ timeout: 10_000 });
    await expect.poll(async () => (await fixture.git(["branch", "--show-current"])).stdout.trim()).toBe("feature/e2e");
    await expect(page.getByRole("button", { name: /Git：feature\/e2e/ })).toBeVisible({ timeout: 10_000 });

    const remoteManager = page.getByRole("region", { name: "Remote manager" });
    await remoteManager.getByRole("textbox", { name: "Remote name", exact: true }).fill("backup");
    await remoteManager.getByRole("textbox", { name: "Fetch URL", exact: true }).fill(fixture.bareRemoteRoot);
    await remoteManager.getByRole("button", { name: "Add" }).click();
    await expect.poll(async () => (await fixture.git(["remote"])).stdout).toContain("backup");
    await expect(remoteManager.getByRole("option", { name: /backup/ })).toBeVisible({ timeout: 10_000 });
    await remoteManager.getByRole("option", { name: /backup/ }).click();
    await remoteManager.getByRole("textbox", { name: "Rename remote" }).fill("backup-renamed");
    await remoteManager.getByRole("button", { name: "Rename" }).click();
    await expect.poll(async () => (await fixture.git(["remote"])).stdout).toContain("backup-renamed");

    const sync = page.getByRole("region", { name: "远程同步" });
    await sync.getByRole("combobox", { name: "Fetch remote" }).selectOption("origin");
    await sync.getByRole("button", { name: "Fetch" }).click();
    await expect(sync.getByRole("button", { name: "Fetch" })).toBeEnabled({ timeout: 10_000 });
    await page.getByRole("tab", { name: "操作" }).click();
    await expect(page.getByRole("region", { name: "Git 操作日志" })).toContainText("fetch", { timeout: 10_000 });
    await page.getByRole("tab", { name: "分支" }).click();

    await sync.getByRole("checkbox", { name: "Force with lease" }).check();
    await expect(sync).toContainText("Lease protects against stale remote state");
    await sync.getByRole("checkbox", { name: "Force with lease" }).uncheck();
    await sync.getByRole("combobox", { name: "Push remote" }).selectOption("origin");
    await expect(sync.getByRole("checkbox", { name: "Set upstream" })).toBeChecked();
    await sync.getByRole("button", { name: "Push", exact: true }).click();
    await expect(sync).toContainText("Push completed", { timeout: 15_000 });
    expect((await fixture.git(["ls-remote", "--heads", "origin", "feature/e2e"])).stdout).toContain("refs/heads/feature/e2e");
    expect((await fixture.git(["rev-parse", "--abbrev-ref", "@{upstream}"])).stdout.trim()).toBe("origin/feature/e2e");

    await sync.getByRole("button", { name: "Update", exact: true }).click();
    await expect(sync).toContainText("Already up to date", { timeout: 15_000 });

    await fixture.screenshot(page, "e2e-046-branch-remote-sync-stash");
  } finally {
    await fixture.cleanup();
  }
});

test("push previews outgoing and replaced commits, force-with-lease succeeds and rejects a stale lease", async ({ page }) => {
  test.setTimeout(150_000);
  const fixture = await startGitE2EFixture("push-preview-lease");
  try {
    await fixture.createBranch("feature/lease", true);
    await fixture.git(["push", "--set-upstream", "origin", "feature/lease"]);
    await fixture.git(["commit", "--allow-empty", "-m", "feat: outgoing one"]);
    await fixture.git(["commit", "--allow-empty", "-m", "feat: outgoing two"]);

    await fixture.configurePage(page);
    await page.goto(`${fixture.appBaseUrl}/#/workbench/${fixture.workspaceId}`);
    await openGitToolWindow(page);
    await page.getByRole("tab", { name: "分支" }).click();
    const sync = page.getByRole("region", { name: "远程同步" });
    const outgoing = page.getByRole("region", { name: "Outgoing commits" });
    await expect(outgoing).toContainText("feat: outgoing one", { timeout: 15_000 });
    await expect(outgoing).toContainText("feat: outgoing two");
    await expect(outgoing).toContainText("Commits to publish (2)");
    await sync.getByRole("button", { name: "Push", exact: true }).click();
    await expect(sync).toContainText("Push completed", { timeout: 20_000 });
    await expect.poll(async () => (await fixture.git(["rev-parse", "origin/feature/lease"])).stdout.trim())
      .toBe((await fixture.git(["rev-parse", "HEAD"])).stdout.trim());

    const peerRoot = path.join(fixture.runDir, "e2e-git-peer");
    await fixture.git(["clone", "--branch", "feature/lease", fixture.bareRemoteRoot, peerRoot], fixture.runDir);
    await fixture.git(["config", "user.name", "Keydex Git Peer"], peerRoot);
    await fixture.git(["config", "user.email", "keydex-git-peer@example.invalid"], peerRoot);
    await fixture.git(["commit", "--allow-empty", "-m", "peer: remote commit to replace"], peerRoot);
    await fixture.git(["push", "origin", "feature/lease"], peerRoot);
    await fixture.git(["fetch", "origin"]);
    await fixture.git(["commit", "--allow-empty", "-m", "local: replacement commit"]);

    await expect(page.getByRole("button", { name: /Git：feature\/lease/ })).toContainText("↑1", { timeout: 20_000 });
    await sync.getByRole("checkbox", { name: "Force with lease" }).check();
    const replaced = page.getByRole("region", { name: "Remote commits that will be replaced" });
    await expect(replaced).toContainText("peer: remote commit to replace", { timeout: 20_000 });
    page.on("dialog", (dialog) => dialog.accept());
    await sync.getByRole("button", { name: "Force Push with Lease" }).click();
    await expect(sync).toContainText("Push completed", { timeout: 20_000 });
    const successfulForceHead = (await fixture.git(["rev-parse", "HEAD"])).stdout.trim();
    await expect.poll(async () => (await fixture.git(["ls-remote", "origin", "refs/heads/feature/lease"])).stdout)
      .toContain(successfulForceHead);
    await expect(page.getByRole("button", { name: /Git：feature\/lease/ })).toBeVisible({ timeout: 20_000 });
    await expect.poll(
      async () => fileExists(path.join(fixture.repositoryRoot, ".git", "index.lock")),
      { timeout: 15_000 },
    ).toBe(false);

    await fixture.git(["commit", "--allow-empty", "-m", "local: stale lease candidate"]);
    await fixture.git(["fetch", "origin"], peerRoot);
    await fixture.git(["reset", "--hard", "origin/feature/lease"], peerRoot);
    await fixture.git(["commit", "--allow-empty", "-m", "peer: third party must survive"], peerRoot);
    await fixture.git(["push", "origin", "feature/lease"], peerRoot);
    const thirdPartyHead = (await fixture.git(["rev-parse", "HEAD"], peerRoot)).stdout.trim();

    await expect(page.getByRole("button", { name: /Git：feature\/lease/ })).toContainText("↑1", { timeout: 20_000 });
    await sync.getByRole("button", { name: "Force Push with Lease" }).click();
    await expect(page.getByTestId("git-tool-window")).toContainText(/stale info|rejected|Fetch\/Update/i, { timeout: 20_000 });
    await expect.poll(async () => (await fixture.git(["ls-remote", "origin", "refs/heads/feature/lease"])).stdout)
      .toContain(thirdPartyHead);
    await expect.poll(async () => fileExists(path.join(fixture.repositoryRoot, ".git", "index.lock"))).toBe(false);
    await fixture.screenshot(page, "e2e-044-045-push-preview-force-lease");
  } finally {
    await fixture.cleanup();
  }
});

test("dirty checkout, defensive local deletion and annotated tag remote lifecycle complete from the branch view", async ({ page }) => {
  test.setTimeout(120_000);
  const fixture = await startGitE2EFixture("branch-safety-tag");
  try {
    await fixture.createBranch("target/dirty");
    await fixture.createBranch("old/merged");
    await fixture.write("dirty.txt", "keep me in a stash\n");
    await fixture.configurePage(page);
    await page.goto(`${fixture.appBaseUrl}/#/workbench/${fixture.workspaceId}`);
    await openGitToolWindow(page);
    await page.getByRole("tab", { name: "分支" }).click();
    const branches = page.getByRole("region", { name: "Branch actions" });
    await page.getByRole("treeitem", { name: "target/dirty" }).click();
    await branches.getByRole("button", { name: "Checkout", exact: true }).click();
    const dirtyAlert = branches.getByRole("alert");
    await expect(dirtyAlert).toContainText("Working tree has local changes");
    await dirtyAlert.getByRole("button", { name: "Cancel" }).click();
    expect((await fixture.git(["branch", "--show-current"])).stdout.trim()).toBe("main");
    expect((await fixture.git(["status", "--porcelain"])).stdout).toContain("dirty.txt");

    await branches.getByRole("button", { name: "Checkout", exact: true }).click();
    await dirtyAlert.getByRole("button", { name: "Stash and checkout" }).click();
    await expect.poll(async () => (await fixture.git(["branch", "--show-current"])).stdout.trim(), { timeout: 20_000 })
      .toBe("target/dirty");
    expect((await fixture.git(["stash", "list", "--format=%s"])).stdout).toContain("Keydex stash before checkout target/dirty");

    await page.reload();
    await expect(page.getByRole("button", { name: /Git：target\/dirty/ })).toBeEnabled({ timeout: 20_000 });
    if (!(await page.getByRole("tablist", { name: "Git 面板视图" }).isVisible().catch(() => false))) {
      await openGitToolWindow(page);
    }
    await page.getByRole("tab", { name: "分支" }).click();

    page.on("dialog", (dialog) => dialog.accept());
    await page.getByRole("treeitem", { name: "old/merged" }).click();
    await expect(branches).toContainText("Delete old/merged");
    await branches.getByRole("button", { name: "Delete…", exact: true }).click();
    await expect.poll(async () => (await fixture.git(["branch", "--list", "old/merged"])).stdout.trim(), { timeout: 20_000 })
      .toBe("");

    await page.getByRole("treeitem", { name: "● target/dirty" }).click();
    await branches.getByRole("textbox", { name: "Tag name" }).fill("v1.0.0-e2e");
    await branches.getByRole("checkbox", { name: "Annotated" }).check();
    await branches.getByRole("textbox", { name: "Tag message" }).fill("Keydex E2E annotated release");
    await branches.getByRole("button", { name: "Create tag" }).click();
    const tagRef = page.getByRole("treeitem", { name: "v1.0.0-e2e" });
    await expect(tagRef).toBeVisible({ timeout: 20_000 });
    await tagRef.click();
    await expect(branches).toContainText("Keydex E2E annotated release");
    await branches.getByRole("button", { name: "Push tag…" }).click();
    await expect.poll(async () => (await fixture.git(["ls-remote", "--tags", "origin", "v1.0.0-e2e"])).stdout, { timeout: 20_000 })
      .toContain("refs/tags/v1.0.0-e2e");

    await branches.getByRole("button", { name: "Delete remote tag…" }).click();
    await expect.poll(async () => (await fixture.git(["ls-remote", "--tags", "origin", "v1.0.0-e2e"])).stdout.trim(), { timeout: 20_000 })
      .toBe("");
    await branches.getByRole("button", { name: "Delete local tag…" }).click();
    await expect.poll(async () => (await fixture.git(["tag", "--list", "v1.0.0-e2e"])).stdout.trim(), { timeout: 20_000 })
      .toBe("");
    await fixture.screenshot(page, "e2e-036-038-039-branch-safety-tag");
  } finally {
    await fixture.cleanup();
  }
});

async function openGitToolWindow(page: Page): Promise<void> {
  const trigger = page.getByRole("button", { name: /Git：/ });
  await expect(trigger).toBeEnabled({ timeout: 10_000 });
  await trigger.click();
  await page.getByRole("menuitem", { name: "打开 Git 面板" }).click();
  await expect(page.getByRole("tablist", { name: "Git 面板视图" })).toBeVisible();
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}
