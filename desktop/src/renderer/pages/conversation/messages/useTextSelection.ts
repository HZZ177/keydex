import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

export interface SelectionPosition {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function useTextSelection(containerRef: RefObject<HTMLElement | null>, enabled = true) {
  const [selectedText, setSelectedText] = useState("");
  const [selectionPosition, setSelectionPosition] = useState<SelectionPosition | null>(null);
  const deferredUpdateRef = useRef<number | null>(null);

  const clearSelection = useCallback(() => {
    setSelectedText("");
    setSelectionPosition(null);
    window.getSelection()?.removeAllRanges();
  }, []);

  const updateSelection = useCallback(() => {
    const selection = window.getSelection();
    const text = selection?.toString().trim() ?? "";
    const container = containerRef.current;

    if (!container || !selection || selection.rangeCount === 0 || !text) {
      setSelectedText("");
      setSelectionPosition(null);
      return;
    }

    const range = selection.getRangeAt(0);
    if (!container.contains(range.commonAncestorContainer)) {
      setSelectedText("");
      setSelectionPosition(null);
      return;
    }

    const rect = selectionRect(range);
    const x = rect.width > 0 ? rect.left + rect.width / 2 : rect.left;
    const y = rect.top;
    setSelectedText(text);
    setSelectionPosition({
      x,
      y,
      width: rect.width,
      height: rect.height,
    });
  }, [containerRef]);

  useEffect(() => {
    if (!enabled) {
      setSelectedText("");
      setSelectionPosition(null);
      return;
    }

    const hideSelectionToolbar = () => {
      setSelectedText("");
      setSelectionPosition(null);
    };

    const deferredUpdate = () => {
      if (deferredUpdateRef.current !== null) {
        window.clearTimeout(deferredUpdateRef.current);
      }
      deferredUpdateRef.current = window.setTimeout(() => {
        deferredUpdateRef.current = null;
        updateSelection();
      }, 0);
    };
    document.addEventListener("mousedown", hideSelectionToolbar);
    document.addEventListener("mouseup", deferredUpdate);
    document.addEventListener("keyup", updateSelection);
    window.addEventListener("resize", updateSelection);
    window.addEventListener("scroll", updateSelection, true);

    return () => {
      if (deferredUpdateRef.current !== null) {
        window.clearTimeout(deferredUpdateRef.current);
        deferredUpdateRef.current = null;
      }
      document.removeEventListener("mousedown", hideSelectionToolbar);
      document.removeEventListener("mouseup", deferredUpdate);
      document.removeEventListener("keyup", updateSelection);
      window.removeEventListener("resize", updateSelection);
      window.removeEventListener("scroll", updateSelection, true);
    };
  }, [enabled, updateSelection]);

  return { selectedText, selectionPosition, clearSelection };
}

function selectionRect(range: Range): DOMRect {
  const rect = range.getBoundingClientRect();
  if (rect.width > 0 || rect.height > 0) {
    return rect;
  }
  const firstRect = range.getClientRects().item(0);
  return firstRect ?? rect;
}
