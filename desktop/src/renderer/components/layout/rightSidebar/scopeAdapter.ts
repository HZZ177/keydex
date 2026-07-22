import type {
  RightSidebarPanelKind,
  RightSidebarPanelStateFor,
  RightSidebarScopeStateV2,
} from "./types";

export interface PreviewScopePanelState extends RightSidebarScopeStateV2 {
  readonly initialPanelIds: string[];
}

export function panelIdsByKind<K extends RightSidebarPanelKind>(
  state: PreviewScopePanelState,
  kind: K,
): string[] {
  return state.panelOrder.filter((panelId) => state.panels[panelId]?.kind === kind);
}

export function panelRecordByKind<K extends RightSidebarPanelKind>(
  state: PreviewScopePanelState,
  kind: K,
): Record<string, RightSidebarPanelStateFor<K>> {
  return Object.fromEntries(
    Object.entries(state.panels).flatMap(([panelId, panel]) =>
      panel.kind === kind
        ? [[panelId, panel as RightSidebarPanelStateFor<K>] as const]
        : [],
    ),
  );
}

export function panelByIdAndKind<K extends RightSidebarPanelKind>(
  state: PreviewScopePanelState,
  panelId: string | null,
  kind: K,
): RightSidebarPanelStateFor<K> | null {
  if (!panelId) return null;
  const panel = state.panels[panelId];
  return panel?.kind === kind ? panel as RightSidebarPanelStateFor<K> : null;
}

export function removeRegisteredPanels(
  state: PreviewScopePanelState,
  panelIds: ReadonlySet<string>,
): PreviewScopePanelState {
  if (panelIds.size === 0) return state;
  const panels = { ...state.panels };
  panelIds.forEach((panelId) => delete panels[panelId]);
  const panelOrder = state.panelOrder.filter((panelId) => !panelIds.has(panelId));
  return {
    ...state,
    activePanelId: state.activePanelId && panelIds.has(state.activePanelId)
      ? panelOrder[0] ?? null
      : state.activePanelId,
    panelOrder,
    panels,
  };
}

export function replaceRegisteredPanel<K extends RightSidebarPanelKind>(
  state: PreviewScopePanelState,
  panel: RightSidebarPanelStateFor<K>,
): PreviewScopePanelState {
  if (!state.panels[panel.id] || state.panels[panel.id]?.kind !== panel.kind) return state;
  return { ...state, panels: { ...state.panels, [panel.id]: panel } };
}

export function previewScopePanelIds(
  state: PreviewScopePanelState,
  entryIds: readonly string[],
): string[] {
  const knownIds = new Set([
    ...Object.keys(state.panels),
    ...state.initialPanelIds,
    ...entryIds,
  ]);
  const seen = new Set<string>();
  return [...state.panelOrder, ...knownIds].filter((panelId) => {
    if (!knownIds.has(panelId) || seen.has(panelId)) return false;
    seen.add(panelId);
    return true;
  });
}
