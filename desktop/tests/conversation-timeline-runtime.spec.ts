import { describe, expect, it, vi } from "vitest";

import {
  ConversationTimelineRuntime,
  type ConversationTimelineUnitRenderer,
} from "@/renderer/pages/conversation/timeline/ConversationTimelineRuntime";
import type { ConversationRenderUnit, ConversationRenderUnitKind } from "@/renderer/pages/conversation/timeline/ConversationRenderUnit";
import { CONVERSATION_GEOMETRY_COMMIT_EVENT } from "@/renderer/pages/conversation/timeline/ConversationGeometryCommit";

describe("ConversationTimelineRuntime", () => {
  it("keeps older units windowed even for histories below the former native threshold", () => {
    const harness = createRuntime();
    const patch = harness.runtime.publish(units(40));

    expect(patch.mounted).toBeLessThan(40);
    expect(harness.root.dataset.conversationTimelineLayoutMode).toBe("virtual");
    expect(harness.runtime.mountedUnitIds()).toHaveLength(patch.mounted);
    expect(harness.runtime.canvas.style.overflowY).toBe("clip");
  });

  it.each([100, 1_000, 10_000])("keeps mounted units and DOM bounded for %i messages", (count) => {
    const harness = createRuntime();
    const patch = harness.runtime.publish(units(count));

    expect(patch.viewport.totalHeight).toBe(count * 40);
    expect(patch.mounted).toBeLessThanOrEqual(26);
    expect(harness.runtime.diagnostics()).toMatchObject({ units: count, mounted: patch.mounted });
    expect(harness.root.querySelectorAll("[data-conversation-unit-id]").length).toBe(patch.mounted);
    expect(harness.runtime.getUnitElement("unit-0")?.style.minHeight).toBe("");
    expect(harness.runtime.diagnostics().domNodes).toBeLessThan(80);
  });

  it("jumps directly across 10,000 units without mounting intermediate ranges", () => {
    const harness = createRuntime();
    const values = units(10_000);
    harness.runtime.publish(values);
    const mountsBefore = harness.renderer.mount.mock.calls.length;
    const patch = harness.runtime.updateViewport(390_000, 600);

    expect(patch.viewport.visibleRange.start).toBeGreaterThan(9_700);
    expect(patch.mounted).toBeLessThanOrEqual(36);
    expect(harness.renderer.mount.mock.calls.length - mountsBefore).toBeLessThanOrEqual(36);
    expect(harness.runtime.getUnitElement("unit-5000")).toBeNull();

    // The indexed destination host exists immediately; its nested React
    // content may still be pending and will commit independently. The runtime
    // must not flush the parent MessageList to force that local commit.
    expect(harness.root.querySelector("[data-conversation-unit-measurement-pending]")).not.toBeNull();
    const destination = harness.runtime.getUnitElement(values[patch.viewport.visibleRange.start]!.id)!;
    expect(destination.style.visibility).toBe("");
    expect(destination.dataset.conversationUnitScrollClip).toBeUndefined();
    expect(destination.style.height).toBe("");
  });

  it("reuses stable keyed slots and updates only units whose renderVersion changed", () => {
    const harness = createRuntime();
    const initial = units(30);
    harness.runtime.publish(initial);
    const stable = harness.runtime.getUnitElement("unit-2");
    const changed = initial.map((entry) => entry.id === "unit-5" ? { ...entry, renderVersion: "changed" } : entry);
    const patch = harness.runtime.publish(changed);

    expect(harness.runtime.getUnitElement("unit-2")).toBe(stable);
    expect(patch.updated).toBe(1);
    expect(harness.renderer.updates).toEqual(["unit-5"]);
  });

  it("reorders retained blocks by key and destroys identities removed from the Snapshot", () => {
    const harness = createRuntime();
    const initial = units(20);
    harness.runtime.publish(initial);
    const first = harness.runtime.getUnitElement("unit-0");
    const reordered = [initial[2], initial[1], initial[0], ...initial.slice(3, 18)];
    harness.runtime.publish(reordered);

    expect(harness.runtime.getUnitElement("unit-0")).toBe(first);
    expect(harness.runtime.getUnitElement("unit-19")).toBeNull();
    expect(harness.renderer.destroyed).toContain("unit-19");
    expect(harness.runtime.getUnitElement("unit-0")?.dataset.conversationUnitIndex).toBe("2");

    harness.runtime.publish([...reordered, unit(20)]);
    expect(harness.renderer.mount.mock.calls.some(([entry]) => entry.id === "unit-20")).toBe(true);
    expect(harness.runtime.getUnitElement("unit-20")?.textContent).toBe("unit-20");
  });

  it("pins an offscreen interactive unit and releases it back to the viewport budget", () => {
    const harness = createRuntime();
    const values = units(1_000).map((entry, index) => index === 900
      ? { ...entry, interactive: true, pinPolicy: "while-interacting" as const }
      : entry);
    harness.runtime.publish(values);
    const pinned = harness.runtime.setPinned("unit-900", true)!;

    expect(pinned.viewport.items.some((item) => item.index === 900 && item.pinned)).toBe(true);
    expect(harness.runtime.getUnitElement("unit-900")?.dataset.conversationUnitPinned).toBe("true");
    expect(harness.runtime.diagnostics().pinned).toBe(1);
    harness.runtime.setPinned("unit-900", false);
    expect(harness.runtime.getUnitElement("unit-900")).toBeNull();
  });

  it("keeps an explicit hot tail resident while the viewport is detached in old history", () => {
    const harness = createRuntime();
    const values = units(1_000);
    const patch = harness.runtime.publish(values, ["unit-997", "unit-998", "unit-999"]);

    expect(patch.mounted).toBeLessThan(30);
    expect(harness.runtime.getUnitElement("unit-500")).toBeNull();
    for (const id of ["unit-997", "unit-998", "unit-999"]) {
      expect(harness.runtime.getUnitElement(id)?.dataset.conversationUnitResident).toBe("true");
      expect(harness.runtime.getUnitElement(id)?.dataset.conversationUnitPinned).toBe("true");
    }
    expect(harness.runtime.diagnostics().pinned).toBe(3);

    harness.runtime.setResidentUnits([]);
    expect(harness.runtime.getUnitElement("unit-997")).toBeNull();
    expect(harness.runtime.getUnitElement("unit-998")).toBeNull();
    expect(harness.runtime.getUnitElement("unit-999")).toBeNull();
    expect(harness.runtime.diagnostics().pinned).toBe(0);
  });

  it("applies local measurements and shifts later units without remounting stable slots", () => {
    const harness = createRuntime();
    harness.runtime.publish(units(50));
    const first = harness.runtime.getUnitElement("unit-0");
    const before = harness.runtime.getUnitElement("unit-2")?.style.top;
    const patch = harness.runtime.updateMeasuredHeight("unit-0", 100)!;

    expect(patch.viewport.totalHeight).toBe(50 * 40 + 60);
    expect(harness.runtime.getUnitElement("unit-0")).toBe(first);
    expect(harness.runtime.getUnitElement("unit-2")?.style.top).not.toBe(before);
    expect(harness.runtime.getUnitElement("unit-2")?.style.transform).toBe("");
    expect(harness.runtime.diagnostics().measured).toBe(1);
  });

  it("repairs the height index after a nested Markdown geometry commit without a page refresh", () => {
    vi.useFakeTimers();
    try {
      const harness = createRuntime();
      const values = units(50);
      harness.runtime.publish(values);
      const host = harness.runtime.getUnitElement("unit-0")!;
      let height = 40;
      vi.spyOn(host, "getBoundingClientRect").mockImplementation(() => ({
        bottom: height,
        height,
        left: 0,
        right: 100,
        top: 0,
        width: 100,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }));
      expect(harness.runtime.commitRenderedUnit(values[0]!)).toBe(true);
      const totalBefore = harness.runtime.diagnostics().totalHeight;
      const laterTopBefore = harness.runtime.getUnitElement("unit-2")?.style.top;

      height = 240;
      host.firstElementChild!.dispatchEvent(new CustomEvent(CONVERSATION_GEOMETRY_COMMIT_EVENT, {
        bubbles: true,
      }));
      vi.advanceTimersByTime(20);

      expect(harness.runtime.diagnostics().totalHeight).toBe(totalBefore + 200);
      expect(harness.runtime.getUnitElement("unit-2")?.style.top).not.toBe(laterTopBefore);
      expect(host.dataset.conversationUnitMeasurementPending).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not frame-poll a geometry event while the local React root is still pending", () => {
    vi.useFakeTimers();
    try {
      const requestFrame = vi.spyOn(window, "requestAnimationFrame");
      const harness = createRuntime();
      harness.runtime.publish(units(50));
      const pending = harness.runtime.getUnitElement("unit-0")!;
      expect(pending.dataset.conversationUnitMeasurementPending).toBeTruthy();

      pending.dispatchEvent(new CustomEvent(CONVERSATION_GEOMETRY_COMMIT_EVENT, { bubbles: true }));
      vi.advanceTimersByTime(1_000);

      expect(requestFrame).toHaveBeenCalledTimes(1);
      expect(harness.runtime.diagnostics().totalHeight).toBe(50 * 40);
      requestFrame.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores subpixel ResizeObserver noise after a height has converged", () => {
    const harness = createRuntime();
    harness.runtime.publish(units(50));
    harness.runtime.updateMeasuredHeight("unit-0", 100);
    const settled = harness.runtime.diagnostics();

    expect(harness.runtime.updateMeasuredHeight("unit-0", 100.25)).toBeNull();
    expect(harness.runtime.diagnostics()).toMatchObject({
      patches: settled.patches,
      totalHeight: settled.totalHeight,
      deferredMeasurements: 0,
    });
  });

  it("keeps estimated unit height in the index without forcing it onto the measured DOM box", () => {
    const harness = createRuntime();
    harness.runtime.publish([{ ...unit(0), estimatedHeight: 120 }]);

    const element = harness.runtime.getUnitElement("unit-0")!;
    expect(element.style.minHeight).toBe("");
    expect(harness.runtime.diagnostics().totalHeight).toBe(120);
    expect(harness.runtime.updateMeasuredHeight("unit-0", 0)).toBeNull();
    expect(harness.runtime.diagnostics().totalHeight).toBe(120);
  });

  it("reveals by indexed identity and responds to viewport resize", () => {
    const harness = createRuntime();
    harness.runtime.publish(units(1_000));
    expect(harness.runtime.revealUnit("unit-500", "center")).toBe(true);
    expect(harness.runtime.getUnitElement("unit-500")).not.toBeNull();
    const narrow = harness.runtime.updateViewport(harness.root.scrollTop, 200);
    const wide = harness.runtime.updateViewport(harness.root.scrollTop, 1_200);
    expect(wide.mounted).toBeGreaterThan(narrow.mounted);
    expect(harness.runtime.revealUnit("missing")).toBe(false);
  });

  it("publishes the first virtual viewport at the bottom and keeps it there while measured heights settle", () => {
    const harness = createRuntime({ followBottom: true });
    const patch = harness.runtime.publish(units(1_000));

    expect(harness.root.scrollTop).toBe(39_400);
    expect(patch.viewport.visibleRange.start).toBeGreaterThan(980);
    expect(harness.runtime.getUnitElement("unit-0")).toBeNull();
    expect(harness.runtime.getUnitElement("unit-999")).not.toBeNull();
    expect(harness.runtime.diagnostics().followBottom).toBe(true);

    harness.runtime.updateMeasuredHeight("unit-999", 100);
    expect(harness.root.scrollTop).toBe(39_460);
  });

  it("top-aligns a revealed unit and clamps the final unit to the bottom", () => {
    const harness = createRuntime({ followBottom: true });
    harness.runtime.publish(units(1_000));

    expect(harness.runtime.revealUnit("unit-500", "start")).toBe(true);
    expect(harness.root.scrollTop).toBe(20_000);
    expect(harness.runtime.diagnostics().followBottom).toBe(false);

    expect(harness.runtime.revealUnit("unit-999", "start")).toBe(true);
    expect(harness.root.scrollTop).toBe(39_400);
  });

  it("never writes scrollTop directly and delegates every timeline movement to the scroll owner", () => {
    const harness = createRuntime({ followBottom: true, applyScrollRequests: false });

    harness.runtime.publish(units(1_000));
    expect(harness.root.scrollTop).toBe(0);
    expect(harness.scrollRequests.at(-1)).toEqual({ scrollTop: 39_400, reason: "follow-bottom" });

    harness.runtime.revealUnit("unit-500", "start");
    expect(harness.root.scrollTop).toBe(0);
    expect(harness.scrollRequests.at(-1)).toEqual({ scrollTop: 20_000, reason: "reveal-unit" });
  });

  it("marks only the semantic unit immediately before the explicit bottom spacer", () => {
    const harness = createRuntime();
    const bottom = {
      ...unit(2, "footer"),
      id: "conversation-runtime:bottom",
      turnId: null,
      turnIndex: null,
      businessTurnIndex: null,
    } satisfies ConversationRenderUnit;
    harness.runtime.publish([unit(0), unit(1), bottom]);

    expect(harness.runtime.getUnitElement("unit-0")?.dataset.conversationUnitTailAdjacent).toBe("false");
    expect(harness.runtime.getUnitElement("unit-1")?.dataset.conversationUnitTailAdjacent).toBe("true");
    expect(harness.runtime.getUnitElement("conversation-runtime:bottom")?.dataset.conversationUnitTailAdjacent).toBe("false");
  });

  it("lets a fast upward scroll own the viewport while late heights settle without clipping or rollback", () => {
    const harness = createRuntime();
    const values = units(100);
    harness.runtime.publish(values);
    harness.runtime.commitRenderedUnit(values[5]);
    harness.root.scrollTop = 400;
    harness.runtime.updateViewport();

    harness.runtime.setUserScrollInteraction(true);
    const mountedHost = harness.runtime.getUnitElement("unit-5")!;
    expect(mountedHost.dataset.conversationUnitScrollClip).toBeUndefined();
    expect(mountedHost.style.height).toBe("");
    expect(mountedHost.style.overflowY).toBe("");
    harness.root.scrollTop = 200;
    harness.root.dispatchEvent(new Event("scroll"));
    harness.scrollRequests.length = 0;
    const estimatedTotalHeight = harness.runtime.diagnostics().totalHeight;
    harness.runtime.updateMeasuredHeight("unit-0", 100);
    expect(harness.root.scrollTop).toBe(200);
    expect(harness.scrollRequests).toEqual([]);
    expect(harness.runtime.diagnostics()).toMatchObject({
      totalHeight: estimatedTotalHeight + 60,
      deferredMeasurements: 0,
    });

    harness.root.scrollTop = 40;
    harness.root.dispatchEvent(new Event("scroll"));
    harness.scrollRequests.length = 0;

    harness.runtime.updateMeasuredHeight("unit-0", 500);
    expect(harness.root.scrollTop).toBe(40);
    expect(harness.scrollRequests).toEqual([]);
    expect(harness.runtime.diagnostics()).toMatchObject({
      totalHeight: estimatedTotalHeight + 460,
      deferredMeasurements: 0,
      userScrollActive: true,
      topLocked: false,
    });
    expect(harness.runtime.getUnitElement("unit-0")).not.toBeNull();

    harness.runtime.setUserScrollInteraction(false);
    expect(harness.root.scrollTop).toBe(40);
    expect(harness.scrollRequests).toEqual([]);
    expect(harness.runtime.diagnostics().deferredMeasurements).toBe(0);
    harness.runtime.updateMeasuredHeight("unit-1", 400);
    expect(harness.runtime.diagnostics()).toMatchObject({ userScrollActive: false, topLocked: false });

    harness.runtime.setUserScrollInteraction(true);
    harness.root.scrollTop = 120;
    harness.root.dispatchEvent(new Event("scroll"));
    expect(harness.runtime.diagnostics().topLocked).toBe(false);
  });

  it("applies controlled-scroll measurements in the document runtime without moving the thumb", () => {
    const harness = createRuntime();
    harness.runtime.publish(units(100));
    harness.root.scrollTop = 800;
    harness.runtime.updateViewport();
    const totalHeight = harness.runtime.diagnostics().totalHeight;

    harness.runtime.setControlledScrollInteraction(true);
    harness.runtime.updateMeasuredHeight("unit-0", 200);
    harness.runtime.updateMeasuredHeight("unit-1", 300);

    expect(harness.runtime.diagnostics()).toMatchObject({
      totalHeight: totalHeight + 420,
      userScrollActive: false,
      controlledScrollActive: true,
      deferredMeasurements: 0,
    });

    // The runtime's ordinary 180ms user-scroll settlement must not release a
    // custom thumb which still owns the final seek commit.
    harness.runtime.setUserScrollInteraction(true);
    harness.runtime.setUserScrollInteraction(false);
    expect(harness.runtime.diagnostics()).toMatchObject({
      totalHeight: totalHeight + 420,
      userScrollActive: false,
      controlledScrollActive: true,
      deferredMeasurements: 0,
    });

    harness.scrollRequests.length = 0;
    harness.runtime.setControlledScrollInteraction(false);

    expect(harness.runtime.diagnostics()).toMatchObject({
      totalHeight: totalHeight + 420,
      controlledScrollActive: false,
      deferredMeasurements: 0,
    });
    expect(harness.scrollRequests).toEqual([]);
  });

  it("does not freeze the old controlled-scroll window between animation-frame commits", () => {
    const harness = createRuntime();
    harness.runtime.publish(units(1_000));
    const patchesAtStart = harness.runtime.diagnostics().patches;
    const mountedRanges: string[][] = [];

    harness.runtime.setControlledScrollInteraction(true);
    for (const scrollTop of [4_000, 12_000, 20_000, 30_000]) {
      harness.root.scrollTop = scrollTop;
      harness.root.dispatchEvent(new Event("scroll"));
      harness.runtime.settleControlledScrollViewport();
      mountedRanges.push([...harness.runtime.mountedUnitIds()]);
    }

    expect(harness.runtime.diagnostics()).toMatchObject({
      controlledScrollActive: true,
      userScrollActive: false,
    });
    expect(harness.runtime.diagnostics().patches).toBeGreaterThanOrEqual(patchesAtStart + 4);
    expect(new Set(mountedRanges.map((range) => range[0])).size).toBeGreaterThan(1);
    expect(harness.runtime.getUnitElement("unit-750")).not.toBeNull();
    expect(harness.runtime.getUnitElement("unit-100")).toBeNull();
    harness.runtime.setControlledScrollInteraction(false);
    expect(harness.runtime.diagnostics().controlledScrollActive).toBe(false);
  });

  it("detects native scrollbar movement from the scroll event even when Chromium omits pointerdown", () => {
    vi.useFakeTimers();
    const harness = createRuntime();
    harness.runtime.publish(units(100));
    harness.root.scrollTop = 400;
    harness.root.dispatchEvent(new Event("scroll"));
    const totalHeight = harness.runtime.diagnostics().totalHeight;

    expect(harness.runtime.diagnostics().userScrollActive).toBe(true);
    harness.runtime.updateMeasuredHeight("unit-0", 200);
    expect(harness.runtime.diagnostics()).toMatchObject({
      totalHeight: totalHeight + 160,
      deferredMeasurements: 0,
    });

    vi.advanceTimersByTime(180);
    expect(harness.runtime.diagnostics()).toMatchObject({
      userScrollActive: false,
      deferredMeasurements: 0,
      totalHeight: totalHeight + 160,
    });
    vi.useRealTimers();
  });

  it("does not classify a timeline-owned scroll request as a user scrollbar drag", () => {
    const harness = createRuntime({ followBottom: true });
    harness.runtime.publish(units(100));

    harness.root.dispatchEvent(new Event("scroll"));

    expect(harness.runtime.diagnostics().userScrollActive).toBe(false);
  });

  it("gives an upward gesture immediate ownership before follow-bottom state finishes committing", () => {
    const harness = createRuntime({ followBottom: true });
    harness.runtime.publish(units(100));

    harness.runtime.setUserScrollInteraction(true);
    harness.root.scrollTop = 40;
    harness.root.dispatchEvent(new Event("scroll"));
    harness.scrollRequests.length = 0;
    harness.runtime.updateMeasuredHeight("unit-0", 500);

    expect(harness.root.scrollTop).toBe(40);
    expect(harness.scrollRequests).toEqual([]);
    expect(harness.runtime.diagnostics()).toMatchObject({
      followBottom: true,
      userScrollActive: true,
      topLocked: false,
      deferredMeasurements: 0,
    });

    harness.runtime.setUserScrollInteraction(false);
    expect(harness.root.scrollTop).toBe(40);
    expect(harness.scrollRequests).toEqual([]);
  });

  it("enforces pin/identity contracts and destroys every local renderer", () => {
    const harness = createRuntime({ maxPinnedUnits: 1 });
    const values = units(100);
    harness.runtime.publish(values);
    harness.runtime.setPinned("unit-50", true);
    expect(() => harness.runtime.setPinned("unit-51", true)).toThrow(/exceed limit/u);
    expect(() => harness.runtime.publish([values[0], values[0]])).toThrow(/Duplicate conversation unit/u);
    const mounted = harness.runtime.diagnostics().mounted;
    const recycled = harness.runtime.diagnostics().recycled;
    harness.runtime.destroy();
    expect(harness.renderer.destroyed).toHaveLength(mounted + recycled);
    expect(harness.root.childElementCount).toBe(0);
    expect(() => harness.runtime.updateViewport()).toThrow(/destroyed/u);
  });
});

function createRuntime(options: {
  maxPinnedUnits?: number;
  followBottom?: boolean;
  applyScrollRequests?: boolean;
} = {}) {
  const root = document.createElement("div");
  Object.defineProperty(root, "clientHeight", { configurable: true, value: 600 });
  Object.defineProperty(root, "scrollTop", { configurable: true, writable: true, value: 0 });
  const updates: string[] = [];
  const destroyed: string[] = [];
  const scrollRequests: Array<{ scrollTop: number; reason: string }> = [];
  const renderer: ConversationTimelineUnitRenderer & {
    mount: ReturnType<typeof vi.fn>;
    updates: string[];
    destroyed: string[];
  } = {
    mount: vi.fn((entry: ConversationRenderUnit, host: HTMLElement) => {
      host.append(document.createElement("article"));
      host.firstElementChild!.textContent = entry.id;
      return {
        update(next: ConversationRenderUnit) {
          updates.push(next.id);
          host.firstElementChild!.textContent = next.renderVersion;
        },
        destroy() { destroyed.push(entry.id); },
      };
    }),
    updates,
    destroyed,
  };
  const runtime = new ConversationTimelineRuntime(root, {
    renderer,
    overscanPx: 200,
    maxPinnedUnits: options.maxPinnedUnits,
    observeMeasurements: false,
    followBottom: options.followBottom,
    onScrollRequest: (request) => {
      scrollRequests.push(request);
      if (options.applyScrollRequests !== false) root.scrollTop = request.scrollTop;
    },
  });
  return { root, runtime, renderer, scrollRequests };
}

function units(count: number): ConversationRenderUnit[] {
  return Array.from({ length: count }, (_, index) => unit(index));
}

function unit(index: number, kind: ConversationRenderUnitKind = "assistant-markdown"): ConversationRenderUnit {
  return {
    id: `unit-${index}`,
    kind,
    owner: kind.includes("markdown") ? "markdown-runtime" : "react",
    turnId: `turn-${Math.floor(index / 2)}`,
    turnIndex: Math.floor(index / 2),
    businessTurnIndex: Math.floor(index / 2),
    sourceMessageIds: [`message-${index}`],
    item: null,
    parentUnitId: null,
    dynamic: false,
    interactive: false,
    pinPolicy: "never",
    measurementPolicy: "estimate-once",
    estimatedHeight: 40,
    renderVersion: `version-${index}`,
  };
}
