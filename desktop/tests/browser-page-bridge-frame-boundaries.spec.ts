import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";

import {
  parseBrowserBridgeEnvelope,
  type BrowserBridgeEnvelope,
  type WebElementTarget,
} from "../src/renderer/features/browser/runtime";

const bridgeSource = source("page_bridge.js");
const frameSource = source("page_bridge_frame.js");
const elementSource = source("page_bridge_element.js");
const regionSource = source("page_bridge_region.js");
const openDoms: JSDOM[] = [];
type DOMWindow = JSDOM["window"];

afterEach(() => {
  for (const dom of openDoms.splice(0)) dom.window.close();
});

describe("page bridge iframe and Shadow DOM boundaries", () => {
  it("maps a child-frame CSS region into top-surface coordinates without reading child DOM", async () => {
    const run = createFrameRun();
    run.frameRect({ x: 100, y: 50, width: 400, height: 300 });

    const geometry = await run.frameBridge.mapRectToSurface(
      { x: 20, y: 30, width: 100, height: 60 },
      { width: 400, height: 300 },
    );

    expect(geometry).toEqual({
      rect: { x: 120, y: 80, width: 100, height: 60 },
      viewport: { width: 1000, height: 800 },
    });
    expect(run.frameBridge.parentElementPath()?.length).toBeGreaterThan(0);
  });

  it("persists current iframe index/path after reorder and never stores a runtime frame id", async () => {
    const run = createFrameRun();
    run.child.document.body.innerHTML = "<button aria-label='Frame action'>Open</button>";
    const button = run.child.document.querySelector("button")!;
    run.rect(button, { x: 10, y: 20, width: 120, height: 32 });

    const inserted = run.parent.document.createElement("iframe");
    run.parent.document.body.insertBefore(inserted, run.frameElement);
    run.start("selection-frame");
    await run.flush();
    await run.hover(button);
    button.dispatchEvent(new run.child.MouseEvent("click", {
      bubbles: true,
      composed: true,
      cancelable: true,
    }));

    const target = run.result("selection-frame");
    expect(target.frame.indexPath).toEqual([1]);
    expect(target.frame.parentElementPath?.length).toBeGreaterThan(0);
    expect(JSON.stringify(target.frame)).not.toMatch(/frameId|frameKey|frame-native/u);
  });

  it("keeps the persisted region local to the frame but returns top-surface capture geometry", async () => {
    const run = createFrameRun();
    run.frameRect({ x: 100, y: 50, width: 400, height: 300 });
    run.start("selection-frame-region", "region");
    const overlay = run.child.document.querySelector("[data-keydex-annotation-overlay-root='true']");
    const layer = overlay?.shadowRoot?.querySelector("[part='capture-layer']");
    expect(layer).not.toBeNull();
    for (const [type, x, y] of [
      ["pointerdown", 20, 30],
      ["pointerup", 120, 90],
    ] as const) {
      layer!.dispatchEvent(new run.child.MouseEvent(type, {
        bubbles: true,
        composed: true,
        cancelable: true,
        button: 0,
        clientX: x,
        clientY: y,
      }));
    }
    await run.flush();

    expect(run.message("selection.result", "selection-frame-region")?.payload).toMatchObject({
      target: {
        type: "region",
        rect: { x: 20, y: 30, width: 100, height: 60 },
        viewport: { width: 400, height: 300 },
        frame: { indexPath: [0] },
      },
      captureGeometry: {
        rect: { x: 120, y: 80, width: 100, height: 60 },
        viewport: { width: 1000, height: 800 },
      },
    });
  });

  it("reports navigation cancellation before bridge teardown drops the old frame request", async () => {
    const run = createFrameRun();
    run.child.document.body.innerHTML = "<button>Frame action</button>";
    run.start("selection-navigation");
    await run.flush();
    run.child.dispatchEvent(new run.child.Event("pagehide"));

    expect(run.message("selection.cancelled", "selection-navigation")?.payload).toEqual({
      selectionId: "selection-navigation",
      reason: "navigation",
    });
  });
});

