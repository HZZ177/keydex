import { type ReactNode, useLayoutEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";

import type { ConversationRenderUnit } from "./ConversationRenderUnit";
import {
  ConversationTimelineRuntime,
  type ConversationTimelineAnchor,
  type ConversationTimelineDiagnostics,
} from "./ConversationTimelineRuntime";

export interface ConversationTimelineSurfaceHandle {
  revealUnit(unitId: string, align?: "start" | "center" | "end"): boolean;
  captureAnchor(viewportOffset?: number): ConversationTimelineAnchor | null;
  restoreAnchor(anchor: ConversationTimelineAnchor): boolean;
  setPinned(unitId: string, pinned: boolean): void;
  mountedUnitIds(): readonly string[];
  diagnostics(): ConversationTimelineDiagnostics | null;
  measureMounted(): void;
}

export interface ConversationTimelineSurfaceProps {
  readonly units: readonly ConversationRenderUnit[];
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
  readonly variant?: string;
}

/**
 * React is only used to mount/update the bounded set of complex visible units.
 * Scroll windowing, placement and measurement stay outside React in the
 * imperative timeline runtime, so a scroll event cannot reconcile MessageList.
 */
export function ConversationTimelineSurface({
  units,
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
  variant,
}: ConversationTimelineSurfaceProps) {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const runtimeInstanceRef = useRef<ConversationTimelineRuntime | null>(null);
  const renderUnitRef = useRef(renderUnit);
  const onPublishedRef = useRef(onPublished);
  const onViewportChangedRef = useRef(onViewportChanged);
  renderUnitRef.current = renderUnit;
  onPublishedRef.current = onPublished;
  onViewportChangedRef.current = onViewportChanged;

  useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    const roots = new Map<string, Root>();
    const runtime = new ConversationTimelineRuntime(element, {
      overscanPx,
      onPatch: () => onViewportChangedRef.current?.(),
      renderer: {
        mount(unit, host) {
          const root = createRoot(host);
          roots.set(unit.id, root);
          root.render(renderUnitRef.current(unit));
          return {
            update(nextUnit) {
              root.render(renderUnitRef.current(nextUnit));
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
    });
    runtime.canvas.className = canvasClassName ?? "";
    const canvasObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => onPublishedRef.current?.(runtime.diagnostics()));
    canvasObserver?.observe(runtime.canvas);
    runtimeInstanceRef.current = runtime;
    const handle: ConversationTimelineSurfaceHandle = {
      revealUnit: (unitId, align) => runtime.revealUnit(unitId, align),
      captureAnchor: (viewportOffset) => runtime.captureAnchor(viewportOffset),
      restoreAnchor: (anchor) => runtime.restoreAnchor(anchor),
      setPinned: (unitId, pinned) => {
        runtime.setPinned(unitId, pinned);
      },
      mountedUnitIds: () => runtime.mountedUnitIds(),
      diagnostics: () => runtime.diagnostics(),
      measureMounted: () => {
        runtime.measureMounted();
      },
    };
    if (runtimeRef) runtimeRef.current = handle;
    scrollerRef?.(element);
    return () => {
      scrollerRef?.(null);
      if (runtimeRef?.current === handle) runtimeRef.current = null;
      canvasObserver?.disconnect();
      runtime.destroy();
      runtimeInstanceRef.current = null;
      roots.clear();
    };
  }, [canvasClassName, overscanPx, runtimeRef, scrollerRef]);

  useLayoutEffect(() => {
    const runtime = runtimeInstanceRef.current;
    if (!runtime) return;
    runtime.publish(units);
    onPublishedRef.current?.(runtime.diagnostics());
  }, [units]);

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
