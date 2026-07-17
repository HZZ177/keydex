import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { writeFile } from "node:fs/promises";

import {
  DIFF_RUNTIME_PERFORMANCE_BUDGET,
  evaluateDiffRuntimePerformance,
  summarizeDiffRuntimePerformance,
} from "../src/renderer/components/diff/diffRuntimePerformance";
import {
  APP_BASE,
  SESSION_A,
  WORKSPACE_A,
  createWorkbenchBackend,
  installWebSocketMock,
  mockWorkbenchBackend,
  type E2EWorkspaceTreeEntry,
} from "./workbench-e2e-fixtures";

const PERFORMANCE_FILES = {
  "perf-1k.patch": linePatch("src/perf-1k.ts", 1_000),
  "perf-20k.patch": linePatch("src/perf-20k.ts", 20_000),
  "perf-50.patch": multiFilePatch(50),
  "perf-500.patch": multiFilePatch(500),
} satisfies Record<string, string>;
const PERFORMANCE_TREE: E2EWorkspaceTreeEntry[] = Object.entries(PERFORMANCE_FILES).map(([path, content]) => ({
  name: path,
  path,
  type: "file",
  size: content.length,
  modified_at: null,
}));

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.addInitScript(() => {
    const state = { longTasks: [] as number[] };
    (window as Window & { __diffPerformance?: typeof state }).__diffPerformance = state;
    if (typeof PerformanceObserver === "undefined") return;
    try {
      const observer = new PerformanceObserver((list) => {
        state.longTasks.push(...list.getEntries().map((entry) => entry.duration));
      });
      observer.observe({ entryTypes: ["longtask"] });
    } catch {
      // The long-task API is optional; the report retains an empty sample on unsupported engines.
    }
  });
});

test("1k/20k 行与 50/500 文件保持虚拟化、可交互并输出三次采样报告", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const backend = createWorkbenchBackend({
    workspaceFiles: PERFORMANCE_FILES,
    workspaceTreeEntries: PERFORMANCE_TREE,
  });
  await installWebSocketMock(page);
  await mockWorkbenchBackend(page, backend);
  await page.goto(`${APP_BASE}/#/workbench/${WORKSPACE_A}/session/${SESSION_A}`, { waitUntil: "commit" });

  const heapBefore = await usedHeapSize(page);
  const render1kMs = await openAndMeasurePreview(page, "perf-1k.patch", "perf-1k.ts", 1);
  const render20kMs = [
    await openAndMeasurePreview(page, "perf-20k.patch", "perf-20k.ts", 1),
    await reopenAndMeasurePreview(page, "perf-1k.patch", "perf-20k.patch", "perf-20k.ts"),
    await reopenAndMeasurePreview(page, "perf-50.patch", "perf-20k.patch", "perf-20k.ts"),
  ];
  const preview20k = diffPreview(page);
  const engine20k = preview20k.locator('[data-keydex-diff-engine="pierre"]');
  await expect(engine20k).toHaveAttribute("data-virtualization", "aggressive");
  const mountedElements20k = await countMountedEngineElements(engine20k);

  const interactionMs: number[] = [];
  const scrollMs: number[] = [];
  for (let sample = 0; sample < 3; sample += 1) {
    interactionMs.push(await measureToolbarToggle(preview20k, /自动换行/));
    scrollMs.push(await measureScroll(engine20k, sample + 1));
  }
  interactionMs.push(await measureToolbarToggle(preview20k, /切换为并排视图|切换为统一视图/));
  interactionMs.push(await measureThemeToggle(page));
  interactionMs.push(await measureViewportResize(page, engine20k));

  const render50Ms = await openAndMeasurePreview(page, "perf-50.patch", "src/perf-file-1.ts", 50);
  const render500Ms = await openAndMeasurePreview(page, "perf-500.patch", "src/perf-file-1.ts", 500);
  const preview500 = diffPreview(page);
  await expect(preview500.locator('[data-keydex-diff-engine="pierre"]')).toHaveAttribute(
    "data-virtualization",
    "aggressive",
  );
  await preview500.getByRole("button", { name: /500 个变更文件/ }).click();
  await expect(preview500.getByRole("listbox", { name: "变更文件" }).getByRole("option")).toHaveCount(12);
  await preview500.getByRole("listbox", { name: "变更文件" }).evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect(preview500.getByRole("listbox", { name: "变更文件" }).getByRole("option")).toHaveCount(12);

  const longTaskMs = await page.evaluate(() =>
    (window as Window & { __diffPerformance?: { longTasks: number[] } }).__diffPerformance?.longTasks ?? [],
  );
  const heapAfter = await usedHeapSize(page);
  const worker = await readWorkerDiagnostics(preview500);
  expect(worker.status).toBe("ready");
  expect(worker.totalWorkers).toBeGreaterThan(0);
  const summary = summarizeDiffRuntimePerformance({
    render20kMs,
    interactionMs,
    scrollMs,
    longTaskMs,
    mountedElements20k,
    heapGrowthBytes: Math.max(0, heapAfter - heapBefore),
  });
  const report = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    environment: "playwright-chrome-vite-development",
    cases: { render1kMs, render20kMs, render50Ms, render500Ms },
    samples: { interactionMs, scrollMs, longTaskMs },
    worker,
    summary,
    budget: DIFF_RUNTIME_PERFORMANCE_BUDGET,
    violations: evaluateDiffRuntimePerformance(summary),
  };
  const reportPath = testInfo.outputPath("diff-runtime-performance-report.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await testInfo.attach("diff-runtime-performance-report", {
    path: reportPath,
    contentType: "application/json",
  });
  expect(report.violations, JSON.stringify(report, null, 2)).toEqual([]);
  expect(render1kMs).toBeLessThan(DIFF_RUNTIME_PERFORMANCE_BUDGET.render20kMedianMs);
  expect(render50Ms).toBeLessThan(DIFF_RUNTIME_PERFORMANCE_BUDGET.render20kMedianMs);
  expect(render500Ms).toBeLessThan(DIFF_RUNTIME_PERFORMANCE_BUDGET.render20kMedianMs);
});

