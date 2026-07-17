import { expect, test } from "@playwright/test";

import {
  APP_BASE,
  SESSION_A,
  WORKSPACE_A,
  createWorkbenchBackend,
  installWebSocketMock,
  mockWorkbenchBackend,
} from "./workbench-e2e-fixtures";

const PATCH = [
  "diff --git a/src/lazy.py b/src/lazy.py",
  "--- a/src/lazy.py",
  "+++ b/src/lazy.py",
  "@@ -1 +1 @@",
  "-print('before')",
  "+print('after')",
  "",
].join("\n");

test("首屏不请求 Pierre，首次打开 Diff 后才加载引擎与 Worker", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  const backend = createWorkbenchBackend({
    workspaceFiles: { "lazy.patch": PATCH },
    workspaceTreeEntries: [{
      name: "lazy.patch",
      path: "lazy.patch",
      type: "file",
      size: PATCH.length,
      modified_at: null,
    }],
  });
  await installWebSocketMock(page);
  await mockWorkbenchBackend(page, backend);
  await page.goto(`${APP_BASE}/#/workbench/${WORKSPACE_A}/session/${SESSION_A}`, { waitUntil: "networkidle" });

  expect(requests.filter(isPierreResource)).toEqual([]);
  await page.getByRole("button", { name: "选择文件 lazy.patch" }).click();
  const preview = page.locator('[data-keydex-diff-wrapper="preview"]').last();
  await expect(preview.locator('[data-keydex-diff-engine="pierre"]')).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => requests.filter(isPierreResource).length).toBeGreaterThan(0);
  expect(requests.some((url) => url.includes("worker-portable"))).toBe(true);
});

function isPierreResource(url: string) {
  return /@pierre(?:_|\+|\/)(?:diffs)?|worker-portable/u.test(decodeURIComponent(url));
}
