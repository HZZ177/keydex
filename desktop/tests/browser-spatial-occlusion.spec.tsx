import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { useRef } from "react";
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  browserGeometryCoordinator,
  browserSurfaceOcclusionRects,
  BrowserOcclusionProvider,
  useBrowserOcclusionSnapshot,
  useBrowserOcclusionToken,
  useBrowserSpatialOcclusion,
} from "@/renderer/features/browser/runtime";

function SpatialProbe({ active }: { active: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  useBrowserSpatialOcclusion(ref, active, "workbench-assistant-test");
  return <div ref={ref} data-testid="spatial-probe" />;
}

function TokenProbe({ active }: { active: boolean }) {
  useBrowserOcclusionToken(active, "menu");
  const snapshot = useBrowserOcclusionSnapshot();
  return <div data-count={snapshot.count} data-testid="token-probe" />;
}

describe("workbench assistant browser spatial occlusion", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers and releases a spatial element exactly once", () => {
    const release = vi.fn();
    const register = vi
      .spyOn(browserGeometryCoordinator, "registerSpatialOcclusionElement")
      .mockReturnValue(release);
    const view = render(<SpatialProbe active />);

    expect(register).toHaveBeenCalledTimes(1);
    expect(register.mock.calls[0]?.[0]).toContain("workbench-assistant-test");
    expect(register.mock.calls[0]?.[1]).toBe(view.getByTestId("spatial-probe"));
    view.rerender(<SpatialProbe active={false} />);
    expect(release).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("clips only the expanded interactive frame intersection, not its transparent layer", () => {
    expect(browserSurfaceOcclusionRects(
      { left: 300, top: 60, right: 1_300, bottom: 860 },
      [
        {
          left: 520,
          top: 150,
          right: 1_120,
          bottom: 720,
          width: 600,
          height: 570,
        },
      ],
      0,
    )).toEqual([
      { x: 220, y: 90, width: 600, height: 570 },
    ]);
  });

  it("wires expanded, dock transition and drawer resize to paired occlusion boundaries", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/renderer/pages/workbench/WorkbenchAssistantSurface.tsx"),
      "utf8",
    );

    expect(source).toContain("useBrowserSpatialOcclusion(");
    expect(source).toContain("expandedPanelFrameRef");
    expect(source).toContain("stablePanelRef");
    expect(source).not.toMatch(/useBrowserSpatialOcclusion\(\s*expandedLayer/);
    expect(source).toContain('dockTransitionPhase !== null || drawerResize.dragging');
    expect(source).toContain('"window_transition"');
  });

  it("pairs the Workbench menu global token across open and close", () => {
    const view = render(
      <BrowserOcclusionProvider>
        <TokenProbe active />
      </BrowserOcclusionProvider>,
    );
    expect(view.getByTestId("token-probe").getAttribute("data-count")).toBe("1");

    view.rerender(
      <BrowserOcclusionProvider>
        <TokenProbe active={false} />
      </BrowserOcclusionProvider>,
    );
    expect(view.getByTestId("token-probe").getAttribute("data-count")).toBe("0");
  });

  it("routes Workbench menus and terminal geometry through the shared occlusion APIs", () => {
    const workbench = readFileSync(
      resolve(process.cwd(), "src/renderer/pages/workbench/WorkbenchModePage.tsx"),
      "utf8",
    );
    const terminal = readFileSync(
      resolve(process.cwd(), "src/renderer/features/terminal/TerminalDock.tsx"),
      "utf8",
    );
    const permission = readFileSync(
      resolve(process.cwd(), "src/renderer/features/browser/ui/PermissionPrompt.tsx"),
      "utf8",
    );

    expect(workbench).toContain('useBrowserOcclusionToken(Boolean(tabMenu), "menu")');
    expect(terminal).toContain('useBrowserSpatialOcclusion(rootRef, ui.dockOpen, "terminal-dock", { observeResize: false })');
    expect(permission).toContain("<ConfirmDialog");
  });
});
