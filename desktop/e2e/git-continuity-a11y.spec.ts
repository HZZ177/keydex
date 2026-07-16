import { expect, test, type Locator, type Page } from "@playwright/test";

import { startGitE2EFixture } from "./git-e2e-fixtures";

test("Git tool state survives mode changes, close/reopen, responsive layouts and external ref updates", async ({ page }) => {
  test.setTimeout(90_000);
  const fixture = await startGitE2EFixture("continuity-layout");
  try {
    await fixture.write("continuity.txt", "continuity\n");
    await fixture.commit("feat: continuity marker", ["continuity.txt"]);
    await Promise.all(Array.from({ length: 120 }, (_, index) => fixture.write(
      `scale/change-${String(index).padStart(3, "0")}.txt`,
      `change ${index}\n`,
    )));
    await fixture.configurePage(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${fixture.appBaseUrl}/#/workbench/${fixture.workspaceId}`);
    await openGitToolWindow(page);

    const tool = page.getByTestId("git-tool-window");
    const changesTree = page.getByRole("tree", { name: "本地改动" });
    await expect(changesTree).toHaveAttribute("data-virtualized", "true", { timeout: 10_000 });
    expect(await changesTree.getByRole("treeitem").count()).toBeLessThan(60);
    const navigationSplitter = page.getByRole("separator", { name: "调整 Git 仓库导航宽度" });
    const detailSplitter = page.getByRole("separator", { name: "调整 Git 详情宽度" });
    await expect(navigationSplitter).toHaveAttribute("aria-valuenow", "19");
    await navigationSplitter.press("ArrowRight");
    await expect(navigationSplitter).toHaveAttribute("aria-valuenow", "21");
    await expect(detailSplitter).toHaveAttribute("aria-valuenow", "28");
    const repositories = page.getByRole("listbox", { name: "Git repository roots" });
    await expect(repositories.getByRole("option")).toHaveCount(2, { timeout: 10_000 });
    await expect(repositories.getByRole("option").first()).toHaveAttribute("aria-selected", "true");

    await page.getByRole("tab", { name: "提交历史" }).click();
    const filters = page.getByRole("form", { name: "History filters" });
    await filters.getByRole("textbox", { name: "Message or commit hash" }).fill("continuity marker");
    await filters.getByRole("button", { name: "Apply" }).click();
    const selectedCommit = page.getByRole("option", { name: /feat: continuity marker/ });
    await expect(selectedCommit).toBeVisible();
    await selectedCommit.click();
    await expect(selectedCommit).toHaveAttribute("aria-selected", "true");

    const modes = page.getByTestId("app-mode-switch");
    await modes.getByRole("button", { name: "Agent" }).click();
    await expect(page).toHaveURL(/#\/guid(?:\?|$)/);
    await expect(tool).toBeVisible();
    await expect(page.getByRole("tab", { name: "提交历史" })).toHaveAttribute("aria-selected", "true");
    await expect(filters.getByRole("textbox", { name: "Message or commit hash" })).toHaveValue("continuity marker");
    await expect(page.getByRole("option", { name: /feat: continuity marker/ })).toHaveAttribute("aria-selected", "true");
    await modes.getByRole("button", { name: "工作台模式" }).click();
    await expect(page).toHaveURL(new RegExp(`#\\/workbench\\/${fixture.workspaceId}(?:\\?|$)`));
    await expect(modes.getByRole("button", { name: "工作台模式" })).toHaveAttribute("aria-pressed", "true");
    await expect(tool).toBeVisible();
    await expect(page.getByRole("option", { name: /feat: continuity marker/ })).toHaveAttribute("aria-selected", "true");

    await page.getByRole("button", { name: "关闭侧边栏窗口 Git" }).click();
    await expect(tool).toBeHidden();
    await openGitToolWindow(page);
    await expect(page.getByRole("tab", { name: "提交历史" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("form", { name: "History filters" }).getByRole("textbox", { name: "Message or commit hash" })).toHaveValue("continuity marker");
    await expect(page.getByRole("option", { name: /feat: continuity marker/ })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("separator", { name: "调整 Git 仓库导航宽度" })).toHaveAttribute("aria-valuenow", "21");

    await fixture.createBranch("external-refresh");
    const trigger = gitTrigger(page);
    await trigger.click();
    const search = page.getByRole("textbox", { name: "搜索 Git 分支和操作" });
    await search.fill("external-refresh");
    await expect(page.getByRole("menu", { name: "项目 Git 菜单" }).getByRole("treeitem", { name: /external-refresh/ })).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press("Escape");

    await assertInsideViewport(page.getByRole("tab", { name: "操作" }), 1280);
    if (await tool.getAttribute("data-layout") === "maximized") {
      await page.locator('button[data-icon="minimize-2"]').click();
      await expect(tool).toHaveAttribute("data-layout", "split");
    }
    await page.locator('button[data-icon="maximize-2"]').click();
    await expect(tool).toHaveAttribute("data-layout", "maximized");
    await page.setViewportSize({ width: 1920, height: 1080 });
    await assertInsideViewport(page.getByRole("tab", { name: "操作" }), 1920);
    await assertInsideViewport(page.getByRole("button", { name: "缩小右侧栏" }), 1920);
    await fixture.screenshot(page, "e2e-069-077-continuity-layout");
  } finally {
    await fixture.cleanup();
  }
});

test("titlebar Git menu supports branch checkout and opening the tool window with keyboard only", async ({ page }) => {
  test.setTimeout(60_000);
  const fixture = await startGitE2EFixture("keyboard-menu");
  try {
    await fixture.createBranch("e2e-git-feature");
    await fixture.git(["tag", "v1.0.0-menu-e2e"]);
    await fixture.git(["push", "origin", "HEAD:refs/heads/e2e-git-remote"]);
    await fixture.git(["fetch", "origin"]);
    await fixture.configurePage(page);
    await page.goto(`${fixture.appBaseUrl}/#/workbench/${fixture.workspaceId}`);

    const trigger = gitTrigger(page);
    await expect(trigger).toBeEnabled({ timeout: 20_000 });
    await trigger.focus();
    await page.keyboard.press("ArrowDown");
    const search = page.getByRole("textbox", { name: "搜索 Git 分支和操作" });
    await expect(search).toBeFocused();
    await search.fill("e2e-git-remote");
    await expect(page.getByRole("treeitem", { name: /origin\/e2e-git-remote/ })).toBeVisible();
    await search.fill("v1.0.0-menu-e2e");
    await expect(page.getByRole("treeitem", { name: /v1\.0\.0-menu-e2e/ })).toBeVisible();
    await search.fill("e2e-git-feature");
    const feature = page.getByRole("treeitem", { name: /e2e-git-feature/ });
    await expect(feature).toBeVisible();
    await search.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(feature).toBeFocused();
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await fixture.git(["branch", "--show-current"])).stdout.trim(), { timeout: 15_000 }).toBe("e2e-git-feature");
    await expect(gitTrigger(page)).toContainText("e2e-git-feature");

    await gitTrigger(page).focus();
    await page.keyboard.press("ArrowDown");
    await expect(search).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(gitTrigger(page)).toBeFocused();
    await expect(page.getByRole("menu", { name: "项目 Git 菜单" })).toBeHidden();

    await page.keyboard.press("ArrowDown");
    await search.fill("打开");
    const openToolWindow = page.getByRole("menuitem", { name: "打开 Git 面板" });
    await expect(openToolWindow).toBeVisible();
    await search.press("ArrowDown");
    await expect(openToolWindow).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("tablist", { name: "Git 面板视图" })).toBeVisible();
    await fixture.screenshot(page, "e2e-078-keyboard-titlebar");
  } finally {
    await fixture.cleanup();
  }
});

function gitTrigger(page: Page): Locator {
  return page.getByRole("button", { name: /Git：/ });
}

async function openGitToolWindow(page: Page): Promise<void> {
  const trigger = gitTrigger(page);
  await expect(trigger).toBeEnabled({ timeout: 20_000 });
  await trigger.click();
  await page.getByRole("menuitem", { name: "打开 Git 面板" }).click();
  await expect(page.getByRole("tablist", { name: "Git 面板视图" })).toBeVisible();
}

async function assertInsideViewport(locator: Locator, viewportWidth: number): Promise<void> {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewportWidth);
}
