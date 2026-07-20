import { expect, test } from "@playwright/test";

import {
  APP_BASE,
  RICH_SESSION,
  WORKSPACE_A,
  chatFrameCount,
  createWorkbenchBackend,
  installWebSocketMock,
  mockWorkbenchBackend,
  openWorkbenchComposer,
  saveEvidence,
} from "./workbench-e2e-fixtures";

test("workbench capsule keeps plan and runtime status fully visible", async ({ page }) => {
  const backend = createWorkbenchBackend();
  await installWebSocketMock(page);
  await mockWorkbenchBackend(page, backend);

  await page.goto(`${APP_BASE}/#/workbench/${WORKSPACE_A}/session/${RICH_SESSION}`);

  const capsule = page.getByTestId("workbench-assistant-capsule");
  const accessory = capsule.getByLabel("输入框状态");
  const accessoryContent = accessory.getByTestId("composer-accessory-content");
  await expect(capsule.getByTestId("plan-summary-pill")).toBeVisible();
  await expect(accessoryContent).toBeVisible();

  const geometry = await accessoryContent.evaluate((element) => {
    const frame = element.closest<HTMLElement>("[aria-label='输入框状态']")?.parentElement;
    return {
      clientWidth: element.clientWidth,
      frameMaxWidth: frame ? getComputedStyle(frame).maxWidth : null,
      scrollWidth: element.scrollWidth,
    };
  });

  expect(geometry.frameMaxWidth).toBe("340px");
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
});

