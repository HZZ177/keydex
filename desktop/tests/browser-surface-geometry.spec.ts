import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { BrowserOcclusionCoordinator } from "../src/renderer/features/browser/runtime";
import {
  logicalRectFromDomRect,
  resolveBrowserSurfaceVisibility,
} from "../src/renderer/features/browser/ui";

describe("browser surface geometry and occlusion", () => {
  it("passes CSS logical pixels through unchanged at every display scale", () => {
    const rect = { x: 103.25, y: 42.5, width: 416.75, height: 700.25 };
    for (const _displayScale of [1, 1.25, 1.5]) {
      expect(logicalRectFromDomRect(rect)).toEqual(rect);
    }
    const source = readFileSync(
      resolve(process.cwd(), "src/renderer/features/browser/ui/BrowserSurfacePlaceholder.tsx"),
      "utf8",
    );
    expect(source).not.toContain("devicePixelRatio");
  });

  it("coalesces nested occlusion tokens and releases each token exactly once", () => {
    const coordinator = new BrowserOcclusionCoordinator();
    const listener = vi.fn();
    const unsubscribe = coordinator.subscribe(listener);
    const releaseDialog = coordinator.acquire("dialog");
    const releaseMenu = coordinator.acquire("menu");
    const releaseNestedMenu = coordinator.acquire("menu");

    expect(coordinator.snapshot()).toEqual({
      count: 3,
      reasons: { dialog: 1, menu: 2 },
    });
    releaseMenu();
    releaseMenu();
    expect(coordinator.snapshot()).toEqual({ count: 2, reasons: { dialog: 1, menu: 1 } });
    releaseNestedMenu();
    expect(coordinator.snapshot()).toEqual({ count: 1, reasons: { dialog: 1 } });
    releaseDialog();
    expect(coordinator.snapshot()).toEqual({ count: 0, reasons: {} });
    expect(listener).toHaveBeenCalledTimes(6);
    unsubscribe();
  });

  it("requires active, visible, positive, unoccluded live state", () => {
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
    expect(resolveBrowserSurfaceVisibility({ ...baseline, occlusionCount: 2 })).toEqual({
      visible: false,
      reason: "occluded",
    });
    expect(resolveBrowserSurfaceVisibility({ ...baseline, documentVisible: false })).toEqual({
      visible: false,
      reason: "window_hidden",
    });
    expect(resolveBrowserSurfaceVisibility({ ...baseline, resourceState: "warm" })).toEqual({
      visible: false,
      reason: "sidebar_closed",
    });
  });

  it("uses global occlusion for dialogs and floating layers but only spatial occlusion for app menus", () => {
    const sources = [
      "src/renderer/components/dialog/AppDialog.tsx",
      "src/renderer/components/floating/FloatingLayer.tsx",
      "src/renderer/providers/AppContextMenuProvider.tsx",
    ].map((path) => readFileSync(resolve(process.cwd(), path), "utf8"));
    expect(sources[0]).toContain('useBrowserOcclusionToken(true, "dialog")');
    expect(sources[1]).toContain('useBrowserOcclusionToken(true, "menu")');
    expect(sources[2]).toContain('useBrowserOcclusionToken(menu?.occludesNativeSurface === true, "menu")');
    expect(sources[2]).toContain("resolveContextMenuPlacement");
  });

  it("does not treat main-WebView focus loss as native-window occlusion", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/renderer/features/browser/runtime/BrowserOcclusionCoordinator.tsx"),
      "utf8",
    );

    // Focusing a child WebView can defocus the React WebView while the same
    // top-level window remains active. Turning that event into occlusion makes
    // the child hide, refocus the main WebView, show again, and flash forever.
    expect(source).not.toContain("onFocusChanged");
    expect(source).not.toContain("useBrowserNativeWindowOcclusion");
  });
});
