import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";

import scoringPolicy from "../src/renderer/features/browser/annotations/anchoring/scoringPolicyV1.json";
import {
  parseBrowserBridgeEnvelope,
  type BrowserBridgeEnvelope,
  type WebAnnotationPageResolutionEvidence,
  type WebElementTarget,
} from "../src/renderer/features/browser/runtime";

const bridgeSource = readFileSync(resolve(process.cwd(), "src-tauri", "src", "browser", "page_bridge.js"), "utf8");
const elementSource = readFileSync(resolve(process.cwd(), "src-tauri", "src", "browser", "page_bridge_element.js"), "utf8");
const openDoms: JSDOM[] = [];
type DOMWindow = JSDOM["window"];

afterEach(() => {
  for (const dom of openDoms.splice(0)) dom.window.close();
});

describe("page bridge semantic element resolver", () => {
  it("prefers a stable DOM path and returns a fresh semantic target", () => {
    const run = createRun("<button id='save'>Save</button>");
    const button = run.document.querySelector("button")!;
    run.rect(button, 10, 20, 120, 32);
    const original = run.select(button);

    const result = run.resolve(original);

    expect(result.payload).toMatchObject({
      status: "resolved",
      target: { tag: "button", role: "button", accessibleName: "Save" },
      evidence: { strategy: "stable_dom_path", changedSignals: [] },
    });
  });

  it("recovers a reparented element by unique id", () => {
    const run = createRun("<button id='save'>Save</button>");
    const originalButton = run.document.querySelector("button")!;
    run.rect(originalButton, 10, 20, 120, 32);
    const original = run.select(originalButton);
    run.document.body.innerHTML = "<main><section><button id='save'>Save</button></section></main>";
    const current = run.document.querySelector("button")!;
    run.rect(current, 40, 60, 120, 32);

    const result = run.resolve(original);

    expect(result.payload).toMatchObject({
      status: "resolved",
      target: { stableAttributes: expect.arrayContaining([{ name: "id", value: "save" }]) },
      evidence: { strategy: "unique_id" },
    });
  });

  it("marks accessible-name and stable-attribute changes as changed", () => {
    const run = createRun("<button id='save'>Save</button>");
    const button = run.document.querySelector("button")!;
    run.rect(button, 10, 20, 120, 32);
    const original = run.select(button);
    button.id = "store";
    button.textContent = "Store changes";

    const result = run.resolve(original);
    const evidence = result.payload.evidence as WebAnnotationPageResolutionEvidence;

    expect(result.payload).toMatchObject({
      status: "changed",
      target: { accessibleName: "Store changes" },
      evidence: { strategy: "stable_dom_path" },
    });
    expect(evidence.changedSignals).toEqual(expect.arrayContaining([
      "accessible_name_changed",
      "stable_attributes_changed",
    ]));
  });

  it("keeps duplicate controls ambiguous and exposes only minimal candidate summaries", () => {
    const run = createRun("<button>Open</button>");
    const originalButton = run.document.querySelector("button")!;
    run.rect(originalButton, 10, 20, 120, 32);
    const original = run.select(originalButton);
    run.document.body.innerHTML = "<div><button>Open</button><button>Open</button></div>";
    const buttons = run.document.querySelectorAll("button");
    run.rect(buttons[0], 10, 20, 120, 32);
    run.rect(buttons[1], 10, 80, 120, 32);
    run.rect(run.document.querySelector("div")!, 5, 10, 150, 120);

    const result = run.resolve(original);
    const evidence = result.payload.evidence as WebAnnotationPageResolutionEvidence;

    expect(result.payload.status).toBe("ambiguous");
    expect(result.payload.target).toBeUndefined();
    expect(result.payload.candidateIds).toHaveLength(2);
    expect(evidence.candidateSummaries).toEqual([
      expect.objectContaining({ label: "Open", tag: "button", role: "button" }),
      expect.objectContaining({ label: "Open", tag: "button", role: "button" }),
    ]);
    expect(JSON.stringify(evidence.candidateSummaries)).not.toMatch(/outerHTML|value|data-|stableAttributes/);
  });

  it("recovers images, cards, and table cells through semantic stages", () => {
    const imageRun = createRun("<img alt='Diagram' src='https://cdn.example.test/a.png?token=secret'>");
    const originalImage = imageRun.document.querySelector("img")!;
    imageRun.rect(originalImage, 10, 20, 160, 90);
    const imageTarget = imageRun.select(originalImage);
    imageRun.document.body.innerHTML = "<figure><img alt='Diagram' src='https://cdn.example.test/a.png?new=secret'></figure>";
    const currentImage = imageRun.document.querySelector("img")!;
    imageRun.rect(currentImage, 30, 40, 160, 90);
    expect(imageRun.resolve(imageTarget).payload).toMatchObject({
      status: "resolved",
      evidence: { strategy: "image_src_alt" },
    });

    const cardRun = createRun("<article aria-label='Release card'>Details</article>");
    const originalCard = cardRun.document.querySelector("article")!;
    cardRun.rect(originalCard, 10, 20, 240, 120);
    const cardTarget = cardRun.select(originalCard);
    cardRun.document.body.innerHTML = "<main><article aria-label='Release card'>Details</article></main>";
    cardRun.rect(cardRun.document.querySelector("article")!, 40, 60, 240, 120);
    expect(cardRun.resolve(cardTarget).payload).toMatchObject({
      status: "resolved",
      evidence: { strategy: "role_name" },
    });

    const tableRun = createRun("<table><tbody><tr><td>42</td></tr></tbody></table>");
    const originalCell = tableRun.document.querySelector("td")!;
    tableRun.rect(originalCell, 10, 20, 80, 30);
    const cellTarget = tableRun.select(originalCell);
    tableRun.document.body.innerHTML = "<section><table><tbody><tr><td>42</td></tr></tbody></table></section>";
    tableRun.rect(tableRun.document.querySelector("td")!, 30, 50, 80, 30);
    expect(tableRun.resolve(cellTarget).payload).toMatchObject({
      status: "resolved",
      target: { tag: "td", role: "cell", accessibleName: "42" },
      evidence: { strategy: "role_name" },
    });
  });

  it("never resolves from geometry alone and does not serialize form values", () => {
    const run = createRun("<button aria-label='Submit'>Submit</button>");
    const originalButton = run.document.querySelector("button")!;
    run.rect(originalButton, 10, 20, 120, 32);
    const original = run.select(originalButton);
    run.document.body.innerHTML = "<input value='password-secret' data-token='secret'><div>Unrelated</div>";
    const input = run.document.querySelector("input")!;
    const div = run.document.querySelector("div")!;
    run.rect(input, 10, 20, 120, 32);
    run.rect(div, 10, 20, 120, 32);

    const result = run.resolve(original);

    expect(result.payload.status).toBe("orphaned");
    expect(JSON.stringify(result.payload)).not.toMatch(/password-secret|data-token|secret/);
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
    scoringPolicy,
  })));
  window.eval(elementSource);
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
  const select = (element: Element): WebElementTarget => {
    const requestId = `selection-${++requestSequence}`;
    send("selection.start", requestId, { selectionId: requestId, mode: "element" });
    element.dispatchEvent(new window.MouseEvent("click", { bubbles: true, composed: true, cancelable: true }));
    const result = message("selection.result", requestId);
    if (!result) throw new Error("Expected selection result");
    return result.payload.target as WebElementTarget;
  };
  const resolveTarget = (target: WebElementTarget) => {
    const requestId = `resolve-${++requestSequence}`;
    send("annotation.resolve", requestId, { annotationId: "annotation-1", target });
    const result = message("resolution.result", requestId);
    if (!result) throw new Error("Expected resolution result");
    return result;
  };
  return { window, document: window.document, rect, select, resolve: resolveTarget };
}
