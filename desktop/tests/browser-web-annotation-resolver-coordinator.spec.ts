import { describe, expect, it, vi } from "vitest";

import {
  WebAnnotationResolverCoordinator,
  webAnnotationResolutionCacheKey,
  type WebAnnotationResolverPort,
  type WebAnnotationResolverScheduler,
  type WebAnnotationResolverTarget,
} from "../src/renderer/features/browser/annotations";
import type { BrowserSurfaceRef } from "../src/renderer/features/browser/domain";
import type { BrowserBridgeEnvelope, WebElementTarget } from "../src/renderer/features/browser/runtime";

const surface: BrowserSurfaceRef = { panelId: "panel-1", surfaceId: "surface-1", generation: 2 };
const localFileUrl = "file:///D:/e2e-wbf/annotations/article.html";

describe("WebAnnotationResolverCoordinator", () => {
  it("batches 75 annotations as 50 + 25 and keeps all work off the activation call stack", () => {
    const run = createRun();
    run.coordinator.activatePage(page(75));
    run.coordinator.applyBridgeEnvelope(ready("navigation-a", "main", true));

    expect(run.resolveAnnotations).not.toHaveBeenCalled();
    run.scheduler.runAll();

    expect(run.resolveAnnotations).toHaveBeenCalledTimes(2);
    expect(run.resolveAnnotations.mock.calls.map(([input]) => input.targets.length)).toEqual([50, 25]);
    expect(run.coordinator.getSnapshot().queued).toBe(0);
  });

  it("honors the 8ms slice budget and resumes remaining work in later slices", () => {
    const run = createRun(4);
    run.coordinator.activatePage(page(6));
    run.coordinator.applyBridgeEnvelope(ready("navigation-a", "main", true));

    run.scheduler.runNext();
    expect(run.resolveAnnotations.mock.calls[0][0].targets).toHaveLength(2);
    expect(run.coordinator.getSnapshot().queued).toBe(4);
    run.scheduler.runAll();

    expect(run.resolveAnnotations.mock.calls.flatMap(([input]) => input.targets)).toHaveLength(6);
  });

  it("deduplicates DOM dirty signals and ignores geometry-only scroll updates", () => {
    const run = createRun();
    run.coordinator.activatePage(page(3));
    run.coordinator.applyBridgeEnvelope(ready("navigation-a", "main", true));
    run.scheduler.runAll();
    run.resolveAnnotations.mockClear();

    run.coordinator.applyBridgeEnvelope(pageChanged("navigation-a", 2));
    run.coordinator.applyBridgeEnvelope(pageChanged("navigation-a", 3));
    expect(run.coordinator.getSnapshot().queued).toBe(3);
    run.coordinator.applyBridgeEnvelope(geometryChanged("navigation-a"));
    expect(run.coordinator.getSnapshot().queued).toBe(3);
    run.scheduler.runAll();

    expect(run.resolveAnnotations).toHaveBeenCalledTimes(1);
    expect(run.resolveAnnotations.mock.calls[0][0].targets).toHaveLength(3);
  });

  it("treats repeated ready messages from the same document as idempotent", () => {
    const run = createRun();
    run.coordinator.activatePage(page(1));
    run.coordinator.applyBridgeEnvelope(ready("navigation-a", "main", true));
    run.scheduler.runAll();
    run.coordinator.applyBridgeEnvelope(resolution("navigation-a", "resolved"));
    run.resolveAnnotations.mockClear();

    run.coordinator.applyBridgeEnvelope(ready("navigation-a", "main", true));
    run.scheduler.runAll();

    expect(run.resolveAnnotations).not.toHaveBeenCalled();
    expect(run.coordinator.getSnapshot().resolutions["annotation-0"]?.status).toBe("resolved");
  });

  it("exposes a newly created live selection as resolved before its background bridge registration", () => {
    const run = createRun();
    const binding = { documentId: "document-1", nodeHandleId: "node-1" };
    run.coordinator.activatePage(page(0));
    run.coordinator.applyBridgeEnvelope(ready("navigation-a", "main", true));

    run.coordinator.confirmCreatedAnnotation({
      resourceId: "resource-1",
      annotationId: "annotation-0",
      target: elementTarget(0),
      binding,
    });
    run.coordinator.activatePage(page(1));

    expect(run.coordinator.getSnapshot().visibleStatuses["annotation-0"]).toBe("resolved");
    expect(run.coordinator.getSnapshot().resolutions["annotation-0"]?.lastKnown).toMatchObject({
      status: "resolved",
      evidence: { strategy: "node_handle", binding },
    });

    run.scheduler.runAll();
    expect(run.resolveAnnotations).toHaveBeenCalledWith(expect.objectContaining({
      targets: [expect.objectContaining({ annotationId: "annotation-0", binding })],
    }));
    expect(run.coordinator.getSnapshot().visibleStatuses["annotation-0"]).toBe("resolved");
  });

  it("keeps dispatch rejection pending instead of misreporting a resolver timeout", async () => {
    const run = createRun();
    run.resolveAnnotations.mockRejectedValueOnce(new Error("Structured page resolver bridge is not ready"));
    run.coordinator.activatePage(page(1));
    run.coordinator.applyBridgeEnvelope(ready("navigation-a", "main", true));
    run.scheduler.runAll();
    await Promise.resolve();

    expect(run.coordinator.getSnapshot().resolutions["annotation-0"]).toMatchObject({
      status: "pending",
      reason: "bridge_not_ready",
    });
    expect(run.coordinator.getSnapshot().visibleStatuses["annotation-0"]).toBe("pending");
  });

  it("keeps a retryable page resolver error pending", () => {
    const run = createRun();
    run.coordinator.activatePage(page(1));
    run.coordinator.applyBridgeEnvelope(ready("navigation-a", "main", true));
    run.scheduler.runAll();

    run.coordinator.applyBridgeEnvelope(bridgeError("navigation-a", true));

    expect(run.coordinator.getSnapshot().resolutions["annotation-0"]).toMatchObject({
      status: "pending",
      reason: "bridge_not_ready",
    });
  });

  it("rejects an old resolution after a newer DOM-change request supersedes it", () => {
    const run = createRun();
    run.coordinator.activatePage(page(1));
    run.coordinator.applyBridgeEnvelope(ready("navigation-a", "main", true));
    run.scheduler.runAll();
    run.coordinator.applyBridgeEnvelope(pageChanged("navigation-a", 2, ["annotation-0"]));
    run.scheduler.runAll();

    run.coordinator.applyBridgeEnvelope(resolution("navigation-a", "orphaned", "main", undefined, "resolve-1:0"));
    expect(run.coordinator.getSnapshot().resolutions["annotation-0"]?.status).toBe("resolving");

    run.coordinator.applyBridgeEnvelope(resolution("navigation-a", "resolved", "main", undefined, "resolve-2:0"));
    expect(run.coordinator.getSnapshot().resolutions["annotation-0"]?.status).toBe("resolved");
  });

  it("invalidates cache by navigation/frame revision and rejects late navigation results", () => {
    const run = createRun();
    run.coordinator.activatePage(page(1));
    run.coordinator.applyBridgeEnvelope(ready("navigation-a", "main", true));
    run.scheduler.runAll();
    expect(run.coordinator.applyBridgeEnvelope(resolution("navigation-a", "resolved"))).toBe(true);
    const first = run.coordinator.getSnapshot().resolutions["annotation-0"]!;
    expect(webAnnotationResolutionCacheKey(first.identity)).toContain("navigation-a");
    expect(first.identity.frameRevision).toBe(1);

    run.coordinator.activatePage(page(1));
    run.scheduler.runAll();
    expect(run.resolveAnnotations).toHaveBeenCalledTimes(1);

    run.coordinator.applyBridgeEnvelope(ready("navigation-b", "main", true));
    run.scheduler.runAll();
    expect(run.resolveAnnotations).toHaveBeenCalledTimes(2);
    expect(run.coordinator.applyBridgeEnvelope(resolution("navigation-a", "changed"))).toBe(false);
    expect(run.coordinator.applyBridgeEnvelope(resolution("navigation-b", "changed", "main", undefined, "resolve-2:0"))).toBe(true);
    const current = run.coordinator.getSnapshot().resolutions["annotation-0"]!;
    expect(current.identity).toMatchObject({ navigationId: "navigation-b", frameRevision: 2 });
    expect(current.status).toBe("changed");
    expect(run.coordinator.getSnapshot().visibleStatuses["annotation-0"]).toBe("resolved");
  });

  it("cancels queued work while suspended and restarts from current targets on resume", () => {
    const run = createRun();
    run.coordinator.activatePage(page(4));
    run.coordinator.applyBridgeEnvelope(ready("navigation-a", "main", true));
    run.coordinator.setSuspended(true);
    run.scheduler.runAll();

    expect(run.resolveAnnotations).not.toHaveBeenCalled();
    expect(run.coordinator.getSnapshot()).toMatchObject({ suspended: true, queued: 0 });
    expect(run.coordinator.getSnapshot().visibleStatuses["annotation-0"]).toBe("pending");

    run.coordinator.setSuspended(false);
    run.scheduler.runAll();
    expect(run.resolveAnnotations).toHaveBeenCalledTimes(1);
    expect(run.resolveAnnotations.mock.calls[0][0].targets).toHaveLength(4);
  });

  it("does not turn a settled locator result into unavailable while the native surface is suspended", () => {
    const run = createRun();
    run.coordinator.activatePage(page(1));
    run.coordinator.applyBridgeEnvelope(ready("navigation-a", "main", true));
    run.scheduler.runAll();
    run.coordinator.applyBridgeEnvelope(resolution("navigation-a", "resolved"));

    run.coordinator.setSuspended(true);

    expect(run.coordinator.getSnapshot().resolutions["annotation-0"]?.status).toBe("resolved");
    expect(run.coordinator.getSnapshot().visibleStatuses["annotation-0"]).toBe("resolved");
  });

  it("clears a never-resolved unavailable label when the native surface suspends", () => {
    const run = createRun();
    run.coordinator.activatePage(page(1));
    run.coordinator.applyBridgeEnvelope(ready("navigation-a", "main", true));
    run.scheduler.runAll();
    run.coordinator.applyBridgeEnvelope(bridgeError("navigation-a", false));
    expect(run.coordinator.getSnapshot().visibleStatuses["annotation-0"]).toBe("temporarily_unavailable");

    run.coordinator.setSuspended(true);

    expect(run.coordinator.getSnapshot().visibleStatuses["annotation-0"]).toBe("pending");
  });

  it("routes a missing child-frame target through main for a fail-closed orphan result, then retries on child ready", () => {
    const run = createRun();
    const child = page(1, [0]);
    run.coordinator.activatePage(child);
    run.coordinator.applyBridgeEnvelope(ready("navigation-main", "main", true));
    run.scheduler.runAll();
    expect(run.resolveAnnotations).toHaveBeenCalledTimes(1);

    run.coordinator.applyBridgeEnvelope(resolution("navigation-main", "orphaned", "main", {
      strategy: "frame_unavailable",
      score: 0,
      rects: [],
      candidateCount: 0,
      truncated: false,
      changedSignals: [],
    }, "resolve-1:0"));
    expect(run.coordinator.getSnapshot().resolutions["annotation-0"]?.reason).toBe("frame_unavailable");

    run.coordinator.applyBridgeEnvelope(ready("navigation-child", "frame:0", false));
    run.scheduler.runAll();
    expect(run.resolveAnnotations).toHaveBeenCalledTimes(2);
    run.coordinator.applyBridgeEnvelope(resolution("navigation-child", "resolved", "frame:0", undefined, "resolve-2:0"));
  });

  it("keeps an exact local-file match resolved with complete evidence", () => {
    const run = prepareLocalFileRun();

    run.coordinator.applyBridgeEnvelope(fileResolution("resolved", {
      strategy: "stable_dom_path",
      score: 1,
      rects: [{ x: 10, y: 20, width: 120, height: 32 }],
      candidateCount: 1,
      truncated: false,
      changedSignals: [],
    }));

    expect(run.coordinator.getSnapshot().resolutions["annotation-0"]).toMatchObject({
      status: "resolved",
      reason: "exact_match",
      identity: { resourceId: "local-resource-1", navigationId: "file-navigation-a" },
      settled: {
        target: { frame: { url: localFileUrl, indexPath: [] } },
        candidateIds: [],
        evidence: { strategy: "stable_dom_path", score: 1, candidateCount: 1 },
      },
    });
    expect(run.coordinator.getSnapshot().visibleStatuses["annotation-0"]).toBe("resolved");
  });

  it("distinguishes a relocated local-file target without reporting material content change", () => {
    const run = prepareLocalFileRun();

    run.coordinator.applyBridgeEnvelope(fileResolution("resolved", {
      strategy: "role_name",
      score: 0.93,
      rects: [{ x: 40, y: 120, width: 120, height: 32 }],
      candidateCount: 1,
      truncated: false,
      changedSignals: ["anchor_position_changed"],
    }));

    expect(run.coordinator.getSnapshot().resolutions["annotation-0"]).toMatchObject({
      status: "resolved",
      reason: "exact_match",
      settled: {
        evidence: {
          strategy: "role_name",
          candidateCount: 1,
          changedSignals: ["anchor_position_changed"],
        },
      },
    });
  });

  it("preserves a changed local-file target as settled evidence while exposing it as navigable", () => {
    const run = prepareLocalFileRun();

    run.coordinator.applyBridgeEnvelope(fileResolution("changed", {
      strategy: "stable_attributes",
      score: 0.9,
      rects: [{ x: 10, y: 20, width: 120, height: 32 }],
      candidateCount: 1,
      truncated: false,
      changedSignals: ["anchor_text_changed"],
    }));

    expect(run.coordinator.getSnapshot().resolutions["annotation-0"]).toMatchObject({
      status: "changed",
      reason: "content_changed",
      settled: { evidence: { changedSignals: ["anchor_text_changed"] } },
    });
    expect(run.coordinator.getSnapshot().visibleStatuses["annotation-0"]).toBe("resolved");
  });

  it("keeps multiple local-file candidates ambiguous and does not select a target", () => {
    const run = prepareLocalFileRun();

    run.coordinator.applyBridgeEnvelope(fileResolution("ambiguous", {
      strategy: "role_name",
      score: 0.9,
      rects: [],
      candidateCount: 2,
      truncated: false,
      changedSignals: [],
    }, ["candidate-a", "candidate-b"]));

    expect(run.coordinator.getSnapshot().resolutions["annotation-0"]).toMatchObject({
      status: "ambiguous",
      reason: "ambiguous_candidates",
      settled: {
        target: null,
        candidateIds: ["candidate-a", "candidate-b"],
        evidence: { candidateCount: 2 },
      },
    });
    expect(run.coordinator.getSnapshot().visibleStatuses["annotation-0"]).toBe("ambiguous");
  });

  it("keeps a deleted local-file target as missing without inventing a candidate", () => {
    const run = prepareLocalFileRun();

    run.coordinator.applyBridgeEnvelope(fileResolution("orphaned", {
      strategy: "stable_dom_path",
      score: 0,
      rects: [],
      candidateCount: 0,
      truncated: false,
      changedSignals: [],
    }));

    expect(run.coordinator.getSnapshot().resolutions["annotation-0"]).toMatchObject({
      status: "orphaned",
      reason: "no_candidate",
      settled: { target: null, candidateIds: [], evidence: { candidateCount: 0 } },
    });
    expect(run.coordinator.getSnapshot().visibleStatuses["annotation-0"]).toBe("orphaned");
  });

  it("rejects a late local-file result after the canonical resource identity changes", () => {
    const run = prepareLocalFileRun();
    run.coordinator.activatePage(sourcePage(1, {
      resourceId: "local-resource-2",
      hostNavigationId: "host-file-navigation-2",
      url: "file:///D:/e2e-wbf/annotations/renamed.html",
    }));
    run.scheduler.runAll();

    run.coordinator.applyBridgeEnvelope(fileResolution("resolved", {
      strategy: "stable_dom_path",
      score: 1,
      rects: [{ x: 10, y: 20, width: 120, height: 32 }],
      candidateCount: 1,
      truncated: false,
      changedSignals: [],
    }, [], "resolve-1:0"));

    expect(run.coordinator.getSnapshot().resolutions["annotation-0"]).toMatchObject({
      status: "resolving",
      identity: { resourceId: "local-resource-2" },
    });
  });
});