test("Worker 构造失败时大 Diff 显示明确错误而不是静默回退主线程", async ({ page }) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => {
    class BrokenWorker {
      constructor() {
        throw new Error("e2e worker construction failed");
      }
    }
    Object.defineProperty(window, "Worker", { configurable: true, value: BrokenWorker });
  });
  const backend = createWorkbenchBackend({
    workspaceFiles: { "perf-20k.patch": PERFORMANCE_FILES["perf-20k.patch"] },
    workspaceTreeEntries: PERFORMANCE_TREE.filter((entry) => entry.path === "perf-20k.patch"),
  });
  await installWebSocketMock(page);
  await mockWorkbenchBackend(page, backend);
  await page.goto(`${APP_BASE}/#/workbench/${WORKSPACE_A}/session/${SESSION_A}`, { waitUntil: "commit" });
  await page.getByRole("button", { name: "选择文件 perf-20k.patch" }).click();
  const preview = diffPreview(page);
  const alert = preview.getByRole("alert");
  await expect(alert).toContainText(/后台解析失败|后台差异服务/, { timeout: 30_000 });
  await expect(preview.locator('[data-keydex-diff-engine="pierre"]')).toHaveCount(0);
});

function diffPreview(page: Page) {
  return page.locator('[data-keydex-diff-wrapper="preview"]').last();
}

async function openAndMeasurePreview(page: Page, path: string, expectedPath: string, fileCount: number) {
  const startedAt = performance.now();
  await page.getByRole("button", { name: `选择文件 ${path}` }).click();
  const preview = diffPreview(page);
  await expect(preview).toHaveAttribute("data-file-count", String(fileCount), { timeout: 60_000 });
  await expect(preview.locator('[data-keydex-diff-engine="pierre"]')).toBeVisible({ timeout: 60_000 });
  await expect(preview).toContainText(expectedPath, { timeout: 60_000 });
  return performance.now() - startedAt;
}

async function reopenAndMeasurePreview(
  page: Page,
  intermediatePath: string,
  targetPath: string,
  expectedPath: string,
) {
  await page.getByRole("button", { name: `选择文件 ${intermediatePath}` }).click();
  await expect(page.locator('[data-file-preview-root="true"]')).toHaveAttribute("data-preview-source", "file");
  return openAndMeasurePreview(page, targetPath, expectedPath, 1);
}

