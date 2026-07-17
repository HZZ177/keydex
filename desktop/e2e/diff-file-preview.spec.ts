import { expect, test, type Page } from "@playwright/test";

import {
  APP_BASE,
  SESSION_A,
  WORKSPACE_A,
  createWorkbenchBackend,
  installWebSocketMock,
  mockWorkbenchBackend,
  saveEvidence,
  type E2EWorkspaceTreeEntry,
} from "./workbench-e2e-fixtures";

const SINGLE_DIFF = filePatch("src/single.ts", "single-before", "single-after");
const MULTI_PATCH = [
  longFilePatch("src/first.ts", "first"),
  longFilePatch("src/middle.ts", "middle"),
  longFilePatch("src/final.ts", "final"),
].join("\n");
const MALFORMED_DIFF = "this is not a unified diff";
const LARGE_DIFF = `${"x".repeat(8 * 1024 * 1024)}\ndiff --git a/large.ts b/large.ts`;
const DIFF_FILES: Record<string, string> = {
  "single.diff": SINGLE_DIFF,
  "multi.patch": MULTI_PATCH,
  "malformed.diff": MALFORMED_DIFF,
  "large.patch": LARGE_DIFF,
};
const DIFF_TREE: E2EWorkspaceTreeEntry[] = Object.entries(DIFF_FILES).map(([path, content]) => ({
  name: path,
  path,
  type: "file",
  size: content.length,
  modified_at: null,
}));

test("Agent 对话中的 diff 代码块通过显式 content 请求打开统一侧栏预览", async ({ page }) => {
  const backend = createWorkbenchBackend({
    historyBySession: {
      [SESSION_A]: [
        {
          id: "diff-content-message",
          sessionId: SESSION_A,
          role: "assistant",
          content: ["下面是变更：", "", "```diff", SINGLE_DIFF, "```"].join("\n"),
          timestamp: 1_784_240_000_000,
        },
      ],
    },
  });
  await installWebSocketMock(page);
  await mockWorkbenchBackend(page, backend);

  await page.goto(`${APP_BASE}/#/conversation/${SESSION_A}`);
  const openButton = page.getByRole("button", { name: "在预览面板打开 Diff 预览" });
  await expect(openButton).toBeVisible();
  await openButton.click();

  const preview = diffPreview(page);
  await expect(preview).toBeVisible();
  await expect(preview).toHaveAttribute("data-file-count", "1");
  await expect(preview.locator('[data-keydex-diff-engine="pierre"]')).toBeVisible();
  await expect(page.locator('[data-file-preview-root="true"]')).toHaveAttribute("data-preview-source", "diff-document");
  await expectLegacyDiffRendererAbsent(page);
  await saveEvidence(page, "diff-preview-content-request");
});

