import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import { DEFAULT_TERMINAL_DOCK_HEIGHT, MIN_TERMINAL_DOCK_HEIGHT, clampTerminalDockHeight } from "./terminalStore";
import styles from "./TerminalDock.module.css";

export function TerminalResizeHandle({ height, disabled, getMaxHeight, onResize }: {
  height: number;
  disabled: boolean;
  getMaxHeight: () => number;
  onResize: (height: number) => void;
}) {
  const dragRef = useRef<{ pointerId: number; startY: number; startHeight: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const stopDragging = useCallback(() => { dragRef.current = null; setDragging(false); }, []);
  useEffect(() => {
    if (!dragging) return;
    const move = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      onResize(resolveTerminalDockHeight(drag.startHeight + drag.startY - event.clientY, getMaxHeight()));
    };
    const stop = (event: PointerEvent) => {
      if (dragRef.current?.pointerId === event.pointerId) stopDragging();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [dragging, getMaxHeight, onResize, stopDragging]);
  const start = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    dragRef.current = { pointerId: event.pointerId, startY: event.clientY, startHeight: height };
    setDragging(true);
  };
  return (
    <div
      className={styles.resizeHandle}
      data-dragging={dragging ? "true" : "false"}
      role="separator"
      aria-label="调整终端面板高度"
      aria-orientation="horizontal"
      aria-valuemin={MIN_TERMINAL_DOCK_HEIGHT}
      aria-valuemax={Math.round(getMaxHeight())}
      aria-valuenow={height}
      tabIndex={disabled ? -1 : 0}
      onDoubleClick={() => onResize(resolveTerminalDockHeight(DEFAULT_TERMINAL_DOCK_HEIGHT, getMaxHeight()))}
      onKeyDown={(event) => {
        if (disabled) return;
        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          event.preventDefault();
          onResize(resolveTerminalDockHeight(height + (event.key === "ArrowUp" ? 16 : -16), getMaxHeight()));
        } else if (event.key === "Home") {
          event.preventDefault();
          onResize(MIN_TERMINAL_DOCK_HEIGHT);
        }
      }}
      onPointerDown={start}
    />
  );
}

export function resolveTerminalDockHeight(height: number, maxHeight: number): number {
  return clampTerminalDockHeight(height, Math.max(MIN_TERMINAL_DOCK_HEIGHT, Math.round(maxHeight)));
}
