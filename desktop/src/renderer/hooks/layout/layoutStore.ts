export interface LayoutState {
  sidebarCollapsed: boolean;
  workspaceOpen: boolean;
  previewOpen: boolean;
  workspaceWidth: number;
  previewWidth: number;
  isMobileLike: boolean;
}

export type LayoutAction =
  | { type: "toggle-sidebar" }
  | { type: "set-sidebar"; collapsed: boolean }
  | { type: "toggle-workspace" }
  | { type: "set-workspace-open"; open: boolean }
  | { type: "toggle-preview" }
  | { type: "set-preview-open"; open: boolean }
  | { type: "set-workspace-width"; width: number }
  | { type: "set-preview-width"; width: number }
  | { type: "set-mobile-like"; value: boolean };

export const LAYOUT_PREFERENCES_KEY = "codex-copy.layout.preferences";
export const MIN_PANEL_WIDTH = 280;
export const MAX_PANEL_WIDTH = 760;

export const defaultLayoutState: LayoutState = {
  sidebarCollapsed: false,
  workspaceOpen: false,
  previewOpen: false,
  workspaceWidth: 360,
  previewWidth: 460,
  isMobileLike: false,
};

export interface LayoutPreferences {
  sidebarCollapsed?: boolean;
  workspaceWidth?: number;
  previewWidth?: number;
}

export function clampPanelWidth(width: number) {
  if (!Number.isFinite(width)) {
    return MIN_PANEL_WIDTH;
  }
  return Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, Math.round(width)));
}

export function layoutReducer(state: LayoutState, action: LayoutAction): LayoutState {
  switch (action.type) {
    case "toggle-sidebar":
      return { ...state, sidebarCollapsed: !state.sidebarCollapsed };
    case "set-sidebar":
      return { ...state, sidebarCollapsed: action.collapsed };
    case "toggle-workspace":
      return { ...state, workspaceOpen: !state.workspaceOpen };
    case "set-workspace-open":
      return { ...state, workspaceOpen: action.open };
    case "toggle-preview":
      return { ...state, previewOpen: !state.previewOpen };
    case "set-preview-open":
      return { ...state, previewOpen: action.open };
    case "set-workspace-width":
      return { ...state, workspaceWidth: clampPanelWidth(action.width) };
    case "set-preview-width":
      return { ...state, previewWidth: clampPanelWidth(action.width) };
    case "set-mobile-like":
      return { ...state, isMobileLike: action.value };
    default:
      return state;
  }
}

export function mergeLayoutPreferences(state: LayoutState, preferences: LayoutPreferences): LayoutState {
  return {
    ...state,
    sidebarCollapsed: preferences.sidebarCollapsed ?? state.sidebarCollapsed,
    workspaceWidth:
      preferences.workspaceWidth === undefined ? state.workspaceWidth : clampPanelWidth(preferences.workspaceWidth),
    previewWidth: preferences.previewWidth === undefined ? state.previewWidth : clampPanelWidth(preferences.previewWidth),
  };
}

export function readLayoutPreferences(storage: Pick<Storage, "getItem">): LayoutPreferences {
  const raw = storage.getItem(LAYOUT_PREFERENCES_KEY);
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as LayoutPreferences;
    return {
      sidebarCollapsed:
        typeof parsed.sidebarCollapsed === "boolean" ? parsed.sidebarCollapsed : undefined,
      workspaceWidth: typeof parsed.workspaceWidth === "number" ? parsed.workspaceWidth : undefined,
      previewWidth: typeof parsed.previewWidth === "number" ? parsed.previewWidth : undefined,
    };
  } catch {
    return {};
  }
}

export function writeLayoutPreferences(
  storage: Pick<Storage, "setItem">,
  state: Pick<LayoutState, "sidebarCollapsed" | "workspaceWidth" | "previewWidth">,
) {
  storage.setItem(
    LAYOUT_PREFERENCES_KEY,
    JSON.stringify({
      sidebarCollapsed: state.sidebarCollapsed,
      workspaceWidth: clampPanelWidth(state.workspaceWidth),
      previewWidth: clampPanelWidth(state.previewWidth),
    }),
  );
}
