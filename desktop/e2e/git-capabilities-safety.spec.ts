import { expect, test, type Dialog, type Page } from "@playwright/test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { startGitE2EFixture } from "./git-e2e-fixtures";

test("submodule, worktree and LFS capabilities load independently with exact paths and safe degradation", async ({ page }) => {
  test.setTimeout(120_000);
  const fixture = await startGitE2EFixture("capability-submodule-worktree-lfs");
  try {
    const submoduleSource = path.join(fixture.runDir, "submodule-source");
    await mkdir(submoduleSource, { recursive: true });
    await fixture.git(["init", "-b", "main"], submoduleSource);
    await fixture.git(["config", "user.name", "Keydex Submodule E2E"], submoduleSource);
    await fixture.git(["config", "user.email", "keydex-submodule@example.invalid"], submoduleSource);
    await writeFile(path.join(submoduleSource, "module.txt"), "local submodule content\n", "utf8");
    await fixture.git(["add", "--", "module.txt"], submoduleSource);
    await fixture.git(["commit", "-m", "test: submodule source"], submoduleSource);
    await fixture.git(["-c", "protocol.file.allow=always", "submodule", "add", submoduleSource, "modules/local"]);
    await fixture.commit("test: add local submodule", [".gitmodules", "modules/local"]);
    const worktreeRoot = path.join(fixture.runDir, "external-worktree");
    await fixture.git(["worktree", "add", "-b", "worktree/e2e", worktreeRoot, "HEAD"]);

    await fixture.configurePage(page);
    await page.goto(`${fixture.appBaseUrl}/#/workbench/${fixture.workspaceId}`);
    await openGitToolWindow(page);
    await page.getByRole("tab", { name: "操作" }).click();

    const submodules = page.getByRole("region", { name: "Git submodules" });
    await expect(submodules).toContainText("modules/local", { timeout: 30_000 });
    await expect(submodules).toContainText("clean");
    await expect(submodules).toContainText(submoduleSource);
    await expect(submodules.getByRole("checkbox", { name: "Select modules/local" })).toBeChecked();

    const worktrees = page.getByRole("region", { name: "Git worktrees" });
    await expect(worktrees).toContainText(worktreeRoot.replaceAll("\\", "/"), { timeout: 30_000 });
    await expect(worktrees).toContainText("worktree/e2e");
    await expect(worktrees).toContainText("external");
    await expect(worktrees.getByRole("button", { name: "Authorize", exact: true })).toBeVisible();

    const lfs = page.getByRole("region", { name: "Git LFS" });
    await expect(lfs).not.toContainText("Loading Git LFS status", { timeout: 30_000 });
    const unavailable = lfs.getByRole("status");
    if (await unavailable.isVisible().catch(() => false)) {
      await expect(unavailable).toContainText("Git LFS unavailable");
      await expect(lfs).toContainText("never installs Git LFS automatically");
      await expect(lfs.getByRole("button", { name: "Fetch objects" })).toBeDisabled();
      await expect(lfs.getByRole("button", { name: "Pull & checkout" })).toBeDisabled();
      await expect(lfs.getByRole("button", { name: "Push objects" })).toBeDisabled();
    } else {
      await expect(lfs).toContainText("LFS files");
      await expect(lfs).toContainText("tracked patterns");
      await expect(lfs.getByRole("button", { name: "Fetch objects" })).toBeEnabled();
    }
    await fixture.screenshot(page, "e2e-075-submodule-worktree-lfs-capabilities");
  } finally {
    await fixture.cleanup();
  }
});

