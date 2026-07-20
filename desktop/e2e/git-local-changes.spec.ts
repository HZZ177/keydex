import { expect, test, type Page } from "@playwright/test";
import { access, rm } from "node:fs/promises";
import { createServer } from "node:http";
import * as path from "node:path";

import { startGitE2EFixture } from "./git-e2e-fixtures";

test.describe.configure({ mode: "serial" });

test("an untracked text file renders as a whole-file addition", async ({ page }) => {
  test.setTimeout(180_000);
  const fixture = await startGitE2EFixture("untracked-file-diff");
  try {
    await fixture.write("new-file.txt", "first added line\nsecond added line\n");
    await fixture.configurePage(page);
    await page.goto(`${fixture.appBaseUrl}/#/workbench/${fixture.workspaceId}`, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Git", exact: true }).click();
    await expect(page.getByRole("tablist", { name: "Git 面板视图" })).toBeVisible();

    const row = page.getByRole("tree", { name: "本地改动" })
      .getByRole("treeitem", { name: /new-file\.txt untracked/ });
    await expect(row).toBeVisible({ timeout: 10_000 });
    await row.click();

    await expect(gitDiff(page)).toContainText("first added line", { timeout: 20_000 });
    await expect(gitDiff(page).locator('[data-keydex-diff-file-header="true"]'))
      .toHaveAttribute("data-status", "added");
    await expect(gitDiff(page).getByLabel("新增 2 行，删除 0 行")).toBeVisible();
  } finally {
    await fixture.cleanup();
  }
});

test("local changes, unified diff, stage, unstage, commit and commit-push close against a real repo", async ({ page }) => {
  test.setTimeout(180_000);
  const fixture = await startGitE2EFixture("local-changes-commit");
  try {
    await fixture.write("README.md", "# Keydex E2E workspace\n\ntracked change from page fixture\n");
    await fixture.write("push.txt", "commit and push through the page\n");
    await fixture.configurePage(page);
    await page.goto(`${fixture.appBaseUrl}/#/workbench/${fixture.workspaceId}`, { waitUntil: "domcontentloaded" });
    await openGitToolWindow(page);
    const editor = page.getByRole("region", { name: "提交编辑器" });

    await expect(page.getByRole("treeitem", { name: /README\.md modified/ })).toBeVisible({ timeout: 10_000 });
    await selectChange(page, /README\.md modified/);
    await expect(gitDiff(page)).toContainText("tracked change from page fixture");
    await applyFileAction(page, "暂存文件");
    await expect.poll(
      async () => (await fixture.git(["diff", "--cached", "--name-only"])).stdout.trim(),
      { timeout: 15_000 },
    ).toBe("README.md");

    await refreshChanges(page);
    await selectOnlyChangeForFileAction(page, /README\.md modified/, "取消暂存文件");
    await applyFileAction(page, "取消暂存文件");
    await expect.poll(
      async () => (await fixture.git(["diff", "--cached", "--name-only"])).stdout.trim(),
      { timeout: 15_000 },
    ).toBe("");

    await refreshChanges(page);
    await selectOnlyChange(page, /README\.md modified/);
    await expect(editor).toContainText("1 个已选择文件", { timeout: 10_000 });
    await expect(editor).toContainText("Keydex Git E2E <keydex-git-e2e@example.invalid>");
    await editor.getByRole("textbox", { name: "提交说明" }).fill("e2e: commit from Git workbench");
    await editor.getByRole("button", { name: "提交", exact: true }).click();
    await expect(page.getByTestId("notification-item").filter({ hasText: "提交成功" }).last()).toBeVisible({ timeout: 15_000 });
    await expect(editor.getByRole("status", { name: "提交结果" })).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: /将提交推送到/ })).toHaveCount(0);
    await expect.poll(
      async () => (await fixture.git(["log", "-1", "--pretty=%s"])).stdout.trim(),
      { timeout: 15_000 },
    ).toBe("e2e: commit from Git workbench");
    await expect(page.getByRole("button", { name: /Git：main/ })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("treeitem", { name: /push\.txt untracked/ })).toBeVisible({ timeout: 10_000 });
    await selectChange(page, /push\.txt untracked/);
    expect((await fixture.git(["diff", "--cached", "--name-only"])).stdout.trim()).toBe("");
    await expect(editor).toContainText("1 个已选择文件", { timeout: 10_000 });
    await editor.getByRole("textbox", { name: "提交说明" }).fill("e2e: commit and push");
    await editor.getByRole("button", { name: "提交并推送" }).click();
    const pushDialog = page.getByRole("dialog", { name: /将提交推送到/ });
    await expect(pushDialog).toBeVisible({ timeout: 30_000 });
    const outgoingCommits = pushDialog.getByRole("listbox", { name: "待推送提交列表" });
    await expect(outgoingCommits.getByRole("option")).toHaveCount(2);
    await expect(outgoingCommits).toContainText("e2e: commit and push");
    await expect(outgoingCommits).toContainText("e2e: commit from Git workbench");
    const pushedFiles = pushDialog.getByRole("tree", { name: "待推送提交改动文件树" });
    await expect(pushedFiles).toContainText("push.txt");
    const repositoryRootNode = pushedFiles.getByRole("treeitem").first();
    await expect(repositoryRootNode).toHaveAttribute("aria-expanded", "true");
    await expect(repositoryRootNode).toContainText("1 个文件");
    await pushDialog.getByRole("checkbox", { name: "推送标签" }).check();
    await pushDialog.getByRole("button", { name: "推送标签范围" }).click();
    await page.getByRole("option", { name: "当前分支", exact: true }).click();
    await expect.poll(async () =>
      (await fixture.git(["rev-parse", "origin/main"])).stdout.trim()
        !== (await fixture.git(["rev-parse", "HEAD"])).stdout.trim(),
    { timeout: 15_000 }).toBe(true);
    await pushDialog.getByRole("button", { name: "推送", exact: true }).click();
    await expect(page.getByTestId("notification-item").filter({ hasText: "推送完成" }).last()).toBeVisible({ timeout: 30_000 });
    await expect(editor.getByRole("status", { name: "提交结果" })).toHaveCount(0);
    await expect.poll(async () =>
      (await fixture.git(["rev-parse", "origin/main"])).stdout.trim()
        === (await fixture.git(["rev-parse", "HEAD"])).stdout.trim(),
    { timeout: 30_000 }).toBe(true);
    await fixture.screenshot(page, "e2e-026-local-commit-push");
  } finally {
    await fixture.cleanup();
  }
});

