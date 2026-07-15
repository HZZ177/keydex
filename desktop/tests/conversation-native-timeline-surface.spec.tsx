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
        onScrollRequest={(request) => {
          screen.getByTestId("message-list-scroll").scrollTop = request.scrollTop;
        }}
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

  it("delegates follow-bottom movement to the shared scroll owner", () => {
    const scrollRequests = vi.fn();
    const directScrollWrites: number[] = [];
    let scrollTop = 25;
    const first = streamingUnit("assistant-1", "streaming");
    const { rerender } = render(
      <ConversationNativeTimelineSurface
        units={[first]}
        renderUnit={(entry) => <span>{entry.renderVersion}</span>}
        followBottom
        onScrollRequest={scrollRequests}
        scrollerRef={(element) => {
          if (!element) return;
          Object.defineProperties(element, {
            clientHeight: { configurable: true, get: () => 200 },
            scrollHeight: { configurable: true, get: () => 1_000 },
            scrollTop: {
              configurable: true,
              get: () => scrollTop,
              set: (value: number) => {
                scrollTop = value;
                directScrollWrites.push(value);
              },
            },
          });
        }}
      />,
    );

    expect(scrollRequests).toHaveBeenLastCalledWith({ scrollTop: 800, reason: "follow-bottom" });
    expect(directScrollWrites).toEqual([]);
    expect(scrollTop).toBe(25);

    rerender(
      <ConversationNativeTimelineSurface
        units={[{ ...first, renderVersion: "streaming-more" }]}
        renderUnit={(entry) => <span>{entry.renderVersion}</span>}
        followBottom
        onScrollRequest={scrollRequests}
      />,
    );

    expect(scrollRequests).toHaveBeenLastCalledWith({ scrollTop: 800, reason: "follow-bottom" });
    expect(directScrollWrites).toEqual([]);
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

function streamingUnit(id: string, renderVersion: string): ConversationRenderUnit {
  return {
    id,
    kind: "assistant-markdown",
    owner: "markdown-runtime",
    turnId: "turn-1",
    turnIndex: 0,
    businessTurnIndex: 0,
    sourceMessageIds: [id],
    item: null,
    parentUnitId: null,
    dynamic: true,
    interactive: false,
    pinPolicy: "never",
    measurementPolicy: "observe-until-settled",
    estimatedHeight: 120,
    renderVersion,
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
