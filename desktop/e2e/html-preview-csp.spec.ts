import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test } from "@playwright/test";

const APP_URL = "http://keydex.test/";
const PREVIEW_URL = "http://127.0.0.1:43123/api/local-preview/html/content/test-token";
const CHILD_URL = "http://127.0.0.1:43123/child.html";

const tauriConfig = JSON.parse(
  readFileSync(resolve(process.cwd(), "src-tauri", "tauri.conf.json"), "utf8"),
) as { app: { security: { csp: string } } };

test("scoped main-webview CSP allows isolated local HTML previews and their nested pages", async ({ page }) => {
  await page.route(APP_URL, (route) => route.fulfill({
    status: 200,
    contentType: "text/html",
    headers: { "Content-Security-Policy": tauriConfig.app.security.csp },
    body: `<iframe id="preview" sandbox="allow-scripts" src="${PREVIEW_URL}"></iframe>`,
  }));
  await page.route(PREVIEW_URL, (route) => route.fulfill({
    status: 200,
    contentType: "text/html",
    body: [
      '<main id="state">initial</main>',
      '<iframe id="child" src="/child.html"></iframe>',
      "<script>document.querySelector('#state').textContent = 'script-ready'</script>",
    ].join(""),
  }));
  await page.route(CHILD_URL, (route) => route.fulfill({
    status: 200,
    contentType: "text/html",
    body: "<main>nested-ready</main>",
  }));

  await page.goto(APP_URL);

  const preview = page.frameLocator("#preview");
  await expect(preview.locator("#state")).toHaveText("script-ready");
  await expect(preview.frameLocator("#child").locator("main")).toHaveText("nested-ready");
});