test("special paths, rename, binary, executable mode and ignored policy render and mutate the exact Git entries", async ({ page }) => {
  test.setTimeout(120_000);
  const fixture = await startGitE2EFixture("special-paths-status");
  try {
    await fixture.write("中文 空格😀.txt", "unicode base\n");
    await fixture.write("old name.txt", "rename base\n");
    await fixture.write("binary.dat", "\u0000binary base\n");
    await fixture.write("scripts/run.sh", "#!/bin/sh\necho base\n");
    await fixture.write(".gitignore", "ignored.log\n");
    await fixture.commit("test: special path baseline", ["中文 空格😀.txt", "old name.txt", "binary.dat", "scripts/run.sh", ".gitignore"]);
    await fixture.write("中文 空格😀.txt", "unicode base\n中文修改 😀\n");
    await fixture.git(["mv", "old name.txt", "renamed name.txt"]);
    await fixture.write("binary.dat", "\u0000binary changed\n");
    await fixture.git(["update-index", "--chmod=+x", "scripts/run.sh"]);
    await fixture.write("ignored.log", "ignored content\n");

    await fixture.configurePage(page);
    await page.goto(`${fixture.appBaseUrl}/#/workbench/${fixture.workspaceId}`);
    await openGitToolWindow(page);
    const changes = page.getByRole("tree", { name: "本地改动" });

    await expect(changes.getByRole("treeitem", { name: /中文 空格😀\.txt modified/ })).toBeVisible({ timeout: 15_000 });
    await selectOnlyChange(page, /中文 空格😀\.txt modified/);
    await expect(gitDiff(page)).toContainText("中文修改 😀");
    await applyFileAction(page, "暂存文件");
    await expect.poll(async () => (await fixture.git(["diff", "--cached", "--name-only"])).stdout, { timeout: 15_000 })
      .toContain("中文 空格😀.txt");

    await selectOnlyChange(page, /renamed name\.txt renamed/);
    await expect(changes.getByRole("treeitem", { name: /renamed name\.txt renamed/ })).toBeVisible();
    const cachedNames = (await fixture.git(["diff", "--cached", "--name-status", "-M"])).stdout;
    expect(cachedNames).toMatch(/R\d*\s+old name\.txt\s+renamed name\.txt/);
    expect(cachedNames).toContain("scripts/run.sh");
    await selectOnlyChange(page, /binary\.dat modified/);
    await expect(gitDiff(page)).toContainText("二进制文件", { timeout: 10_000 });
    await expect(gitDiff(page)).toContainText("不提供文本差异");
    expect((await fixture.git(["diff", "--numstat", "--", "binary.dat"])).stdout).toContain("-\t-\tbinary.dat");
    await selectOnlyChange(page, /scripts\/run\.sh modified/);
    await expect(gitDiff(page)).toContainText("模式 100644 → 100755", { timeout: 10_000 });

    await expect(changes).not.toContainText("ignored.log");
    expect((await fixture.git(["status", "--porcelain=v1", "--ignored", "--", "ignored.log"])).stdout.trim()).toBe("!! ignored.log");
    await fixture.screenshot(page, "e2e-013-016-017-special-paths-status");
  } finally {
    await fixture.cleanup();
  }
});

