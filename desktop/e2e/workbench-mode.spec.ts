import { mkdir } from "node:fs/promises";
import * as path from "node:path";

import { expect, test, type Locator, type Page, type Route } from "@playwright/test";

import type { SkillSummary } from "@/runtime";

const API_BASE = "http://127.0.0.1:8765";
const APP_BASE = process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173";
const EVIDENCE_ROOT =
  process.env.E2E_WORKBENCH_EVIDENCE_DIR ??
  path.resolve("..", ".dev", "e2e", "evidence", "2026-06-25_17-18-19-workbench-mode");
const E2E_RUN_ID = process.env.E2E_RUN_ID ?? "latest";
const WORKSPACE_A = "workspace-a";
const WORKSPACE_B = "workspace-b";
const SESSION_A = "e2e-session-a";
const SESSION_B = "e2e-session-b";
const NEW_SESSION = "e2e-new-workbench-session";
const README_CONTENT = makeWorkbenchMarkdownContent();

test("agent mode remains the full conversation surface and only switches manually", async ({ page }) => {
  const backend = createWorkbenchBackend();
  await installWebSocketMock(page);
  await mockWorkbenchBackend(page, backend);

  await page.goto(`${APP_BASE}/#/conversation/${SESSION_A}`);
  await expect(page.getByRole("button", { name: "Agent" })).toHaveAttribute("aria-pressed", "true");
  await expectTitlebarModeSwitchGeometry(page);
  await expect(page.getByLabel("继续输入")).toBeVisible();
  await expect(page.getByLabel("展开工作台消息层")).toHaveCount(0);
  await expect(page.getByTestId("workbench-mode-page")).toHaveCount(0);
  await saveEvidence(page, "e2e-001");

  await page.getByRole("button", { name: "工作台模式" }).click();
  await expect(page.getByTestId("workbench-mode-page")).toBeVisible();
  await expect(page.getByTestId("workbench-workspace-picker")).toBeVisible();
  await expectTitlebarModeSwitchGeometry(page);
  await saveEvidence(page, "e2e-002");
});

test("workbench picker, workspace switch and scoped session list stay workspace-first", async ({ page }) => {
  const backend = createWorkbenchBackend();
  await installWebSocketMock(page);
  await mockWorkbenchBackend(page, backend);

  await page.goto(`${APP_BASE}/#/workbench`);
  await expect(page.getByTestId("workbench-workspace-picker")).toBeVisible();
  await expect(page.getByText("无项目聊天")).toHaveCount(0);
  await saveEvidence(page, "e2e-003");

  await page.getByRole("button", { name: "选择工作区" }).click();
  await page.getByRole("option", { name: /keydex/ }).click();
  await expect(page).toHaveURL(/\/workbench\/workspace-a$/);
  await expect(page.getByTestId("workbench-workspace-shell")).toBeVisible();
  await expect(page.getByTestId("workspace-file-browser")).toBeVisible();
  await expect(page.getByTestId("workbench-titlebar-workspace-selector")).toBeVisible();
  await expect(page.getByTestId("workbench-titlebar-workspace-selector")).toContainText("keydex");
  await expect(page.getByRole("main", { name: "工作台" }).getByRole("button", { name: "选择工作区" })).toHaveCount(0);
  await expect(page.getByText("工作台 A 会话")).toBeVisible();
  await expect(page.getByText("工作台 B 会话")).toHaveCount(0);
  await expect(page.getByText("纯对话")).toHaveCount(0);
  await saveEvidence(page, "e2e-004");
  await saveEvidence(page, "e2e-006");

  await page.getByTestId("workbench-titlebar-workspace-selector").getByRole("button", { name: "选择工作区" }).click();
  await page.getByRole("option", { name: /other/ }).click();
  await expect(page).toHaveURL(/\/workbench\/workspace-b$/);
  await expect(page.getByTestId("workbench-mode-page")).toHaveAttribute("data-workspace-id", WORKSPACE_B);
  await expect(page.getByText("工作台 B 会话")).toBeVisible();
  await expect(page.getByTestId("workbench-mode-page")).toHaveAttribute("data-selected-session-id", "");
  await saveEvidence(page, "e2e-005");

  await page.goto(`${APP_BASE}/#/workbench/${WORKSPACE_A}/session/${SESSION_B}`);
  await expect(page).toHaveURL(new RegExp(`/workbench/${WORKSPACE_A}$`));
  await expect(page.getByTestId("workbench-mode-page")).toHaveAttribute("data-workspace-id", WORKSPACE_A);
  await saveEvidence(page, "e2e-007");
});

