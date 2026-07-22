import { describe, expect, it } from "vitest";

import {
  planBrowserResources,
  type BrowserResourceCandidate,
} from "@/renderer/features/browser/runtime/BrowserResourceCoordinator";

function candidates(count: number): BrowserResourceCandidate[] {
  return Array.from({ length: count }, (_, index) => ({
    panelId: `panel-${index + 1}`,
    surface: { panelId: `panel-${index + 1}`, surfaceId: `surface-${index + 1}`, generation: 1 },
    active: index === count - 1,
    protected: false,
    lastUsed: index + 1,
  }));
}

describe("Browser resource coordinator", () => {
  it("keeps 21 metadata candidates at 5 warm/visible and 10 native surfaces", () => {
    const decisions = planBrowserResources(candidates(21));
    expect(decisions.filter((item) => item.next === "visible")).toHaveLength(1);
    expect(decisions.filter((item) => item.next === "warm")).toHaveLength(4);
    expect(decisions.filter((item) => item.next === "native_suspended")).toHaveLength(5);
    expect(decisions.filter((item) => item.next === "discarded")).toHaveLength(11);
  });

  it("discards the least recently used tab when an eleventh live surface arrives", () => {
    const decisions = planBrowserResources(candidates(11));
    expect(decisions.find((item) => item.panelId === "panel-1")?.next).toBe("discarded");
    expect(decisions.find((item) => item.panelId === "panel-11")?.next).toBe("visible");
    expect(decisions.filter((item) => item.next !== "discarded")).toHaveLength(10);
  });

  it("never suspends or discards protected downloads, permissions, drafts, selection, media, or navigation", () => {
    const input = candidates(14).map((candidate, index) => ({
      ...candidate,
      protected: index < 8,
    }));
    const decisions = planBrowserResources(input);
    for (const decision of decisions.filter((item) => item.protected)) {
      expect(decision.next).toBe("warm");
    }
  });

  it("memory pressure discards every inactive unprotected tab but keeps active and protected tabs", () => {
    const input = candidates(8).map((candidate, index) => ({
      ...candidate,
      protected: index === 2,
    }));
    const decisions = planBrowserResources(input, { memoryPressure: true });
    expect(decisions.find((item) => item.active)?.next).toBe("visible");
    expect(decisions.find((item) => item.protected)?.next).toBe("warm");
    expect(decisions.filter((item) => !item.active && !item.protected).every((item) => item.next === "discarded")).toBe(true);
  });
});
