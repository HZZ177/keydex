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
    }, {
      resolved: { bodyMarkdown: "Resolved note" },
      changed: { bodyMarkdown: "Changed note" },
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
    }, {
      changed: { bodyMarkdown: "Changed note" },
    });
    expect(clearHighlights).toHaveBeenCalledWith({ surface, annotationIds: ["resolved"] });
    expect(renderHighlights).toHaveBeenLastCalledWith({
      surface,
      resolutions: [{
        annotationId: "changed",
        state: "changed",
        target: elementTarget("changed-updated"),
        bodyMarkdown: "Changed note",
      }],
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

  it("keeps the current last-known highlight visible while the resolver revalidates it", async () => {
    const renderHighlights = vi.fn<WebAnnotationHighlightPort["renderHighlights"]>().mockResolvedValue(undefined);
    const clearHighlights = vi.fn<WebAnnotationHighlightPort["clearHighlights"]>().mockResolvedValue(undefined);
    const synchronizer = new WebAnnotationHighlightSynchronizer({
      surface,
      port: { renderHighlights, clearHighlights, navigateToTarget: vi.fn() },
    });
    const verified = resolution("resolved", elementTarget("stable"));

    await synchronizer.sync({ stable: verified });
    await synchronizer.sync({
      stable: {
        ...verified,
        status: "resolving",
        reason: "dom_changed",
        requestId: "resolve-2",
        settled: null,
      },
    });

    expect(renderHighlights).toHaveBeenCalledTimes(1);
    expect(clearHighlights).not.toHaveBeenCalled();
  });

  it("replays highlights when a newer sync supersedes an in-flight clear", async () => {
    let finishClear!: () => void;
    const clearBarrier = new Promise<void>((resolve) => {
      finishClear = resolve;
    });
    const renderHighlights = vi.fn<WebAnnotationHighlightPort["renderHighlights"]>().mockResolvedValue(undefined);
    const clearHighlights = vi.fn<WebAnnotationHighlightPort["clearHighlights"]>()
      .mockImplementationOnce(() => clearBarrier);
    const synchronizer = new WebAnnotationHighlightSynchronizer({
      surface,
      port: { renderHighlights, clearHighlights, navigateToTarget: vi.fn() },
    });
    const verified = { stable: resolution("resolved", elementTarget("stable")) };

    await synchronizer.sync(verified);
    const clearing = synchronizer.sync({});
    await vi.waitFor(() => expect(clearHighlights).toHaveBeenCalledTimes(1));
    const restoring = synchronizer.sync(verified);
    finishClear();
    await Promise.all([clearing, restoring]);

    expect(renderHighlights).toHaveBeenCalledTimes(2);
    expect(renderHighlights).toHaveBeenLastCalledWith({
      surface,
      resolutions: [{
        annotationId: "stable",
        state: "resolved",
        target: elementTarget("stable"),
        bodyMarkdown: "",
      }],
    });
  });

  it("renders, retargets, and clears a local-file highlight on the same native surface", async () => {
    const renderHighlights = vi.fn<WebAnnotationHighlightPort["renderHighlights"]>().mockResolvedValue(undefined);
    const clearHighlights = vi.fn<WebAnnotationHighlightPort["clearHighlights"]>().mockResolvedValue(undefined);
    const synchronizer = new WebAnnotationHighlightSynchronizer({
      surface,
      port: { renderHighlights, clearHighlights, navigateToTarget: vi.fn() },
    });
    const localUrl = "file:///D:/e2e-wbf/annotations/article.html";

    await synchronizer.sync({
      local: resolution("resolved", elementTarget("local-before", localUrl)),
    });
    await synchronizer.sync({
      local: resolution("changed", elementTarget("local-after", localUrl)),
    });
    await synchronizer.sync({
      local: resolution("orphaned", null),
    });

    expect(renderHighlights).toHaveBeenNthCalledWith(1, {
      surface,
      resolutions: [expect.objectContaining({
        annotationId: "local",
        state: "resolved",
        target: expect.objectContaining({
          frame: { url: localUrl, indexPath: [] },
        }),
      })],
    });
    expect(renderHighlights).toHaveBeenNthCalledWith(2, {
      surface,
      resolutions: [expect.objectContaining({
        annotationId: "local",
        state: "changed",
        target: expect.objectContaining({ accessibleName: "local-after" }),
      })],
    });
    expect(clearHighlights).toHaveBeenCalledWith({ surface, annotationIds: ["local"] });
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

  it("prefers the requested host and keeps equal panel ids isolated across hosts", async () => {
    const registry = new WebAnnotationPanelRegistry();
    const agent = new FakePanel(
      registry,
      { ...panelSnapshot("shared-panel", true, true, "url-a"), hostKind: "agent" },
    );
    const workbench = new FakePanel(
      registry,
      { ...panelSnapshot("shared-panel", false, true, "url-a"), hostKind: "workbench" },
    );
    agent.resolutions.set("annotation-a", resolution("resolved", elementTarget("agent"), "resource-a"));
    workbench.resolutions.set("annotation-a", resolution("resolved", elementTarget("workbench"), "resource-a"));
    const unregisterAgent = registry.register(agent);
    registry.register(workbench);

    expect(registry.list("session:one")).toHaveLength(2);
    await expect(new WebAnnotationNavigator(registry, { timeoutMs: 100 }).navigate({
      scopeKey: "session:one",
      preferredHostKind: "workbench",
      target: navigationTarget("a"),
      createPanel: vi.fn(),
    })).resolves.toEqual({ status: "revealed", panelId: "shared-panel" });
    expect(workbench.reveal).toHaveBeenCalledWith(
      "annotation-a",
      elementTarget("workbench"),
    );
    expect(agent.reveal).not.toHaveBeenCalled();

    unregisterAgent();
    expect(registry.list("session:one")).toHaveLength(1);
    expect(registry.list("session:one")[0]?.getSnapshot().hostKind).toBe("workbench");
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

  it("matches canonical-equivalent Windows file URLs and reveals in the existing Workbench panel", async () => {
    const registry = new WebAnnotationPanelRegistry();
    const panel = new FakePanel(registry, {
      hostKind: "workbench",
      scopeKey: "workspace:local",
      panelId: "workbench-file-panel",
      active: true,
      ready: true,
      urlKey: null,
      documentUrl: "file:///d:/E2E-WBF/Annotations/ARTICLE.html#old-fragment",
    });
    const target: WebAnnotationNavigationTarget = {
      annotationId: "annotation-local",
      resourceId: "resource-local",
      urlKey: "local-file-v2-key",
      documentUrl: "file:///D:/e2e-wbf/annotations/article.html",
    };
    panel.resolutions.set(
      target.annotationId,
      resolution("resolved", elementTarget("local", target.documentUrl), target.resourceId),
    );
    registry.register(panel);
    const createPanel = vi.fn();

    const result = await new WebAnnotationNavigator(registry, { timeoutMs: 100 }).navigate({
      scopeKey: "workspace:local",
      preferredHostKind: "workbench",
      target,
      createPanel,
    });

    expect(result).toEqual({ status: "revealed", panelId: "workbench-file-panel" });
    expect(createPanel).not.toHaveBeenCalled();
    expect(panel.reveal).toHaveBeenCalledWith(
      "annotation-local",
      elementTarget("local", target.documentUrl),
    );
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
    hostKind: "agent",
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

function elementTarget(
  id: string,
  url = "https://example.test/article",
): WebElementTarget {
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
    frame: { url, indexPath: [] },
  };
}