test("workbench capsule creates workspace-owned sessions, sends, searches and previews files", async ({ page }) => {
  const backend = createWorkbenchBackend();
  await installWebSocketMock(page);
  await mockWorkbenchBackend(page, backend);

  await page.goto(`${APP_BASE}/#/workbench/${WORKSPACE_A}`);
  const input = await openWorkbenchComposer(page);
  await input.click();
  await page.keyboard.type("e2e new task");
  await page.getByLabel("发送").click();

  await expect(page).toHaveURL(new RegExp(`/workbench/${WORKSPACE_A}/session/${NEW_SESSION}$`));
  expect(backend.createdSessionPayloads.at(-1)).toMatchObject({
    session_type: "workspace",
    workspace_id: WORKSPACE_A,
    title: "e2e new task",
  });
  const chatFrame = await lastChatFrame(page);
  expect(chatFrame?.data).toMatchObject({
    session_id: NEW_SESSION,
    message: "e2e new task",
    model: "qwen-coder",
  });
  await saveEvidence(page, "e2e-008");
  await saveEvidence(page, "e2e-011");
  await dispatchAgentEvent(page, {
    action: "completed",
    data: { session_id: NEW_SESSION, status: "completed", final_content: "done", events: [] },
  });

  await page.getByRole("button", { name: "Agent" }).click();
  await expect(page).toHaveURL(new RegExp(`/conversation/${NEW_SESSION}$`));
  await expect(page.getByRole("heading", { name: "e2e new task" })).toBeVisible();
  await expect(page.getByLabel("继续输入")).toBeVisible();
  await saveEvidence(page, "e2e-009");

  await page.goto(`${APP_BASE}/#/workbench/${WORKSPACE_A}/session/${NEW_SESSION}`);
  await expect(page.getByTestId("workbench-assistant-surface")).toHaveAttribute("data-surface-mode", "capsule");
  await saveEvidence(page, "e2e-010");

  const resumedInput = await openWorkbenchComposer(page);
  await resumedInput.click();
  await page.keyboard.type("@READ");
  await expect(page.getByTestId("at-file-menu")).toBeVisible();
  await expect(page.getByRole("option", { name: /README\.md/ })).toBeVisible();
  expect(backend.workspaceSearchRequests.at(-1)).toMatchObject({ workspaceId: WORKSPACE_A, query: "READ" });
  await saveEvidence(page, "e2e-012");

  await page.getByRole("button", { name: "选择文件 README.md" }).click();
  await expect(page.getByRole("heading", { name: "E2E Workbench File" })).toBeVisible();
  expect(backend.workspaceReadRequests.at(-1)).toMatchObject({ workspaceId: WORKSPACE_A, path: "README.md" });
  await saveEvidence(page, "e2e-013");
});

test("workbench slash skill selection creates a composer capsule", async ({ page }) => {
  const backend = createWorkbenchBackend({
    skills: [
      {
        name: "dev-plan",
        label: "/dev-plan",
        source: "workspace",
        description: "计划拆分",
        locator: ".keydex/skills/dev-plan/SKILL.md",
      },
    ],
  });
  await installWebSocketMock(page);
  await mockWorkbenchBackend(page, backend);

  await page.goto(`${APP_BASE}/#/workbench/${WORKSPACE_A}/session/${SESSION_A}`);
  const input = await openWorkbenchComposer(page);
  await input.click();
  await page.keyboard.type("/dev-plan");

  const skillOption = page.getByRole("option", { name: /选择 Skill \/dev-plan/ });
  await expect(skillOption).toBeVisible();
  await expect(skillOption).toHaveAttribute("data-active", "true");
  await page.keyboard.press("Enter");

  await expect(input).toHaveText("");
  await expect(page.getByLabel("删除 Skill /dev-plan")).toBeVisible();
  await page.getByLabel("打开 Skill dev-plan").click();

  await expect(page.getByRole("heading", { name: "E2E Workbench File" })).toBeVisible();
  expect(backend.skillReadRequests.at(-1)).toMatchObject({
    sessionId: SESSION_A,
    skillName: "dev-plan",
    resourcePath: "SKILL.md",
  });
});

test("workbench new-session capsule keeps workspace skills available", async ({ page }) => {
  const backend = createWorkbenchBackend({
    skills: [
      {
        name: "dev-plan",
        label: "/dev-plan",
        source: "workspace",
        description: "计划拆分",
        locator: ".keydex/skills/dev-plan/SKILL.md",
      },
    ],
  });
  await installWebSocketMock(page);
  await mockWorkbenchBackend(page, backend);

  await page.goto(`${APP_BASE}/#/workbench/${WORKSPACE_A}/session/${SESSION_A}`);
  await page.getByRole("button", { name: "新会话" }).click();
  await expect(page).toHaveURL(new RegExp(`/workbench/${WORKSPACE_A}$`));

  const input = await openWorkbenchComposer(page);
  await input.click();
  await page.keyboard.type("/dev-plan");

  await expect(page.getByRole("option", { name: /选择 Skill \/dev-plan/ })).toBeVisible();
});

test("workbench composer preserves context chips after collapsing to capsule", async ({ page }) => {
  const backend = createWorkbenchBackend({
    skills: [
      {
        name: "dev-plan",
        label: "/dev-plan",
        source: "workspace",
        description: "计划拆分",
        locator: ".keydex/skills/dev-plan/SKILL.md",
      },
    ],
  });
  await installWebSocketMock(page);
  await mockWorkbenchBackend(page, backend);

  await page.goto(`${APP_BASE}/#/workbench/${WORKSPACE_A}/session/${SESSION_A}`);
  const input = await openWorkbenchComposer(page);
  await input.click();
  await page.keyboard.type("retain context @READ");
  await page.getByRole("option", { name: /README\.md/ }).click();
  await input.click();
  await page.keyboard.type(" /dev-plan");
  await expect(page.getByRole("option", { name: /选择 Skill \/dev-plan/ })).toBeVisible();
  await page.keyboard.press("Enter");

  await expect(input).toHaveText("retain context");
  await expect(page.getByLabel("移除文件引用 README.md")).toBeVisible();
  await expect(page.getByLabel("删除 Skill /dev-plan")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("workbench-assistant-surface")).toHaveAttribute("data-surface-mode", "capsule");
  await expect(page.getByLabel("工作台助手输入")).toHaveCount(0);

  const reopenedInput = await openWorkbenchComposer(page);
  await expect(reopenedInput).toHaveText("retain context");
  await expect(page.getByLabel("移除文件引用 README.md")).toBeVisible();
  await expect(page.getByLabel("删除 Skill /dev-plan")).toBeVisible();
});

