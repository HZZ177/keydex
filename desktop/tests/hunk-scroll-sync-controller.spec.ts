import { describe, expect, it, vi } from "vitest";

import {
  HunkScrollSyncController,
  type DiffScrollablePane,
} from "@/renderer/components/diff/aligned/HunkScrollSyncController";

class FakePane extends EventTarget implements DiffScrollablePane {
  scrollLeft = 0;
  scrollWidth = 1_000;
  clientWidth = 400;
  private top = 0;
  writes = 0;
  dispatchOnWrite = true;

  get scrollTop() {
    return this.top;
  }

  set scrollTop(value: number) {
    this.top = value;
    this.writes += 1;
    if (this.dispatchOnWrite) this.dispatchEvent(new Event("scroll"));
  }

  userScroll(value: number) {
    this.top = value;
    this.dispatchEvent(new Event("scroll"));
  }

  userHorizontalScroll(value: number) {
    this.scrollLeft = value;
    this.dispatchEvent(new Event("scroll"));
  }
}

function harness(enabled = true) {
  const left = new FakePane();
  const right = new FakePane();
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  const estimatedTargets: Array<{ epoch: number; targetSide: "old" | "new" }> = [];
  const controller = new HunkScrollSyncController({
    left,
    right,
    enabled,
    mapOffset: (side, offset) => side === "old" ? offset * 2 : offset / 2,
    requestFrame: (callback) => {
      const id = ++frameId;
      frames.set(id, callback);
      return id;
    },
    cancelFrame: (id) => { frames.delete(id); },
    onEstimatedTarget: ({ epoch, targetSide }) => estimatedTargets.push({ epoch, targetSide }),
  });
  const flush = () => {
    const pending = [...frames.entries()];
    frames.clear();
    for (const [, callback] of pending) callback(0);
  };
  return { left, right, frames, controller, flush, estimatedTargets };
}

describe("HunkScrollSyncController", () => {
  it("can commit both panes in the source scroll event without an intermediate frame", () => {
    const left = new FakePane();
    const right = new FakePane();
    const requestFrame = vi.fn(() => 1);
    const controller = new HunkScrollSyncController({
      left,
      right,
      synchronizationMode: "immediate",
      mapOffset: (_side, offset) => offset,
      requestFrame,
    });
    left.userScroll(36);
    expect(right.scrollTop).toBe(36);
    expect(requestFrame).not.toHaveBeenCalled();
    controller.destroy();
  });

  it("coalesces high-frequency scroll into one target write per frame", () => {
    const { left, right, frames, flush } = harness();
    left.userScroll(10);
    left.userScroll(20);
    left.userScroll(30);
    expect(frames.size).toBe(1);
    flush();
    expect(right.scrollTop).toBe(60);
    expect(right.writes).toBe(1);
    expect(frames.size).toBe(0);
  });

  it("suppresses recursive target scroll events and synchronizes horizontal offsets", () => {
    const { left, right, frames, flush } = harness();
    left.scrollLeft = 15;
    right.scrollLeft = 47;
    left.userScroll(12);
    flush();
    expect(right.scrollTop).toBe(24);
    expect(left.writes).toBe(0);
    expect(frames.size).toBe(0);
    expect(left.scrollLeft).toBe(15);
    expect(right.scrollLeft).toBe(15);
  });

  it("synchronizes a horizontal-only gesture and clamps it to the target width", () => {
    const { left, right, flush } = harness();
    left.userScroll(120);
    flush();
    expect(right.scrollTop).toBe(240);
    left.userHorizontalScroll(320);
    flush();
    expect(right.scrollLeft).toBe(320);
    expect(left.scrollTop).toBe(120);
    expect(right.scrollTop).toBe(240);
    left.userHorizontalScroll(900);
    flush();
    expect(right.scrollLeft).toBe(600);
    expect(left.scrollTop).toBe(120);
    expect(right.scrollTop).toBe(240);
  });

  it("hands master ownership to wheel, scrollbar, keyboard and alternating panes", () => {
    const { left, right, controller, flush } = harness();
    left.dispatchEvent(new WheelEvent("wheel"));
    expect(controller.masterSide).toBe("old");
    right.dispatchEvent(new Event("pointerdown"));
    expect(controller.masterSide).toBe("new");
    left.dispatchEvent(new KeyboardEvent("keydown", { key: "PageDown" }));
    expect(controller.masterSide).toBe("old");
    right.userScroll(80);
    flush();
    expect(controller.masterSide).toBe("new");
    expect(left.scrollTop).toBe(40);
  });

  it("supports disabled independence and re-aligns from the latest master when enabled", () => {
    const { left, right, controller, frames, flush } = harness(false);
    left.userScroll(25);
    expect(frames.size).toBe(0);
    expect(right.scrollTop).toBe(0);
    controller.setEnabled(true);
    expect(frames.size).toBe(1);
    flush();
    expect(right.scrollTop).toBe(50);
    controller.setEnabled(false);
    right.userScroll(200);
    expect(left.scrollTop).toBe(25);
  });

  it("supports programmatic navigation, tolerance and full cleanup", () => {
    const { left, right, controller, frames, flush } = harness();
    controller.scrollTo("old", 20, 33);
    expect(left.scrollLeft).toBe(33);
    flush();
    expect(right.scrollTop).toBe(40);
    right.userScroll(40.2);
    flush();
    expect(left.scrollTop).toBe(20);
    controller.destroy();
    left.userScroll(90);
    expect(frames.size).toBe(0);
    expect(right.scrollTop).toBeCloseTo(40.2);
  });

  it("applies one measured correction for the latest estimated target without feedback", () => {
    const { left, right, controller, flush, frames, estimatedTargets } = harness();
    left.userScroll(30);
    flush();
    const transaction = estimatedTargets.at(-1)!;
    expect(right.scrollTop).toBe(60);
    expect(controller.correctEstimatedTarget(transaction.epoch, "new", 74)).toBe(true);
    expect(right.scrollTop).toBe(74);
    expect(frames.size).toBe(0);
    expect(controller.correctEstimatedTarget(transaction.epoch, "new", 80)).toBe(false);
  });

  it("rejects stale, wrong-pane and within-tolerance virtual corrections", () => {
    const { left, controller, flush, estimatedTargets } = harness();
    left.userScroll(10);
    flush();
    const stale = estimatedTargets.at(-1)!;
    left.userScroll(20);
    expect(controller.correctEstimatedTarget(stale.epoch, "new", 99)).toBe(false);
    flush();
    const current = estimatedTargets.at(-1)!;
    expect(controller.correctEstimatedTarget(current.epoch, "old", 99)).toBe(false);
    expect(controller.correctEstimatedTarget(current.epoch, "new", 40.2)).toBe(false);
  });
});
