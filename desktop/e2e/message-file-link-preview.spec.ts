import { expect, test, type Route } from "@playwright/test";

import {
  APP_BASE,
  RICH_SESSION,
  createWorkbenchBackend,
  installWebSocketMock,
  mockWorkbenchBackend,
} from "./workbench-e2e-fixtures";

const API_BASE = "http://127.0.0.1:8765";
const LOCAL_PREVIEW_PATH = "D:/Docs/local notes.md";
const LOCAL_PREVIEW_CONTENT = [
  "# Outside Preview",
  "",
  "This markdown file is outside the workspace.",
  "",
  "Reveal target line",
].join("\n");

test("assistant markdown file link opens an outside-workspace file as a single preview", async ({ page }) => {
  const localReadRequests: Array<string | null> = [];
  const backend = createWorkbenchBackend({
    historyBySession: {
      [RICH_SESSION]: [
        {
          id: "hist-local-file-link",
          sessionId: RICH_SESSION,
          role: "assistant",
          content: `请看 [local notes.md](<${LOCAL_PREVIEW_PATH}:5>)`,
          timestamp: 1_782_518_400_000,
        },
      ],
    },
  });
  await installWebSocketMock(page);
  await mockWorkbenchBackend(page, backend);
  await page.route(`${API_BASE}/api/health`, (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: {
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        status: "ok",
        version: "e2e",
      }),
    }),
  );
  await page.route(`${API_BASE}/api/sessions/${RICH_SESSION}/tasks`, (route: Route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: {
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({ list: [] }),
    }),
  );
  await page.route(`${API_BASE}/api/local-preview/read**`, (route: Route) => {
    localReadRequests.push(new URL(route.request().url()).searchParams.get("path"));
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: {
        "Access-Control-Allow-Origin": "*",
      },
      body: JSON.stringify({
        path: LOCAL_PREVIEW_PATH,
        content: LOCAL_PREVIEW_CONTENT,
        encoding: "utf-8",
      }),
    });
  });

  await page.goto(`${APP_BASE}/#/conversation/${RICH_SESSION}`, { waitUntil: "domcontentloaded" });

  const fileLink = page.locator('a[data-keydex-file-link="true"]').filter({ hasText: "local notes.md" });
  await expect(fileLink).toBeVisible({ timeout: 10_000 });
  await fileLink.click();

  await expect(page.getByRole("heading", { name: "Outside Preview" })).toBeVisible();
  await expect(page.getByText("This markdown file is outside the workspace.")).toBeVisible();
  await expect(page.getByTestId("workspace-file-browser-tree")).toHaveCount(0);
  await expect(page.getByTestId("file-source-viewer")).toHaveCount(0);
  await expect(page.locator("[data-transient-reveal='true']")).toContainText("Reveal target line");
  expect(localReadRequests).toEqual([LOCAL_PREVIEW_PATH]);
  expect(backend.workspaceReadRequests.some((request) => request.path === LOCAL_PREVIEW_PATH)).toBe(false);
});
