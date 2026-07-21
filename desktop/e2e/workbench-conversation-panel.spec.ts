import { expect, test, type Page } from "@playwright/test";

import {
  APP_BASE,
  RICH_SESSION,
  WORKSPACE_A,
  approval,
  createWorkbenchBackend,
  dispatchAgentEvent,
  installWebSocketMock,
  lastChatFrame,
  mockWorkbenchBackend,
  openWorkbenchComposer,
  saveEvidence,
  selectVisibleText,
} from "./workbench-e2e-fixtures";

test("workbench drawer renders the reused Agent conversation panel and message components", async ({ page }) => {
  const backend = createWorkbenchBackend();
  await installWebSocketMock(page);
  await mockWorkbenchBackend(page, backend);

  await page.goto(`${APP_BASE}/#/workbench/${WORKSPACE_A}/session/${RICH_SESSION}`);
  await openWorkbenchComposer(page);
  await page.getByRole("button", { name: "将工作台助手展开到右侧" }).click();

  const drawer = page.getByTestId("workbench-assistant-drawer");
  await expect(drawer).toBeVisible();
  await expect(page.getByTestId("workbench-assistant-surface")).toHaveAttribute("data-dock-transition", "idle");
  await expect(drawer.getByTestId("conversation-panel")).toHaveAttribute("data-conversation-panel-variant", "compact");
  await expect(drawer.getByTestId("message-list")).toHaveAttribute("data-message-list-variant", "compact");
  await expect(page.locator("[data-testid='workbench-message-projection']")).toHaveCount(0);

  await expect(drawer.getByTestId("message-text").first()).toBeVisible();
  await expect(drawer.getByLabel("附加上下文")).toContainText("README.md");
  await expect(drawer.getByLabel("附加上下文")).toContainText("引用片段");
  await expect(drawer.getByLabel("附加上下文")).toContainText("dev-plan");
  await expect(drawer.getByTestId("message-thinking").first()).toBeVisible();
  await expect(drawer.getByTestId("skill-activation-block")).toBeVisible();
  await expect(drawer.getByTestId("error-item")).toBeVisible();

  await drawer.getByTestId("message-list-scroll").evaluate((element) => {
    element.scrollTop = 0;
  });
  const group = drawer.getByTestId("message-group-block").first();
  await expect(group).toBeVisible();
  const groupToggle = group.getByRole("button");
  await groupToggle.focus();
  await groupToggle.press("Enter");
  await expect(drawer.getByTestId("tool-call-block")).toBeVisible();
  await expect(drawer.getByTestId("command-execution-block")).toBeVisible();
  await expect(drawer.getByTestId("file-change-block")).toBeVisible();

  await drawer.getByRole("button", { name: "展开工具详情" }).click();
  await expect(drawer.getByText("Deferred search result from tool details")).toBeVisible();
  expect(backend.toolDetailsRequests.at(-1)).toMatchObject({
    sessionId: RICH_SESSION,
    startEventId: "tool-start",
    endEventId: "tool-end",
  });
  await drawer.getByRole("button", { name: "复制输出" }).first().click();
  await expect(drawer.getByRole("button", { name: "已复制输出" }).first()).toBeVisible();

  await drawer.getByRole("button", { name: "展开命令详情" }).click();
  await expect(drawer.getByText("stdout ok")).toBeVisible();
  const fileChangeBlock = drawer.getByTestId("file-change-block");
  await fileChangeBlock.getByRole("button", { name: "展开文件变更详情" }).click();
  await expect(fileChangeBlock).toContainText("+2");
  await drawer.getByRole("button", { name: "复制错误" }).click();
  await expect(drawer.getByRole("button", { name: "复制错误" })).toContainText("已复制");
  await saveEvidence(page, "was-048-056-062-drawer-components");
});

