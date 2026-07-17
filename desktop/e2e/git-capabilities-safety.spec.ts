import { expect, test, type Page } from "@playwright/test";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
    await writeFile(path.join(worktreeRoot, "dirty-worktree.txt"), "dirty worktree content\n", "utf8");

    await fixture.configurePage(page);
    await page.goto(`${fixture.appBaseUrl}/#/workbench/${fixture.workspaceId}`);
    await openGitToolWindow(page);
    await openAdvancedGitView(page);

    const submodules = page.getByRole("region", { name: "Git 子模块" });
    await expect(submodules).toContainText("modules/local", { timeout: 30_000 });
    await expect(submodules).toContainText("状态未知");
    await expect(submodules).toContainText(submoduleSource);
    await expect(submodules.getByRole("checkbox", { name: "选择 modules/local" })).toBeChecked();

    const worktrees = page.getByRole("region", { name: "Git 工作树" });
    await expect(worktrees).toContainText(worktreeRoot.replaceAll("\\", "/"), { timeout: 30_000 });
    await expect(worktrees).toContainText("worktree/e2e");
    await expect(worktrees).toContainText("外部路径");
    await worktrees.getByRole("button", { name: "授权", exact: true }).click();
    const authorizeDialog = page.getByRole("dialog", { name: "确认授权外部工作树" });
    await expect(authorizeDialog).toContainText(worktreeRoot.replaceAll("\\", "/"));
    await authorizeDialog.getByRole("button", { name: "取消" }).click();
    await expect(worktrees.getByRole("button", { name: "移除" })).toBeDisabled();
    await worktrees.getByRole("button", { name: "授权", exact: true }).click();
    await authorizeDialog.getByRole("button", { name: "确认授权" }).click();
    await expect(worktrees.getByRole("button", { name: "撤销授权" })).toBeVisible({ timeout: 30_000 });
    await expect(worktrees).toContainText("有改动");
    await worktrees.getByRole("button", { name: "移除" }).click();
    const removeWorktreeDialog = page.getByRole("dialog", { name: "确认移除工作树" });
    await expect(removeWorktreeDialog).toContainText("强制丢弃这些改动");
    await removeWorktreeDialog.getByRole("button", { name: "取消" }).click();
    await expect.poll(async () => accessExists(worktreeRoot)).toBe(true);
    await worktrees.getByRole("button", { name: "移除" }).click();
    await removeWorktreeDialog.getByRole("button", { name: "确认移除" }).click();
    await expect.poll(async () => accessExists(worktreeRoot), { timeout: 30_000 }).toBe(false);

    await submodules.getByRole("button", { name: "取消初始化" }).click();
    const deinitDialog = page.getByRole("dialog", { name: "确认取消初始化子模块" });
    await deinitDialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect.poll(async () => accessExists(path.join(fixture.repositoryRoot, "modules", "local", "module.txt"))).toBe(true);
    await submodules.getByRole("button", { name: "取消初始化" }).click();
    await deinitDialog.getByRole("button", { name: "确认取消初始化" }).click();
    await expect.poll(async () => (await fixture.git(["submodule", "status", "modules/local"])).stdout.trim(), { timeout: 30_000 }).toMatch(/^-/);

    const lfs = page.getByRole("region", { name: "Git 大文件存储" });
    await expect(lfs).not.toContainText("正在读取 Git 大文件存储状态", { timeout: 30_000 });
    const unavailable = lfs.getByRole("status");
    if (await unavailable.isVisible().catch(() => false)) {
      await expect(unavailable).toContainText("Git 大文件存储不可用");
      await expect(lfs).toContainText("请单独安装 Git 大文件存储扩展");
      await expect(lfs.getByRole("button", { name: "获取对象" })).toBeDisabled();
      await expect(lfs.getByRole("button", { name: "拉取并签出" })).toBeDisabled();
      await expect(lfs.getByRole("button", { name: "推送对象…" })).toBeDisabled();
    } else {
      await expect(lfs).toContainText("个大文件");
      await expect(lfs).toContainText("个跟踪模式");
      await expect(lfs.getByRole("button", { name: "获取对象" })).toBeEnabled();
    }
    await fixture.screenshot(page, "e2e-075-submodule-worktree-lfs-capabilities");
  } finally {
    await fixture.cleanup();
  }
});

test("high-risk reset rejects option injection and requires formal confirmation before untracked data loss", async ({ page }) => {
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
    await openAdvancedGitView(page);
    const reset = page.getByRole("region", { name: "重置与还原" });
    await reset.getByRole("textbox", { name: "重置目标" }).fill("--hard");
    await reset.getByRole("combobox", { name: "重置模式" }).selectOption("hard");
    await reset.getByRole("button", { name: "预览重置" }).click();
    await expect(page.getByTestId("git-tool-window").getByRole("alert").first()).toContainText(/输入不符合要求|参数.*未通过校验/, { timeout: 20_000 });
    expect((await fixture.git(["rev-parse", "HEAD"])).stdout.trim()).toBe(originalHead);
    expect(await readFile(path.join(fixture.repositoryRoot, "sentinel.keep"), "utf8")).toContain("never touch");

    await reset.getByRole("textbox", { name: "重置目标" }).fill(target);
    await reset.getByRole("button", { name: "预览重置" }).click();
    await expect(reset).toContainText("可能丢失未跟踪数据", { timeout: 20_000 });
    await expect(reset.getByRole("alert")).toContainText("未跟踪数据将被覆盖");
    await expect(reset.getByRole("alert")).toContainText("collision.txt");
    await expect(reset.getByRole("list", { name: "重置影响的文件" })).toContainText("collision.txt");

    await reset.getByRole("button", { name: "重置到目标" }).click();
    const resetDialog = page.getByRole("dialog", { name: "确认重置分支" });
    await expect(resetDialog).toContainText("collision.txt");
    await expect(resetDialog).toContainText("HEAD@{1}");
    await expect(resetDialog).toContainText(target.slice(0, 12));
    await resetDialog.getByRole("button", { name: "取消" }).click();
    expect((await fixture.git(["rev-parse", "HEAD"])).stdout.trim()).toBe(originalHead);
    expect(await readFile(path.join(fixture.repositoryRoot, "collision.txt"), "utf8")).toContain("untracked sentinel");

    await reset.getByRole("button", { name: "重置到目标" }).click();
    await resetDialog.getByRole("button", { name: "确认重置" }).click();
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

async function openAdvancedGitView(page: Page): Promise<void> {
  await page.getByRole("button", { name: "更多 Git 视图" }).click();
  await page.getByRole("menuitem", { name: /高级 Git 工具/ }).click();
  await expect(page.getByRole("region", { name: "合并流程" })).toBeVisible();
}

async function accessExists(target: string): Promise<boolean> {
  return access(target).then(() => true).catch(() => false);
}
