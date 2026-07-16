import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

import styles from "./FloatingLayer.module.css";

export type FloatingPlacement = "top" | "bottom";
export type FloatingAlignment = "start" | "end" | "center";

export interface FloatingLayerProps extends Omit<HTMLAttributes<HTMLDivElement>, "style"> {
  anchorRef: RefObject<HTMLElement | null>;
  alignment?: FloatingAlignment;
  children: ReactNode;
  floatingRef?: Ref<HTMLDivElement>;
  matchAnchorWidth?: boolean;
  offset?: number;
  placement?: FloatingPlacement;
  style?: CSSProperties;
  viewportPadding?: number;
}

interface FloatingPosition {
  left: number;
  maxHeight: number;
  placement: FloatingPlacement;
  ready: boolean;
  top: number;
  width?: number;
}

const DEFAULT_OFFSET = 8;
const DEFAULT_VIEWPORT_PADDING = 12;
const MIN_LAYER_HEIGHT = 120;

const INITIAL_POSITION: FloatingPosition = {
  left: 0,
  maxHeight: 0,
  placement: "bottom",
  ready: false,
  top: 0,
};

export function FloatingLayer({
  alignment = "start",
  anchorRef,
  children,
  className,
  floatingRef,
  matchAnchorWidth = false,
  offset = DEFAULT_OFFSET,
  placement = "bottom",
  style,
  viewportPadding = DEFAULT_VIEWPORT_PADDING,
  ...props
}: FloatingLayerProps) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const [position, setPosition] = useState<FloatingPosition>(() => ({
    ...INITIAL_POSITION,
    placement,
  }));

  const setLayerRef = useCallback(
    (element: HTMLDivElement | null) => {
      layerRef.current = element;
      assignRef(floatingRef, element);
    },
    [floatingRef],
  );

  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    const layer = layerRef.current;
    if (!anchor || !layer || typeof window === "undefined") {
      return;
    }

    const anchorRect = anchor.getBoundingClientRect();
    const layerRect = layer.getBoundingClientRect();
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const layerWidth = matchAnchorWidth ? anchorRect.width : layerRect.width;
    const layerHeight = layerRect.height;
    const usableWidth = Math.max(0, viewportWidth - viewportPadding * 2);
    const width = matchAnchorWidth ? Math.min(Math.max(anchorRect.width, 0), usableWidth) : undefined;
    const measuredWidth = Math.min(Math.max(layerWidth || anchorRect.width, width ?? 0), usableWidth);
    const spaceBelow = Math.max(0, viewportHeight - viewportPadding - anchorRect.bottom - offset);
    const spaceAbove = Math.max(0, anchorRect.top - viewportPadding - offset);
    const canResolveCollision =
      anchorRect.width > 0 || anchorRect.height > 0 || layerRect.width > 0 || layerRect.height > 0;
    const resolvedPlacement =
      !canResolveCollision
        ? placement
        : placement === "bottom"
        ? spaceBelow < Math.min(layerHeight || MIN_LAYER_HEIGHT, MIN_LAYER_HEIGHT) && spaceAbove > spaceBelow
          ? "top"
          : "bottom"
        : spaceAbove < Math.min(layerHeight || MIN_LAYER_HEIGHT, MIN_LAYER_HEIGHT) && spaceBelow > spaceAbove
          ? "bottom"
          : "top";
    const availableHeight = resolvedPlacement === "bottom" ? spaceBelow : spaceAbove;
    const maxHeight = Math.max(MIN_LAYER_HEIGHT, availableHeight);
    const renderedHeight = Math.min(layerHeight || MIN_LAYER_HEIGHT, maxHeight);
    const top =
      resolvedPlacement === "bottom"
        ? anchorRect.bottom + offset
        : Math.max(viewportPadding, anchorRect.top - offset - renderedHeight);
    const alignedLeft = alignLayer(anchorRect, measuredWidth, alignment);
    const left = clamp(alignedLeft, viewportPadding, Math.max(viewportPadding, viewportWidth - viewportPadding - measuredWidth));

    setPosition((current) => {
      const next: FloatingPosition = {
        left: Math.round(left),
        maxHeight: Math.round(maxHeight),
        placement: resolvedPlacement,
        ready: true,
        top: Math.round(top),
        width,
      };
      return floatingPositionsEqual(current, next) ? current : next;
    });
  }, [alignment, anchorRef, matchAnchorWidth, offset, placement, viewportPadding]);

  const scheduleUpdate = useCallback(() => {
    if (frameRef.current !== null || typeof window === "undefined") {
      return;
    }
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      updatePosition();
    });
  }, [updatePosition]);

  useLayoutEffect(() => {
    setPosition((current) => ({ ...current, placement, ready: false }));
    updatePosition();
    scheduleUpdate();

    const anchor = anchorRef.current;
    const layer = layerRef.current;
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            scheduleUpdate();
          });
    if (anchor) {
      resizeObserver?.observe(anchor);
    }
    if (layer) {
      resizeObserver?.observe(layer);
    }

    window.addEventListener("resize", scheduleUpdate);
    window.addEventListener("scroll", scheduleUpdate, true);
    return () => {
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleUpdate);
      window.removeEventListener("scroll", scheduleUpdate, true);
    };
  }, [anchorRef, placement, scheduleUpdate, updatePosition]);

  if (typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div
      {...props}
      className={[styles.layer, className].filter(Boolean).join(" ")}
      data-floating-layer="true"
      data-placement={position.placement}
      ref={setLayerRef}
      style={{
        ...style,
        "--floating-max-height": `${position.maxHeight}px`,
        bottom: "auto",
        left: position.left,
        maxHeight: position.maxHeight ? `${position.maxHeight}px` : undefined,
        position: "fixed",
        right: "auto",
        top: position.top,
        visibility: position.ready ? style?.visibility : "hidden",
        width: position.width ?? style?.width,
      } as CSSProperties}
    >
      {children}
    </div>,
    document.body,
  );
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (!ref) {
    return;
  }
  if (typeof ref === "function") {
    ref(value);
    return;
  }
  ref.current = value;
}

function alignLayer(anchorRect: DOMRect, layerWidth: number, alignment: FloatingAlignment) {
  if (alignment === "end") {
    return anchorRect.right - layerWidth;
  }
  if (alignment === "center") {
    return anchorRect.left + anchorRect.width / 2 - layerWidth / 2;
  }
  return anchorRect.left;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function floatingPositionsEqual(left: FloatingPosition, right: FloatingPosition) {
  return (
    left.left === right.left &&
    left.maxHeight === right.maxHeight &&
    left.placement === right.placement &&
    left.ready === right.ready &&
    left.top === right.top &&
    left.width === right.width
  );
}
