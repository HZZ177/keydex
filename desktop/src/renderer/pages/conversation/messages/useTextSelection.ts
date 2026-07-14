import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

export interface SelectionPosition {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TextSelectionOptions {
  enabled?: boolean;
  excludeSelector?: string;
}

interface TextSelectionSnapshot {
  selectedText: string;
  selectionPosition: SelectionPosition | null;
  selectionRange: Range | null;
}

interface SelectionSubscriber {
  containerRef: RefObject<HTMLElement | null>;
  excludeSelector?: string;
  setSnapshot: (snapshot: TextSelectionSnapshot) => void;
}

const EMPTY_SELECTION: TextSelectionSnapshot = {
  selectedText: "",
  selectionPosition: null,
  selectionRange: null,
};

const selectionSubscribers = new Set<SelectionSubscriber>();
let activeSelectionSubscriber: SelectionSubscriber | null = null;
let globalSelectionListenersAttached = false;
let deferredSelectionUpdateId: number | null = null;
let scheduledActiveSelectionUpdateId: number | null = null;

export function useTextSelection(
  containerRef: RefObject<HTMLElement | null>,
  enabledOrOptions: boolean | TextSelectionOptions = true,
) {
  const enabled = typeof enabledOrOptions === "boolean" ? enabledOrOptions : enabledOrOptions.enabled ?? true;
  const excludeSelector = typeof enabledOrOptions === "boolean" ? undefined : enabledOrOptions.excludeSelector;
  const [snapshot, setSnapshotState] = useState<TextSelectionSnapshot>(EMPTY_SELECTION);

  const setSnapshot = useCallback((nextSnapshot: TextSelectionSnapshot) => {
    setSnapshotState((current) => {
      return textSelectionSnapshotsEqual(current, nextSnapshot) ? current : nextSnapshot;
    });
  }, []);

  const subscriberRef = useRef<SelectionSubscriber | null>(null);
  if (subscriberRef.current === null) {
    subscriberRef.current = {
      containerRef,
      excludeSelector,
      setSnapshot,
    };
  }
  subscriberRef.current.containerRef = containerRef;
  subscriberRef.current.excludeSelector = excludeSelector;
  subscriberRef.current.setSnapshot = setSnapshot;

  const clearSelection = useCallback(() => {
    const subscriber = subscriberRef.current;
    if (activeSelectionSubscriber === subscriber) {
      activeSelectionSubscriber = null;
    }
    setSnapshot(EMPTY_SELECTION);
    window.getSelection()?.removeAllRanges();
  }, [setSnapshot]);

  useEffect(() => {
    const subscriber = subscriberRef.current;
    if (!subscriber) {
      return;
    }
    if (!enabled) {
      if (activeSelectionSubscriber === subscriber) {
        activeSelectionSubscriber = null;
      }
      setSnapshot(EMPTY_SELECTION);
      return;
    }

    selectionSubscribers.add(subscriber);
    ensureGlobalSelectionListeners();

    return () => {
      selectionSubscribers.delete(subscriber);
      if (activeSelectionSubscriber === subscriber) {
        activeSelectionSubscriber = null;
      }
      if (selectionSubscribers.size === 0) {
        removeGlobalSelectionListeners();
      }
    };
  }, [enabled, setSnapshot]);

  return {
    selectedText: snapshot.selectedText,
    selectionPosition: snapshot.selectionPosition,
    selectionRange: snapshot.selectionRange,
    clearSelection,
  };
}

function ensureGlobalSelectionListeners(): void {
  if (globalSelectionListenersAttached || typeof document === "undefined" || typeof window === "undefined") {
    return;
  }
  document.addEventListener("mousedown", handleDocumentMouseDown);
  document.addEventListener("mouseup", handleDocumentMouseUp);
  document.addEventListener("keyup", handleDocumentKeyUp);
  window.addEventListener("resize", scheduleActiveSelectionUpdate);
  window.addEventListener("scroll", scheduleActiveSelectionUpdate, true);
  globalSelectionListenersAttached = true;
}

function removeGlobalSelectionListeners(): void {
  if (!globalSelectionListenersAttached || typeof document === "undefined" || typeof window === "undefined") {
    return;
  }
  document.removeEventListener("mousedown", handleDocumentMouseDown);
  document.removeEventListener("mouseup", handleDocumentMouseUp);
  document.removeEventListener("keyup", handleDocumentKeyUp);
  window.removeEventListener("resize", scheduleActiveSelectionUpdate);
  window.removeEventListener("scroll", scheduleActiveSelectionUpdate, true);
  globalSelectionListenersAttached = false;
  clearScheduledSelectionUpdates();
}

function handleDocumentMouseDown(): void {
  clearActiveSelectionSubscriber();
}

function handleDocumentMouseUp(): void {
  scheduleDeferredSelectionUpdate();
}

function handleDocumentKeyUp(): void {
  updateGlobalSelection({ activeOnly: false });
}

function scheduleDeferredSelectionUpdate(): void {
  if (deferredSelectionUpdateId !== null) {
    window.clearTimeout(deferredSelectionUpdateId);
  }
  deferredSelectionUpdateId = window.setTimeout(() => {
    deferredSelectionUpdateId = null;
    updateGlobalSelection({ activeOnly: false });
  }, 0);
}

function scheduleActiveSelectionUpdate(event?: Event): void {
  if (event?.type === "scroll" && eventTargetsSelectionOverlay(event)) {
    return;
  }
  if (scheduledActiveSelectionUpdateId !== null) {
    return;
  }
  scheduledActiveSelectionUpdateId = window.setTimeout(() => {
    scheduledActiveSelectionUpdateId = null;
    updateGlobalSelection({ activeOnly: true });
  }, 16);
}

function eventTargetsSelectionOverlay(event: Event): boolean {
  const target = event.target;
  return target instanceof Element && Boolean(target.closest("[data-text-selection-overlay='true']"));
}

function clearScheduledSelectionUpdates(): void {
  if (deferredSelectionUpdateId !== null) {
    window.clearTimeout(deferredSelectionUpdateId);
    deferredSelectionUpdateId = null;
  }
  if (scheduledActiveSelectionUpdateId !== null) {
    window.clearTimeout(scheduledActiveSelectionUpdateId);
    scheduledActiveSelectionUpdateId = null;
  }
}

function updateGlobalSelection({ activeOnly }: { activeOnly: boolean }): void {
  if (selectionSubscribers.size === 0) {
    return;
  }
  if (activeOnly && selectionCommentOverlayIsOpen()) {
    return;
  }
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    clearActiveSelectionSubscriber();
    return;
  }

