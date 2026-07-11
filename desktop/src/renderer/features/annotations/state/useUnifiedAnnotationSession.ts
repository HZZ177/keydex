import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";

import type { AnnotationsRuntime, TextSelector } from "@/runtime/annotations";
import type { MarkdownDocumentModel } from "@/renderer/components/workspace/markdownPreviewEngine";
import { markdownLogicalRangeFromDomRange } from "@/renderer/components/workspace/markdownPreviewEngine/selectionRange";

import { MarkdownAnnotationAdapter, type MarkdownAnnotationBinding } from "../adapters/MarkdownAnnotationAdapter";
import { SourceAnnotationAdapter } from "../adapters/SourceAnnotationAdapter";
import { createTextSelector } from "../anchoring/createTextSelector";
import { createMarkdownTextModel, type MarkdownTextModel } from "../document/MarkdownTextModel";
import { createPlainTextModel } from "../document/PlainTextModel";
import type { DocumentSelection, DocumentTextModel, LogicalRange } from "../document/DocumentTextModel";
import type { ResolvedTextAnnotation } from "../domain/resolutions";
import {
  markerAnchorPoint,
  normalizeDocumentGeometry,
  sameDocumentGeometry,
  type DocumentGeometrySnapshot,
} from "../layout/DocumentGeometry";
import { AnnotationNavigator, connectorViewId, type AnnotationViewMode } from "../navigation/AnnotationNavigator";
import { AnnotationViewRegistry } from "../navigation/AnnotationViewRegistry";
import type { AnnotationLanePlacement } from "../layout/AnnotationLaneLayout";
import type { AnnotationRenderMarker, AnnotationRenderState, AnnotationViewEvent, AnnotationViewId } from "../navigation/types";
import { annotationDocumentRegistry } from "../chat/AnnotationDocumentRegistry";
import { createAnnotationActions } from "./annotationActions";
import { createAnnotationStore, type AnnotationInteraction } from "./annotationStore";

export const DRAFT_ANNOTATION_ID = "__annotation_draft__";
export const RETARGET_ANNOTATION_ID = "__annotation_retarget__";