function createRun(nowStep = 0) {
  const scheduler = new ManualScheduler(nowStep);
  const resolveAnnotations = vi.fn<WebAnnotationResolverPort["resolveAnnotations"]>().mockResolvedValue(undefined);
  const coordinator = new WebAnnotationResolverCoordinator({
    surface,
    port: { resolveAnnotations },
    scheduler,
  });
  return { coordinator, resolveAnnotations, scheduler };
}

function page(count: number, indexPath: readonly number[] = []) {
  return sourcePage(count, { indexPath });
}

function sourcePage(
  count: number,
  options: {
    readonly indexPath?: readonly number[];
    readonly resourceId?: string;
    readonly hostNavigationId?: string;
    readonly url?: string;
  } = {},
) {
  const indexPath = options.indexPath ?? [];
  const resourceId = options.resourceId ?? "resource-1";
  const url = options.url ?? "https://example.test/article";
  const annotations = Array.from(
    { length: count },
    (_, index) => annotation(index, indexPath, resourceId, url),
  );
  return {
    resourceId,
    hostNavigationId: options.hostNavigationId ?? "host-navigation-1",
    annotations,
  };
}

function annotation(
  index: number,
  indexPath: readonly number[],
  resourceId = "resource-1",
  url = "https://example.test/article",
): WebAnnotationResolverTarget {
  return {
    resourceId,
    annotationId: `annotation-${index}`,
    target: elementTarget(index, indexPath, url),
  };
}