test("workbench assistant shell morphs from bottom composer to right drawer without replacing the shell", async ({ page }) => {
  const backend = createWorkbenchBackend();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await installWebSocketMock(page);
  await mockWorkbenchBackend(page, backend);

  await page.goto(`${APP_BASE}/#/workbench/${WORKSPACE_A}/session/${RICH_SESSION}`);
  const input = await openWorkbenchComposer(page);
  await input.click();
  await page.keyboard.type("draft before morph");

  const shell = page.getByTestId("workbench-assistant-shell");
  const chrome = page.getByTestId("workbench-assistant-chrome");
  await shell.evaluate((element) => element.setAttribute("data-e2e-stable-shell", "true"));
  await chrome.evaluate((element) => element.setAttribute("data-e2e-stable-chrome", "true"));
  await expect(page.locator("[data-testid='workbench-assistant-dock-morph']")).toHaveCount(0);
  await expect(page.getByTestId("workbench-assistant-surface")).toHaveAttribute("data-surface-mode", "composer");
  await page.evaluate(() => {
    type DockSample = {
      drawerExists: boolean;
      dockOutChromeHasShell: boolean;
      dockOutChromeTransition: string | null;
      dockOutMorphAnimation: string | null;
      dockOutMorphMode: string | null;
      hasInputDraft: boolean;
      hasMorphHeader: boolean;
      hasMorphMiddle: boolean;
      hasMorphPanel: boolean;
      morphHasConversationPanel: boolean;
      phase: string | null;
      shellPaddingBottom: string | null;
      shellPaddingTop: string | null;
      shellMode: string | null;
      syntaxFallbackCount: number;
      syntaxReadyCount: number;
      visualMode: string | null;
    };
    const win = window as Window & {
      __workbenchDockObserver?: MutationObserver;
      __workbenchDockSamples?: DockSample[];
    };
    win.__workbenchDockObserver?.disconnect();
    const samples: DockSample[] = [];
    const sample = () => {
      const workspace = document.querySelector("[data-testid='workbench-workspace-shell']");
      const surface = document.querySelector("[data-testid='workbench-assistant-surface']");
      const shellNode = document.querySelector("[data-testid='workbench-assistant-shell']");
      const chromeNode = document.querySelector("[data-testid='workbench-assistant-chrome']");
      const morphPanel = document.querySelector("[data-testid='workbench-assistant-morph-panel']");
      const shellStyle = shellNode instanceof HTMLElement ? getComputedStyle(shellNode) : null;
      const chromeStyle = chromeNode instanceof HTMLElement ? getComputedStyle(chromeNode) : null;
      const morphStyle = morphPanel instanceof HTMLElement ? getComputedStyle(morphPanel) : null;
      samples.push({
        drawerExists: Boolean(document.querySelector("[data-testid='workbench-assistant-drawer']")),
        dockOutChromeHasShell: Boolean(
          chromeStyle &&
            chromeStyle.backgroundColor !== "rgba(0, 0, 0, 0)" &&
            chromeStyle.borderLeftWidth === "1px" &&
            chromeStyle.boxShadow !== "none",
        ),
        dockOutChromeTransition: chromeStyle?.transitionProperty ?? null,
        dockOutMorphAnimation: morphStyle?.animationName ?? null,
        dockOutMorphMode: morphPanel?.getAttribute("data-panel-mode") ?? null,
        hasInputDraft: document.querySelector("[aria-label='工作台助手输入']")?.textContent?.includes("draft before morph") ?? false,
        hasMorphHeader: Boolean(document.querySelector("[data-testid='workbench-assistant-morph-header']")),
        hasMorphMiddle: Boolean(document.querySelector("[data-testid='workbench-assistant-morph-middle']")),
        hasMorphPanel: Boolean(document.querySelector("[data-testid='workbench-assistant-morph-panel']")),
        morphHasConversationPanel: Boolean(
          document.querySelector("[data-testid='workbench-assistant-morph-panel'] [data-testid='conversation-panel']"),
        ),
        phase: workspace?.getAttribute("data-dock-transition-phase") ?? null,
        shellPaddingBottom: shellStyle?.paddingBottom ?? null,
        shellPaddingTop: shellStyle?.paddingTop ?? null,
        shellMode: shellNode?.getAttribute("data-shell-mode") ?? null,
        syntaxFallbackCount: document.querySelectorAll("[data-markdown-code-highlighter-state='fallback']").length,
        syntaxReadyCount: document.querySelectorAll("[data-markdown-code-highlighter-state='ready']").length,
        visualMode: surface?.getAttribute("data-visual-mode") ?? null,
      });
    };
    sample();
    const observer = new MutationObserver(sample);
    observer.observe(document.body, {
      attributes: true,
      childList: true,
      subtree: true,
    });
    win.__workbenchDockObserver = observer;
    win.__workbenchDockSamples = samples;
  });

  await page.getByRole("button", { name: "将工作台助手展开到右侧" }).click();

  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const samples = ((window as Window & { __workbenchDockSamples?: Array<Record<string, unknown>> })
            .__workbenchDockSamples ?? []);
          return samples.some(
            (sample) =>
              sample.phase === "dock-in" &&
              sample.visualMode === "dock-morph" &&
              sample.shellMode === "dock-morph" &&
              sample.shellPaddingTop === "0px" &&
              sample.shellPaddingBottom === "0px" &&
              sample.hasMorphPanel === true &&
              sample.hasMorphHeader === true &&
              sample.hasMorphMiddle === true &&
              sample.morphHasConversationPanel === true &&
              sample.hasInputDraft === true &&
              sample.drawerExists === false,
          );
        }),
      { timeout: 5000 },
    )
    .toBe(true);

  await expect(page.getByTestId("workbench-assistant-drawer")).toBeVisible();
  await expect(page.getByTestId("workbench-assistant-surface")).toHaveAttribute("data-surface-mode", "drawer");
  await expect(page.getByTestId("workbench-assistant-surface")).toHaveAttribute("data-dock-layout", "inline");
  await expect(page.getByTestId("workbench-workspace-shell")).toHaveAttribute("data-dock-transition-phase", "idle");
  await expect(page.locator("[data-e2e-stable-shell='true']")).toHaveCount(1);
  await expect(page.locator("[data-e2e-stable-chrome='true']")).toHaveCount(1);
  await expect(page.getByLabel("工作台助手输入")).toContainText("draft before morph");
  await expect(page.getByTestId("workbench-assistant-surface")).toHaveAttribute("data-dock-transition", "idle");
  const codeHighlighterSamples = await page.evaluate(() => {
    const samples = ((window as Window & { __workbenchDockSamples?: Array<Record<string, unknown>> })
      .__workbenchDockSamples ?? []);
    return {
      fallbackAfterDrawer: samples.some(
        (sample) => sample.drawerExists === true && Number(sample.syntaxFallbackCount ?? 0) > 0,
      ),
      readyAfterDrawer: samples.some(
        (sample) => sample.drawerExists === true && Number(sample.syntaxReadyCount ?? 0) > 0,
      ),
    };
  });
  expect(codeHighlighterSamples.fallbackAfterDrawer).toBe(false);
  expect(codeHighlighterSamples.readyAfterDrawer).toBe(true);
  const drawerBox = await page.getByTestId("workbench-assistant-drawer").boundingBox();
  expect(drawerBox?.width ?? 0).toBeGreaterThanOrEqual(320);
  expect(drawerBox?.width ?? 0).toBeLessThanOrEqual(520);
  const settledDrawerChrome = await page.evaluate(() => {
    const chrome = document.querySelector<HTMLElement>("[data-testid='workbench-assistant-chrome']");
    const panel = document.querySelector<HTMLElement>("[data-testid='conversation-panel']");
    const composer = document.querySelector<HTMLElement>("[data-testid='workbench-assistant-capsule']");
    const composerFrame = document.querySelector<HTMLElement>("[data-testid='workbench-assistant-drawer-composer-frame']");
    const inputSurface = document.querySelector<HTMLElement>("[data-testid='workbench-assistant-drawer-input-surface']");
    const input = document.querySelector<HTMLElement>("[aria-label='工作台助手输入']");
    const sendButton = document.querySelector<HTMLElement>("[aria-label='发送']");
    if (!chrome || !panel || !composer || !composerFrame || !inputSurface || !input || !sendButton) {
      return null;
    }
    const chromeRect = chrome.getBoundingClientRect();
    const composerFrameRect = composerFrame.getBoundingClientRect();
    const inputSurfaceRect = inputSurface.getBoundingClientRect();
    const inputRect = input.getBoundingClientRect();
    const sendRect = sendButton.getBoundingClientRect();
    const chromeStyle = getComputedStyle(chrome);
    const panelStyle = getComputedStyle(panel);
    const composerStyle = getComputedStyle(composer);
    const inputSurfaceStyle = getComputedStyle(inputSurface);
    return {
      chromeBottom: chromeRect.bottom,
      chromeBottomLeftRadius: chromeStyle.borderBottomLeftRadius,
      chromeTopLeftRadius: chromeStyle.borderTopLeftRadius,
      panelFilter: panelStyle.filter,
      panelTransform: panelStyle.transform,
      composerBackground: composerStyle.backgroundColor,
      composerFrameWidth: composerFrameRect.width,
      inputSurfaceBottom: inputSurfaceRect.bottom,
      inputSurfaceRadius: inputSurfaceStyle.borderBottomLeftRadius,
      inputBottom: inputRect.bottom,
      sendBottom: sendRect.bottom,
      viewportHeight: window.innerHeight,
    };
  });
  expect(settledDrawerChrome).not.toBeNull();
  expect(settledDrawerChrome?.chromeTopLeftRadius).toBe("18px");
  expect(settledDrawerChrome?.chromeBottomLeftRadius).toBe("18px");
  expect(settledDrawerChrome?.panelFilter).toBe("none");
  expect(settledDrawerChrome?.panelTransform).toBe("none");
  expect(settledDrawerChrome?.composerBackground).toBe("rgba(0, 0, 0, 0)");
  expect(settledDrawerChrome?.composerFrameWidth ?? 0).toBeGreaterThan(300);
  expect(settledDrawerChrome?.inputSurfaceRadius).toBe("20px");
  expect(settledDrawerChrome?.chromeBottom ?? 0).toBeLessThanOrEqual((settledDrawerChrome?.viewportHeight ?? 0) - 6);
  expect(settledDrawerChrome?.inputSurfaceBottom ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual((settledDrawerChrome?.chromeBottom ?? 0) - 14);
  expect(settledDrawerChrome?.inputBottom ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual((settledDrawerChrome?.chromeBottom ?? 0) - 8);
  expect(settledDrawerChrome?.sendBottom ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual((settledDrawerChrome?.chromeBottom ?? 0) - 8);

  await page.getByRole("button", { name: "关闭工作台助手侧栏" }).click();
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const samples = ((window as Window & { __workbenchDockSamples?: Array<Record<string, unknown>> })
            .__workbenchDockSamples ?? []);
          return samples.some(
            (sample) =>
              sample.phase === "dock-out" &&
              typeof sample.dockOutChromeTransition === "string" &&
              sample.dockOutChromeTransition.includes("left") &&
              sample.dockOutChromeTransition.includes("height") &&
              sample.visualMode === "dock-out-morph" &&
              sample.shellMode === "dock-out-morph" &&
              typeof sample.dockOutMorphAnimation === "string" &&
              sample.dockOutMorphAnimation.includes("morphPanelConcealToCapsule") &&
              sample.dockOutMorphMode === "morph",
          );
        }),
      { timeout: 5000 },
    )
    .toBe(true);
  await expect(page.getByTestId("workbench-assistant-surface")).toHaveAttribute("data-surface-mode", "composer");
  await expect(page.getByTestId("workbench-assistant-surface")).toHaveAttribute("data-dock-layout", "overlay");
  await expect
    .poll(() => page.evaluate(bottomAssistantCenterDelta), { timeout: 3000 })
    .toBeLessThanOrEqual(3);
  await expect(page.locator("[data-e2e-stable-shell='true']")).toHaveCount(1);
  await expect(page.locator("[data-e2e-stable-chrome='true']")).toHaveCount(1);
  await expect(page.getByLabel("工作台助手输入")).toContainText("draft before morph");
  await page.evaluate(() => {
    const win = window as Window & { __workbenchDockObserver?: MutationObserver };
    win.__workbenchDockObserver?.disconnect();
  });
  await saveEvidence(page, "was-045-046-shell-morph");
});

