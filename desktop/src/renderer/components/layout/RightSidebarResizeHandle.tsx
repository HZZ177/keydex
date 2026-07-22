import {
  useCallback,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import {
  DEFAULT_RIGHT_SIDEBAR_RATIO,
  MAX_RIGHT_SIDEBAR_RATIO,
  MIN_RIGHT_SIDEBAR_RATIO,
} from "@/renderer/hooks/layout/layoutStore";
import type { RightSidebarPlacement } from "@/renderer/hooks/layout/layoutStore";

import styles from "./RightSidebarResizeHandle.module.css";
import { useRafPanelResize } from "./useRafPanelResize";

interface RightSidebarResizeHandleProps {
  disabled?: boolean;
  ratio: number;
  maxRatio?: number;
  getMaxRatio?: () => number;
  placement: RightSidebarPlacement;
  getAvailableWidth: () => number;
  onResizePreview?: (ratio: number) => void;
  onResize: (ratio: number) => void;
  onResizeDragChange?: (dragging: boolean, input?: RightSidebarResizeDragInput) => void;
  onSwapPlacement: () => void;
}

export interface RightSidebarResizeDragInput {
  readonly placement: RightSidebarPlacement;
  readonly startScreenX: number;
  readonly minDelta: number;
  readonly maxDelta: number;
}

const KEYBOARD_STEP = 0.01;

function HalfSwapIcon() {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      focusable="false"
      height="14"
      viewBox="0 0 24 24"
      width="14"
    >
      <path
        d="M18.5 7.5H6.5l5-3"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2.1"
      />
      <path
        d="M5.5 16.5h12l-5 3"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2.1"
      />
    </svg>
  );
}

export function RightSidebarResizeHandle({
  disabled = false,
  ratio,
  maxRatio = MAX_RIGHT_SIDEBAR_RATIO,
  getMaxRatio,
  placement,
  getAvailableWidth,
  onResizePreview,
  onResize,
  onResizeDragChange,
  onSwapPlacement,
}: RightSidebarResizeHandleProps) {
  const getBoundedMaxRatio = useCallback(
    () => Math.max(MIN_RIGHT_SIDEBAR_RATIO, Math.min(MAX_RIGHT_SIDEBAR_RATIO, getMaxRatio?.() ?? maxRatio)),
    [getMaxRatio, maxRatio],
  );
  const boundedMaxRatio = getBoundedMaxRatio();
  const clampRatio = useCallback(
    (nextRatio: number) => {
      const liveMaxRatio = getBoundedMaxRatio();
      if (!Number.isFinite(nextRatio)) {
        return Math.min(DEFAULT_RIGHT_SIDEBAR_RATIO, liveMaxRatio);
      }
      return Math.min(
        liveMaxRatio,
        Math.max(MIN_RIGHT_SIDEBAR_RATIO, Math.round(nextRatio * 1000) / 1000),
      );
    },
    [getBoundedMaxRatio],
  );
  const getDragRatio = useCallback(
    (startRatio: number, startX: number, clientX: number) => {
      const direction = placement === "right" ? -1 : 1;
      return clampRatio(startRatio + direction * ((clientX - startX) / Math.max(1, getAvailableWidth())));
    },
    [clampRatio, getAvailableWidth, placement],
  );
  const { dragging, startDrag, finishDrag } = useRafPanelResize({
    disabled,
    width: ratio,
    getWidth: getDragRatio,
    onPreview: onResizePreview,
    onCommit: onResize,
    onDragStart: ({ startWidth, startScreenCoordinate }) => {
      const availableWidth = Math.max(1, getAvailableWidth());
      const direction = placement === "right" ? -1 : 1;
      const deltaAtMin = ((MIN_RIGHT_SIDEBAR_RATIO - startWidth) * availableWidth) / direction;
      const deltaAtMax = ((getBoundedMaxRatio() - startWidth) * availableWidth) / direction;
      onResizeDragChange?.(true, {
        placement,
        startScreenX: startScreenCoordinate,
        minDelta: Math.min(deltaAtMin, deltaAtMax),
        maxDelta: Math.max(deltaAtMin, deltaAtMax),
      });
    },
    onDragEnd: () => onResizeDragChange?.(false),
    previewMode: "sync",
  });

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (disabled) {
      return;
    }
    let nextRatio: number | null = null;
    if (event.key === "ArrowLeft") {
      nextRatio = placement === "right" ? ratio + KEYBOARD_STEP : ratio - KEYBOARD_STEP;
    } else if (event.key === "ArrowRight") {
      nextRatio = placement === "right" ? ratio - KEYBOARD_STEP : ratio + KEYBOARD_STEP;
    } else if (event.key === "Home") {
      nextRatio = MIN_RIGHT_SIDEBAR_RATIO;
    } else if (event.key === "End") {
      nextRatio = boundedMaxRatio;
    }
    if (nextRatio === null) {
      return;
    }
    event.preventDefault();
    onResize(clampRatio(nextRatio));
  };

  const resetWidth = () => {
    if (disabled) {
      return;
    }
    finishDrag();
    const resetRatio = clampRatio(DEFAULT_RIGHT_SIDEBAR_RATIO);
    onResizePreview?.(resetRatio);
    onResize(resetRatio);
  };

  const placementLabel = placement === "left" ? "左侧栏" : "右侧栏";

  return (
    <div className={styles.root} data-disabled={disabled ? "true" : "false"} data-placement={placement}>
      <div
        aria-label={`调整${placementLabel}宽度`}
        aria-orientation="vertical"
        aria-valuemax={Math.round(boundedMaxRatio * 100)}
        aria-valuemin={Math.round(MIN_RIGHT_SIDEBAR_RATIO * 100)}
        aria-valuenow={Math.round(ratio * 100)}
        className={styles.handle}
        data-disabled={disabled ? "true" : "false"}
        data-dragging={dragging ? "true" : "false"}
        onDoubleClick={resetWidth}
        onKeyDown={handleKeyDown}
        onPointerDown={startDrag}
        role="separator"
        tabIndex={disabled ? -1 : 0}
        title="拖动调整宽度，双击恢复默认宽度"
      />
      {!disabled ? (
        <button
          aria-label="交换对话区和侧边栏位置"
          className={styles.swapButton}
          onClick={onSwapPlacement}
          onPointerDown={(event) => event.stopPropagation()}
          title="交换对话区和侧边栏位置"
          type="button"
        >
          <HalfSwapIcon />
        </button>
      ) : null}
    </div>
  );
}
