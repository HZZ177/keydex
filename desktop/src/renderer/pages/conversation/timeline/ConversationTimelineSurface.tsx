import { type ReactNode, useLayoutEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { ConversationRenderUnit } from "./ConversationRenderUnit";
import {
  ConversationTimelineRuntime,
  type ConversationTimelineAnchor,
  type ConversationTimelineDiagnostics,
  type ConversationTimelineScrollRequest,
} from "./ConversationTimelineRuntime";

const EMPTY_RESIDENT_UNIT_IDS: readonly string[] = Object.freeze([]);

export interface ConversationTimelineSurfaceHandle {
  revealUnit(unitId: string, align?: "start" | "center" | "end"): boolean;
  setFollowBottom(enabled: boolean): void;
  setUserScrollInteraction(active: boolean): void;
  setControlledScrollInteraction(active: boolean): void;
  settleControlledScrollViewport(): void;
  captureAnchor(viewportOffset?: number): ConversationTimelineAnchor | null;
  restoreAnchor(anchor: ConversationTimelineAnchor): boolean;
  setPinned(unitId: string, pinned: boolean): void;
  setResidentUnits(unitIds: readonly string[]): void;
  getUnitElement(unitId: string): HTMLElement | null;
  mountedUnitIds(): readonly string[];
  diagnostics(): ConversationTimelineDiagnostics | null;
  measureMounted(): void;
}

export interface ConversationTimelineSurfaceProps {
  readonly units: readonly ConversationRenderUnit[];
  readonly residentUnitIds?: readonly string[];
  readonly renderUnit: (unit: ConversationRenderUnit) => ReactNode;
  readonly className?: string;
  readonly canvasClassName?: string;
  readonly overscanPx?: number;
  readonly runtimeRef?: { current: ConversationTimelineSurfaceHandle | null };
  readonly scrollerRef?: (element: HTMLElement | null) => void;
  readonly onPointerDown?: (event: React.PointerEvent<HTMLDivElement>) => void;
  readonly onWheel?: (event: React.WheelEvent<HTMLDivElement>) => void;
  readonly onScroll?: (event: React.UIEvent<HTMLDivElement>) => void;
  readonly onPublished?: (diagnostics: ConversationTimelineDiagnostics) => void;
  readonly onViewportChanged?: () => void;
  readonly onScrollRequest?: (request: ConversationTimelineScrollRequest) => void;
  readonly followBottom?: boolean;
  readonly variant?: string;
}

/**
 * React is only used to mount/update the bounded set of complex visible units.
 * Scroll windowing, placement and measurement stay outside React in the
 * imperative timeline runtime, so a scroll event cannot reconcile MessageList.
 */
export function ConversationTimelineSurface({
  units,
  residentUnitIds = EMPTY_RESIDENT_UNIT_IDS,
  renderUnit,
  className,
  canvasClassName,
  overscanPx = 1800,
  runtimeRef,
  scrollerRef,
  onPointerDown,
  onWheel,
  onScroll,
  onPublished,
  onViewportChanged,
  onScrollRequest,
  followBottom = false,
  variant,
}: ConversationTimelineSurfaceProps) {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const runtimeInstanceRef = useRef<ConversationTimelineRuntime | null>(null);
  const renderUnitRef = useRef(renderUnit);
  const onPublishedRef = useRef(onPublished);
  const onViewportChangedRef = useRef(onViewportChanged);
  const onScrollRequestRef = useRef(onScrollRequest);
  const scrollerRefRef = useRef(scrollerRef);
  renderUnitRef.current = renderUnit;
  onPublishedRef.current = onPublished;
  onViewportChangedRef.current = onViewportChanged;
  onScrollRequestRef.current = onScrollRequest;
  scrollerRefRef.current = scrollerRef;

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    const roots = new Map<string, Root>();
    let runtime: ConversationTimelineRuntime;
    runtime = new ConversationTimelineRuntime(element, {
      overscanPx,
      onPatch: () => onViewportChangedRef.current?.(),
      onScrollRequest: (request) => onScrollRequestRef.current?.(request),
      renderer: {
        mount(unit, host) {
          const root = createRoot(host);
          roots.set(unit.id, root);
          const render = (nextUnit: ConversationRenderUnit) => {
            const content = (
              <ConversationTimelineMeasurementCommit
                unit={nextUnit}
                onCommit={(committedUnit) => {
                  if (runtimeInstanceRef.current === runtime) runtime.commitRenderedUnit(committedUnit);
                }}
              >
                {renderUnitRef.current(nextUnit)}
              </ConversationTimelineMeasurementCommit>
            );
            root.render(content);
          };
          render(unit);
          return {
            update(nextUnit) {
              render(nextUnit);
            },
            destroy() {
              roots.delete(unit.id);
              // Slot disposal can happen while the parent root is committing a
              // new publication. Defer the local-root teardown to the next
              // microtask so React never recursively unmounts during render.
              queueMicrotask(() => root.unmount());
            },
          };
        },
      },
      followBottom,
    });
    runtime.canvas.className = canvasClassName ?? "";
    let canvasPublishFrame: number | null = null;
    const canvasObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => {
          if (canvasPublishFrame !== null) return;
          const view = element.ownerDocument.defaultView;
          if (!view) {
            onPublishedRef.current?.(runtime.diagnostics());
            return;
          }
          canvasPublishFrame = view.requestAnimationFrame(() => {
            canvasPublishFrame = null;
            onPublishedRef.current?.(runtime.diagnostics());
          });
        });
    canvasObserver?.observe(runtime.canvas);
    runtimeInstanceRef.current = runtime;
    const handle: ConversationTimelineSurfaceHandle = {
      revealUnit: (unitId, align) => runtime.revealUnit(unitId, align),
      setFollowBottom: (enabled) => {
        runtime.setFollowBottom(enabled);
      },
      setUserScrollInteraction: (active) => {
        runtime.setUserScrollInteraction(active);
      },
      setControlledScrollInteraction: (active) => {
        runtime.setControlledScrollInteraction(active);
      },
      settleControlledScrollViewport: () => {
        runtime.settleControlledScrollViewport();
      },
      captureAnchor: (viewportOffset) => runtime.captureAnchor(viewportOffset),
      restoreAnchor: (anchor) => runtime.restoreAnchor(anchor),
      setPinned: (unitId, pinned) => {
        runtime.setPinned(unitId, pinned);
      },
      setResidentUnits: (unitIds) => {
        runtime.setResidentUnits(unitIds);
      },
      getUnitElement: (unitId) => runtime.getUnitElement(unitId),
      mountedUnitIds: () => runtime.mountedUnitIds(),
      diagnostics: () => runtime.diagnostics(),
      measureMounted: () => {
        runtime.measureMounted();
      },
    };
    if (runtimeRef) runtimeRef.current = handle;
    scrollerRefRef.current?.(element);
    return () => {
      scrollerRefRef.current?.(null);
      if (runtimeRef?.current === handle) runtimeRef.current = null;
      canvasObserver?.disconnect();
      if (canvasPublishFrame !== null) element.ownerDocument.defaultView?.cancelAnimationFrame(canvasPublishFrame);
      runtime.destroy();
      runtimeInstanceRef.current = null;
      roots.clear();
    };
  }, [canvasClassName, overscanPx, runtimeRef]);

  useLayoutEffect(() => {
    runtimeInstanceRef.current?.setFollowBottom(followBottom);
  }, [followBottom]);

  useLayoutEffect(() => {
    const runtime = runtimeInstanceRef.current;
    if (!runtime) return;
    runtime.publish(units, residentUnitIds);
    onPublishedRef.current?.(runtime.diagnostics());
  }, [residentUnitIds, units]);

  return (
    <div
      ref={elementRef}
      className={className}
      data-message-list-scroll="true"
      data-message-list-variant={variant}
      data-testid="message-list-scroll"
      onPointerDown={onPointerDown}
      onWheel={onWheel}
      onScroll={onScroll}
    />
  );
}

function ConversationTimelineMeasurementCommit({
  children,
  onCommit,
  unit,
}: {
  readonly children: ReactNode;
  readonly onCommit: (unit: ConversationRenderUnit) => void;
  readonly unit: ConversationRenderUnit;
}) {
  useLayoutEffect(() => {
    onCommit(unit);
  }, [onCommit, unit]);
  return children;
}
