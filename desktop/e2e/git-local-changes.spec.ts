import { expect, test, type Page } from "@playwright/test";
import { access, rm } from "node:fs/promises";
import { createServer } from "node:http";
import * as path from "node:path";

import { startGitE2EFixture } from "./git-e2e-fixtures";

test.describe.configure({ mode: "serial" });

test("local changes, diff, stage, unstage, commit, amend and commit-push close against a real repo", async ({ page }) => {
  test.setTimeout(90_000);
  const fixture = await startGitE2EFixture("local-changes-commit");
  try {
    await fixture.write("README.md", "# Keydex E2E workspace\n\ntracked change from page fixture\n");
    await fixture.write("amend.txt", "amend through the page\n");
    await fixture.write("push.txt", "commit and push through the page\n");
    await fixture.configurePage(page);
    await page.goto(`${fixture.appBaseUrl}/#/workbench/${fixture.workspaceId}`);
    await openGitToolWindow(page);
    const editor = page.getByRole("region", { name: "Commit 编辑器" });

    await expect(page.getByRole("treeitem", { name: /README\.md modified/ })).toBeVisible({ timeout: 10_000 });
    await selectChange(page, /README\.md modified/);
    await expect(page.getByRole("table", { name: "统一 Diff 内容" })).toContainText("tracked change from page fixture");
    await page.getByRole("button", { name: "暂存", exact: true }).click();
    await expect(page.getByRole("checkbox", { name: "选择已暂存" })).toBeVisible({ timeout: 10_000 });
    expect((await fixture.git(["diff", "--cached", "--name-only"])).stdout.trim()).toBe("README.md");

    await page.getByRole("checkbox", { name: "选择已暂存" }).click();
    await page.getByRole("button", { name: "取消暂存", exact: true }).click();
    await expect(page.getByRole("checkbox", { name: "选择未暂存" })).toBeVisible({ timeout: 10_000 });
    expect((await fixture.git(["diff", "--cached", "--name-only"])).stdout.trim()).toBe("");

    await selectChange(page, /README\.md modified/);
    await page.getByRole("button", { name: "暂存", exact: true }).click();
    await expect(editor).toContainText("1 个已暂存文件", { timeout: 10_000 });
    await expect(editor).toContainText("Keydex Git E2E <keydex-git-e2e@example.invalid>");
    await editor.getByRole("textbox", { name: "Commit message" }).fill("e2e: commit from Git workbench");
    await editor.getByRole("button", { name: "提交", exact: true }).click();
    await expect(editor.getByRole("status", { name: "Commit result" })).toBeVisible({ timeout: 10_000 });
    expect((await fixture.git(["log", "-1", "--pretty=%s"])).stdout.trim()).toBe("e2e: commit from Git workbench");
    await expect(page.getByRole("button", { name: /Git：main/ })).toBeVisible({ timeout: 20_000 });
    const amendTarget = (await fixture.git(["rev-parse", "HEAD"])).stdout.trim();

    await expect(page.getByRole("treeitem", { name: /amend\.txt untracked/ })).toBeVisible({ timeout: 10_000 });
    await selectChange(page, /amend\.txt untracked/);
    await page.getByRole("button", { name: "暂存", exact: true }).click();
    await expect.poll(async () => (await fixture.git(["diff", "--cached", "--name-only"])).stdout).toContain("amend.txt");
    await expect(editor).toContainText("1 个已暂存文件", { timeout: 10_000 });
    await editor.getByRole("checkbox", { name: "修订上次提交" }).check();
    const amendPreview = editor.getByRole("status", { name: "Amend rewrite preview" });
    await expect(amendPreview).toContainText(amendTarget.slice(0, 12));
    await expect(amendPreview).toContainText("原提交 OID 会被新的 OID 替代");
    await editor.getByRole("textbox", { name: "Commit message" }).fill("e2e: amended from Git workbench");
    await editor.getByRole("button", { name: "提交", exact: true }).click();
    await expect.poll(async () => (await fixture.git(["log", "-1", "--pretty=%s"])).stdout.trim(), { timeout: 15_000 }).toBe("e2e: amended from Git workbench");
    await expect(page.getByRole("button", { name: /Git：main/ })).toBeVisible({ timeout: 20_000 });
    expect((await fixture.git(["rev-parse", "HEAD"])).stdout.trim()).not.toBe(amendTarget);
    expect((await fixture.git(["rev-list", "--count", "HEAD"])).stdout.trim()).toBe("2");

    await expect(page.getByRole("treeitem", { name: /push\.txt untracked/ })).toBeVisible({ timeout: 10_000 });
    await selectChange(page, /push\.txt untracked/);
    await page.getByRole("button", { name: "暂存", exact: true }).click();
    await expect.poll(
      async () => (await fixture.git(["diff", "--cached", "--name-only"])).stdout,
      { timeout: 15_000 },
    ).toContain("push.txt");
    await expect(editor).toContainText("1 个已暂存文件", { timeout: 10_000 });
    await editor.getByRole("checkbox", { name: "修订上次提交" }).uncheck();
    await editor.getByRole("textbox", { name: "Commit message" }).fill("e2e: commit and push");
    await editor.getByRole("button", { name: "Commit and Push" }).click();
    await expect(editor.getByRole("status", { name: "Commit result" })).toContainText("Committed and pushed", { timeout: 20_000 });
    expect((await fixture.git(["rev-parse", "origin/main"])).stdout.trim())
      .toBe((await fixture.git(["rev-parse", "HEAD"])).stdout.trim());
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
    await expect(page.getByRole("table", { name: "统一 Diff 内容" })).toContainText("中文修改 😀");
    await page.getByRole("button", { name: "暂存", exact: true }).click();
    await expect.poll(async () => (await fixture.git(["diff", "--cached", "--name-only"])).stdout, { timeout: 15_000 })
      .toContain("中文 空格😀.txt");

    await selectOnlyChange(page, /renamed name\.txt renamed/);
    await expect(page.getByTestId("git-tool-window")).toContainText("old name.txt → renamed name.txt", { timeout: 10_000 });
    await selectOnlyChange(page, /binary\.dat modified/);
    await expect(page.getByTestId("git-tool-window")).toContainText("二进制文件不提供文本 Diff", { timeout: 10_000 });
    await selectOnlyChange(page, /scripts\/run\.sh modified/);
    await expect(page.getByLabel("Mode change")).toContainText("100644 → 100755", { timeout: 10_000 });

    await expect(changes).not.toContainText("ignored.log");
    const ignoredToggle = page.getByRole("checkbox", { name: "显示已忽略文件" });
    await ignoredToggle.check();
    await expect(changes).toContainText("ignored.log", { timeout: 15_000 });
    await expect(changes.getByRole("treeitem", { name: /ignored\.log ignored/ })).toBeVisible();
    await page.reload();
    if (await page.getByRole("checkbox", { name: "显示已忽略文件" }).count() === 0) {
      await openGitToolWindow(page);
    }
    await expect(page.getByRole("checkbox", { name: "显示已忽略文件" })).toBeChecked({ timeout: 20_000 });
    await expect(page.getByRole("tree", { name: "本地改动" })).toContainText("ignored.log");
    await page.getByRole("checkbox", { name: "显示已忽略文件" }).uncheck();
    await expect(page.getByRole("tree", { name: "本地改动" })).not.toContainText("ignored.log");
    await fixture.screenshot(page, "e2e-013-016-017-special-paths-status");
  } finally {
    await fixture.cleanup();
  }
});

