export interface LayoutState {
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  rightSidebarOpen: boolean;
  rightSidebarRatio: number;
  rightSidebarPlacement: RightSidebarPlacement;
  workspaceOpen: boolean;
  previewOpen: boolean;
  workspaceWidth: number;
  previewWidth: number;
  workbenchAssistantDrawerWidth: number;
  lastWorkbenchWorkspaceId: string | null;
  lastModePaths: Record<string, string | undefined>;
  isMobileLike: boolean;
}

export type RightSidebarPlacement = "left" | "right";

export type LayoutAction =
  | { type: "toggle-sidebar" }
  | { type: "set-sidebar"; collapsed: boolean }
  | { type: "set-sidebar-width"; width: number }
  | { type: "toggle-right-sidebar" }
  | { type: "set-right-sidebar-open"; open: boolean }
  | { type: "set-right-sidebar-ratio"; ratio: number }
  | { type: "toggle-right-sidebar-placement" }
  | { type: "set-right-sidebar-placement"; placement: RightSidebarPlacement }
  | { type: "toggle-workspace" }
  | { type: "set-workspace-open"; open: boolean }
  | { type: "toggle-preview" }
  | { type: "set-preview-open"; open: boolean }
  | { type: "set-workspace-width"; width: number }
  | { type: "set-preview-width"; width: number }
  | { type: "set-workbench-assistant-drawer-width"; width: number }
  | { type: "set-last-workbench-workspace-id"; workspaceId: string | null }
  | { type: "set-last-mode-path"; mode: string; path: string | null }
  | { type: "set-mobile-like"; value: boolean };

export const LAYOUT_PREFERENCES_KEY = "keydex.layout.preferences";
export const DEFAULT_SIDEBAR_WIDTH = 286;
export const SIDEBAR_COLLAPSED_WIDTH = 58;
export const MIN_SIDEBAR_WIDTH = 220;
export const MAX_SIDEBAR_WIDTH = 460;
export const DEFAULT_RIGHT_SIDEBAR_RATIO = 0.45;
export const MIN_RIGHT_SIDEBAR_RATIO = 0.2;
export const MAX_RIGHT_SIDEBAR_RATIO = 0.8;
export const MIN_PANEL_WIDTH = 280;
export const MAX_PANEL_WIDTH = 760;
export const MIN_WORKBENCH_ASSISTANT_DRAWER_WIDTH = 360;
export const MAX_WORKBENCH_ASSISTANT_DRAWER_WIDTH = 520;
export const DEFAULT_WORKBENCH_ASSISTANT_DRAWER_WIDTH = MIN_WORKBENCH_ASSISTANT_DRAWER_WIDTH;

export const defaultLayoutState: LayoutState = {
  sidebarCollapsed: false,
  sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
  rightSidebarOpen: false,
  rightSidebarRatio: DEFAULT_RIGHT_SIDEBAR_RATIO,
  rightSidebarPlacement: "right",
  workspaceOpen: false,
  previewOpen: false,
  workspaceWidth: 360,
  previewWidth: 460,
  workbenchAssistantDrawerWidth: DEFAULT_WORKBENCH_ASSISTANT_DRAWER_WIDTH,
  lastWorkbenchWorkspaceId: null,
  lastModePaths: {},
  isMobileLike: false,
};

export interface LayoutPreferences {
  sidebarCollapsed?: boolean;
  sidebarWidth?: number;
  rightSidebarRatio?: number;
  rightSidebarPlacement?: RightSidebarPlacement;
  workspaceWidth?: number;
  previewWidth?: number;
  workbenchAssistantDrawerWidth?: number;
  lastWorkbenchWorkspaceId?: string | null;
  lastModePaths?: Record<string, string | undefined>;
}

export function clampSidebarWidth(width: number) {
  if (!Number.isFinite(width)) {
    return DEFAULT_SIDEBAR_WIDTH;
  }
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)));
}

export function clampPanelWidth(width: number) {
  if (!Number.isFinite(width)) {
    return MIN_PANEL_WIDTH;
  }
  return Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, Math.round(width)));
}

export function clampRightSidebarRatio(ratio: number) {
  if (!Number.isFinite(ratio)) {
    return DEFAULT_RIGHT_SIDEBAR_RATIO;
  }
  return Math.min(MAX_RIGHT_SIDEBAR_RATIO, Math.max(MIN_RIGHT_SIDEBAR_RATIO, Math.round(ratio * 1000) / 1000));
}