export function useUnifiedAnnotationSession({
  documentRevision,
  kind,
  markdownModel,
  mode,
  path,
  runtime,
  source,
  workspaceId,
}: {
  documentRevision: string | null;
  kind: string;
  markdownModel: MarkdownDocumentModel | null;
  mode: AnnotationViewMode;
  path: string | null;
  runtime: AnnotationsRuntime | null;
  source: string;
  workspaceId: string | null;
}) {
  const available = Boolean(documentRevision && path && runtime && workspaceId && kind !== "image");
  const model = useMemo<DocumentTextModel | null>(() => {
    if (!available || !documentRevision) return null;
    return kind === "markdown"
      ? createMarkdownTextModel(source, documentRevision)
      : createPlainTextModel(source, documentRevision);
  }, [available, documentRevision, kind, source]);
  const store = useMemo(() => createAnnotationStore(), []);
  const state = useStore(store, (value) => value);
  const sourceAdapter = useMemo(() => new SourceAnnotationAdapter(), []);
  const markdownAdapter = useMemo(() => new MarkdownAnnotationAdapter(), []);
  const registry = useMemo(() => new AnnotationViewRegistry(), []);
  const navigator = useMemo(() => new AnnotationNavigator(registry, store), [registry, store]);
  const actions = useMemo(
    () => runtime ? createAnnotationActions({ runtime, store }) : null,
    [runtime, store],
  );
  const [geometry, setGeometry] = useState<Partial<Record<AnnotationViewId, DocumentGeometrySnapshot>>>({});
  const [selections, setSelections] = useState<Partial<Record<AnnotationViewId, DocumentSelection | null>>>({});
  const [lanePlacements, setLanePlacements] = useState<readonly AnnotationLanePlacement[]>([]);
  const [railRevealRequest, setRailRevealRequest] = useState<{ annotationId: string; token: number } | null>(null);
  const railRevealSequence = useRef(0);
  const commitLanePlacements = useCallback((placements: readonly AnnotationLanePlacement[]) => {
    setLanePlacements((current) => sameLanePlacements(current, placements) ? current : placements);
  }, []);

  useEffect(() => {
    const unregisterSource = registry.register(sourceAdapter);
    const unregisterMarkdown = registry.register(markdownAdapter);
    const handle = (viewId: AnnotationViewId) => (event: AnnotationViewEvent) => {
      if (event.type === "marker-activate") {
        navigator.activateFromMarker(event.annotationId);
        railRevealSequence.current += 1;
        setRailRevealRequest({ annotationId: event.annotationId, token: railRevealSequence.current });
      } else if (event.type === "marker-hover") {
        store.getState().hover(event.annotationId);
      } else if (event.type === "selection") {
        setSelections((current) => ({ ...current, [viewId]: event.selection }));
      } else if (model && store.getState().panelOpen) {
        const snapshot = normalizeDocumentGeometry(viewId, model.revision.textRevision, event.snapshot);
        setGeometry((current) => {
          const previous = current[viewId];
          return previous && sameDocumentGeometry(previous, snapshot)
            ? current
            : { ...current, [viewId]: snapshot };
        });
      }
    };
    const unsubscribeSource = sourceAdapter.subscribe(handle("source"));
    const unsubscribeMarkdown = markdownAdapter.subscribe(handle("markdown"));
    return () => {
      unsubscribeSource();
      unsubscribeMarkdown();
      unregisterSource();
      unregisterMarkdown();
    };
  }, [markdownAdapter, model, navigator, registry, sourceAdapter, store]);

  useEffect(() => {
    sourceAdapter.setGeometryEnabled(state.panelOpen);
    markdownAdapter.setGeometryEnabled(state.panelOpen);
  }, [markdownAdapter, sourceAdapter, state.panelOpen]);

  useEffect(() => {
    setGeometry({});
    setSelections({});
    setLanePlacements([]);
    setRailRevealRequest(null);
    if (!available || !model || !path || !workspaceId || !actions) {
      store.getState().dispose();
      return;
    }
    store.getState().setDocument({ model, path, workspaceId });
    void actions.load();
  }, [actions, available, model, path, store, workspaceId]);

  useEffect(() => {
    if (!available || !model || !path || !workspaceId) return;
    const registration = annotationDocumentRegistry.register({
      index: state.resolutions,
      model,
      path,
      workspaceId,
    });
    return () => registration.dispose();
  }, [available, model, path, state.resolutions, workspaceId]);

  useEffect(() => () => {
    actions?.dispose();
    navigator.dispose();
    registry.dispose();
    sourceAdapter.dispose();
    markdownAdapter.dispose();
    store.getState().dispose();
  }, [actions, markdownAdapter, navigator, registry, sourceAdapter, store]);

  const markers = useMemo<readonly AnnotationRenderMarker[]>(() => {
    const persistent = state.resolutions.resolved.map((item) => ({
      annotationId: item.record.id,
      blockRanges: item.projection.blockRanges,
      logicalRange: item.projection.logicalRange,
      sourceRanges: item.projection.sourceRanges,
    }));
    const interactionMarker = interactionRenderMarker(state.interaction, model);
    return Object.freeze(interactionMarker ? [...persistent, interactionMarker] : persistent);
  }, [model, state.interaction, state.resolutions.resolved]);
  const renderState = useMemo<AnnotationRenderState>(() => Object.freeze({
    activeAnnotationId: state.activeAnnotationId,
    flashAnnotationId: state.flashAnnotationId,
    flashToken: state.flashToken,
    hoveredAnnotationId: state.hoveredAnnotationId,
    markers,
    revision: `${state.resolutions.annotationSetRevision}:${state.resolutions.textRevision}`,
  }), [markers, state.activeAnnotationId, state.flashAnnotationId, state.flashToken, state.hoveredAnnotationId, state.resolutions.annotationSetRevision, state.resolutions.textRevision]);

  useEffect(() => {
    sourceAdapter.render(renderState);
    markdownAdapter.render(renderState);
  }, [markdownAdapter, renderState, sourceAdapter]);

  const navigate = useCallback((item: ResolvedTextAnnotation) => {
    void navigator.navigate({ annotationId: item.record.id, mode, projection: item.projection }).catch(() => undefined);
  }, [mode, navigator]);
  const beginDraft = useCallback((selection: DocumentSelection | null) => {
    if (!model || !selection) return false;
    const projection = model.projectSelection(selection);
    if (!projection) return false;
    const selector = createTextSelector(model, projection.logicalRange);
    store.getState().beginDraft(projection.logicalRange, selector);
    return true;
  }, [model, store]);
  const beginDraftFromMarkdownRange = useCallback((range: Range | null, boundary: HTMLElement | null) => {
    if (model?.kind !== "markdown" || !range || !boundary) return false;
    const result = markdownLogicalRangeFromDomRange(model as MarkdownTextModel, range, boundary);
    return result.range ? beginDraft({ coordinateSpace: "logical", range: result.range }) : false;
  }, [beginDraft, model]);
  const setRetargetSelection = useCallback((selection: DocumentSelection | null) => {
    if (!model || !selection) return false;
    const projection = model.projectSelection(selection);
    if (!projection) return false;
    store.getState().setRetargetSelection(projection.logicalRange, createTextSelector(model, projection.logicalRange));
    return true;
  }, [model, store]);
  const setRetargetFromMarkdownRange = useCallback((range: Range | null, boundary: HTMLElement | null) => {
    if (model?.kind !== "markdown" || !range || !boundary) return false;
    const result = markdownLogicalRangeFromDomRange(model as MarkdownTextModel, range, boundary);
    return result.range ? setRetargetSelection({ coordinateSpace: "logical", range: result.range }) : false;
  }, [model, setRetargetSelection]);
  const submitDraft = useCallback(async () => {
    const interaction = store.getState().interaction;
    if (!actions || interaction.type !== "drafting" || !interaction.body.trim()) return false;
    return Boolean(await actions.createText(interaction.body.trim(), interaction.selector));
  }, [actions, store]);
  const submitRetarget = useCallback(async (annotationId: string, selector: TextSelector) => Boolean(await actions?.retarget(annotationId, selector)), [actions]);

  const connectorGeometrySnapshot = geometry[connectorViewId(mode)] ?? null;
  const railItems = useMemo(() => state.resolutions.resolved.map((resolution, index) => {
    const point = connectorGeometrySnapshot ? markerAnchorPoint(connectorGeometrySnapshot, resolution.record.id) : null;
    const logicalLength = Math.max(1, model?.logicalText.length ?? 1);
    const stagedHeight = Math.max(600, connectorGeometrySnapshot?.documentHeight ?? 0);
    const stagedY = 80 + (resolution.projection.logicalRange.start / logicalLength) * Math.max(1, stagedHeight - 160);
    return { anchorY: point?.y ?? stagedY + index * 0.001, resolution };
  }), [connectorGeometrySnapshot, model?.logicalText.length, state.resolutions.resolved]);
  const draftingRange = state.interaction.type === "drafting" ? state.interaction.range : null;
  const draftAnchorY = draftingRange
    ? (connectorGeometrySnapshot ? markerAnchorPoint(connectorGeometrySnapshot, DRAFT_ANNOTATION_ID)?.y : undefined)
      ?? stagedLogicalAnchorY(
        draftingRange.start,
        Math.max(1, model?.logicalText.length ?? 1),
        Math.max(600, connectorGeometrySnapshot?.documentHeight ?? 0),
      )
    : null;
  const retargetAnchorY = connectorGeometrySnapshot
    ? markerAnchorPoint(connectorGeometrySnapshot, RETARGET_ANNOTATION_ID)?.y ?? null
    : null;
  const activeSelection = selections[connectorViewId(mode)] ?? null;
  const bindMarkdown = useCallback((binding: MarkdownAnnotationBinding | null) => {
    if (!binding) return () => undefined;
    return markdownAdapter.attach(binding);
  }, [markdownAdapter]);
  const notifyMarkdownLayoutChange = useCallback(() => {
    markdownAdapter.notifyMountedBlocksChanged();
  }, [markdownAdapter]);

  return {
    actions,
    activeSelection,
    available,
    beginDraft,
    beginDraftFromMarkdownRange,
    bindMarkdown,
    connectorGeometry: connectorGeometrySnapshot,
    draftAnchorY,
    lanePlacements,
    markdownAdapter,
    model,
    navigate,
    notifyMarkdownLayoutChange,
    railItems,
    railRevealRequest,
    retargetAnchorY,
    renderState,
    setLanePlacements: commitLanePlacements,
    setRetargetSelection,
    setRetargetFromMarkdownRange,
    sourceAdapter,
    state,
    store,
    submitDraft,
    submitRetarget,
  };
}

