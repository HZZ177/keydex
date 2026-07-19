import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from "react";

import type {
  DiffChangeBlock,
  DiffConnectorGeometry,
  DiffPaneSide,
  KeydexAlignedDiffModel,
} from "./alignedDiffModel";
import type { DiffScrollMappingMetrics } from "./hunkScrollMapping";
import styles from "./DiffHunkActionLayer.module.css";

export type DiffChangeNavigationDirection = "previous" | "next";

export interface DiffHunkActionLayerProps {
  readonly changes: readonly DiffChangeBlock[];
  readonly geometry: readonly DiffConnectorGeometry[];
  readonly activeChangeId?: string | null;
  readonly onActiveChange: (changeId: string) => void;
  readonly onNavigate: (changeId: string) => void;
  readonly loop?: boolean;
}

export function DiffHunkActionLayer({
  changes,
  geometry,
  activeChangeId = null,
  onActiveChange,
  onNavigate,
  loop = false,
}: DiffHunkActionLayerProps) {
  const changeById = new Map(changes.map((change) => [change.id, change]));
  const navigate = (direction: DiffChangeNavigationDirection) => {
    const target = resolveAdjacentDiffChangeId(
      changes.map(({ id }) => id),
      activeChangeId,
      direction,
      loop,
    );
    if (!target || target === activeChangeId) return;
    onActiveChange(target);
    onNavigate(target);
  };
  return (
    <div
      className={styles.layer}
      role="group"
      aria-label="差异导航"
      onKeyDown={(event) => handleAlignedDiffNavigationKeyDown(event, navigate)}
    >
      {geometry.map((item, index) => {
        const change = changeById.get(item.changeId);
        if (!change) return null;
        const style = {
          "--diff-change-y": `${connectorGeometryMidpoint(item)}px`,
        } as CSSProperties;
        return (
          <button
            key={item.changeId}
            type="button"
            className={styles.target}
            style={style}
            data-change-id={item.changeId}
            data-active={activeChangeId === item.changeId ? "true" : "false"}
            aria-pressed={activeChangeId === item.changeId}
            aria-current={activeChangeId === item.changeId ? "true" : undefined}
            aria-label={`差异 ${changes.indexOf(change) + 1}/${changes.length}，${changeKindLabel(change.kind)}`}
            onMouseDown={(event) => event.preventDefault()}
            onFocus={() => onActiveChange(item.changeId)}
            onClick={() => {
              onActiveChange(item.changeId);
              onNavigate(item.changeId);
            }}
          >
            <span aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}

export function resolveAdjacentDiffChangeId(
  changeIds: readonly string[],
  activeChangeId: string | null,
  direction: DiffChangeNavigationDirection,
  loop = false,
): string | null {
  if (changeIds.length === 0) return null;
  const currentIndex = activeChangeId ? changeIds.indexOf(activeChangeId) : -1;
  if (currentIndex < 0) return direction === "next" ? changeIds[0]! : changeIds[changeIds.length - 1]!;
  const delta = direction === "next" ? 1 : -1;
  const nextIndex = currentIndex + delta;
  if (nextIndex >= 0 && nextIndex < changeIds.length) return changeIds[nextIndex]!;
  if (loop) return direction === "next" ? changeIds[0]! : changeIds[changeIds.length - 1]!;
  return changeIds[currentIndex]!;
}

export function handleAlignedDiffNavigationKeyDown(
  event: ReactKeyboardEvent<HTMLElement>,
  navigate: (direction: DiffChangeNavigationDirection) => void,
): boolean {
  if (
    event.defaultPrevented
    || !event.altKey
    || event.ctrlKey
    || event.metaKey
    || isEditableTarget(event.target)
  ) return false;
  const direction = event.key === "ArrowUp"
    ? "previous"
    : event.key === "ArrowDown"
      ? "next"
      : null;
  if (!direction) return false;
  event.preventDefault();
  event.stopPropagation();
  navigate(direction);
  return true;
}

export function resolveDiffChangeScrollTarget(
  model: KeydexAlignedDiffModel,
  metrics: DiffScrollMappingMetrics,
  changeId: string,
  side: DiffPaneSide,
  viewportHeight: number,
  viewportFraction = 0.28,
): number | null {
  const change = model.changes.find((candidate) => candidate.id === changeId);
  if (!change) return null;
  const mapping = metrics.segments.find(({ segment }) => segment.id === change.segmentId);
  if (!mapping) return null;
  const range = side === "old" ? mapping.left : mapping.right;
  const totalHeight = side === "old" ? metrics.leftTotalHeight : metrics.rightTotalHeight;
  const safeViewport = Number.isFinite(viewportHeight) ? Math.max(0, viewportHeight) : 0;
  const fraction = Number.isFinite(viewportFraction)
    ? Math.min(1, Math.max(0, viewportFraction))
    : 0.28;
  return Math.min(
    Math.max(0, totalHeight - safeViewport),
    Math.max(0, range.start - safeViewport * fraction),
  );
}

export function connectorGeometryMidpoint(geometry: DiffConnectorGeometry): number {
  return (geometry.leftStart + geometry.leftEnd + geometry.rightStart + geometry.rightEnd) / 4;
}

function changeKindLabel(kind: DiffChangeBlock["kind"]): string {
  if (kind === "added") return "新增内容";
  if (kind === "removed") return "删除内容";
  return "修改内容";
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof Element
    && Boolean(target.closest("input, textarea, select, [contenteditable='true'], [role='textbox']"));
}
