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
    expect(run.coordinator.applyBridgeEnvelope(resolution("navigation-b", "changed"))).toBe(true);
    const current = run.coordinator.getSnapshot().resolutions["annotation-0"]!;
    expect(current.identity).toMatchObject({ navigationId: "navigation-b", frameRevision: 2 });
    expect(current.status).toBe("changed");
  });

  it("cancels queued work while suspended and restarts from current targets on resume", () => {
    const run = createRun();
    run.coordinator.activatePage(page(4));
    run.coordinator.applyBridgeEnvelope(ready("navigation-a", "main", true));
    run.coordinator.setSuspended(true);
    run.scheduler.runAll();

    expect(run.resolveAnnotations).not.toHaveBeenCalled();
    expect(run.coordinator.getSnapshot()).toMatchObject({ suspended: true, queued: 0 });
    expect(run.coordinator.getSnapshot().visibleStatuses["annotation-0"]).toBe("temporarily_unavailable");

    run.coordinator.setSuspended(false);
    run.scheduler.runAll();
    expect(run.resolveAnnotations).toHaveBeenCalledTimes(1);
    expect(run.resolveAnnotations.mock.calls[0][0].targets).toHaveLength(4);
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
    }));
    expect(run.coordinator.getSnapshot().resolutions["annotation-0"]?.reason).toBe("frame_unavailable");

    run.coordinator.applyBridgeEnvelope(ready("navigation-child", "frame:0", false));
    run.scheduler.runAll();
    expect(run.resolveAnnotations).toHaveBeenCalledTimes(2);
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
  const annotations = Array.from({ length: count }, (_, index) => annotation(index, indexPath));
  return {
    resourceId: "resource-1",
    hostNavigationId: "host-navigation-1",
    annotations,
  };
}

function annotation(index: number, indexPath: readonly number[]): WebAnnotationResolverTarget {
  return {
    resourceId: "resource-1",
    annotationId: `annotation-${index}`,
    target: elementTarget(index, indexPath),
  };
}

function elementTarget(index: number, indexPath: readonly number[] = []): WebElementTarget {
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
    frame: { url: "https://example.test/article", indexPath },
  };
}

function ready(
  navigationId: string,
  frameKey: string,
  top: boolean,
): BrowserBridgeEnvelope<"bridge.ready"> {
  return envelope("bridge.ready", navigationId, frameKey, {
    href: "https://example.test/article",
    top,
  });
}

function pageChanged(navigationId: string, revision: number): BrowserBridgeEnvelope<"page.changed"> {
  return envelope("page.changed", navigationId, "main", { reason: "dom", revision });
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
): BrowserBridgeEnvelope<"resolution.result"> {
  return envelope("resolution.result", navigationId, frameKey, {
    annotationId: "annotation-0",
    status,
    ...(status === "resolved" || status === "changed" ? { target: elementTarget(0) } : {}),
    evidence,
  });
}

function envelope<K extends "bridge.ready" | "page.changed" | "geometry.changed" | "resolution.result">(
  kind: K,
  navigationId: string,
  frameKey: string,
  payload: BrowserBridgeEnvelope<K>["payload"],
): BrowserBridgeEnvelope<K> {
  return {
    protocol: "keydex.web-annotation.v1",
    kind,
    ...surface,
    navigationId,
    frameKey,
    requestId: kind === "resolution.result" ? "resolve-1:0" : `${kind}-1`,
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
