import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";

import scoringPolicy from "../src/renderer/features/browser/annotations/anchoring/scoringPolicyV1.json";
import {
  parseBrowserBridgeEnvelope,
  type BrowserBridgeEnvelope,
  type WebAnnotationPageResolutionEvidence,
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

describe("page bridge text resolver", () => {
  it("keeps repeated text attached to the exact selected container in the current document", () => {
    const run = createRun("<section><p>target</p></section>");
    const selection = run.selectTextWithBinding("target");
    const duplicate = run.document.createElement("section");
    duplicate.innerHTML = "<p>target</p>";
    run.document.body.prepend(duplicate);

    const result = run.resolve(selection.target, selection.binding);

    expect(result.payload).toMatchObject({
      status: "resolved",
      evidence: { strategy: "node_handle", binding: selection.binding },
    });
    expect((result.payload.target as WebTextTarget).position?.start).toBe(6);
  });

  it("prefers a valid DOM Range and returns current quote, rects, and evidence", () => {
    const run = createRun("<h1>Guide</h1><p>prefix target suffix</p>");
    const original = run.selectText("target");

    const result = run.resolve(original);

    expect(result.payload).toMatchObject({
      status: "resolved",
      target: { quote: { exact: "target" }, rects: [{ x: 10, y: 20, width: 120, height: 24 }] },
      evidence: {
        strategy: "dom_range",
        currentQuote: "target",
        candidateCount: 1,
        truncated: false,
      },
    });
  });

  it("falls through stale DOM/position anchors and keeps context-only drift resolved", () => {
    const run = createRun("<h1>Guide</h1><p>prefix target suffix</p>");
    const original = run.selectText("target");
    run.document.body.innerHTML = "<h1>Guide</h1><div><span>Intro </span><p>prefix target suffix</p></div>";

    const result = run.resolve(original);

    expect(result.payload).toMatchObject({
      status: "resolved",
      target: { quote: { exact: "target" } },
      evidence: {
        strategy: "exact_quote",
        currentQuote: "target",
        changedSignals: expect.arrayContaining(["prefix_changed"]),
      },
    });
  });

  it("marks a high-scoring fuzzy match as changed", () => {
    const run = createRun("<h1>Guide</h1><p>prefix target suffix</p>");
    const original = run.selectText("target");
    run.document.body.innerHTML = "<h1>Guide</h1><div><p>prefix targat suffix</p></div>";

    const result = run.resolve(original);

    expect(result.payload).toMatchObject({
      status: "changed",
      target: { quote: { exact: "targat" } },
      evidence: { strategy: "fuzzy_quote", currentQuote: "targat" },
    });
    expect((result.payload.evidence as WebAnnotationPageResolutionEvidence).score).toBeGreaterThanOrEqual(
      scoringPolicy.acceptThreshold,
    );
  });

  it("returns bounded candidate ids for repeated and long dynamic text without auto-selecting", () => {
    const run = createRun("<p>target</p>");
    const original = run.selectText("target");
    run.document.body.innerHTML = `<p>intro ${Array.from({ length: 400 }, () => "target").join(" ")}</p>`;

    const result = run.resolve(original);

    expect(result.payload.status).toBe("ambiguous");
    expect(result.payload.target).toBeUndefined();
    expect(result.payload.candidateIds?.length).toBeLessThanOrEqual(20);
    expect(result.payload.evidence).toMatchObject({
      strategy: "exact_quote",
      truncated: true,
      rects: [],
    });
    expect((result.payload.evidence as WebAnnotationPageResolutionEvidence).candidateCount).toBeGreaterThan(1);
    expect((result.payload.evidence as WebAnnotationPageResolutionEvidence).candidateCount).toBeLessThanOrEqual(256);
  });

  it("returns orphaned for deleted text and for a frame locator that is not current", () => {
    const run = createRun("<p>target</p>");
    const original = run.selectText("target");
    run.document.body.innerHTML = "<p>nothing remains</p>";

    expect(run.resolve(original).payload).toMatchObject({
      status: "orphaned",
      evidence: { strategy: "fuzzy_quote", candidateCount: 0 },
    });
    expect(run.resolve({
      ...original,
      frame: { ...original.frame, url: "https://other.test/frame" },
    }).payload).toMatchObject({
      status: "orphaned",
      evidence: { strategy: "frame_unavailable", candidateCount: 0 },
    });
  });

  it("never scans hidden form values while resolving", () => {
    const run = createRun("<p>public target</p>");
    const original = run.selectText("target");
    run.document.body.innerHTML = "<input type='password' value='target'><textarea>target</textarea><p>public</p>";

    const result = run.resolve(original);

    expect(result.payload.status).toBe("orphaned");
    expect(JSON.stringify(result.payload)).not.toContain("password");
  });

  it("restores the selected local-file instance after a full page reload", () => {
    const url = "file:///D:/Keydex%20Fixtures/nested/annotation.html?mode=preview#section";
    const beforeReload = createRun(
      "<h1>本地指南</h1><p>重复文本</p><h2>详情</h2><p>重复文本 😀</p>",
      url,
    );
    const original = beforeReload.selectText("文本 😀");
    expect(original.frame).toEqual({ url, indexPath: [] });

    const afterReload = createRun(
      "<h1>本地指南</h1><p>重复文本</p><h2>详情</h2><p>重复文本 😀</p>",
      url,
    );
    const result = afterReload.resolve(original);

    expect(result.payload).toMatchObject({
      status: "resolved",
      target: {
        type: "text",
        quote: { exact: "文本 😀" },
        position: {
          start: original.position?.start,
          end: original.position?.end,
          textModelVersion: 1,
        },
        context: {
          headingPath: ["本地指南", "详情"],
          containerRole: "paragraph",
        },
        rects: [{ x: 10, y: 20, width: 120, height: 24 }],
        frame: { url, indexPath: [] },
      },
      evidence: {
        strategy: "dom_range",
        currentQuote: "文本 😀",
        candidateCount: 1,
        truncated: false,
      },
    });
  });

  it("fails closed when a persisted file target is resolved by an HTTP page", () => {
    const local = createRun("<p>target</p>", "file:///D:/Keydex%20Fixtures/annotation.html");
    const original = local.selectText("target");
    const remote = createRun("<p>target</p>");

    expect(remote.resolve(original).payload).toMatchObject({
      status: "orphaned",
      evidence: {
        strategy: "frame_unavailable",
        candidateCount: 0,
      },
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
  Object.defineProperties(window.Range.prototype, {
    getClientRects: {
      configurable: true,
      value: () => [{ x: 10, y: 20, left: 10, top: 20, width: 120, height: 24 }],
    },
    getBoundingClientRect: {
      configurable: true,
      value: () => ({ x: 10, y: 20, left: 10, top: 20, width: 120, height: 24 }),
    },
  });
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
    scoringPolicy,
  }));
  window.eval(`let __KEYDEX_BRIDGE_DIAGNOSTICS_POST__ = null;\n${rendered}`);
  window.eval(textSource);
  const metadata = (window as unknown as {
    KeydexAnnotationBridge: { navigationId: string; frameKey: string };
  }).KeydexAnnotationBridge;
  let hostSequence = 0;
  let requestSequence = 0;

  const send = (kind: "selection.start" | "annotation.resolve", requestId: string, payload: Record<string, unknown>) => {
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
  const message = <K extends BrowserBridgeEnvelope["kind"]>(kind: K, requestId: string) =>
    (messages.find((envelope) => envelope.kind === kind && envelope.requestId === requestId) ?? null) as BrowserBridgeEnvelope<K> | null;
  const selectTextWithBinding = (value: string) => {
    const walker = window.document.createTreeWalker(window.document.body, window.NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node && !node.nodeValue?.includes(value)) node = walker.nextNode();
    if (!node?.nodeValue) throw new Error(`Text not found: ${value}`);
    const start = node.nodeValue.indexOf(value);
    const range = window.document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + value.length);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const requestId = `selection-${++requestSequence}`;
    send("selection.start", requestId, { selectionId: requestId, mode: "text" });
    window.document.dispatchEvent(new window.Event("pointerup", { bubbles: true }));
    const result = message("selection.result", requestId);
    if (!result) throw new Error("Expected selection result");
    if (!result.payload.binding) throw new Error("Expected live node binding");
    return {
      target: result.payload.target as WebTextTarget,
      binding: result.payload.binding,
    };
  };
  const selectText = (value: string): WebTextTarget => selectTextWithBinding(value).target;
  const resolveTarget = (
    target: WebTextTarget,
    binding?: BrowserBridgeEnvelope<"selection.result">["payload"]["binding"],
  ) => {
    const requestId = `resolve-${++requestSequence}`;
    send("annotation.resolve", requestId, {
      annotationId: "annotation-1",
      target,
      ...(binding ? { binding } : {}),
    });
    const result = message("resolution.result", requestId);
    if (!result) throw new Error("Expected resolution result");
    return result;
  };
  return {
    window,
    document: window.document,
    selectText,
    selectTextWithBinding,
    resolve: resolveTarget,
  };
}