test("workbench drawer bounds expanded tool groups and exposes result scrolling", async ({ page }) => {
  const longToolPath = "backend/app/keydex/builtin_skills/skills/init-keydex/references/very-long-tool-result-contract.md";
  const longToolResult = Array.from(
    { length: 80 },
    (_, index) => `long result line ${index + 1}: ${"bounded-output ".repeat(12)}`,
  ).join("\n");
  const toolMessages = Array.from({ length: 3 }, (_, index) => ({
    id: `bounded-tool-${index}`,
    sessionId: RICH_SESSION,
    role: "tool",
    content: "",
    timestamp: 1_782_518_400_001 + index,
    toolName: "read_file",
    toolParams: { path: `${longToolPath}.${index}` },
    toolResult: longToolResult,
    toolDurationMs: 150 + index,
    status: "completed",
  }));
  const backend = createWorkbenchBackend({
    historyBySession: {
      [RICH_SESSION]: [
        {
          id: "bounded-user",
          sessionId: RICH_SESSION,
          role: "user",
          content: "读取长路径文件",
          timestamp: 1_782_518_400_000,
        },
        ...toolMessages,
      ],
    },
  });
  await installWebSocketMock(page);
  await mockWorkbenchBackend(page, backend);

  await page.goto(`${APP_BASE}/#/workbench/${WORKSPACE_A}/session/${RICH_SESSION}`);
  await openWorkbenchComposer(page);
  await page.getByRole("button", { name: "将工作台助手展开到右侧" }).click();

  const drawer = page.getByTestId("workbench-assistant-drawer");
  const group = drawer.getByTestId("message-group-block");
  await expect(group).toBeVisible();
  await group.getByRole("button").first().click();
  await expect(group.locator('[data-motion="open"]')).toBeVisible();

  const toolBlock = drawer.getByTestId("tool-call-block").first();
  const toolHeader = toolBlock.getByRole("button", { name: "展开工具详情" });
  await expect(toolHeader).toBeVisible();
  const rowGeometry = await toolHeader.evaluate((header) => {
    const titleGroup = header.children.item(1) as HTMLElement | null;
    const title = titleGroup?.children.item(0) as HTMLElement | null;
    const meta = titleGroup?.children.item(titleGroup.children.length - 1) as HTMLElement | null;
    const trailing = header.children.item(2) as HTMLElement | null;
    const headerRect = header.getBoundingClientRect();
    const blockRect = header.parentElement?.getBoundingClientRect();
    return {
      blockRight: blockRect?.right ?? 0,
      headerRight: headerRect.right,
      metaRight: meta?.getBoundingClientRect().right ?? 0,
      titleClientWidth: title?.clientWidth ?? 0,
      titleScrollWidth: title?.scrollWidth ?? 0,
      trailingRight: trailing?.getBoundingClientRect().right ?? 0,
    };
  });
  expect(rowGeometry.titleScrollWidth).toBeGreaterThan(rowGeometry.titleClientWidth);
  expect(rowGeometry.headerRight).toBeLessThanOrEqual(rowGeometry.blockRight + 1);
  expect(rowGeometry.metaRight).toBeLessThanOrEqual(rowGeometry.headerRight + 1);
  expect(rowGeometry.trailingRight).toBeLessThanOrEqual(rowGeometry.headerRight + 1);

  await toolHeader.click();
  const toolDetails = toolBlock.getByLabel("工具详情", { exact: true });
  await expect(toolDetails).toBeVisible();
  const panelGeometry = await toolDetails.evaluate((panel) => {
    const parentGroup = panel.closest<HTMLElement>("[data-testid='message-group-block']");
    const panelRect = panel.getBoundingClientRect();
    const groupRect = parentGroup?.getBoundingClientRect();
    return {
      groupRight: groupRect?.right ?? 0,
      panelRight: panelRect.right,
      panelWidth: panelRect.width,
      groupWidth: groupRect?.width ?? 0,
    };
  });
  expect(panelGeometry.panelRight).toBeLessThanOrEqual(panelGeometry.groupRight + 1);
  expect(panelGeometry.panelWidth).toBeLessThanOrEqual(panelGeometry.groupWidth);

  const resultViewport = toolBlock.getByLabel("工具输出").locator("pre").locator("..");
  const resultScroll = await resultViewport.evaluate((viewport) => ({
    clientHeight: viewport.clientHeight,
    overflowY: getComputedStyle(viewport).overflowY,
    scrollHeight: viewport.scrollHeight,
    scrollbarWidth: getComputedStyle(viewport, "::-webkit-scrollbar").width,
  }));
  expect(resultScroll.scrollHeight).toBeGreaterThan(resultScroll.clientHeight);
  expect(resultScroll.overflowY).toBe("auto");
  expect(resultScroll.scrollbarWidth).toBe("9px");
});

