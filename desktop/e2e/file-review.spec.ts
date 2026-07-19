import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  APP_BASE,
  RICH_SESSION,
  WORKSPACE_A,
  createWorkbenchBackend,
  installWebSocketMock,
  mockWorkbenchBackend,
  openWorkbenchComposer,
} from "./workbench-e2e-fixtures";

const REVIEW_DIFF = "--- a/README.md\n+++ b/README.md\n@@ -1 +1,2 @@\n-old\n+new\n+added";
const DEFERRED_REVIEW_DIFF =
  "--- a/README.md\n+++ b/README.md\n@@ -1 +1,2 @@\n-old\n+loaded\n+reviewed";

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  page.on("pageerror", (error) => {
    console.error(`[pageerror] ${error.message}`);
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      console.error(`[console:${message.type()}] ${message.text()}`);
    }
  });
});

test("right sidebar review action opens an empty review panel", async ({ page }) => {
  const backend = createWorkbenchBackend({
    historyBySession: {
      [RICH_SESSION]: [],
    },
  });
  await installWebSocketMock(page);
  await mockWorkbenchBackend(page, backend);

  await gotoRichConversation(page);
  await expect(page.getByTestId("app-shell")).toBeVisible({ timeout: 15_000 });

  await page.getByLabel("展开右侧栏").click();
  await page.getByRole("button", { name: "审阅" }).click();

  await expect(page.getByTestId("app-shell")).toHaveAttribute("data-right-sidebar", "open");
  await expect(page.getByRole("tab", { name: "审阅" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("right-sidebar-review-panel")).toBeVisible();
  await expect(page.getByTestId("review-empty-state")).toContainText("暂无可审阅的文件变更");
});

test("file mutation tool filename opens the right sidebar unified review diff", async ({ page }) => {
  const backend = createWorkbenchBackend({
    historyBySession: {
      [RICH_SESSION]: [fileMutationMessage({ id: "file-review-click" })],
    },
  });
  await installWebSocketMock(page);
  await mockWorkbenchBackend(page, backend);

  await gotoRichConversation(page);
  const fileTool = await revealFileMutationTool(page);

  await fileTool.getByRole("button", { name: "README.md" }).click();

  await expect(page.getByTestId("app-shell")).toHaveAttribute("data-right-sidebar", "open");
  await expect(page.getByRole("tab", { name: "审阅" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("right-sidebar-review-panel")).toBeVisible();
  await expect(page.getByTestId("right-sidebar-review-panel").getByTestId("file-review-card")).toHaveCount(0);
  const review = page.getByTestId("right-sidebar-review-panel");
  const diff = review.locator("[data-keydex-diff-view='true']");
  await expectDiffLines(review, "new", "added");
  const wrapButton = page.getByRole("button", { name: "开启自动换行" });
  await expect(wrapButton).toHaveAttribute("aria-pressed", "false");
  await expect(wrapButton).toHaveAttribute("data-tooltip-label", "开启自动换行");
  await expect(diff).toHaveAttribute("data-wrap", "false");
  await wrapButton.hover();
  await expect(page.locator("[role='tooltip']").filter({ hasText: "开启自动换行" })).toBeVisible();
  await wrapButton.click();
  await expect(diff).toHaveAttribute("data-wrap", "true");
  await page.getByRole("button", { name: "关闭自动换行" }).click();
  await expect(diff).toHaveAttribute("data-wrap", "false");
  await expect(page.getByRole("tab", { name: "文件" })).toHaveCount(0);

  await expect(review.getByRole("button", { name: "打开文件" })).toHaveCount(0);
  expect(backend.workspaceReadRequests).toHaveLength(0);
});

test("multi-file final review replaces streaming content and works in Agent and Workbench", async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          (window as Window & { __e2eCopiedPatch?: string }).__e2eCopiedPatch = value;
        },
      },
    });
  });
  const partialDiff = "--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n-old\n+partial";
  const finalDiff = "--- a/README.md\n+++ b/README.md\n@@ -1 +1,2 @@\n-old\n+complete\n+reviewed";
  const secondDiff = "--- /dev/null\n+++ b/src/second.ts\n@@ -0,0 +1 @@\n+export const second = true;";
  const backend = createWorkbenchBackend({
    historyBySession: {
      [RICH_SESSION]: [
        fileMutationMessage({
          diff: partialDiff,
          id: "streaming-review",
          status: "running",
        }),
        fileMutationMessage({
          fileChanges: [
            fileChange("README.md", finalDiff, "update"),
            fileChange("src/second.ts", secondDiff, "add"),
          ],
          id: "final-multi-review",
          path: "src/second.ts",
        }),
      ],
    },
  });
  await installWebSocketMock(page);
  await mockWorkbenchBackend(page, backend);

  await gotoRichConversation(page);
  await expect(page.getByRole("button", { name: "Agent" })).toHaveAttribute("aria-pressed", "true");
  const fileTool = await revealFileMutationTool(page, "src/second.ts");
  await fileTool.getByRole("button", { name: "src/second.ts" }).click();

  const review = page.getByTestId("right-sidebar-review-panel");
  await expect(review).toBeVisible();
  await expect(review.getByRole("button", { name: /2 个变更文件/ })).toBeVisible();
  await review.getByRole("button", { name: /2 个变更文件/ }).click();
  const fileList = review.getByRole("listbox", { name: "变更文件" });
  await expect(fileList.getByRole("option")).toHaveCount(2);
  await fileList.getByRole("option").filter({ hasText: "README.md" }).click();
  await expectDiffLines(review, "complete", "reviewed");
  await expect(diffRegion(review)).not.toContainText("partial");

  const copyPatch = review.getByRole("button", { name: "复制原始补丁" });
  await copyPatch.click();
  await expect(review.getByRole("button", { name: "复制原始补丁成功" })).toBeVisible();
  await expect.poll(() => page.evaluate(() =>
    (window as Window & { __e2eCopiedPatch?: string }).__e2eCopiedPatch ?? "",
  )).toContain("+complete");

  await page.getByRole("button", { name: "工作台模式" }).click();
  await expect(page).toHaveURL(new RegExp("#/workbench(?:\\?|$)"));
  await expect(page.getByRole("button", { name: "工作台模式" })).toHaveAttribute("aria-pressed", "true");
  await page.goto(`${APP_BASE}/#/workbench/${WORKSPACE_A}/session/${RICH_SESSION}`, { waitUntil: "commit" });
  await expect(page).toHaveURL(new RegExp(`#\\/workbench\\/${WORKSPACE_A}\\/session\\/${RICH_SESSION}(?:\\?|$)`));
  await openWorkbenchComposer(page);
  await page.getByRole("button", { name: "将工作台助手展开到右侧" }).click();
  const drawer = page.getByTestId("workbench-assistant-drawer");
  await expect(drawer).toBeVisible();
  const workbenchTool = await revealFileMutationToolIn(drawer, "src/second.ts");
  await workbenchTool.getByRole("button", { name: "展开工具详情" }).click();
  await expect(drawer.locator("[data-keydex-diff-view='true']")).toBeVisible();
  await expectDiffLines(drawer, "export const second = true;");
  await testInfo.attach("agent-workbench-review-surfaces", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
});

