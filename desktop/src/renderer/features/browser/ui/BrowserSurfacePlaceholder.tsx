import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
} from "react";

import type { BrowserLogicalRect, BrowserVisibilityReason } from "../domain";
import { useBrowserOcclusionSnapshot } from "../runtime";

import styles from "./BrowserSurfacePlaceholder.module.css";

export type BrowserSurfaceResourceState = "visible" | "warm" | "native_suspended" | "discarded";

export interface BrowserSurfaceVisibilityInput {
  readonly visible: boolean;
  readonly reason: BrowserVisibilityReason;
}

export interface BrowserSurfacePlaceholderProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  readonly active: boolean;
  readonly resourceState?: BrowserSurfaceResourceState;
  onBoundsChange(rect: BrowserLogicalRect): void;
  onVisibilityChange(input: BrowserSurfaceVisibilityInput): void;
}

export function BrowserSurfacePlaceholder({
  active,
  className = "",
  onBoundsChange,
  onVisibilityChange,
  resourceState = "visible",
  ...props
}: BrowserSurfacePlaceholderProps) {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const lastBoundsRef = useRef<BrowserLogicalRect | null>(null);
  const onBoundsChangeRef = useRef(onBoundsChange);
  const onVisibilityChangeRef = useRef(onVisibilityChange);
  const [hasPositiveArea, setHasPositiveArea] = useState(false);
  const { count: occlusionCount } = useBrowserOcclusionSnapshot();
  onBoundsChangeRef.current = onBoundsChange;
  onVisibilityChangeRef.current = onVisibilityChange;

  const measure = useCallback(() => {
    frameRef.current = null;
    const element = elementRef.current;
    if (!element) return;
    const next = logicalRectFromDomRect(element.getBoundingClientRect());
    const positive = next.width > 0 && next.height > 0;
    setHasPositiveArea((current) => current === positive ? current : positive);
    if (!sameLogicalRect(lastBoundsRef.current, next)) {
      lastBoundsRef.current = next;
      onBoundsChangeRef.current(next);
    }
  }, []);

  const scheduleMeasure = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = window.requestAnimationFrame(measure);
  }, [measure]);

  useLayoutEffect(scheduleMeasure);

  // The DOM placeholder is measured before the native WebView is ready. That
  // first callback cannot dispatch bounds because no surface exists yet, but
  // it still populates lastBoundsRef. When readiness flips `active` to true,
  // invalidate the cache so the unchanged rect is sent to the new surface.
  useLayoutEffect(() => {
    if (!active) return;
    lastBoundsRef.current = null;
    scheduleMeasure();
  }, [active, scheduleMeasure]);

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(scheduleMeasure);
    resizeObserver?.observe(element);
    window.addEventListener("resize", scheduleMeasure);
    window.addEventListener("scroll", scheduleMeasure, true);
    document.addEventListener("visibilitychange", scheduleMeasure);
    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleMeasure);
      window.removeEventListener("scroll", scheduleMeasure, true);
      document.removeEventListener("visibilitychange", scheduleMeasure);
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [scheduleMeasure]);

  const visibility = resolveBrowserSurfaceVisibility({
    active,
    documentVisible: typeof document === "undefined" || document.visibilityState !== "hidden",
    hasPositiveArea,
    occlusionCount,
    resourceState,
  });
  const lastVisibilityRef = useRef<BrowserSurfaceVisibilityInput | null>(null);
  useEffect(() => {
    const previous = lastVisibilityRef.current;
    if (previous?.visible === visibility.visible && previous.reason === visibility.reason) return;
    lastVisibilityRef.current = visibility;
    onVisibilityChangeRef.current(visibility);
  }, [visibility.reason, visibility.visible]);

  return (
    <div
      {...props}
      ref={elementRef}
      aria-hidden="true"
      className={`${styles.root} ${className}`.trim()}
      data-browser-native-surface="placeholder"
    />
  );
}

export function logicalRectFromDomRect(rect: Pick<DOMRect, "x" | "y" | "width" | "height">): BrowserLogicalRect {
  return {
    x: finiteOrZero(rect.x),
    y: finiteOrZero(rect.y),
    width: Math.max(0, finiteOrZero(rect.width)),
    height: Math.max(0, finiteOrZero(rect.height)),
  };
}

export function resolveBrowserSurfaceVisibility(input: {
  readonly active: boolean;
  readonly documentVisible: boolean;
  readonly hasPositiveArea: boolean;
  readonly occlusionCount: number;
  readonly resourceState: BrowserSurfaceResourceState;
}): BrowserSurfaceVisibilityInput {
  if (!input.documentVisible) return { visible: false, reason: "window_hidden" };
  if (!input.active) return { visible: false, reason: "inactive_tab" };
  if (!input.hasPositiveArea || input.resourceState !== "visible") {
    return { visible: false, reason: "sidebar_closed" };
  }
  if (input.occlusionCount > 0) return { visible: false, reason: "occluded" };
  return { visible: true, reason: "active" };
}

function sameLogicalRect(left: BrowserLogicalRect | null, right: BrowserLogicalRect): boolean {
  return left !== null
    && left.x === right.x
    && left.y === right.y
    && left.width === right.width
    && left.height === right.height;
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}
