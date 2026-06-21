import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import {
  DEFAULT_SIDEBAR_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_SIDEBAR_WIDTH,
  clampSidebarWidth,
} from "@/renderer/hooks/layout/layoutStore";

import styles from "./SidebarResizeHandle.module.css";

interface SidebarResizeHandleProps {
  disabled?: boolean;
  width: number;
  onResize: (width: number) => void;
}

const KEYBOARD_STEP = 12;

export function SidebarResizeHandle({ disabled = false, width, onResize }: SidebarResizeHandleProps) {
  const dragRef = useRef<{ pointerId: number; startWidth: number; startX: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!dragging) {
      return;
    }
    const handlePointerMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) {
        return;
      }
      onResize(clampSidebarWidth(drag.startWidth + event.clientX - drag.startX));
    };
    const handlePointerEnd = () => {
      dragRef.current = null;
      setDragging(false);
    };
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerEnd);
    window.addEventListener("pointercancel", handlePointerEnd);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerEnd);
      window.removeEventListener("pointercancel", handlePointerEnd);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };
  }, [dragging, onResize]);

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled) {
      return;
    }
    event.preventDefault();
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // Window-level pointer listeners below keep resizing available without capture.
    }
    dragRef.current = {
      pointerId: event.pointerId,
      startWidth: width,
      startX: event.clientX,
    };
    setDragging(true);
  };

  const updateDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) {
      return;
    }
    event.preventDefault();
    onResize(clampSidebarWidth(drag.startWidth + event.clientX - drag.startX));
  };

  const stopDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) {
      return;
    }
    try {
      event.currentTarget.releasePointerCapture?.(drag.pointerId);
    } catch {
      // Some test and WebView runtimes do not expose active pointer capture.
    }
    dragRef.current = null;
    setDragging(false);
  };

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
    dragRef.current = null;
    setDragging(false);
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
      onPointerCancel={stopDrag}
      onPointerDown={startDrag}
      onPointerMove={updateDrag}
      onPointerUp={stopDrag}
      role="separator"
      tabIndex={disabled ? -1 : 0}
      title="拖动调整宽度，双击恢复默认宽度"
    />
  );
}