function createFrameRun() {
  const dom = new JSDOM("<!doctype html><body><iframe id='target-frame'></iframe></body>", {
    url: "https://host.example.test/article",
    pretendToBeVisual: true,
    runScripts: "outside-only",
  });
  openDoms.push(dom);
  const parent = dom.window;
  const frameElement = parent.document.querySelector("iframe")!;
  const child = frameElement.contentWindow as unknown as DOMWindow;
  Object.defineProperties(parent.document.documentElement, {
    clientWidth: { configurable: true, value: 1000 },
    clientHeight: { configurable: true, value: 800 },
  });
  Object.defineProperties(child.document.documentElement, {
    clientWidth: { configurable: true, value: 400 },
    clientHeight: { configurable: true, value: 300 },
  });
  installMessageBus(parent, child);
  parent.eval(frameSource);

  const messages: BrowserBridgeEnvelope[] = [];
  const nativeListeners = new Set<(event: { data: unknown }) => void>();
  Object.defineProperty(child, "chrome", {
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
  Object.defineProperty(child, "__KEYDEX_BRIDGE_DIAGNOSTICS_POST__", {
    configurable: true,
    writable: true,
    value: null,
  });
  child.eval(bridgeSource.replace("__KEYDEX_BRIDGE_BOOTSTRAP__", JSON.stringify({
    panelId: "panel-1",
    surfaceId: "surface-1",
    generation: 2,
  })));
  child.eval(frameSource);
  child.eval(elementSource);
  child.eval(regionSource);
  const metadata = (child as unknown as {
    KeydexAnnotationBridge: { navigationId: string; frameKey: string };
    KeydexAnnotationFrameBridge: {
      mapRectToSurface(
        rect: { x: number; y: number; width: number; height: number },
        viewport: { width: number; height: number },
      ): Promise<{
        rect: { x: number; y: number; width: number; height: number };
        viewport: { width: number; height: number };
      }>;
      parentElementPath(): readonly { childIndex: number; shadowRoot: boolean }[] | null;
    };
  });
  let hostSequence = 0;
  const start = (selectionId: string, mode: "element" | "region" = "element") => {
    const envelope = {
      protocol: "keydex.web-annotation.v1",
      kind: "selection.start",
      panelId: "panel-1",
      surfaceId: "surface-1",
      generation: 2,
      navigationId: metadata.KeydexAnnotationBridge.navigationId,
      frameKey: metadata.KeydexAnnotationBridge.frameKey,
      requestId: selectionId,
      sequence: ++hostSequence,
      payload: { selectionId, mode },
    };
    for (const listener of nativeListeners) listener({ data: envelope });
  };
  const frameRect = (value: { x: number; y: number; width: number; height: number }) => {
    rect(frameElement, value);
    Object.defineProperties(frameElement, {
      offsetWidth: { configurable: true, value: value.width },
      offsetHeight: { configurable: true, value: value.height },
      clientWidth: { configurable: true, value: value.width },
      clientHeight: { configurable: true, value: value.height },
      clientLeft: { configurable: true, value: 0 },
      clientTop: { configurable: true, value: 0 },
    });
  };
  frameRect({ x: 0, y: 0, width: 400, height: 300 });
  const hover = async (element: Element) => {
    element.dispatchEvent(new child.MouseEvent("pointermove", { bubbles: true, composed: true }));
    await new Promise<void>((resolveFrame) => child.requestAnimationFrame(() => resolveFrame()));
  };
  const message = <K extends BrowserBridgeEnvelope["kind"]>(kind: K, requestId: string) =>
    (messages.find((envelope) => envelope.kind === kind && envelope.requestId === requestId) ?? null) as BrowserBridgeEnvelope<K> | null;
  const result = (requestId: string): WebElementTarget => {
    const envelope = message("selection.result", requestId);
    expect(envelope).not.toBeNull();
    return (envelope as BrowserBridgeEnvelope<"selection.result">).payload.target as WebElementTarget;
  };
  const flush = async () => {
    await new Promise<void>((resolveTask) => parent.setTimeout(resolveTask, 0));
    await new Promise<void>((resolveTask) => parent.setTimeout(resolveTask, 0));
  };
  return {
    parent,
    child,
    frameElement,
    frameBridge: metadata.KeydexAnnotationFrameBridge,
    messages,
    start,
    frameRect,
    rect,
    hover,
    message,
    result,
    flush,
  };
}

function installMessageBus(parent: DOMWindow, child: DOMWindow): void {
  Object.defineProperty(parent, "postMessage", {
    configurable: true,
    value(data: unknown) {
      parent.queueMicrotask(() => parent.dispatchEvent(new parent.MessageEvent("message", {
        data,
        source: child as unknown as MessageEventSource,
      })));
    },
  });
  Object.defineProperty(child, "postMessage", {
    configurable: true,
    value(data: unknown) {
      child.queueMicrotask(() => child.dispatchEvent(new child.MessageEvent("message", {
        data,
        source: parent as unknown as MessageEventSource,
      })));
    },
  });
}

function rect(element: Element, value: { x: number; y: number; width: number; height: number }): void {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      ...value,
      left: value.x,
      top: value.y,
      right: value.x + value.width,
      bottom: value.y + value.height,
    }),
  });
}

function source(file: string): string {
  return readFileSync(resolve(process.cwd(), "src-tauri", "src", "browser", file), "utf8");
}