test("high-risk reset rejects option injection and requires both confirmations before untracked data loss", async ({ page }) => {
  test.setTimeout(120_000);
  const fixture = await startGitE2EFixture("high-risk-confirmation-injection");
  try {
    await fixture.write("collision.txt", "tracked target content\n");
    await fixture.commit("test: collision exists at reset target", ["collision.txt"]);
    const target = (await fixture.git(["rev-parse", "HEAD"])).stdout.trim();
    await fixture.git(["rm", "--", "collision.txt"]);
    await fixture.git(["commit", "-m", "test: remove collision at current head"]);
    const originalHead = (await fixture.git(["rev-parse", "HEAD"])).stdout.trim();
    await fixture.write("collision.txt", "untracked sentinel must survive cancellation\n");
    await fixture.write("sentinel.keep", "option injection must never touch this file\n");

    await fixture.configurePage(page);
    await page.goto(`${fixture.appBaseUrl}/#/workbench/${fixture.workspaceId}`);
    await openGitToolWindow(page);
    await page.getByRole("tab", { name: "操作" }).click();
    const reset = page.getByRole("region", { name: "Reset and restore" });
    await reset.getByRole("textbox", { name: "Reset target" }).fill("--hard");
    await reset.getByRole("combobox", { name: "Reset mode" }).selectOption("hard");
    await reset.getByRole("button", { name: "Preview reset" }).click();
    await expect(page.getByTestId("git-tool-window").getByRole("alert").first()).toContainText(/unsafe|valid Git revision|invalid/i, { timeout: 20_000 });
    expect((await fixture.git(["rev-parse", "HEAD"])).stdout.trim()).toBe(originalHead);
    expect(await readFile(path.join(fixture.repositoryRoot, "sentinel.keep"), "utf8")).toContain("never touch");

    await reset.getByRole("textbox", { name: "Reset target" }).fill(target);
    await reset.getByRole("button", { name: "Preview reset" }).click();
    await expect(reset).toContainText("untracked-loss", { timeout: 20_000 });
    await expect(reset.getByRole("alert")).toContainText("Untracked data will be overwritten");
    await expect(reset.getByRole("alert")).toContainText("collision.txt");
    await expect(reset.getByRole("list", { name: "Reset affected files" })).toContainText("collision.txt");
    await expect(reset).toContainText("HEAD@{1}");
    await expect(reset).toContainText("ORIG_HEAD");

    let dialogCount = 0;
    const cancelSecondConfirmation = (dialog: Dialog) => {
      dialogCount += 1;
      if (dialogCount === 1) void dialog.accept();
      else void dialog.dismiss();
    };
    page.on("dialog", cancelSecondConfirmation);
    await reset.getByRole("button", { name: "Reset to target" }).click();
    await expect.poll(() => dialogCount, { timeout: 10_000 }).toBe(2);
    page.off("dialog", cancelSecondConfirmation);
    expect((await fixture.git(["rev-parse", "HEAD"])).stdout.trim()).toBe(originalHead);
    expect(await readFile(path.join(fixture.repositoryRoot, "collision.txt"), "utf8")).toContain("untracked sentinel");

    page.on("dialog", (dialog) => dialog.accept());
    await reset.getByRole("button", { name: "Reset to target" }).click();
    await expect.poll(async () => (await fixture.git(["rev-parse", "HEAD"])).stdout.trim(), { timeout: 30_000 }).toBe(target);
    expect(await readFile(path.join(fixture.repositoryRoot, "collision.txt"), "utf8")).toBe("tracked target content\n");
    expect(await readFile(path.join(fixture.repositoryRoot, "sentinel.keep"), "utf8")).toContain("never touch");
    expect((await fixture.git(["reflog", "-1", "--format=%H", "HEAD@{1}"])).stdout.trim()).toBe(originalHead);
    await fixture.screenshot(page, "e2e-076-high-risk-confirmation-injection");
  } finally {
    await rm(path.join(fixture.repositoryRoot, "sentinel.keep"), { force: true }).catch(() => undefined);
    await fixture.cleanup();
  }
});

async function openGitToolWindow(page: Page): Promise<void> {
  const trigger = page.getByRole("button", { name: /Git：main/ });
  await expect(trigger).toBeEnabled({ timeout: 20_000 });
  await trigger.click();
  await page.getByRole("menuitem", { name: "打开 Git 面板" }).click();
  await expect(page.getByRole("tablist", { name: "Git 面板视图" })).toBeVisible();
}