export function clampWorkbenchAssistantDrawerWidth(width: number) {
  if (!Number.isFinite(width)) {
    return DEFAULT_WORKBENCH_ASSISTANT_DRAWER_WIDTH;
  }
  return Math.min(
    MAX_WORKBENCH_ASSISTANT_DRAWER_WIDTH,
    Math.max(MIN_WORKBENCH_ASSISTANT_DRAWER_WIDTH, Math.round(width)),
  );
}

function normalizeRightSidebarPlacement(value: unknown): RightSidebarPlacement | undefined {
  return value === "left" || value === "right" ? value : undefined;
}

export function layoutReducer(state: LayoutState, action: LayoutAction): LayoutState {
  switch (action.type) {
    case "toggle-sidebar":
      return { ...state, sidebarCollapsed: !state.sidebarCollapsed };
    case "set-sidebar":
      if (state.sidebarCollapsed === action.collapsed) {
        return state;
      }
      return { ...state, sidebarCollapsed: action.collapsed };
    case "set-sidebar-width":
      {
        const sidebarWidth = clampSidebarWidth(action.width);
        return sidebarWidth === state.sidebarWidth ? state : { ...state, sidebarWidth };
      }
    case "toggle-right-sidebar":
      return { ...state, rightSidebarOpen: !state.rightSidebarOpen };
    case "set-right-sidebar-open":
      if (state.rightSidebarOpen === action.open) {
        return state;
      }
      return { ...state, rightSidebarOpen: action.open };
    case "set-right-sidebar-ratio":
      {
        const rightSidebarRatio = clampRightSidebarRatio(action.ratio);
        return rightSidebarRatio === state.rightSidebarRatio ? state : { ...state, rightSidebarRatio };
      }
    case "toggle-right-sidebar-placement":
      return { ...state, rightSidebarPlacement: state.rightSidebarPlacement === "right" ? "left" : "right" };
    case "set-right-sidebar-placement":
      if (state.rightSidebarPlacement === action.placement) {
        return state;
      }
      return { ...state, rightSidebarPlacement: action.placement };
    case "toggle-workspace":
      return { ...state, workspaceOpen: !state.workspaceOpen };
    case "set-workspace-open":
      if (state.workspaceOpen === action.open) {
        return state;
      }
      return { ...state, workspaceOpen: action.open };
    case "toggle-preview":
      return { ...state, previewOpen: !state.previewOpen };
    case "set-preview-open":
      if (state.previewOpen === action.open) {
        return state;
      }
      return { ...state, previewOpen: action.open };
    case "set-workspace-width":
      {
        const workspaceWidth = clampPanelWidth(action.width);
        return workspaceWidth === state.workspaceWidth ? state : { ...state, workspaceWidth };
      }
    case "set-preview-width":
      {
        const previewWidth = clampPanelWidth(action.width);
        return previewWidth === state.previewWidth ? state : { ...state, previewWidth };
      }
    case "set-workbench-assistant-drawer-width":
      {
        const workbenchAssistantDrawerWidth = clampWorkbenchAssistantDrawerWidth(action.width);
        return workbenchAssistantDrawerWidth === state.workbenchAssistantDrawerWidth
          ? state
          : { ...state, workbenchAssistantDrawerWidth };
      }
    case "set-last-workbench-workspace-id":
      if (state.lastWorkbenchWorkspaceId === action.workspaceId) {
        return state;
      }
      return { ...state, lastWorkbenchWorkspaceId: action.workspaceId };
    case "set-last-mode-path": {
      if (state.lastModePaths[action.mode] === (action.path ?? undefined)) {
        return state;
      }
      const lastModePaths = { ...state.lastModePaths };
      if (action.path) {
        lastModePaths[action.mode] = action.path;
      } else {
        delete lastModePaths[action.mode];
      }
      return { ...state, lastModePaths };
    }
    case "set-mobile-like":
      if (state.isMobileLike === action.value) {
        return state;
      }
      return { ...state, isMobileLike: action.value };
    default:
      return state;
  }
}