test("workbench drawer composer keeps toolbar inset with context chips", async ({ page }) => {
  const backend = createWorkbenchBackend({
    skills: [
      {
        name: "dev-plan",
        label: "/dev-plan",
        source: "workspace",
        description: "计划拆分",
        locator: ".keydex/skills/dev-plan/SKILL.md",
      },
    ],
  });
  await installWebSocketMock(page);
  await mockWorkbenchBackend(page, backend);

  await page.goto(`${APP_BASE}/#/workbench/${WORKSPACE_A}/session/${SESSION_A}`);
  const input = await openWorkbenchComposer(page);
  await input.click();
  await page.keyboard.type("layout check @READ");
  await page.getByRole("option", { name: /README\.md/ }).click();
  await input.click();
  await page.keyboard.type(" /dev-plan");
  await page.keyboard.press("Enter");

  await expect(page.getByLabel("移除文件引用 README.md")).toBeVisible();
  await expect(page.getByLabel("删除 Skill /dev-plan")).toBeVisible();
  await page.getByRole("button", { name: "将工作台助手展开到右侧" }).click();
  await expect(page.getByTestId("workbench-assistant-surface")).toHaveAttribute("data-surface-mode", "drawer");

  const layoutInsets = await page.getByTestId("workbench-assistant-drawer-input-surface").evaluate((surface) => {
    const sendButton = surface.querySelector<HTMLButtonElement>("button[aria-label='发送']");
    const frame = surface.closest<HTMLElement>("[data-testid='workbench-assistant-drawer-composer-frame']");
    const capsule = frame?.closest<HTMLElement>("[data-testid='workbench-assistant-capsule']");
    if (!sendButton) {
      throw new Error("Send button was not rendered inside drawer composer.");
    }
    if (!frame) {
      throw new Error("Drawer composer frame was not rendered.");
    }
    if (!capsule) {
      throw new Error("Drawer composer capsule was not rendered.");
    }
    return {
      buttonBottomInset: surface.getBoundingClientRect().bottom - sendButton.getBoundingClientRect().bottom,
      inputBottomInset: frame.getBoundingClientRect().bottom - surface.getBoundingClientRect().bottom,
      capsuleBottomInset: capsule.getBoundingClientRect().bottom - frame.getBoundingClientRect().bottom,
    };
  });
  expect(layoutInsets.buttonBottomInset).toBeGreaterThanOrEqual(6);
  expect(layoutInsets.inputBottomInset).toBeGreaterThanOrEqual(2);
  expect(layoutInsets.inputBottomInset).toBeLessThanOrEqual(6);
  expect(layoutInsets.capsuleBottomInset).toBeGreaterThanOrEqual(6);
  expect(layoutInsets.capsuleBottomInset).toBeLessThanOrEqual(10);
});