function elementTarget(
  index: number,
  indexPath: readonly number[] = [],
  url = "https://example.test/article",
): WebElementTarget {
  return {
    type: "element",
    tag: "button",
    role: "button",
    accessibleName: `Button ${index}`,
    textSummary: `Button ${index}`,
    stableAttributes: [{ name: "id", value: `button-${index}` }],
    path: [{ childIndex: index + 1, shadowRoot: false }],
    context: { headingPath: [] },
    rect: { x: 10, y: 20 + index, width: 120, height: 32 },
    frame: { url, indexPath },
  };
}

function ready(
  navigationId: string,
  frameKey: string,
  top: boolean,
  href = "https://example.test/article",
): BrowserBridgeEnvelope<"bridge.ready"> {
  return envelope("bridge.ready", navigationId, frameKey, {
    href,
    top,
  });
}

function prepareLocalFileRun() {
  const run = createRun();
  run.coordinator.activatePage(sourcePage(1, {
    resourceId: "local-resource-1",
    hostNavigationId: "host-file-navigation-1",
    url: localFileUrl,
  }));
  run.coordinator.applyBridgeEnvelope(ready("file-navigation-a", "main", true, localFileUrl));
  run.scheduler.runAll();
  return run;
}

function fileResolution(
  status: "resolved" | "changed" | "ambiguous" | "orphaned",
  evidence: BrowserBridgeEnvelope<"resolution.result">["payload"]["evidence"],
  candidateIds: readonly string[] = [],
  requestId = "resolve-1:0",
): BrowserBridgeEnvelope<"resolution.result"> {
  return envelope("resolution.result", "file-navigation-a", "main", {
    annotationId: "annotation-0",
    status,
    ...(status === "resolved" || status === "changed"
      ? { target: elementTarget(0, [], localFileUrl) }
      : {}),
    candidateIds,
    evidence,
  }, requestId);
}

