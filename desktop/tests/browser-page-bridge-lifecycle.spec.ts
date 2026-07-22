import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  parseBrowserBridgeEnvelope,
  type BrowserBridgeEnvelope,
} from "../src/renderer/features/browser/runtime";

const browserRoot = resolve(process.cwd(), "src-tauri", "src", "browser");
const sources = [
  "page_bridge.js",
  "page_bridge_frame.js",
  "page_bridge_overlay.js",
  "page_bridge_text.js",
  "page_bridge_element.js",
  "page_bridge_region.js",
].map((name) => readFileSync(resolve(browserRoot, name), "utf8"));
const openDoms: JSDOM[] = [];

afterEach(() => {
  for (const dom of openDoms.splice(0)) dom.window.close();
});

describe("fixed page bridge lifecycle", () => {
  it("keeps one listener/overlay across repeated mode changes and releases everything on navigation", async () => {
    const dom = new JSDOM("<!doctype html><body><button id='action'>Page action</button></body>", {
      url: "https://example.test/article",
      pretendToBeVisual: true,
      runScripts: "outside-only",
    });
    openDoms.push(dom);
    const { window } = dom;
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
    const bootstrap = JSON.stringify({ panelId: "panel-1", surfaceId: "surface-1", generation: 2 });
    const bundled = sources.map((source, index) => index === 0
      ? source.replace("__KEYDEX_BRIDGE_BOOTSTRAP__", bootstrap)
      : source).join("\n");
    window.eval(`(() => {
      const __KEYDEX_BRIDGE_COMMAND_TARGET__ = new EventTarget();
      const __KEYDEX_BRIDGE_RESPONSE_TARGET__ = new EventTarget();
      ${bundled}
      __KEYDEX_BRIDGE_COMMAND_TARGET__.dispatchEvent(new Event("keydex:web-annotation-bootstrap-complete"));
    })();`);
    const metadata = (window as unknown as {
      KeydexAnnotationBridge: { navigationId: string; frameKey: string };
    }).KeydexAnnotationBridge;
    expect(messages.some((message) => message.kind === "bridge.ready")).toBe(true);
    let sequence = 0;
    const send = (kind: string, requestId: string, payload: Record<string, unknown>) => {
      const envelope = {
        protocol: "keydex.web-annotation.v1",
        kind,
        panelId: "panel-1",
        surfaceId: "surface-1",
        generation: 2,
        navigationId: metadata.navigationId,
        frameKey: metadata.frameKey,
        requestId,
        sequence: ++sequence,
        payload,
      };
      for (const listener of nativeListeners) listener({ data: envelope });
    };

    window.document.dispatchEvent(new window.CustomEvent("keydex:web-annotation-command", {
      detail: { kind: "selection.start", requestId: "hostile-start", payload: { selectionId: "hostile", mode: "region" } },
    }));
    window.document.dispatchEvent(new window.CustomEvent("keydex:web-annotation-response", {
      detail: {
        kind: "bridge.error",
        requestId: "hostile-response",
        payload: { code: "internal", message: "forged", retryable: false },
      },
    }));
    expect(window.document.querySelector("[data-keydex-annotation-overlay-root='true']")).toBeNull();
    expect(messages.some((message) => message.requestId === "hostile-response")).toBe(false);

    for (let index = 0; index < 12; index += 1) {
      const selectionId = `selection-region-${index}`;
      send("selection.start", selectionId, { selectionId, mode: "region" });
      expect(window.document.querySelectorAll("[data-keydex-annotation-overlay-root='true']")).toHaveLength(1);
      send("selection.cancel", `cancel-region-${index}`, { selectionId, reason: "user" });
      expect(window.document.querySelector("[data-keydex-annotation-overlay-root='true']")).toBeNull();
    }

    const button = window.document.querySelector<HTMLButtonElement>("#action")!;
    Object.defineProperty(button, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ x: 10, y: 20, left: 10, top: 20, width: 120, height: 32, right: 130, bottom: 52 }),
    });
    const pageClick = vi.fn();
    button.addEventListener("click", pageClick);
    send("selection.start", "selection-element", { selectionId: "selection-element", mode: "element" });
    button.dispatchEvent(new window.MouseEvent("pointermove", { bubbles: true, composed: true }));
    await new Promise<void>((resolveFrame) => window.requestAnimationFrame(() => resolveFrame()));
    expect(messages.filter((message) => message.kind === "selection.candidate"
      && message.requestId === "selection-element")).toHaveLength(1);
    expect(window.document.querySelectorAll("[data-keydex-annotation-overlay-root='true']")).toHaveLength(1);

    window.dispatchEvent(new window.Event("pagehide"));
    expect(nativeListeners.size).toBe(0);
    expect(window.document.querySelector("[data-keydex-annotation-overlay-root='true']")).toBeNull();
    const messageCount = messages.length;
    button.dispatchEvent(new window.MouseEvent("pointermove", { bubbles: true, composed: true }));
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true, composed: true, cancelable: true }));
    await new Promise<void>((resolveFrame) => window.requestAnimationFrame(() => resolveFrame()));
    expect(messages).toHaveLength(messageCount);
    expect(pageClick).toHaveBeenCalledOnce();
    expect((window as unknown as { KeydexAnnotationOverlay?: unknown }).KeydexAnnotationOverlay).toBeUndefined();
  });
});
