import { access } from "node:fs/promises";

import { expect, test } from "@playwright/test";

import { startGitBaseE2EFixture, startGitE2EFixture } from "./git-e2e-fixtures";

test.describe.configure({ mode: "serial" });

test("Git entry is globally visible but disabled without a current project", async ({ page }) => {
  const fixture = await startGitBaseE2EFixture("e2e-git-no-project");
  try {
    await fixture.configurePage(page);
    await page.route(`${fixture.baseUrl}/api/workspaces`, (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ list: [] }),
    }));
    await page.goto(`${fixture.appBaseUrl}/#/guid`);

    const trigger = page.getByRole("button", { name: "Git：加载项目后可用" });
    await expect(trigger).toBeVisible();
    await expect(trigger).toBeDisabled();
    for (const mode of ["Agent", "工作台模式", "项目模式"] as const) {
      await page.getByRole("button", { name: mode }).click();
      await expect(page.getByRole("button", { name: "Git：加载项目后可用" })).toBeVisible();
    }
  } finally {
    await fixture.stop();
  }
});

test("a non-repository project can be initialized from the titlebar", async ({ page }) => {
  const fixture = await startGitBaseE2EFixture("e2e-git-init-project");
  try {
    await fixture.configurePage(page);
    await page.goto(`${fixture.appBaseUrl}/#/workbench/${fixture.workspaceId}`);
    const trigger = page.getByRole("button", { name: /Git：/ });
    await expect(trigger).toBeEnabled();
    await trigger.click();
    await expect(page.getByRole("menuitem", { name: /初始化 Git 仓库/ })).toBeVisible();
    await page.getByRole("menuitem", { name: /初始化 Git 仓库/ }).click();

    await expect.poll(async () => access(`${fixture.workspaceRoot}/.git/HEAD`).then(() => true).catch(() => false), { timeout: 10_000 }).toBe(true);
    await expect(page.getByRole("button", { name: /Git：(读取中|main|master)/ })).toBeVisible();
  } finally {
    await fixture.stop();
  }
});

test("all three modes share one real-repository Git menu and one tool window", async ({ page }) => {
  const fixture = await startGitE2EFixture("shell-and-entry");
  try {
    await fixture.write("dirty.txt", "visible local change\n");
    await fixture.configurePage(page);
    await page.goto(`${fixture.appBaseUrl}/#/workbench/${fixture.workspaceId}`);

    for (const mode of ["工作台模式", "Agent"] as const) {
      await page.getByRole("button", { name: mode }).click();
      const trigger = page.getByRole("button", { name: /Git：main/ });
      await expect(trigger).toBeVisible();
      await expect(trigger).toBeEnabled();
    }
    await page.getByRole("button", { name: "项目模式" }).click();
    await expect(page.getByRole("button", { name: "Git：加载项目后可用" })).toBeDisabled();
    await page.getByRole("button", { name: "工作台模式" }).click();
    await expect(page.getByRole("button", { name: /Git：main/ })).toBeEnabled();

    const trigger = page.getByRole("button", { name: /Git：main/ });
    await trigger.click();
    await expect(page.getByRole("menu", { name: "项目 Git 菜单" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /更新项目/ })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /提交/ })).toBeEnabled();
    await expect(page.getByRole("menuitem", { name: /推送/ })).toBeVisible();
    await page.getByRole("menuitem", { name: /新建分支/ }).click();
    await expect(page.getByRole("dialog", { name: "创建新分支" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "创建新分支" })).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await trigger.click();
    await page.getByRole("menuitem", { name: "打开 Git 面板" }).click();

    await expect(page.getByTestId("app-shell")).toHaveAttribute("data-primary-surface", "git");
    await expect(page.getByTestId("git-tool-window")).toHaveCount(1);
    await expect(page.getByRole("tab", { name: "Git", exact: true })).toHaveCount(0);
    await expect(page.getByRole("tablist", { name: "Git 面板视图" })).toBeVisible();
    await expect(page.getByRole("tree", { name: "本地改动" })).toContainText("dirty.txt");
    await fixture.screenshot(page, "e2e-005-git-shell");

    await trigger.click();
    await page.getByRole("menuitem", { name: "打开 Git 面板" }).click();
    await expect(page.getByTestId("git-tool-window")).toHaveCount(1);

    await trigger.click();
    await page.getByRole("menuitem", { name: "Git 帮助与风险说明" }).click();
    const help = page.getByRole("dialog", { name: "Git 操作与风险说明" });
    await expect(help).toContainText("提供合并与变基两种方式");
    await expect(help).toContainText("失败后不会自动切换");
    await expect(help).toContainText("祖先仓库");
    await expect(help).toContainText("二次确认");
    await expect(help).toContainText("Stack-Cairn/LiveAgent");
    await expect(help).toContainText("1616eb5e574274693dc29e18248650dc30911123");
    await expect(help).toContainText("MIT 许可证");
    await fixture.screenshot(page, "e2e-080-git-help");
    await page.getByRole("button", { name: "关闭 Git 帮助" }).click();
  } finally {
    await fixture.cleanup();
  }
});