test("a staged two-hunk file can unstage the whole file without losing either working-tree edit", async ({ page }) => {
  test.setTimeout(90_000);
  const fixture = await startGitE2EFixture("partial-unstage");
  try {
    const baseline = Array.from({ length: 24 }, (_, index) => `line ${index + 1}`).join("\n") + "\n";
    await fixture.write("partial.txt", baseline);
    await fixture.commit("test: partial unstage baseline", ["partial.txt"]);
    const changed = baseline.replace("line 2\n", "line 2 changed\n").replace("line 22\n", "line 22 changed\n");
    await fixture.write("partial.txt", changed);
    await fixture.git(["add", "--", "partial.txt"]);
    await fixture.configurePage(page);
    await page.goto(`${fixture.appBaseUrl}/#/workbench/${fixture.workspaceId}`);
    await openGitToolWindow(page);
    await selectOnlyChange(page, /partial\.txt modified/);
    await applyFileAction(page, "取消暂存文件");
    await expect.poll(async () => (await fixture.git(["diff", "--cached", "--", "partial.txt"])).stdout, { timeout: 15_000 })
      .toBe("");
    expect((await fixture.git(["show", ":partial.txt"])).stdout).toBe((await fixture.git(["show", "HEAD:partial.txt"])).stdout);
    expect((await fixture.git(["diff", "--", "partial.txt"])).stdout).toContain("line 2 changed");
    expect((await fixture.git(["diff", "--", "partial.txt"])).stdout).toContain("line 22 changed");
    expect((await fixture.git(["show", "HEAD:partial.txt"])).stdout).toContain("line 2\n");
    await fixture.screenshot(page, "e2e-020-partial-unstage");
  } finally {
    await fixture.cleanup();
  }
});

