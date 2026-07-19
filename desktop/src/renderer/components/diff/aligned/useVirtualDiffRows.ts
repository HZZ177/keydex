import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { DiffRowHeightIndex } from "./rowHeightIndex";

export interface VirtualDiffWindow {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly visibleStartIndex: number;
  readonly visibleEndIndex: number;
  readonly topSpacerHeight: number;
  readonly bottomSpacerHeight: number;
  readonly totalHeight: number;
  readonly mountedRowCount: number;
}

export interface UseVirtualDiffRowsOptions {
  readonly rowCount: number;
  readonly estimatedHeight: number | readonly number[];
  readonly scrollElement: HTMLElement | null;
  readonly viewport?: Readonly<{ scrollTop: number; height: number }>;
  readonly enabled?: boolean;
  readonly overscanPx?: number;
  readonly maxMountedRows?: number;
}

export interface UseVirtualDiffRowsResult {
  readonly heightIndex: DiffRowHeightIndex;
  readonly window: VirtualDiffWindow;
  readonly rowIndexes: readonly number[];
  readonly measureRow: (rowIndex: number, height: number) => void;
  readonly observeRow: (rowIndex: number, element: HTMLElement | null) => void;
  readonly refresh: () => void;
}

const DEFAULT_OVERSCAN_PX = 480;
const DEFAULT_MAX_MOUNTED_ROWS = 1_000;

export function resolveVirtualDiffWindow(
  heightIndex: DiffRowHeightIndex,
  scrollTop: number,
  viewportHeight: number,
  overscanPx = DEFAULT_OVERSCAN_PX,
  maxMountedRows = DEFAULT_MAX_MOUNTED_ROWS,
): VirtualDiffWindow {
  assertWindowInput(scrollTop, viewportHeight, overscanPx, maxMountedRows);
  const rowCount = heightIndex.length;
  if (rowCount === 0) return emptyWindow();

  const safeTop = Math.min(heightIndex.totalHeight, Math.max(0, scrollTop));
  const safeBottom = Math.min(heightIndex.totalHeight, safeTop + viewportHeight);
  const visibleStartIndex = Math.min(rowCount, heightIndex.offsetToRow(safeTop));
  const visibleEndIndex = safeBottom >= heightIndex.totalHeight
    ? rowCount
    : Math.min(rowCount, heightIndex.offsetToRow(safeBottom) + 1);
  let startIndex = Math.min(rowCount, heightIndex.offsetToRow(Math.max(0, safeTop - overscanPx)));
  let endIndex = safeBottom + overscanPx >= heightIndex.totalHeight
    ? rowCount
    : Math.min(rowCount, heightIndex.offsetToRow(safeBottom + overscanPx) + 1);

  const visibleCount = visibleEndIndex - visibleStartIndex;
  const effectiveBudget = Math.max(maxMountedRows, visibleCount);
  if (endIndex - startIndex > effectiveBudget) {
    const spare = Math.max(0, effectiveBudget - visibleCount);
    const before = Math.min(visibleStartIndex, Math.floor(spare / 2));
    startIndex = visibleStartIndex - before;
    endIndex = Math.min(rowCount, startIndex + effectiveBudget);
    startIndex = Math.max(0, endIndex - effectiveBudget);
  }

  return Object.freeze({
    startIndex,
    endIndex,
    visibleStartIndex,
    visibleEndIndex,
    topSpacerHeight: heightIndex.rowToOffset(startIndex),
    bottomSpacerHeight: heightIndex.totalHeight - heightIndex.rowToOffset(endIndex),
    totalHeight: heightIndex.totalHeight,
    mountedRowCount: endIndex - startIndex,
  });
}