function pageChanged(
  navigationId: string,
  revision: number,
  annotationIds: readonly string[] = ["annotation-0", "annotation-1", "annotation-2"],
): BrowserBridgeEnvelope<"page.changed"> {
  return envelope("page.changed", navigationId, "main", {
    reason: "dom",
    revision,
    annotationIds,
  });
}

function geometryChanged(navigationId: string): BrowserBridgeEnvelope<"geometry.changed"> {
  return envelope("geometry.changed", navigationId, "main", { annotationIds: ["annotation-0"] });
}

function resolution(
  navigationId: string,
  status: "resolved" | "changed" | "orphaned",
  frameKey = "main",
  evidence: BrowserBridgeEnvelope<"resolution.result">["payload"]["evidence"] = {
    strategy: "stable_dom_path",
    score: 1,
    rects: [{ x: 10, y: 20, width: 120, height: 32 }],
    candidateCount: 1,
    truncated: false,
    changedSignals: [],
  },
  requestId = "resolve-1:0",
): BrowserBridgeEnvelope<"resolution.result"> {
  return envelope("resolution.result", navigationId, frameKey, {
    annotationId: "annotation-0",
    status,
    ...(status === "resolved" || status === "changed" ? { target: elementTarget(0) } : {}),
    evidence,
  }, requestId);
}

