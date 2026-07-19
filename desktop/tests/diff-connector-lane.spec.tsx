import { render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  DiffConnectorLane,
  diffConnectorEdgePathData,
  diffConnectorPathData,
  diffConnectorZeroEdgePathData,
} from "@/renderer/components/diff/aligned/DiffConnectorLane";
import type { DiffConnectorGeometry } from "@/renderer/components/diff/aligned/alignedDiffModel";

const modified: DiffConnectorGeometry = Object.freeze({
  changeId: "change:1",
  kind: "modified",
  leftStart: 10.25,
  leftEnd: 40.5,
  rightStart: 18.75,
  rightEnd: 32.125,
  clippedTop: false,
  clippedBottom: true,
});

describe("Keydex SVG connector lane", () => {
  it("builds a stable closed cubic path without rounding sub-pixels", () => {
    expect(diffConnectorPathData(modified)).toBe(
      "M 0 10.75 C 36 10.75 64 19.25 100 19.25 L 100 31.625 C 64 31.625 36 40 0 40 Z",
    );
    expect(diffConnectorEdgePathData(modified)).toEqual([
      "M 0 10.75 C 36 10.75 64 19.25 100 19.25",
      "M 0 40 C 36 40 64 31.625 100 31.625",
    ]);
    expect(diffConnectorZeroEdgePathData(modified)).toBeNull();
    expect(() => diffConnectorPathData({ ...modified, leftStart: Number.NaN })).toThrow(TypeError);
  });

  it("renders visible geometry as an assistive-hidden, non-focusable SVG", () => {
    const added = {
      ...modified,
      changeId: "change:2",
      kind: "added" as const,
      leftStart: 64,
      leftEnd: 64,
    };
    const { container } = render(
      <DiffConnectorLane geometry={[modified, added]} height={220.5} activeChangeId="change:1" />,
    );
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("focusable")).toBe("false");
    expect(svg.getAttribute("viewBox")).toBe("0 0 100 220.5");
    expect(container.querySelectorAll("g")).toHaveLength(2);
    expect(container.querySelector("linearGradient")).toBeNull();
    expect(container.querySelector('[data-change-id="change:1"] path')?.getAttribute("style"))
      .toBeNull();
    expect(container.querySelector('[data-change-id="change:1"]')?.getAttribute("data-active")).toBe("true");
    expect(container.querySelector('[data-change-id="change:2"]')?.getAttribute("data-kind")).toBe("added");
    expect(container.querySelectorAll('[data-change-id="change:1"] path')).toHaveLength(3);
    expect(container.querySelectorAll('[data-change-id="change:1"] [data-connector-edge]')).toHaveLength(2);
    const insertionSurface = container.querySelector('[data-change-id="change:2"] [data-connector-fill]');
    expect(insertionSurface?.getAttribute("d")).toBe(
      "M 0 63.5 C 36 63.5 64 19.25 100 19.25 L 100 31.625 C 64 31.625 36 64.5 0 64.5 Z",
    );
    expect(insertionSurface?.getAttribute("d")).not.toContain("-10000");
    expect(container.querySelector('[data-change-id="change:2"] [data-connector-zero-edge="old"]')?.getAttribute("d"))
      .toBe("M -10000 64 L 0 64");
    expect(container.querySelector('[data-change-id="change:2"] [data-connector-edge="end"]')?.getAttribute("d"))
      .toBe("M 0 64.5 C 36 64.5 64 31.625 100 31.625");
    expect(container.querySelector('[data-change-id="change:2"] [data-side="old"]')).toBeNull();
  });

  it("aligns connector centers and strokes to one physical pixel", () => {
    const { container } = render(
      <DiffConnectorLane geometry={[modified]} height={100} edgeWidth={0.8} />,
    );
    const svg = container.querySelector<SVGElement>("svg")!;
    expect(svg.style.getPropertyValue("--keydex-diff-edge-width")).toBe("0.8px");
    expect(container.querySelector('[data-connector-edge="start"]')?.getAttribute("d")).toBe(
      "M 0 10.65 C 36 10.65 64 19.15 100 19.15",
    );
    expect(container.querySelector('[data-connector-edge="end"]')?.getAttribute("d")).toBe(
      "M 0 40.1 C 36 40.1 64 31.725 100 31.725",
    );
  });

  it("renders a zero-height deletion edge as part of the same filled surface", () => {
    const removed = {
      ...modified,
      kind: "removed" as const,
      rightStart: 90,
      rightEnd: 90,
    };
    const { container } = render(<DiffConnectorLane geometry={[removed]} height={160} />);
    expect(container.querySelector('[data-change-id="change:1"] [data-connector-fill]')?.getAttribute("d")).toBe(
      "M 0 10.75 C 36 10.75 64 89.5 100 89.5 L 100 90.5 C 64 90.5 36 40 0 40 Z",
    );
    expect(container.querySelector('[data-change-id="change:1"] [data-connector-fill]')?.getAttribute("d"))
      .not.toContain("10100");
    expect(container.querySelector('[data-change-id="change:1"] [data-connector-zero-edge="new"]')?.getAttribute("d"))
      .toBe("M 100 90 L 10100 90");
    expect(container.querySelector('[data-change-id="change:1"] [data-connector-edge="end"]')?.getAttribute("d"))
      .toBe("M 0 40 C 36 40 64 90.5 100 90.5");
    expect(container.querySelector('[data-side="new"]')).toBeNull();
  });

  it("updates and removes connector paths without retaining stale changes", () => {
    const added = { ...modified, changeId: "change:2", kind: "added" as const };
    const { container, rerender } = render(<DiffConnectorLane geometry={[modified]} height={200} />);
    expect(container.querySelector('[data-change-id="change:1"]')).toBeTruthy();
    rerender(<DiffConnectorLane geometry={[added]} height={180} hoveredChangeId="change:2" />);
    expect(container.querySelector('[data-change-id="change:1"]')).toBeNull();
    expect(container.querySelector('[data-change-id="change:2"]')?.getAttribute("data-hovered")).toBe("true");
    expect(container.querySelector("svg")?.getAttribute("viewBox")).toBe("0 0 100 180");
  });

  it("keeps scrolling geometry free of path interpolation and pointer interception", () => {
    const css = readFileSync(
      resolve(process.cwd(), "src/renderer/components/diff/aligned/DiffConnectorLane.module.css"),
      "utf8",
    );
    expect(css).toMatch(/\.lane\s*{[^}]*pointer-events:\s*none/s);
    expect(css).toMatch(/\.lane\s*{[^}]*shape-rendering:\s*geometricPrecision/s);
    expect(css).toMatch(/\.fill\s*{[^}]*transition:\s*none/s);
    expect(css).toMatch(/\.change\s*{[^}]*opacity:\s*1/s);
    expect(css).toMatch(/\.fill\s*{[^}]*fill:\s*var\(--diff-modified-bg\)/s);
    expect(css).toMatch(/\.lane\s*{[^}]*overflow:\s*visible/s);
    expect(css).toMatch(/\.fill\s*{[^}]*stroke:\s*none/s);
    expect(css).toMatch(/\.edge\s*{[^}]*stroke:\s*var\(--diff-aligned-change-edge\)[^}]*stroke-width:\s*var\(--keydex-diff-edge-width,\s*1px\)/s);
    expect(css).toMatch(/\.edge\s*{[^}]*stroke-linecap:\s*butt/s);
    expect(css).toMatch(/data-kind="added"\] \.fill\s*{[^}]*fill:\s*var\(--diff-added-bg\)/s);
    expect(css).toMatch(/data-kind="added"\] \.edge\s*{[^}]*stroke:\s*var\(--diff-aligned-added-edge\)/s);
    expect(css).toMatch(/data-kind="removed"\] \.fill\s*{[^}]*fill:\s*var\(--diff-removed-bg\)/s);
    expect(css).toMatch(/data-kind="removed"\] \.edge\s*{[^}]*stroke:\s*var\(--diff-aligned-removed-edge\)/s);
    expect(css).not.toContain("leftEdge");
    expect(css).not.toContain("rightEdge");
    expect(css).not.toContain("zeroAnchor");
    expect(css).not.toContain("filter:");
    expect(css).not.toContain("linearGradient");
    expect(css).not.toMatch(/transition:\s*d\b/u);
  });
});