function stagedLogicalAnchorY(position: number, logicalLength: number, documentHeight: number): number {
  return 80 + (Math.max(0, Math.min(position, logicalLength)) / logicalLength) * Math.max(1, documentHeight - 160);
}

function sameLanePlacements(
  left: readonly AnnotationLanePlacement[],
  right: readonly AnnotationLanePlacement[],
): boolean {
  return left.length === right.length && left.every((item, index) => {
    const candidate = right[index];
    return Boolean(candidate)
      && item.id === candidate.id
      && item.anchorY === candidate.anchorY
      && item.cardY === candidate.cardY
      && item.connectorY === candidate.connectorY
      && item.height === candidate.height
      && item.createdAt === candidate.createdAt;
  });
}

export type UnifiedAnnotationSession = ReturnType<typeof useUnifiedAnnotationSession>;

function interactionRenderMarker(
  interaction: AnnotationInteraction,
  model: DocumentTextModel | null,
): AnnotationRenderMarker | null {
  if (!model) return null;
  const range: LogicalRange | null = interaction.type === "drafting"
    ? interaction.range
    : interaction.type === "retargeting" ? interaction.range : null;
  if (!range) return null;
  const projection = model.projectView(range);
  return Object.freeze({
    annotationId: interaction.type === "drafting" ? DRAFT_ANNOTATION_ID : RETARGET_ANNOTATION_ID,
    blockRanges: projection.blockRanges,
    logicalRange: projection.logicalRange,
    sourceRanges: projection.sourceRanges,
  });
}