test("unavailable system Git disables the shortcut while keeping the primary panel reachable", async ({ page }) => {
  const fixture = await startGitBaseE2EFixture("e2e-git-unavailable");
  const capability = {
    available: false,
    executable: null,
    version: null,
    supports_switch: false,
    supports_restore: false,
    supports_pathspec_from_file: false,
    lfs_available: false,
    reason: "git executable was not found",
  };
  try {
    await fixture.configurePage(page);
    await page.route("**/api/git/capabilities", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(capability),
    }));
    await page.route("**/api/git/repositories/discover", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ capability, repositories: [], ancestor_candidate: null }),
    }));
    await page.goto(`${fixture.appBaseUrl}/#/workbench/${fixture.workspaceId}`);

    const trigger = page.getByRole("button", { name: "Git：系统 Git 不可用" });
    await expect(trigger).toBeVisible({ timeout: 15_000 });
    await expect(trigger).toBeDisabled();
    const primaryEntry = page.getByRole("button", { name: "Git", exact: true });
    await expect(primaryEntry).toBeVisible();
    await expect(primaryEntry).toBeEnabled();
    await primaryEntry.click();
    await expect(page.getByTestId("app-shell")).toHaveAttribute("data-primary-surface", "git");
    await expect(page.getByRole("tab", { name: "Git", exact: true })).toHaveCount(0);
    await page.screenshot({ path: `${fixture.runDir}/e2e-012-git-unavailable.png`, fullPage: true });
  } finally {
    await fixture.stop();
  }
});

test("a damaged HEAD becomes a diagnostic error and retry restores the repository after repair", async ({ page }) => {
  test.setTimeout(90_000);
  const fixture = await startGitE2EFixture("damaged-head-retry");
  try {
    await fixture.write(".git/HEAD", "ref: refs/heads/\n");
    await fixture.configurePage(page);
    await page.goto(`${fixture.appBaseUrl}/#/workbench/${fixture.workspaceId}`);
    const trigger = page.getByRole("button", { name: /Git：(不可用|Git)/ });
    await expect(trigger).toBeEnabled({ timeout: 20_000 });
    await trigger.click();
    await page.getByRole("menuitem", { name: "打开 Git 面板" }).click();
    const diagnostic = page.getByRole("alert");
    await expect(diagnostic).toContainText("Git 仓库加载失败", { timeout: 20_000 });
    await expect(diagnostic).toContainText("无法解析 Git 输出");
    await expect(diagnostic).not.toContainText(/Traceback|Authorization:|password=/i);

    await fixture.write(".git/HEAD", "ref: refs/heads/main\n");
    await diagnostic.getByRole("button", { name: "重试" }).click();
    await expect(page.getByRole("tablist", { name: "Git 面板视图" })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("button", { name: /Git：main/ })).toBeEnabled();
    await fixture.screenshot(page, "e2e-011-damaged-head-retry");
  } finally {
    await fixture.cleanup();
  }
});
