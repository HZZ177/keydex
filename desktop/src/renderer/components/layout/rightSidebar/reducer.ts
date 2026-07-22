import { RightSidebarDefinitionRegistry } from "./registry";
import {
  emptyRightSidebarScopeStateV2,
  type JsonObject,
  type PanelNormalizeContext,
  type RightSidebarPanelKind,
  type RightSidebarPanelState,
  type RightSidebarScopeStateV2,
} from "./types";

export type RightSidebarLifecycleIntentType =
  | "panel.mount"
  | "panel.activate"
  | "panel.deactivate"
  | "panel.destroy";

export interface RightSidebarLifecycleIntent {
  readonly type: RightSidebarLifecycleIntentType;
  readonly panel: RightSidebarPanelState;
}

export type RightSidebarReducerWarning =
  | "create_failed"
  | "duplicate_panel_id"
  | "invalid_panel_update"
  | "invalid_scope_state"
  | "missing_panel";

export type RightSidebarReducerAction =
  | {
      readonly type: "panel.create";
      readonly kind: RightSidebarPanelKind;
      readonly now: string;
      readonly input?: JsonObject;
      readonly activate?: boolean;
    }
  | { readonly type: "panel.activate"; readonly panelId: string; readonly now: string }
  | { readonly type: "panel.close"; readonly panelId: string }
  | { readonly type: "panel.reorder"; readonly panelId: string; readonly toIndex: number }
  | { readonly type: "panel.update"; readonly panel: RightSidebarPanelState }
  | {
      readonly type: "scope.replace";
      readonly raw: unknown;
      readonly normalizeContext: PanelNormalizeContext;
    }
  | {
      readonly type: "state.normalize";
      readonly normalizeContext: PanelNormalizeContext;
    };

export interface RightSidebarReducerResult {
  readonly state: RightSidebarScopeStateV2;
  readonly intents: readonly RightSidebarLifecycleIntent[];
  readonly warnings: readonly RightSidebarReducerWarning[];
}

export function reduceRightSidebarState(
  currentState: RightSidebarScopeStateV2,
  action: RightSidebarReducerAction,
  registry: RightSidebarDefinitionRegistry,
): RightSidebarReducerResult {
  const state = canonicalizeState(currentState);
  switch (action.type) {
    case "panel.create":
      return createPanel(state, action, registry);
    case "panel.activate":
      return activatePanel(state, action.panelId, action.now);
    case "panel.close":
      return closePanel(state, action.panelId);
    case "panel.reorder":
      return reorderPanel(state, action.panelId, action.toIndex);
    case "panel.update":
      return updatePanel(state, action.panel, registry);
    case "scope.replace": {
      const nextState = registry.normalizeScopeState(action.raw, action.normalizeContext);
      if (!nextState) {
        return replaceState(state, emptyRightSidebarScopeStateV2(), ["invalid_scope_state"]);
      }
      return replaceState(state, nextState);
    }
    case "state.normalize": {
      const normalized = registry.normalizeScopeState(
        registry.serializeScopeState(state),
        action.normalizeContext,
      );
      if (!normalized) {
        return replaceState(state, emptyRightSidebarScopeStateV2(), ["invalid_scope_state"]);
      }
      return replaceState(state, normalized);
    }
  }
}

function createPanel(
  state: RightSidebarScopeStateV2,
  action: Extract<RightSidebarReducerAction, { type: "panel.create" }>,
  registry: RightSidebarDefinitionRegistry,
): RightSidebarReducerResult {
  const definition = registry.get(action.kind);
  if (definition.multiplicity === "singleton") {
    const existing = state.panelOrder.find((panelId) => state.panels[panelId]?.kind === action.kind);
    if (existing) return action.activate === false ? unchanged(state) : activatePanel(state, existing, action.now);
  }

  const sequence = state.nextPanelSeq + 1;
  const id = registry.panelId(action.kind, sequence);
  if (state.panels[id]) return warning(state, "duplicate_panel_id");

  let panel: RightSidebarPanelState;
  try {
    panel = createPanelFromRegistry(registry, action.kind, {
      id,
      sequence,
      now: action.now,
      input: action.input,
    });
  } catch {
    return warning(state, "create_failed");
  }

  const activate = action.activate !== false;
  const panels = { ...state.panels, [id]: panel };
  const panelOrder = [...state.panelOrder, id];
  const nextState: RightSidebarScopeStateV2 = {
    ...state,
    activePanelId: activate ? id : state.activePanelId,
    panelOrder,
    panels,
    nextPanelSeq: sequence,
  };
  const intents: RightSidebarLifecycleIntent[] = [];
  if (activate && state.activePanelId) {
    intents.push({ type: "panel.deactivate", panel: state.panels[state.activePanelId] });
  }
  intents.push({ type: "panel.mount", panel });
  if (activate) intents.push({ type: "panel.activate", panel });
  return result(nextState, intents);
}

function activatePanel(
  state: RightSidebarScopeStateV2,
  panelId: string,
  now: string,
): RightSidebarReducerResult {
  const panel = state.panels[panelId];
  if (!panel) return warning(state, "missing_panel");
  if (state.activePanelId === panelId) return unchanged(state);

  const activated = { ...panel, lastActivatedAt: now } as RightSidebarPanelState;
  const intents: RightSidebarLifecycleIntent[] = [];
  if (state.activePanelId) {
    intents.push({ type: "panel.deactivate", panel: state.panels[state.activePanelId] });
  }
  intents.push({ type: "panel.activate", panel: activated });
  return result({
    ...state,
    activePanelId: panelId,
    panels: { ...state.panels, [panelId]: activated },
  }, intents);
}

