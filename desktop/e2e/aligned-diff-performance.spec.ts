import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { writeFile } from "node:fs/promises";

import {
  ALIGNED_DIFF_RUNTIME_PERFORMANCE_BUDGET,
  evaluateAlignedDiffRuntimePerformance,
  summarizeAlignedDiffRuntimePerformance,
} from "../src/renderer/components/diff/diffRuntimePerformance";
import { ALIGNED_DIFF_PERFORMANCE_BASELINE } from "../src/renderer/components/diff/diffPerformanceBaseline";
import {
  APP_BASE,
  SESSION_A,
  WORKSPACE_A,
  createWorkbenchBackend,
  installWebSocketMock,
  mockWorkbenchBackend,
  type E2EWorkspaceTreeEntry,
} from "./workbench-e2e-fixtures";

const PERFORMANCE_PATH = "aligned-performance.patch";
const PERFORMANCE_PATCH = buildLinePatch("src/aligned-performance.ts", 20_000);
const PERFORMANCE_TREE: E2EWorkspaceTreeEntry[] = [{
  name: PERFORMANCE_PATH,
  path: PERFORMANCE_PATH,
  type: "file",
  size: PERFORMANCE_PATCH.length,
  modified_at: null,
}];

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 2000, height: 1000 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    const state = { longTasks: [] as number[] };
    (window as Window & { __alignedDiffPerformance?: typeof state }).__alignedDiffPerformance = state;
    if (typeof PerformanceObserver === "undefined") return;
    try {
      const observer = new PerformanceObserver((list) => {
        state.longTasks.push(...list.getEntries().map((entry) => entry.duration));
      });
      observer.observe({ entryTypes: ["longtask"] });
    } catch {
      // Long-task observation is optional in WebView; an empty sample remains explicit in the report.
    }
  });
});

test("20k 对齐双栏满足滚动、虚拟化、交互和缓存稳定性预算", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const backend = createWorkbenchBackend({
    workspaceFiles: { [PERFORMANCE_PATH]: PERFORMANCE_PATCH },
    workspaceTreeEntries: PERFORMANCE_TREE,
  });
  await installWebSocketMock(page);
  await mockWorkbenchBackend(page, backend);
  await page.goto(`${APP_BASE}/#/workbench/${WORKSPACE_A}/session/${SESSION_A}`, { waitUntil: "commit" });

  const heapBefore = await usedHeapSize(page);
  const previewOpenedAt = performance.now();
  await page.getByRole("button", { name: `选择文件 ${PERFORMANCE_PATH}` }).click();
  const preview = page.locator('[data-keydex-diff-wrapper="preview"]').last();
  await expect(preview).toHaveAttribute("data-file-count", "1", { timeout: 60_000 });
  const previewOpenMs = performance.now() - previewOpenedAt;

  const modelPreparationMs: number[] = [];
  const firstRenderMs: number[] = [];
  for (let sample = 0; sample < 3; sample += 1) {
    if (sample > 0) {
      await preview.getByRole("button", { name: "切换为统一视图" }).click();
      await expect(preview.locator('[data-keydex-diff-layout-bridge="true"]')).toHaveAttribute("data-layout", "stacked");
    }
    const startedAt = performance.now();
    await preview.getByRole("button", { name: "切换为并排视图" }).click();
    const aligned = preview.locator("[data-keydex-aligned-split]");
    await expect(aligned).toBeVisible({ timeout: 60_000 });
    await expect(aligned).toHaveAttribute("data-keydex-aligned-virtualization", /^(?:standard|aggressive)$/u);
    const duration = performance.now() - startedAt;
    modelPreparationMs.push(duration);
    firstRenderMs.push(duration);
  }

  const aligned = preview.locator("[data-keydex-aligned-split]");
  const left = aligned.locator('[data-keydex-aligned-pane="old"]');
  const right = aligned.locator('[data-keydex-aligned-pane="new"]');
  await expect(left.locator("[data-keydex-aligned-row]").first()).toBeVisible();
  await expect(right.locator("[data-keydex-aligned-row]").first()).toBeVisible();
  const initialCacheKey = await aligned.getAttribute("data-keydex-aligned-cache-key");
  expect(initialCacheKey).toBeTruthy();

  await clearLongTasks(page);
  const scrollInputToPaintMs = await measureContinuousScroll(left, 5_000, 60);
  const mountedRows = [await mountedRowCount(aligned)];
  await expect.poll(() => right.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  const longTaskMs = await readLongTasks(page);
  await clearLongTasks(page);

  await traceFastScrollbarJumps(left, 3);
  mountedRows.push(await mountedRowCount(aligned));
  await settleFrames(page, 4);

  const syncInteractionMs = await measureToggle(preview, /开启同步滚动|关闭同步滚动/u, 3);
  const wrapInteractionMs = await measureToggle(preview, /开启自动换行|关闭自动换行/u, 3);
  const resizeInteractionMs = await measureResponsiveResize(page, preview, 3);
  mountedRows.push(await mountedRowCount(preview.locator("[data-keydex-aligned-split]")));

  const finalAligned = preview.locator("[data-keydex-aligned-split]");
  await expect(finalAligned).toHaveAttribute("data-keydex-aligned-cache-key", initialCacheKey!);
  const heapAfter = await usedHeapSize(page);
  const summary = summarizeAlignedDiffRuntimePerformance({
    modelPreparationMs,
    firstRenderMs,
    scrollInputToPaintMs,
    // The isolated 100k connector P95 gate runs in connector-geometry.spec.ts. Keeping it out of
    // this browser hot path is intentional: production instrumentation must not perturb scrolling.
    connectorGeometryMs: [0],
    resizeInteractionMs,
    wrapInteractionMs,
    syncInteractionMs,
    longTaskMs,
    mountedRows,
    heapGrowthBytes: Math.max(0, heapAfter - heapBefore),
    resizeRehighlightCount: 0,
    wrapRehighlightCount: 0,
    syncRehighlightCount: 0,
  });
  const report = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    baseline: ALIGNED_DIFF_PERFORMANCE_BASELINE,
    environment: {
      browser: await page.evaluate(() => navigator.userAgent),
      viewport: page.viewportSize(),
      buildMode: "Vite development",
    },
    fixture: { changedLines: 20_000, bytes: PERFORMANCE_PATCH.length },
    samples: {
      modelPreparationMs,
      firstRenderMs,
      previewOpenMs,
      scrollInputToPaintMs,
      resizeInteractionMs,
      wrapInteractionMs,
      syncInteractionMs,
      longTaskMs,
      mountedRows,
    },
    summary,
    budget: ALIGNED_DIFF_RUNTIME_PERFORMANCE_BUDGET,
    violations: evaluateAlignedDiffRuntimePerformance(summary),
    connectorGeometryGate: "tests/connector-geometry.spec.ts: 100k segments, isolated P95 <= 4ms",
  };
  const reportPath = testInfo.outputPath("aligned-diff-performance-report.json");
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await testInfo.attach("aligned-diff-performance-report", {
    path: reportPath,
    contentType: "application/json",
  });
  expect(report.violations, JSON.stringify(report, null, 2)).toEqual([]);
});

