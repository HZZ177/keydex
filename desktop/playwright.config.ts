import { defineConfig } from "@playwright/test";
import { tmpdir } from "node:os";
import * as path from "node:path";

const executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
const outputDir = path.resolve(
  process.env.KEYDEX_PLAYWRIGHT_OUTPUT_DIR
    ?? path.join(tmpdir(), "keydex-playwright-results", String(process.pid)),
);

export default defineConfig({
  testDir: "./e2e",
  outputDir,
  timeout: 30_000,
  expect: {
    timeout: 5_000,
  },
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173",
    channel: executablePath ? undefined : (process.env.PLAYWRIGHT_BROWSER_CHANNEL ?? "chrome"),
    launchOptions: executablePath ? { executablePath } : undefined,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "pnpm dev",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
