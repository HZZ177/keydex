import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet, type ViewUpdate } from "@codemirror/view";

import type { DocumentSelection, SourceRange } from "../document/DocumentTextModel";
import type {
  AnnotationRenderState,
  AnnotationRevealRequest,
  AnnotationViewAdapter,
  AnnotationViewEvent,
  AnnotationViewGeometrySnapshot,
  DocumentCoordinateRect,
} from "../navigation/types";
import { AnnotationGeometryScheduler } from "./AnnotationGeometryScheduler";
import {
  restartAnnotationNavigationFlash,
  smoothScrollElementTo,
} from "../navigation/AnnotationNavigationEffects";

const setAnnotationRenderState = StateEffect.define<AnnotationRenderState>();

const annotationDecorations = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setAnnotationRenderState)) {
        return decorationsForState(effect.value, transaction.state.doc.length);
      }
    }
    return value.map(transaction.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

export class SourceAnnotationAdapter implements AnnotationViewAdapter {
  readonly id = "source" as const;
  readonly extension: Extension;
  private readonly listeners = new Set<(event: AnnotationViewEvent) => void>();
  private readonly readyWaiters = new Set<{
    reject: (reason: unknown) => void;
    resolve: () => void;
  }>();
  private view: EditorView | null = null;
  private scrollElement: HTMLElement | null = null;
  private cleanupAttachment: (() => void) | null = null;
  private renderState: AnnotationRenderState = EMPTY_RENDER_STATE;
  private geometryRevision = 0;
  private geometryEnabled = false;
  private disposed = false;
  private readonly geometryScheduler = new AnnotationGeometryScheduler(() => this.emitGeometryNow());

  constructor() {
    this.extension = [
      annotationDecorations,
      EditorView.updateListener.of((update) => this.handleUpdate(update)),
      EditorView.domEventHandlers({
        click: (event) => {
          const element = event.target instanceof Element
            ? event.target.closest<HTMLElement>("[data-annotation-id]")
            : null;
          const annotationId = element?.dataset.annotationId;
          if (annotationId) {
            this.emit({ type: "marker-activate", annotationId });
          }
          return false;
        },
        mouseout: (event) => {
          this.emitMarkerHoverTransition(event);
          return false;
        },
        mouseover: (event) => {
          this.emitMarkerHoverTransition(event);
          return false;
        },
      }),
    ];
  }

  attach(view: EditorView, scrollElement: HTMLElement = view.scrollDOM): () => void {
    if (this.disposed) {
      throw new Error("Source annotation adapter is disposed");
    }
    this.cleanupAttachment?.();
    this.view = view;
    this.scrollElement = scrollElement;
    view.dispatch({ effects: setAnnotationRenderState.of(this.renderState) });
    const requestGeometry = () => this.requestGeometryMeasure();
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(requestGeometry);
    resizeObserver?.observe(scrollElement);
    resizeObserver?.observe(view.contentDOM);
    for (const waiter of this.readyWaiters) {
      waiter.resolve();
    }
    this.readyWaiters.clear();
    this.requestGeometryMeasure();
    const cleanup = () => {
      resizeObserver?.disconnect();
      if (this.view === view) {
        this.geometryScheduler.cancel();
        this.view = null;
        this.scrollElement = null;
      }
      if (this.cleanupAttachment === cleanup) {
        this.cleanupAttachment = null;
      }
    };
    this.cleanupAttachment = cleanup;
    return cleanup;
  }

  isReady(): boolean {
    return this.view !== null;
  }

  flashMarker(annotationId: string): void {
    const root = this.view?.dom;
    if (!root) {
      return;
    }
    for (const marker of root.querySelectorAll<HTMLElement>(".cm-annotation-mark[data-annotation-id]")) {
      if (marker.dataset.annotationId === annotationId) {
        restartAnnotationNavigationFlash(marker);
      }
    }
  }

  whenReady(signal: AbortSignal): Promise<void> {
    if (this.view) {
      return Promise.resolve();
    }
    if (signal.aborted) {
      return Promise.reject(abortError("Source annotation view readiness aborted"));
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        },
        reject: (reason: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(reason);
        },
      };
      const onAbort = () => {
        this.readyWaiters.delete(waiter);
        reject(abortError("Source annotation view readiness aborted"));
      };
      this.readyWaiters.add(waiter);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  render(state: AnnotationRenderState): void {
    const decorationChanged = this.renderState.activeAnnotationId !== state.activeAnnotationId
      || this.renderState.flashAnnotationId !== state.flashAnnotationId
      || this.renderState.flashToken !== state.flashToken
      || this.renderState.revision !== state.revision
      || this.renderState.markers !== state.markers;
    const geometryChanged = this.renderState.revision !== state.revision || this.renderState.markers !== state.markers;
    this.renderState = state;
    if (decorationChanged) {
      this.view?.dispatch({ effects: setAnnotationRenderState.of(state) });
    }
    this.applyHoveredState(state.hoveredAnnotationId);
    if (geometryChanged) {
      this.requestGeometryMeasure();
    }
  }

  setGeometryEnabled(enabled: boolean): void {
    if (this.geometryEnabled === enabled) {
      return;
    }
    this.geometryEnabled = enabled;
    if (enabled) {
      this.requestGeometryMeasure();
    } else {
      this.geometryScheduler.cancel();
    }
  }

  selection(): DocumentSelection | null {
    const selection = this.view?.state.selection.main;
    if (!selection || selection.empty) {
      return null;
    }
    return {
      coordinateSpace: "source",
      range: {
        start: Math.min(selection.from, selection.to),
        end: Math.max(selection.from, selection.to),
      },
    };
  }

  async reveal(request: AnnotationRevealRequest): Promise<void> {
    if (request.signal.aborted) {
      throw abortError("Source annotation reveal aborted");
    }
    const view = this.view;
    const target = request.sourceRanges[0];
    if (!view || !target) {
      throw new Error("Source annotation target is unavailable");
    }
    const start = Math.max(0, Math.min(target.start, view.state.doc.length));
    const end = Math.max(start, Math.min(target.end, view.state.doc.length));
    view.dispatch({ selection: { anchor: start, head: end } });
    if (!request.scroll) {
      return;
    }
    const scrollElement = this.scrollElement ?? view.scrollDOM;
    const coordinates = view.coordsAtPos(start);
    if (!coordinates) {
      throw new Error("Source annotation target geometry is unavailable");
    }
    const scrollRect = scrollElement.getBoundingClientRect();
    const targetY = coordinates.top - scrollRect.top + scrollElement.scrollTop;
    const maxScrollTop = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
    const top = Math.max(0, Math.min(targetY - scrollElement.clientHeight / 2, maxScrollTop));
    await smoothScrollElementTo(scrollElement, top, request.signal);
  }

  geometry(): AnnotationViewGeometrySnapshot {
    const view = this.view;
    const scrollElement = this.scrollElement;
    if (!view || !scrollElement) {
      return emptyGeometry(this.geometryRevision);
    }
    const scrollRect = scrollElement.getBoundingClientRect();
    const visibleRanges = view.visibleRanges;
    const renderedRects = renderedMarkerRects(view, scrollElement, scrollRect);
    const markers: Record<string, readonly DocumentCoordinateRect[]> = {};
    for (const marker of this.renderState.markers) {
      const exactRects = renderedRects.get(marker.annotationId) ?? [];
      markers[marker.annotationId] = Object.freeze(exactRects.length > 0
        ? exactRects
        : marker.sourceRanges.flatMap((range) =>
          visibleRanges.flatMap((visibleRange) => {
            const start = Math.max(range.start, visibleRange.from);
            const end = Math.min(range.end, visibleRange.to);
            return end > start
              ? safeSourceRangeRects(view, { start, end }, scrollElement, scrollRect)
              : [];
          })));
    }
    return Object.freeze({
      documentHeight: view.contentHeight,
      markers: Object.freeze(markers),
      revision: this.geometryRevision,
      scrollOffset: scrollElement.scrollTop,
      viewportHeight: scrollElement.clientHeight,
      viewportWidth: scrollElement.clientWidth,
    });
  }

  subscribe(listener: (event: AnnotationViewEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    this.disposed = true;
    this.geometryScheduler.cancel();
    this.cleanupAttachment?.();
    for (const waiter of this.readyWaiters) {
      waiter.reject(abortError("Source annotation adapter disposed"));
    }
    this.readyWaiters.clear();
    this.listeners.clear();
  }

  private handleUpdate(update: ViewUpdate): void {
    if (update.selectionSet) {
      this.emit({ type: "selection", selection: this.selection() });
    }
    if (update.docChanged || update.geometryChanged || update.viewportChanged) {
      this.requestGeometryMeasure();
    }
  }

  private requestGeometryMeasure(): void {
    if (!this.view || !this.geometryEnabled) {
      return;
    }
    this.geometryScheduler.request();
  }

  private emitGeometryNow(): void {
    if (!this.view || !this.geometryEnabled) {
      return;
    }
    this.geometryRevision += 1;
    this.emit({ type: "geometry", snapshot: this.geometry() });
  }

  private emitMarkerHoverTransition(event: MouseEvent): void {
    const annotationId = markerHoverTransition(event);
    if (annotationId !== undefined) {
      this.applyHoveredState(annotationId);
      this.emit({ type: "marker-hover", annotationId });
    }
  }

  private applyHoveredState(annotationId: string | null): void {
    const root = this.view?.dom;
    if (!root) {
      return;
    }
    for (const marker of root.querySelectorAll<HTMLElement>(".cm-annotation-mark[data-annotation-id]")) {
      marker.dataset.hovered = marker.dataset.annotationId === annotationId ? "true" : "false";
    }
  }

  private emit(event: AnnotationViewEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

function renderedMarkerRects(
  view: EditorView,
  scrollElement: HTMLElement,
  scrollRect: DOMRect,
): ReadonlyMap<string, readonly DocumentCoordinateRect[]> {
  const markers = new Map<string, DocumentCoordinateRect[]>();
  for (const element of view.dom.querySelectorAll<HTMLElement>(".cm-annotation-mark[data-annotation-id]")) {
    const annotationId = element.dataset.annotationId;
    if (!annotationId) continue;
    let rects: readonly DOMRect[];
    try {
      rects = Array.from(element.getClientRects());
    } catch {
      rects = [];
    }
    const target = markers.get(annotationId) ?? [];
    for (const rect of rects) {
      if (rect.width <= 0 && rect.height <= 0) continue;
      target.push(Object.freeze({
        bottom: rect.bottom - scrollRect.top + scrollElement.scrollTop,
        left: rect.left - scrollRect.left + scrollElement.scrollLeft,
        right: rect.right - scrollRect.left + scrollElement.scrollLeft,
        top: rect.top - scrollRect.top + scrollElement.scrollTop,
      }));
    }
    if (target.length > 0) markers.set(annotationId, target);
  }
  return markers;
}

function decorationsForState(state: AnnotationRenderState, documentLength: number): DecorationSet {
  const ranges = state.markers.flatMap((marker) => marker.sourceRanges.map((range) => {
    const start = Math.max(0, Math.min(range.start, documentLength));
    const end = Math.max(start, Math.min(range.end, documentLength));
    if (end <= start) {
      return null;
    }
    return Decoration.mark({
      class: "cm-annotation-mark",
      attributes: {
        "data-active": marker.annotationId === state.activeAnnotationId ? "true" : "false",
        "data-annotation-id": marker.annotationId,
        "data-flash": marker.annotationId === state.flashAnnotationId ? "true" : "false",
        "data-flash-token": String(state.flashToken),
        "data-hovered": marker.annotationId === state.hoveredAnnotationId ? "true" : "false",
      },
    }).range(start, end);
  })).filter((range): range is NonNullable<typeof range> => range !== null);
  return Decoration.set(ranges, true);
}

function sourceRangeRects(
  view: EditorView,
  range: SourceRange,
  scrollElement: HTMLElement,
  scrollRect: DOMRect,
): DocumentCoordinateRect[] {
  const start = Math.max(0, Math.min(range.start, view.state.doc.length));
  const end = Math.max(start, Math.min(range.end, view.state.doc.length));
  if (end <= start) {
    return [];
  }
  const rects: DocumentCoordinateRect[] = [];
  let cursor = start;
  while (cursor < end) {
    const line = view.state.doc.lineAt(cursor);
    const fragmentEnd = Math.min(end, line.to);
    const startCoords = view.coordsAtPos(cursor);
    const endCoords = view.coordsAtPos(Math.max(cursor, fragmentEnd));
    if (startCoords && endCoords) {
      rects.push(Object.freeze({
        bottom: Math.max(startCoords.bottom, endCoords.bottom) - scrollRect.top + scrollElement.scrollTop,
        left: startCoords.left - scrollRect.left + scrollElement.scrollLeft,
        right: endCoords.right - scrollRect.left + scrollElement.scrollLeft,
        top: Math.min(startCoords.top, endCoords.top) - scrollRect.top + scrollElement.scrollTop,
      }));
    }
    cursor = fragmentEnd < end ? line.to + 1 : end;
  }
  return rects;
}

function safeSourceRangeRects(
  view: EditorView,
  range: SourceRange,
  scrollElement: HTMLElement,
  scrollRect: DOMRect,
): DocumentCoordinateRect[] {
  try {
    return sourceRangeRects(view, range, scrollElement, scrollRect);
  } catch {
    return [];
  }
}

function emptyGeometry(revision: number): AnnotationViewGeometrySnapshot {
  return Object.freeze({
    documentHeight: 0,
    markers: Object.freeze({}),
    revision,
    scrollOffset: 0,
    viewportHeight: 0,
    viewportWidth: 0,
  });
}

function abortError(message: string): DOMException {
  return new DOMException(message, "AbortError");
}

const EMPTY_RENDER_STATE: AnnotationRenderState = Object.freeze({
  activeAnnotationId: null,
  flashAnnotationId: null,
  flashToken: 0,
  hoveredAnnotationId: null,
  markers: Object.freeze([]),
  revision: "empty",
});

function markerHoverTransition(event: MouseEvent): string | null | undefined {
  const current = annotationIdFromTarget(event.target);
  const related = annotationIdFromTarget(event.relatedTarget);
  return current === related ? undefined : event.type === "mouseover" ? current : related;
}

function annotationIdFromTarget(target: EventTarget | null): string | null {
  const marker = target instanceof Element ? target.closest<HTMLElement>("[data-annotation-id]") : null;
  return marker?.dataset.annotationId ?? null;
}
