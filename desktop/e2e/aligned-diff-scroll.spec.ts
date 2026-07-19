import { expect, test, type Locator, type Page } from "@playwright/test";

import { startGitE2EFixture } from "./git-e2e-fixtures";
import {
  APP_BASE,
  SESSION_A,
  WORKSPACE_A,
  createWorkbenchBackend,
  installWebSocketMock,
  mockWorkbenchBackend,
  type E2EWorkspaceTreeEntry,
} from "./workbench-e2e-fixtures";

const PREVIEW_PATH = "aligned-scroll.patch";
const PREVIEW_PATCH = buildUnevenPatch("src/aligned-scroll.ts");
const PREVIEW_TREE: E2EWorkspaceTreeEntry[] = [{
  name: PREVIEW_PATH,
  path: PREVIEW_PATH,
  type: "file",
  size: PREVIEW_PATCH.length,
  modified_at: null,
}];

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 2000, height: 1000 });
  await page.emulateMedia({ reducedMotion: "reduce" });
});

test("Preview 的智能并排滚动可同步、可独立、可重新对齐并保留响应式偏好", async ({ page }) => {
  test.setTimeout(90_000);
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const backend = createWorkbenchBackend({
    workspaceFiles: { [PREVIEW_PATH]: PREVIEW_PATCH },
    workspaceTreeEntries: PREVIEW_TREE,
  });
  await installWebSocketMock(page);
  await mockWorkbenchBackend(page, backend);
  await page.goto(`${APP_BASE}/#/workbench/${WORKSPACE_A}/session/${SESSION_A}`, { waitUntil: "commit" });
  await page.getByRole("button", { name: `选择文件 ${PREVIEW_PATH}` }).click();

  const preview = page.locator('[data-keydex-diff-wrapper="preview"]').last();
  await expect(preview).toBeVisible();
  await preview.getByRole("button", { name: "切换为并排视图" }).click();
  await expect(preview.locator('[data-keydex-diff-layout-bridge="true"]')).toHaveAttribute("data-layout", "split");

  const aligned = preview.locator("[data-keydex-aligned-split]");
  const left = aligned.locator('[data-keydex-aligned-pane="old"]');
  const right = aligned.locator('[data-keydex-aligned-pane="new"]');
  await expect(aligned).toBeVisible();
  await expect(left.locator("[data-keydex-aligned-row]").first()).toBeVisible();
  await expect(right.locator("[data-keydex-aligned-row]").first()).toBeVisible();
  await expect.poll(() => isScrollable(left)).toBe(true);
  await expect.poll(() => isScrollable(right)).toBe(true);

  await wheelPane(page, left, 2_400);
  await expect.poll(() => scrollTop(left)).toBeGreaterThan(100);
  await page.waitForTimeout(160);
  expect(pageErrors).toEqual([]);
  await expect.poll(() => scrollTop(right)).toBeGreaterThan(100);
  const synchronizedRight = await scrollTop(right);
  const synchronizedLeft = await scrollTop(left);

  await left.evaluate((element) => {
    element.scrollLeft = Math.min(120, Math.max(0, element.scrollWidth - element.clientWidth));
    element.dispatchEvent(new Event("scroll"));
  });
  await page.waitForTimeout(80);
  expect(Math.abs((await scrollTop(left)) - synchronizedLeft)).toBeLessThanOrEqual(1);
  expect(Math.abs((await scrollTop(right)) - synchronizedRight)).toBeLessThanOrEqual(1);

  await preview.getByRole("button", { name: "关闭同步滚动" }).click();
  await expect(preview.getByRole("button", { name: "开启同步滚动" })).toHaveAttribute("aria-pressed", "false");
  await wheelPane(page, left, 480);
  await page.waitForTimeout(120);
  expect(Math.abs((await scrollTop(right)) - synchronizedRight)).toBeLessThanOrEqual(1);

  await preview.getByRole("button", { name: "开启同步滚动" }).click();
  await expect(preview.getByRole("button", { name: "关闭同步滚动" })).toHaveAttribute("aria-pressed", "true");
  await wheelPane(page, left, 360);
  await expect.poll(() => scrollTop(right)).not.toBe(synchronizedRight);

  await preview.getByRole("button", { name: "下一个差异" }).click();
  await expect(aligned.locator('[data-keydex-aligned-row][data-active="true"]').first()).toBeVisible();

  await page.setViewportSize({ width: 860, height: 760 });
  await expect(preview.locator('[data-keydex-diff-layout-bridge="true"]')).toHaveAttribute("data-layout", "stacked");
  await expect(preview.locator('[data-keydex-diff-layout-bridge="true"]')).toHaveAttribute("data-preferred-layout", "split");
  await page.setViewportSize({ width: 2000, height: 1000 });
  await expect(preview.locator('[data-keydex-diff-layout-bridge="true"]')).toHaveAttribute("data-layout", "split");
  await expect(preview.locator("[data-keydex-aligned-split]")).toBeVisible();
});