test("workbench drawer plan card escapes clipping, stays open and separates long items", async ({ page }) => {
  const backend = createWorkbenchBackend();
  await installWebSocketMock(page);
  await mockWorkbenchBackend(page, backend);

  await page.goto(`${APP_BASE}/#/workbench/${WORKSPACE_A}/session/${RICH_SESSION}`);
  await openWorkbenchComposer(page);
  await page.getByRole("button", { name: "将工作台助手展开到右侧" }).click();

  const drawer = page.getByTestId("workbench-assistant-drawer");
  const planPill = page.getByTestId("plan-summary-pill");
  await expect(drawer).toBeVisible();
  await expect(planPill).toContainText("2/2 步");
  await planPill.hover();

  const planCard = page.getByTestId("plan-summary-card");
  await expect(planCard).toBeVisible();
  await expect(planCard).toContainText("E2E plan accessory");
  await page.waitForTimeout(250);
  await expect(planCard).toBeVisible();
  expect(
    await planCard.getByRole("listitem").nth(1).evaluate((element) => getComputedStyle(element).borderTopWidth),
  ).toBe("1px");

  const geometry = await planCard.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const drawerElement = document.querySelector<HTMLElement>("[data-testid='workbench-assistant-drawer']");
    const sample = document.elementFromPoint(rect.left + 1, rect.top + rect.height / 2);
    return {
      clippedAtLeftEdge: !sample || !element.contains(sample),
      insideDrawer: Boolean(drawerElement?.contains(element)),
      left: rect.left,
      right: rect.right,
      viewportWidth: window.innerWidth,
    };
  });
  expect(geometry.insideDrawer).toBe(false);
  expect(geometry.clippedAtLeftEdge).toBe(false);
  expect(geometry.left).toBeGreaterThanOrEqual(12);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth - 12);
});