test("workbench expanded layer, drawer and approval stay above the workspace", async ({ page }) => {
  const backend = createWorkbenchBackend();
  await installWebSocketMock(page);
  await mockWorkbenchBackend(page, backend);

  await page.goto(`${APP_BASE}/#/workbench/${WORKSPACE_A}/session/${SESSION_A}`);
  await expect(page.getByTestId("app-shell")).toHaveAttribute("data-right-sidebar-enabled", "false");
  await expect(page.getByTestId("app-shell")).toHaveAttribute("data-right-sidebar", "closed");
  await expect(page.getByLabel("展开右侧栏")).toHaveCount(0);
  const fileBrowser = page.getByTestId("workspace-file-browser");
  await expect(fileBrowser).toBeVisible();
  const beforeBox = await fileBrowser.boundingBox();

  await openWorkbenchComposer(page);
  await expect(page.getByRole("button", { name: "展开工作台消息层" })).toBeVisible();
  await page.getByRole("button", { name: "展开工作台消息层" }).click();
  await expect(page.getByRole("button", { name: "收起工作台消息层" })).toBeVisible();
  const expanded = page.getByTestId("workbench-expanded-layer");
  await expect(expanded).toBeVisible();
  await expect(fileBrowser).toBeVisible();
  expect(await expanded.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
  const afterBox = await fileBrowser.boundingBox();
  expect(Math.round(afterBox?.width ?? 0)).toBe(Math.round(beforeBox?.width ?? 0));
  await saveEvidence(page, "e2e-016");

  await expanded.click({ position: { x: 12, y: 12 } });
  await expect(expanded).toHaveCount(0);
  await expect(page.getByTestId("workbench-assistant-surface")).toHaveAttribute("data-surface-mode", "capsule");
  await expect(page.getByLabel("工作台助手输入")).toHaveCount(0);
  await openWorkbenchComposer(page);
  await page.getByRole("button", { name: "展开工作台消息层" }).click();
  await expect(expanded).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(expanded).toHaveCount(0);
  await expect(page.getByTestId("workbench-assistant-surface")).toHaveAttribute("data-surface-mode", "capsule");
  await expect(page.getByLabel("工作台助手输入")).toHaveCount(0);
  await openWorkbenchComposer(page);
  await page.getByRole("button", { name: "展开工作台消息层" }).click();
  await expect(expanded).toBeVisible();

  await page.getByRole("button", { name: "收起工作台消息层" }).click();
  await expect(expanded).toHaveCount(0);
  await expect(page.getByTestId("workbench-assistant-surface")).toHaveAttribute("data-surface-mode", "capsule");
  await expect(page.getByTestId("workbench-assistant-chrome")).toHaveAttribute("data-shell-mode", "capsule");
  await expect(page.getByLabel("工作台助手输入")).toHaveCount(0);
  await saveEvidence(page, "e2e-017");

  await openWorkbenchComposer(page);
  await page.getByRole("button", { name: "将工作台助手展开到右侧" }).click();
  const drawer = page.getByTestId("workbench-assistant-drawer");
  await expect(drawer).toBeVisible();
  await expect(page.getByRole("button", { name: "展开工作台消息层" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "收回工作台助手为胶囊" })).toBeVisible();
  await expect(page.getByTestId("workbench-assistant-surface")).toHaveAttribute("data-dock-transition", "idle");
  await expect(drawer).toHaveCSS("box-shadow", "none");
  await expect(drawer).toHaveCSS("backdrop-filter", "none");
  const drawerBox = await drawer.boundingBox();
  expect(drawerBox?.width ?? 0).toBeGreaterThanOrEqual(320);
  expect(drawerBox?.width ?? 0).toBeLessThanOrEqual(520);
  const dockedFileBox = await fileBrowser.boundingBox();
  expect(dockedFileBox?.width ?? 0).toBeLessThan((beforeBox?.width ?? 0) - 300);
  expect(Math.round(drawerBox?.x ?? 0)).toBeGreaterThanOrEqual(Math.round((dockedFileBox?.x ?? 0) + (dockedFileBox?.width ?? 0)) - 6);
  await expect(page.getByTestId("app-shell")).toHaveAttribute("data-right-sidebar", "closed");
  await expect(page.getByTestId("right-sidebar-initial-page")).toHaveCount(0);
  await expect(page.getByTestId("workbench-expanded-layer")).toHaveCount(0);
  await saveEvidence(page, "e2e-018");

  await dispatchAgentEvent(page, {
    action: "approval_requested",
    data: {
      session_id: SESSION_A,
      approval: approval("e2e-approval-1"),
    },
  });
  await expect(page.getByTestId("workbench-approval-prompt")).toBeVisible();
  await page.getByRole("button", { name: "批准" }).click();
  expect(backend.approvalDecisions.at(-1)).toMatchObject({
    approvalId: "e2e-approval-1",
    body: { decision: "approved", trust_scope: "once" },
  });
  await saveEvidence(page, "e2e-020");

  await page.getByRole("button", { name: "关闭工作台助手侧栏" }).click();
  await expect(drawer).toHaveCount(0);
  await expect(page.getByTestId("workbench-assistant-surface")).toHaveAttribute("data-surface-mode", "capsule");
  await saveEvidence(page, "e2e-019");
});

test("workbench dock keeps large markdown searchable without enabling the global sidebar", async ({ page }) => {
  const backend = createWorkbenchBackend();
  await installWebSocketMock(page);
  await mockWorkbenchBackend(page, backend);

  await page.goto(`${APP_BASE}/#/workbench/${WORKSPACE_A}/session/${SESSION_A}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "选择文件 README.md" }).click();
  await expect(page.getByRole("heading", { name: "E2E Workbench File" })).toBeVisible();
  const virtualPreview = page.locator("[data-markdown-virtual-preview='true']");
  await expect(virtualPreview).toBeAttached();
  const initialMetrics = await virtualPreview.evaluate((element) => ({
    mountedBlocks: Number(element.getAttribute("data-markdown-mounted-block-count") ?? 0),
    totalBlocks: Number(element.getAttribute("data-markdown-block-count") ?? 0),
  }));
  expect(initialMetrics.totalBlocks).toBeGreaterThan(200);
  expect(initialMetrics.mountedBlocks).toBeGreaterThan(0);
  expect(initialMetrics.mountedBlocks).toBeLessThan(initialMetrics.totalBlocks);

  await page.getByRole("button", { name: "将工作台助手展开到右侧" }).click();
  await expect(page.getByTestId("workbench-assistant-drawer")).toBeVisible();
  await expect(page.getByTestId("app-shell")).toHaveAttribute("data-right-sidebar-enabled", "false");
  await expect(page.getByTestId("app-shell")).toHaveAttribute("data-right-sidebar", "closed");

  const previewPanel = page.getByTestId("workbench-main-file-preview");
  await previewPanel.getByRole("button", { name: "搜索文件内容" }).click();
  const search = page.getByRole("search", { name: "文件内容搜索" });
  await search.getByLabel("搜索文件内容").fill("tail-search-target");
  await expect(search).toContainText("1/1");
  await expect(page.getByText("tail-search-target")).toBeVisible();
  await expect(page.getByTestId("workbench-assistant-drawer")).toBeVisible();
  const tailMetrics = await virtualPreview.evaluate((element) => ({
    mountedBlocks: Number(element.getAttribute("data-markdown-mounted-block-count") ?? 0),
    totalBlocks: Number(element.getAttribute("data-markdown-block-count") ?? 0),
  }));
  expect(tailMetrics.mountedBlocks).toBeLessThan(tailMetrics.totalBlocks);
  await saveEvidence(page, "markdown-e2e-workbench-dock-search");
});

test("workbench running task survives manual mode switching", async ({ page }) => {
  const backend = createWorkbenchBackend();
  await installWebSocketMock(page);
  await mockWorkbenchBackend(page, backend);

  await page.goto(`${APP_BASE}/#/workbench/${WORKSPACE_A}/session/${SESSION_A}`);
  const input = await openWorkbenchComposer(page);
  await input.click();
  await page.keyboard.type("keep running while switching");
  await page.getByLabel("发送").click();
  await expect(page.getByRole("button", { name: "停止" })).toBeEnabled();
  const countAfterSend = await chatFrameCount(page);

  await page.getByRole("button", { name: "Agent" }).click();
  await expect(page).toHaveURL(new RegExp(`/conversation/${SESSION_A}$`));
  await expect(page.getByRole("button", { name: "停止" })).toBeEnabled();
  await expect(page.getByLabel("展开工作台消息层")).toHaveCount(0);

  await page.getByRole("button", { name: "工作台模式" }).click();
  await expect(page).toHaveURL(new RegExp(`/workbench/${WORKSPACE_A}$`));
  await page.getByRole("button", { name: "工作台 A 会话", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/workbench/${WORKSPACE_A}/session/${SESSION_A}$`));
  await openWorkbenchComposer(page);
  await expect(page.getByRole("button", { name: "停止" })).toBeEnabled();
  expect(await chatFrameCount(page)).toBe(countAfterSend);
  await saveEvidence(page, "e2e-021");
});

test("workbench keeps controls usable across responsive viewports and reload", async ({ page }) => {
  const backend = createWorkbenchBackend();
  await installWebSocketMock(page);
  await mockWorkbenchBackend(page, backend);

  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 1440, height: 900 },
    { width: 1600, height: 1000 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto(`${APP_BASE}/#/workbench/${WORKSPACE_A}/session/${SESSION_A}`);
    await expect(page.getByRole("region", { name: "工作区文件浏览器" })).toBeVisible();
    await openWorkbenchComposer(page);
    if (viewport.width === 1280) {
      const inputSurface = page.getByTestId("workbench-assistant-input-surface");
      await expect
        .poll(async () => Math.round((await inputSurface.boundingBox())?.width ?? 0), { timeout: 3000 })
        .toBeGreaterThan(620);
      const inputSurfaceBox = await inputSurface.boundingBox();
      const sendButton = page.getByRole("button", { name: "发送" });
      await expect(page.getByRole("button", { name: "选择模型" })).toBeEnabled();
      const sendBeforeBox = await sendButton.boundingBox();
      await page.getByRole("button", { name: "选择模型" }).click();
      const modelMenu = page.locator("[data-placement='top']").last();
      await expect(modelMenu).toBeVisible();
      const modelMenuBox = await modelMenu.boundingBox();
      const sendAfterBox = await sendButton.boundingBox();
      expect(modelMenuBox?.y ?? Number.POSITIVE_INFINITY).toBeLessThan((inputSurfaceBox?.y ?? 0) - 4);
      expect(Math.abs((sendAfterBox?.x ?? 0) - (sendBeforeBox?.x ?? 0))).toBeLessThanOrEqual(2);
      await page.keyboard.press("Escape");
      await expect(modelMenu).toHaveCount(0);
    }
    await page.getByRole("button", { name: "展开工作台消息层" }).click();
    await expect(page.getByTestId("workbench-expanded-layer")).toBeVisible();
    await page.getByRole("button", { name: "将工作台助手展开到右侧" }).click();
    await expect(page.getByTestId("workbench-assistant-drawer")).toBeVisible();
    await expect(page.getByRole("button", { name: "展开工作台消息层" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "收回工作台助手为胶囊" })).toBeVisible();
    await saveEvidence(page, viewport.width === 1280 ? "e2e-022" : viewport.width === 1440 ? "e2e-023" : "e2e-024");
    await page.getByRole("button", { name: "收回工作台助手为胶囊" }).click();
    await expect(page.getByTestId("workbench-assistant-surface")).toHaveAttribute("data-surface-mode", "capsule");
  }

  await expect(page.getByTestId("workbench-assistant-surface")).toHaveAttribute("data-dock-transition", "idle");
  await openWorkbenchComposer(page);
  await page.getByRole("button", { name: "展开工作台消息层" }).click();
  await expect(page.getByTestId("workbench-expanded-layer")).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("workbench-mode-page")).toHaveAttribute("data-workspace-id", WORKSPACE_A);
  await expect(page.getByTestId("workbench-mode-page")).toHaveAttribute("data-selected-session-id", SESSION_A);
  await expect(page.getByTestId("workbench-assistant-surface")).toHaveAttribute("data-surface-mode", "capsule");
  await saveEvidence(page, "e2e-025");
  await saveEvidence(page, "e2e-026");
});

async function saveEvidence(page: Page, caseId: string) {
  const directory = path.join(EVIDENCE_ROOT, caseId, E2E_RUN_ID);
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, "success.png"), fullPage: true });
}