export function useVirtualDiffRows({
  rowCount,
  estimatedHeight,
  scrollElement,
  viewport: controlledViewport,
  enabled = true,
  overscanPx = DEFAULT_OVERSCAN_PX,
  maxMountedRows = DEFAULT_MAX_MOUNTED_ROWS,
}: UseVirtualDiffRowsOptions): UseVirtualDiffRowsResult {
  const heightIndex = useMemo(
    () => new DiffRowHeightIndex(rowCount, estimatedHeight),
    [estimatedHeight, rowCount],
  );
  const [viewport, setViewport] = useState(() => ({ scrollTop: 0, height: 0, revision: 0 }));
  const controlledViewportRef = useRef(controlledViewport);
  controlledViewportRef.current = controlledViewport;
  const frameRef = useRef<number | null>(null);
  const observedRows = useRef(new Map<HTMLElement, number>());
  const resizeObserverRef = useRef<ResizeObserver | null>(null);

  const refresh = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestFrame(() => {
      frameRef.current = null;
      const controlled = controlledViewportRef.current;
      setViewport((current) => ({
        scrollTop: controlled?.scrollTop ?? scrollElement?.scrollTop ?? current.scrollTop,
        height: controlled?.height ?? scrollElement?.clientHeight ?? current.height,
        revision: current.revision + 1,
      }));
    });
  }, [scrollElement]);

  const measureRow = useCallback((rowIndex: number, height: number) => {
    const delta = heightIndex.setMeasuredHeight(rowIndex, height);
    if (Math.abs(delta) > 0.01) refresh();
  }, [heightIndex, refresh]);

  const observeRow = useCallback((rowIndex: number, element: HTMLElement | null) => {
    for (const [current, currentIndex] of observedRows.current) {
      if (currentIndex !== rowIndex || current === element) continue;
      resizeObserverRef.current?.unobserve(current);
      observedRows.current.delete(current);
    }
    if (!element) return;
    observedRows.current.set(element, rowIndex);
    resizeObserverRef.current?.observe(element);
    const height = element.getBoundingClientRect().height;
    if (height > 0) measureRow(rowIndex, height);
  }, [measureRow]);

  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const rowIndex = observedRows.current.get(entry.target as HTMLElement);
        const height = resizeEntryHeight(entry);
        if (rowIndex !== undefined && height > 0) measureRow(rowIndex, height);
      }
    });
    resizeObserverRef.current = observer;
    for (const element of observedRows.current.keys()) observer.observe(element);
    return () => {
      observer.disconnect();
      resizeObserverRef.current = null;
    };
  }, [measureRow]);

  useEffect(() => {
    if (!scrollElement) return undefined;
    if (controlledViewport) return undefined;
    const onScroll = () => refresh();
    scrollElement.addEventListener("scroll", onScroll, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(refresh);
    observer?.observe(scrollElement);
    refresh();
    return () => {
      scrollElement.removeEventListener("scroll", onScroll);
      observer?.disconnect();
    };
  }, [controlledViewport, refresh, scrollElement]);

  useEffect(() => () => {
    if (frameRef.current !== null) cancelFrame(frameRef.current);
  }, []);

  const effectiveViewport = controlledViewport
    ? { ...controlledViewport, revision: viewport.revision }
    : viewport;
  const window = useMemo(() => {
    if (!enabled) {
      return Object.freeze({
        startIndex: 0,
        endIndex: rowCount,
        visibleStartIndex: 0,
        visibleEndIndex: rowCount,
        topSpacerHeight: 0,
        bottomSpacerHeight: 0,
        totalHeight: heightIndex.totalHeight,
        mountedRowCount: rowCount,
      });
    }
    return resolveVirtualDiffWindow(
      heightIndex,
      effectiveViewport.scrollTop,
      effectiveViewport.height,
      overscanPx,
      maxMountedRows,
    );
  }, [effectiveViewport, enabled, heightIndex, maxMountedRows, overscanPx, rowCount]);
  const rowIndexes = useMemo(
    () => Object.freeze(Array.from(
      { length: window.endIndex - window.startIndex },
      (_, offset) => window.startIndex + offset,
    )),
    [window.endIndex, window.startIndex],
  );

  return Object.freeze({ heightIndex, window, rowIndexes, measureRow, observeRow, refresh });
}

function emptyWindow(): VirtualDiffWindow {
  return Object.freeze({
    startIndex: 0,
    endIndex: 0,
    visibleStartIndex: 0,
    visibleEndIndex: 0,
    topSpacerHeight: 0,
    bottomSpacerHeight: 0,
    totalHeight: 0,
    mountedRowCount: 0,
  });
}

function resizeEntryHeight(entry: ResizeObserverEntry): number {
  const borderBox = Array.isArray(entry.borderBoxSize) ? entry.borderBoxSize[0] : entry.borderBoxSize;
  return borderBox?.blockSize ?? entry.contentRect.height;
}

function requestFrame(callback: FrameRequestCallback): number {
  return typeof requestAnimationFrame === "function"
    ? requestAnimationFrame(callback)
    : globalThis.setTimeout(() => callback(performance.now()), 0) as unknown as number;
}

function cancelFrame(frame: number): void {
  if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(frame);
  else globalThis.clearTimeout(frame);
}

function assertWindowInput(
  scrollTop: number,
  viewportHeight: number,
  overscanPx: number,
  maxMountedRows: number,
): void {
  if (![scrollTop, viewportHeight, overscanPx].every(Number.isFinite)) {
    throw new TypeError("virtual window measurements must be finite");
  }
  if (viewportHeight < 0 || overscanPx < 0) {
    throw new RangeError("virtual window measurements must be non-negative");
  }
  if (!Number.isInteger(maxMountedRows) || maxMountedRows <= 0) {
    throw new TypeError("maxMountedRows must be a positive integer");
  }
}