function closePanel(
  state: RightSidebarScopeStateV2,
  panelId: string,
): RightSidebarReducerResult {
  const panel = state.panels[panelId];
  if (!panel) return unchanged(state);

  const closedIndex = state.panelOrder.indexOf(panelId);
  const panelOrder = state.panelOrder.filter((id) => id !== panelId);
  const panels = { ...state.panels };
  delete panels[panelId];
  const wasActive = state.activePanelId === panelId;
  const activePanelId = wasActive
    ? panelOrder[Math.min(Math.max(closedIndex, 0), panelOrder.length - 1)] ?? null
    : state.activePanelId;
  const nextState = canonicalizeState({ ...state, activePanelId, panelOrder, panels });
  const intents: RightSidebarLifecycleIntent[] = [];
  if (wasActive) intents.push({ type: "panel.deactivate", panel });
  intents.push({ type: "panel.destroy", panel });
  if (wasActive && nextState.activePanelId) {
    intents.push({ type: "panel.activate", panel: nextState.panels[nextState.activePanelId] });
  }
  return result(nextState, intents);
}

function reorderPanel(
  state: RightSidebarScopeStateV2,
  panelId: string,
  toIndex: number,
): RightSidebarReducerResult {
  const fromIndex = state.panelOrder.indexOf(panelId);
  if (fromIndex < 0) return warning(state, "missing_panel");
  const nextIndex = Math.max(0, Math.min(state.panelOrder.length - 1, Math.trunc(toIndex)));
  if (fromIndex === nextIndex) return unchanged(state);
  const panelOrder = [...state.panelOrder];
  panelOrder.splice(fromIndex, 1);
  panelOrder.splice(nextIndex, 0, panelId);
  return result({ ...state, panelOrder });
}

function updatePanel(
  state: RightSidebarScopeStateV2,
  panel: RightSidebarPanelState,
  registry: RightSidebarDefinitionRegistry,
): RightSidebarReducerResult {
  const current = state.panels[panel.id];
  if (!current) return warning(state, "missing_panel");
  if (current.kind !== panel.kind || current.schemaVersion !== panel.schemaVersion) {
    return warning(state, "invalid_panel_update");
  }
  const normalized = registry.normalizePanel(
    registry.serializePanel(panel),
    { now: panel.lastActivatedAt, source: "persistence" },
  );
  if (!normalized || normalized.id !== panel.id) return warning(state, "invalid_panel_update");
  return result({ ...state, panels: { ...state.panels, [panel.id]: normalized } });
}

function replaceState(
  state: RightSidebarScopeStateV2,
  nextState: RightSidebarScopeStateV2,
  warnings: readonly RightSidebarReducerWarning[] = [],
): RightSidebarReducerResult {
  const next = canonicalizeState(nextState);
  const intents: RightSidebarLifecycleIntent[] = [];
  if (state.activePanelId && state.activePanelId !== next.activePanelId) {
    intents.push({ type: "panel.deactivate", panel: state.panels[state.activePanelId] });
  }
  for (const panelId of state.panelOrder) {
    if (!next.panels[panelId]) intents.push({ type: "panel.destroy", panel: state.panels[panelId] });
  }
  for (const panelId of next.panelOrder) {
    if (!state.panels[panelId]) intents.push({ type: "panel.mount", panel: next.panels[panelId] });
  }
  if (next.activePanelId && state.activePanelId !== next.activePanelId) {
    intents.push({ type: "panel.activate", panel: next.panels[next.activePanelId] });
  }
  return result(next, intents, warnings);
}

function canonicalizeState(state: RightSidebarScopeStateV2): RightSidebarScopeStateV2 {
  const panels: Record<string, RightSidebarPanelState> = {};
  for (const [panelId, panel] of Object.entries(state.panels)) {
    if (panel.id === panelId) panels[panelId] = panel;
  }
  const seen = new Set<string>();
  const panelOrder = state.panelOrder.filter((panelId) => {
    if (!panels[panelId] || seen.has(panelId)) return false;
    seen.add(panelId);
    return true;
  });
  for (const panelId of Object.keys(panels).sort()) {
    if (!seen.has(panelId)) panelOrder.push(panelId);
  }
  const activePanelId = state.activePanelId && panels[state.activePanelId]
    ? state.activePanelId
    : panelOrder[0] ?? null;
  return { ...state, activePanelId, panelOrder, panels };
}

function createPanelFromRegistry(
  registry: RightSidebarDefinitionRegistry,
  kind: RightSidebarPanelKind,
  context: Parameters<RightSidebarDefinitionRegistry["create"]>[1],
): RightSidebarPanelState {
  switch (kind) {
    case "files":
      return registry.create("files", context);
    case "conversation":
      return registry.create("conversation", context);
    case "review":
      return registry.create("review", context);
    case "browser":
      return registry.create("browser", context);
  }
}

function unchanged(state: RightSidebarScopeStateV2): RightSidebarReducerResult {
  return result(state);
}

function warning(
  state: RightSidebarScopeStateV2,
  value: RightSidebarReducerWarning,
): RightSidebarReducerResult {
  return result(state, [], [value]);
}

function result(
  state: RightSidebarScopeStateV2,
  intents: readonly RightSidebarLifecycleIntent[] = [],
  warnings: readonly RightSidebarReducerWarning[] = [],
): RightSidebarReducerResult {
  return { state, intents, warnings };
}