async function openWorkbenchComposer(page: Page): Promise<Locator> {
  const input = page.getByLabel("工作台助手输入");
  if ((await input.count()) === 0) {
    await page.getByRole("button", { name: "展开工作台输入框" }).click();
  }
  await expect(input).toBeVisible();
  return input;
}

async function expectTitlebarModeSwitchGeometry(page: Page) {
  const metrics = await page.getByTestId("app-mode-switch").evaluate((switchElement) => {
    const buttons = Array.from(switchElement.querySelectorAll("button"));
    const [agentButton, workbenchButton, projectButton] = buttons;
    if (
      !(agentButton instanceof HTMLElement) ||
      !(workbenchButton instanceof HTMLElement) ||
      !(projectButton instanceof HTMLElement)
    ) {
      throw new Error("Titlebar mode switch buttons were not rendered.");
    }
    const switchStyle = window.getComputedStyle(switchElement);
    const sliderStyle = window.getComputedStyle(switchElement, "::before");
    const agentRect = agentButton.getBoundingClientRect();
    const workbenchRect = workbenchButton.getBoundingClientRect();
    const projectRect = projectButton.getBoundingClientRect();

    return {
      sliderBoxSizing: sliderStyle.boxSizing,
      flexShrink: switchStyle.flexShrink,
      switchWidth: switchElement.getBoundingClientRect().width,
      agentWidth: agentRect.width,
      workbenchWidth: workbenchRect.width,
      projectWidth: projectRect.width,
      agentCenterY: agentRect.top + agentRect.height / 2,
      workbenchCenterY: workbenchRect.top + workbenchRect.height / 2,
      projectCenterY: projectRect.top + projectRect.height / 2,
    };
  });

  expect(metrics.sliderBoxSizing).toBe("border-box");
  expect(metrics.flexShrink).toBe("0");
  expect(Math.abs(metrics.switchWidth - 248)).toBeLessThan(0.5);
  expect(Math.abs(metrics.agentWidth - metrics.workbenchWidth)).toBeLessThan(0.5);
  expect(Math.abs(metrics.agentWidth - metrics.projectWidth)).toBeLessThan(0.5);
  expect(Math.abs(metrics.agentCenterY - metrics.workbenchCenterY)).toBeLessThan(0.5);
  expect(Math.abs(metrics.agentCenterY - metrics.projectCenterY)).toBeLessThan(0.5);
}

