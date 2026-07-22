import { describe, expect, it, vi } from "vitest";

import {
  WebAnnotationHighlightSynchronizer,
  WebAnnotationNavigator,
  WebAnnotationPanelRegistry,
  type WebAnnotationCoordinatorResolution,
  type WebAnnotationHighlightPort,
  type WebAnnotationNavigationPanel,
  type WebAnnotationNavigationPanelSnapshot,
  type WebAnnotationNavigationTarget,
} from "../src/renderer/features/browser/annotations";
import type { BrowserSurfaceRef } from "../src/renderer/features/browser/domain";
import type { WebElementTarget } from "../src/renderer/features/browser/runtime";

const surface: BrowserSurfaceRef = { panelId: "panel-1", surfaceId: "surface-1", generation: 1 };

describe("web annotation highlight synchronization", () => {
  it("renders only verified targets and incrementally clears delete, ambiguity, and orphan states", async () => {
    const renderHighlights = vi.fn<WebAnnotationHighlightPort["renderHighlights"]>().mockResolvedValue(undefined);
    const clearHighlights = vi.fn<WebAnnotationHighlightPort["clearHighlights"]>().mockResolvedValue(undefined);
    const synchronizer = new WebAnnotationHighlightSynchronizer({
      surface,
      port: { renderHighlights, clearHighlights, navigateToTarget: vi.fn() },
    });

    await synchronizer.sync({
      resolved: resolution("resolved", elementTarget("resolved")),
      changed: resolution("changed", elementTarget("changed")),
      ambiguous: resolution("ambiguous", null),
      orphaned: resolution("orphaned", null),
    });
    expect(renderHighlights).toHaveBeenCalledTimes(1);
    expect(renderHighlights.mock.calls[0][0].resolutions.map((item) => [item.annotationId, item.state])).toEqual([
      ["resolved", "resolved"],
      ["changed", "changed"],
    ]);
    expect(clearHighlights).not.toHaveBeenCalled();

    await synchronizer.sync({
      resolved: resolution("ambiguous", null),
      changed: resolution("changed", elementTarget("changed-updated")),
    });
    expect(clearHighlights).toHaveBeenCalledWith({ surface, annotationIds: ["resolved"] });
    expect(renderHighlights).toHaveBeenLastCalledWith({
      surface,
      resolutions: [{ annotationId: "changed", state: "changed", target: elementTarget("changed-updated") }],
    });

    await synchronizer.sync({});
    expect(clearHighlights).toHaveBeenLastCalledWith({ surface, annotationIds: ["changed"] });
  });

  it("batches highlight writes at the shared 50-item boundary", async () => {
    const renderHighlights = vi.fn<WebAnnotationHighlightPort["renderHighlights"]>().mockResolvedValue(undefined);
    const synchronizer = new WebAnnotationHighlightSynchronizer({
      surface,
      port: { renderHighlights, clearHighlights: vi.fn(), navigateToTarget: vi.fn() },
    });
    const resolutions = Object.fromEntries(Array.from({ length: 51 }, (_, index) => [
      `annotation-${index}`,
      resolution("resolved", elementTarget(String(index))),
    ]));

    await synchronizer.sync(resolutions);

    expect(renderHighlights.mock.calls.map(([input]) => input.resolutions.length)).toEqual([50, 1]);
  });
});

