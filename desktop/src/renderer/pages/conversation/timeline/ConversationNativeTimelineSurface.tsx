import {
  type PointerEvent,
  type ReactNode,
  type UIEvent,
  type WheelEvent,
  memo,
  useLayoutEffect,
  useRef,
} from "react";

import type { ConversationRenderUnit } from "./ConversationRenderUnit";
import type {
  ConversationTimelineAnchor,
  ConversationTimelineDiagnostics,
  ConversationTimelineScrollRequest,
} from "./ConversationTimelineRuntime";
import {
  CONVERSATION_GEOMETRY_COMMIT_EVENT,
  conversationGeometryCommitDetail,
} from "./ConversationGeometryCommit";
import type { ConversationTimelineSurfaceHandle } from "./ConversationTimelineSurface";

export interface ConversationNativeTimelineSurfaceProps {
  readonly units: readonly ConversationRenderUnit[];
  readonly renderUnit: (unit: ConversationRenderUnit) => ReactNode;
  readonly before?: ReactNode;
  readonly className?: string;
  readonly contentClassName?: string;
  readonly runtimeRef?: { current: ConversationTimelineSurfaceHandle | null };
  readonly scrollerRef?: (element: HTMLElement | null) => void;
  readonly onPointerDown?: (event: PointerEvent<HTMLDivElement>) => void;
  readonly onWheel?: (event: WheelEvent<HTMLDivElement>) => void;
  readonly onScroll?: (event: UIEvent<HTMLDivElement>) => void;
  readonly onPublished?: (diagnostics: ConversationTimelineDiagnostics) => void;
  readonly onScrollRequest?: (request: ConversationTimelineScrollRequest) => void;
  readonly followBottom?: boolean;
  readonly variant?: string;
}

/**
 * UX-first conversation surface for ordinary histories.
 *
 * Every unit participates in one normal document flow, so the browser owns
 * layout, scroll height, anchoring and the native scrollbar. There are no
 * estimated positions, recycled hosts or clipped partially committed units.
 */
