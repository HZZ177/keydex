import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";

import scoringPolicy from "../src/renderer/features/browser/annotations/anchoring/scoringPolicyV1.json";
import {
  parseBrowserBridgeEnvelope,
  type BrowserBridgeEnvelope,
  type WebAnnotationPageResolutionEvidence,
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

describe("page bridge semantic region resolver", () => {
  it("maps a region by relative proportions when its semantic anchor moves and resizes", async () => {
    const run = createRun("<article id='card' aria-label='Release card'>Release notes</article>");
    const article = run.document.querySelector("article")!;
    run.rect(article, 80, 90, 260, 180);
    const original = await run.select(article, { x: 100, y: 110 }, { x: 300, y: 230 });
    run.rect(article, 160, 180, 520, 360);

    const result = run.resolve(original);
    const evidence = result.payload.evidence as WebAnnotationPageResolutionEvidence;

    expect(result.payload).toMatchObject({
      status: "changed",
      target: { rect: { x: 200, y: 220, width: 400, height: 240 } },
      evidence: { strategy: "relative_region" },
    });
    expect(evidence.changedSignals).toEqual(expect.arrayContaining([
      "anchor_position_changed",
      "anchor_size_changed",
    ]));
  });

  it("recovers a reflowed semantic anchor and explains a local fingerprint change", async () => {
    const run = createRun("<article id='card' aria-label='Release card'>Release notes</article>");
    const originalElement = run.document.querySelector("article")!;
    run.rect(originalElement, 80, 90, 260, 180);
    const original = await run.select(originalElement, { x: 100, y: 110 }, { x: 300, y: 230 });
    run.document.body.innerHTML = "<main><section><article id='card' aria-label='Release card'>Updated release notes</article></section></main>";
    const current = run.document.querySelector("article")!;
    run.rect(current, 180, 70, 260, 180);

    const result = run.resolve(original);
    const evidence = result.payload.evidence as WebAnnotationPageResolutionEvidence;

    expect(result.payload).toMatchObject({
      status: "changed",
      target: { relativeElement: { accessibleName: "Release card" } },
      evidence: { strategy: "region_semantic_search" },
    });
    expect(evidence.changedSignals).toEqual(expect.arrayContaining([
      "anchor_position_changed",
      "anchor_text_changed",
      "local_fingerprint_changed",
    ]));
  });

  it("keeps similar regions ambiguous and returns only minimal candidate summaries", async () => {
    const run = createRun("<article aria-label='Release card'>Release notes</article>");
    const originalElement = run.document.querySelector("article")!;
    run.rect(originalElement, 80, 90, 260, 180);
    const original = await run.select(originalElement, { x: 100, y: 110 }, { x: 300, y: 230 });
    run.document.body.innerHTML = [
      "<main>",
      "<article aria-label='Release card'>Release notes</article>",
      "<article aria-label='Release card'>Release notes</article>",
      "</main>",
    ].join("");
    const candidates = run.document.querySelectorAll("article");
    run.rect(candidates[0], 80, 90, 260, 180);
    run.rect(candidates[1], 80, 310, 260, 180);

    const result = run.resolve(original);
    const evidence = result.payload.evidence as WebAnnotationPageResolutionEvidence;

    expect(result.payload.status).toBe("ambiguous");
    expect(result.payload.target).toBeUndefined();
    expect(result.payload.candidateIds).toHaveLength(2);
    expect(evidence.candidateSummaries).toEqual([
      expect.objectContaining({ label: "Release card", tag: "article", role: "article" }),
      expect.objectContaining({ label: "Release card", tag: "article", role: "article" }),
    ]);
    expect(JSON.stringify(evidence.candidateSummaries)).not.toMatch(/outerHTML|stableAttributes|localDigest|data-/);
  });

  it("never auto-resolves a coordinate-only region even when a pHash is available", async () => {
    const run = createRun("<article>Release notes</article>");
    const article = run.document.querySelector("article")!;
    run.rect(article, 80, 90, 260, 180);
    const selected = await run.select(article, { x: 100, y: 110 }, { x: 300, y: 230 });
    const coordinateOnly: WebRegionTarget = {
      ...selected,
      relativeElement: undefined,
      visual: {
        ...selected.visual!,
        perceptualHash: "dhash64:0123456789abcdef",
      },
    };

    const result = run.resolve(coordinateOnly);

    expect(result.payload).toMatchObject({
      status: "orphaned",
      evidence: {
        strategy: "coordinate_only_region",
        changedSignals: ["perceptual_hash_available"],
      },
    });
    expect(result.payload.target).toBeUndefined();
  });

  it("uses CSS-pixel relative geometry across viewport and DPI-style scaling", async () => {
    const run = createRun("<article id='card'>Release notes</article>");
    const article = run.document.querySelector("article")!;
    run.rect(article, 80, 90, 260, 180);
    const original = await run.select(article, { x: 100, y: 110 }, { x: 300, y: 230 });
    run.viewport(1_200, 900);
    run.rect(article, 120, 135, 390, 270);

    const result = run.resolve(original);

    expect(result.payload).toMatchObject({
      status: "changed",
      target: {
        rect: { x: 150, y: 165, width: 300, height: 180 },
        viewport: { width: 1_200, height: 900 },
      },
    });
  });
});

function createRun(html: string) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, {
    url: "https://example.test/article",
    pretendToBeVisual: true,
    runScripts: "outside-only",
  });
  openDoms.push(dom);
  return installRun(dom.window);
}

