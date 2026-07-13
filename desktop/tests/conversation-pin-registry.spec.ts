import { describe, expect, it } from "vitest";

import { ConversationPinRegistry } from "@/renderer/pages/conversation/timeline/ConversationPinRegistry";
import { ConversationTimelineRuntime } from "@/renderer/pages/conversation/timeline/ConversationTimelineRuntime";
import type { ConversationRenderUnit } from "@/renderer/pages/conversation/timeline/ConversationRenderUnit";

describe("ConversationPinRegistry", () => {
  it("keeps a focused input mounted offscreen and releases it after focus leaves", async () => {
    const harness = createHarness(units(100));
    const input = document.createElement("input");
    harness.runtime.getUnitElement("unit-1")!.append(input);
    input.focus();
    await Promise.resolve();
    harness.runtime.updateViewport(3_600, 600);
    expect(harness.runtime.getUnitElement("unit-1")).not.toBeNull();
    expect(harness.registry.diagnostics().pinsByReason.focus).toBe(1);

    const outside = document.createElement("button");
    document.body.append(outside);
    outside.focus();
    await Promise.resolve();
    harness.runtime.updateViewport(3_600, 600);
    expect(harness.runtime.getUnitElement("unit-1")).toBeNull();
  });

  it("pins both endpoints of a cross-unit native selection without cloning hidden DOM", () => {
    const harness = createHarness(units(100));
    const first = harness.runtime.getUnitElement("unit-1")!;
    const second = harness.runtime.getUnitElement("unit-2")!;
    first.textContent = "alpha";
    second.textContent = "beta";
    const range = document.createRange();
    range.setStart(first.firstChild!, 1);
    range.setEnd(second.firstChild!, 3);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
    harness.runtime.updateViewport(3_600, 600);

    expect(harness.runtime.getUnitElement("unit-1")).not.toBeNull();
    expect(harness.runtime.getUnitElement("unit-2")).not.toBeNull();
    expect(harness.registry.diagnostics().pinsByReason.selection).toBe(2);
    expect(harness.root.querySelectorAll("[data-conversation-unit-id]").length).toBeLessThan(50);
  });

  it("pins dirty A2UI/form state through blur and clears it on submit", async () => {
    const values = units(100).map((unit, index) => index === 1
      ? { ...unit, kind: "a2ui" as const, interactive: true, pinPolicy: "while-interacting" as const }
      : unit);
    const harness = createHarness(values);
    const form = document.createElement("form");
    const input = document.createElement("input");
    form.append(input);
    harness.runtime.getUnitElement("unit-1")!.append(form);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    harness.runtime.updateViewport(3_600, 600);
    expect(harness.registry.diagnostics().pinsByReason["dirty-input"]).toBe(1);
    expect(harness.runtime.getUnitElement("unit-1")).not.toBeNull();

    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    harness.registry.sync(values.map((unit, index) => index === 1
      ? { ...unit, interactive: false, pinPolicy: "never" as const }
      : unit));
    await Promise.resolve();
    harness.runtime.updateViewport(3_600, 600);
    expect(harness.runtime.getUnitElement("unit-1")).toBeNull();
  });

  it("pins expanded tools and running commands, then releases both when state settles", () => {
    const values = units(100).map((unit, index) => index === 1
      ? { ...unit, kind: "tool" as const }
      : index === 2
        ? { ...unit, kind: "tool" as const, dynamic: true, pinPolicy: "while-active" as const }
        : unit);
    const harness = createHarness(values);
    const toggle = document.createElement("button");
    toggle.setAttribute("aria-expanded", "true");
    harness.runtime.getUnitElement("unit-1")!.append(toggle);
    harness.registry.sync(values);
    harness.runtime.updateViewport(3_600, 600);
    expect(harness.runtime.getUnitElement("unit-1")).not.toBeNull();
    expect(harness.runtime.getUnitElement("unit-2")).not.toBeNull();

    toggle.setAttribute("aria-expanded", "false");
    harness.registry.sync(values.map((unit, index) => index === 2
      ? { ...unit, dynamic: false, pinPolicy: "never" as const }
      : unit));
    harness.runtime.updateViewport(3_600, 600);
    expect(harness.runtime.getUnitElement("unit-1")).toBeNull();
    expect(harness.runtime.getUnitElement("unit-2")).toBeNull();
  });

  it("bounds multiple automatic pins, evicts only safe pins, and diagnoses rejected protected pins", async () => {
    const values = units(20).map((unit, index) => index < 4
      ? { ...unit, interactive: true, pinPolicy: "while-interacting" as const }
      : unit);
    const harness = createHarness(values, 2);
    expect(harness.registry.diagnostics()).toMatchObject({ pinned: 2, maxPins: 2, evicted: 2 });
    const firstPinned = harness.registry.diagnostics().unitIds[0];
    const input = document.createElement("input");
    harness.runtime.getUnitElement(firstPinned)!.append(input);
    input.focus();
    await Promise.resolve();
    harness.registry.pin("unit-10", "selection");
    harness.registry.pin("unit-11", "selection");
    expect(harness.registry.diagnostics().pinned).toBe(2);
    expect(harness.registry.diagnostics().rejected).toBeGreaterThanOrEqual(1);
  });
});

function createHarness(values: ConversationRenderUnit[], maxPins = 32) {
  const root = document.createElement("div");
  document.body.append(root);
  Object.defineProperties(root, {
    clientHeight: { configurable: true, value: 600 },
    scrollTop: { configurable: true, writable: true, value: 0 },
  });
  const runtime = new ConversationTimelineRuntime(root, {
    observeMeasurements: false,
    overscanPx: 200,
    renderer: {
      mount(unit, host) {
        const article = document.createElement("article");
        article.textContent = unit.id;
        host.append(article);
        return { update: () => undefined, destroy: () => undefined };
      },
    },
  });
  runtime.publish(values);
  const registry = new ConversationPinRegistry({ maxPins });
  registry.attach(root, runtime);
  registry.sync(values);
  return { root, runtime, registry };
}

function units(count: number): ConversationRenderUnit[] {
  return Array.from({ length: count }, (_, index) => ({
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
  }));
}