test("file mutation tool details render a compact diff panel instead of raw JSON", async ({ page }) => {
  const backend = createWorkbenchBackend({
    historyBySession: {
      [RICH_SESSION]: [fileMutationMessage({ id: "file-review-details" })],
    },
  });
  await installWebSocketMock(page);
  await mockWorkbenchBackend(page, backend);

  await gotoRichConversation(page);
  const fileTool = await revealFileMutationTool(page);

  const detailsToggle = fileTool.getByRole("button", { name: "展开工具详情" });
  await detailsToggle.focus();
  await detailsToggle.press("Enter");

  await expect(fileTool.locator("[data-keydex-diff-view='true'][data-profile='compact']")).toBeVisible();
  await expectDiffLines(fileTool, "new", "added");
  await expect(fileTool.getByText("工具入参")).toHaveCount(0);
  await expect(fileTool.getByText("工具输出")).toHaveCount(0);
});

test("deferred file mutation click loads tool details before opening the review diff", async ({ page }) => {
  const backend = createWorkbenchBackend({
    historyBySession: {
      [RICH_SESSION]: [
        fileMutationMessage({
          diff: "",
          id: "deferred-file-review",
          deferred: true,
        }),
      ],
    },
    toolDetailsByRef: {
      "review-start:review-end": {
        detailRef: {
          startEventId: "review-start",
          endEventId: "review-end",
          runId: "run-review",
          toolCallId: "call-review",
        },
        runId: "run-review",
        toolCallId: "call-review",
        toolName: "apply_patch",
        toolParams: { path: "README.md" },
        toolResult: "patched",
        status: "completed",
        fileChanges: [
          {
            path: "README.md",
            operation: "update",
            added_lines: 2,
            deleted_lines: 1,
            diff: DEFERRED_REVIEW_DIFF,
          },
        ],
      },
    },
  });
  await installWebSocketMock(page);
  await mockWorkbenchBackend(page, backend);

  await gotoRichConversation(page);
  const fileTool = await revealFileMutationTool(page);

  await fileTool.getByRole("button", { name: "README.md" }).click();

  await expect.poll(() => backend.toolDetailsRequests.length).toBe(1);
  expect(backend.toolDetailsRequests.at(-1)).toMatchObject({
    sessionId: RICH_SESSION,
    startEventId: "review-start",
    endEventId: "review-end",
  });
  await expect(page.getByTestId("app-shell")).toHaveAttribute("data-right-sidebar", "open");
  await expect(page.getByRole("tab", { name: "审阅" })).toHaveAttribute("aria-selected", "true");
  await expectDiffLines(page.getByTestId("right-sidebar-review-panel"), "loaded", "reviewed");
});