test("a persistent index lock exposes cancellation, preserves the foreign lock and leaves no staged residue", async ({ page }) => {
  test.setTimeout(90_000);
  const fixture = await startGitE2EFixture("operation-cancel-lock");
  const lockPath = path.join(fixture.repositoryRoot, ".git", "index.lock");
  try {
    await fixture.write("cancel-stage.txt", "baseline before cancel\n");
    await fixture.commit("test: cancellation baseline", ["cancel-stage.txt"]);
    await fixture.write("cancel-stage.txt", "do not stage after cancel\n");
    await fixture.configurePage(page);
    await page.goto(`${fixture.appBaseUrl}/#/workbench/${fixture.workspaceId}`);
    await openGitToolWindow(page);
    await selectOnlyChange(page, /cancel-stage\.txt modified/);
    await fixture.write(".git/index.lock", "held by external process\n");
    await applyFileAction(page, "暂存文件", { noWaitAfter: true });
    await openAdvancedGitView(page);
    const log = page.getByRole("region", { name: "Git 操作日志" });
    const cancel = log.getByRole("button", { name: "取消操作" });
    await expect(cancel).toBeVisible({ timeout: 10_000 });
    await cancel.click();
    await expect(log).toContainText("已取消", { timeout: 20_000 });
    await expect.poll(() => fileExists(lockPath)).toBe(true);
    expect((await fixture.git(["diff", "--cached", "--name-only"])).stdout.trim()).toBe("");
    await rm(lockPath);
    await expect.poll(() => fileExists(lockPath)).toBe(false);
    await fixture.screenshot(page, "e2e-067-068-operation-cancel-lock");
  } finally {
    await rm(lockPath, { force: true }).catch(() => undefined);
    await fixture.cleanup();
  }
});