describe("WebAnnotationNavigator", () => {
  it("reuses the current matching panel and reveals only after a current resolved target exists", async () => {
    const registry = new WebAnnotationPanelRegistry();
    const panel = new FakePanel(registry, panelSnapshot("panel-current", true, true, "url-a"));
    panel.resolutions.set("annotation-a", resolution("resolved", elementTarget("a"), "resource-a"));
    registry.register(panel);
    const navigator = new WebAnnotationNavigator(registry, { timeoutMs: 100 });

    const result = await navigator.navigate({
      scopeKey: "session:one",
      currentPanelId: "panel-current",
      target: navigationTarget("a"),
      createPanel: vi.fn(),
    });

    expect(result).toEqual({ status: "revealed", panelId: "panel-current" });
    expect(panel.activate).toHaveBeenCalledTimes(1);
    expect(panel.reveal).toHaveBeenCalledWith("annotation-a", elementTarget("a"));
  });

  it("activates a different matching panel and restores a discarded surface before revealing", async () => {
    const registry = new WebAnnotationPanelRegistry();
    const current = new FakePanel(registry, panelSnapshot("panel-current", true, true, "url-other"));
    const discarded = new FakePanel(registry, panelSnapshot("panel-target", false, false, "url-a"));
    discarded.resolutions.set("annotation-a", resolution("changed", elementTarget("restored"), "resource-a"));
    discarded.restoreOnActivate = true;
    registry.register(current);
    registry.register(discarded);

    const result = await new WebAnnotationNavigator(registry, { timeoutMs: 100 }).navigate({
      scopeKey: "session:one",
      currentPanelId: "panel-current",
      target: navigationTarget("a"),
      createPanel: vi.fn(),
    });

    expect(result).toEqual({ status: "revealed", panelId: "panel-target" });
    expect(discarded.reveal).toHaveBeenCalledWith("annotation-a", elementTarget("restored"));
    expect(current.reveal).not.toHaveBeenCalled();
  });

  it("creates a replacement for a closed panel and waits for registration", async () => {
    const registry = new WebAnnotationPanelRegistry();
    const navigator = new WebAnnotationNavigator(registry, { timeoutMs: 100 });
    const created = new FakePanel(registry, panelSnapshot("panel-created", false, true, "url-a"));
    created.resolutions.set("annotation-a", resolution("resolved", elementTarget("created"), "resource-a"));
    const createPanel = vi.fn(() => registry.register(created));

    const result = await navigator.navigate({
      scopeKey: "session:one",
      target: navigationTarget("a"),
      createPanel,
    });

    expect(createPanel).toHaveBeenCalledWith("https://example.test/a");
    expect(result).toEqual({ status: "revealed", panelId: "panel-created" });
  });

  it("cancels an older rapid-click request and never reveals ambiguous or orphaned candidates", async () => {
    const registry = new WebAnnotationPanelRegistry();
    const first = new FakePanel(registry, panelSnapshot("panel-a", true, true, "url-a"));
    const second = new FakePanel(registry, panelSnapshot("panel-b", false, true, "url-b"));
    second.resolutions.set("annotation-b", resolution("ambiguous", null, "resource-b"));
    registry.register(first);
    registry.register(second);
    const navigator = new WebAnnotationNavigator(registry, { timeoutMs: 100 });

    const stale = navigator.navigate({
      scopeKey: "session:one",
      currentPanelId: "panel-a",
      target: navigationTarget("a"),
      createPanel: vi.fn(),
    });
    const current = navigator.navigate({
      scopeKey: "session:one",
      currentPanelId: "panel-a",
      target: navigationTarget("b"),
      createPanel: vi.fn(),
    });

    await expect(stale).resolves.toEqual({ status: "cancelled" });
    await expect(current).resolves.toEqual({
      status: "evidence_only",
      panelId: "panel-b",
      resolution: "ambiguous",
    });
    expect(first.reveal).not.toHaveBeenCalled();
    expect(second.reveal).not.toHaveBeenCalled();

    second.resolutions.set("annotation-b", resolution("orphaned", null, "resource-b"));
    registry.notify();
    await expect(navigator.navigate({
      scopeKey: "session:one",
      target: navigationTarget("b"),
      createPanel: vi.fn(),
    })).resolves.toMatchObject({ status: "evidence_only", resolution: "orphaned" });
    expect(second.reveal).not.toHaveBeenCalled();
  });
});

class FakePanel implements WebAnnotationNavigationPanel {
  readonly resolutions = new Map<string, WebAnnotationCoordinatorResolution>();
  readonly activate = vi.fn(() => {
    this.snapshot = { ...this.snapshot, active: true, ready: this.restoreOnActivate || this.snapshot.ready };
    this.registry.notify();
  });
  readonly reveal = vi.fn(async () => undefined);
  restoreOnActivate = false;

  constructor(
    private readonly registry: WebAnnotationPanelRegistry,
    private snapshot: WebAnnotationNavigationPanelSnapshot,
  ) {}

  getSnapshot(): WebAnnotationNavigationPanelSnapshot {
    return this.snapshot;
  }

  getResolution(annotationId: string): WebAnnotationCoordinatorResolution | undefined {
    return this.resolutions.get(annotationId);
  }
}

function panelSnapshot(
  panelId: string,
  active: boolean,
  ready: boolean,
  urlKey: string,
): WebAnnotationNavigationPanelSnapshot {
  return {
    scopeKey: "session:one",
    panelId,
    active,
    ready,
    urlKey,
    documentUrl: `https://example.test/${urlKey.slice(4)}`,
  };
}

function navigationTarget(suffix: "a" | "b"): WebAnnotationNavigationTarget {
  return {
    annotationId: `annotation-${suffix}`,
    resourceId: `resource-${suffix}`,
    urlKey: `url-${suffix}`,
    documentUrl: `https://example.test/${suffix}`,
  };
}

function resolution(
  status: "resolved" | "changed" | "ambiguous" | "orphaned",
  target: WebElementTarget | null,
  resourceId = "resource-1",
): WebAnnotationCoordinatorResolution {
  const identity = {
    resourceId,
    annotationId: target ? `annotation-${target.accessibleName}` : "annotation-none",
    navigationId: "navigation-1",
    frameRevision: 1,
  };
  const settled = {
    status,
    identity,
    frameKey: "main",
    target,
    candidateIds: [],
    evidence: null,
    settledAt: "2026-07-22T00:00:00.000Z",
  } as const;
  return {
    status,
    identity,
    frameKey: "main",
    reason: status === "resolved"
      ? "exact_match"
      : status === "changed"
        ? "content_changed"
        : status === "ambiguous"
          ? "ambiguous_candidates"
          : "no_candidate",
    lastKnown: settled,
    settled,
  };
}

function elementTarget(id: string): WebElementTarget {
  return {
    type: "element",
    tag: "button",
    role: "button",
    accessibleName: id,
    textSummary: id,
    stableAttributes: [{ name: "id", value: id }],
    path: [{ childIndex: 1, shadowRoot: false }],
    context: { headingPath: [] },
    rect: { x: 10, y: 20, width: 120, height: 32 },
    frame: { url: "https://example.test/article", indexPath: [] },
  };
}
