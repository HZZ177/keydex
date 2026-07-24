import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  parseBrowserBridgeEnvelope,
  type BrowserBridgeEnvelope,
} from "../src/renderer/features/browser/runtime";

const bridgeSource = readFileSync(resolve(process.cwd(), "src-tauri", "src", "browser", "page_bridge.js"), "utf8");
const overlaySource = readFileSync(resolve(process.cwd(), "src-tauri", "src", "browser", "page_bridge_overlay.js"), "utf8");
const devtoolsElementTargetSource = readFileSync(
  resolve(process.cwd(), "src-tauri", "src", "browser", "devtools_element_target.js"),
  "utf8",
);
const openDoms: JSDOM[] = [];
type DOMWindow = JSDOM["window"];

afterEach(() => {
  for (const dom of openDoms.splice(0)) dom.window.close();
});

describe("page bridge themed overlay", () => {
  it("reports native page pointer interaction while ignoring its own annotation overlay", () => {
    const run = createRun("<button id='page-action'>Page action</button>");
    const countInteractions = () => run.messages.filter((message) => message.kind === "page.interaction").length;

    run.document.querySelector("#page-action")?.dispatchEvent(new run.window.MouseEvent("pointerdown", {
      bubbles: true,
    }));
    expect(countInteractions()).toBe(1);

    run.configure("light", false);
    run.send("highlight.render", "highlight-interaction", {
      annotationId: "annotation-interaction",
      state: "resolved",
      target: elementTarget(documentPath(0), { x: 24, y: 40, width: 180, height: 36 }),
    });
    run.root().dispatchEvent(new run.window.MouseEvent("pointerdown", { bubbles: true }));
    expect(countInteractions()).toBe(1);
  });

  it("isolates its styles, applies controlled light/dark tokens, and honors reduced motion", () => {
    const run = createRun(`
      <style>div { all: unset !important; background: red !important; z-index: 1 !important; }</style>
      <button id="page-action">Page action</button>
    `);
    const pageButton = run.document.querySelector<HTMLButtonElement>("#page-action")!;
    pageButton.focus();

    run.configure("dark", true);
    run.send("selection.start", "selection-theme", { selectionId: "selection-theme", mode: "element" });
    const root = run.root();
    const status = root.shadowRoot?.querySelector<HTMLElement>("[part='status']");

    expect(root.getAttribute("data-keydex-overlay-theme")).toBe("dark");
    expect(root.getAttribute("data-reduced-motion")).toBe("true");
    expect(root.style.zIndex).toBe("2147483647");
    expect(root.style.pointerEvents).toBe("none");
    expect(root.style.getPropertyValue("--keydex-overlay-accent")).toBe("rgb(255, 121, 198)");
    expect(root.style.getPropertyValue("--keydex-overlay-motion")).toBe("0ms");
    expect(status?.getAttribute("role")).toBe("status");
    expect(status?.getAttribute("aria-live")).toBe("polite");
    expect(status?.textContent).toContain("Tab");
    expect(run.document.activeElement).toBe(pageButton);

    run.configure("light", false);
    expect(root.getAttribute("data-keydex-overlay-theme")).toBe("light");
    expect(root.getAttribute("data-reduced-motion")).toBe("false");
    expect(root.style.getPropertyValue("--keydex-overlay-accent")).toBe("rgb(22, 119, 255)");
    expect(root.style.getPropertyValue("--keydex-overlay-motion")).toBe("140ms");
  });

  it("renders multiple rects and resolution states without writing wrappers into page content", () => {
    const run = createRun("<article id='content'>Original page text</article>");
    run.configure("light", false);
    run.send("highlight.render", "highlight-text", {
      annotationId: "annotation-text",
      state: "changed",
      target: textTarget([
        { x: 20, y: 30, width: 90, height: 18 },
        { x: 20, y: 50, width: 140, height: 18 },
      ]),
    });

    const root = run.root();
    const markers = root.shadowRoot?.querySelectorAll("[part='annotation-highlight']") ?? [];
    expect(markers).toHaveLength(2);
    expect(Array.from(markers).every((marker) => marker.getAttribute("data-state") === "changed")).toBe(true);
    expect(root.getAttribute("data-highlight-count")).toBe("2");
    expect(run.document.querySelector("#content")?.childNodes).toHaveLength(1);
    expect(run.document.querySelector("mark")).toBeNull();

    run.send("highlight.clear", "highlight-clear", { annotationIds: ["annotation-text"] });
    expect(run.document.querySelector("[data-keydex-annotation-overlay-root='true']")).toBeNull();
  });

  it("opens annotation content from a clickable highlight and requests adding it to the Agent composer", () => {
    const run = createRun("<article>Page content</article>");
    run.configure("light", false);
    run.send("highlight.render", "highlight-action-request", {
      annotationId: "annotation-action",
      state: "resolved",
      bodyMarkdown: "请让 Agent 检查这个区域。",
      target: elementTarget(documentPath(0), { x: 24, y: 40, width: 180, height: 36 }),
    });

    const marker = run.marker("annotation-action");
    expect(marker?.getAttribute("role")).toBe("button");
    marker?.click();

    const popover = run.root().shadowRoot?.querySelector<HTMLElement>("[part='annotation-highlight-popover']");
    expect(popover?.textContent).toContain("请让 Agent 检查这个区域。");
    popover?.querySelector<HTMLButtonElement>("[aria-label='将网页批注发送给 Agent']")?.click();
    expect(run.message("highlight.action", "highlight-action-request")?.payload).toEqual({
      annotationId: "annotation-action",
      action: "add_to_composer",
    });
    expect(run.root().shadowRoot?.querySelector("[part='annotation-highlight-popover']")).toBeNull();
  });

  it("requires inline confirmation before requesting deletion from the annotation popover", () => {
    const run = createRun("<article>Page content</article>");
    run.configure("light", false);
    run.send("highlight.render", "highlight-delete-request", {
      annotationId: "annotation-delete",
      state: "resolved",
      bodyMarkdown: "删除这条批注。",
      target: elementTarget(documentPath(0), { x: 24, y: 40, width: 180, height: 36 }),
    });

    run.marker("annotation-delete")?.click();
    const popover = run.root().shadowRoot?.querySelector<HTMLElement>("[part='annotation-highlight-popover']");
    const remove = popover?.querySelector<HTMLButtonElement>("[aria-label='删除网页批注']");
    remove?.click();

    expect(run.message("highlight.action", "highlight-delete-request")).toBeNull();
    expect(remove?.textContent).toBe("确认删除");
    remove?.click();
    expect(run.message("highlight.action", "highlight-delete-request")?.payload).toEqual({
      annotationId: "annotation-delete",
      action: "delete_annotation",
    });
    expect(run.root().shadowRoot?.querySelector("[part='annotation-highlight-popover']")).toBeNull();
  });

  it("recognizes a native-inspected annotation marker and resumes selection after its popover closes", () => {
    const run = createRun("<article>Page content</article>");
    run.configure("light", false);
    run.send("highlight.render", "highlight-native-existing", {
      annotationId: "annotation-native-existing",
      state: "resolved",
      bodyMarkdown: "已有批注内容",
      target: elementTarget(documentPath(0), { x: 24, y: 40, width: 180, height: 36 }),
    });
    const marker = run.marker("annotation-native-existing")!;
    const serializeTarget = run.window.eval(`(${devtoolsElementTargetSource})`) as (
      this: Element,
    ) => Record<string, unknown>;

    expect(serializeTarget.call(marker)).toEqual({
      keydexOverlayAction: "open_existing_annotation",
      annotationId: "annotation-native-existing",
    });
    const overlayApi = (run.window as unknown as {
      KeydexAnnotationOverlay: { openNativeHighlight(annotationId: string): boolean };
    }).KeydexAnnotationOverlay;
    expect(overlayApi.openNativeHighlight("annotation-native-existing")).toBe(true);
    expect(run.root().shadowRoot?.querySelector("[part='annotation-highlight-popover']")).not.toBeNull();

    run.root().shadowRoot
      ?.querySelector<HTMLButtonElement>("[aria-label='关闭批注内容']")
      ?.click();
    expect(run.message("highlight.action", "highlight-native-existing")?.payload).toEqual({
      annotationId: "annotation-native-existing",
      action: "resume_selection",
    });
  });

  it("persists native-inspected local-file targets with their real frame URL", () => {
    const url = "file:///D:/Keydex%20Fixtures/forms.html";
    const run = createRun(
      "<a id='next' href='./next.html?token=secret#section'>Next page</a>",
      url,
    );
    const link = run.document.querySelector("a")!;
    Object.defineProperty(link, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        x: 24,
        y: 40,
        left: 24,
        top: 40,
        right: 184,
        bottom: 76,
        width: 160,
        height: 36,
      }),
    });
    const serializeTarget = run.window.eval(`(${devtoolsElementTargetSource})`) as (
      this: Element,
    ) => Record<string, unknown>;

    expect(serializeTarget.call(link)).toMatchObject({
      type: "element",
      tag: "a",
      stableAttributes: expect.arrayContaining([
        { name: "href", value: "file:///D:/Keydex%20Fixtures/next.html" },
      ]),
      frame: { url, indexPath: [] },
    });
  });

  it("draws selection candidates, keeps the page non-interactive, and clears after terminal selection", () => {
    const run = createRun("<button id='save'>Save changes</button>");
    run.configure("light", false);
    run.send("selection.start", "selection-element", { selectionId: "selection-element", mode: "element" });
    run.respond("selection.candidate", "selection-element", {
      selectionId: "selection-element",
      mode: "element",
      candidateId: "candidate-save",
      label: "Save changes button",
      rect: { x: 12, y: 18, width: 130, height: 32 },
      depth: 3,
    });

    const root = run.root();
    const marker = root.shadowRoot?.querySelector<HTMLElement>("[part='selection-candidate']");
    expect(marker?.style.left).toBe("12px");
    expect(marker?.getAttribute("data-kind")).toBe("candidate");
    expect(root.shadowRoot?.querySelector("[part='selection-candidate-label']")?.textContent)
      .toBe("Save changes button  130 × 32");
    expect(root.getAttribute("data-selection-count")).toBe("1");

    run.respond("selection.candidate", "selection-element", {
      selectionId: "selection-element",
      mode: "element",
      candidateId: "candidate-next",
      label: "Next element",
      rect: { x: 220, y: 80, width: 90, height: 28 },
      depth: 4,
    });
    const currentMarkers = root.shadowRoot?.querySelectorAll("[part='selection-candidate']") ?? [];
    expect(currentMarkers).toHaveLength(1);
    expect((currentMarkers[0] as HTMLElement).style.left).toBe("220px");
    expect(root.shadowRoot?.querySelectorAll("[part='selection-candidate-label']")).toHaveLength(1);

    run.respond("selection.candidate.cleared", "selection-element", {
      selectionId: "selection-element",
    });
    expect(root.shadowRoot?.querySelectorAll("[part='selection-candidate']")).toHaveLength(0);
    expect(root.getAttribute("data-selection-count")).toBe("0");

    run.respond("selection.cancelled", "selection-element", {
      selectionId: "selection-element",
      reason: "user",
    });
    expect(run.document.querySelector("[data-keydex-annotation-overlay-root='true']")).toBeNull();
  });

  it("opens a compact editor beside the selected element and submits only the annotation body", () => {
    const run = createRun("<button id='save'>Save changes</button>");
    run.configure("light", false);
    run.send("selection.start", "selection-element", { selectionId: "selection-element", mode: "element" });
    run.respond("selection.result", "selection-element", {
      selectionId: "selection-element",
      target: elementTarget(documentPath(0), { x: 12, y: 18, width: 130, height: 32 }),
    });

    const root = run.root();
    const editor = root.shadowRoot?.querySelector<HTMLElement>("[part='annotation-editor']");
    const input = root.shadowRoot?.querySelector<HTMLTextAreaElement>("[aria-label='批注内容']");
    const cancel = root.shadowRoot?.querySelector<HTMLButtonElement>("[data-kind='cancel']");
    expect(editor?.getAttribute("aria-label")).toBe("添加网页批注");
    expect(input).not.toBeNull();
    expect(cancel?.textContent).toBe("取消");
    expect(root.shadowRoot?.querySelector("[part='selection-candidate']")).not.toBeNull();
    expect(editor?.tagName).toBe("DIV");

    input!.value = "这里需要进一步确认。";
    root.shadowRoot?.querySelector<HTMLButtonElement>("[data-kind='save']")?.click();

    expect(run.message("annotation.submit", "selection-element")?.payload).toEqual({
      selectionId: "selection-element",
      bodyMarkdown: "这里需要进一步确认。",
    });
    expect(run.document.querySelector("[data-keydex-annotation-overlay-root='true']")).toBeNull();
  });

  it("cancels a selected element draft through the explicit cancel action", () => {
    const run = createRun("<button id='save'>Save changes</button>");
    run.configure("light", false);
    run.send("selection.start", "selection-cancel", { selectionId: "selection-cancel", mode: "element" });
    run.respond("selection.result", "selection-cancel", {
      selectionId: "selection-cancel",
      target: elementTarget(documentPath(0), { x: 12, y: 18, width: 130, height: 32 }),
    });

    run.root().shadowRoot?.querySelector<HTMLButtonElement>("[data-kind='cancel']")?.click();

    expect(run.message("annotation.cancelled", "selection-cancel")?.payload).toEqual({
      selectionId: "selection-cancel",
    });
    expect(run.document.querySelector("[data-keydex-annotation-overlay-root='true']")).toBeNull();
  });

  it("opens and cancels the editor from a Chromium-native inspected element", () => {
    const run = createRun("<canvas id='chart'></canvas>");
    run.configure("light", false);
    const target = elementTarget(documentPath(0), { x: 24, y: 48, width: 420, height: 240 });

    run.window.dispatchEvent(new run.window.CustomEvent("keydex:web-annotation-native-selection", {
      detail: {
        requestId: "selection-native",
        selectionId: "selection-native",
        target,
      },
    }));
    expect(run.root().shadowRoot?.querySelector("[part='annotation-editor']")).not.toBeNull();

    run.window.dispatchEvent(new run.window.CustomEvent("keydex:web-annotation-native-cancel", {
      detail: { selectionId: "selection-native" },
    }));
    expect(run.document.querySelector("[data-keydex-annotation-overlay-root='true']")).toBeNull();
  });

  it("recomputes element geometry on scroll/resize, reports changes, and tears down on navigation", async () => {
    const run = createRun("<button id='moving'>Moving target</button>");
    const button = run.document.querySelector("#moving")!;
    let rect = { x: 40, y: 80, width: 160, height: 36 };
    Object.defineProperty(button, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ ...rect, left: rect.x, top: rect.y, right: rect.x + rect.width, bottom: rect.y + rect.height }),
    });
    run.configure("dark", false);
    run.send("highlight.render", "highlight-moving", {
      annotationId: "annotation-moving",
      state: "resolved",
      target: elementTarget(documentPath(0), rect),
    });
    expect(run.marker("annotation-moving")?.style.top).toBe("80px");

    rect = { x: 42, y: 24, width: 160, height: 36 };
    run.window.dispatchEvent(new run.window.Event("scroll"));
    await run.nextFrame();
    expect(run.marker("annotation-moving")?.style.top).toBe("24px");
    expect(run.message("geometry.changed", "highlight-moving")?.payload).toEqual({
      annotationIds: ["annotation-moving"],
    });

    rect = { x: 42, y: 24, width: 180, height: 40 };
    run.window.dispatchEvent(new run.window.Event("resize"));
    await run.nextFrame();
    expect(run.marker("annotation-moving")?.style.width).toBe("180px");

    run.window.dispatchEvent(new run.window.Event("pagehide"));
    expect(run.document.querySelector("[data-keydex-annotation-overlay-root='true']")).toBeNull();
  });

  it("keeps a newly saved fallback highlight anchored to the document while resolution catches up", async () => {
    const run = createRun("<main>Page content</main>");
    Object.defineProperty(run.window, "scrollX", { configurable: true, value: 0 });
    Object.defineProperty(run.window, "scrollY", { configurable: true, value: 120 });
    run.configure("light", false);
    run.send("highlight.render", "highlight-new-fallback", {
      annotationId: "annotation-new-fallback",
      state: "resolved",
      target: elementTarget(documentPath(99), { x: 24, y: 340, width: 180, height: 36 }),
    });
    expect(run.marker("annotation-new-fallback")?.style.top).toBe("340px");

    Object.defineProperty(run.window, "scrollY", { configurable: true, value: 200 });
    run.window.dispatchEvent(new run.window.Event("scroll"));
    await run.nextFrame();

    expect(run.marker("annotation-new-fallback")?.style.top).toBe("260px");
    expect(run.message("geometry.changed", "highlight-new-fallback")?.payload).toEqual({
      annotationIds: ["annotation-new-fallback"],
    });
  });

  it("scrolls text-node targets through their containing element and flashes the verified highlight", async () => {
    const run = createRun("<p id='quote'>Quoted text</p>");
    const paragraph = run.document.querySelector<HTMLElement>("#quote")!;
    const scrollIntoView = vi.fn();
    Object.defineProperty(paragraph, "scrollIntoView", { configurable: true, value: scrollIntoView });
    const target = {
      type: "text" as const,
      quote: { exact: "Quoted text", prefix: "", suffix: "" },
      domRange: {
        startPath: documentPath(0).concat({ childIndex: 0, shadowRoot: false }),
        startOffset: 0,
        endPath: documentPath(0).concat({ childIndex: 0, shadowRoot: false }),
        endOffset: 11,
      },
      context: { headingPath: [] },
      rects: [{ x: 20, y: 30, width: 90, height: 18 }],
      frame: { url: "https://example.test/article", indexPath: [] },
    };
    run.configure("light", true);
    run.send("highlight.render", "highlight-quote", {
      annotationId: "annotation-quote",
      state: "resolved",
      target,
    });
    run.send("navigate.toTarget", "navigate-quote", {
      annotationId: "annotation-quote",
      target,
    });
    await run.nextFrame();

    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", inline: "nearest", behavior: "auto" });
    expect(run.marker("annotation-quote")?.getAttribute("data-flash")).toBe("true");
  });

  it("renders, opens, navigates, retargets, and clears a local-file highlight", async () => {
    const localUrl = "file:///D:/e2e-wbf/annotations/article.html";
    const run = createRun("<button id='local-target'>Local target</button>", localUrl);
    const button = run.document.querySelector<HTMLElement>("#local-target")!;
    const scrollIntoView = vi.fn();
    Object.defineProperty(button, "scrollIntoView", { configurable: true, value: scrollIntoView });
    const initial = elementTarget(
      documentPath(0),
      { x: 20, y: 36, width: 140, height: 32 },
      localUrl,
    );
    run.configure("light", false);

    run.send("highlight.render", "highlight-local", {
      annotationId: "annotation-local",
      state: "resolved",
      bodyMarkdown: "Local annotation",
      target: initial,
    });
    expect(run.marker("annotation-local")?.style.top).toBe("36px");
    expect(run.root().shadowRoot?.querySelector("style")?.textContent)
      .toContain('[data-kind="highlight"]:hover');
    run.marker("annotation-local")?.click();
    expect(run.root().shadowRoot?.querySelector("[part='annotation-highlight-popover']")?.textContent)
      .toContain("Local annotation");

    run.send("navigate.toTarget", "navigate-local", {
      annotationId: "annotation-local",
      target: initial,
    });
    await run.nextFrame();
    expect(scrollIntoView).toHaveBeenCalledWith({
      block: "center",
      inline: "nearest",
      behavior: "smooth",
    });
    expect(run.marker("annotation-local")?.getAttribute("data-flash")).toBe("true");

    run.send("highlight.render", "highlight-local-retarget", {
      annotationId: "annotation-local",
      state: "changed",
      bodyMarkdown: "Local annotation",
      target: elementTarget(
        documentPath(0),
        { x: 40, y: 88, width: 160, height: 32 },
        localUrl,
      ),
    });
    expect(run.root().shadowRoot?.querySelectorAll(
      "[part='annotation-highlight'][data-annotation-id='annotation-local']",
    )).toHaveLength(1);
    expect(run.marker("annotation-local")?.style.top).toBe("88px");
    expect(run.marker("annotation-local")?.getAttribute("data-state")).toBe("changed");

    run.send("highlight.clear", "highlight-local-clear", { annotationIds: ["annotation-local"] });
    expect(run.document.querySelector("[data-keydex-annotation-overlay-root='true']")).toBeNull();
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
  window.eval(overlaySource);
  const metadata = (window as unknown as {
    KeydexAnnotationBridge: { navigationId: string; frameKey: string };
  }).KeydexAnnotationBridge;
  let hostSequence = 0;
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
      sequence: ++hostSequence,
      payload,
    };
    for (const listener of nativeListeners) listener({ data: envelope });
  };
  const respond = (kind: string, requestId: string, payload: Record<string, unknown>) => {
    window.document.dispatchEvent(new window.CustomEvent("keydex:web-annotation-response", {
      detail: { kind, requestId, payload },
    }));
  };
  const configure = (theme: "light" | "dark", reducedMotion: boolean) => {
    const dark = theme === "dark";
    send("overlay.configure", `overlay-${theme}-${hostSequence}`, {
      theme,
      tokens: dark ? {
        accent: "rgb(255, 121, 198)", surface: "rgb(40, 42, 54)", text: "rgb(248, 248, 242)",
        border: "rgb(89, 100, 131)", focus: "rgb(255, 121, 198)", warning: "rgb(255, 184, 108)", danger: "rgb(255, 85, 85)",
      } : {
        accent: "rgb(22, 119, 255)", surface: "rgb(255, 255, 255)", text: "rgb(23, 23, 23)",
        border: "rgb(201, 201, 201)", focus: "rgb(22, 119, 255)", warning: "rgb(217, 119, 6)", danger: "rgb(217, 45, 32)",
      },
      radiusPx: 4,
      motionMs: reducedMotion ? 0 : 140,
      reducedMotion,
    });
  };
  const root = () => {
    const value = window.document.querySelector<HTMLElement>("[data-keydex-annotation-overlay-root='true']");
    expect(value).not.toBeNull();
    return value!;
  };
  const marker = (annotationId: string) => root().shadowRoot?.querySelector<HTMLElement>(
    `[part='annotation-highlight'][data-annotation-id='${annotationId}']`,
  ) ?? null;
  const message = <K extends BrowserBridgeEnvelope["kind"]>(kind: K, requestId: string) =>
    (messages.find((envelope) => envelope.kind === kind && envelope.requestId === requestId) ?? null) as BrowserBridgeEnvelope<K> | null;
  const nextFrame = () => new Promise<void>((resolveFrame) => window.requestAnimationFrame(() => resolveFrame()));
  return { window, document: window.document, messages, send, respond, configure, root, marker, message, nextFrame };
}

function textTarget(rects: readonly { x: number; y: number; width: number; height: number }[]) {
  return {
    type: "text",
    quote: { exact: "Original page text", prefix: "", suffix: "" },
    context: { headingPath: [] },
    rects,
    frame: { url: "https://example.test/article", indexPath: [] },
  };
}

function elementTarget(
  path: readonly { childIndex: number; shadowRoot: boolean }[],
  rect: { x: number; y: number; width: number; height: number },
  url = "https://example.test/article",
) {
  return {
    type: "element",
    tag: "button",
    role: "button",
    accessibleName: "Moving target",
    stableAttributes: [{ name: "id", value: "moving" }],
    path,
    context: { headingPath: [] },
    rect,
    frame: { url, indexPath: [] },
  };
}

function documentPath(bodyChildIndex: number) {
  return [
    { childIndex: 1, shadowRoot: false },
    { childIndex: 1, shadowRoot: false },
    { childIndex: bodyChildIndex, shadowRoot: false },
  ];
}