test("operation log keeps idempotent serial writes, lock retry, cancellation and redacted retryable failure", async ({ page }) => {
  test.setTimeout(150_000);
  const fixture = await startGitE2EFixture("operation-log-serial-redaction");
  const lockPath = path.join(fixture.repositoryRoot, ".git", "index.lock");
  const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456";
  const authServer = createServer((_request, response) => {
    response.writeHead(401, { "WWW-Authenticate": "Basic realm=keydex-e2e" });
    response.end("credentials required");
  });
  try {
    await new Promise<void>((resolve, reject) => {
      authServer.once("error", reject);
      authServer.listen(0, "127.0.0.1", resolve);
    });
    const address = authServer.address();
    if (!address || typeof address === "string") throw new Error("Expected a TCP address for the E2E auth server");
    await fixture.git(["remote", "add", "auth-e2e", `http://user:${secret}@127.0.0.1:${address.port}/repository.git`]);
    await fixture.write("queued-stage.txt", "queued stage baseline\n");
    await fixture.write("cancel-stage-two.txt", "cancel stage baseline\n");
    await fixture.commit("test: serial operation baseline", ["queued-stage.txt", "cancel-stage-two.txt"]);
    await fixture.write("already-staged.txt", "commit waits for queued stage\n");
    await fixture.git(["add", "--", "already-staged.txt"]);
    await fixture.write("queued-stage.txt", "stage through a transient lock\n");
    await fixture.write("cancel-stage-two.txt", "must remain in the worktree after cancel\n");

    await fixture.configurePage(page);
    await page.goto(`${fixture.appBaseUrl}/#/workbench/${fixture.workspaceId}`);
    await openGitToolWindow(page);
    await selectOnlyChange(page, /queued-stage\.txt modified/);
    const editor = page.getByRole("region", { name: "提交编辑器" });
    await editor.getByRole("textbox", { name: "提交说明" }).fill("test: serialized stage then commit");
    await fixture.write(".git/index.lock", "short external lock\n");
    const stage = page.getByRole("button", { name: "暂存文件" }).first();
    await stage.evaluate((element) => {
      (element as HTMLButtonElement).click();
      (element as HTMLButtonElement).click();
    });
    await editor.getByRole("button", { name: "提交", exact: true }).click({ noWaitAfter: true });
    await page.waitForTimeout(350);
    expect(await fileExists(lockPath)).toBe(true);
    await rm(lockPath);
    await expect.poll(async () => (await fixture.git(["log", "-1", "--pretty=%s"])).stdout.trim(), { timeout: 30_000 })
      .toBe("test: serialized stage then commit");
    await expect(page.getByRole("button", { name: /Git：main/ })).toBeVisible({ timeout: 20_000 });
    const committedPaths = (await fixture.git(["show", "--pretty=", "--name-only", "HEAD"])).stdout;
    expect(committedPaths).toContain("queued-stage.txt");
    expect(committedPaths).not.toContain("already-staged.txt");
    expect((await fixture.git(["diff", "--cached", "--name-only"])).stdout).toContain("already-staged.txt");

    await openAdvancedGitView(page);
    const log = page.getByRole("region", { name: "Git 操作日志" });
    await expect(log).toContainText("test: serialized stage then commit", { timeout: 20_000 });
    const commandNamesAfterCommit = await log.getByRole("listitem").locator("code").allTextContents();
    expect(commandNamesAfterCommit.filter((command) => command === "apply_patch")).toHaveLength(1);
    expect(commandNamesAfterCommit.filter((command) => command === "commit")).toHaveLength(1);
    expect(commandNamesAfterCommit.indexOf("commit")).toBeLessThan(commandNamesAfterCommit.indexOf("apply_patch"));

    await page.getByRole("tab", { name: "提交" }).click();
    await selectOnlyChange(page, /cancel-stage-two\.txt modified/);
    await fixture.write(".git/index.lock", "persistent external lock\n");
    await applyFileAction(page, "暂存文件", { noWaitAfter: true });
    await openAdvancedGitView(page);
    const cancel = log.getByRole("button", { name: "取消操作" });
    await expect(cancel).toBeVisible({ timeout: 15_000 });
    await cancel.click();
    await expect(log).toContainText("已取消", { timeout: 30_000 });
    expect(await fileExists(lockPath)).toBe(true);
    expect((await fixture.git(["diff", "--cached", "--name-only"])).stdout.trim()).toBe("already-staged.txt");
    expect((await fixture.git(["status", "--porcelain=v1", "--", "cancel-stage-two.txt"])).stdout).toContain(" M");
    await rm(lockPath);

    await page.getByRole("tab", { name: "分支" }).click();
    const sync = page.getByRole("region", { name: "远程同步" });
    await sync.getByRole("combobox", { name: "获取远程仓库" }).selectOption("auth-e2e");
    await sync.getByRole("button", { name: "获取", exact: true }).click();
    await expect(page.getByTestId("notification-item").filter({ hasText: /凭据|credentials|authentication/i }).last())
      .toBeVisible({ timeout: 30_000 });
    await openAdvancedGitView(page);
    const failedFetch = log.getByRole("listitem").filter({ hasText: "git_credentials_missing" }).first();
    await expect(failedFetch).toHaveAttribute("data-state", "failed", { timeout: 20_000 });
    await expect(failedFetch.getByRole("button", { name: "重试" })).toBeEnabled();
    await expect(log).not.toContainText(secret);
    await expect(log).not.toContainText("user:");
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await failedFetch.getByRole("button", { name: "复制诊断" }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).not.toContain(secret);
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).not.toContain("user:");
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("git_credentials_missing");
    await expect(log.getByRole("listitem").filter({ hasText: "成功" })).not.toHaveCount(0);
    await expect(log.getByRole("listitem").filter({ hasText: "失败" })).not.toHaveCount(0);
    await expect(log.getByRole("listitem").filter({ hasText: "已取消" })).not.toHaveCount(0);
    await fixture.screenshot(page, "e2e-067-068-operation-log-serial-redaction");
  } finally {
    await rm(lockPath, { force: true }).catch(() => undefined);
    await new Promise<void>((resolve) => authServer.close(() => resolve())).catch(() => undefined);
    await fixture.cleanup();
  }
});