test("a staged two-hunk file can unstage one hunk without losing either working-tree edit", async ({ page }) => {
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
    await expect(page.getByRole("button", { name: "取消暂存 Hunk 1" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: "取消暂存 Hunk 2" })).toBeVisible();
    await page.getByRole("button", { name: "取消暂存 Hunk 1" }).click();
    await expect.poll(async () => (await fixture.git(["diff", "--cached", "--", "partial.txt"])).stdout, { timeout: 15_000 })
      .not.toContain("line 2 changed");
    expect((await fixture.git(["diff", "--cached", "--", "partial.txt"])).stdout).toContain("line 22 changed");
    expect((await fixture.git(["show", ":partial.txt"])).stdout).toContain("line 22 changed");
    expect((await fixture.git(["diff", "--", "partial.txt"])).stdout).toContain("line 2 changed");
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
    await fixture.write("cancel-stage.txt", "do not stage after cancel\n");
    await fixture.configurePage(page);
    await page.goto(`${fixture.appBaseUrl}/#/workbench/${fixture.workspaceId}`);
    await openGitToolWindow(page);
    await selectOnlyChange(page, /cancel-stage\.txt untracked/);
    await fixture.write(".git/index.lock", "held by external process\n");
    await page.getByRole("button", { name: "暂存", exact: true }).click({ noWaitAfter: true });
    await page.getByRole("tab", { name: "操作" }).click();
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
    await fixture.write("already-staged.txt", "commit waits for queued stage\n");
    await fixture.git(["add", "--", "already-staged.txt"]);
    await fixture.write("queued-stage.txt", "stage through a transient lock\n");
    await fixture.write("cancel-stage-two.txt", "must remain untracked after cancel\n");

    await fixture.configurePage(page);
    await page.goto(`${fixture.appBaseUrl}/#/workbench/${fixture.workspaceId}`);
    await openGitToolWindow(page);
    await selectOnlyChange(page, /queued-stage\.txt untracked/);
    const editor = page.getByRole("region", { name: "Commit 编辑器" });
    await editor.getByRole("textbox", { name: "Commit message" }).fill("test: serialized stage then commit");
    await fixture.write(".git/index.lock", "short external lock\n");
    const stage = page.getByRole("button", { name: "暂存", exact: true });
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
    expect((await fixture.git(["show", "--pretty=", "--name-only", "HEAD"])).stdout).toContain("already-staged.txt");
    expect((await fixture.git(["show", "--pretty=", "--name-only", "HEAD"])).stdout).toContain("queued-stage.txt");

    await page.getByRole("tab", { name: "操作" }).click();
    const log = page.getByRole("region", { name: "Git 操作日志" });
    await expect(log).toContainText("test: serialized stage then commit", { timeout: 20_000 });
    const commandNamesAfterCommit = await log.locator("article code").allTextContents();
    expect(commandNamesAfterCommit.filter((command) => command === "stage")).toHaveLength(1);
    expect(commandNamesAfterCommit.filter((command) => command === "commit")).toHaveLength(1);
    expect(commandNamesAfterCommit.indexOf("commit")).toBeLessThan(commandNamesAfterCommit.indexOf("stage"));

    await page.getByRole("tab", { name: "本地改动" }).click();
    await selectOnlyChange(page, /cancel-stage-two\.txt untracked/);
    await fixture.write(".git/index.lock", "persistent external lock\n");
    await page.getByRole("button", { name: "暂存", exact: true }).click({ noWaitAfter: true });
    await page.getByRole("tab", { name: "操作" }).click();
    const cancel = log.getByRole("button", { name: "取消操作" });
    await expect(cancel).toBeVisible({ timeout: 15_000 });
    await cancel.click();
    await expect(log).toContainText("已取消", { timeout: 30_000 });
    expect(await fileExists(lockPath)).toBe(true);
    expect((await fixture.git(["diff", "--cached", "--name-only"])).stdout.trim()).toBe("");
    expect((await fixture.git(["status", "--porcelain=v1", "--", "cancel-stage-two.txt"])).stdout).toContain("??");
    await rm(lockPath);

    await page.getByRole("tab", { name: "分支" }).click();
    const sync = page.getByRole("region", { name: "远程同步" });
    await sync.getByRole("combobox", { name: "Fetch remote" }).selectOption("auth-e2e");
    await sync.getByRole("button", { name: "Fetch" }).click();
    await expect(page.getByTestId("git-tool-window")).toContainText(/credentials|authentication/i, { timeout: 30_000 });
    await page.getByRole("tab", { name: "操作" }).click();
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

async function openGitToolWindow(page: Page): Promise<void> {
  const trigger = page.getByRole("button", { name: /Git：main/ });
  await expect(trigger).toBeEnabled({ timeout: 10_000 });
  await trigger.click();
  await page.getByRole("menuitem", { name: "打开 Git 工具窗" }).click();
  await expect(page.getByRole("tablist", { name: "Git 工具窗视图" })).toBeVisible();
}

async function selectChange(page: Page, name: RegExp): Promise<void> {
  const checkbox = page.getByRole("checkbox", { name });
  await expect(checkbox).toBeVisible({ timeout: 20_000 });
  await checkbox.check();
  await expect(checkbox).toBeChecked();
}

async function selectOnlyChange(page: Page, name: RegExp): Promise<void> {
  const tree = page.getByRole("tree", { name: "本地改动" });
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

async function fileExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}
