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

    await openMoreGitView(page, "暂存的改动");
    await page.getByRole("button", { name: "创建储藏…" }).click();
    const createStashDialog = page.getByRole("dialog", { name: "创建储藏" });
    await createStashDialog.getByRole("textbox", { name: "储藏说明" }).fill("e2e stash from page");
    await createStashDialog.getByRole("button", { name: "创建储藏", exact: true }).click();
    await expect(page.getByRole("option", { name: /e2e stash from page/ })).toBeVisible({ timeout: 10_000 });
    expect((await fixture.git(["stash", "list", "--format=%s"])).stdout).toContain("e2e stash from page");

    await page.getByRole("option", { name: /e2e stash from page/ }).click();
    await page.getByRole("button", { name: "删除储藏…" }).click();
    const dropDialog = page.getByRole("dialog", { name: "删除储藏" });
    await dropDialog.getByRole("button", { name: "取消" }).click();
    expect((await fixture.git(["stash", "list"])).stdout.trim()).not.toBe("");
    await page.getByRole("button", { name: "删除储藏…" }).click();
    await page.getByRole("dialog", { name: "删除储藏" }).getByRole("button", { name: "删除储藏" }).click();
    await expect(page.getByRole("status")).toContainText("没有储藏记录", { timeout: 10_000 });
    expect((await fixture.git(["stash", "list"])).stdout.trim()).toBe("");

    await page.reload();
    if (!(await page.getByRole("tablist", { name: "Git 面板视图" }).isVisible().catch(() => false))) await openGitToolWindow(page);
    await expect(page.getByRole("tablist", { name: "Git 面板视图" })).toBeVisible({ timeout: 10_000 });
    await page.getByRole("tab", { name: "分支" }).click();
    const branches = page.getByRole("region", { name: "分支操作" });
    await branches.getByRole("button", { name: "新建分支…" }).click();
    await page.getByLabel("新分支名称").fill("feature/e2e");
    await page.getByRole("button", { name: "创建", exact: true }).click();
    await expect.poll(async () => (await fixture.git(["branch", "--list", "feature/e2e"])).stdout.trim()).toContain("feature/e2e");
    await expect.poll(async () => (await fixture.git(["branch", "--show-current"])).stdout.trim()).toBe("feature/e2e");
    await expect(page.getByRole("treeitem", { name: "feature/e2e", exact: true })).toHaveAttribute("aria-current", "true");
    await page.getByRole("treeitem", { name: "feature/e2e", exact: true }).click();
    await branches.getByRole("button", { name: "重命名…" }).click();
    const renameBranchDialog = page.getByRole("dialog", { name: "重命名分支 feature/e2e" });
    await renameBranchDialog.getByRole("textbox", { name: "重命名分支" }).fill("feature/e2e-renamed");
    await renameBranchDialog.getByRole("button", { name: "重命名", exact: true }).click();
    await expect.poll(async () => (await fixture.git(["branch", "--show-current"])).stdout.trim()).toBe("feature/e2e-renamed");
    await expect(page.getByRole("button", { name: /Git：feature\/e2e-renamed/ })).toBeVisible({ timeout: 10_000 });

    const remoteManager = page.getByRole("region", { name: "远程仓库管理" });
    await remoteManager.getByRole("button", { name: "添加远程仓库…" }).click();
    await page.getByRole("textbox", { name: "远程仓库名称" }).fill("backup");
    await page.getByRole("textbox", { name: "获取地址" }).fill(fixture.bareRemoteRoot);
    await page.getByRole("button", { name: "添加", exact: true }).click();
    await expect.poll(async () => (await fixture.git(["remote"])).stdout).toContain("backup");
    await expect(remoteManager.getByRole("option", { name: /backup/ })).toBeVisible({ timeout: 10_000 });
    await remoteManager.getByRole("option", { name: /backup/ }).click();
    await remoteManager.getByRole("button", { name: "重命名…" }).click();
    const renameRemoteDialog = page.getByRole("dialog", { name: "重命名远程仓库" });
    await renameRemoteDialog.getByRole("textbox", { name: "重命名远程仓库" }).fill("backup-renamed");
    await renameRemoteDialog.getByRole("button", { name: "重命名", exact: true }).click();
    await expect.poll(async () => (await fixture.git(["remote"])).stdout).toContain("backup-renamed");

    const sync = page.getByRole("region", { name: "远程同步" });
    await sync.getByRole("combobox", { name: "获取远程仓库" }).selectOption("origin");
    await sync.getByRole("button", { name: "获取" }).click();
    await expect(sync.getByRole("button", { name: "获取" })).toBeEnabled({ timeout: 10_000 });
    await openMoreGitView(page, "高级 Git 工具");
    await expect(page.getByRole("region", { name: "Git 操作日志" })).toContainText("fetch", { timeout: 10_000 });
    await page.getByRole("tab", { name: "分支" }).click();

    await sync.getByRole("button", { name: "推送…" }).click();
    await page.getByRole("combobox", { name: "推送远程仓库" }).selectOption("origin");
    await expect(page.getByRole("checkbox", { name: "设置上游" })).toBeChecked();
    await page.getByRole("button", { name: "推送", exact: true }).click();
    await expect(sync).toContainText("推送完成", { timeout: 15_000 });
    expect((await fixture.git(["ls-remote", "--heads", "origin", "feature/e2e-renamed"])).stdout).toContain("refs/heads/feature/e2e-renamed");
    expect((await fixture.git(["rev-parse", "--abbrev-ref", "@{upstream}"])).stdout.trim()).toBe("origin/feature/e2e-renamed");

    await sync.getByRole("button", { name: "更新…" }).click();
    const updateDialog = page.getByRole("dialog", { name: "更新项目" });
    await expect(updateDialog.getByRole("radio")).toHaveCount(2);
    await expect(updateDialog.getByRole("radio", { name: /将传入更改合并到当前分支/ })).toBeChecked();
    await expect(updateDialog).toContainText("历史更线性，但会改写本地提交");
    await expect(updateDialog).not.toContainText("仅快进");
    await updateDialog.getByRole("button", { name: "更新", exact: true }).click();
    await expect(sync).toContainText("已是最新状态", { timeout: 15_000 });

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
    await sync.getByRole("button", { name: "推送…" }).click();
    const outgoing = page.getByRole("region", { name: "将要发布的提交" });
    await expect(outgoing).toContainText("feat: outgoing one", { timeout: 15_000 });
    await expect(outgoing).toContainText("feat: outgoing two");
    await page.getByRole("button", { name: "推送", exact: true }).click();
    await expect(sync).toContainText("推送完成", { timeout: 20_000 });
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
    await sync.getByRole("button", { name: "推送…" }).click();
    await page.getByRole("checkbox", { name: "带租约强制推送" }).check();
    const replaced = page.getByRole("region", { name: "可能被替换的远程提交" });
    await expect(replaced).toContainText("peer: remote commit to replace", { timeout: 20_000 });
    await page.getByRole("button", { name: "继续确认" }).click();
    await page.getByRole("dialog", { name: "确认带租约强制推送" }).getByRole("button", { name: "带租约强制推送" }).click();
    await expect(sync).toContainText("推送完成", { timeout: 20_000 });
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
    await sync.getByRole("button", { name: "推送…" }).click();
    await page.getByRole("checkbox", { name: "带租约强制推送" }).check();
    await page.getByRole("button", { name: "继续确认" }).click();
    await page.getByRole("dialog", { name: "确认带租约强制推送" }).getByRole("button", { name: "带租约强制推送" }).click();
    await expect(page.getByTestId("git-tool-window")).toContainText(/stale info|rejected|Fetch\/Update|过期|拒绝|获取|更新/i, { timeout: 20_000 });
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
    const branches = page.getByRole("region", { name: "分支操作" });
    await page.getByRole("treeitem", { name: "target/dirty" }).click();
    await branches.getByRole("button", { name: "签出…" }).click();
    const dirtyDialog = page.getByRole("dialog", { name: "工作树存在本地改动" });
    await expect(dirtyDialog).toContainText("本地改动");
    await dirtyDialog.getByRole("button", { name: "取消" }).click();
    expect((await fixture.git(["branch", "--show-current"])).stdout.trim()).toBe("main");
    expect((await fixture.git(["status", "--porcelain"])).stdout).toContain("dirty.txt");

    await branches.getByRole("button", { name: "签出…" }).click();
    await page.getByRole("dialog", { name: "工作树存在本地改动" }).getByRole("button", { name: "储藏并签出" }).click();
    await expect.poll(async () => (await fixture.git(["branch", "--show-current"])).stdout.trim(), { timeout: 20_000 })
      .toBe("target/dirty");
    expect((await fixture.git(["stash", "list", "--format=%s"])).stdout).toContain("Keydex：切换到 target/dirty 前的自动储藏");

    await page.reload();
    await expect(page.getByRole("button", { name: /Git：target\/dirty/ })).toBeEnabled({ timeout: 20_000 });
    if (!(await page.getByRole("tablist", { name: "Git 面板视图" }).isVisible().catch(() => false))) {
      await openGitToolWindow(page);
    }
    await page.getByRole("tab", { name: "分支" }).click();

    await page.getByRole("treeitem", { name: "old/merged" }).click();
    await expect(branches).toContainText("删除 old/merged");
    await branches.getByRole("button", { name: "删除…", exact: true }).click();
    await page.getByRole("dialog", { name: "删除分支" }).getByRole("button", { name: "删除" }).click();
    await expect.poll(async () => (await fixture.git(["branch", "--list", "old/merged"])).stdout.trim(), { timeout: 20_000 })
      .toBe("");

    await page.getByRole("treeitem", { name: "当前分支 target/dirty" }).click();
    await branches.getByRole("button", { name: "创建标签…" }).click();
    await page.getByRole("textbox", { name: "标签名称" }).fill("v1.0.0-e2e");
    await page.getByRole("checkbox", { name: "附注标签" }).check();
    await page.getByRole("textbox", { name: "标签说明" }).fill("Keydex E2E annotated release");
    await page.getByRole("dialog", { name: "创建标签" }).getByRole("button", { name: "创建标签", exact: true }).click();
    await page.getByRole("treeitem", { name: /标签 1/ }).click();
    const tagRef = page.getByRole("treeitem", { name: "v1.0.0-e2e" });
    await expect(tagRef).toBeVisible({ timeout: 20_000 });
    await tagRef.click();
    await expect(branches).toContainText("Keydex E2E annotated release");
    await branches.getByRole("button", { name: "推送标签…" }).click();
    await page.getByRole("dialog", { name: /推送标签/ }).getByRole("button", { name: "推送标签" }).click();
    await expect.poll(async () => (await fixture.git(["ls-remote", "--tags", "origin", "v1.0.0-e2e"])).stdout, { timeout: 20_000 })
      .toContain("refs/tags/v1.0.0-e2e");

    await branches.getByRole("button", { name: "删除远程标签…" }).click();
    await page.getByRole("dialog", { name: /删除远程标签/ }).getByRole("button", { name: "删除远程标签" }).click();
    await expect.poll(async () => (await fixture.git(["ls-remote", "--tags", "origin", "v1.0.0-e2e"])).stdout.trim(), { timeout: 20_000 })
      .toBe("");
    await branches.getByRole("button", { name: "删除本地标签…" }).click();
    await page.getByRole("dialog", { name: "删除本地标签" }).getByRole("button", { name: "删除" }).click();
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

async function openMoreGitView(page: Page, label: "暂存的改动" | "高级 Git 工具"): Promise<void> {
  await page.getByRole("button", { name: "更多 Git 视图" }).click();
  await page.getByRole("menuitem", { name: new RegExp(label) }).click();
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}
