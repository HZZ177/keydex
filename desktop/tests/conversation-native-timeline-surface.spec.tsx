import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ConversationRenderUnit } from "@/renderer/pages/conversation/timeline/ConversationRenderUnit";
import { ConversationNativeTimelineSurface } from "@/renderer/pages/conversation/timeline/ConversationNativeTimelineSurface";
import type { ConversationTimelineSurfaceHandle } from "@/renderer/pages/conversation/timeline/ConversationTimelineSurface";

describe("ConversationNativeTimelineSurface", () => {
  it("keeps every ordinary unit in native flow and navigates by real DOM geometry", () => {
    const units = [unit(0), unit(1), unit(2)];
    const runtimeRef: { current: ConversationTimelineSurfaceHandle | null } = { current: null };
    render(
      <ConversationNativeTimelineSurface
        units={units}
        runtimeRef={runtimeRef}
        renderUnit={(entry) => <div>{entry.id}</div>}
      />,
    );

    const root = screen.getByTestId("message-list-scroll") as HTMLDivElement;
    Object.defineProperties(root, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, value: 400 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });
    vi.spyOn(root, "getBoundingClientRect").mockImplementation(() => rect(0, 200));
    const absoluteTops = [0, 100, 250];
    const heights = [100, 150, 150];
    units.forEach((entry, index) => {
      const host = runtimeRef.current!.getUnitElement(entry.id)!;
      vi.spyOn(host, "getBoundingClientRect").mockImplementation(
        () => rect(absoluteTops[index] - root.scrollTop, heights[index]),
      );
      expect(host.style.position).toBe("");
      expect(host.style.height).toBe("");
      expect(host.style.overflowY).toBe("");
      expect(host.style.visibility).toBe("");
    });

    expect(runtimeRef.current?.mountedUnitIds()).toEqual(units.map((entry) => entry.id));
    expect(runtimeRef.current?.revealUnit("unit-1", "start")).toBe(true);
    expect(root.scrollTop).toBe(100);

    const anchor = runtimeRef.current?.captureAnchor(0);
    expect(anchor).toMatchObject({ unitId: "unit-1", offsetWithinUnit: 0, viewportOffset: 0 });
    absoluteTops[1] = 180;
    absoluteTops[2] = 330;
    expect(runtimeRef.current?.restoreAnchor(anchor!)).toBe(true);
    expect(root.scrollTop).toBe(180);
  });
});

function unit(index: number): ConversationRenderUnit {
  return {
    id: `unit-${index}`,
    kind: index % 2 === 0 ? "assistant-markdown" : "user-markdown",
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
    estimatedHeight: 100,
    renderVersion: `version-${index}`,
  };
}

function rect(top: number, height: number): DOMRect {
  return {
    bottom: top + height,
    height,
    left: 0,
    right: 800,
    top,
    width: 800,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}