test("工作台主预览支持单文件、多文件、源码切换、文件导航、刷新与路由恢复", async ({ page }) => {
  const backend = createWorkbenchBackend({
    workspaceFiles: DIFF_FILES,
    workspaceTreeEntries: DIFF_TREE,
  });
  await installWebSocketMock(page);
  await mockWorkbenchBackend(page, backend);

  await page.goto(`${APP_BASE}/#/workbench/${WORKSPACE_A}/session/${SESSION_A}`);
  await openWorkspaceFile(page, "single.diff");

  let preview = diffPreview(page);
  await expect(preview).toHaveAttribute("data-file-count", "1");
  await expect(preview.locator('[data-keydex-diff-engine="pierre"]')).toBeVisible();
  await expectLegacyDiffRendererAbsent(page);

  const previewRoot = page.locator('[data-file-preview-root="true"]');
  const modeSwitch = previewRoot.locator('[aria-label="预览模式"]');
  await modeSwitch.getByRole("button", { name: "源码" }).click();
  await expect(previewRoot.getByTestId("file-source-viewer")).toContainText("diff --git a/src/single.ts b/src/single.ts");
  await modeSwitch.getByRole("button", { name: "预览" }).click();
  await expect(diffPreview(page)).toBeVisible();

  await openWorkspaceFile(page, "multi.patch");
  preview = diffPreview(page);
  await expect(preview).toHaveAttribute("data-file-count", "3");
  await preview.getByRole("button", { name: /3 个变更文件/ }).click();
  const middle = preview.getByRole("option", { name: /middle\.ts/ });
  await middle.click();
  await expect(middle).toHaveAttribute("aria-selected", "true");
  const final = preview.getByRole("option", { name: /final\.ts/ });
  await final.click();
  await expect(final).toHaveAttribute("aria-selected", "true");
  await expect(preview.getByRole("region", { name: /文件预览差异：共 3 个文件/ })).toBeVisible();

  await page.reload();
  await expect(page).toHaveURL(new RegExp(`/workbench/${WORKSPACE_A}/session/${SESSION_A}$`));
  preview = diffPreview(page);
  await expect(preview).toHaveAttribute("data-file-count", "3");
  await expect(preview.locator('[data-keydex-diff-engine="pierre"]')).toBeVisible();

  await openWorkspaceFile(page, "single.diff");
  await expect(diffPreview(page)).toHaveAttribute("data-file-count", "1");
  backend.workspaceFiles["single.diff"] = `${SINGLE_DIFF}\n${filePatch("src/second.ts", "old", "new")}`;
  const readsBeforeRefresh = backend.workspaceReadRequests.filter((item) => item.path === "single.diff").length;
  await page.getByRole("button", { name: "刷新工作区" }).click();
  await expect.poll(
    () => backend.workspaceReadRequests.filter((item) => item.path === "single.diff").length,
  ).toBeGreaterThan(readsBeforeRefresh);
  await expect(diffPreview(page)).toHaveAttribute("data-file-count", "2");

  await expectLegacyDiffRendererAbsent(page);
  await saveEvidence(page, "diff-preview-workbench-main");
});

test("文件预览为 malformed 与超大补丁保留统一诊断边界", async ({ page }) => {
  const backend = createWorkbenchBackend({
    workspaceFiles: DIFF_FILES,
    workspaceTreeEntries: DIFF_TREE,
  });
  await installWebSocketMock(page);
  await mockWorkbenchBackend(page, backend);

  await page.goto(`${APP_BASE}/#/workbench/${WORKSPACE_A}/session/${SESSION_A}`);
  await openWorkspaceFile(page, "malformed.diff");
  await expect(page.getByText("无法解析差异", { exact: true })).toBeVisible();
  await expect(diffPreview(page)).toHaveAttribute("data-file-count", "0");

  await openWorkspaceFile(page, "large.patch");
  await expect(page.getByText("差异内容过大", { exact: true })).toBeVisible();
  await expect(diffPreview(page)).toHaveAttribute("data-file-count", "0");
  await expectLegacyDiffRendererAbsent(page);
  await saveEvidence(page, "diff-preview-diagnostics");
});

function diffPreview(page: Page) {
  return page.locator('[data-keydex-diff-wrapper="preview"]').last();
}

async function openWorkspaceFile(page: Page, path: string) {
  await page.getByRole("button", { name: `选择文件 ${path}` }).click();
  await expect(page.locator('[data-file-preview-root="true"]')).toHaveAttribute("data-preview-source", "file");
}

async function expectLegacyDiffRendererAbsent(page: Page) {
  await expect(page.locator('[data-legacy-diff-renderer], [data-git-diff-viewer], .diffPane, .diffLine')).toHaveCount(0);
}

function filePatch(path: string, before: string, after: string): string {
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

function longFilePatch(path: string, prefix: string): string {
  const removed = Array.from({ length: 40 }, (_, index) => `-${prefix}-before-${index + 1}`);
  const added = Array.from({ length: 40 }, (_, index) => `+${prefix}-after-${index + 1}`);
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1,41 +1,41 @@",
    ` ${prefix}-context`,
    ...removed,
    ...added,
    "",
  ].join("\n");
}