test("a stale file-level patch is rejected and refreshes to the latest worktree diff", async ({ page }) => {
  test.setTimeout(90_000);
  const fixture = await startGitE2EFixture("stale-file-patch");
  try {
    await fixture.write("stale.txt", "baseline\n");
    await fixture.commit("test: stale patch baseline", ["stale.txt"]);
    await fixture.write("stale.txt", "first visible change\n");
    await fixture.configurePage(page);
    await page.goto(`${fixture.appBaseUrl}/#/workbench/${fixture.workspaceId}`);
    await openGitToolWindow(page);
    await selectOnlyChange(page, /stale\.txt modified/);
    await expect(gitDiff(page)).toContainText("first visible change", { timeout: 20_000 });

    await fixture.write("stale.txt", "latest external change\n");
    await applyFileAction(page, "暂存文件");
    await expect(page.getByRole("alert")).toContainText(/变化|刷新|过期/, { timeout: 20_000 });
    expect((await fixture.git(["diff", "--cached", "--name-only"])).stdout.trim()).toBe("");
    await expect(gitDiff(page)).toContainText("latest external change", { timeout: 20_000 });
    await fixture.screenshot(page, "e2e-diff-stale-file-refresh");
  } finally {
    await fixture.cleanup();
  }
});

test("a large Git diff does not block unrelated backend requests", async ({ page }) => {
  test.setTimeout(90_000);
  const fixture = await startGitE2EFixture("large-diff-nonblocking");
  try {
    const baseline = Array.from({ length: 6_000 }, (_, index) => `baseline ${index + 1}`).join("\n") + "\n";
    const changed = Array.from({ length: 6_000 }, (_, index) => `changed ${index + 1}`).join("\n") + "\n";
    await fixture.write("large.txt", baseline);
    await fixture.commit("test: large diff baseline", ["large.txt"]);
    await fixture.write("large.txt", changed);
    await fixture.configurePage(page);
    await page.goto(`${fixture.appBaseUrl}/#/workbench/${fixture.workspaceId}`);
    await openGitToolWindow(page);

    const row = page.getByRole("tree", { name: "本地改动" }).getByRole("treeitem", { name: /large\.txt modified/ });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.click();
    const startedAt = Date.now();
    const requestCompleted = await Promise.race([
      fixture.api<{ list: unknown[] }>("/api/workspaces").then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3_000)),
    ]);
    expect(requestCompleted).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(3_000);
    await expect(gitDiff(page).locator('[data-keydex-diff-engine="pierre"]')).toBeVisible({ timeout: 30_000 });
    await expect(gitDiff(page)).toContainText("large.txt");
    await fixture.screenshot(page, "e2e-diff-large-nonblocking");
  } finally {
    await fixture.cleanup();
  }
});

test("stash details and exported patches render through the unified read-only Diff", async ({ page }) => {
  test.setTimeout(90_000);
  const fixture = await startGitE2EFixture("stash-patch-diff");
  try {
    await fixture.write("stash-diff.txt", "baseline\n");
    await fixture.commit("test: stash diff baseline", ["stash-diff.txt"]);
    await fixture.write("stash-diff.txt", "stash diff change\n");
    await fixture.configurePage(page);
    await page.goto(`${fixture.appBaseUrl}/#/workbench/${fixture.workspaceId}`);
    await openGitToolWindow(page);

    await openMoreGitView(page, "暂存的改动");
    await page.getByRole("button", { name: "创建储藏…" }).click();
    const dialog = page.getByRole("dialog", { name: "创建储藏" });
    await dialog.getByRole("textbox", { name: "储藏说明" }).fill("e2e unified diff stash");
    await dialog.getByRole("button", { name: "创建储藏", exact: true }).click();
    await page.getByRole("option", { name: /e2e unified diff stash/ }).click();
    await expect(gitDiff(page)).toHaveAttribute("data-read-only", "true", { timeout: 20_000 });
    await expect(gitDiff(page)).toContainText("stash diff change");

    await openAdvancedGitView(page);
    const exchange = page.getByRole("region", { name: "补丁导入与导出" });
    await exchange.getByRole("combobox", { name: "补丁导出方式" }).selectOption("commit");
    await exchange.getByRole("textbox", { name: "补丁左侧修订" }).fill("HEAD");
    await exchange.getByRole("button", { name: "生成补丁" }).click();
    const exported = exchange.getByLabel("已导出的补丁");
    await expect(exported.locator('[data-keydex-diff-wrapper="preview"]')).toBeVisible({ timeout: 20_000 });
    await expect(exported).toContainText("baseline");
    expect((await fixture.git(["format-patch", "-1", "--stdout", "HEAD"])).stdout).toContain("baseline");
    await fixture.screenshot(page, "e2e-diff-stash-and-patch-export");
  } finally {
    await fixture.cleanup();
  }
});