export function ConversationNativeTimelineSurface({
  units,
  renderUnit,
  before,
  className,
  contentClassName,
  runtimeRef,
  scrollerRef,
  onPointerDown,
  onWheel,
  onScroll,
  onPublished,
  onScrollRequest,
  followBottom = false,
  variant,
}: ConversationNativeTimelineSurfaceProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const elementsByIdRef = useRef(new Map<string, HTMLElement>());
  const unitsRef = useRef(units);
  const renderRevisionRef = useRef(0);
  const followBottomRef = useRef(followBottom);
  const onPublishedRef = useRef(onPublished);
  const onScrollRequestRef = useRef(onScrollRequest);
  const scrollerRefRef = useRef(scrollerRef);
  const lastPublishedHeightRef = useRef<number | null>(null);
  const resizeFrameRef = useRef<number | null>(null);
  unitsRef.current = units;
  followBottomRef.current = followBottom;
  onPublishedRef.current = onPublished;
  onScrollRequestRef.current = onScrollRequest;
  scrollerRefRef.current = scrollerRef;

  const requestScroll = (scrollTop: number, reason: ConversationTimelineScrollRequest["reason"]) => {
    onScrollRequestRef.current?.(Object.freeze({ scrollTop, reason }));
  };

  const diagnostics = (): ConversationTimelineDiagnostics => {
    const root = rootRef.current;
    return Object.freeze({
      revision: `conversation-native:${renderRevisionRef.current}`,
      units: unitsRef.current.length,
      mounted: elementsByIdRef.current.size,
      recycled: 0,
      pinned: 0,
      measured: elementsByIdRef.current.size,
      totalHeight: root?.scrollHeight ?? 0,
      domNodes: root?.querySelectorAll("*").length ?? 0,
      patches: renderRevisionRef.current,
      scrollPatches: 0,
      followBottom: followBottomRef.current,
      userScrollActive: false,
      controlledScrollActive: false,
      topLocked: false,
      deferredMeasurements: 0,
    });
  };

  const publishLayout = (force = false) => {
    const root = rootRef.current;
    const content = contentRef.current;
    if (!root || !content) return;
    const height = content.getBoundingClientRect().height;
    if (!force && lastPublishedHeightRef.current !== null && Math.abs(lastPublishedHeightRef.current - height) < 0.5) {
      return;
    }
    lastPublishedHeightRef.current = height;
    root.dataset.conversationTimelineMountedUnits = String(elementsByIdRef.current.size);
    root.dataset.conversationTimelineLayoutMode = "native";
    content.dataset.conversationTimelineTotalHeight = String(root.scrollHeight);
    if (followBottomRef.current) requestScroll(nativeBottom(root), "follow-bottom");
    onPublishedRef.current?.(diagnostics());
  };

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const handle: ConversationTimelineSurfaceHandle = {
      revealUnit(unitId, align = "center") {
        const element = elementsByIdRef.current.get(unitId);
        if (!element) return false;
        requestScroll(nativeRevealTop(root, element, align), "reveal-unit");
        return true;
      },
      setFollowBottom(enabled) {
        followBottomRef.current = enabled;
        if (enabled) requestScroll(nativeBottom(root), "follow-bottom");
      },
      setUserScrollInteraction() {},
      captureAnchor(viewportOffset = 0) {
        return captureNativeAnchor(root, unitsRef.current, elementsByIdRef.current, viewportOffset, renderRevisionRef.current);
      },
      restoreAnchor(anchor) {
        const element = elementsByIdRef.current.get(anchor.unitId);
        if (!element) return false;
        const elementTop = nativeElementTop(root, element);
        requestScroll(
          clamp(
            elementTop + anchor.offsetWithinUnit - anchor.viewportOffset,
            0,
            nativeBottom(root),
          ),
          "restore-anchor",
        );
        return true;
      },
      setPinned() {},
      setResidentUnits() {},
      setControlledScrollInteraction() {},
      settleControlledScrollViewport() {},
      getUnitElement: (unitId) => elementsByIdRef.current.get(unitId) ?? null,
      mountedUnitIds: () => Object.freeze(unitsRef.current.map((unit) => unit.id)),
      diagnostics,
      measureMounted() {},
    };
    if (runtimeRef) runtimeRef.current = handle;
    scrollerRefRef.current?.(root);
    return () => {
      scrollerRefRef.current?.(null);
      if (runtimeRef?.current === handle) runtimeRef.current = null;
    };
  }, [runtimeRef]);

  useLayoutEffect(() => {
    renderRevisionRef.current += 1;
    publishLayout(true);
  }, [units]);

  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;
    // ResizeObserver can report several intermediate sizes while streamed
    // Markdown is settling. Coalesce them into one scroll correction per frame
    // so layout feedback cannot repeatedly rewrite scrollTop in the same frame.
    const observer = new ResizeObserver(() => {
      if (resizeFrameRef.current !== null) return;
      resizeFrameRef.current = window.requestAnimationFrame(() => {
        resizeFrameRef.current = null;
        publishLayout();
      });
    });
    observer.observe(content);
    return () => {
      observer.disconnect();
      if (resizeFrameRef.current !== null) window.cancelAnimationFrame(resizeFrameRef.current);
      resizeFrameRef.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const handleGeometryCommit = (event: Event) => {
      const detail = conversationGeometryCommitDetail(event);
      if (!detail || !followBottomRef.current || Math.abs(detail.delta) <= 0.5) return;
      // When content shrinks Chromium clamps scrollTop to the new maximum
      // before this event is handled. Applying the negative height delta to
      // that already-clamped value moves the viewport one delta above the
      // bottom for a frame, until the ResizeObserver fallback repairs it.
      // The follow contract is the bottom itself, not a relative delta.
      requestScroll(nativeBottom(root), "follow-bottom-geometry");
    };
    root.addEventListener(CONVERSATION_GEOMETRY_COMMIT_EVENT, handleGeometryCommit);
    return () => root.removeEventListener(CONVERSATION_GEOMETRY_COMMIT_EVENT, handleGeometryCommit);
  }, []);

  return (
    <div
      ref={rootRef}
      className={className}
      data-conversation-native-timeline="true"
      data-conversation-timeline-layout-mode="native"
      data-message-list-scroll="true"
      data-message-list-variant={variant}
      data-testid="message-list-scroll"
      onPointerDown={onPointerDown}
      onWheel={onWheel}
      onScroll={onScroll}
    >
      <div ref={contentRef} className={contentClassName} data-conversation-native-timeline-content="true" role="list">
        {before}
        {units.map((unit, index) => {
          const firstInTurn = unit.turnIndex !== null && units[index - 1]?.turnIndex !== unit.turnIndex;
          return (
            <ConversationNativeTimelineUnit
              key={unit.id}
              unit={unit}
              index={index}
              firstInTurn={firstInTurn}
              tailAdjacent={index === units.length - 1}
              elementsById={elementsByIdRef.current}
              renderUnit={renderUnit}
            />
          );
        })}
      </div>
    </div>
  );
}

