import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronUp, MessageSquareText, X } from "lucide-react";

import type { ResolvedTextAnnotation } from "../domain/resolutions";
import { layoutAnnotationLane, type AnnotationLanePlacement } from "../layout/AnnotationLaneLayout";
import { AnnotationCard } from "./AnnotationCard";
import { AnnotationDraftCard } from "./AnnotationDraftCard";
import styles from "./AnnotationRail.module.css";

export interface AnnotationRailItem {
  readonly anchorY: number;
  readonly resolution: ResolvedTextAnnotation;
}

export interface AnnotationRailDraft {
  readonly anchorY: number;
  readonly body: string;
  readonly error?: string | null;
  readonly onBodyChange: (body: string) => void;
  readonly onCancel: () => void;
  readonly onSubmit: () => void;
  readonly pending: boolean;
  readonly revision: string;
}

export interface AnnotationRailAuxiliaryItem {
  readonly anchorY: number;
  readonly content: ReactNode;
  readonly estimatedHeight: number;
  readonly id: string;
}

const DRAFT_PLACEMENT_ID = "__annotation_draft__";

export function AnnotationRail({
  activeAnnotationId,
  bottomPadding = 16,
  documentHeight,
  draft,
  floatingItems = [],
  footer,
  hoveredAnnotationId,
  items,
  onClose,
  onDelete,
  onNavigate,
  onLayout,
  onHoverChange,
  onSave,
  onNavigateNext,
  onNavigatePrevious,
  onStartChat,
  reservedTop = 64,
  top,
  totalCount = items.length,
}: {
  activeAnnotationId: string | null;
  bottomPadding?: number;
  documentHeight: number;
  draft?: AnnotationRailDraft | null;
  floatingItems?: readonly AnnotationRailAuxiliaryItem[];
  footer?: ReactNode;
  hoveredAnnotationId: string | null;
  items: readonly AnnotationRailItem[];
  onClose(): void;
  onDelete(annotationId: string): Promise<boolean>;
  onNavigate(item: ResolvedTextAnnotation): void;
  onLayout?(placements: readonly AnnotationLanePlacement[]): void;
  onHoverChange(annotationId: string | null): void;
  onSave(annotationId: string, body: string): Promise<boolean>;
  onNavigateNext?(): void;
  onNavigatePrevious?(): void;
  onStartChat?(item: ResolvedTextAnnotation): void;
  reservedTop?: number;
  top?: ReactNode;
  totalCount?: number;
}) {
  const [heights, setHeights] = useState<Readonly<Record<string, number>>>({});
  const pendingMeasurements = useRef(new Map<string, number>());
  const measurementScheduled = useRef(false);
  const reportHeight = useCallback((id: string, height: number) => {
    pendingMeasurements.current.set(id, height);
    if (measurementScheduled.current) {
      return;
    }
    measurementScheduled.current = true;
    queueMicrotask(() => {
      measurementScheduled.current = false;
      const batch = pendingMeasurements.current;
      pendingMeasurements.current = new Map();
      setHeights((current) => {
        let changed = false;
        const next = { ...current };
        for (const [annotationId, measuredHeight] of batch) {
          if (next[annotationId] !== measuredHeight) {
            next[annotationId] = measuredHeight;
            changed = true;
          }
        }
        return changed ? next : current;
      });
    });
  }, []);
  const laneLayout = useMemo(() => layoutAnnotationLane({
    bottomPadding,
    documentHeight,
    reservedTop,
    items: [
      ...items.map(({ anchorY, resolution }) => ({
      anchorY,
      createdAt: resolution.record.created_at,
      height: heights[resolution.record.id] ?? 112,
      id: resolution.record.id,
      })),
      ...(draft ? [{
        anchorY: draft.anchorY,
        createdAt: "",
        height: heights[DRAFT_PLACEMENT_ID] ?? 148,
        id: DRAFT_PLACEMENT_ID,
      }] : []),
      ...floatingItems.map((item) => ({
        anchorY: item.anchorY,
        createdAt: "",
        height: heights[item.id] ?? item.estimatedHeight,
        id: item.id,
      })),
    ],
  }), [bottomPadding, documentHeight, draft, floatingItems, heights, items, reservedTop]);
  const placements = laneLayout.placements;
  const resolutionById = useMemo(
    () => new Map(items.map((item) => [item.resolution.record.id, item.resolution])),
    [items],
  );
  const orderedNavigationItems = useMemo(
    () => [...items].sort((left, right) => (
      left.resolution.projection.logicalRange.start - right.resolution.projection.logicalRange.start
      || left.resolution.record.id.localeCompare(right.resolution.record.id)
    )),
    [items],
  );
  const activeNavigationIndex = orderedNavigationItems.findIndex(
    (item) => item.resolution.record.id === activeAnnotationId,
  );
  const navigateAdjacent = useCallback((direction: -1 | 1) => {
    if (orderedNavigationItems.length === 0) {
      return;
    }
    const origin = activeNavigationIndex >= 0
      ? activeNavigationIndex
      : direction > 0 ? -1 : 0;
    const targetIndex = (origin + direction + orderedNavigationItems.length) % orderedNavigationItems.length;
    const target = orderedNavigationItems[targetIndex];
    if (target) {
      onNavigate(target.resolution);
    }
  }, [activeNavigationIndex, onNavigate, orderedNavigationItems]);
  const handleNavigatePrevious = useCallback(() => {
    if (onNavigatePrevious) {
      onNavigatePrevious();
      return;
    }
    navigateAdjacent(-1);
  }, [navigateAdjacent, onNavigatePrevious]);
  const handleNavigateNext = useCallback(() => {
    if (onNavigateNext) {
      onNavigateNext();
      return;
    }
    navigateAdjacent(1);
  }, [navigateAdjacent, onNavigateNext]);

  useLayoutEffect(() => {
    onLayout?.(placements);
  }, [onLayout, placements]);

  return (
    <section
      aria-label="文档批注"
      className={styles.rail}
      data-annotation-rail-content="true"
      style={{ height: laneLayout.documentHeight }}
    >
      <header className={styles.header}>
        <div className={styles.headerTitle}>
          <MessageSquareText aria-hidden="true" className={styles.headerIcon} size={16} />
          <strong>批注</strong>
          <span className={styles.headerCount} data-annotation-total-count="true">{totalCount}</span>
        </div>
        <div className={styles.headerActions}>
          <div aria-label="选区批注导航" className={styles.headerNavigation} role="group">
            <button aria-label="上一条选区批注" disabled={orderedNavigationItems.length === 0} onClick={handleNavigatePrevious} type="button">
              <ChevronUp size={14} />
            </button>
            <span className={styles.headerPosition} data-annotation-navigation-position="true">
              {activeNavigationIndex >= 0 ? activeNavigationIndex + 1 : "–"} / {orderedNavigationItems.length}
            </span>
            <button aria-label="下一条选区批注" disabled={orderedNavigationItems.length === 0} onClick={handleNavigateNext} type="button">
              <ChevronDown size={14} />
            </button>
          </div>
          <button aria-label="收起批注栏" onClick={onClose} type="button"><X size={15} /></button>
        </div>
      </header>
      {top ? <div className={styles.topSection}>{top}</div> : null}
      <div className={styles.lane}>
        {placements.map((placement) => {
          if (placement.id === DRAFT_PLACEMENT_ID && draft) {
            return (
              <MeasuredCard key={placement.id} id={placement.id} onHeight={reportHeight} top={placement.cardY}>
                <AnnotationDraftCard {...draft} />
              </MeasuredCard>
            );
          }
          const floating = floatingItems.find((item) => item.id === placement.id);
          if (floating) {
            return <MeasuredCard key={placement.id} id={placement.id} onHeight={reportHeight} top={placement.cardY}>{floating.content}</MeasuredCard>;
          }
          const resolution = resolutionById.get(placement.id);
          return resolution ? (
            <MeasuredCard key={placement.id} id={placement.id} onHeight={reportHeight} top={placement.cardY}>
              <AnnotationCard
                active={placement.id === activeAnnotationId}
                hovered={placement.id === hoveredAnnotationId}
                item={resolution}
                onDelete={onDelete}
                onNavigate={onNavigate}
                onHoverChange={onHoverChange}
                onSave={onSave}
                onStartChat={onStartChat}
              />
            </MeasuredCard>
          ) : null;
        })}
      </div>
      {footer ? <footer className={styles.footer}>{footer}</footer> : null}
    </section>
  );
}

function MeasuredCard({
  children,
  id,
  onHeight,
  top,
}: {
  children: ReactNode;
  id: string;
  onHeight(id: string, height: number): void;
  top: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(([entry]) => {
      const height = Math.round(entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height);
      if (height > 0) {
        onHeight(id, height);
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [id, onHeight]);
  return <div className={styles.placement} data-annotation-placement-id={id} ref={ref} style={{ top }}>{children}</div>;
}
