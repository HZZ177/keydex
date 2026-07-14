import { createStore, type StoreApi } from "zustand/vanilla";

import type { AnnotationRecord, TextSelector } from "@/runtime/annotations";

import type { DocumentTextModel, LogicalRange } from "../document/DocumentTextModel";
import type { ResolvedAnnotationIndex } from "../domain/resolutions";
import { resolveTextAnchor } from "../anchoring/resolveTextAnchor";
import { createTextSelector } from "../anchoring/createTextSelector";

export interface AnnotationDocumentState {
  readonly model: DocumentTextModel;
  readonly path: string;
  readonly workspaceId: string;
}

export type AnnotationInteraction =
  | { readonly type: "idle" }
  | {
      readonly body: string;
      readonly range: LogicalRange | null;
      readonly selector: TextSelector | null;
      readonly selectionStatus: "ready" | "ambiguous" | "changed";
      readonly type: "drafting";
    }
  | { readonly annotationId: string; readonly body: string; readonly type: "editing" }
  | {
      readonly annotationId: string;
      readonly range: LogicalRange | null;
      readonly selector: TextSelector | null;
      readonly selectionStatus: "empty" | "ready" | "ambiguous" | "changed";
      readonly type: "retargeting";
    };

export interface AnnotationNavigationState {
  readonly annotationId: string | null;
  readonly error: string | null;
  readonly requestId: number;
  readonly status: "idle" | "pending" | "ready" | "error";
}

export interface PendingAnnotationMutation {
  readonly annotationId: string | null;
  readonly kind: "create" | "update-body" | "retarget" | "delete";
  readonly token: number;
}

export interface AnnotationState {
  readonly activeAnnotationId: string | null;
  readonly document: AnnotationDocumentState | null;
  readonly error: string | null;
  readonly flashAnnotationId: string | null;
  readonly flashToken: number;
  readonly hoveredAnnotationId: string | null;
  readonly interaction: AnnotationInteraction;
  readonly loading: boolean;
  readonly navigation: AnnotationNavigationState;
  readonly panelOpen: boolean;
  readonly pendingMutation: PendingAnnotationMutation | null;
  readonly mutationSequence: number;
  readonly records: readonly AnnotationRecord[];
  readonly resolutions: ResolvedAnnotationIndex;
}

export interface AnnotationActions {
  activate(annotationId: string | null, openPanel?: boolean): void;
  beginDraft(range: LogicalRange, selector: TextSelector): void;
  beginEdit(annotationId: string, body: string): void;
  beginRetarget(annotationId: string): void;
  cancelInteraction(): void;
  closePanel(): void;
  dispose(): void;
  failNavigation(requestId: number, error: string): void;
  flash(annotationId: string): void;
  finishNavigation(requestId: number): void;
  hover(annotationId: string | null): void;
  openPanel(): void;
  requestNavigation(annotationId: string): number;
  setDocument(document: AnnotationDocumentState): void;
  setError(error: string | null): void;
  setLoading(loading: boolean): void;
  setRecords(records: readonly AnnotationRecord[], resolutions: ResolvedAnnotationIndex): void;
  setRetargetSelection(range: LogicalRange, selector: TextSelector): void;
  startMutation(kind: PendingAnnotationMutation["kind"], annotationId?: string): number;
  finishMutation(token: number): void;
  togglePanel(): void;
  updateInteractionBody(body: string): void;
}

export type AnnotationStoreState = AnnotationState & AnnotationActions;
export type AnnotationStore = StoreApi<AnnotationStoreState>;

