import { act, renderHook } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { describe, expect, it } from "vitest";

import { LayoutStateProvider, useLayoutState } from "@/renderer/hooks/layout/LayoutStateProvider";
import {
  LAYOUT_PREFERENCES_KEY,
  DEFAULT_WORKBENCH_ASSISTANT_DRAWER_WIDTH,
  MAX_WORKBENCH_ASSISTANT_DRAWER_WIDTH,
  DEFAULT_RIGHT_SIDEBAR_RATIO,
  MAX_SIDEBAR_WIDTH,
  MAX_PANEL_WIDTH,
  MAX_RIGHT_SIDEBAR_RATIO,
  MIN_WORKBENCH_ASSISTANT_DRAWER_WIDTH,
  MIN_SIDEBAR_WIDTH,
  MIN_PANEL_WIDTH,
  clampPanelWidth,
  clampRightSidebarRatio,
  clampSidebarWidth,
  clampWorkbenchAssistantDrawerWidth,
  defaultLayoutState,
  layoutReducer,
  mergeLayoutPreferences,
  readLayoutPreferences,
  writeLayoutPreferences,
} from "@/renderer/hooks/layout/layoutStore";

describe("layout store", () => {
  it("toggles layout panels and clamps persisted widths", () => {
    let state = layoutReducer(defaultLayoutState, { type: "toggle-sidebar" });
    state = layoutReducer(state, { type: "toggle-right-sidebar" });
    state = layoutReducer(state, { type: "toggle-right-sidebar-placement" });
    state = layoutReducer(state, { type: "toggle-workspace" });
    state = layoutReducer(state, { type: "toggle-preview" });
    state = layoutReducer(state, { type: "set-sidebar-width", width: 9999 });
    state = layoutReducer(state, { type: "set-right-sidebar-ratio", ratio: Number.NaN });
    state = layoutReducer(state, { type: "set-workspace-width", width: 100 });
    state = layoutReducer(state, { type: "set-preview-width", width: 9999 });
    state = layoutReducer(state, { type: "set-workbench-assistant-drawer-width", width: 9999 });
    state = layoutReducer(state, { type: "set-last-workbench-workspace-id", workspaceId: "workspace-a" });
    state = layoutReducer(state, {
      type: "set-last-mode-path",
      mode: "workbench",
      path: "/workbench/workspace-a/session/session-a",
    });

    expect(state.sidebarCollapsed).toBe(true);
    expect(state.rightSidebarOpen).toBe(true);
    expect(state.rightSidebarPlacement).toBe("left");
    expect(state.sidebarWidth).toBe(MAX_SIDEBAR_WIDTH);
    expect(state.rightSidebarRatio).toBe(DEFAULT_RIGHT_SIDEBAR_RATIO);
    expect(state.workspaceOpen).toBe(true);
    expect(state.previewOpen).toBe(true);
    expect(state.workspaceWidth).toBe(MIN_PANEL_WIDTH);
    expect(state.previewWidth).toBe(MAX_PANEL_WIDTH);
    expect(state.workbenchAssistantDrawerWidth).toBe(MAX_WORKBENCH_ASSISTANT_DRAWER_WIDTH);
    expect(state.lastWorkbenchWorkspaceId).toBe("workspace-a");
    expect(state.lastModePaths.workbench).toBe("/workbench/workspace-a/session/session-a");
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
      rightSidebarRatio: 0.42,
      rightSidebarPlacement: "left",
      workspaceWidth: 320,
      previewWidth: 480,
      workbenchAssistantDrawerWidth: 380,
      lastWorkbenchWorkspaceId: "workspace-a",
      lastModePaths: {
        agent: "/conversation/session-a",
        workbench: "/workbench/workspace-a/session/session-a",
        project: "/project",
      },
    });

    expect(store.has(LAYOUT_PREFERENCES_KEY)).toBe(true);
    expect(readLayoutPreferences(storage)).toEqual({
      sidebarCollapsed: true,
      sidebarWidth: 240,
      rightSidebarRatio: 0.42,
      rightSidebarPlacement: "left",
      workspaceWidth: 320,
      previewWidth: 480,
      workbenchAssistantDrawerWidth: 380,
      lastWorkbenchWorkspaceId: "workspace-a",
      lastModePaths: {
        agent: "/conversation/session-a",
        workbench: "/workbench/workspace-a/session/session-a",
        project: "/project",
      },
    });
    expect(clampPanelWidth(Number.NaN)).toBe(MIN_PANEL_WIDTH);
    expect(clampRightSidebarRatio(9)).toBe(MAX_RIGHT_SIDEBAR_RATIO);
    expect(clampSidebarWidth(1)).toBe(MIN_SIDEBAR_WIDTH);
    expect(clampWorkbenchAssistantDrawerWidth(Number.NaN)).toBe(DEFAULT_WORKBENCH_ASSISTANT_DRAWER_WIDTH);
    expect(clampWorkbenchAssistantDrawerWidth(1)).toBe(MIN_WORKBENCH_ASSISTANT_DRAWER_WIDTH);
  });

  it("keeps legacy preferences compatible and normalizes invalid workbench preferences", () => {
    const legacyState = mergeLayoutPreferences(defaultLayoutState, {
      sidebarWidth: 260,
    });
    expect(legacyState.sidebarWidth).toBe(260);
    expect(legacyState.workbenchAssistantDrawerWidth).toBe(DEFAULT_WORKBENCH_ASSISTANT_DRAWER_WIDTH);
    expect(legacyState.lastWorkbenchWorkspaceId).toBeNull();
    expect(legacyState.lastModePaths).toEqual({});

    const store = new Map<string, string>([
      [
        LAYOUT_PREFERENCES_KEY,
        JSON.stringify({
          workbenchAssistantDrawerWidth: 120,
          lastWorkbenchWorkspaceId: 42,
          lastWorkbenchPath: 42,
          lastModePaths: {
            agent: "/conversation/session-a",
            workbench: 42,
          },
        }),
      ],
    ]);
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
    };

    expect(readLayoutPreferences(storage)).toEqual({
      sidebarCollapsed: undefined,
      sidebarWidth: undefined,
      rightSidebarRatio: undefined,
      rightSidebarPlacement: undefined,
      workspaceWidth: undefined,
      previewWidth: undefined,
      workbenchAssistantDrawerWidth: 120,
      lastWorkbenchWorkspaceId: undefined,
      lastModePaths: {
        agent: "/conversation/session-a",
      },
    });

    const merged = mergeLayoutPreferences(defaultLayoutState, readLayoutPreferences(storage));
    expect(merged.workbenchAssistantDrawerWidth).toBe(MIN_WORKBENCH_ASSISTANT_DRAWER_WIDTH);
    expect(merged.lastWorkbenchWorkspaceId).toBeNull();
    expect(merged.lastModePaths).toEqual({
      agent: "/conversation/session-a",
    });
  });

  it("migrates the legacy workbench path preference into mode paths", () => {
    const storage = {
      getItem: () =>
        JSON.stringify({
          lastWorkbenchPath: "/workbench/workspace-a/session/session-a",
        }),
    };

    expect(readLayoutPreferences(storage).lastModePaths).toEqual({
      workbench: "/workbench/workspace-a/session/session-a",
    });
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
      result.current.actions.setRightSidebarRatio(0.42);
      result.current.actions.toggleRightSidebarPlacement();
      result.current.actions.setWorkspaceWidth(500);
      result.current.actions.setWorkbenchAssistantDrawerWidth(510);
      result.current.actions.setLastWorkbenchWorkspaceId("workspace-b");
      result.current.actions.setLastModePath("workbench", "/workbench/workspace-b/session/session-b");
    });

    expect(result.current.state.rightSidebarOpen).toBe(true);
    expect(result.current.state.workspaceOpen).toBe(true);
    expect(result.current.state.previewOpen).toBe(true);
    expect(result.current.state.sidebarWidth).toBe(340);
    expect(result.current.state.rightSidebarRatio).toBe(0.42);
    expect(result.current.state.rightSidebarPlacement).toBe("left");
    expect(result.current.state.workspaceWidth).toBe(500);
    expect(result.current.state.workbenchAssistantDrawerWidth).toBe(510);
    expect(result.current.state.lastWorkbenchWorkspaceId).toBe("workspace-b");
    expect(result.current.state.lastModePaths.workbench).toBe("/workbench/workspace-b/session/session-b");
  });
});