async function selectVisibleText(page: Page, text: string) {
  await page.evaluate((needle) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let current = walker.nextNode();
    while (current) {
      const value = current.textContent ?? "";
      const start = value.indexOf(needle);
      if (start >= 0) {
        const range = document.createRange();
        range.setStart(current, start);
        range.setEnd(current, start + needle.length);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
        return;
      }
      current = walker.nextNode();
    }
    throw new Error(`Text not found: ${needle}`);
  }, text);
}

interface MockBackendState {
  sessions: Record<string, E2ESession>;
  createdSessionPayloads: Array<Record<string, unknown>>;
  workspaceSearchRequests: Array<{ workspaceId: string; query: string }>;
  workspaceReadRequests: Array<{ workspaceId: string; path: string }>;
  skillReadRequests: Array<{ sessionId: string; skillName: string; resourcePath: string }>;
  approvalDecisions: Array<{ approvalId: string; body: Record<string, unknown> }>;
  skills: SkillSummary[];
}

interface E2ESession {
  id: string;
  title: string;
  session_type: "chat" | "workspace";
  workspace_id: string | null;
  workspace: E2EWorkspace | null;
}

interface E2EWorkspace {
  id: string;
  name: string;
  root_path: string;
  archived_at: null;
}

function createWorkbenchBackend({ skills = [] }: { skills?: SkillSummary[] } = {}): MockBackendState {
  return {
    sessions: {
      [SESSION_A]: session(SESSION_A, "工作台 A 会话", WORKSPACE_A),
      [SESSION_B]: session(SESSION_B, "工作台 B 会话", WORKSPACE_B),
      "e2e-pure-chat": session("e2e-pure-chat", "纯对话", null),
    },
    createdSessionPayloads: [],
    workspaceSearchRequests: [],
    workspaceReadRequests: [],
    skillReadRequests: [],
    approvalDecisions: [],
    skills,
  };
}

