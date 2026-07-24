import { describe, expect, it, vi } from "vitest";

import type { BrowserSurfaceRef } from "../src/renderer/features/browser/domain";
import {
  createWebAnnotationSessionPort,
  createWebAnnotationResolverPort,
  WebAnnotationDraftActiveError,
  WebAnnotationSession,
  type WebAnnotationSessionPort,
} from "../src/renderer/features/browser/annotations";
import type {
  BrowserBridgeEnvelope,
  WebElementTarget,
  WebRegionCaptureGeometry,
  WebRegionTarget,
} from "../src/renderer/features/browser/runtime";
import { planBrowserResources } from "../src/renderer/features/browser/runtime";
import { BrowserHostCommandError } from "../src/renderer/features/browser/runtime";

const surface: BrowserSurfaceRef = { panelId: "panel-1", surfaceId: "surface-1", generation: 2 };
const target: WebRegionTarget = {
  type: "region",
  rect: { x: 10, y: 20, width: 120, height: 80 },
  viewport: { width: 800, height: 600 },
  scroll: { x: 0, y: 100 },
  visual: { fingerprintVersion: 1, localDigest: "fnv1a32:0123abcd" },
  frame: { url: "https://example.test/article", indexPath: [] },
};

describe("WebAnnotationSession", () => {
  it("does not report active selection until the page bridge accepts the command", async () => {
    const bridge = { acceptSelection: undefined as (() => void) | undefined };
    const startSelection = vi.fn<WebAnnotationSessionPort["startSelection"]>(() => new Promise<void>((resolve) => {
      bridge.acceptSelection = resolve;
    }));
    const session = new WebAnnotationSession({
      surface,
      port: {
        startSelection,
        cancelSelection: vi.fn().mockResolvedValue(undefined),
        captureRegion: vi.fn().mockResolvedValue(undefined),
        discardCapture: vi.fn().mockResolvedValue(undefined),
        setProtection: vi.fn(),
      },
      requestId: () => "selection-starting",
    });

    const started = session.startSelection("element");
    expect(session.getSnapshot().status).toBe("starting");
    await Promise.resolve();
    expect(bridge.acceptSelection).toBeTypeOf("function");
    bridge.acceptSelection?.();
    await started;
    expect(session.getSnapshot().status).toBe("selecting");
  });

  it("serializes mode switches so only one selection request remains active", async () => {
    const harness = createHarness(["selection-1", "selection-2"]);
    await harness.session.startSelection("text");
    await harness.session.startSelection("element");

    expect(harness.startSelection).toHaveBeenNthCalledWith(1, {
      surface,
      selectionRequestId: "selection-1",
      mode: "text",
    });
    expect(harness.cancelSelection).toHaveBeenCalledTimes(1);
    expect(harness.startSelection).toHaveBeenNthCalledWith(2, {
      surface,
      selectionRequestId: "selection-2",
      mode: "element",
    });
    expect(harness.session.getSnapshot()).toMatchObject({
      status: "selecting",
      request: { requestId: "selection-2", mode: "element" },
    });
    expect(harness.setProtection).toHaveBeenCalledWith("panel-1", "selection", true);
  });

  it("cancels on Escape/navigation and ignores stale results", async () => {
    const harness = createHarness(["selection-1", "selection-2"]);
    await harness.session.startSelection("text");
    const escape = harness.session.cancelSelection("user");
    expect(harness.session.getSnapshot()).toMatchObject({ status: "cancelling", reason: "user" });
    await escape;
    expect(harness.session.getSnapshot()).toEqual({ status: "idle", lastExitReason: "user", error: null });

    await harness.session.startSelection("region");
    await harness.session.handleNavigation();
    expect(harness.session.getSnapshot()).toEqual({ status: "idle", lastExitReason: "navigation", error: null });
    expect(harness.session.applyBridgeEnvelope(selectionResult("selection-2"))).toBe(false);
    expect(harness.session.getSnapshot().status).toBe("idle");
    expect(harness.setProtection).toHaveBeenLastCalledWith("panel-1", "selection", false);
  });

  it("cancels a local-file region draft on navigation and releases its capture and protection", async () => {
    const harness = createHarness(["selection-local"]);
    const localTarget: WebRegionTarget = {
      ...target,
      frame: { url: "file:///D:/workspace/index.html", indexPath: [] },
    };
    await harness.session.startSelection("region");
    expect(harness.session.applyBridgeEnvelope(selectionResult("selection-local", {
      target: localTarget,
    }))).toBe(true);
    expect(harness.session.applyHostEvent(captureCompleted("capture:selection-local"))).toBe(true);

    await harness.session.handleNavigation();

    expect(harness.session.getSnapshot()).toEqual({
      status: "idle",
      lastExitReason: "navigation",
      error: null,
    });
    expect(harness.discardCapture).toHaveBeenCalledWith({
      surface,
      captureRequestId: "capture:selection-local",
    });
    expect(harness.setProtection).toHaveBeenLastCalledWith(
      "panel-1",
      "annotation_draft",
      false,
    );
    expect(harness.session.applyHostEvent(captureCompleted("capture:selection-local"))).toBe(false);
  });

  it("runs the global surface teardown after Chromium reports an Escape cancellation", async () => {
    const harness = createHarness(["selection-1"]);
    await harness.session.startSelection("element");

    expect(harness.session.applyHostEvent(nativeSelectionCancelled("selection-1"))).toBe(true);
    await vi.waitFor(() => expect(harness.cancelSelection).toHaveBeenCalledWith(surface));

    expect(harness.session.getSnapshot()).toEqual({
      status: "idle",
      lastExitReason: "user",
      error: null,
    });
  });

  it("moves candidate to an unsaved protected draft and releases it only on save/cancel", async () => {
    const harness = createHarness(["selection-1", "selection-2"]);
    await harness.session.startSelection("region");
    expect(harness.session.applyBridgeEnvelope(selectionCandidate("selection-1"))).toBe(true);
    expect(harness.session.getSnapshot()).toMatchObject({
      status: "candidate",
      candidate: { candidateId: "candidate-1", label: "区域 120 × 80" },
    });
    await harness.session.rejectCandidate();
    expect(harness.session.getSnapshot().status).toBe("idle");

    await harness.session.startSelection("region");
    expect(harness.session.applyBridgeEnvelope(selectionResult("selection-2"))).toBe(true);
    expect(harness.session.getSnapshot()).toMatchObject({
      status: "draft",
      draft: {
        draftId: "draft:selection-2",
        dirty: true,
        target,
        evidence: { status: "capturing", captureRequestId: "capture:selection-2" },
      },
    });
    expect(harness.session.completeDraftSave()).toBeNull();
    expect(harness.session.applyHostEvent(captureCompleted("capture:selection-2"))).toBe(true);
    expect(harness.session.getSnapshot()).toMatchObject({
      status: "draft",
      draft: {
        target: { visual: { perceptualHash: "dhash64:0123456789abcdef" } },
        evidence: { status: "ready", asset: { kind: "staged" } },
      },
    });
    expect(harness.setProtection).toHaveBeenCalledWith("panel-1", "annotation_draft", true);
    await expect(harness.session.startSelection("text")).rejects.toBeInstanceOf(WebAnnotationDraftActiveError);

    const decisions = planBrowserResources([{
      panelId: "panel-1",
      surface,
      active: false,
      protected: harness.session.getSnapshot().status === "draft",
      lastUsed: 1,
    }], { maxLive: 0, maxWarm: 0, memoryPressure: true });
    expect(decisions[0].next).toBe("warm");

    const saved = harness.session.completeDraftSave();
    expect(saved?.draftId).toBe("draft:selection-2");
    expect(harness.session.getSnapshot()).toEqual({ status: "idle", lastExitReason: "saved", error: null });
    expect(harness.setProtection).toHaveBeenLastCalledWith("panel-1", "annotation_draft", false);
  });

  it("accepts Chromium-native element results without depending on page bridge readiness", async () => {
    const harness = createHarness(["selection-native"]);
    await harness.session.startSelection("element");

    expect(harness.session.applyHostEvent(nativeElementResult("selection-native"))).toBe(true);
    expect(harness.session.getSnapshot()).toMatchObject({
      status: "draft",
      draft: {
        request: { mode: "element" },
        frameKey: "devtools:iframe-session-1",
        target: { type: "element", tag: "canvas" },
        evidence: null,
      },
    });

    const saved = harness.session.completeDraftSave();
    expect(saved?.target).toEqual(nativeElementTarget);
    await Promise.resolve();
    expect(harness.cancelSelection).toHaveBeenCalledWith(surface);
  });

  it("fully releases a saved native draft before starting the next continuous element selection", async () => {
    const harness = createHarness(["selection-native-1", "selection-native-2"]);
    await harness.session.startSelection("element");
    expect(harness.session.applyHostEvent(nativeElementResult("selection-native-1"))).toBe(true);

    const saved = await harness.session.completeDraftSaveAndContinue("element");

    expect(saved?.target).toEqual(nativeElementTarget);
    expect(harness.cancelSelection).toHaveBeenCalledTimes(1);
    expect(harness.startSelection).toHaveBeenNthCalledWith(2, {
      surface,
      selectionRequestId: "selection-native-2",
      mode: "element",
    });
    expect(harness.cancelSelection.mock.invocationCallOrder[0]).toBeLessThan(
      harness.startSelection.mock.invocationCallOrder[1],
    );
    expect(harness.session.getSnapshot()).toMatchObject({
      status: "selecting",
      request: { requestId: "selection-native-2", mode: "element" },
    });
  });

  it("cleans selection/draft protection on panel close and keeps drafts out of persisted panel state", async () => {
    const harness = createHarness(["selection-1", "selection-2"]);
    await harness.session.startSelection("element");
    await harness.session.closePanel();
    expect(harness.cancelSelection).toHaveBeenCalledWith(surface);
    expect(harness.session.getSnapshot()).toEqual({
      status: "idle",
      lastExitReason: "surface_destroyed",
      error: null,
    });

    const draftHarness = createHarness(["selection-2"]);
    await draftHarness.session.startSelection("region");
    draftHarness.session.applyBridgeEnvelope(selectionResult("selection-2"));
    await draftHarness.session.closePanel();
    expect(draftHarness.session.getSnapshot().status).toBe("idle");
    expect(draftHarness.discardCapture).toHaveBeenCalledWith({
      surface,
      captureRequestId: "capture:selection-2",
    });
    expect(JSON.stringify({ kind: "browser", restoreUrl: "https://example.test" })).not.toContain("draft:");
    expect(draftHarness.setProtection).toHaveBeenLastCalledWith("panel-1", "annotation_draft", false);
  });

  it("captures child-frame regions with correlated top-surface geometry and fails closed without it", async () => {
    const mapped = createHarness(["selection-frame"]);
    await mapped.session.startSelection("region");
    const childTarget: WebRegionTarget = {
      ...target,
      rect: { x: 20, y: 30, width: 100, height: 60 },
      viewport: { width: 400, height: 300 },
      frame: { url: "https://frame.example.test/article", indexPath: [0] },
    };
    expect(mapped.session.applyBridgeEnvelope(selectionResult("selection-frame", {
      frameKey: "frame:0",
      target: childTarget,
      captureGeometry: {
        rect: { x: 120, y: 80, width: 100, height: 60 },
        viewport: { width: 1000, height: 800 },
      },
    }))).toBe(true);
    await new Promise<void>((resolveTask) => setTimeout(resolveTask, 0));
    expect(mapped.captureRegion).toHaveBeenCalledWith({
      surface,
      captureRequestId: "capture:selection-frame",
      rect: { x: 120, y: 80, width: 100, height: 60 },
      viewport: { width: 1000, height: 800 },
    });

    const unsupported = createHarness(["selection-unsupported"]);
    await unsupported.session.startSelection("region");
    unsupported.session.applyBridgeEnvelope(selectionResult("selection-unsupported", {
      frameKey: "frame:0",
      target: childTarget,
    }));
    await Promise.resolve();
    expect(unsupported.session.getSnapshot()).toMatchObject({
      status: "draft",
      draft: { evidence: { status: "failed", errorCategory: "unsupported_frame" } },
    });
    expect(unsupported.captureRegion).not.toHaveBeenCalled();
    expect(unsupported.session.completeDraftSave()).toBeNull();
  });

  it("adapts BrowserHost commands and BrowserPanel resource protection without coupling state to them", async () => {
    const send = vi.fn().mockResolvedValue({ ok: true, requestId: "host-1" });
    const setProtection = vi.fn();
    const port = createWebAnnotationSessionPort({
      client: { send } as never,
      setProtection,
    });
    const resolverPort = createWebAnnotationResolverPort({ client: { send } as never });
    await port.startSelection({ surface, selectionRequestId: "selection-1", mode: "text" });
    await port.cancelSelection(surface);
    await port.captureRegion({
      surface,
      captureRequestId: "capture-1",
      rect: target.rect,
      viewport: target.viewport,
    });
    await port.discardCapture({ surface, captureRequestId: "capture-1" });
    port.setProtection("panel-1", "annotation_draft", true);
    await resolverPort.resolveAnnotations({
      surface,
      resolveRequestId: "resolve-1",
      targets: [{ annotationId: "annotation-1", target }],
    });

    expect(send).toHaveBeenNthCalledWith(1, "browser_start_selection", {
      ...surface,
      selectionRequestId: "selection-1",
      mode: "text",
    });
    expect(send).toHaveBeenNthCalledWith(2, "browser_cancel_selection", surface);
    expect(send).toHaveBeenNthCalledWith(3, "browser_capture_region", {
      ...surface,
      captureRequestId: "capture-1",
      rect: target.rect,
      viewport: target.viewport,
    });
    expect(send).toHaveBeenNthCalledWith(4, "browser_discard_capture", {
      ...surface,
      captureRequestId: "capture-1",
    });
    expect(setProtection).toHaveBeenCalledWith("panel-1", "annotation_draft", true);
    expect(send).toHaveBeenNthCalledWith(5, "browser_resolve_annotations", {
      ...surface,
      resolveRequestId: "resolve-1",
      targets: [{ annotationId: "annotation-1", target }],
    });
  });

  it("waits through the bounded bridge bootstrap window before starting selection", async () => {
    vi.useFakeTimers();
    try {
      const notReady = new BrowserHostCommandError({
        ok: false,
        requestId: "host-not-ready",
        error: {
          code: "host_failure",
          message: "Structured page selection bridge is not ready",
          retryable: true,
        },
      });
      const send = vi.fn()
        .mockRejectedValueOnce(notReady)
        .mockRejectedValueOnce(notReady)
        .mockResolvedValue({ ok: true, requestId: "host-ready" });
      const port = createWebAnnotationSessionPort({
        client: { send } as never,
        setProtection: vi.fn(),
      });

      const started = port.startSelection({ surface, selectionRequestId: "selection-retry", mode: "element" });
      await vi.advanceTimersByTimeAsync(120);
      await started;

      expect(send).toHaveBeenCalledTimes(3);
      expect(send).toHaveBeenLastCalledWith("browser_start_selection", {
        ...surface,
        selectionRequestId: "selection-retry",
        mode: "element",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

function createHarness(requestIds: string[]) {
  const startSelection = vi.fn<WebAnnotationSessionPort["startSelection"]>().mockResolvedValue(undefined);
  const cancelSelection = vi.fn<WebAnnotationSessionPort["cancelSelection"]>().mockResolvedValue(undefined);
  const captureRegion = vi.fn<WebAnnotationSessionPort["captureRegion"]>().mockResolvedValue(undefined);
  const discardCapture = vi.fn<WebAnnotationSessionPort["discardCapture"]>().mockResolvedValue(undefined);
  const setProtection = vi.fn<WebAnnotationSessionPort["setProtection"]>();
  const ids = [...requestIds];
  const session = new WebAnnotationSession({
    surface,
    port: { startSelection, cancelSelection, captureRegion, discardCapture, setProtection },
    requestId: () => ids.shift() ?? "selection-fallback",
    now: () => "2026-07-22T00:00:00.000Z",
  });
  return { session, startSelection, cancelSelection, captureRegion, discardCapture, setProtection };
}

function captureCompleted(
  captureRequestId: string,
): import("../src/renderer/features/browser/domain").BrowserEventEnvelope<"capture.completed"> {
  return {
    schemaVersion: 2,
    kind: "capture.completed",
    ...surface,
    sequence: 4,
    occurredAt: "2026-07-22T00:00:01.000Z",
    payload: {
      captureRequestId,
      asset: {
        assetId: "web-capture-1",
        kind: "staged",
        mimeType: "image/png",
        width: 150,
        height: 100,
        byteLength: 4096,
        sha256: "a".repeat(64),
        perceptualHash: "dhash64:0123456789abcdef",
        expiresAt: "2026-07-23T00:00:01.000Z",
      },
    },
  };
}

const nativeElementTarget: WebElementTarget = {
  type: "element",
  tag: "canvas",
  stableAttributes: [{ name: "id", value: "chart" }],
  path: [
    { childIndex: 0, shadowRoot: false },
    { childIndex: 1, shadowRoot: false },
    { childIndex: 2, shadowRoot: false },
  ],
  context: { headingPath: ["Dashboard"] },
  rect: { x: 40, y: 80, width: 640, height: 360 },
  frame: { url: "https://example.test/dashboard", indexPath: [0] },
};

function nativeElementResult(
  selectionRequestId: string,
): import("../src/renderer/features/browser/domain").BrowserEventEnvelope<"selection.result"> {
  return {
    schemaVersion: 2,
    kind: "selection.result",
    ...surface,
    sequence: 5,
    navigationId: "navigation:1",
    occurredAt: "2026-07-22T00:00:01.000Z",
    payload: {
      selectionRequestId,
      frameKey: "devtools:iframe-session-1",
      binding: { documentId: "document-1", nodeHandleId: "node-1" },
      target: nativeElementTarget,
    },
  };
}

function nativeSelectionCancelled(
  selectionRequestId: string,
): import("../src/renderer/features/browser/domain").BrowserEventEnvelope<"selection.cancelled"> {
  return {
    schemaVersion: 2,
    kind: "selection.cancelled",
    ...surface,
    sequence: 6,
    navigationId: "navigation:1",
    occurredAt: "2026-07-22T00:00:01.000Z",
    payload: {
      selectionRequestId,
      reason: "user",
    },
  };
}

function selectionCandidate(selectionId: string): BrowserBridgeEnvelope<"selection.candidate"> {
  return envelope("selection.candidate", selectionId, {
    selectionId,
    mode: "region",
    candidateId: "candidate-1",
    label: "区域 120 × 80",
    rect: target.rect,
    depth: 0,
  });
}

function selectionResult(
  selectionId: string,
  options: {
    readonly frameKey?: string;
    readonly target?: WebRegionTarget;
    readonly captureGeometry?: WebRegionCaptureGeometry;
  } = {},
): BrowserBridgeEnvelope<"selection.result"> {
  const value = envelope("selection.result", selectionId, {
    selectionId,
    target: options.target ?? target,
    ...(options.captureGeometry ? { captureGeometry: options.captureGeometry } : {}),
  });
  return options.frameKey ? { ...value, frameKey: options.frameKey } : value;
}

function envelope<K extends "selection.candidate" | "selection.result">(
  kind: K,
  requestId: string,
  payload: BrowserBridgeEnvelope<K>["payload"],
): BrowserBridgeEnvelope<K> {
  return {
    protocol: "keydex.web-annotation.v1",
    kind,
    ...surface,
    navigationId: "navigation:1",
    frameKey: "main",
    requestId,
    sequence: 2,
    payload,
  };
}