async function openGitToolWindow(page: Page): Promise<void> {
  const trigger = page.getByRole("button", { name: /Git：main/ });
  await expect(trigger).toBeEnabled({ timeout: 10_000 });
  await trigger.click();
  await page.getByRole("menuitem", { name: "打开 Git 面板" }).click();
  await expect(page.getByRole("tablist", { name: "Git 面板视图" })).toBeVisible();
}

async function openAdvancedGitView(page: Page): Promise<void> {
  await page.getByRole("button", { name: "更多 Git 视图" }).click();
  await page.getByRole("menuitem", { name: /高级 Git 工具/ }).click();
}

async function openMoreGitView(page: Page, label: "暂存的改动"): Promise<void> {
  await page.getByRole("button", { name: "更多 Git 视图" }).click();
  await page.getByRole("menuitem", { name: new RegExp(label) }).click();
}

function gitDiff(page: Page) {
  return page.locator('[data-keydex-diff-wrapper="git"]').last();
}

async function refreshChanges(page: Page): Promise<void> {
  const refresh = page.getByRole("button", { name: "刷新本地改动" });
  await expect(refresh).toBeEnabled({ timeout: 20_000 });
  const statusResponse = page.waitForResponse((response) =>
    response.request().method() === "GET"
      && /\/api\/git\/repositories\/[^/]+\/status(?:\?|$)/.test(response.url())
      && response.ok(),
  );
  await refresh.click();
  await statusResponse;
  await expect(refresh).toBeEnabled({ timeout: 20_000 });
}

async function applyFileAction(
  page: Page,
  name: "暂存文件" | "取消暂存文件",
  options: { noWaitAfter?: boolean } = {},
): Promise<void> {
  const action = page.getByRole("button", { name }).first();
  await expect(action).toBeVisible({ timeout: 20_000 });
  await action.click(options);
}

async function selectChange(page: Page, name: RegExp): Promise<void> {
  const tree = page.getByRole("tree", { name: "本地改动" });
  const row = tree.getByRole("treeitem", { name });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();
  const checkbox = tree.getByRole("checkbox", { name });
  await expect(checkbox).toBeVisible({ timeout: 20_000 });
  await checkbox.check();
  await expect(checkbox).toBeChecked();
}

async function selectOnlyChange(page: Page, name: RegExp): Promise<void> {
  const tree = page.getByRole("tree", { name: "本地改动" });
  const row = tree.getByRole("treeitem", { name });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();
  const target = tree.getByRole("checkbox", { name });
  await expect(target).toBeVisible({ timeout: 20_000 });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const checked = tree.getByRole("checkbox", { checked: true });
    if ((await checked.count()) === 0) break;
    await checked.first().uncheck();
  }
  await target.check();
  await expect(target).toBeChecked();
}

async function selectOnlyChangeForFileAction(
  page: Page,
  name: RegExp,
  actionName: "暂存文件" | "取消暂存文件",
): Promise<void> {
  await selectOnlyChange(page, name);
  const tree = page.getByRole("tree", { name: "本地改动" });
  const row = tree.getByRole("treeitem", { name });
  const action = page.getByRole("button", { name: actionName }).first();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (await action.isVisible().catch(() => false)) return;
    await page.waitForTimeout(400);
    await row.click();
  }
  await expect(action).toBeVisible({ timeout: 5_000 });
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}