export function mergeLayoutPreferences(state: LayoutState, preferences: LayoutPreferences): LayoutState {
  return {
    ...state,
    sidebarCollapsed: preferences.sidebarCollapsed ?? state.sidebarCollapsed,
    sidebarWidth:
      preferences.sidebarWidth === undefined ? state.sidebarWidth : clampSidebarWidth(preferences.sidebarWidth),
    rightSidebarRatio:
      preferences.rightSidebarRatio === undefined
        ? state.rightSidebarRatio
        : clampRightSidebarRatio(preferences.rightSidebarRatio),
    rightSidebarPlacement: preferences.rightSidebarPlacement ?? state.rightSidebarPlacement,
    workspaceWidth:
      preferences.workspaceWidth === undefined ? state.workspaceWidth : clampPanelWidth(preferences.workspaceWidth),
    previewWidth: preferences.previewWidth === undefined ? state.previewWidth : clampPanelWidth(preferences.previewWidth),
    workbenchAssistantDrawerWidth:
      preferences.workbenchAssistantDrawerWidth === undefined
        ? state.workbenchAssistantDrawerWidth
        : clampWorkbenchAssistantDrawerWidth(preferences.workbenchAssistantDrawerWidth),
    lastWorkbenchWorkspaceId:
      preferences.lastWorkbenchWorkspaceId === undefined
        ? state.lastWorkbenchWorkspaceId
        : preferences.lastWorkbenchWorkspaceId,
    lastModePaths:
      preferences.lastModePaths === undefined ? state.lastModePaths : { ...preferences.lastModePaths },
  };
}

function normalizeModePaths(value: unknown): Record<string, string | undefined> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const result: Record<string, string | undefined> = {};
  for (const [mode, path] of Object.entries(value)) {
    if (typeof path === "string") {
      result[mode] = path;
    }
  }
  return result;
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
      sidebarWidth: typeof parsed.sidebarWidth === "number" ? parsed.sidebarWidth : undefined,
      rightSidebarRatio: typeof parsed.rightSidebarRatio === "number" ? parsed.rightSidebarRatio : undefined,
      rightSidebarPlacement: normalizeRightSidebarPlacement(parsed.rightSidebarPlacement),
      workspaceWidth: typeof parsed.workspaceWidth === "number" ? parsed.workspaceWidth : undefined,
      previewWidth: typeof parsed.previewWidth === "number" ? parsed.previewWidth : undefined,
      workbenchAssistantDrawerWidth:
        typeof parsed.workbenchAssistantDrawerWidth === "number" ? parsed.workbenchAssistantDrawerWidth : undefined,
      lastWorkbenchWorkspaceId:
        typeof parsed.lastWorkbenchWorkspaceId === "string"
          ? parsed.lastWorkbenchWorkspaceId
          : parsed.lastWorkbenchWorkspaceId === null
            ? null
            : undefined,
      lastModePaths:
        normalizeModePaths(parsed.lastModePaths) ??
        (typeof (parsed as { lastWorkbenchPath?: unknown }).lastWorkbenchPath === "string"
          ? { workbench: (parsed as { lastWorkbenchPath: string }).lastWorkbenchPath }
          : undefined),
    };
  } catch {
    return {};
  }
}

export function writeLayoutPreferences(
  storage: Pick<Storage, "setItem">,
  state: Pick<
    LayoutState,
    | "sidebarCollapsed"
    | "sidebarWidth"
    | "rightSidebarRatio"
    | "rightSidebarPlacement"
    | "workspaceWidth"
    | "previewWidth"
    | "workbenchAssistantDrawerWidth"
    | "lastWorkbenchWorkspaceId"
    | "lastModePaths"
  >,
) {
  storage.setItem(
    LAYOUT_PREFERENCES_KEY,
    JSON.stringify({
      sidebarCollapsed: state.sidebarCollapsed,
      sidebarWidth: clampSidebarWidth(state.sidebarWidth),
      rightSidebarRatio: clampRightSidebarRatio(state.rightSidebarRatio),
      rightSidebarPlacement: state.rightSidebarPlacement,
      workspaceWidth: clampPanelWidth(state.workspaceWidth),
      previewWidth: clampPanelWidth(state.previewWidth),
      workbenchAssistantDrawerWidth: clampWorkbenchAssistantDrawerWidth(state.workbenchAssistantDrawerWidth),
      lastWorkbenchWorkspaceId: state.lastWorkbenchWorkspaceId,
      lastModePaths: state.lastModePaths,
    }),
  );
}