function bridgeError(navigationId: string, retryable: boolean): BrowserBridgeEnvelope<"bridge.error"> {
  return envelope("bridge.error", navigationId, "main", {
    code: "internal",
    message: "resolver failed",
    retryable,
  }, "resolve-1:0");
}

function envelope<K extends "bridge.ready" | "page.changed" | "geometry.changed" | "resolution.result" | "bridge.error">(
  kind: K,
  navigationId: string,
  frameKey: string,
  payload: BrowserBridgeEnvelope<K>["payload"],
  requestId = kind === "resolution.result" ? "resolve-1:0" : `${kind}-1`,
): BrowserBridgeEnvelope<K> {
  return {
    protocol: "keydex.web-annotation.v1",
    kind,
    ...surface,
    navigationId,
    frameKey,
    requestId,
    sequence: 2,
    payload,
  };
}

class ManualScheduler implements WebAnnotationResolverScheduler {
  readonly #tasks = new Map<number, () => void>();
  readonly #nowStep: number;
  #nextId = 0;
  #now = 0;

  constructor(nowStep: number) {
    this.#nowStep = nowStep;
  }

  now(): number {
    const value = this.#now;
    this.#now += this.#nowStep;
    return value;
  }

  nowIso(): string {
    return "2026-07-22T00:00:00.000Z";
  }

  scheduleSlice(callback: () => void): number {
    const id = ++this.#nextId;
    this.#tasks.set(id, callback);
    return id;
  }

  cancelSlice(handle: unknown): void {
    if (typeof handle === "number") this.#tasks.delete(handle);
  }

  runNext(): void {
    const next = this.#tasks.entries().next().value as [number, () => void] | undefined;
    if (!next) return;
    this.#tasks.delete(next[0]);
    next[1]();
  }

  runAll(): void {
    let guard = 0;
    while (this.#tasks.size > 0) {
      this.runNext();
      guard += 1;
      if (guard > 1_000) throw new Error("Resolver scheduler did not settle");
    }
  }
}
