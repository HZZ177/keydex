import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { AlignedDiffPaneHandle } from "@/renderer/components/diff/aligned/AlignedDiffPane";
import { KeydexAlignedSplitDiff } from "@/renderer/components/diff/aligned/KeydexAlignedSplitDiff";
import {
  alignedDiffBottomScrollSpace,
  alignedHorizontalWheelDelta,
  alignedVerticalWheelDelta,
  applyAlignedDiffPaneHorizontalWheel,
  applyAlignedDiffPaneVerticalWheel,
  shouldChainAlignedDiffVerticalWheel,
} from "@/renderer/components/diff/aligned/alignedPaneScroll";

describe("aligned pane nested and blank-area scrolling", () => {
  it("reserves thirty percent of the viewport below long files only", () => {
    expect(alignedDiffBottomScrollSpace(1_200, 800)).toBe(240);
    expect(alignedDiffBottomScrollSpace(800, 800)).toBe(0);
    expect(alignedDiffBottomScrollSpace(300, 800)).toBe(0);
    expect(alignedDiffBottomScrollSpace(Number.NaN, 800)).toBe(0);
  });

  it("converts Shift-wheel with a fine capped step and leaves native horizontal input untouched", () => {
    const left = pane(320, 900, 300, 1_000);
    const right = pane(320, 900, 300, 1_000);
    expect(applyAlignedDiffPaneHorizontalWheel(left, wheel({ deltaY: 3, deltaMode: 1, shiftKey: true }))).toBe(true);
    expect(left.scrollLeft).toBe(24);
    expect(right.scrollLeft).toBe(0);
    expect(applyAlignedDiffPaneHorizontalWheel(right, wheel({ deltaX: 70, deltaY: 2 }))).toBe(false);
    expect(right.scrollLeft).toBe(0);
    expect(alignedHorizontalWheelDelta(wheel({ deltaY: 120, shiftKey: true }), 320)).toBe(32);
    expect(alignedHorizontalWheelDelta(wheel({ deltaY: -120, shiftKey: true }), 320)).toBe(-32);
    expect(alignedHorizontalWheelDelta(wheel({ deltaY: 1, deltaMode: 2, shiftKey: true }), 320)).toBe(32);
  });

  it("leaves ordinary vertical wheels native and chains only parent-at-edge hosts", () => {
    const target = pane(320, 900, 300, 1_000);
    target.scrollTop = 100;
    expect(alignedHorizontalWheelDelta(wheel({ deltaY: 80 }), 320)).toBe(0);
    expect(alignedVerticalWheelDelta(wheel({ deltaY: 80 }), 300)).toBe(80);
    expect(shouldChainAlignedDiffVerticalWheel(target, 80, "parent_at_edge")).toBe(false);
    target.scrollTop = 700;
    expect(shouldChainAlignedDiffVerticalWheel(target, 80, "parent_at_edge")).toBe(true);
    expect(shouldChainAlignedDiffVerticalWheel(target, 80, "contain")).toBe(false);
    target.scrollTop = 0;
    expect(shouldChainAlignedDiffVerticalWheel(target, -30, "parent_at_edge")).toBe(true);
  });

  it("manually scrolls the scrollbar-free old pane with vertical wheel input", () => {
    const target = pane(320, 900, 300, 1_000);
    expect(applyAlignedDiffPaneVerticalWheel(target, wheel({ deltaY: 3, deltaMode: 1 }))).toBe(true);
    expect(target.scrollTop).toBe(48);
    expect(applyAlignedDiffPaneVerticalWheel(target, wheel({ deltaY: 1, shiftKey: true }))).toBe(false);
    target.scrollTop = 700;
    expect(applyAlignedDiffPaneVerticalWheel(target, wheel({ deltaY: 40 }))).toBe(false);
  });

  it("does not consume horizontal input at a pane boundary", () => {
    const target = pane(320, 900, 300, 1_000);
    target.scrollLeft = 580;
    expect(applyAlignedDiffPaneHorizontalWheel(target, wheel({ deltaX: 40 }))).toBe(false);
    expect(target.scrollLeft).toBe(580);
  });

  it("applies host-specific chaining attributes and keeps both panes independent", () => {
    const leftRef = createRef<AlignedDiffPaneHandle>();
    const rightRef = createRef<AlignedDiffPaneHandle>();
    const { rerender } = render(
      <KeydexAlignedSplitDiff
        left={<div style={{ width: 2_000 }} />}
        right={<div style={{ width: 2_000 }} />}
        leftPaneRef={leftRef}
        rightPaneRef={rightRef}
        scrollChaining="parent_at_edge"
      />,
    );
    expect(screen.getByRole("region", { name: "修改前" }).getAttribute("data-scroll-chaining"))
      .toBe("parent_at_edge");
    expect(screen.getByRole("region", { name: "修改后" }).getAttribute("data-scroll-chaining"))
      .toBe("parent_at_edge");

    const left = leftRef.current!.element!;
    Object.defineProperties(left, {
      clientWidth: { configurable: true, value: 320 },
      scrollWidth: { configurable: true, value: 1_000 },
    });
    fireEvent.wheel(left, { deltaY: 60, shiftKey: true });
    expect(left.scrollLeft).toBe(32);
    expect(rightRef.current!.element!.scrollLeft).toBe(0);

    rerender(<KeydexAlignedSplitDiff left={null} right={null} scrollChaining="contain" />);
    expect(screen.getByRole("region", { name: "修改前" }).getAttribute("data-scroll-chaining"))
      .toBe("contain");
  });
});

function pane(clientWidth: number, scrollWidth: number, clientHeight: number, scrollHeight: number) {
  return { scrollTop: 0, scrollLeft: 0, clientWidth, scrollWidth, clientHeight, scrollHeight };
}

function wheel({
  deltaX = 0,
  deltaY = 0,
  deltaMode = 0,
  shiftKey = false,
}: {
  readonly deltaX?: number;
  readonly deltaY?: number;
  readonly deltaMode?: number;
  readonly shiftKey?: boolean;
}) {
  return { deltaX, deltaY, deltaMode, shiftKey };
}
