import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import styles from "./MessageList.module.css";

const MIN_THUMB_HEIGHT_PX = 36;

interface ScrollMetrics {
  readonly visible: boolean;
  readonly maxScrollTop: number;
  readonly maxThumbTop: number;
  readonly thumbHeight: number;
  readonly thumbTop: number;
}

interface ScrollDrag {
  readonly pointerId: number;
  readonly pointerOffsetY: number;
  readonly trackTop: number;
  readonly metrics: ScrollMetrics;
  thumbTop: number;
}

const EMPTY_METRICS: ScrollMetrics = Object.freeze({
  visible: false,
  maxScrollTop: 0,
  maxThumbTop: 0,
  thumbHeight: 0,
  thumbTop: 0,
});

export function ConversationScrollRail({
  scrollElement,
  onInteractionChange,
}: {
  readonly scrollElement: HTMLElement | null;
  readonly onInteractionChange: (active: boolean) => void;
}) {
  const railRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<number | null>(null);
  const dragRef = useRef<ScrollDrag | null>(null);
  const onInteractionChangeRef = useRef(onInteractionChange);
  const [metrics, setMetrics] = useState<ScrollMetrics>(EMPTY_METRICS);
  onInteractionChangeRef.current = onInteractionChange;

  const readMetrics = useCallback((): ScrollMetrics => {
    const track = trackRef.current;
    if (!track || !scrollElement) return EMPTY_METRICS;
    const trackHeight = track.clientHeight;
    const viewportHeight = scrollElement.clientHeight;
    const scrollHeight = scrollElement.scrollHeight;
    const maxScrollTop = Math.max(0, scrollHeight - viewportHeight);
    if (trackHeight <= 0 || viewportHeight <= 0 || maxScrollTop <= 0) return EMPTY_METRICS;
    const thumbHeight = Math.min(
      trackHeight,
      Math.max(MIN_THUMB_HEIGHT_PX, Math.round((viewportHeight / scrollHeight) * trackHeight)),
    );
    const maxThumbTop = Math.max(0, trackHeight - thumbHeight);
    const thumbTop = maxThumbTop <= 0 ? 0 : (scrollElement.scrollTop / maxScrollTop) * maxThumbTop;
    return Object.freeze({
      visible: true,
      maxScrollTop,
      maxThumbTop,
      thumbHeight,
      thumbTop: clamp(thumbTop, 0, maxThumbTop),
    });
  }, [scrollElement]);

  const updateMetrics = useCallback(() => {
    if (dragRef.current) return;
    const next = readMetrics();
    setMetrics((current) => metricsEqual(current, next) ? current : next);
  }, [readMetrics]);

  const scheduleMetrics = useCallback(() => {
    if (frameRef.current !== null || dragRef.current) return;
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      updateMetrics();
    });
  }, [updateMetrics]);

  useLayoutEffect(() => {
    updateMetrics();
    if (!scrollElement) return;
    const delayedMeasure = window.setTimeout(scheduleMetrics, 80);
    scrollElement.addEventListener("scroll", scheduleMetrics, { passive: true });
    window.addEventListener("resize", scheduleMetrics);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleMetrics);
    observer?.observe(scrollElement);
    const content = scrollElement.firstElementChild;
    if (content instanceof HTMLElement) observer?.observe(content);
    if (railRef.current) observer?.observe(railRef.current);
    if (trackRef.current) observer?.observe(trackRef.current);
    return () => {
      window.clearTimeout(delayedMeasure);
      scrollElement.removeEventListener("scroll", scheduleMetrics);
      window.removeEventListener("resize", scheduleMetrics);
      observer?.disconnect();
    };
  }, [scheduleMetrics, scrollElement, updateMetrics]);

  useEffect(() => () => {
    if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
    if (dragRef.current) onInteractionChangeRef.current(false);
    dragRef.current = null;
  }, []);

  const scrollToThumbTop = useCallback((thumbTop: number, source: ScrollMetrics): number | null => {
    if (!scrollElement || !source.visible || source.maxThumbTop <= 0) return null;
    const nextThumbTop = clamp(thumbTop, 0, source.maxThumbTop);
    // The thumb is a direct-manipulation surface. Update its compositor-only
    // transform before touching scrollTop so it never waits for React to batch
    // a continuous pointermove state update behind timeline work.
    if (thumbRef.current) thumbRef.current.style.transform = `translateY(${nextThumbTop}px)`;
    scrollElement.scrollTop = (nextThumbTop / source.maxThumbTop) * source.maxScrollTop;
    return nextThumbTop;
  }, [scrollElement]);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const rail = railRef.current;
    const track = trackRef.current;
    if (!rail || !track || !scrollElement) return;
    const current = readMetrics();
    if (!current.visible || current.maxThumbTop <= 0 || current.maxScrollTop <= 0) return;
    event.preventDefault();
    event.stopPropagation();
    const target = event.target instanceof Element ? event.target : null;
    const thumb = target?.closest<HTMLElement>(`.${styles.conversationScrollThumb}`) ?? null;
    const trackRect = track.getBoundingClientRect();
    const pointerOffsetY = thumb
      ? clamp(event.clientY - thumb.getBoundingClientRect().top, 0, current.thumbHeight)
      : current.thumbHeight / 2;
    dragRef.current = {
      pointerId: event.pointerId,
      pointerOffsetY,
      trackTop: trackRect.top,
      metrics: current,
      thumbTop: current.thumbTop,
    };
    rail.dataset.dragging = "true";
    rail.setPointerCapture?.(event.pointerId);
    onInteractionChange(true);
    if (!thumb) {
      const nextThumbTop = scrollToThumbTop(event.clientY - trackRect.top - pointerOffsetY, current);
      if (nextThumbTop !== null && dragRef.current) dragRef.current.thumbTop = nextThumbTop;
    }
  }, [onInteractionChange, readMetrics, scrollElement, scrollToThumbTop]);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const nextThumbTop = scrollToThumbTop(event.clientY - drag.trackTop - drag.pointerOffsetY, drag.metrics);
    if (nextThumbTop !== null) drag.thumbTop = nextThumbTop;
  }, [scrollToThumbTop]);

  const finishDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setMetrics(Object.freeze({ ...drag.metrics, thumbTop: drag.thumbTop }));
    delete event.currentTarget.dataset.dragging;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    onInteractionChange(false);
    scheduleMetrics();
  }, [onInteractionChange, scheduleMetrics]);

  return (
    <div
      ref={railRef}
      className={styles.conversationScrollRail}
      data-visible={metrics.visible ? "true" : "false"}
      data-testid="conversation-scroll-rail"
      aria-hidden="true"
      onPointerCancel={finishDrag}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishDrag}
    >
      <div ref={trackRef} className={styles.conversationScrollTrack}>
        <div
          ref={thumbRef}
          className={styles.conversationScrollThumb}
          data-testid="conversation-scroll-thumb"
          style={{ height: `${metrics.thumbHeight}px`, transform: `translateY(${metrics.thumbTop}px)` }}
        />
      </div>
    </div>
  );
}

function metricsEqual(left: ScrollMetrics, right: ScrollMetrics): boolean {
  return left.visible === right.visible
    && Math.abs(left.maxScrollTop - right.maxScrollTop) < 0.5
    && Math.abs(left.maxThumbTop - right.maxThumbTop) < 0.5
    && Math.abs(left.thumbHeight - right.thumbHeight) < 0.5
    && Math.abs(left.thumbTop - right.thumbTop) < 0.5;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}
