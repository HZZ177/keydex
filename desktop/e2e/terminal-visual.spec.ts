import { mkdir } from "node:fs/promises";
import * as path from "node:path";

import { expect, test } from "@playwright/test";

import {
  APP_BASE,
  SESSION_A,
  createWorkbenchBackend,
  installWebSocketMock,
  mockWorkbenchBackend,
} from "./workbench-e2e-fixtures";

const EVIDENCE_DIR = path.resolve("..", ".dev", "verification", "embedded-session-terminal");

test("browser refresh keeps the native-only terminal unavailable without invoking Tauri IPC", async ({ page }) => {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  const backend = createWorkbenchBackend();
  await installWebSocketMock(page);
  await mockWorkbenchBackend(page, backend);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${APP_BASE}/#/conversation/${SESSION_A}`);

  const terminalAction = page.getByRole("button", { name: "打开终端" });
  const sidebarAction = page.getByRole("button", { name: "展开右侧栏" });
  await expect(terminalAction).toBeDisabled();
  await expect(terminalAction).toHaveAttribute("title", "内置终端仅在 Keydex 桌面客户端中可用");
  await expect(page.getByTestId("titlebar").getByRole("button", { name: "打开终端" })).toHaveCount(0);
  const [terminalBox, sidebarBox] = await Promise.all([terminalAction.boundingBox(), sidebarAction.boundingBox()]);
  expect(terminalBox).not.toBeNull();
  expect(sidebarBox).not.toBeNull();
  expect((terminalBox?.x ?? 0) + (terminalBox?.width ?? 0)).toBeLessThanOrEqual(sidebarBox?.x ?? 0);
  await expect(page.getByTestId("notification-viewport")).toHaveCount(1);
  await expect(page.getByTestId("notification-viewport")).not.toContainText("Cannot read properties of undefined");
  await expect(page.getByTestId("notification-viewport")).not.toContainText("当前电脑没有可用的终端配置");
  await expect(page.locator("[data-testid='terminal-toast'], .terminalToast, .terminalBanner")).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole("button", { name: "打开终端" })).toBeDisabled();
  await expect(page.getByTestId("notification-viewport")).not.toContainText("invoke");
  await page.screenshot({ path: path.join(EVIDENCE_DIR, "browser-refresh-fallback.png"), fullPage: true });
});
