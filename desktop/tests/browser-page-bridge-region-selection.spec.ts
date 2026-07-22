import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  parseBrowserBridgeEnvelope,
  type BrowserBridgeEnvelope,
  type WebRegionTarget,
} from "../src/renderer/features/browser/runtime";

const bridgeSource = readFileSync(resolve(process.cwd(), "src-tauri", "src", "browser", "page_bridge.js"), "utf8");
const overlaySource = readFileSync(resolve(process.cwd(), "src-tauri", "src", "browser", "page_bridge_overlay.js"), "utf8");
const regionSource = readFileSync(resolve(process.cwd(), "src-tauri", "src", "browser", "page_bridge_region.js"), "utf8");
const openDoms: JSDOM[] = [];
type DOMWindow = JSDOM["window"];

afterEach(() => {
  for (const dom of openDoms.splice(0)) dom.window.close();
});

describe("page bridge region selection", () => {
  it("returns a viewport CSS rect, scroll snapshot, frame locator, and semantic anchor", async () => {
    const run = createRun("<article id='card'>Release notes</article>");
    const article = run.document.querySelector("article")!;
    run.rect(article, { x: 80, y: 90, width: 260, height: 180 });
    run.hitTest(article);
    Object.defineProperties(run.window, {
      scrollX: { configurable: true, value: 14 },
      scrollY: { configurable: true, value: 120 },
    });

    run.start("selection-region");
    await run.drag({ x: 100, y: 110 }, { x: 300, y: 230 });

    const target = run.result("selection-region");
    expect(target).toMatchObject({
      type: "region",
      rect: { x: 100, y: 110, width: 200, height: 120 },
      viewport: { width: 800, height: 600 },
      scroll: { x: 14, y: 120 },
      frame: { url: "https://example.test/article", indexPath: [] },
      relativeElement: {
        rect: { x: 80, y: 90, width: 260, height: 180 },
        tag: "article",
        role: "article",
        accessibleName: "Release notes",
      },
      visual: {
        fingerprintVersion: 1,
        localDigest: expect.stringMatching(/^fnv1a32:[0-9a-f]{8}$/u),
      },
    });
    expect(target.relativeElement?.path.length).toBeGreaterThan(0);
    expect(run.message("selection.candidate", "selection-region")?.payload).toMatchObject({
      mode: "region",
      label: "区域 200 × 120",
      rect: target.rect,
    });
  });

  it("normalizes reverse drags and keeps the capture layer isolated from page actions", async () => {
    const run = createRun("<button>Dangerous page action</button>");
    const pagePointerDown = vi.fn();
    run.document.querySelector("button")!.addEventListener("pointerdown", pagePointerDown);

    run.start("selection-reverse");
    await run.drag({ x: 300, y: 260 }, { x: 120, y: 100 });

    expect(pagePointerDown).not.toHaveBeenCalled();
    expect(run.result("selection-reverse").rect).toEqual({
      x: 120,
      y: 100,
      width: 180,
      height: 160,
    });
    expect(run.document.querySelector("[data-keydex-annotation-overlay-root='true']")).toBeNull();
  });

  it("rejects tiny and pointer-cancelled regions without producing capture targets", async () => {
    const tiny = createRun("");
    tiny.start("selection-tiny");
    await tiny.drag({ x: 10, y: 10 }, { x: 15, y: 15 });
    expect(tiny.message("selection.result", "selection-tiny")).toBeNull();
    expect(tiny.message("selection.cancelled", "selection-tiny")?.payload).toEqual({
      selectionId: "selection-tiny",
      reason: "invalid_selection",
    });

    const cancelled = createRun("");
    cancelled.start("selection-cancelled");
    cancelled.pointer("pointerdown", 20, 20);
    cancelled.pointer("pointercancel", 80, 80);
    expect(cancelled.message("selection.result", "selection-cancelled")).toBeNull();
    expect(cancelled.message("selection.cancelled", "selection-cancelled")?.payload).toMatchObject({
      reason: "invalid_selection",
    });

    const offscreen = createRun("");
    offscreen.start("selection-offscreen");
    offscreen.pointer("pointerdown", 20, 20);
    offscreen.pointer("pointerup", 900, 700);
    expect(offscreen.message("selection.result", "selection-offscreen")).toBeNull();
    expect(offscreen.message("selection.cancelled", "selection-offscreen")?.payload).toMatchObject({
      reason: "invalid_selection",
    });
  });

  it("cancels with Escape and removes every temporary listener/overlay on navigation", () => {
    const escape = createRun("");
    escape.start("selection-escape");
    escape.document.dispatchEvent(new escape.window.KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    }));
    expect(escape.message("selection.cancelled", "selection-escape")?.payload).toEqual({
      selectionId: "selection-escape",
      reason: "user",
    });
    expect(escape.document.querySelector("[data-keydex-annotation-overlay-root='true']")).toBeNull();

    const navigation = createRun("");
    navigation.start("selection-navigation");
    navigation.window.dispatchEvent(new navigation.window.Event("pagehide"));
    expect(navigation.document.querySelector("[data-keydex-annotation-overlay-root='true']")).toBeNull();
    navigation.document.body.dispatchEvent(new navigation.window.MouseEvent("pointerup", {
      bubbles: true,
      cancelable: true,
      clientX: 100,
      clientY: 100,
    }));
    expect(navigation.message("selection.result", "selection-navigation")).toBeNull();
  });
});

