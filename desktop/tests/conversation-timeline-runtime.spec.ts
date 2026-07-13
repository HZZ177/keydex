import { describe, expect, it, vi } from "vitest";

import {
  ConversationTimelineRuntime,
  type ConversationTimelineUnitRenderer,
} from "@/renderer/pages/conversation/timeline/ConversationTimelineRuntime";
import type { ConversationRenderUnit, ConversationRenderUnitKind } from "@/renderer/pages/conversation/timeline/ConversationRenderUnit";

describe("ConversationTimelineRuntime", () => {
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
    harness.runtime.publish(units(10_000));
    const mountsBefore = harness.renderer.mount.mock.calls.length;
    const patch = harness.runtime.updateViewport(390_000, 600);

    expect(patch.viewport.visibleRange.start).toBeGreaterThan(9_700);
    expect(patch.mounted).toBeLessThanOrEqual(36);
    expect(harness.renderer.mount.mock.calls.length - mountsBefore).toBeLessThanOrEqual(36);
    expect(harness.runtime.getUnitElement("unit-5000")).toBeNull();
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

  it("reorders by key and resets a pooled slot before assigning another identity", () => {
    const harness = createRuntime();
    const initial = units(20);
    harness.runtime.publish(initial);
    const first = harness.runtime.getUnitElement("unit-0");
    const reordered = [initial[2], initial[1], initial[0], ...initial.slice(3, 18)];
    harness.runtime.publish(reordered);

    expect(harness.runtime.getUnitElement("unit-0")).toBe(first);
    expect(harness.runtime.getUnitElement("unit-19")).toBeNull();
    expect(harness.renderer.destroyed).not.toContain("unit-19");
    expect(harness.runtime.getUnitElement("unit-0")?.dataset.conversationUnitIndex).toBe("2");

    harness.runtime.publish([...reordered, unit(20)]);
    expect(harness.renderer.updates).toContain("unit-20");
    expect(harness.runtime.getUnitElement("unit-20")?.textContent).toBe("version-20");
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

  it("keeps estimated unit height in the index without forcing it onto the measured DOM box", () => {
    const harness = createRuntime();
    harness.runtime.publish([{ ...unit(0), estimatedHeight: 120 }]);

    const element = harness.runtime.getUnitElement("unit-0")!;
    expect(element.style.minHeight).toBe("");
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

function createRuntime(options: { maxPinnedUnits?: number } = {}) {
  const root = document.createElement("div");
  Object.defineProperty(root, "clientHeight", { configurable: true, value: 600 });
  Object.defineProperty(root, "scrollTop", { configurable: true, writable: true, value: 0 });
  const updates: string[] = [];
  const destroyed: string[] = [];
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
  });
  return { root, runtime, renderer };
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