async function mockWorkbenchBackend(page: Page, backend: MockBackendState) {
  await page.route(`${API_BASE}/api/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (path === "/api/settings") {
      return fulfillJson(route, {
        model: {
          base_url: "https://api.example/v1",
          model: "qwen-coder",
          timeout_seconds: 60,
          api_key_set: true,
          api_key_preview: "sk-***",
        },
        command: {
          selected_shell: "cmd",
          shell_path: "C:/Windows/System32/cmd.exe",
          shell_label: "CMD",
          shell_edition: null,
          require_approval_for_untrusted: true,
          allow_persistent_trust: true,
          file_access_mode: "workspace_trusted",
          default_timeout_seconds: 120,
          max_timeout_seconds: 600,
          inline_output_max_chars: 12000,
          tail_max_chars: 12000,
          output_file_max_bytes: 8388608,
          progress_interval_ms: 500,
        },
      });
    }
    if (path === "/api/settings/model-defaults") {
      return fulfillJson(route, modelDefaultsResponse());
    }
    if (path === "/api/models") {
      return fulfillJson(route, { models: [{ id: "qwen-coder" }], cached: true });
    }
    if (path === "/api/model-providers") {
      return fulfillJson(route, modelProvidersResponse());
    }
    if (path === "/api/workspaces" && method === "GET") {
      return fulfillJson(route, { list: [workspace(WORKSPACE_A, "keydex"), workspace(WORKSPACE_B, "other")], total: 2 });
    }
    if (path.startsWith("/api/workspaces/") && method === "GET" && !path.includes("/tree") && !path.includes("/read") && !path.includes("/search") && !path.includes("/skills")) {
      return fulfillJson(route, { workspace: workspace(decodeURIComponent(path.split("/").at(-1) ?? ""), "keydex") });
    }
    if (path === "/api/sessions" && method === "GET") {
      const workspaceId = url.searchParams.get("workspace_id");
      const sessionType = url.searchParams.get("session_type");
      const sessions = Object.values(backend.sessions).filter((item) => {
        if (workspaceId) {
          return item.workspace_id === workspaceId;
        }
        if (sessionType === "workspace") {
          return item.session_type === "workspace";
        }
        return true;
      });
      return fulfillJson(route, { list: sessions.map(sessionResponse), total: sessions.length, page: 1, page_size: 50 });
    }
    if (path === "/api/sessions" && method === "POST") {
      const payload = request.postDataJSON() as Record<string, unknown>;
      backend.createdSessionPayloads.push(payload);
      const created = session(
        NEW_SESSION,
        String(payload.title || "e2e new task"),
        String(payload.workspace_id || WORKSPACE_A),
      );
      backend.sessions[created.id] = created;
      return fulfillJson(route, { session: sessionResponse(created) });
    }
    const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)$/);
    if (sessionMatch && method === "GET") {
      const id = decodeURIComponent(sessionMatch[1]);
      return fulfillJson(route, { session: sessionResponse(backend.sessions[id] ?? backend.sessions[SESSION_A]) });
    }
    const sessionSkillsMatch = path.match(/^\/api\/sessions\/([^/]+)\/skills$/);
    if (sessionSkillsMatch && method === "GET") {
      const id = decodeURIComponent(sessionSkillsMatch[1]);
      const target = backend.sessions[id] ?? backend.sessions[SESSION_A];
      return fulfillJson(route, {
        mode: target.workspace ? "workspace_effective" : "system_only",
        workspace_root: target.workspace?.root_path ?? null,
        fingerprint: "e2e",
        loaded_at: "2026-06-25T00:00:00Z",
        skills: backend.skills,
        diagnostics: [],
      });
    }
    const sessionSkillReadMatch = path.match(/^\/api\/sessions\/([^/]+)\/skills\/read$/);
    if (sessionSkillReadMatch && method === "POST") {
      const sessionId = decodeURIComponent(sessionSkillReadMatch[1]);
      const payload = request.postDataJSON() as {
        skill_name: string;
        source: SkillSummary["source"];
        resource_path: string;
      };
      backend.skillReadRequests.push({
        sessionId,
        skillName: payload.skill_name,
        resourcePath: payload.resource_path,
      });
      return fulfillJson(route, {
        skill_name: payload.skill_name,
        source: payload.source,
        resource_path: payload.resource_path,
        locator: `.keydex/skills/${payload.skill_name}/${payload.resource_path}`,
        content: README_CONTENT,
        encoding: "utf-8",
        revision: "e2e-revision",
        fingerprint: "e2e",
      });
    }
    const sessionTasksMatch = path.match(/^\/api\/sessions\/([^/]+)\/tasks$/);
    if (sessionTasksMatch && method === "GET") {
      return fulfillJson(route, { list: [] });
    }
    const historyMatch = path.match(/^\/api\/sessions\/([^/]+)\/history$/);
    if (historyMatch) {
      const id = decodeURIComponent(historyMatch[1]);
      const target = backend.sessions[id] ?? backend.sessions[SESSION_A];
      return fulfillJson(route, {
        session: sessionResponse(target),
        list: [
          {
            id: `hist-user-${id}`,
            role: "user",
            content: "历史问题",
            timestamp: 1,
          },
          {
            id: `hist-assistant-${id}`,
            role: "assistant",
            content: "历史回答",
            timestamp: 2,
          },
        ],
        next_cursor: null,
        has_more_older: false,
      });
    }
    const workspaceMatch = path.match(/^\/api\/workspaces\/([^/]+)(\/.*)?$/);
    if (workspaceMatch) {
      const workspaceId = decodeURIComponent(workspaceMatch[1]);
      const suffix = workspaceMatch[2] ?? "";
      if (suffix === "/tree") {
        return fulfillJson(route, {
          root: workspace(workspaceId, workspaceId).root_path,
          entries: [
            { name: "README.md", path: "README.md", type: "file", size: 35, modified_at: null },
            { name: "src", path: "src", type: "directory", size: null, modified_at: null },
          ],
        });
      }
      if (suffix === "/read") {
        const filePath = url.searchParams.get("path") ?? "";
        backend.workspaceReadRequests.push({ workspaceId, path: filePath });
        return fulfillJson(route, { path: filePath, content: README_CONTENT, encoding: "utf-8" });
      }
      if (suffix === "/search") {
        backend.workspaceSearchRequests.push({ workspaceId, query: url.searchParams.get("q") ?? "" });
        return fulfillJson(route, [{ name: "README.md", path: "README.md", type: "file" }]);
      }
      if (suffix === "/skills") {
        return fulfillJson(route, {
          mode: "workspace_effective",
          workspace_root: workspace(workspaceId, workspaceId).root_path,
          fingerprint: "e2e",
          loaded_at: "2026-06-25T00:00:00Z",
          skills: backend.skills,
          diagnostics: [],
        });
      }
    }
    const approvalMatch = path.match(/^\/api\/approvals\/([^/]+)\/decision$/);
    if (approvalMatch && method === "POST") {
      const approvalId = decodeURIComponent(approvalMatch[1]);
      const body = request.postDataJSON() as Record<string, unknown>;
      backend.approvalDecisions.push({ approvalId, body });
      return fulfillJson(route, { ...approval(approvalId), status: "approved", decision: body.decision, trust_scope: body.trust_scope });
    }
    return fulfillJson(route, {});
  });
}

function modelDefaultsResponse() {
  return {
    defaults: {
      default_chat: {
        scope: "default_chat",
        configured: true,
        provider_id: "provider-1",
        provider_name: "默认模型服务",
        model: "qwen-coder",
        provider_enabled: true,
        model_enabled: true,
        missing_reason: null,
      },
      fast: {
        scope: "fast",
        configured: false,
        provider_id: null,
        provider_name: null,
        model: null,
        provider_enabled: null,
        model_enabled: null,
        missing_reason: "not_configured",
      },
    },
  };
}

function modelProvidersResponse() {
  return {
    providers: [
      {
        id: "provider-1",
        name: "默认模型服务",
        base_url: "https://api.example/v1",
        enabled: true,
        api_key_set: true,
        api_key_preview: "sk-***",
        models: ["qwen-coder"],
        model_enabled: { "qwen-coder": true },
        health: {},
      },
    ],
  };
}

async function installWebSocketMock(page: Page) {
  await page.addInitScript(() => {
    type MockSocket = Record<string, unknown> & {
      onopen: ((event: Event) => void) | null;
      onclose: ((event: CloseEvent) => void) | null;
      onmessage: ((event: MessageEvent) => void) | null;
      readyState: number;
    };
    const sockets: MockSocket[] = [];
    (window as Window & { __wsSentMessages?: unknown[]; __dispatchAgentEvent?: (event: unknown) => void }).__wsSentMessages = [];
    const NativeWebSocket = window.WebSocket;
    const MockWebSocket = function MockWebSocket(this: MockSocket, url: string) {
      if (!String(url).includes("/agent-base/ws/chat")) {
        return new NativeWebSocket(url);
      }
      this.url = url;
      this.readyState = MockWebSocket.CONNECTING;
      this.onopen = null;
      this.onclose = null;
      this.onerror = null;
      this.onmessage = null;
      sockets.push(this);
      window.setTimeout(() => {
        this.readyState = MockWebSocket.OPEN;
        this.onopen?.(new Event("open"));
      }, 0);
      return this;
    } as unknown as typeof WebSocket & {
      prototype: WebSocket;
      CONNECTING: number;
      OPEN: number;
      CLOSING: number;
      CLOSED: number;
    };
    MockWebSocket.CONNECTING = 0;
    MockWebSocket.OPEN = 1;
    MockWebSocket.CLOSING = 2;
    MockWebSocket.CLOSED = 3;
    MockWebSocket.prototype.send = function send(data: string) {
      const sentMessages = (window as Window & { __wsSentMessages?: unknown[] }).__wsSentMessages ?? [];
      try {
        sentMessages.push(JSON.parse(data));
      } catch {
        sentMessages.push(data);
      }
      (window as Window & { __wsSentMessages?: unknown[] }).__wsSentMessages = sentMessages;
    };
    MockWebSocket.prototype.close = function close(this: MockSocket) {
      this.readyState = MockWebSocket.CLOSED;
      this.onclose?.(new CloseEvent("close", { code: 1000 }));
    };
    (window as Window & { __dispatchAgentEvent?: (event: unknown) => void }).__dispatchAgentEvent = (event) => {
      const message = new MessageEvent("message", { data: JSON.stringify(event) });
      sockets.forEach((socket) => socket.onmessage?.(message));
    };
    Object.assign(window, { WebSocket: MockWebSocket as unknown as typeof WebSocket });
  });
}

async function dispatchAgentEvent(page: Page, event: unknown) {
  await page.evaluate((payload) => {
    (window as Window & { __dispatchAgentEvent?: (event: unknown) => void }).__dispatchAgentEvent?.(payload);
  }, event);
}

async function lastChatFrame(page: Page) {
  const handle = await page.waitForFunction(() => {
    const sentMessages = (window as Window & { __wsSentMessages?: Array<Record<string, unknown>> }).__wsSentMessages ?? [];
    return sentMessages.findLast((message) => message.action === "chat") ?? null;
  });
  return handle.jsonValue() as Promise<{ action?: string; data?: Record<string, unknown> } | null>;
}

async function chatFrameCount(page: Page) {
  return page.evaluate(() => {
    const sentMessages = (window as Window & { __wsSentMessages?: Array<Record<string, unknown>> }).__wsSentMessages ?? [];
    return sentMessages.filter((message) => message.action === "chat").length;
  });
}

function workspace(id: string, name: string): E2EWorkspace {
  return {
    id,
    name,
    root_path: `D:/repo/${name}`,
    archived_at: null,
  };
}

function session(id: string, title: string, workspaceId: string | null): E2ESession {
  return {
    id,
    title,
    session_type: workspaceId ? "workspace" : "chat",
    workspace_id: workspaceId,
    workspace: workspaceId ? workspace(workspaceId, workspaceId === WORKSPACE_A ? "keydex" : "other") : null,
  };
}

function sessionResponse(item: E2ESession) {
  return {
    id: item.id,
    user_id: "local-user",
    scene_id: "desktop-agent",
    status: "active",
    title: item.title,
    session_tag: "chat",
    session_type: item.session_type,
    workspace_id: item.workspace_id,
    cwd: item.workspace?.root_path ?? null,
    workspace_roots: item.workspace ? [item.workspace.root_path] : [],
    workspace: item.workspace,
    active_session_id: null,
    parent_session_id: null,
    child_session_id: null,
    source_trace_id: null,
    created_at: "2026-06-25T00:00:00Z",
    updated_at: "2026-06-25T00:00:00Z",
    is_debug: false,
    is_scheduled: false,
    is_current: false,
  };
}

function approval(id: string) {
  return {
    id,
    session_id: SESSION_A,
    tool_name: "run_cmd",
    kind: "exec",
    title: "是否允许执行命令？",
    description: "pnpm test",
    details: {
      command: "pnpm test",
      cwd: "D:/repo/keydex",
      tool_name: "run_cmd",
      shell: "cmd",
      shell_label: "CMD",
      shell_path: "C:/Windows/System32/cmd.exe",
    },
    status: "pending",
    created_at: "2026-06-25T00:00:00Z",
  };
}

function makeWorkbenchMarkdownContent(): string {
  const sections = Array.from({ length: 240 }, (_, index) =>
    [
      `## Workbench Virtual Section ${index + 1}`,
      "",
      `Workbench markdown virtualized filler ${index + 1}.`,
      "",
      "```ts",
      `const workbenchE2E${index + 1} = true;`,
      "```",
    ].join("\n"),
  );
  return [
    "# E2E Workbench File",
    "",
    "This file is rendered inside Workbench.",
    "",
    "```ts",
    "const workbenchE2E = true;",
    "```",
    "",
    ...sections,
    "",
    "## Workbench Tail Section",
    "",
    "tail-search-target",
  ].join("\n");
}

function fulfillJson(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}