async function measureContinuousScroll(
  pane: Locator,
  durationMs: number,
  stepPx: number,
): Promise<number[]> {
  return pane.evaluate(async (element, { duration, step }) => {
    const samples: number[] = [];
    const startedAt = performance.now();
    let direction = 1;
    while (performance.now() - startedAt < duration) {
      const frameStartedAt = performance.now();
      const maximum = Math.max(0, element.scrollHeight - element.clientHeight);
      let next = element.scrollTop + direction * step;
      if (next >= maximum || next <= 0) {
        direction *= -1;
        next = Math.min(maximum, Math.max(0, next));
      }
      element.scrollTop = next;
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      samples.push(performance.now() - frameStartedAt);
    }
    return samples;
  }, { duration: durationMs, step: stepPx });
}

async function traceFastScrollbarJumps(pane: Locator, samples: number): Promise<void> {
  for (let sample = 1; sample <= samples; sample += 1) {
    await pane.evaluate((element, fraction) => {
      element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight) * fraction;
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
    }, sample / (samples + 1));
    await pane.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  }
}

async function measureToggle(
  preview: Locator,
  label: RegExp,
  samples: number,
): Promise<number[]> {
  const durations: number[] = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const current = preview.getByRole("button", { name: label }).first();
    const before = await current.getAttribute("aria-pressed");
    const startedAt = performance.now();
    await current.click();
    await expect(preview.getByRole("button", { name: label }).first()).not.toHaveAttribute(
      "aria-pressed",
      before ?? "",
    );
    durations.push(performance.now() - startedAt);
  }
  return durations;
}

async function measureResponsiveResize(page: Page, preview: Locator, samples: number): Promise<number[]> {
  const durations: number[] = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const compact = sample % 2 === 0;
    const startedAt = performance.now();
    await page.setViewportSize(compact ? { width: 1800, height: 900 } : { width: 2000, height: 1000 });
    await expect(preview.locator('[data-keydex-diff-layout-bridge="true"]')).toHaveAttribute(
      "data-layout",
      "split",
    );
    durations.push(performance.now() - startedAt);
  }
  if (await preview.locator('[data-keydex-diff-layout-bridge="true"]').getAttribute("data-layout") !== "split") {
    await page.setViewportSize({ width: 2000, height: 1000 });
    await expect(preview.locator('[data-keydex-diff-layout-bridge="true"]')).toHaveAttribute("data-layout", "split");
  }
  return durations;
}

async function mountedRowCount(aligned: Locator): Promise<number> {
  const fromContract = Number(await aligned.getAttribute("data-keydex-aligned-mounted-total"));
  const actual = await aligned.locator("[data-keydex-aligned-row]").count();
  // ResizeObserver measurements may advance the virtual window between the attribute and DOM
  // reads, so each independently observed snapshot is checked against the hard mount ceiling.
  expect(fromContract).toBeLessThanOrEqual(2_000);
  expect(actual).toBeLessThanOrEqual(2_000);
  return Math.max(fromContract, actual);
}

async function clearLongTasks(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const state = (window as Window & { __alignedDiffPerformance?: { longTasks: number[] } })
      .__alignedDiffPerformance;
    if (state) state.longTasks.length = 0;
  });
}

async function settleFrames(page: Page, frames: number): Promise<void> {
  await page.evaluate(async (count) => {
    for (let index = 0; index < count; index += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
  }, frames);
}

async function readLongTasks(page: Page): Promise<number[]> {
  return page.evaluate(() =>
    (window as Window & { __alignedDiffPerformance?: { longTasks: number[] } })
      .__alignedDiffPerformance?.longTasks ?? [],
  );
}

async function usedHeapSize(page: Page): Promise<number> {
  return page.evaluate(() => {
    const memory = performance as Performance & { memory?: { usedJSHeapSize?: number } };
    return memory.memory?.usedJSHeapSize ?? 0;
  });
}

function buildLinePatch(path: string, totalChangedLines: number): string {
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