export function createAnnotationStore(): AnnotationStore {
  return createStore<AnnotationStoreState>()((set, get) => ({
    ...initialAnnotationState(),
    activate(annotationId, openPanel = false) {
      set((state) => ({
        activeAnnotationId: annotationId,
        flashAnnotationId: annotationId === null ? null : state.flashAnnotationId,
        hoveredAnnotationId: annotationId === null ? null : state.hoveredAnnotationId,
        panelOpen: openPanel ? true : state.panelOpen,
      }));
    },
    beginDraft(range, selector) {
      const current = get().interaction;
      set({
        activeAnnotationId: null,
        error: null,
        hoveredAnnotationId: null,
        interaction: Object.freeze({
          body: current.type === "drafting" ? current.body : "",
          range,
          selector,
          selectionStatus: "ready",
          type: "drafting",
        }),
        panelOpen: true,
      });
    },
    beginEdit(annotationId, body) {
      set({
        activeAnnotationId: annotationId,
        error: null,
        interaction: Object.freeze({ annotationId, body, type: "editing" }),
        panelOpen: true,
      });
    },
    beginRetarget(annotationId) {
      set({
        activeAnnotationId: annotationId,
        error: null,
        interaction: Object.freeze({
          annotationId,
          range: null,
          selector: null,
          selectionStatus: "empty",
          type: "retargeting",
        }),
        panelOpen: true,
      });
    },
    cancelInteraction() {
      set({ error: null, interaction: IDLE_INTERACTION });
    },
    closePanel() {
      set({ hoveredAnnotationId: null, interaction: IDLE_INTERACTION, panelOpen: false });
    },
    dispose() {
      set(initialAnnotationState());
    },
    failNavigation(requestId, error) {
      if (get().navigation.requestId !== requestId) {
        return;
      }
      set({ navigation: Object.freeze({ ...get().navigation, error, status: "error" }) });
    },
    flash(annotationId) {
      set((state) => ({
        activeAnnotationId: annotationId,
        flashAnnotationId: annotationId,
        flashToken: state.flashToken + 1,
      }));
    },
    finishNavigation(requestId) {
      if (get().navigation.requestId !== requestId) {
        return;
      }
      set({ navigation: Object.freeze({ ...get().navigation, error: null, status: "ready" }) });
    },
    finishMutation(token) {
      if (get().pendingMutation?.token === token) {
        set({ pendingMutation: null });
      }
    },
    hover(annotationId) {
      if (get().hoveredAnnotationId !== annotationId) {
        set({ hoveredAnnotationId: annotationId });
      }
    },
    openPanel() {
      set({ panelOpen: true });
    },
    requestNavigation(annotationId) {
      const requestId = get().navigation.requestId + 1;
      set({
        activeAnnotationId: annotationId,
        navigation: Object.freeze({ annotationId, error: null, requestId, status: "pending" }),
      });
      return requestId;
    },
    setDocument(document) {
      const current = get();
      const sameDocument = current.document?.workspaceId === document.workspaceId
        && current.document.path === document.path;
      if (!sameDocument) {
        set({ ...initialAnnotationState(), document });
        return;
      }
      const interaction = reconcileInteraction(current.interaction, document.model);
      set({
        document,
        interaction,
        error: interactionSelectionError(interaction),
      });
    },
    setError(error) {
      set({ error });
    },
    setLoading(loading) {
      set({ loading });
    },
    setRecords(records, resolutions) {
      const recordIds = new Set(records.map((record) => record.id));
      set((state) => ({
        activeAnnotationId: state.activeAnnotationId && recordIds.has(state.activeAnnotationId)
          ? state.activeAnnotationId
          : null,
        flashAnnotationId: state.flashAnnotationId && recordIds.has(state.flashAnnotationId)
          ? state.flashAnnotationId
          : null,
        hoveredAnnotationId: state.hoveredAnnotationId && recordIds.has(state.hoveredAnnotationId)
          ? state.hoveredAnnotationId
          : null,
        records: Object.freeze([...records]),
        resolutions,
      }));
    },
    setRetargetSelection(range, selector) {
      const interaction = get().interaction;
      if (interaction.type !== "retargeting") {
        throw new Error("Cannot set retarget selection outside retargeting state");
      }
      set({ interaction: Object.freeze({
        ...interaction,
        range,
        selector,
        selectionStatus: "ready",
      }) });
    },
    startMutation(kind, annotationId) {
      if (get().pendingMutation) {
        throw new Error("An annotation mutation is already pending");
      }
      const token = get().mutationSequence + 1;
      set({
        mutationSequence: token,
        pendingMutation: Object.freeze({ annotationId: annotationId ?? null, kind, token }),
      });
      return token;
    },
    togglePanel() {
      const open = !get().panelOpen;
      set({
        hoveredAnnotationId: open ? get().hoveredAnnotationId : null,
        interaction: open ? get().interaction : IDLE_INTERACTION,
        panelOpen: open,
      });
    },
    updateInteractionBody(body) {
      const interaction = get().interaction;
      if (interaction.type !== "drafting" && interaction.type !== "editing") {
        throw new Error("Current annotation interaction has no editable body");
      }
      set({ interaction: Object.freeze({ ...interaction, body }) });
    },
  }));
}

const IDLE_INTERACTION = Object.freeze({ type: "idle" as const });

export function emptyResolvedAnnotationIndex(textRevision = ""): ResolvedAnnotationIndex {
  return Object.freeze({
    ambiguous: Object.freeze([]),
    annotationSetRevision: "annotations:0",
    byId: Object.freeze({}),
    changed: Object.freeze([]),
    document: Object.freeze([]),
    ordered: Object.freeze([]),
    resolved: Object.freeze([]),
    textRevision,
  });
}

function initialAnnotationState(): AnnotationState {
  return {
    activeAnnotationId: null,
    document: null,
    error: null,
    flashAnnotationId: null,
    flashToken: 0,
    hoveredAnnotationId: null,
    interaction: IDLE_INTERACTION,
    loading: false,
    navigation: Object.freeze({ annotationId: null, error: null, requestId: 0, status: "idle" }),
    mutationSequence: 0,
    panelOpen: false,
    pendingMutation: null,
    records: Object.freeze([]),
    resolutions: emptyResolvedAnnotationIndex(),
  };
}

function reconcileInteraction(
  interaction: AnnotationInteraction,
  model: DocumentTextModel,
): AnnotationInteraction {
  if (interaction.type === "drafting") {
    if (!interaction.selector) return interaction;
    const resolution = resolveTextAnchor(model, interaction.selector);
    if (resolution.status !== "resolved") {
      return Object.freeze({
        ...interaction,
        range: null,
        selector: null,
        selectionStatus: resolution.status,
      });
    }
    return Object.freeze({
      ...interaction,
      range: resolution.range,
      selector: createTextSelector(model, resolution.range),
      selectionStatus: "ready",
    });
  }
  if (interaction.type === "retargeting" && interaction.selector) {
    const resolution = resolveTextAnchor(model, interaction.selector);
    if (resolution.status !== "resolved") {
      return Object.freeze({
        ...interaction,
        range: null,
        selector: null,
        selectionStatus: resolution.status,
      });
    }
    return Object.freeze({
      ...interaction,
      range: resolution.range,
      selector: createTextSelector(model, resolution.range),
      selectionStatus: "ready",
    });
  }
  return interaction;
}

function interactionSelectionError(interaction: AnnotationInteraction): string | null {
  if ((interaction.type === "drafting" || interaction.type === "retargeting")
    && interaction.selectionStatus === "ambiguous") {
    return "The annotation selection is ambiguous after the document changed; select the target again.";
  }
  if ((interaction.type === "drafting" || interaction.type === "retargeting")
    && interaction.selectionStatus === "changed") {
    return "The annotation selection changed with the document; select the target again.";
  }
  return null;
}