function createRun(html: string) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, {
    url: "https://example.test/article",
    pretendToBeVisual: true,
    runScripts: "outside-only",
  });
  openDoms.push(dom);
  Object.defineProperties(dom.window.document.documentElement, {
    clientWidth: { configurable: true, value: 800 },
    clientHeight: { configurable: true, value: 600 },
  });
  return installRun(dom.window);
}

function installRun(window: DOMWindow) {
  const messages: BrowserBridgeEnvelope[] = [];
  const nativeListeners = new Set<(event: { data: unknown }) => void>();
  Object.defineProperty(window, "chrome", {
    configurable: true,
    value: {
      webview: {
        postMessage(value: unknown) {
          const parsed = parseBrowserBridgeEnvelope(value, "page-to-host");
          if (parsed.ok) messages.push(parsed.envelope);
        },
        addEventListener(type: string, listener: (event: { data: unknown }) => void) {
          if (type === "message") nativeListeners.add(listener);
        },
        removeEventListener(type: string, listener: (event: { data: unknown }) => void) {
          if (type === "message") nativeListeners.delete(listener);
        },
      },
    },
  });
  window.eval(bridgeSource.replace("__KEYDEX_BRIDGE_BOOTSTRAP__", JSON.stringify({
    panelId: "panel-1",
    surfaceId: "surface-1",
    generation: 2,
  })));
  window.eval(overlaySource);
  window.eval(regionSource);
  const metadata = (window as unknown as {
    KeydexAnnotationBridge: { navigationId: string; frameKey: string };
  }).KeydexAnnotationBridge;
  let hostSequence = 0;
  const start = (selectionId: string) => {
    const envelope = {
      protocol: "keydex.web-annotation.v1",
      kind: "selection.start",
      panelId: "panel-1",
      surfaceId: "surface-1",
      generation: 2,
      navigationId: metadata.navigationId,
      frameKey: metadata.frameKey,
      requestId: selectionId,
      sequence: ++hostSequence,
      payload: { selectionId, mode: "region" },
    };
    for (const listener of nativeListeners) listener({ data: envelope });
  };
  const layer = () => {
    const root = window.document.querySelector("[data-keydex-annotation-overlay-root='true']");
    const value = root?.shadowRoot?.querySelector("[part='capture-layer']");
    expect(value).not.toBeNull();
    return value!;
  };
  const pointer = (type: string, x: number, y: number) => {
    layer().dispatchEvent(new window.MouseEvent(type, {
      bubbles: true,
      composed: true,
      cancelable: true,
      button: 0,
      clientX: x,
      clientY: y,
    }));
  };
  const drag = async (startPoint: { x: number; y: number }, endPoint: { x: number; y: number }) => {
    pointer("pointerdown", startPoint.x, startPoint.y);
    pointer("pointermove", endPoint.x, endPoint.y);
    pointer("pointerup", endPoint.x, endPoint.y);
    await Promise.resolve();
  };
  const rect = (element: Element, value: { x: number; y: number; width: number; height: number }) => {
    Object.defineProperty(element, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ ...value, left: value.x, top: value.y, right: value.x + value.width, bottom: value.y + value.height }),
    });
  };
  const hitTest = (element: Element) => {
    Object.defineProperty(window.document, "elementsFromPoint", {
      configurable: true,
      value: () => [element],
    });
  };
  const message = <K extends BrowserBridgeEnvelope["kind"]>(kind: K, requestId: string) =>
    (messages.find((envelope) => envelope.kind === kind && envelope.requestId === requestId) ?? null) as BrowserBridgeEnvelope<K> | null;
  const result = (requestId: string): WebRegionTarget => {
    const envelope = message("selection.result", requestId);
    expect(envelope).not.toBeNull();
    return (envelope as BrowserBridgeEnvelope<"selection.result">).payload.target as WebRegionTarget;
  };
  return { window, document: window.document, messages, start, pointer, drag, rect, hitTest, message, result };
}