const ConversationNativeTimelineUnit = memo(function ConversationNativeTimelineUnit({
  unit,
  index,
  firstInTurn,
  tailAdjacent,
  elementsById,
  renderUnit,
}: {
  readonly unit: ConversationRenderUnit;
  readonly index: number;
  readonly firstInTurn: boolean;
  readonly tailAdjacent: boolean;
  readonly elementsById: Map<string, HTMLElement>;
  readonly renderUnit: (unit: ConversationRenderUnit) => ReactNode;
}) {
  return (
    <div
      ref={(element) => {
        if (element) elementsById.set(unit.id, element);
        else elementsById.delete(unit.id);
      }}
      data-conversation-unit-id={unit.id}
      data-conversation-unit-index={index}
      data-conversation-unit-kind={unit.kind}
      data-conversation-unit-pinned="false"
      data-conversation-unit-tail-adjacent={tailAdjacent ? "true" : "false"}
      data-testid={firstInTurn ? "message-turn" : undefined}
      data-turn-index={unit.turnIndex ?? undefined}
    >
      {renderUnit(unit)}
    </div>
  );
});

function captureNativeAnchor(
  root: HTMLElement,
  units: readonly ConversationRenderUnit[],
  elementsById: ReadonlyMap<string, HTMLElement>,
  viewportOffset: number,
  revision: number,
): ConversationTimelineAnchor | null {
  const rootRect = root.getBoundingClientRect();
  const boundedViewportOffset = clamp(viewportOffset, 0, Math.max(0, root.clientHeight));
  const targetY = rootRect.top + boundedViewportOffset;
  let fallback: { unit: ConversationRenderUnit; element: HTMLElement } | null = null;
  for (const unit of units) {
    const element = elementsById.get(unit.id);
    if (!element) continue;
    fallback = { unit, element };
    const rect = element.getBoundingClientRect();
    if (rect.bottom <= targetY) continue;
    return Object.freeze({
      unitId: unit.id,
      offsetWithinUnit: Math.max(0, targetY - rect.top),
      viewportOffset: boundedViewportOffset,
      capturedRevision: `conversation-native:${revision}`,
    });
  }
  if (!fallback) return null;
  const rect = fallback.element.getBoundingClientRect();
  return Object.freeze({
    unitId: fallback.unit.id,
    offsetWithinUnit: Math.max(0, rect.height),
    viewportOffset: boundedViewportOffset,
    capturedRevision: `conversation-native:${revision}`,
  });
}

function nativeRevealTop(
  root: HTMLElement,
  element: HTMLElement,
  align: "start" | "center" | "end",
): number {
  const top = nativeElementTop(root, element);
  const height = element.getBoundingClientRect().height;
  const target = align === "start"
    ? top
    : align === "end"
      ? top + height - root.clientHeight
      : top + height / 2 - root.clientHeight / 2;
  return clamp(target, 0, nativeBottom(root));
}

function nativeElementTop(root: HTMLElement, element: HTMLElement): number {
  return root.scrollTop + element.getBoundingClientRect().top - root.getBoundingClientRect().top;
}

function nativeBottom(root: HTMLElement): number {
  return Math.max(0, root.scrollHeight - root.clientHeight);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}
