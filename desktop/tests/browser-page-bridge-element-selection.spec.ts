import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  parseBrowserBridgeEnvelope,
  type BrowserBridgeEnvelope,
  type WebElementTarget,
} from "../src/renderer/features/browser/runtime";

const bridgeSource = readFileSync(resolve(process.cwd(), "src-tauri", "src", "browser", "page_bridge.js"), "utf8");
const elementSource = readFileSync(resolve(process.cwd(), "src-tauri", "src", "browser", "page_bridge_element.js"), "utf8");
const openDoms: JSDOM[] = [];
type DOMWindow = JSDOM["window"];

afterEach(() => {
  for (const dom of openDoms.splice(0)) dom.window.close();
});

describe("page bridge element selection", () => {
  it("selects the deepest hit DOM element and suppresses the page click", async () => {
    const run = createRun("<button id='save'><span>Save changes</span></button>");
    const button = run.document.querySelector("button")!;
    const span = run.document.querySelector("span")!;
    run.rect(button, { x: 10, y: 20, width: 140, height: 32 });
    run.rect(span, { x: 14, y: 24, width: 90, height: 20 });
    const pageClick = vi.fn();
    const pagePointerUp = vi.fn();
    button.addEventListener("click", pageClick);
    button.addEventListener("pointerup", pagePointerUp);

    run.start("selection-button");
    await run.hover(span);
    span.dispatchEvent(new run.window.MouseEvent("pointerup", { bubbles: true, cancelable: true }));
    const dispatched = span.dispatchEvent(new run.window.MouseEvent("click", { bubbles: true, cancelable: true }));

    const target = run.result("selection-button");
    expect(dispatched).toBe(false);
    expect(pageClick).not.toHaveBeenCalled();
    expect(pagePointerUp).not.toHaveBeenCalled();
    expect(target).toMatchObject({
      type: "element",
      tag: "span",
      rect: { x: 14, y: 24, width: 90, height: 20 },
    });
  });

  it("treats canvas and background containers as first-class inspectable elements", async () => {
    const run = createRun("<section id='dashboard' class='surface panel'><canvas id='chart' class='plot'></canvas></section>");
    const container = run.document.querySelector("section")!;
    const canvas = run.document.querySelector("canvas")!;
    run.rect(container, { x: 10, y: 10, width: 420, height: 260 });
    run.rect(canvas, { x: 30, y: 40, width: 360, height: 180 });

    run.start("selection-canvas");
    expect(run.document.querySelector("[data-keydex-annotation-inspector-cursor='true']")).not.toBeNull();
    await run.hover(canvas);
    const canvasCandidate = run.internalResponses.find((response) => response.kind === "selection.candidate");
    expect(canvasCandidate?.payload?.label).toBe("canvas#chart.plot");
    canvas.dispatchEvent(new run.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(run.result("selection-canvas")).toMatchObject({ tag: "canvas" });
    expect(run.document.querySelector("[data-keydex-annotation-inspector-cursor='true']")).toBeNull();

    run.start("selection-container");
    await run.hover(canvas);
    run.document.dispatchEvent(new run.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    run.document.dispatchEvent(new run.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(run.result("selection-container")).toMatchObject({ tag: "section" });
  });

  it("navigates every child/parent DOM candidate with Tab and confirms with Enter", async () => {
    const run = createRun("<article aria-label='Release card'><button><span>Open release</span></button></article>");
    const article = run.document.querySelector("article")!;
    const button = run.document.querySelector("button")!;
    const span = run.document.querySelector("span")!;
    run.rect(article, { x: 5, y: 5, width: 300, height: 180 });
    run.rect(button, { x: 20, y: 40, width: 120, height: 30 });
    run.rect(span, { x: 25, y: 45, width: 90, height: 20 });

    run.start("selection-parent");
    await run.hover(span);
    run.document.dispatchEvent(new run.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    run.document.dispatchEvent(new run.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    run.document.dispatchEvent(new run.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));

    const target = run.result("selection-parent");
    expect(target.tag).toBe("article");
    expect(target.role).toBe("article");
    expect(target.accessibleName).toBe("Release card");
  });

  it("captures safe input/image/link attributes without value, token query, HTML, class, or data fields", async () => {
    const run = createRun(`
      <label for='secret'>Account password</label>
      <input id='secret' name='credential' type='password' value='password-secret' data-token='token-secret'>
      <img alt='Architecture diagram' src='https://cdn.example.test/diagram.png?token=secret#part'>
      <a href='https://example.test/report?access_token=secret#section'>Report</a>
    `);
    const input = run.document.querySelector("input")!;
    const image = run.document.querySelector("img")!;
    const link = run.document.querySelector("a")!;
    for (const [index, element] of [input, image, link].entries()) {
      run.rect(element, { x: 10, y: 20 + index * 40, width: 180, height: 30 });
    }

    run.start("selection-input");
    await run.hover(input);
    input.dispatchEvent(new run.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    const inputTarget = run.result("selection-input");
    expect(inputTarget.accessibleName).toBe("Account password");
    expect(JSON.stringify(inputTarget)).not.toMatch(/password-secret|token-secret|data-token|outerHTML/);
    expect(Object.prototype.hasOwnProperty.call(inputTarget, "value")).toBe(false);
    expect(inputTarget.stableAttributes).toContainEqual({ name: "type", value: "password" });

    run.start("selection-image");
    await run.hover(image);
    image.dispatchEvent(new run.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    const imageTarget = run.result("selection-image");
    expect(imageTarget).toMatchObject({ tag: "img", role: "img", accessibleName: "Architecture diagram" });
    expect(imageTarget.stableAttributes.find((entry) => entry.name === "src")?.value).toBe("https://cdn.example.test/diagram.png");

    run.start("selection-link");
    await run.hover(link);
    link.dispatchEvent(new run.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    const linkTarget = run.result("selection-link");
    expect(linkTarget.stableAttributes.find((entry) => entry.name === "href")?.value).toBe("https://example.test/report");
  });

  it("keeps canonical file href/src only for a native local-file document", async () => {
    const local = createRun(`
      <img alt='Local diagram' src='./assets/diagram.png?token=secret#part'>
      <a href='./nested/page.html?session=secret#section'>Local page</a>
    `, "file:///D:/workspace/index.html");
    const image = local.document.querySelector("img")!;
    const link = local.document.querySelector("a")!;
    local.rect(image, { x: 10, y: 20, width: 180, height: 80 });
    local.rect(link, { x: 10, y: 120, width: 180, height: 30 });

    local.start("selection-local-image");
    await local.hover(image);
    image.dispatchEvent(new local.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(local.result("selection-local-image").stableAttributes).toContainEqual({
      name: "src",
      value: "file:///D:/workspace/assets/diagram.png",
    });

    local.start("selection-local-link");
    await local.hover(link);
    link.dispatchEvent(new local.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(local.result("selection-local-link").stableAttributes).toContainEqual({
      name: "href",
      value: "file:///D:/workspace/nested/page.html",
    });

    const remote = createRun("<a href='file:///D:/workspace/private.html'>Blocked local path</a>");
    const remoteLink = remote.document.querySelector("a")!;
    remote.rect(remoteLink, { x: 10, y: 20, width: 180, height: 30 });
    remote.start("selection-remote-file-link");
    await remote.hover(remoteLink);
    remoteLink.dispatchEvent(new remote.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(remote.result("selection-remote-file-link").stableAttributes)
      .not.toContainEqual({ name: "href", value: "file:///D:/workspace/private.html" });
  });

  it("selects a local-file button without firing its page action", async () => {
    const run = createRun(
      "<h1>Local controls</h1><button id='save' aria-label='Save local draft'>Save</button>",
      "file:///D:/Keydex%20Fixtures/annotation.html",
    );
    const button = run.document.querySelector("button")!;
    run.rect(button, { x: 20, y: 40, width: 160, height: 36 });
    const pageAction = vi.fn();
    button.addEventListener("click", pageAction);

    run.start("selection-local-button");
    await run.hover(button);
    const dispatched = button.dispatchEvent(new run.window.MouseEvent("click", {
      bubbles: true,
      composed: true,
      cancelable: true,
    }));

    expect(dispatched).toBe(false);
    expect(pageAction).not.toHaveBeenCalled();
    expect(run.result("selection-local-button")).toMatchObject({
      type: "element",
      tag: "button",
      role: "button",
      accessibleName: "Save local draft",
      stableAttributes: expect.arrayContaining([{ name: "id", value: "save" }]),
      rect: { x: 20, y: 40, width: 160, height: 36 },
      frame: {
        url: "file:///D:/Keydex%20Fixtures/annotation.html",
        indexPath: [],
      },
    });
  });

  it("selects a local-file form submit control without submitting the form", async () => {
    const run = createRun(
      "<form><label for='name'>Name</label><input id='name'><button type='submit'>Send form</button></form>",
      "file:///D:/Keydex%20Fixtures/forms.html",
    );
    const form = run.document.querySelector("form")!;
    const submit = run.document.querySelector("button")!;
    run.rect(submit, { x: 30, y: 80, width: 120, height: 32 });
    const pageSubmit = vi.fn((event: Event) => event.preventDefault());
    form.addEventListener("submit", pageSubmit);

    run.start("selection-local-submit");
    await run.hover(submit);
    submit.click();

    expect(pageSubmit).not.toHaveBeenCalled();
    expect(run.result("selection-local-submit")).toMatchObject({
      tag: "button",
      role: "button",
      accessibleName: "Send form",
      stableAttributes: expect.arrayContaining([{ name: "type", value: "submit" }]),
      frame: { url: "file:///D:/Keydex%20Fixtures/forms.html", indexPath: [] },
    });
  });

  it("persists an open-shadow target from a local file with host boundaries", async () => {
    const run = createRun(
      "<main><div id='widget-host' aria-label='Local widget'></div></main>",
      "file:///D:/Keydex%20Fixtures/shadow.html",
    );
    const host = run.document.querySelector("#widget-host")!;
    const shadow = host.attachShadow({ mode: "open" });
    const action = run.document.createElement("button");
    action.setAttribute("aria-label", "Shadow save");
    action.textContent = "Save";
    shadow.append(action);
    run.rect(host, { x: 10, y: 20, width: 220, height: 80 });
    run.rect(action, { x: 30, y: 40, width: 120, height: 32 });

    run.start("selection-local-shadow");
    await run.hover(action);
    action.dispatchEvent(new run.window.MouseEvent("click", {
      bubbles: true,
      composed: true,
      cancelable: true,
    }));

    const target = run.result("selection-local-shadow");
    expect(target).toMatchObject({
      tag: "button",
      role: "button",
      accessibleName: "Shadow save",
      rect: { x: 30, y: 40, width: 120, height: 32 },
      frame: { url: "file:///D:/Keydex%20Fixtures/shadow.html", indexPath: [] },
    });
    expect(target.path.some((segment) => segment.shadowRoot)).toBe(true);
    expect(target.shadowHostPath?.length).toBeGreaterThan(0);
  });

  it("selects table cells and records open Shadow DOM host/path boundaries", async () => {
    const run = createRun("<table><tbody><tr><td><span>42</span></td></tr></tbody></table><div id='host'></div>");
    const cell = run.document.querySelector("td")!;
    const cellSpan = cell.querySelector("span")!;
    run.rect(cell, { x: 10, y: 10, width: 80, height: 30 });
    run.rect(cellSpan, { x: 14, y: 14, width: 20, height: 18 });
    run.start("selection-cell");
    await run.hover(cellSpan);
    run.document.dispatchEvent(new run.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    cellSpan.dispatchEvent(new run.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(run.result("selection-cell")).toMatchObject({ tag: "td", role: "cell", accessibleName: "42" });

    const host = run.document.querySelector("#host")!;
    const shadow = host.attachShadow({ mode: "open" });
    const shadowButton = run.document.createElement("button");
    shadowButton.textContent = "Shadow action";
    shadow.append(shadowButton);
    run.rect(host, { x: 200, y: 10, width: 150, height: 50 });
    run.rect(shadowButton, { x: 210, y: 20, width: 120, height: 30 });
    run.start("selection-shadow");
    await run.hover(shadowButton);
    shadowButton.dispatchEvent(new run.window.MouseEvent("click", { bubbles: true, composed: true, cancelable: true }));
    const shadowTarget = run.result("selection-shadow");
    expect(shadowTarget.tag).toBe("button");
    expect(shadowTarget.path.some((segment) => segment.shadowRoot)).toBe(true);
    expect(shadowTarget.shadowHostPath?.length).toBeGreaterThan(0);
  });

  it("degrades a closed Shadow DOM selection to its visible semantic host", async () => {
    const run = createRun("<div id='closed-host' role='button' aria-label='Closed widget'></div>");
    const host = run.document.querySelector("#closed-host")!;
    const shadow = host.attachShadow({ mode: "closed" });
    const internal = run.document.createElement("button");
    internal.textContent = "Private implementation";
    shadow.append(internal);
    run.rect(host, { x: 40, y: 30, width: 180, height: 44 });
    run.rect(internal, { x: 50, y: 36, width: 140, height: 30 });

    run.start("selection-closed-shadow");
    await run.hover(internal);
    internal.dispatchEvent(new run.window.MouseEvent("click", {
      bubbles: true,
      composed: true,
      cancelable: true,
    }));

    const target = run.result("selection-closed-shadow");
    expect(target).toMatchObject({
      type: "element",
      tag: "div",
      role: "button",
      accessibleName: "Closed widget",
    });
    expect(target.path.some((segment) => segment.shadowRoot)).toBe(false);
    expect(target.shadowHostPath).toBeUndefined();
    expect(JSON.stringify(target)).not.toContain("Private implementation");
  });

  it("includes generic and aria-hidden visual elements, then clears the candidate when the pointer leaves", async () => {
    const run = createRun("<div aria-hidden='true'><span class='decoration'>Visual decoration</span></div>");
    const container = run.document.querySelector("div")!;
    const decoration = run.document.querySelector("span")!;
    run.rect(container, { x: 10, y: 10, width: 180, height: 60 });
    run.rect(decoration, { x: 18, y: 18, width: 120, height: 24 });

    run.start("selection-generic");
    await run.hover(decoration);
    expect(run.internalResponses.some((response) => response.kind === "selection.candidate"
      && response.payload?.selectionId === "selection-generic")).toBe(true);

    decoration.dispatchEvent(new run.window.MouseEvent("pointerout", {
      bubbles: true,
      composed: true,
      relatedTarget: null,
    }));
    expect(run.internalResponses.some((response) => response.kind === "selection.candidate.cleared"
      && response.payload?.selectionId === "selection-generic")).toBe(true);

    await run.hover(decoration);
    decoration.dispatchEvent(new run.window.MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(run.result("selection-generic")).toMatchObject({ tag: "span" });
  });

  it("cancels safely when a dynamic candidate disappears before confirmation", async () => {
    const run = createRun("<button>Temporary action</button>");
    const button = run.document.querySelector("button")!;
    run.rect(button, { x: 10, y: 10, width: 140, height: 30 });
    run.start("selection-removed");
    await run.hover(button);
    button.remove();
    run.document.dispatchEvent(new run.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));

    expect(run.message("selection.result", "selection-removed")).toBeNull();
    expect(run.message("selection.cancelled", "selection-removed")?.payload).toEqual({
      selectionId: "selection-removed",
      reason: "invalid_selection",
    });
  });
});

function createRun(html: string, url = "https://example.test/article") {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, {
    url,
    pretendToBeVisual: true,
    runScripts: "outside-only",
  });
  openDoms.push(dom);
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
  window.eval(`let __KEYDEX_BRIDGE_DIAGNOSTICS_POST__ = null;\n${bridgeSource.replace("__KEYDEX_BRIDGE_BOOTSTRAP__", JSON.stringify({
    panelId: "panel-1",
    surfaceId: "surface-1",
    generation: 2,
  }))}`);
  const internalResponses: Array<{ kind: string; payload?: Record<string, unknown> }> = [];
  window.document.addEventListener("keydex:web-annotation-response", (event) => {
    const detail = (event as CustomEvent).detail;
    if (detail && typeof detail === "object") internalResponses.push(detail);
  });
  window.eval(elementSource);
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
      payload: { selectionId, mode: "element" },
    };
    for (const listener of nativeListeners) listener({ data: envelope });
  };
  const rect = (element: Element, value: { x: number; y: number; width: number; height: number }) => {
    Object.defineProperty(element, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ ...value, left: value.x, top: value.y, right: value.x + value.width, bottom: value.y + value.height }),
    });
  };
  const hover = async (element: Element) => {
    element.dispatchEvent(new window.MouseEvent("pointermove", { bubbles: true, composed: true }));
    await new Promise<void>((resolveFrame) => window.requestAnimationFrame(() => resolveFrame()));
  };
  const message = <K extends BrowserBridgeEnvelope["kind"]>(kind: K, requestId: string) =>
    (messages.find((envelope) => envelope.kind === kind && envelope.requestId === requestId) ?? null) as BrowserBridgeEnvelope<K> | null;
  const result = (requestId: string): WebElementTarget => {
    const envelope = message("selection.result", requestId);
    expect(envelope).not.toBeNull();
    return (envelope as BrowserBridgeEnvelope<"selection.result">).payload.target as WebElementTarget;
  };
  return { window, document: window.document, messages, internalResponses, start, rect, hover, message, result };
}
