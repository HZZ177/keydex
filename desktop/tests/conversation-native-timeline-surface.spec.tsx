import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ConversationRenderUnit } from "@/renderer/pages/conversation/timeline/ConversationRenderUnit";
import { dispatchConversationGeometryCommit } from "@/renderer/pages/conversation/timeline/ConversationGeometryCommit";
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

  it("coalesces streamed content resizes into one follow-bottom correction per frame", () => {
    let resizeCallback: ResizeObserverCallback | null = null;
    let scheduledFrame: FrameRequestCallback | null = null;
    class TestResizeObserver implements ResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", TestResizeObserver);
    const animationFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      scheduledFrame = callback;
      return 1;
    });
    const scrollRequests = vi.fn();
    let scrollHeight = 1_000;

    try {
      render(
        <ConversationNativeTimelineSurface
          units={[streamingUnit("assistant-1", "streaming")]}
          renderUnit={(entry) => <span>{entry.renderVersion}</span>}
          followBottom
          onScrollRequest={scrollRequests}
          scrollerRef={(element) => {
            if (!element) return;
            Object.defineProperties(element, {
              clientHeight: { configurable: true, get: () => 200 },
              scrollHeight: { configurable: true, get: () => scrollHeight },
              scrollTop: { configurable: true, writable: true, value: 800 },
            });
          }}
        />,
      );
      const content = screen.getByTestId("message-list-scroll")
        .querySelector<HTMLElement>("[data-conversation-native-timeline-content]")!;
      vi.spyOn(content, "getBoundingClientRect").mockImplementation(() => rect(0, scrollHeight));
      scrollRequests.mockClear();
      animationFrame.mockClear();
      scrollHeight = 1_040;

      act(() => {
        resizeCallback?.([], {} as ResizeObserver);
        resizeCallback?.([], {} as ResizeObserver);
      });

      expect(scrollRequests).not.toHaveBeenCalled();
      expect(animationFrame).toHaveBeenCalledTimes(1);

      act(() => {
        scheduledFrame?.(0);
      });

      expect(scrollRequests).toHaveBeenLastCalledWith({ scrollTop: 840, reason: "follow-bottom" });
      expect(scrollRequests).toHaveBeenCalledTimes(1);
    } finally {
      animationFrame.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("targets the exact native bottom for Markdown geometry before the ResizeObserver fallback frame", () => {
    const scrollRequests = vi.fn();
    let scrollTop = 800;
    let scrollHeight = 1_040;
    const { rerender } = render(
      <ConversationNativeTimelineSurface
        units={[streamingUnit("assistant-1", "streaming")]}
        renderUnit={(entry) => <span>{entry.renderVersion}</span>}
        followBottom
        onScrollRequest={scrollRequests}
        scrollerRef={(element) => {
          if (!element) return;
          Object.defineProperties(element, {
            clientHeight: { configurable: true, value: 200 },
            scrollHeight: { configurable: true, get: () => scrollHeight },
            scrollTop: {
              configurable: true,
              get: () => scrollTop,
              set: (value: number) => {
                scrollTop = value;
              },
            },
          });
        }}
      />,
    );
    const root = screen.getByTestId("message-list-scroll");
    const source = root.querySelector<HTMLElement>("[data-conversation-unit-id]")!;
    scrollRequests.mockClear();

    act(() => {
      dispatchConversationGeometryCommit(source, {
        messageId: "assistant-1",
        revision: "geometry-2",
        phase: "measurement",
        previousHeight: 120,
        height: 160,
        delta: 40,
      });
    });

    expect(scrollRequests).toHaveBeenCalledTimes(1);
    expect(scrollRequests).toHaveBeenLastCalledWith({
      scrollTop: 840,
      reason: "follow-bottom-geometry",
    });

    // Browser range clamping happens as soon as scrollHeight shrinks. The
    // geometry handler must keep that new bottom instead of subtracting the
    // same delta a second time (809 - 31 = 778).
    scrollHeight = 1_009;
    scrollTop = 809;
    scrollRequests.mockClear();
    act(() => {
      dispatchConversationGeometryCommit(source, {
        messageId: "assistant-1",
        revision: "geometry-shrink",
        phase: "measurement",
        previousHeight: 160,
        height: 129,
        delta: -31,
      });
    });
    expect(scrollRequests).toHaveBeenLastCalledWith({
      scrollTop: 809,
      reason: "follow-bottom-geometry",
    });

    rerender(
      <ConversationNativeTimelineSurface
        units={[streamingUnit("assistant-1", "streaming-more")]}
        renderUnit={(entry) => <span>{entry.renderVersion}</span>}
        followBottom={false}
        onScrollRequest={scrollRequests}
      />,
    );
    scrollRequests.mockClear();
    act(() => {
      dispatchConversationGeometryCommit(source, {
        messageId: "assistant-1",
        revision: "geometry-3",
        phase: "measurement",
        previousHeight: 160,
        height: 200,
        delta: 40,
      });
    });
    expect(scrollRequests).not.toHaveBeenCalled();
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