async function measureToolbarToggle(preview: Locator, label: RegExp) {
  const action = preview.getByRole("button", { name: label }).first();
  await expect(action).toBeEnabled();
  const before = await action.getAttribute("aria-pressed");
  const startedAt = performance.now();
  await action.click();
  await expect(preview.getByRole("button", { name: label }).first()).not.toHaveAttribute("aria-pressed", before ?? "");
  return performance.now() - startedAt;
}

async function measureThemeToggle(page: Page) {
  const root = page.locator("html");
  const before = await root.getAttribute("data-theme");
  const startedAt = performance.now();
  await page.getByRole("button", { name: "切换主题" }).click();
  await expect(root).not.toHaveAttribute("data-theme", before ?? "");
  await expect(diffPreview(page).locator('[data-keydex-diff-engine="pierre"]')).toBeVisible();
  return performance.now() - startedAt;
}

async function measureViewportResize(page: Page, engine: Locator) {
  const startedAt = performance.now();
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(engine).toBeVisible();
  const compactBox = await engine.boundingBox();
  expect(compactBox?.width ?? 0).toBeGreaterThan(300);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await expect(engine).toBeVisible();
  return performance.now() - startedAt;
}

async function measureScroll(engine: Locator, multiplier: number) {
  const startedAt = performance.now();
  await engine.evaluate((element, amount) => {
    const target = element.closest<HTMLElement>("[data-diff-scroll-owner]") ?? element as HTMLElement;
    target.scrollTop = Math.min(target.scrollHeight, amount * 4_000);
    target.dispatchEvent(new Event("scroll", { bubbles: true }));
  }, multiplier);
  await engine.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  return performance.now() - startedAt;
}

async function countMountedEngineElements(engine: Locator) {
  return engine.evaluate((root) => {
    const count = (node: Element | ShadowRoot): number => {
      let total = 0;
      for (const element of Array.from(node.children)) {
        total += 1;
        total += count(element);
        if (element.shadowRoot) total += count(element.shadowRoot);
      }
      return total;
    };
    return count(root);
  });
}

async function usedHeapSize(page: Page) {
  return page.evaluate(() => {
    const memory = performance as Performance & { memory?: { usedJSHeapSize?: number } };
    return memory.memory?.usedJSHeapSize ?? 0;
  });
}

async function readWorkerDiagnostics(preview: Locator) {
  const surface = preview.locator('[data-keydex-diff-view="true"]');
  await expect(surface).toHaveAttribute("data-worker-status", "ready");
  return surface.evaluate((element) => ({
    status: element.getAttribute("data-worker-status"),
    totalWorkers: Number(element.getAttribute("data-worker-total") ?? 0),
    busyWorkers: Number(element.getAttribute("data-worker-busy") ?? 0),
    queuedTasks: Number(element.getAttribute("data-worker-queued") ?? 0),
    activeTasks: Number(element.getAttribute("data-worker-active") ?? 0),
    fileCacheSize: Number(element.getAttribute("data-worker-file-cache-size") ?? 0),
    diffCacheSize: Number(element.getAttribute("data-worker-diff-cache-size") ?? 0),
    cacheEpoch: Number(element.getAttribute("data-worker-cache-epoch") ?? 0),
  }));
}

function linePatch(path: string, totalChangedLines: number) {
  const sideLines = Math.max(1, Math.floor(totalChangedLines / 2));
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${sideLines} +1,${sideLines} @@`,
    ...Array.from({ length: sideLines }, (_, index) => `-before ${index + 1}`),
    ...Array.from({ length: sideLines }, (_, index) => `+after ${index + 1}`),
    "",
  ].join("\n");
}

function multiFilePatch(fileCount: number) {
  return Array.from({ length: fileCount }, (_, index) => {
    const path = `src/perf-file-${index + 1}.ts`;
    return [
      `diff --git a/${path} b/${path}`,
      `--- a/${path}`,
      `+++ b/${path}`,
      "@@ -1 +1 @@",
      `-before ${index + 1}`,
      `+after ${index + 1}`,
      "",
    ].join("\n");
  }).join("\n");
}