function installRun(window: DOMWindow) {
  const messages: BrowserBridgeEnvelope[] = [];
  const nativeListeners = new Set<(event: { data: unknown }) => void>();
  let viewportWidth = 800;
  let viewportHeight = 600;
  Object.defineProperties(window.document.documentElement, {
    clientWidth: { configurable: true, get: () => viewportWidth },
    clientHeight: { configurable: true, get: () => viewportHeight },
  });
  Object.defineProperties(window, {
    innerWidth: { configurable: true, get: () => viewportWidth },
    innerHeight: { configurable: true, get: () => viewportHeight },
    chrome: {
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
    },
  });
  window.eval(bridgeSource.replace("__KEYDEX_BRIDGE_BOOTSTRAP__", JSON.stringify({
    panelId: "panel-1",
    surfaceId: "surface-1",
    generation: 2,
    scoringPolicy,
  })));
  window.eval(overlaySource);
  window.eval(regionSource);
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
  const rect = (element: Element, x: number, y: number, width: number, height: number) => {
    Object.defineProperty(element, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ x, y, width, height, left: x, top: y, right: x + width, bottom: y + height }),
    });
  };
  const hitTest = (element: Element) => {
    Object.defineProperty(window.document, "elementsFromPoint", {
      configurable: true,
      value: () => [element],
    });
  };
  const layer = () => {
    const root = window.document.querySelector("[data-keydex-annotation-overlay-root='true']");
    const value = root?.shadowRoot?.querySelector("[part='capture-layer']");
    if (!value) throw new Error("Expected region capture layer");
    return value;
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
  const select = async (
    element: Element,
    start: { x: number; y: number },
    end: { x: number; y: number },
  ): Promise<WebRegionTarget> => {
    const requestId = `selection-${++requestSequence}`;
    hitTest(element);
    send("selection.start", requestId, { selectionId: requestId, mode: "region" });
    pointer("pointerdown", start.x, start.y);
    pointer("pointermove", end.x, end.y);
    pointer("pointerup", end.x, end.y);
    await Promise.resolve();
    const result = message("selection.result", requestId);
    if (!result) throw new Error("Expected selection result");
    return result.payload.target as WebRegionTarget;
  };
  const resolveTarget = (target: WebRegionTarget) => {
    const requestId = `resolve-${++requestSequence}`;
    send("annotation.resolve", requestId, { annotationId: "annotation-1", target });
    const result = message("resolution.result", requestId);
    if (!result) throw new Error("Expected resolution result");
    return result;
  };
  return {
    window,
    document: window.document,
    rect,
    select,
    resolve: resolveTarget,
    viewport(width: number, height: number) {
      viewportWidth = width;
      viewportHeight = height;
    },
  };
}
