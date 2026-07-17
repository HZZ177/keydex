import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";

import { startGitE2EFixture } from "./git-e2e-fixtures";
import {
  APP_BASE,
  RICH_SESSION,
  SESSION_A,
  WORKSPACE_A,
  createWorkbenchBackend,
  installWebSocketMock,
  mockWorkbenchBackend,
  type E2EWorkspaceTreeEntry,
} from "./workbench-e2e-fixtures";

const REVIEW_PATCH = [
  "diff --git a/README.md b/README.md",
  "--- a/README.md",
  "+++ b/README.md",
  "@@ -1 +1,2 @@",
  "-before",
  "+after",
  "+accessible",
  "",
].join("\n");
const PREVIEW_PATCH = [
  filePatch("src/first.ts", "first before", "first after"),
  filePatch("src/second.ts", "second before", "second after"),
].join("\n");
const PREVIEW_FILES: Record<string, string> = {
  "visual.patch": PREVIEW_PATCH,
  "broken.diff": "not a unified patch",
  "large.patch": `${"x".repeat(8 * 1024 * 1024)}\ndiff --git a/large.ts b/large.ts`,
};
const PREVIEW_TREE: E2EWorkspaceTreeEntry[] = Object.entries(PREVIEW_FILES).map(([path, content]) => ({
  name: path,
  path,
  type: "file",
  size: content.length,
  modified_at: null,
}));

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.emulateMedia({ reducedMotion: "reduce" });
});

test("compact 与 review 在亮暗主题、悬停、窄宽和 200% 缩放下保持 Keydex 视觉与可访问合同", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const backend = createWorkbenchBackend({
    historyBySession: {
      [RICH_SESSION]: [fileMutationMessage()],
    },
  });
  await installWebSocketMock(page);
  await mockWorkbenchBackend(page, backend);

  await page.goto(`${APP_BASE}/#/conversation/${RICH_SESSION}`, { waitUntil: "commit" });
  const fileTool = await revealFileMutationTool(page);
  const compact = fileTool.locator('[data-keydex-diff-wrapper="compact"]');
  if (!await compact.locator('[data-keydex-diff-view="true"][data-profile="compact"]').isVisible()) {
    const details = fileTool.getByRole("button", { name: "展开工具详情" });
    await details.focus();
    await details.press("Enter");
  }
  await expect(compact.locator('[data-keydex-diff-view="true"][data-profile="compact"]')).toBeVisible({ timeout: 20_000 });
  await assertAccessibleDiff(compact, "compact");
  const compactAction = compact.getByRole("button", { name: "复制原始补丁" });
  await compactAction.hover();
  await expect(page.getByRole("tooltip", { name: "复制原始补丁" })).toBeVisible();
  const compactLightTokens = await readVisualTokens(compact);
  await attachLocatorScreenshot(compact, testInfo, "compact-light-wide-hover");

  await switchToTheme(page, "dark");
  const compactDarkTokens = await readVisualTokens(compact);
  expect(compactDarkTokens).not.toEqual(compactLightTokens);
  await attachLocatorScreenshot(compact, testInfo, "compact-dark-wide");

  await fileTool.getByRole("button", { name: "README.md", exact: true }).click();
  const reviewPanel = page.getByTestId("right-sidebar-review-panel");
  const review = reviewPanel.locator('[data-keydex-diff-wrapper="review"]');
  await expect(review.locator('[data-keydex-diff-view="true"][data-profile="review"]')).toBeVisible({ timeout: 20_000 });
  await assertAccessibleDiff(review, "review");
  await attachLocatorScreenshot(review, testInfo, "review-dark-wide");

  await switchToTheme(page, "light");
  await page.setViewportSize({ width: 920, height: 800 });
  await expect(review).toBeVisible();
  await attachPageScreenshot(page, testInfo, "review-light-narrow");

  await setPageZoom(page, 2);
  await expect(review).toBeVisible();
  await assertNoUnnamedVisibleControls(review);
  await attachPageScreenshot(page, testInfo, "review-light-200-percent");
  await setPageZoom(page, 1);

  const reviewAction = review.getByRole("button", { name: /自动换行/ }).first();
  await reviewAction.focus();
  await expect(reviewAction).toBeFocused();
  await reviewAction.press("Enter");
  await expect(review.getByRole("button", { name: "开启自动换行" })).toHaveAttribute("aria-pressed", "false");
});

