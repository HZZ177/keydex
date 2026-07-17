import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConversationFollowController } from "@/renderer/pages/conversation/timeline/ConversationFollowController";
import { EXPANSION_SCROLL_LOCK_ATTR } from "@/renderer/pages/conversation/messages/useExpansionScrollAnchor";

describe("ConversationFollowController", () => {
  beforeEach(() => {
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(performance.now() + 1_000);
      return 1;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  it("follows initial content, token appends, typing backlog and completion while at bottom", () => {
    const harness = createHarness();
    harness.controller.setContentAvailable(true);
    expect(harness.element.scrollTop).toBe(800);
    expect(harness.controller.snapshot()).toMatchObject({
      mode: "bootstrapping-tail",
      bootstrapCommitted: false,
    });
    harness.controller.setTailReady(true);
    expect(harness.controller.snapshot()).toMatchObject({
      mode: "following-bottom",
      bootstrapCommitted: true,
    });
    for (const kind of ["token-append", "typing-backlog", "stream-complete"] as const) {
      harness.metrics.scrollHeight += 200;
      harness.controller.notifyContentMutation(kind);
      expect(harness.element.scrollTop).toBe(harness.metrics.scrollHeight - 200);
      expect(harness.controller.snapshot().mode).toBe("following-bottom");
    }
  });

  it("keeps the initial tail uncommitted through late height growth and exposes only the final bottom", () => {
    const harness = createHarness();
    harness.controller.setContentAvailable(true);

    harness.metrics.scrollHeight = 6_000;
    harness.controller.notifyContentMutation("timeline-publish");
    harness.metrics.scrollHeight = 8_600;
    harness.controller.notifyContentMutation("resource-resize");

    expect(harness.element.scrollTop).toBe(8_400);
    expect(harness.controller.snapshot()).toMatchObject({
      mode: "bootstrapping-tail",
      bootstrapCommitted: false,
      tailReady: false,
    });

    harness.controller.setTailReady(true);
    expect(harness.element.scrollTop).toBe(8_400);
    expect(harness.controller.snapshot()).toMatchObject({
      mode: "following-bottom",
      bootstrapCommitted: true,
      tailReady: true,
    });
  });

  it("detaches immediately on upward wheel and never lets later content steal the viewport", () => {
    const harness = createHarness();
    harness.controller.setContentAvailable(true);
    harness.controller.setTailReady(true);
    harness.element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -120 }));
    expect(harness.controller.snapshot()).toMatchObject({ mode: "user-detached", reason: "user-wheel-up" });
    harness.metrics.scrollHeight = 1_400;
    harness.controller.notifyContentMutation("token-append");
    harness.controller.notifyContentMutation("resource-resize");
    harness.controller.applyScrollRequest({ scrollTop: 1_200, reason: "follow-bottom-geometry" });
    expect(harness.element.scrollTop).toBe(800);
    expect(harness.controller.snapshot().showScrollToBottom).toBe(true);
  });

  it("does not consume the first upward wheel when tail geometry still reports the bottom", () => {
    const harness = createHarness();
    harness.controller.setContentAvailable(true);
    harness.controller.setTailReady(true);

    harness.element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -120 }));
    harness.element.scrollTop = 798;
    harness.element.dispatchEvent(new Event("scroll"));

    expect(harness.controller.snapshot()).toMatchObject({
      mode: "user-detached",
      reason: "user-wheel-up",
    });

    harness.element.scrollTop = 700;
    harness.element.dispatchEvent(new Event("scroll"));
    expect(harness.controller.snapshot().mode).toBe("user-detached");

    harness.element.scrollTop = 800;
    harness.element.dispatchEvent(new Event("scroll"));
    expect(harness.controller.snapshot()).toMatchObject({
      mode: "following-bottom",
      reason: "user-returned-bottom",
    });
  });

  it("resumes only after the user reaches bottom or explicitly presses scroll-to-bottom", () => {
    const harness = createHarness();
    harness.controller.setContentAvailable(true);
    harness.controller.setTailReady(true);
    harness.element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -120 }));
    harness.metrics.scrollHeight = 1_400;
    harness.element.scrollTop = 1_200;
    harness.element.dispatchEvent(new Event("scroll"));
    expect(harness.controller.snapshot().mode).toBe("following-bottom");
    harness.element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -120 }));
    harness.element.scrollTop = 600;
    harness.controller.scrollToBottom("auto");
    expect(harness.element.scrollTop).toBe(1_200);
    expect(harness.controller.snapshot().mode).toBe("following-bottom");
  });

  it("holds navigation ownership across late measurement and exits detached away from bottom", () => {
    const harness = createHarness();
    harness.controller.setContentAvailable(true);
    harness.controller.setTailReady(true);
    harness.controller.beginNavigation();
    harness.element.scrollTop = 240;
    harness.metrics.scrollHeight = 1_600;
    harness.controller.notifyContentMutation("resource-resize");
    expect(harness.element.scrollTop).toBe(240);
    expect(harness.controller.snapshot().mode).toBe("navigating-turn");
    harness.controller.endNavigation();
    expect(harness.controller.snapshot().mode).toBe("user-detached");
  });

  it("preserves explicit history-restore ownership and its prior detached state", () => {
    const harness = createHarness();
    harness.controller.setContentAvailable(true);
    harness.controller.setTailReady(true);
    harness.element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -120 }));
    harness.controller.beginHistoryRestore();
    harness.metrics.scrollHeight = 1_600;
    harness.element.scrollTop = 1_000;
    harness.controller.notifyContentMutation("timeline-publish");
    expect(harness.controller.snapshot().mode).toBe("restoring-history");
    expect(harness.element.scrollTop).toBe(1_000);
    harness.controller.endHistoryRestore();
    expect(harness.controller.snapshot().mode).toBe("user-detached");
  });

  it("suspends A2UI live updates and resumes the exact previous follow policy", () => {
    const harness = createHarness();
    harness.controller.setContentAvailable(true);
    harness.controller.setTailReady(true);
    harness.controller.suspend("a2ui-live");
    harness.metrics.scrollHeight = 1_300;
    harness.controller.notifyContentMutation("a2ui-live");
    expect(harness.element.scrollTop).toBe(800);
    expect(harness.controller.snapshot().mode).toBe("suspended");
    harness.controller.resume("a2ui-settled");
    expect(harness.controller.snapshot().mode).toBe("following-bottom");
    expect(harness.element.scrollTop).toBe(1_100);
  });

  it("does not fight expansion locks and catches up after the lock is released", () => {
    const harness = createHarness();
    harness.controller.setContentAvailable(true);
    harness.controller.setTailReady(true);
    harness.element.setAttribute(EXPANSION_SCROLL_LOCK_ATTR, "true");
    harness.metrics.scrollHeight = 1_300;
    harness.controller.notifyContentMutation("resource-resize");
    harness.controller.applyScrollRequest({ scrollTop: 1_100, reason: "follow-bottom-geometry" });
    expect(harness.element.scrollTop).toBe(800);
    expect(harness.controller.snapshot().reason).toContain("expansion-lock");
    harness.element.removeAttribute(EXPANSION_SCROLL_LOCK_ATTR);
    harness.controller.notifyContentMutation("resource-resize");
    expect(harness.element.scrollTop).toBe(1_100);
  });

  it("treats native scrollbar dragging as user detach and cleans listeners on destroy", () => {
    const harness = createHarness();
    harness.controller.setContentAvailable(true);
    harness.controller.setTailReady(true);
    harness.element.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, clientX: 98, clientY: 20 }));
    expect(harness.controller.snapshot()).toMatchObject({ mode: "user-detached", reason: "scrollbar-drag" });
    harness.controller.destroy();
    expect(() => harness.controller.notifyContentMutation("token-append")).toThrow(/destroyed/u);
  });

  it("gives an external controlled scrollbar the same follow ownership as the native thumb", () => {
    const harness = createHarness();
    harness.controller.setContentAvailable(true);
    harness.controller.setTailReady(true);

    harness.controller.beginScrollbarDrag("controlled-scrollbar-drag");
    harness.element.scrollTop = 400;
    harness.controller.endScrollbarDrag();
    expect(harness.controller.snapshot()).toMatchObject({
      mode: "user-detached",
      reason: "controlled-scrollbar-drag",
    });

    harness.controller.beginScrollbarDrag("controlled-scrollbar-drag");
    harness.element.scrollTop = 800;
    harness.controller.endScrollbarDrag();
    expect(harness.controller.snapshot()).toMatchObject({
      mode: "following-bottom",
      reason: "scrollbar-drag-ended-at-bottom",
    });
  });
});

function createHarness() {
  const element = document.createElement("div");
  const metrics = { scrollHeight: 1_000, clientHeight: 200 };
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, get: () => metrics.scrollHeight },
    clientHeight: { configurable: true, get: () => metrics.clientHeight },
    clientWidth: { configurable: true, value: 88 },
    offsetWidth: { configurable: true, value: 100 },
    scrollTop: { configurable: true, writable: true, value: 0 },
    getBoundingClientRect: {
      configurable: true,
      value: () => ({ top: 0, bottom: 200, left: 0, right: 100, width: 100, height: 200 }),
    },
  });
  const controller = new ConversationFollowController();
  controller.attach(element);
  return { controller, element, metrics };
}