test("workbench expanded overlay uses the same panel without reflowing the workspace or opening the global sidebar", async ({ page }) => {
  const backend = createWorkbenchBackend();
  await installWebSocketMock(page);
  await mockWorkbenchBackend(page, backend);

  await page.goto(`${APP_BASE}/#/workbench/${WORKSPACE_A}/session/${RICH_SESSION}`);
  const workspace = page.getByTestId("workspace-file-browser");
  await expect(workspace).toBeVisible();
  const beforeBox = await workspace.boundingBox();
  await openWorkbenchComposer(page);
  await waitForAssistantChromeStable(page);
  const beforeAssistantBox = await page.getByTestId("workbench-assistant-chrome").boundingBox();
  await page.getByRole("button", { name: "展开工作台消息层" }).click();

  const expanded = page.getByTestId("workbench-expanded-layer");
  await expect(expanded).toBeVisible();
  await expect(page.getByTestId("workbench-expanded-panel-frame")).toBeVisible();
  await expect(page.getByTestId("workbench-assistant-chrome")).toHaveAttribute("data-shell-mode", "composer");
  await expect(expanded.getByTestId("conversation-panel")).toHaveAttribute("data-conversation-panel-variant", "overlay");
  await expect(expanded.getByTestId("message-list")).toHaveAttribute("data-message-list-variant", "overlay");
  expect(await expanded.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgba(0, 0, 0, 0)");
  await expect
    .poll(() => assistantChromeBoxDelta(page, beforeAssistantBox), { timeout: 3000 })
    .toBeLessThanOrEqual(3);
  const afterBox = await workspace.boundingBox();
  expect(Math.round(afterBox?.width ?? 0)).toBe(Math.round(beforeBox?.width ?? 0));
  await expect(page.getByTestId("app-shell")).toHaveAttribute("data-right-sidebar-enabled", "false");
  await expect(page.getByTestId("app-shell")).toHaveAttribute("data-right-sidebar", "closed");
  await expect(page.getByTestId("right-sidebar-initial-page")).toHaveCount(0);

  await expect(expanded.getByRole("button", { name: "打开文件引用 README.md" }).first()).toBeVisible();
  await saveEvidence(page, "was-049-050-067-expanded-overlay");
});

test("workbench drawer keeps markdown, code preview, selection quote and accessory behavior from Agent", async ({ page }) => {
  const backend = createWorkbenchBackend();
  await installWebSocketMock(page);
  await mockWorkbenchBackend(page, backend);

  await page.goto(`${APP_BASE}/#/workbench/${WORKSPACE_A}/session/${RICH_SESSION}`);
  await openWorkbenchComposer(page);
  await page.getByRole("button", { name: "将工作台助手展开到右侧" }).click();
  const drawer = page.getByTestId("workbench-assistant-drawer");
  await expect(drawer).toBeVisible();

  const virtualMarkdown = drawer.locator("[data-markdown-virtual-preview='true']").first();
  await expect(virtualMarkdown).toBeAttached();
  const markdownMetrics = await virtualMarkdown.evaluate((element) => ({
    mountedBlocks: Number(element.getAttribute("data-markdown-mounted-block-count") ?? 0),
    totalBlocks: Number(element.getAttribute("data-markdown-block-count") ?? 0),
  }));
  expect(markdownMetrics.totalBlocks).toBeGreaterThan(96);
  expect(markdownMetrics.mountedBlocks).toBeGreaterThan(0);
  expect(markdownMetrics.mountedBlocks).toBeLessThan(markdownMetrics.totalBlocks);

  await expect(drawer.getByTestId("markdown-code-viewport").first()).toBeVisible();
  const copyCodeButton = drawer.getByRole("button", { name: "复制代码" }).first();
  await copyCodeButton.click();
  await expect(copyCodeButton.locator("svg.lucide-check")).toBeVisible();
  await drawer.getByRole("button", { name: /预览 HTML/ }).click();
  await expect(drawer.getByTestId("html-preview-frame")).toBeVisible();
  await drawer.getByRole("button", { name: /预览 Mermaid/ }).click();
  await expect(drawer.getByTestId("mermaid-preview")).toBeVisible();
  await drawer.getByRole("button", { name: /全屏显示 Mermaid/ }).click();
  await expect(page.getByRole("dialog", { name: /Mermaid/ })).toBeVisible();
  await page.getByRole("button", { name: "关闭全屏预览" }).click();

  await selectVisibleText(page, "Visible Code Preview Anchor");
  await expect(page.getByRole("toolbar", { name: "选中文本操作" })).toBeVisible();
  await page.getByRole("button", { name: "引用选中文本" }).click();
  await expect(page.getByLabel("已添加上下文")).toContainText("引用片段");

  await dispatchAgentEvent(page, {
    action: "stream",
    data: { session_id: RICH_SESSION, id: "evt-stream-e2e", content: "streaming from workbench" },
  });
  await expect(drawer.getByText("streaming from workbench")).toBeVisible();
  await expect(drawer.getByTestId("streaming-cursor").last()).toBeVisible();
  await page.getByRole("button", { name: "切换胶囊信息" }).click();
  await page.getByRole("menuitemradio", { name: /计划/ }).click();
  await expect(page.getByTestId("plan-summary-pill")).toContainText("E2E plan accessory");
  await expect(drawer.getByTestId("message-list").getByText("E2E plan accessory")).toHaveCount(0);
  await saveEvidence(page, "was-051-055-063-065-rich-behavior");
});

test("workbench drawer preserves workspace scope for media, search and approvals", async ({ page }) => {
  const backend = createWorkbenchBackend();
  await installWebSocketMock(page);
  await mockWorkbenchBackend(page, backend);

  await page.goto(`${APP_BASE}/#/workbench/${WORKSPACE_A}/session/${RICH_SESSION}`);
  const input = await openWorkbenchComposer(page);
  await input.click();
  await page.keyboard.type("@context");
  await expect(page.getByTestId("at-file-menu")).toBeVisible();
  expect(backend.workspaceSearchRequests.at(-1)).toMatchObject({ workspaceId: WORKSPACE_A, query: "context" });
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "打开文件引用 docs/context.md" })).toBeVisible();

  await page.getByLabel("工作台助手输入").click();
  await page.keyboard.press("Control+A");
  await page.keyboard.type("scoped send");
  await page.getByLabel("发送").click();
  const chatFrame = await lastChatFrame(page);
  expect(chatFrame?.data).toMatchObject({
    session_id: RICH_SESSION,
    message: "scoped send",
    model: "qwen-coder",
  });
  const injections = (chatFrame?.data?.runtime_params as { message_injection?: unknown[] } | undefined)?.message_injection ?? [];
  expect(JSON.stringify(injections)).toContain("docs/context.md");

  await dispatchAgentEvent(page, {
    action: "approval_requested",
    data: {
      session_id: RICH_SESSION,
      approval: approval("approval-live"),
    },
  });
  await expect(page.getByTestId("workbench-assistant-drawer")).toBeVisible();
  await page.getByRole("button", { name: "批准" }).last().click();
  expect(backend.approvalDecisions.at(-1)).toMatchObject({
    approvalId: "approval-live",
    body: { decision: "approved", trust_scope: "once" },
  });
  await saveEvidence(page, "was-061-066-scope-approval");
});

