import { createContext, useContext, useEffect, useMemo, useReducer } from "react";
import type { PropsWithChildren } from "react";

import {
  defaultLayoutState,
  layoutReducer,
  mergeLayoutPreferences,
  readLayoutPreferences,
  writeLayoutPreferences,
} from "./layoutStore";
import type { LayoutState } from "./layoutStore";

export interface LayoutStateActions {
  toggleSidebar(): void;
  setSidebarCollapsed(collapsed: boolean): void;
  toggleWorkspace(): void;
  setWorkspaceOpen(open: boolean): void;
  togglePreview(): void;
  setPreviewOpen(open: boolean): void;
  setWorkspaceWidth(width: number): void;
  setPreviewWidth(width: number): void;
  setMobileLike(value: boolean): void;
}

export interface LayoutStateContextValue {
  state: LayoutState;
  actions: LayoutStateActions;
}

const LayoutStateContext = createContext<LayoutStateContextValue | null>(null);

function createInitialState(): LayoutState {
  if (typeof window === "undefined") {
    return defaultLayoutState;
  }

  return mergeLayoutPreferences(defaultLayoutState, readLayoutPreferences(window.localStorage));
}

export function LayoutStateProvider({ children }: PropsWithChildren) {
  const [state, dispatch] = useReducer(layoutReducer, undefined, createInitialState);

  useEffect(() => {
    writeLayoutPreferences(window.localStorage, state);
  }, [state.sidebarCollapsed, state.workspaceWidth, state.previewWidth]);

  const actions = useMemo<LayoutStateActions>(
    () => ({
      toggleSidebar() {
        dispatch({ type: "toggle-sidebar" });
      },
      setSidebarCollapsed(collapsed) {
        dispatch({ type: "set-sidebar", collapsed });
      },
      toggleWorkspace() {
        dispatch({ type: "toggle-workspace" });
      },
      setWorkspaceOpen(open) {
        dispatch({ type: "set-workspace-open", open });
      },
      togglePreview() {
        dispatch({ type: "toggle-preview" });
      },
      setPreviewOpen(open) {
        dispatch({ type: "set-preview-open", open });
      },
      setWorkspaceWidth(width) {
        dispatch({ type: "set-workspace-width", width });
      },
      setPreviewWidth(width) {
        dispatch({ type: "set-preview-width", width });
      },
      setMobileLike(value) {
        dispatch({ type: "set-mobile-like", value });
      },
    }),
    [],
  );

  const value = useMemo(() => ({ state, actions }), [actions, state]);

  return <LayoutStateContext.Provider value={value}>{children}</LayoutStateContext.Provider>;
}

export function useLayoutState() {
  const value = useContext(LayoutStateContext);
  if (!value) {
    throw new Error("useLayoutState 必须在 LayoutStateProvider 内使用");
  }
  return value;
}
