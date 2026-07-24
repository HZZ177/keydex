import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { workbenchBrowserInteractiveResizeInput } from "@/renderer/pages/workbench/WorkbenchModePage";
import {
  logicalRectFromDomRect,
  resolveBrowserSurfaceVisibility,
} from "@/renderer/features/browser/ui";

describe("workbench browser surface geometry", () => {
  it("maps the left workspace-tree resize into bounded native interactive deltas", () => {
    expect(workbenchBrowserInteractiveResizeInput(300, 1_200, 1_000)).toEqual({
      placement: "left",
      startScreenX: 1_200,
      minDelta: -80,
      maxDelta: 380,
    });
    expect(workbenchBrowserInteractiveResizeInput(220, 600, 500)).toEqual({
      placement: "left",
      startScreenX: 600,
      minDelta: 0,
      maxDelta: 0,
    });
  });

  it("keeps workbench native geometry in CSS logical pixels across DPI scales", () => {
    const rect = { x: 420.5, y: 82.25, width: 780.75, height: 641.5 };
    for (const _displayScale of [1, 1.25, 1.5, 2]) {
      expect(logicalRectFromDomRect(rect)).toEqual(rect);
    }
  });

  it("hides zero-area and inactive workbench browser surfaces", () => {
    const baseline = {
      active: true,
      documentVisible: true,
      hasPositiveArea: true,
      occlusionCount: 0,
      resourceState: "visible" as const,
    };

    expect(resolveBrowserSurfaceVisibility(baseline)).toEqual({ visible: true, reason: "active" });
    expect(resolveBrowserSurfaceVisibility({ ...baseline, active: false })).toEqual({
      visible: false,
      reason: "inactive_tab",
    });
    expect(resolveBrowserSurfaceVisibility({ ...baseline, hasPositiveArea: false })).toEqual({
      visible: false,
      reason: "sidebar_closed",
    });
  });

  it("connects Workbench drag start/end and the shared placeholder without a host-specific copy", () => {
    const page = readFileSync(
      resolve(process.cwd(), "src/renderer/pages/workbench/WorkbenchModePage.tsx"),
      "utf8",
    );
    const placeholder = readFileSync(
      resolve(process.cwd(), "src/renderer/features/browser/ui/BrowserSurfacePlaceholder.tsx"),
      "utf8",
    );
    const css = readFileSync(
      resolve(process.cwd(), "src/renderer/pages/workbench/WorkbenchModePage.module.css"),
      "utf8",
    );

    expect(page).toContain("browserGeometryCoordinator.beginInteractiveResize");
    expect(page).toContain("browserGeometryCoordinator.endInteractiveResize");
    expect(page).toContain("<BrowserTabSurface host={host} />");
    expect(page).not.toContain("WorkbenchBrowserSurfacePlaceholder");
    expect(placeholder).toContain("new ResizeObserver(scheduleMeasure)");
    expect(placeholder).toContain('window.addEventListener("resize", scheduleMeasure)');
    expect(css).toMatch(/\.mainPreviewBody\s*\{[\s\S]*?min-height:\s*0;[\s\S]*?overflow:\s*hidden;/);
  });
});
