import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";

import {
  parseBrowserBridgeEnvelope,
  type BrowserBridgeEnvelope,
  type WebTextTarget,
} from "../src/renderer/features/browser/runtime";

const bridgeSource = readFileSync(resolve(
  process.cwd(), "src-tauri", "src", "browser", "page_bridge.js",
), "utf8");
const textSource = readFileSync(resolve(
  process.cwd(), "src-tauri", "src", "browser", "page_bridge_text.js",
), "utf8");
const openDoms: JSDOM[] = [];
type DOMWindow = JSDOM["window"];

afterEach(() => {
  for (const dom of openDoms.splice(0)) dom.window.close();
});

describe("page bridge structured text selection", () => {
  it("uses logical position and heading context to disambiguate repeated text", () => {
    const run = createRun("<h1>Guide</h1><p>repeat target</p><h2>Details</h2><p>repeat target</p>");
    const paragraphs = run.document.querySelectorAll("p");
    const text = paragraphs[1].firstChild!;
    run.select(text, 7, text, 13);
    run.startAndCommit("selection-repeat");

    const target = run.result("selection-repeat");
    expect(target.quote).toEqual(expect.objectContaining({ exact: "target" }));
    expect(target.position!.start).toBeGreaterThan("Guiderepeat targetDetails".length);
    expect(target.position).toEqual(expect.objectContaining({ textModelVersion: 1 }));
    expect(target.context.headingPath).toEqual(["Guide", "Details"]);
    expect(target.context.containerRole).toBe("paragraph");
    expect(target.domRange!.startPath.length).toBeGreaterThan(0);
  });

  it("captures one exact range across text nodes and preserves UTF-16-safe context", () => {
    const prefix = "😀".repeat(160);
    const suffix = "👋".repeat(160);
    const run = createRun(`<p>${prefix}<strong>cross</strong><em> node</em> target${suffix}</p>`);
    const paragraph = run.document.querySelector("p")!;
    const start = paragraph.firstChild!;
    const end = paragraph.lastChild!;
    run.select(start, start.nodeValue!.length - 4, end, " target".length);
    run.startAndCommit("selection-cross");

    const target = run.result("selection-cross");
    expect(target.quote.exact).toBe("😀😀cross node target");
    expect(target.quote.prefix.length).toBeLessThanOrEqual(256);
    expect(target.quote.suffix.length).toBeLessThanOrEqual(256);
    expect(target.quote.prefix.endsWith("\uD83D")).toBe(false);
    expect(target.quote.suffix.startsWith("\uDC4B")).toBe(false);
    expect(target.domRange!.startPath).not.toEqual(target.domRange!.endPath);
  });

  it("excludes hidden/script/style/form text and never serializes password values", () => {
    const run = createRun(`
      <h1>Safe</h1>
      <p><span>visible </span><span style="display:none">hidden-secret</span><script>script-secret</script><style>.secret{}</style><span>target</span></p>
      <input type="password" value="password-secret">
    `);
    const visible = run.document.querySelector("p span:first-child")!.firstChild!;
    const targetNode = run.document.querySelector("p span:last-child")!.firstChild!;
    run.select(visible, 0, targetNode, targetNode.nodeValue!.length);
    run.startAndCommit("selection-safe");

    const target = run.result("selection-safe");
    expect(target.quote.exact).toBe("visible target");
    expect(JSON.stringify(target)).not.toMatch(/hidden-secret|script-secret|password-secret|\.secret/);
    expect(target.rects).toEqual([{ x: 10, y: 20, width: 120, height: 24 }]);
  });

  it("rejects collapsed selections and drops commits after page navigation", () => {
    const collapsed = createRun("<p>target</p>");
    const text = collapsed.document.querySelector("p")!.firstChild!;
    collapsed.select(text, 2, text, 2);
    collapsed.startAndCommit("selection-collapsed");
    expect(collapsed.message("selection.cancelled", "selection-collapsed")?.payload).toEqual({
      selectionId: "selection-collapsed",
      reason: "invalid_selection",
    });
    expect(collapsed.message("selection.result", "selection-collapsed")).toBeNull();

    const whitespace = createRun("<p>   </p>");
    const whitespaceText = whitespace.document.querySelector("p")!.firstChild!;
    whitespace.select(whitespaceText, 0, whitespaceText, 3);
    whitespace.startAndCommit("selection-whitespace");
    expect(whitespace.message("selection.result", "selection-whitespace")).toBeNull();

    const overlong = createRun(`<p>${"x".repeat(8193)}</p>`);
    const overlongText = overlong.document.querySelector("p")!.firstChild!;
    overlong.select(overlongText, 0, overlongText, overlongText.nodeValue!.length);
    overlong.startAndCommit("selection-overlong");
    expect(overlong.message("selection.result", "selection-overlong")).toBeNull();

    const navigation = createRun("<p>target</p>");
    const navigationText = navigation.document.querySelector("p")!.firstChild!;
    navigation.select(navigationText, 0, navigationText, 6);
    navigation.start("selection-navigation");
    navigation.window.dispatchEvent(new navigation.window.PageTransitionEvent("pagehide"));
    navigation.commit();
    expect(navigation.message("selection.result", "selection-navigation")).toBeNull();
  });

  it("persists frame URL/name/index path without runtime frame IDs", () => {
    const top = new JSDOM("<!doctype html><body><iframe name='article-frame'></iframe></body>", {
      url: "https://example.test/",
      pretendToBeVisual: true,
      runScripts: "outside-only",
    });
    openDoms.push(top);
    const frame = top.window.document.querySelector("iframe")!;
    const frameWindow = frame.contentWindow!;
    frameWindow.name = "article-frame";
    frameWindow.document.body.innerHTML = "<p>frame target</p>";
    const run = installRun(frameWindow as DOMWindow, "https://example.test/frame");
    const text = frameWindow.document.querySelector("p")!.firstChild!;
    run.select(text, 6, text, 12);
    run.startAndCommit("selection-frame");

    const target = run.result("selection-frame");
    expect(target.frame.indexPath).toEqual([0]);
    expect(target.frame.name).toBe("article-frame");
    expect(target.frame.url).toBe("about:blank");
    expect(JSON.stringify(target.frame)).not.toContain("runtime");
  });
});