test("workbench assistant preserves composer state while docking and running, with reduced-motion switching directly", async ({ page }) => {
  const backend = createWorkbenchBackend();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await installWebSocketMock(page);
  await mockWorkbenchBackend(page, backend);

  await page.goto(`${APP_BASE}/#/workbench/${WORKSPACE_A}/session/${RICH_SESSION}`);
  const input = await openWorkbenchComposer(page);
  await input.click();
  await page.keyboard.type("reduced motion draft");
  await expect(page.getByRole("button", { name: "选择模型" })).toContainText("qwen-coder");

  await page.getByRole("button", { name: "将工作台助手展开到右侧" }).click();
  await expect(page.getByTestId("workbench-assistant-surface")).toHaveAttribute("data-surface-mode", "drawer");
  await expect(page.getByTestId("workbench-assistant-surface")).toHaveAttribute("data-dock-transition", "idle");
  await expect(page.getByLabel("工作台助手输入")).toContainText("reduced motion draft");

  const beforeSend = await chatFrameCount(page);
  await page.keyboard.type(" run from drawer");
  await page.getByLabel("发送").click();
  await expect(page.getByRole("button", { name: "停止" })).toBeEnabled();
  expect(await chatFrameCount(page)).toBe(beforeSend + 1);

  await page.getByRole("button", { name: "关闭工作台助手侧栏" }).click();
  await expect(page.getByTestId("workbench-assistant-surface")).toHaveAttribute("data-surface-mode", "capsule");
  await expect(page.getByTestId("workbench-assistant-surface")).toHaveAttribute("data-dock-transition", "idle");
  await expect
    .poll(() => page.evaluate(bottomAssistantCenterDelta), { timeout: 3000 })
    .toBeLessThanOrEqual(3);
  await saveEvidence(page, "was-047-reduced-motion-state");
});