  const range = selection.getRangeAt(0);
  const target = findSelectionSubscriber(range, activeOnly);
  if (!target) {
    clearActiveSelectionSubscriber();
    return;
  }

  const text = selection.toString().trim();
  if (!text) {
    const targetWasActive = activeSelectionSubscriber === target;
    clearActiveSelectionSubscriber();
    if (!targetWasActive) {
      target.setSnapshot(EMPTY_SELECTION);
    }
    return;
  }

  const rect = selectionRect(range);
  const snapshot: TextSelectionSnapshot = {
    selectedText: text,
    selectionPosition: {
      x: rect.width > 0 ? rect.left + rect.width / 2 : rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    },
    selectionRange: typeof range.cloneRange === "function" ? range.cloneRange() : null,
  };

  if (activeSelectionSubscriber && activeSelectionSubscriber !== target) {
    activeSelectionSubscriber.setSnapshot(EMPTY_SELECTION);
  }
  activeSelectionSubscriber = target;
  target.setSnapshot(snapshot);
}

function selectionCommentOverlayIsOpen(): boolean {
  return Boolean(document.querySelector("[data-text-selection-overlay='true'][data-mode='comment']"));
}

function findSelectionSubscriber(range: Range, activeOnly: boolean): SelectionSubscriber | null {
  if (
    activeSelectionSubscriber &&
    selectionSubscribers.has(activeSelectionSubscriber) &&
    subscriberOwnsRange(activeSelectionSubscriber, range)
  ) {
    return activeSelectionSubscriber;
  }
  if (activeOnly) {
    return null;
  }

  let match: SelectionSubscriber | null = null;
  for (const subscriber of selectionSubscribers) {
    if (!subscriberOwnsRange(subscriber, range)) {
      continue;
    }
    const container = subscriber.containerRef.current;
    const matchContainer = match?.containerRef.current;
    if (!match || (container && matchContainer?.contains(container))) {
      match = subscriber;
    }
  }
  return match;
}

function subscriberOwnsRange(subscriber: SelectionSubscriber, range: Range): boolean {
  const container = subscriber.containerRef.current;
  if (!container || !container.contains(range.commonAncestorContainer)) {
    return false;
  }
  return !rangeTouchesExcludedElement(range, container, subscriber.excludeSelector);
}

function clearActiveSelectionSubscriber(): void {
  const subscriber = activeSelectionSubscriber;
  if (!subscriber) {
    return;
  }
  activeSelectionSubscriber = null;
  subscriber.setSnapshot(EMPTY_SELECTION);
}

function textSelectionSnapshotsEqual(a: TextSelectionSnapshot, b: TextSelectionSnapshot): boolean {
  return (
    a.selectedText === b.selectedText &&
    selectionPositionsEqual(a.selectionPosition, b.selectionPosition) &&
    rangesEquivalent(a.selectionRange, b.selectionRange)
  );
}

function selectionPositionsEqual(a: SelectionPosition | null, b: SelectionPosition | null): boolean {
  if (a === b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function rangesEquivalent(a: Range | null, b: Range | null): boolean {
  if (a === b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  try {
    return (
      a.startContainer === b.startContainer &&
      a.startOffset === b.startOffset &&
      a.endContainer === b.endContainer &&
      a.endOffset === b.endOffset &&
      a.collapsed === b.collapsed
    );
  } catch {
    return false;
  }
}

function rangeTouchesExcludedElement(
  range: Range,
  container: HTMLElement,
  excludeSelector: string | undefined,
): boolean {
  if (!excludeSelector) {
    return false;
  }
  return [range.commonAncestorContainer, range.startContainer, range.endContainer]
    .filter((node): node is Node => Boolean(node))
    .some((node) => nodeTouchesExcludedElement(node, container, excludeSelector));
}

function nodeTouchesExcludedElement(node: Node, container: HTMLElement, excludeSelector: string): boolean {
  const element = node instanceof Element ? node : node.parentElement;
  const excluded = element?.closest(excludeSelector);
  return Boolean(excluded && container.contains(excluded));
}

function selectionRect(range: Range): DOMRect {
  const rect = range.getBoundingClientRect();
  if (rect.width > 0 || rect.height > 0) {
    return rect;
  }
  const firstRect = range.getClientRects().item(0);
  return firstRect ?? rect;
}
