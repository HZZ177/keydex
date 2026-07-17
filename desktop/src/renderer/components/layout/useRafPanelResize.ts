import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

interface ResizeDragState {
  pointerId: number;
  target: HTMLDivElement;
  startWidth: number;
  startCoordinate: number;
  lastWidth: number;
  pendingWidth: number;
  frameId: number | null;
}

interface UseRafPanelResizeOptions {
  disabled: boolean;
  width: number;
  getWidth(startWidth: number, startCoordinate: number, clientCoordinate: number): number;
  onPreview?: (width: number) => void;
  onCommit: (width: number) => void;
  previewMode?: "raf" | "sync";
  axis?: "x" | "y";
}

export function useRafPanelResize({
  disabled,
  width,
  getWidth,
  onPreview,
  onCommit,
  previewMode = "raf",
  axis = "x",
}: UseRafPanelResizeOptions) {
  const dragRef = useRef<ResizeDragState | null>(null);
  const optionsRef = useRef({ getWidth, onPreview, onCommit, previewMode });
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    optionsRef.current = { getWidth, onPreview, onCommit, previewMode };
  }, [getWidth, onPreview, onCommit, previewMode]);

  const flushPreview = useCallback((drag: ResizeDragState) => {
    if (drag.frameId !== null) {
      cancelAnimationFrame(drag.frameId);
      drag.frameId = null;
    }
    if (drag.pendingWidth !== drag.lastWidth) {
      drag.lastWidth = drag.pendingWidth;
      optionsRef.current.onPreview?.(drag.lastWidth);
    }
    return drag.lastWidth;
  }, []);

  const finishDrag = useCallback(
    (pointerId?: number) => {
      const drag = dragRef.current;
      if (!drag || (pointerId !== undefined && pointerId !== drag.pointerId)) {
        return;
      }

      const finalWidth = flushPreview(drag);
      try {
        drag.target.releasePointerCapture?.(drag.pointerId);
      } catch {
        // Some test and WebView runtimes do not expose active pointer capture.
      }
      dragRef.current = null;
      setDragging(false);
      optionsRef.current.onCommit(finalWidth);
    },
    [flushPreview],
  );

  const schedulePreview = useCallback((nextWidth: number) => {
    const drag = dragRef.current;
    if (!drag || nextWidth === drag.pendingWidth) {
      return;
    }
    drag.pendingWidth = nextWidth;
    if (optionsRef.current.previewMode === "sync") {
      if (drag.frameId !== null) {
        cancelAnimationFrame(drag.frameId);
        drag.frameId = null;
      }
      drag.lastWidth = nextWidth;
      optionsRef.current.onPreview?.(nextWidth);
      return;
    }
    if (drag.frameId !== null) {
      return;
    }

    drag.frameId = requestAnimationFrame(() => {
      const activeDrag = dragRef.current;
      if (activeDrag !== drag) {
        return;
      }
      drag.frameId = null;
      if (drag.pendingWidth === drag.lastWidth) {
        return;
      }
      drag.lastWidth = drag.pendingWidth;
      optionsRef.current.onPreview?.(drag.lastWidth);
    });
  }, []);

  useEffect(() => {
    if (!dragging) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || pointerIdValue(event) !== drag.pointerId) {
        return;
      }
      event.preventDefault();
      const coordinate = axis === "y" ? event.clientY : event.clientX;
      schedulePreview(optionsRef.current.getWidth(drag.startWidth, drag.startCoordinate, coordinate));
    };
    const handlePointerEnd = (event: PointerEvent) => {
      finishDrag(pointerIdValue(event));
    };

    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.cursor = axis === "y" ? "row-resize" : "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", handlePointerMove, { passive: false });
    window.addEventListener("pointerup", handlePointerEnd);
    window.addEventListener("pointercancel", handlePointerEnd);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerEnd);
      window.removeEventListener("pointercancel", handlePointerEnd);
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
    };
  }, [axis, dragging, finishDrag, schedulePreview]);

  useEffect(() => {
    if (disabled) {
      finishDrag();
    }
  }, [disabled, finishDrag]);

  useEffect(() => {
    return () => {
      const drag = dragRef.current;
      if (drag?.frameId !== null && drag?.frameId !== undefined) {
        cancelAnimationFrame(drag.frameId);
      }
      dragRef.current = null;
    };
  }, []);

  const startDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (disabled || event.button !== 0) {
        return;
      }
      event.preventDefault();
      const pointerId = pointerIdValue(event);
      try {
        event.currentTarget.setPointerCapture?.(pointerId);
      } catch {
        // Window-level pointer listeners below keep resizing available without capture.
      }
      dragRef.current = {
        pointerId,
        target: event.currentTarget,
        startWidth: width,
        startCoordinate: axis === "y" ? event.clientY : event.clientX,
        lastWidth: width,
        pendingWidth: width,
        frameId: null,
      };
      setDragging(true);
    },
    [axis, disabled, width],
  );

  return { dragging, startDrag, finishDrag };
}

function pointerIdValue(event: Pick<PointerEvent | ReactPointerEvent<HTMLDivElement>, "pointerId">): number {
  return Number.isFinite(event.pointerId) ? event.pointerId : 1;
}
