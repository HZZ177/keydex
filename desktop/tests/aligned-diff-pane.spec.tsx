import { createRef } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import type { AlignedDiffPaneHandle } from "@/renderer/components/diff/aligned/AlignedDiffPane";
import { KeydexAlignedSplitDiff } from "@/renderer/components/diff/aligned/KeydexAlignedSplitDiff";

describe("Keydex aligned split pane foundation", () => {
  it("creates two distinct native scroll owners and a non-interactive connector lane", () => {
    const leftRef = createRef<AlignedDiffPaneHandle>();
    const rightRef = createRef<AlignedDiffPaneHandle>();
    const { container } = render(
      <KeydexAlignedSplitDiff
        left={<pre>left code</pre>}
        right={<pre>right code</pre>}
        connector={<svg data-testid="connector" />}
        edgeWidth={0.8}
        leftPaneRef={leftRef}
        rightPaneRef={rightRef}
      />,
    );
    const left = leftRef.current?.element;
    const right = rightRef.current?.element;
    expect(left).toBeInstanceOf(HTMLDivElement);
    expect(right).toBeInstanceOf(HTMLDivElement);
    expect(left).not.toBe(right);
    expect(left?.getAttribute("data-keydex-aligned-pane")).toBe("old");
    expect(right?.getAttribute("data-keydex-aligned-pane")).toBe("new");
    expect(container.querySelector('[data-keydex-aligned-connector-visual]')?.getAttribute("aria-hidden")).toBe("true");
    expect(container.querySelector('[data-keydex-aligned-connector]')?.getAttribute("data-keydex-aligned-viewport-sync")).toBe("stable");
    expect(screen.getByTestId("connector")).toBeTruthy();
    expect(container.querySelector<HTMLElement>('[data-keydex-aligned-split]')?.style
      .getPropertyValue("--keydex-diff-edge-width")).toBe("0.8px");
  });

  it("keeps vertical and horizontal positions independent", () => {
    const leftRef = createRef<AlignedDiffPaneHandle>();
    const rightRef = createRef<AlignedDiffPaneHandle>();
    render(
      <KeydexAlignedSplitDiff
        left={<div style={{ width: 2_000, height: 2_000 }} />}
        right={<div style={{ width: 2_000, height: 2_000 }} />}
        leftPaneRef={leftRef}
        rightPaneRef={rightRef}
      />,
    );
    const left = leftRef.current!.element!;
    const right = rightRef.current!.element!;
    left.scrollTop = 120;
    left.scrollLeft = 35;
    right.scrollTop = 45;
    right.scrollLeft = 80;
    fireEvent.scroll(left);
    expect(leftRef.current?.position()).toEqual({ top: 120, left: 35 });
    expect(rightRef.current?.position()).toEqual({ top: 45, left: 80 });
  });

  it("keeps empty pane space focusable, labelled and available for native input", () => {
    const onWheel = vi.fn();
    const { container } = render(
      <KeydexAlignedSplitDiff left={null} right={null} minHeight={360} />,
    );
    const root = container.querySelector<HTMLElement>('[data-keydex-aligned-split]')!;
    const left = screen.getByRole("region", { name: "修改前" });
    left.addEventListener("wheel", onWheel);
    fireEvent.wheel(left, { deltaY: 40 });
    expect(onWheel).toHaveBeenCalledOnce();
    expect(left.tabIndex).toBe(0);
    expect(left.querySelector('[data-keydex-aligned-pane-content]')).toBeTruthy();
    expect(root.style.getPropertyValue("--keydex-aligned-min-height")).toBe("360px");
  });

  it("shows one vertical scrollbar at the far-right pane while preserving both horizontal owners", () => {
    const css = readFileSync(
      resolve(process.cwd(), "src/renderer/components/diff/aligned/AlignedDiffPane.module.css"),
      "utf8",
    );
    expect(css).toMatch(/\.pane\[data-keydex-aligned-pane="old"\]\s*{[^}]*overflow-y:\s*hidden/s);
    expect(css).not.toMatch(/\.pane\[data-keydex-aligned-pane="new"\]\s*{[^}]*overflow-y:\s*hidden/s);
    expect(css).toMatch(/\.pane::\-webkit-scrollbar\s*{[^}]*height:\s*8px/s);
    expect(css).toMatch(/\.pane\s*{[^}]*container-type:\s*inline-size/s);
    expect(css).toMatch(/\.content\s*{[^}]*width:\s*max-content/s);
    expect(css).not.toMatch(/\.content\s*{[^}]*overflow:\s*clip/s);
  });

  it("renders fixed gutters as pane siblings so horizontal scrolling cannot move them", () => {
    const leftRef = createRef<AlignedDiffPaneHandle>();
    const rightRef = createRef<AlignedDiffPaneHandle>();
    const { container } = render(
      <KeydexAlignedSplitDiff
        left={<div style={{ width: 2_000 }}>left code</div>}
        right={<div style={{ width: 2_000 }}>right code</div>}
        leftGutter={<div>left lines</div>}
        rightGutter={<div>right lines</div>}
        leftGutterScrollTop={120}
        rightGutterScrollTop={240}
        connectorViewportHeight={300}
        leftPaneRef={leftRef}
        rightPaneRef={rightRef}
      />,
    );
    const leftGutter = container.querySelector<HTMLElement>('[data-keydex-aligned-gutter="old"]')!;
    const rightGutter = container.querySelector<HTMLElement>('[data-keydex-aligned-gutter="new"]')!;
    expect(leftRef.current!.element!.contains(leftGutter)).toBe(false);
    expect(rightRef.current!.element!.contains(rightGutter)).toBe(false);
    expect(leftGutter.firstElementChild?.getAttribute("style")).toContain("-120px");
    expect(rightGutter.firstElementChild?.getAttribute("style")).toContain("-240px");
    leftRef.current!.element!.scrollLeft = 400;
    rightRef.current!.element!.scrollLeft = 400;
    fireEvent.scroll(leftRef.current!.element!);
    fireEvent.scroll(rightRef.current!.element!);
    expect(leftGutter.firstElementChild?.getAttribute("style")).toContain("-120px");
    expect(rightGutter.firstElementChild?.getAttribute("style")).toContain("-240px");
  });

  it("keeps connector visuals and actions inside the code viewport above horizontal scrollbars", () => {
    const { container } = render(
      <KeydexAlignedSplitDiff
        left={null}
        right={null}
        connector={<svg />}
        connectorOverlay={<button type="button">change</button>}
        connectorViewportHeight={312}
      />,
    );
    const root = container.querySelector<HTMLElement>('[data-keydex-aligned-split]')!;
    expect(root.style.getPropertyValue("--keydex-aligned-connector-viewport-height")).toBe("312px");
    expect(root.getAttribute("data-keydex-aligned-connector-viewport-height")).toBe("312");

    const css = readFileSync(
      resolve(process.cwd(), "src/renderer/components/diff/aligned/KeydexAlignedSplitDiff.module.css"),
      "utf8",
    );
    expect(css).toMatch(/\.connectorVisual,\s*\.connectorActions\s*{[^}]*top:\s*0[^}]*height:\s*min\(100%,\s*var\(--keydex-aligned-connector-viewport-height/s);
    expect(css).not.toMatch(/\.connectorVisual,\s*\.connectorActions\s*{[^}]*inset:\s*0/s);
    expect(css).toMatch(/data-keydex-aligned-viewport-sync="pending"[^}]*\.connectorVisual,[\s\S]*?visibility:\s*hidden/s);
  });
});