function createRun(html: string) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, {
    url: "https://example.test/article",
    pretendToBeVisual: true,
    runScripts: "outside-only",
  });
  openDoms.push(dom);
  return installRun(dom.window, "https://example.test/article");
}

function installRun(window: DOMWindow, _url: string) {
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
  const rendered = bridgeSource.replace("__KEYDEX_BRIDGE_BOOTSTRAP__", JSON.stringify({
    panelId: "panel-1",
    surfaceId: "surface-1",
    generation: 2,
  }));
  window.eval(rendered);
  window.eval(textSource);
  const metadata = (window as unknown as {
    KeydexAnnotationBridge: { navigationId: string; frameKey: string };
  }).KeydexAnnotationBridge;
  let hostSequence = 0;

  const send = (kind: "selection.start" | "selection.cancel", requestId: string, payload: Record<string, unknown>) => {
    const envelope = {
      protocol: "keydex.web-annotation.v1",
      kind,
      panelId: "panel-1",
      surfaceId: "surface-1",
      generation: 2,
      navigationId: metadata.navigationId,
      frameKey: metadata.frameKey,
      requestId,
      sequence: ++hostSequence,
      payload,
    };
    for (const listener of nativeListeners) listener({ data: envelope });
  };
  const select = (start: Node, startOffset: number, end: Node, endOffset: number) => {
    const range = window.document.createRange();
    range.setStart(start, startOffset);
    range.setEnd(end, endOffset);
    Object.defineProperty(range, "getClientRects", {
      configurable: true,
      value: () => [{ x: 10, y: 20, left: 10, top: 20, width: 120, height: 24 }],
    });
    Object.defineProperty(range, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ x: 10, y: 20, left: 10, top: 20, width: 120, height: 24 }),
    });
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  };
  const start = (selectionId: string) => send("selection.start", selectionId, { selectionId, mode: "text" });
  const commit = () => window.document.dispatchEvent(new window.Event("pointerup", { bubbles: true }));
  const message = <K extends BrowserBridgeEnvelope["kind"]>(kind: K, requestId: string) =>
    (messages.find((envelope) => envelope.kind === kind && envelope.requestId === requestId) ?? null) as BrowserBridgeEnvelope<K> | null;
  const result = (requestId: string): WebTextTarget => {
    const envelope = message("selection.result", requestId);
    expect(envelope).not.toBeNull();
    return (envelope as BrowserBridgeEnvelope<"selection.result">).payload.target as WebTextTarget;
  };
  return {
    window,
    document: window.document,
    messages,
    select,
    start,
    commit,
    startAndCommit(selectionId: string) {
      start(selectionId);
      commit();
    },
    message,
    result,
  };
}
