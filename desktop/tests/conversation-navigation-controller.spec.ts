import { describe, expect, it, vi } from "vitest";

import { ConversationNavigationController } from "@/renderer/pages/conversation/timeline/ConversationNavigationController";
import { ConversationTimelineRuntime } from "@/renderer/pages/conversation/timeline/ConversationTimelineRuntime";
import type { ConversationRenderUnit } from "@/renderer/pages/conversation/timeline/ConversationRenderUnit";

describe("ConversationNavigationController", () => {
  it("retains only the latest unresolved turn intent and reveals it once after publication", () => {
    const controller = new ConversationNavigationController();
    const first = vi.fn();
    const latest = vi.fn();
    controller.requestNavigation({ requestId: 1, unitId: "turn-1", onRevealed: first });
    controller.requestNavigation({ requestId: 2, unitId: "turn-2", onRevealed: latest });
    const target = targetHarness(["turn-2"]);
    controller.attach(target);

    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledTimes(1);
    expect(target.revealUnit).toHaveBeenCalledTimes(1);
    expect(controller.diagnostics()).toMatchObject({
      pendingNavigationId: null,
      completedNavigationId: 2,
      revealAttempts: 1,
      revealSuccesses: 1,
    });
  });

  it("gives explicit navigation priority over prepend restoration", () => {
    const target = targetHarness([]);
    const controller = new ConversationNavigationController();
    controller.attach(target);
    expect(controller.beginPrepend()).toBe(true);
    target.restoreAnchor.mockClear();
    controller.requestNavigation({ requestId: "capsule-1", unitId: "turn-tail", source: "capsule" });
    target.available.add("turn-tail");
    controller.onTimelinePublished();

    expect(target.revealUnit).toHaveBeenCalledWith("turn-tail", "center");
    expect(target.restoreAnchor).not.toHaveBeenCalled();
    expect(controller.completePrepend()).toBe(true);
    expect(target.restoreAnchor).toHaveBeenCalledTimes(1);
  });

  it("cancels stale prepend and pending navigation on user scroll", () => {
    const target = targetHarness([]);
    const controller = new ConversationNavigationController();
    controller.attach(target);
    controller.beginPrepend();
    controller.requestNavigation({ requestId: 1, unitId: "not-hydrated" });
    controller.recordUserScroll();
    target.available.add("not-hydrated");
    controller.onTimelinePublished();

    expect(target.restoreAnchor).not.toHaveBeenCalled();
    expect(target.revealUnit).toHaveBeenCalledTimes(1);
    expect(controller.diagnostics()).toMatchObject({ pendingNavigationId: null, prependState: "cancelled" });
  });

  it("restores a stable logical unit after multiple prepends and dynamic height changes", () => {
    const runtime = runtimeHarness();
    const initial = units(100, 0);
    runtime.publish(initial);
    runtime.root.scrollTop = 805;
    const controller = new ConversationNavigationController();
    controller.attach(runtime);
    expect(controller.beginPrepend()).toBe(true);

    runtime.publish([...units(10, -10), ...initial]);
    runtime.updateMeasuredHeight("unit-0", 100);
    expect(controller.completePrepend()).toBe(true);
    expect(runtime.root.scrollTop).toBe(1_265);
    expect(controller.diagnostics()).toMatchObject({ prependState: "restored", anchorRestores: 1 });
  });

  it("jumps to the tail of 10,000 units with one indexed reveal attempt", () => {
    const runtime = runtimeHarness();
    runtime.publish(units(10_000, 0));
    const controller = new ConversationNavigationController();
    controller.attach(runtime);
    expect(controller.requestNavigation({ requestId: "tail", unitId: "unit-9999" })).toBe(true);

    expect(runtime.getUnitElement("unit-9999")).not.toBeNull();
    expect(runtime.diagnostics().mounted).toBeLessThan(40);
    expect(controller.diagnostics()).toMatchObject({ revealAttempts: 1, revealSuccesses: 1 });
  });

  it("stabilizes the revealed viewport after late resource measurement until user intent cancels it", () => {
    const target = targetHarness(["turn-50"]);
    const controller = new ConversationNavigationController();
    controller.attach(target);
    controller.requestNavigation({ requestId: "resource", unitId: "turn-50" });
    target.restoreAnchor.mockClear();
    controller.onTimelinePublished();
    expect(target.restoreAnchor).toHaveBeenCalledTimes(1);
    expect(controller.diagnostics().navigationStabilizations).toBe(1);
    controller.recordUserScroll();
    controller.onTimelinePublished();
    expect(target.restoreAnchor).toHaveBeenCalledTimes(1);
  });
});

function targetHarness(initial: string[]) {
  const available = new Set(initial);
  return {
    available,
    revealUnit: vi.fn((unitId: string) => available.has(unitId)),
    captureAnchor: vi.fn(() => ({
      unitId: "anchor-unit",
      offsetWithinUnit: 5,
      viewportOffset: 0,
      capturedRevision: "r1",
    })),
    restoreAnchor: vi.fn(() => true),
  };
}

function runtimeHarness() {
  const root = document.createElement("div");
  Object.defineProperties(root, {
    clientHeight: { configurable: true, value: 600 },
    scrollTop: { configurable: true, writable: true, value: 0 },
  });
  return new ConversationTimelineRuntime(root, {
    observeMeasurements: false,
    overscanPx: 200,
    renderer: {
      mount(unit, host) {
        host.textContent = unit.id;
        return { update: () => undefined, destroy: () => undefined };
      },
    },
  });
}

function units(count: number, start: number): ConversationRenderUnit[] {
  return Array.from({ length: count }, (_, offset) => {
    const index = start + offset;
    return {
      id: `unit-${index}`,
      kind: "assistant-markdown",
      owner: "markdown-runtime",
      turnId: `turn-${index}`,
      turnIndex: index,
      businessTurnIndex: index,
      sourceMessageIds: [`message-${index}`],
      item: null,
      parentUnitId: null,
      dynamic: false,
      interactive: false,
      pinPolicy: "never",
      measurementPolicy: "estimate-once",
      estimatedHeight: 40,
      renderVersion: `v-${index}`,
    };
  });
}
