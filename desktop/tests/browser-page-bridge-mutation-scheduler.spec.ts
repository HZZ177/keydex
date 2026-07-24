import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseBrowserBridgeEnvelope, type BrowserBridgeEnvelope } from "../src/renderer/features/browser/runtime";

const bridgeSource = readFileSync(resolve(process.cwd(), "src-tauri", "src", "browser", "page_bridge.js"), "utf8");
const mutationSource = readFileSync(resolve(process.cwd(), "src-tauri", "src", "browser", "page_bridge_mutation.js"), "utf8");
const openDoms: JSDOM[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const dom of openDoms.splice(0)) dom.window.close();
});

describe("page bridge mutation scheduler", () => {
  it("coalesces a mutation storm behind the centralized 250ms debounce", async () => {
    vi.useFakeTimers();
    const run = createRun();
    for (let index = 0; index < 20; index += 1) {
      run.document.body.append(run.document.createElement("div"));
    }
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(249);
    expect(run.changes()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);

    expect(run.changes()).toHaveLength(1);
    expect(run.changes()[0].payload).toEqual({
      reason: "dom",
      revision: 1,
      annotationIds: ["annotation-1"],
    });
  });

  it("flushes continuous updates no later than the 2s maximum delay", async () => {
    vi.useFakeTimers();
    const run = createRun();
    for (let index = 0; index < 10; index += 1) {
      run.document.body.setAttribute("class", `step-${index}`);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(200);
    }

    expect(run.changes()).toHaveLength(1);
    expect(run.changes()[0].payload).toEqual({
      reason: "dom",
      revision: 1,
      annotationIds: ["annotation-1"],
    });
  });

  it("turns a 10 MiB dynamic-page update into one bounded dirty signal", async () => {
    vi.useFakeTimers();
    const run = createRun();
    const article = run.document.createElement("article");
    article.textContent = "x".repeat(10 * 1024 * 1024);
    run.document.body.append(article);
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(250);

    expect(run.changes()).toHaveLength(1);
    expect(run.changes()[0].payload).toEqual({
      reason: "dom",
      revision: 1,
      annotationIds: ["annotation-1"],
    });
  });

  it("coalesces dynamic local-file DOM updates with the same bounded scheduler", async () => {
    vi.useFakeTimers();
    const run = createRun("file:///D:/e2e-wbf/annotations/dynamic.html");
    const article = run.document.createElement("article");
    run.document.body.append(article);
    article.replaceChildren(run.document.createTextNode("updated local content"));
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(250);

    expect(run.changes()).toHaveLength(1);
    expect(run.changes()[0].payload).toEqual({
      reason: "dom",
      revision: 1,
      annotationIds: ["annotation-1"],
    });
  });

  it("ignores Keydex overlay mutations and cancels pending work on pagehide", async () => {
    vi.useFakeTimers();
    const run = createRun();
    const overlay = run.document.createElement("div");
    overlay.setAttribute("data-keydex-annotation-overlay-root", "true");
    run.document.documentElement.append(overlay);
    overlay.append(run.document.createElement("span"));
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(run.changes()).toHaveLength(0);

    run.document.body.append(run.document.createElement("article"));
    await Promise.resolve();
    run.window.dispatchEvent(new run.window.Event("pagehide"));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(run.changes()).toHaveLength(0);
  });
});

function createRun(url = "https://example.test/dynamic") {
  const dom = new JSDOM("<!doctype html><body></body>", {
    url,
    pretendToBeVisual: true,
    runScripts: "outside-only",
  });
  openDoms.push(dom);
  Object.defineProperty(dom.window.Date, "now", {
    configurable: true,
    value: () => Date.now(),
  });
  const messages: BrowserBridgeEnvelope[] = [];
  Object.defineProperty(dom.window, "chrome", {
    configurable: true,
    value: {
      webview: {
        postMessage(value: unknown) {
          const parsed = parseBrowserBridgeEnvelope(value, "page-to-host");
          if (parsed.ok) messages.push(parsed.envelope);
        },
        addEventListener() {},
        removeEventListener() {},
      },
    },
  });
  dom.window.eval(`let __KEYDEX_BRIDGE_DIAGNOSTICS_POST__ = null;\n${bridgeSource.replace("__KEYDEX_BRIDGE_BOOTSTRAP__", JSON.stringify({
    panelId: "panel-1",
    surfaceId: "surface-1",
    generation: 2,
    resolverPolicy: {
      batchSize: 50,
      mutationDebounceMs: 250,
      mutationMaxDelayMs: 2_000,
      sliceBudgetMs: 8,
    },
  }))}`);
  (dom.window as unknown as {
    KeydexAnnotationBridge: {
      nodeBindings: { bindAnnotation(annotationId: string, node: Element): unknown };
    };
  }).KeydexAnnotationBridge.nodeBindings.bindAnnotation("annotation-1", dom.window.document.body);
  dom.window.eval(mutationSource);
  return {
    window: dom.window,
    document: dom.window.document,
    changes: () => messages.filter((message): message is BrowserBridgeEnvelope<"page.changed"> => message.kind === "page.changed"),
  };
}