test("preview 在亮暗主题、并排选中态、窄宽、错误和超大输入下保持统一外壳", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const backend = createWorkbenchBackend({
    workspaceFiles: PREVIEW_FILES,
    workspaceTreeEntries: PREVIEW_TREE,
  });
  await installWebSocketMock(page);
  await mockWorkbenchBackend(page, backend);

  await page.goto(`${APP_BASE}/#/workbench/${WORKSPACE_A}/session/${SESSION_A}`, { waitUntil: "commit" });
  await openWorkspaceFile(page, "visual.patch");
  let preview = page.locator('[data-keydex-diff-wrapper="preview"]').last();
  await expect(preview.locator('[data-keydex-diff-view="true"][data-profile="preview"]')).toBeVisible({ timeout: 20_000 });
  await assertAccessibleDiff(preview, "preview");
  await attachLocatorScreenshot(preview, testInfo, "preview-light-wide");

  const split = preview.getByRole("button", { name: "切换为并排视图" });
  await split.click();
  await expect(preview.locator('[data-keydex-diff-layout-bridge="true"]')).toHaveAttribute("data-layout", "split");
  await expect(preview.getByRole("button", { name: "切换为统一视图" })).toHaveAttribute("aria-pressed", "true");
  await attachLocatorScreenshot(preview, testInfo, "preview-light-selected-split");

  await switchToTheme(page, "dark");
  await attachLocatorScreenshot(preview, testInfo, "preview-dark-wide");
  await page.setViewportSize({ width: 840, height: 760 });
  await expect(preview.locator('[data-keydex-diff-layout-bridge="true"]')).toHaveAttribute("data-layout", "stacked");
  await expect(preview.locator('[data-keydex-diff-layout-bridge="true"]')).toHaveAttribute("data-auto-downgraded", "true");
  await attachPageScreenshot(page, testInfo, "preview-dark-narrow-auto-stacked");

  await openWorkspaceFile(page, "broken.diff");
  preview = page.locator('[data-keydex-diff-wrapper="preview"]').last();
  await expect(preview.getByRole("alert")).toContainText("无法解析");
  await assertNoUnnamedVisibleControls(preview);
  await attachLocatorScreenshot(preview, testInfo, "preview-error-dark");

  await openWorkspaceFile(page, "large.patch");
  preview = page.locator('[data-keydex-diff-wrapper="preview"]').last();
  await expect(preview.getByRole("alert")).toContainText("差异内容过大");
  await attachLocatorScreenshot(preview, testInfo, "preview-large-dark");
});

