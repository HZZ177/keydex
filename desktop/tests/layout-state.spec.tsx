import { act, renderHook } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { describe, expect, it } from "vitest";

import { LayoutStateProvider, useLayoutState } from "@/renderer/hooks/layout/LayoutStateProvider";
import {
  LAYOUT_PREFERENCES_KEY,
  MAX_SIDEBAR_WIDTH,
  MAX_PANEL_WIDTH,
  MIN_SIDEBAR_WIDTH,
  MIN_PANEL_WIDTH,
  clampPanelWidth,
  clampSidebarWidth,
  defaultLayoutState,
  layoutReducer,
  readLayoutPreferences,
  writeLayoutPreferences,
} from "@/renderer/hooks/layout/layoutStore";

describe("layout store", () => {
  it("toggles layout panels and clamps persisted widths", () => {
    let state = layoutReducer(defaultLayoutState, { type: "toggle-sidebar" });
    state = layoutReducer(state, { type: "toggle-right-sidebar" });
    state = layoutReducer(state, { type: "toggle-workspace" });
    state = layoutReducer(state, { type: "toggle-preview" });
    state = layoutReducer(state, { type: "set-sidebar-width", width: 9999 });
    state = layoutReducer(state, { type: "set-right-sidebar-width", width: Number.NaN });
    state = layoutReducer(state, { type: "set-workspace-width", width: 100 });
    state = layoutReducer(state, { type: "set-preview-width", width: 9999 });

    expect(state.sidebarCollapsed).toBe(true);
    expect(state.rightSidebarOpen).toBe(true);
    expect(state.sidebarWidth).toBe(MAX_SIDEBAR_WIDTH);
    expect(state.rightSidebarWidth).toBe(MIN_PANEL_WIDTH);
    expect(state.workspaceOpen).toBe(true);
    expect(state.previewOpen).toBe(true);
    expect(state.workspaceWidth).toBe(MIN_PANEL_WIDTH);
    expect(state.previewWidth).toBe(MAX_PANEL_WIDTH);
  });

  it("reads and writes local layout preferences", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
    };

    writeLayoutPreferences(storage, {
      sidebarCollapsed: true,
      sidebarWidth: 240,
      rightSidebarWidth: 360,
      workspaceWidth: 320,
      previewWidth: 480,
    });

    expect(store.has(LAYOUT_PREFERENCES_KEY)).toBe(true);
    expect(readLayoutPreferences(storage)).toEqual({
      sidebarCollapsed: true,
      sidebarWidth: 240,
      rightSidebarWidth: 360,
      workspaceWidth: 320,
      previewWidth: 480,
    });
    expect(clampPanelWidth(Number.NaN)).toBe(MIN_PANEL_WIDTH);
    expect(clampSidebarWidth(1)).toBe(MIN_SIDEBAR_WIDTH);
  });

});

describe("LayoutStateProvider", () => {
  it("exposes stable actions for shell state", () => {
    const wrapper = ({ children }: PropsWithChildren) => <LayoutStateProvider>{children}</LayoutStateProvider>;
    const { result } = renderHook(() => useLayoutState(), { wrapper });

    act(() => {
      result.current.actions.toggleRightSidebar();
      result.current.actions.toggleWorkspace();
      result.current.actions.setPreviewOpen(true);
      result.current.actions.setSidebarWidth(340);
      result.current.actions.setRightSidebarWidth(420);
      result.current.actions.setWorkspaceWidth(500);
    });

    expect(result.current.state.rightSidebarOpen).toBe(true);
    expect(result.current.state.workspaceOpen).toBe(true);
    expect(result.current.state.previewOpen).toBe(true);
    expect(result.current.state.sidebarWidth).toBe(340);
    expect(result.current.state.rightSidebarWidth).toBe(420);
    expect(result.current.state.workspaceWidth).toBe(500);
  });
});
