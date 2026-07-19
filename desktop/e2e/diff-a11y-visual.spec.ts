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
  asymmetricFilePatch("src/first.ts"),
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
  const nextReviewWrap = await reviewAction.getAttribute("aria-pressed") !== "true";
  await reviewAction.press("Enter");
  await expect(review.getByRole("button", { name: /自动换行/ }).first()).toHaveAttribute(
    "aria-pressed",
    String(nextReviewWrap),
  );
});

test("preview 在亮暗主题、并排选中态、窄宽、错误和超大输入下保持统一外壳", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 2000, height: 1100 });
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
  const aligned = preview.locator('[data-keydex-aligned-split]');
  await expect(aligned).toBeVisible();
  await expect(aligned.locator('[data-keydex-aligned-pane]')).toHaveCount(2);
  await expect(aligned.locator('[data-keydex-diff-connector]')).toBeVisible();
  await expect(aligned.locator('[data-keydex-aligned-row][data-active="true"]')).toHaveCount(0);
  const changeRowWidths = await aligned.evaluate((root) => Array.from(
    root.querySelectorAll<HTMLElement>('[data-keydex-aligned-pane]'),
    (pane) => ({
      paneWidth: pane.clientWidth,
      paneScrollWidth: pane.scrollWidth,
      rowWidths: Array.from(
        pane.querySelectorAll<HTMLElement>('[data-keydex-aligned-row][data-change-kind]'),
        (row) => row.getBoundingClientRect().width,
      ),
    }),
  ));
  expect(changeRowWidths.every(({ paneWidth, paneScrollWidth, rowWidths }) => (
    rowWidths.length > 0
    && rowWidths.every((rowWidth) => rowWidth >= paneWidth - 1 && rowWidth >= paneScrollWidth - 1)
  ))).toBe(true);
  const connectorVisual = await aligned.evaluate((root) => {
    const style = getComputedStyle(root);
    return {
      changeFill: style.getPropertyValue("--diff-aligned-change-fill").trim(),
      addedFill: style.getPropertyValue("--diff-aligned-added-fill").trim(),
      removedFill: style.getPropertyValue("--diff-aligned-removed-fill").trim(),
      expectedChangeFill: style.getPropertyValue("--diff-modified-bg").trim(),
      expectedAddedFill: style.getPropertyValue("--diff-added-bg").trim(),
      expectedRemovedFill: style.getPropertyValue("--diff-removed-bg").trim(),
      gradientStops: root.querySelectorAll("linearGradient stop").length,
    };
  });
  expect(connectorVisual.changeFill).toBe(connectorVisual.expectedChangeFill);
  expect(connectorVisual.addedFill).toBe(connectorVisual.expectedAddedFill);
  expect(connectorVisual.removedFill).toBe(connectorVisual.expectedRemovedFill);
  expect(new Set([
    connectorVisual.changeFill,
    connectorVisual.addedFill,
    connectorVisual.removedFill,
  ]).size).toBe(3);
  expect(connectorVisual.gradientStops).toBe(0);
  const alignment = await aligned.evaluate((root) => {
    const lane = root.querySelector<HTMLElement>('[data-keydex-aligned-connector]');
    const laneTop = lane?.getBoundingClientRect().top ?? 0;
    const contextDeltas: number[] = [];
    const segments = new Set(Array.from(root.querySelectorAll('[data-kind="context"]'))
      .map((row) => row.getAttribute("data-segment-id"))
      .filter((segment): segment is string => Boolean(segment)));
    for (const segment of segments) {
      const left = Array.from(root.querySelectorAll<HTMLElement>(
        `[data-keydex-aligned-pane="old"] [data-kind="context"][data-segment-id="${segment}"]`,
      ));
      const right = Array.from(root.querySelectorAll<HTMLElement>(
        `[data-keydex-aligned-pane="new"] [data-kind="context"][data-segment-id="${segment}"]`,
      ));
      for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
        contextDeltas.push(Math.abs(
          left[index]!.getBoundingClientRect().top - right[index]!.getBoundingClientRect().top,
        ));
      }
    }
    const endpointDeltas: number[] = [];
    for (const group of root.querySelectorAll<SVGGElement>('[data-keydex-diff-connector] g[data-change-id]')) {
      const changeId = group.getAttribute("data-change-id");
      if (!changeId) continue;
      for (const side of ["old", "new"] as const) {
        const pane = root.querySelector<HTMLElement>(`[data-keydex-aligned-pane="${side}"]`);
        const rows = Array.from(root.querySelectorAll<HTMLElement>(
          `[data-keydex-aligned-pane="${side}"] [data-keydex-aligned-row][data-change-id="${changeId}"]`,
        ));
        const prefix = side === "old" ? "left" : "right";
        const actualStart = Number(group.getAttribute(`data-${prefix}-start`));
        const actualEnd = Number(group.getAttribute(`data-${prefix}-end`));
        if (rows.length === 0) {
          endpointDeltas.push(Math.abs(actualStart - actualEnd));
          continue;
        }
        const height = pane?.clientHeight ?? 0;
        const clamp = (value: number) => Math.max(0, Math.min(height, value));
        endpointDeltas.push(
          Math.abs(actualStart - clamp(rows[0]!.getBoundingClientRect().top - laneTop)),
          Math.abs(actualEnd - clamp(rows.at(-1)!.getBoundingClientRect().bottom - laneTop)),
        );
      }
    }
    return {
      contextPairs: contextDeltas.length,
      maxContextDelta: contextDeltas.length ? Math.max(...contextDeltas) : 0,
      endpointCount: endpointDeltas.length,
      maxEndpointDelta: endpointDeltas.length ? Math.max(...endpointDeltas) : 0,
    };
  });
  expect(alignment.contextPairs).toBeGreaterThan(0);
  expect(alignment.endpointCount).toBeGreaterThan(0);
  expect(alignment.maxContextDelta).toBeLessThanOrEqual(1);
  expect(alignment.maxEndpointDelta).toBeLessThanOrEqual(1);
  await expect(preview.getByRole("button", { name: "切换为统一视图" })).toHaveAttribute("aria-pressed", "true");
  await attachLocatorScreenshot(preview, testInfo, "preview-light-selected-split");

  for (const zoom of [1.25, 1.5]) {
    await setPageZoom(page, zoom);
    await expect(aligned).toBeVisible();
    await assertNoUnnamedVisibleControls(aligned);
    await attachLocatorScreenshot(preview, testInfo, `preview-light-split-${zoom * 100}-percent`);
  }
  await setPageZoom(page, 1);

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

function asymmetricFilePatch(path: string) {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1,4 +1,5 @@",
    " const before = true;",
    "-const value = 'before';",
    "+const value = 'after';",
    "+const inserted = true;",
    " const after = true;",
    " export { value };",
    "",
  ].join("\n");
}