test("git 在亮暗主题、大文件与二进制状态下只提供文件级动作并保持键盘可达", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const fixture = await startGitE2EFixture("diff-a11y-visual");
  try {
    const baseline = Array.from({ length: 1_200 }, (_, index) => `baseline ${index + 1}`).join("\n") + "\n";
    const changed = Array.from({ length: 1_200 }, (_, index) => `changed ${index + 1}`).join("\n") + "\n";
    await fixture.write("large.ts", baseline);
    await fixture.write("binary.dat", "\u0000binary baseline\n");
    await fixture.commit("test: visual diff baseline", ["large.ts", "binary.dat"]);
    await fixture.write("large.ts", changed);
    await fixture.write("binary.dat", "\u0000binary changed\n");
    await fixture.configurePage(page);
    await page.goto(`${fixture.appBaseUrl}/#/workbench/${fixture.workspaceId}`, { waitUntil: "domcontentloaded" });
    await openGitToolWindow(page);

    await selectGitChange(page, /large\.ts modified/);
    let git = page.locator('[data-keydex-diff-wrapper="git"]').last();
    await expect(git.locator('[data-keydex-diff-view="true"][data-profile="git"]')).toBeVisible({ timeout: 30_000 });
    await expect(git.getByText("仅应用这个变更块", { exact: true })).toHaveCount(0);
    await expect(git.getByRole("button", { name: /暂存变更块|取消暂存变更块/ })).toHaveCount(0);
    await expect(git.getByRole("button", { name: "暂存文件" })).toBeVisible();
    await assertAccessibleDiff(git, "git");
    await git.getByRole("button", { name: "暂存文件" }).hover();
    await expect(page.getByRole("tooltip", { name: "暂存文件" })).toBeVisible();
    await attachLocatorScreenshot(git, testInfo, "git-light-large-hover");

    await switchToTheme(page, "dark");
    await attachLocatorScreenshot(git, testInfo, "git-dark-large");
    await page.setViewportSize({ width: 900, height: 760 });
    await attachPageScreenshot(page, testInfo, "git-dark-narrow");

    await selectGitChange(page, /binary\.dat modified/);
    git = page.locator('[data-keydex-diff-wrapper="git"]').last();
    await expect(git).toContainText("二进制文件", { timeout: 20_000 });
    await expect(git).toContainText("不提供文本差异");
    await expect(git.getByRole("button", { name: /暂存变更块|取消暂存变更块/ })).toHaveCount(0);
    await attachLocatorScreenshot(git, testInfo, "git-dark-binary");

    const wrapAction = git.getByRole("button", { name: /自动换行/ }).first();
    await wrapAction.focus();
    await expect(wrapAction).toBeFocused();
    const nextWrapLabel = await wrapAction.getAttribute("aria-pressed") === "true"
      ? "开启自动换行"
      : "关闭自动换行";
    await wrapAction.press("Enter");
    await expect(git.getByRole("button", { name: new RegExp(nextWrapLabel) })).toHaveAttribute(
      "aria-pressed",
      nextWrapLabel === "关闭自动换行" ? "true" : "false",
    );
  } finally {
    await fixture.cleanup();
  }
});

async function assertAccessibleDiff(wrapper: Locator, profile: "compact" | "review" | "git" | "preview") {
  const bridge = wrapper.locator('[data-keydex-diff-accessibility="true"]').first();
  await expect(bridge).toBeVisible();
  await expect(bridge).toHaveAttribute("role", "region");
  await expect(bridge).toHaveAttribute("data-diff-profile", profile);
  await expect(bridge).toHaveAttribute("aria-label", /差异/);
  expect(await bridge.ariaSnapshot()).toContain("region");
  await assertNoUnnamedVisibleControls(wrapper);
  const duplicateIds = await wrapper.evaluate((root) => {
    const ids = Array.from(root.querySelectorAll<HTMLElement>("[id]"), (element) => element.id).filter(Boolean);
    return ids.filter((id, index) => ids.indexOf(id) !== index);
  });
  expect(duplicateIds).toEqual([]);
}

async function assertNoUnnamedVisibleControls(wrapper: Locator) {
  const unnamed = await wrapper.evaluate((root) => {
    const controls = Array.from(root.querySelectorAll<HTMLElement>(
      "button, input, select, textarea, a[href], [role='button'], [role='option'], [tabindex]:not([tabindex='-1'])",
    ));
    return controls.filter((element) => {
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden") return false;
      if (element.getBoundingClientRect().width === 0 && element.getBoundingClientRect().height === 0) return false;
      const labelledBy = element.getAttribute("aria-labelledby");
      const labelledText = labelledBy
        ? labelledBy.split(/\s+/u).map((id) => document.getElementById(id)?.textContent ?? "").join(" ")
        : "";
      const labelText = element instanceof HTMLInputElement
        || element instanceof HTMLSelectElement
        || element instanceof HTMLTextAreaElement
        ? Array.from(element.labels ?? [], (label) => label.textContent ?? "").join(" ")
        : "";
      const name = [
        element.getAttribute("aria-label"),
        element.getAttribute("title"),
        element.getAttribute("alt"),
        labelledText,
        labelText,
        element.getAttribute("placeholder"),
        element.textContent,
      ].find((candidate) => candidate?.trim());
      return !name;
    }).map((element) => element.outerHTML.slice(0, 180));
  });
  expect(unnamed).toEqual([]);
}