test("apply_patch add-file change opens the review diff with create wording", async ({ page }) => {
  const backend = createWorkbenchBackend({
    historyBySession: {
      [RICH_SESSION]: [
        fileMutationMessage({
          diff: "--- /dev/null\n+++ b/docs/new.md\n@@ -0,0 +1,2 @@\n+hello\n+world",
          id: "apply-patch-add-file",
          operation: "add",
          path: "docs/new.md",
          toolParams: { patch: "*** Begin Patch\n*** Add File: docs/new.md\n+hello\n+world\n*** End Patch" },
        }),
      ],
    },
  });
  await installWebSocketMock(page);
  await mockWorkbenchBackend(page, backend);

  await gotoRichConversation(page);
  const fileTool = await revealFileMutationTool(page, "docs/new.md");

  await expect(fileTool.getByText("已创建文件")).toBeVisible();
  await fileTool.getByText("docs/new.md").click();

  await expect(page.getByRole("tab", { name: "审阅" })).toHaveAttribute("aria-selected", "true");
  await expectDiffLines(page.getByTestId("right-sidebar-review-panel"), "hello", "world");
});

test("move_file change opens the review diff with move wording", async ({ page }) => {
  const backend = createWorkbenchBackend({
    historyBySession: {
      [RICH_SESSION]: [
        fileMutationMessage({
          diff: "--- a/docs/old.md\n+++ b/docs/new.md\n@@ -1 +1 @@\n-old title\n+new title",
          id: "move-file-review",
          operation: "move",
          path: "docs/new.md",
          toolName: "move_file",
          toolParams: { path: "docs/old.md", new_path: "docs/new.md" },
        }),
      ],
    },
  });
  await installWebSocketMock(page);
  await mockWorkbenchBackend(page, backend);

  await gotoRichConversation(page);
  const fileTool = await revealFileMutationTool(page, "docs/new.md");

  await expect(fileTool.getByText("已移动文件")).toBeVisible();
  await fileTool.getByText("docs/new.md").click();

  await expect(page.getByRole("tab", { name: "审阅" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("group", { name: /docs\/new\.md，重命名文件/ })).toBeVisible();
  await expectDiffLines(page.getByTestId("right-sidebar-review-panel"), "old title", "new title");
});

test("legacy edit_file patch history opens the review diff", async ({ page }) => {
  const backend = createWorkbenchBackend({
    historyBySession: {
      [RICH_SESSION]: [
        fileMutationMessage({
          diff: "--- a/docs/legacy.md\n+++ b/docs/legacy.md\n@@ -1 +1 @@\n-old\n+new",
          id: "legacy-edit-file-patch",
          path: "docs/legacy.md",
          toolName: "edit_file",
          toolParams: { patch: "*** Begin Patch\n*** Update File: docs/legacy.md\n@@\n-old\n+new\n*** End Patch" },
        }),
      ],
    },
  });
  await installWebSocketMock(page);
  await mockWorkbenchBackend(page, backend);

  await gotoRichConversation(page);
  const fileTool = await revealFileMutationTool(page, "docs/legacy.md");

  await expect(fileTool.getByText("已编辑文件")).toBeVisible();
  await fileTool.getByText("docs/legacy.md").click();

  await expect(page.getByRole("tab", { name: "审阅" })).toHaveAttribute("aria-selected", "true");
  await expectDiffLines(page.getByTestId("right-sidebar-review-panel"), "old", "new");
});

test("failed file mutation shows recoverable error details", async ({ page }) => {
  const backend = createWorkbenchBackend({
    historyBySession: {
      [RICH_SESSION]: [
        fileMutationMessage({
          id: "failed-file-mutation",
          path: "docs/error.md",
          status: "failed",
          toolResult: "patch failed",
        }),
      ],
    },
  });
  await installWebSocketMock(page);
  await mockWorkbenchBackend(page, backend);

  await gotoRichConversation(page);
  const fileTool = await revealFileMutationTool(page, "docs/error.md");

  await expect(fileTool).toContainText("编辑文件失败");
  await expect(fileTool).toContainText("错误信息：patch failed");
  await fileTool.getByText("docs/error.md").click();
  await expect(page.getByRole("tab", { name: "审阅" })).toHaveAttribute("aria-selected", "true");
  await expectDiffLines(page.getByTestId("right-sidebar-review-panel"), "old");
});

test("user message reverse opens the canonical preview and completes code rollback", async ({ page }, testInfo) => {
  const backend = createWorkbenchBackend({
    historyBySession: {
      [RICH_SESSION]: [reverseTargetMessage()],
    },
  });
  await installWebSocketMock(page);
  await mockWorkbenchBackend(page, backend);

  await gotoRichConversation(page);
  const targetMessage = page.getByTestId("message-list").getByText("请恢复到稳定版本").first();
  await targetMessage.hover();
  await page.getByRole("button", { name: "回溯到此处" }).click();

  await expect.poll(() => backend.reversePreviewRequests.length).toBe(1);
  expect(backend.reversePreviewRequests[0]).toEqual({
    sessionId: RICH_SESSION,
    body: { message_event_id: "e2e-reverse-event" },
  });
  const dialog = page.getByRole("dialog", { name: "回溯到此处" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("src/reverse.ts")).toBeVisible();
  await dialog.getByText("src/reverse.ts").click();
  await expectDiffLines(dialog, "current", "target");
  await dialog.getByRole("radio", { name: /只回溯修改/ }).check();
  await dialog.getByRole("button", { name: "回溯到此处" }).click();

  await expect.poll(() => backend.reverseExecuteRequests.length).toBe(1);
  expect(backend.reverseExecuteRequests[0]?.body).toMatchObject({
    message_event_id: "e2e-reverse-event",
    operation_id: "e2e-reverse-operation",
    preview_token: "e2e-reverse-token",
    mode: "code",
    decision: "full",
  });
  const resultDialog = page.getByRole("dialog", { name: "回溯结果" });
  await expect(resultDialog).toBeVisible();
  await expect(resultDialog.getByText("回溯完成")).toBeVisible();
  await expect(resultDialog.getByText("src/reverse.ts")).toBeVisible();
  await testInfo.attach("reverse-canonical-preview-result", {
    body: await page.screenshot({ fullPage: true }),
    contentType: "image/png",
  });
});

async function revealFileMutationTool(page: Page, target = "README.md") {
  await expect(page.getByLabel("继续输入")).toBeVisible();
  return revealFileMutationToolIn(page, target);
}

async function revealFileMutationToolIn(scope: Page | Locator, target: string) {
  await scope.getByTestId("message-list-scroll").evaluate((element) => {
    element.scrollTop = 0;
  });
  const group = scope.getByTestId("message-group-block").first();
  if (await group.count()) {
    await group.getByRole("button").first().click();
  }
  const fileTool = scope.getByTestId("tool-call-block").filter({ hasText: target }).first();
  await expect(fileTool).toBeVisible();
  return fileTool;
}

async function gotoRichConversation(page: Page) {
  await page.goto(`${APP_BASE}/#/conversation/${RICH_SESSION}`, { waitUntil: "commit" });
  await expect(page.getByLabel("继续输入")).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(400);
}

function diffRegion(scope: Page | Locator) {
  return scope.locator("[data-keydex-diff-accessibility='true']").first();
}

async function expectDiffLines(
  scope: Page | Locator,
  ...lines: string[]
) {
  const region = diffRegion(scope);
  await expect(region).toBeVisible({ timeout: 15_000 });
  for (const line of lines) {
    await expect(region).toContainText(line);
  }
}

function fileMutationMessage({
  deferred = false,
  diff = REVIEW_DIFF,
  fileChanges,
  id = "file-review",
  operation = "update",
  path = "README.md",
  status = "completed",
  toolName = "apply_patch",
  toolParams,
  toolResult,
}: {
  deferred?: boolean;
  diff?: string;
  fileChanges?: Array<Record<string, unknown>>;
  id?: string;
  operation?: string;
  path?: string;
  status?: string;
  toolName?: string;
  toolParams?: Record<string, unknown>;
  toolResult?: string;
}) {
  return {
    id,
    sessionId: RICH_SESSION,
    role: "tool",
    content: path,
    timestamp: 1_782_518_400_000,
    toolName,
    toolParams: toolParams ?? { path },
    toolResult: toolResult ?? (deferred ? "" : "patched"),
    status,
    toolDetailsDeferred: deferred,
    toolDetailRef: deferred
      ? {
          startEventId: "review-start",
          endEventId: "review-end",
          runId: "run-review",
          toolCallId: "call-review",
        }
      : null,
    runId: "run-review",
    toolCallId: "call-review",
    fileChanges: fileChanges ?? [fileChange(path, diff, operation, deferred)],
  };
}

function fileChange(path: string, diff: string, operation: string, deferred = false) {
  return {
    path,
    operation,
    added_lines: deferred ? 0 : diff.split("\n").filter((line) => line.startsWith("+") && !line.startsWith("+++")).length,
    deleted_lines: deferred ? 0 : diff.split("\n").filter((line) => line.startsWith("-") && !line.startsWith("---")).length,
    diff,
  };
}

function reverseTargetMessage() {
  return {
    id: "reverse-target-message",
    sessionId: RICH_SESSION,
    role: "user",
    content: "请恢复到稳定版本",
    timestamp: 1_782_518_400_000,
    messageEventId: "e2e-reverse-event",
  };
}