test("workbench drawer loads older history and follows the bottom while streaming", async ({ page }) => {
  const initialHistory = Array.from({ length: 28 }, (_, index) => [
    e2eHistoryMessage("user", `Current history question ${index}`, `current-user-${index}`, index * 2),
    e2eHistoryMessage("assistant", `Current history answer ${index}`, `current-assistant-${index}`, index * 2 + 1),
  ]).flat();
  const olderHistory = [
    e2eHistoryMessage("user", "Older history anchor question", "older-user-0", -2),
    e2eHistoryMessage("assistant", "Older history anchor answer", "older-assistant-0", -1),
  ];
  const backend = createWorkbenchBackend({
    historyPagesBySession: {
      [RICH_SESSION]: {
        __initial__: {
          list: initialHistory,
          next_cursor: "older-page-1",
          has_more_older: true,
        },
        "older-page-1": {
          list: olderHistory,
          next_cursor: null,
          has_more_older: false,
        },
      },
    },
  });
  await installWebSocketMock(page);
  await mockWorkbenchBackend(page, backend);

  await page.goto(`${APP_BASE}/#/workbench/${WORKSPACE_A}/session/${RICH_SESSION}`);
  await openWorkbenchComposer(page);
  await page.getByRole("button", { name: "将工作台助手展开到右侧" }).click();

  const drawer = page.getByTestId("workbench-assistant-drawer");
  const scroller = drawer.getByTestId("message-list-scroll");
  await expect(drawer.getByText("Current history answer 27")).toBeVisible();
  await expect
    .poll(() => backend.historyRequests.filter((request) => request.sessionId === RICH_SESSION).length)
    .toBeGreaterThanOrEqual(1);
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollHeight > element.clientHeight + 120))
    .toBeTruthy();

  await scroller.evaluate((element) => {
    element.scrollTop = 180;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await scroller.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });

  await expect(drawer.getByText("Older history anchor answer")).toBeVisible();
  await expect
    .poll(() => backend.historyRequests.some((request) => request.sessionId === RICH_SESSION && request.cursor === "older-page-1"))
    .toBeTruthy();

  await scroller.evaluate((element) => {
    element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await dispatchAgentEvent(page, {
    action: "stream",
    data: { session_id: RICH_SESSION, id: "evt-bottom-follow", content: "Bottom follow streaming message" },
  });
  await expect(drawer.getByText("Bottom follow streaming message")).toBeVisible();
  await expect
    .poll(() =>
      scroller.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop <= 24),
    )
    .toBeTruthy();
  await saveEvidence(page, "was-064-history-scroll-bottom");
});

function e2eHistoryMessage(role: "user" | "assistant", content: string, id: string, timestamp: number) {
  return {
    id,
    role,
    content,
    timestamp,
  };
}

type BoundingBox = {
  height: number;
  width: number;
  x: number;
  y: number;
};

async function assistantChromeBoxDelta(page: Page, baseline: BoundingBox | null) {
  const current = await page.getByTestId("workbench-assistant-chrome").boundingBox();
  if (!baseline || !current) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(
    Math.abs(current.x - baseline.x),
    Math.abs(current.y - baseline.y),
    Math.abs(current.width - baseline.width),
    Math.abs(current.height - baseline.height),
  );
}

async function waitForAssistantChromeStable(page: Page) {
  await expect
    .poll(
      async () => {
        const first = await page.getByTestId("workbench-assistant-chrome").boundingBox();
        await page.waitForTimeout(120);
        return assistantChromeBoxDelta(page, first);
      },
      { timeout: 3000 },
    )
    .toBeLessThanOrEqual(1);
}