async function readVisualTokens(wrapper: Locator) {
  return wrapper.evaluate((root) => {
    const surface = root.querySelector<HTMLElement>("[data-keydex-diff-surface]") ?? root as HTMLElement;
    const style = getComputedStyle(surface);
    return {
      theme: document.documentElement.dataset.theme,
      surface: style.getPropertyValue("--diff-surface-bg").trim(),
      added: style.getPropertyValue("--diff-added-bg").trim(),
      removed: style.getPropertyValue("--diff-removed-bg").trim(),
      selection: style.getPropertyValue("--diff-selection-bg").trim(),
      focus: style.getPropertyValue("--diff-focus-ring").trim(),
    };
  });
}

async function switchToTheme(page: Page, theme: "light" | "dark") {
  const root = page.locator("html");
  if (await root.getAttribute("data-theme") !== theme) {
    await page.getByRole("button", { name: "切换主题" }).click();
  }
  await expect(root).toHaveAttribute("data-theme", theme);
}

async function setPageZoom(page: Page, factor: number) {
  await page.evaluate((zoom) => {
    document.documentElement.style.zoom = String(zoom);
  }, factor);
  await page.waitForTimeout(100);
}

async function attachLocatorScreenshot(locator: Locator, testInfo: TestInfo, name: string) {
  await locator.scrollIntoViewIfNeeded();
  await testInfo.attach(name, {
    body: await locator.screenshot({ animations: "disabled" }),
    contentType: "image/png",
  });
}

async function attachPageScreenshot(page: Page, testInfo: TestInfo, name: string) {
  await testInfo.attach(name, {
    body: await page.screenshot({ animations: "disabled" }),
    contentType: "image/png",
  });
}

async function revealFileMutationTool(page: Page) {
  await expect(page.getByLabel("继续输入")).toBeVisible({ timeout: 30_000 });
  const scroll = page.getByTestId("message-list-scroll");
  await scroll.evaluate((element) => {
    element.scrollTop = 0;
  });
  const group = page.getByTestId("message-group-block").first();
  if (await group.count()) await group.getByRole("button").first().click();
  const tool = page.getByTestId("tool-call-block").filter({ hasText: "README.md" }).first();
  await expect(tool).toBeVisible();
  return tool;
}

function fileMutationMessage() {
  return {
    id: "diff-a11y-visual",
    sessionId: RICH_SESSION,
    role: "tool",
    content: "README.md",
    timestamp: 1_784_240_000_000,
    toolName: "apply_patch",
    toolParams: { path: "README.md" },
    toolResult: "patched",
    status: "completed",
    toolDetailsDeferred: false,
    runId: "diff-a11y-run",
    toolCallId: "diff-a11y-call",
    fileChanges: [{
      path: "README.md",
      operation: "update",
      added_lines: 2,
      deleted_lines: 1,
      diff: REVIEW_PATCH,
    }],
  };
}

async function openWorkspaceFile(page: Page, path: string) {
  await page.getByRole("button", { name: `选择文件 ${path}` }).click();
  await expect(page.locator('[data-file-preview-root="true"]')).toHaveAttribute("data-preview-source", "file");
}

async function openGitToolWindow(page: Page) {
  const trigger = page.getByRole("button", { name: /Git：main/ });
  await expect(trigger).toBeEnabled({ timeout: 20_000 });
  await trigger.click();
  await page.getByRole("menuitem", { name: "打开 Git 面板" }).click();
  await expect(page.getByRole("tablist", { name: "Git 面板视图" })).toBeVisible();
}

async function selectGitChange(page: Page, name: RegExp) {
  const row = page.getByRole("tree", { name: "本地改动" }).getByRole("treeitem", { name });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();
}

function filePatch(path: string, before: string, after: string) {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1 +1 @@",
    `-${before}`,
    `+${after}`,
    "",
  ].join("\n");
}