test("真实 Git 仓库的并排视图保持语义同步且只执行文件级暂存", async ({ page }) => {
  test.setTimeout(120_000);
  const fixture = await startGitE2EFixture("aligned-smart-scroll");
  try {
    const baseline = Array.from({ length: 720 }, (_, index) => `baseline ${index + 1}`);
    const changed = [
      ...baseline.slice(0, 110),
      ...Array.from({ length: 45 }, (_, index) => `inserted-a ${index + 1}`),
      ...baseline.slice(110, 240),
      ...baseline.slice(285, 510),
      ...Array.from({ length: 8 }, (_, index) => `inserted-b ${index + 1}`),
      ...baseline.slice(510),
    ];
    await fixture.write("scroll.ts", `${baseline.join("\n")}\n`);
    await fixture.commit("test: aligned scroll baseline", ["scroll.ts"]);
    await fixture.write("scroll.ts", `${changed.join("\n")}\n`);
    await fixture.configurePage(page);
    await page.goto(`${fixture.appBaseUrl}/#/workbench/${fixture.workspaceId}`, { waitUntil: "domcontentloaded" });
    await openGitToolWindow(page);

    const row = page.getByRole("tree", { name: "本地改动" }).getByRole("treeitem", { name: /scroll\.ts modified/ });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.click();
    const git = page.locator('[data-keydex-diff-wrapper="git"]').last();
    const aligned = git.locator("[data-keydex-aligned-split]");
    await expect(aligned).toBeVisible({ timeout: 30_000 });
    await expect(git.getByText("仅应用这个变更块", { exact: true })).toHaveCount(0);
    await expect(git.getByRole("button", { name: /暂存变更块|取消暂存变更块/ })).toHaveCount(0);

    const left = aligned.locator('[data-keydex-aligned-pane="old"]');
    const right = aligned.locator('[data-keydex-aligned-pane="new"]');
    await expect.poll(() => isScrollable(left)).toBe(true);
    await wheelPane(page, left, 2_800);
    await expect.poll(() => scrollTop(left)).toBeGreaterThan(20);
    await expect.poll(() => scrollTop(right)).toBeGreaterThan(20);

    await git.getByRole("button", { name: "暂存文件" }).click();
    await expect.poll(
      async () => (await fixture.git(["diff", "--cached", "--name-only"])).stdout.trim(),
      { timeout: 20_000 },
    ).toBe("scroll.ts");
    const staged = page.locator('[data-keydex-diff-wrapper="git"][data-git-action-mode="unstage"]');
    await expect(staged.getByRole("button", { name: "取消暂存文件" })).toBeVisible({ timeout: 20_000 });
  } finally {
    await fixture.cleanup();
  }
});

async function openGitToolWindow(page: Page) {
  const trigger = page.getByRole("button", { name: /Git：main/ });
  await expect(trigger).toBeEnabled({ timeout: 20_000 });
  await trigger.click();
  await page.getByRole("menuitem", { name: "打开 Git 面板" }).click();
  await expect(page.getByRole("tablist", { name: "Git 面板视图" })).toBeVisible();
}

async function scrollTop(locator: Locator) {
  return locator.evaluate((element) => element.scrollTop);
}

async function isScrollable(locator: Locator) {
  return locator.evaluate((element) => element.scrollHeight > element.clientHeight + 1);
}

async function wheelPane(page: Page, locator: Locator, deltaY: number) {
  await locator.hover({ position: { x: 80, y: 120 } });
  await page.mouse.wheel(0, deltaY);
}

function buildUnevenPatch(path: string) {
  const firstContext = Array.from({ length: 120 }, (_, index) => ` context-a-${index + 1}`);
  const firstRemoved = Array.from({ length: 70 }, (_, index) => `-removed-a-${index + 1}`);
  const firstAdded = Array.from({ length: 12 }, (_, index) => `+added-a-${index + 1}`);
  const middleContext = Array.from({ length: 180 }, (_, index) => ` context-b-${index + 1}`);
  const secondRemoved = Array.from({ length: 12 }, (_, index) => `-removed-b-${index + 1}`);
  const secondAdded = Array.from({ length: 70 }, (_, index) => `+added-b-${index + 1}`);
  const finalContext = Array.from({ length: 120 }, (_, index) => ` context-c-${index + 1}`);
  const oldLines = 120 + 70 + 180 + 12 + 120;
  const newLines = 120 + 12 + 180 + 70 + 120;
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${oldLines} +1,${newLines} @@`,
    ...firstContext,
    ...firstRemoved,
    ...firstAdded,
    ...middleContext,
    ...secondRemoved,
    ...secondAdded,
    ...finalContext,
    "",
  ].join("\n");
}