test("workbench assistant bottom chrome stays centered after repeated overlay and drawer cycles", async ({ page }) => {
  const backend = createWorkbenchBackend();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await installWebSocketMock(page);
  await mockWorkbenchBackend(page, backend);

  await page.goto(`${APP_BASE}/#/workbench/${WORKSPACE_A}/session/${RICH_SESSION}`);
  await openWorkbenchComposer(page);

  for (let index = 0; index < 3; index += 1) {
    await expect
      .poll(() => page.evaluate(bottomAssistantCenterDelta), { timeout: 3000 })
      .toBeLessThanOrEqual(3);

    await page.getByRole("button", { name: "展开工作台消息层" }).click();
    await expect(page.getByTestId("workbench-expanded-layer")).toBeVisible();
    await expect(page.getByTestId("workbench-assistant-chrome")).toHaveAttribute("data-shell-mode", "composer");
    await expect
      .poll(() => page.evaluate(bottomAssistantCenterDelta), { timeout: 3000 })
      .toBeLessThanOrEqual(3);

    await page.getByRole("button", { name: "收起工作台消息层" }).click();
    await expect(page.getByTestId("workbench-expanded-layer")).toHaveCount(0);
    await expect(page.getByTestId("workbench-assistant-surface")).toHaveAttribute("data-surface-mode", "capsule");
    await expect(page.getByLabel("工作台助手输入")).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(bottomAssistantCenterDelta), { timeout: 3000 })
      .toBeLessThanOrEqual(3);

    await openWorkbenchComposer(page);
    await page.getByRole("button", { name: "将工作台助手展开到右侧" }).click();
    await expect(page.getByTestId("workbench-assistant-drawer")).toBeVisible();
    await expect(page.getByTestId("workbench-assistant-surface")).toHaveAttribute("data-dock-transition", "idle");
    await expect(page.getByRole("button", { name: "展开工作台消息层" })).toHaveCount(0);
    await page.getByRole("button", { name: "收回工作台助手为胶囊" }).click();
    await expect(page.getByTestId("workbench-assistant-surface")).toHaveAttribute("data-surface-mode", "capsule");
    await expect
      .poll(() => page.evaluate(bottomAssistantCenterDelta), { timeout: 3000 })
      .toBeLessThanOrEqual(3);

    await openWorkbenchComposer(page);
  }

  await saveEvidence(page, "was-070-bottom-chrome-repeat-center");
});

function bottomAssistantCenterDelta() {
  const chrome = document.querySelector("[data-testid='workbench-assistant-chrome']");
  const canvas = document.querySelector("[data-testid='workbench-canvas-content']");
  if (!(chrome instanceof HTMLElement) || !(canvas instanceof HTMLElement)) {
    throw new Error("assistant or canvas not found");
  }
  const chromeRect = chrome.getBoundingClientRect();
  const canvasRect = canvas.getBoundingClientRect();
  return Math.abs(chromeRect.left + chromeRect.width / 2 - (canvasRect.left + canvasRect.width / 2));
}
