import {
  useCallback,
  useEffect,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import {
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  clampSidebarWidth,
} from "@/renderer/hooks/layout/layoutStore";

import styles from "./SidebarResizeHandle.module.css";
import { useRafPanelResize } from "./useRafPanelResize";

interface SidebarResizeHandleProps {
  disabled?: boolean;
  width: number;
  onResizePreview?: (width: number) => void;
  onResize: (width: number) => void;
  onResizeDragChange?: (dragging: boolean) => void;
}

const KEYBOARD_STEP = 12;

export function SidebarResizeHandle({
  disabled = false,
  width,
  onResizePreview,
  onResize,
  onResizeDragChange,
}: SidebarResizeHandleProps) {
  const getDragWidth = useCallback(
    (startWidth: number, startX: number, clientX: number) => clampSidebarWidth(startWidth + clientX - startX),
    [],
  );
  const { dragging, startDrag, finishDrag } = useRafPanelResize({
    disabled,
    width,
    getWidth: getDragWidth,
    onPreview: onResizePreview,
    onCommit: onResize,
  });

  useEffect(() => {
    onResizeDragChange?.(dragging);
    return () => {
      if (dragging) {
        onResizeDragChange?.(false);
      }
    };
  }, [dragging, onResizeDragChange]);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (disabled) {
      return;
    }
    let nextWidth: number | null = null;
    if (event.key === "ArrowLeft") {
      nextWidth = width - KEYBOARD_STEP;
    } else if (event.key === "ArrowRight") {
      nextWidth = width + KEYBOARD_STEP;
    } else if (event.key === "Home") {
      nextWidth = MIN_SIDEBAR_WIDTH;
    } else if (event.key === "End") {
      nextWidth = MAX_SIDEBAR_WIDTH;
    }
    if (nextWidth === null) {
      return;
    }
    event.preventDefault();
    onResize(clampSidebarWidth(nextWidth));
  };

  const resetWidth = () => {
    if (disabled) {
      return;
    }
    finishDrag();
    onResizePreview?.(DEFAULT_SIDEBAR_WIDTH);
    onResize(DEFAULT_SIDEBAR_WIDTH);
  };

  return (
    <div
      aria-label="调整侧边栏宽度"
      aria-orientation="vertical"
      aria-valuemax={MAX_SIDEBAR_WIDTH}
      aria-valuemin={MIN_SIDEBAR_WIDTH}
      aria-valuenow={width}
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
  );
}
