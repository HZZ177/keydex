import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { FollowOutput, VirtuosoHandle } from "react-virtuoso";

import { isUpwardWheelIntent, wheelWillScrollElement, type WheelIntentEvent } from "./scrollIntent";
import { EXPANSION_SCROLL_LOCK_ATTR } from "./useExpansionScrollAnchor";

const AT_BOTTOM_THRESHOLD_PX = 100;
const FOLLOW_BOTTOM_THRESHOLD_PX = 4;
type VirtuosoScrollBehavior = "auto" | "smooth";

export interface UseVirtuosoAutoScrollResult {
  virtuosoRef: RefObject<VirtuosoHandle | null>;
  showScrollToBottom: boolean;
  userPinnedScroll: boolean;
  followOutput: FollowOutput;
  setScrollerRef: (ref: HTMLElement | Window | null) => void;
  handleAtBottomStateChange: (atBottom: boolean) => void;
  handleTotalListHeightChanged: () => void;
  cancelScrollAnimation: () => void;
  scrollToBottom: (behavior?: ScrollBehavior) => void;
}

export interface UseVirtuosoAutoScrollOptions {
  autoFollow?: boolean;
}

export function useVirtuosoAutoScroll(
  itemCount: number,
  { autoFollow = true }: UseVirtuosoAutoScrollOptions = {},
): UseVirtuosoAutoScrollResult {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const atBottomRef = useRef(true);
  const userPinnedRef = useRef(false);
  const userInputActiveRef = useRef(false);
  const upwardWheelPendingRef = useRef(false);
  const scrollbarDragActiveRef = useRef(false);
  const scrollAnimationFrameRef = useRef<number | null>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [userPinnedScroll, setUserPinnedScroll] = useState(false);

  const cancelScrollAnimation = useCallback(() => {
    if (scrollAnimationFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollAnimationFrameRef.current);
      scrollAnimationFrameRef.current = null;
    }
  }, []);

  const handleWheelIntent = useCallback(
    (event: WheelIntentEvent, scrollElement: HTMLElement) => {
      if (!wheelWillScrollElement(event, scrollElement)) {
        return;
      }
      cancelScrollAnimation();
      userInputActiveRef.current = true;
      if (isUpwardWheelIntent(event)) {
        upwardWheelPendingRef.current = true;
        userPinnedRef.current = true;
        atBottomRef.current = false;
        setUserPinnedScroll(true);
      }
    },
    [cancelScrollAnimation],
  );

  const updateBottomState = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) {
      setShowScrollToBottom((current) => current ? false : current);
      return true;
    }

    const bottomGap = getBottomGap(scroller);
    const atBottom = bottomGap <= FOLLOW_BOTTOM_THRESHOLD_PX;
    atBottomRef.current = atBottom;

    setUserPinnedScroll((current) => current === userPinnedRef.current ? current : userPinnedRef.current);
    const nextShowScrollToBottom = bottomGap > AT_BOTTOM_THRESHOLD_PX;
    setShowScrollToBottom((current) => current === nextShowScrollToBottom ? current : nextShowScrollToBottom);
    return atBottom;
  }, []);

  const setScrollerRef = useCallback(
    (ref: HTMLElement | Window | null) => {
      const element = ref instanceof HTMLElement ? ref : null;
      if (scrollerRef.current === element) {
        return;
      }
      scrollerRef.current = element;
      setScroller((current) => current === element ? current : element);
      updateBottomState();
    },
    [updateBottomState],
  );

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      if (itemCount <= 0) {
        return;
      }

      cancelScrollAnimation();
      userPinnedRef.current = false;
      userInputActiveRef.current = false;
      upwardWheelPendingRef.current = false;
      scrollbarDragActiveRef.current = false;
      atBottomRef.current = true;
      setUserPinnedScroll((current) => current ? false : current);
      setShowScrollToBottom((current) => current ? false : current);

      const scrollBehavior = toVirtuosoScrollBehavior(behavior);
      const scroller = scrollerRef.current;
      if (scroller && scrollBehavior === "auto") {
        scroller.scrollTop = bottomScrollTop(scroller);
        return;
      }

      if (scroller && scrollBehavior === "smooth") {
        animateScrollToBottom({
          scroller,
          frameRef: scrollAnimationFrameRef,
          onDone: updateBottomState,
        });
        return;
      }

      virtuosoRef.current?.scrollToIndex({
        align: "end",
        behavior: scrollBehavior,
        index: itemCount - 1,
      });
    },
    [cancelScrollAnimation, itemCount, updateBottomState],
  );

  const handleAtBottomStateChange = useCallback((atBottom: boolean) => {
    atBottomRef.current = atBottom;
    setUserPinnedScroll((current) => current === userPinnedRef.current ? current : userPinnedRef.current);
    setShowScrollToBottom((current) => current === !atBottom ? current : !atBottom);
  }, []);

  const handleTotalListHeightChanged = useCallback(() => {
    if (!autoFollow) {
      updateBottomState();
      return;
    }
    if (scrollerRef.current && isExpansionScrollLocked(scrollerRef.current)) {
      updateBottomState();
      return;
    }
    if (scrollbarDragActiveRef.current) {
      updateBottomState();
      return;
    }
    if (scrollAnimationFrameRef.current !== null) {
      updateBottomState();
      return;
    }
    if (!userPinnedRef.current && atBottomRef.current) {
      scrollToBottom("auto");
      return;
    }
    updateBottomState();
  }, [autoFollow, scrollToBottom, updateBottomState]);

  const followOutput = useCallback(() => {
    // Keep the bottom spacer visible by letting handleTotalListHeightChanged
    // drive scrolling to the scroller's real bottom.
    return false;
  }, []);

  useEffect(() => {
    if (!scroller) {
      return;
    }

    const handleScroll = () => {
      const atBottom = updateBottomState();
      if (atBottom) {
        if (!upwardWheelPendingRef.current) {
          userPinnedRef.current = false;
          userInputActiveRef.current = false;
          scrollbarDragActiveRef.current = false;
          setUserPinnedScroll((current) => current ? false : current);
        }
        return;
      }
      upwardWheelPendingRef.current = false;
      if (userInputActiveRef.current) {
        userPinnedRef.current = true;
        userInputActiveRef.current = false;
        setUserPinnedScroll((current) => current ? current : true);
      }
    };
    const handleWheel = (event: WheelEvent) => {
      handleWheelIntent(event, scroller);
    };
    const handlePointerDown = (event: Event) => {
      cancelScrollAnimation();
      userInputActiveRef.current = true;
      if (isScrollbarPointerStart(event, scroller)) {
        scrollbarDragActiveRef.current = true;
      }
    };
    const clearScrollbarDrag = () => {
      scrollbarDragActiveRef.current = false;
    };

    scroller.addEventListener("scroll", handleScroll, { passive: true });
    scroller.addEventListener("wheel", handleWheel, { passive: true });
    scroller.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("pointerup", clearScrollbarDrag);
    window.addEventListener("pointercancel", clearScrollbarDrag);
    window.addEventListener("blur", clearScrollbarDrag);
    return () => {
      scroller.removeEventListener("scroll", handleScroll);
      scroller.removeEventListener("wheel", handleWheel);
      scroller.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("pointerup", clearScrollbarDrag);
      window.removeEventListener("pointercancel", clearScrollbarDrag);
      window.removeEventListener("blur", clearScrollbarDrag);
    };
  }, [cancelScrollAnimation, handleWheelIntent, scroller, updateBottomState]);

  useEffect(() => {
    if (itemCount === 0) {
      cancelScrollAnimation();
      setShowScrollToBottom((current) => current ? false : current);
      atBottomRef.current = true;
      userPinnedRef.current = false;
      userInputActiveRef.current = false;
      upwardWheelPendingRef.current = false;
      scrollbarDragActiveRef.current = false;
      setUserPinnedScroll((current) => current ? false : current);
      return;
    }

    if (autoFollow && !userPinnedRef.current && atBottomRef.current) {
      scrollToBottom("auto");
      return;
    }
    updateBottomState();
  }, [autoFollow, cancelScrollAnimation, itemCount, scrollToBottom, updateBottomState]);

  useEffect(() => {
    return () => cancelScrollAnimation();
  }, [cancelScrollAnimation]);

  return {
    virtuosoRef,
    showScrollToBottom,
    userPinnedScroll,
    followOutput,
    setScrollerRef,
    handleAtBottomStateChange,
    handleTotalListHeightChanged,
    cancelScrollAnimation,
    scrollToBottom,
  };
}

function getBottomGap(scroller: HTMLElement): number {
  return Math.max(0, bottomScrollTop(scroller) - scroller.scrollTop);
}

function bottomScrollTop(scroller: HTMLElement): number {
  return Math.max(0, scroller.scrollHeight - scroller.clientHeight);
}

function toVirtuosoScrollBehavior(behavior: ScrollBehavior): VirtuosoScrollBehavior {
  return behavior === "smooth" && !prefersReducedMotion() ? "smooth" : "auto";
}

function isExpansionScrollLocked(element: HTMLElement): boolean {
  return element.hasAttribute(EXPANSION_SCROLL_LOCK_ATTR);
}

function isScrollbarPointerStart(event: Event, scroller: HTMLElement): boolean {
  if (event.type !== "pointerdown" && event.type !== "mousedown") {
    return false;
  }
  const pointer = event as MouseEvent;
  if (!Number.isFinite(pointer.clientX) || !Number.isFinite(pointer.clientY)) {
    return false;
  }
  const scrollbarInlineSize = Math.max(0, scroller.offsetWidth - scroller.clientWidth);
  if (scrollbarInlineSize <= 0) {
    return false;
  }
  const rect = scroller.getBoundingClientRect();
  const edgeSize = Math.max(12, Math.min(24, scrollbarInlineSize));
  return pointer.clientX >= rect.right - edgeSize && pointer.clientX <= rect.right;
}

function animateScrollToBottom({
  scroller,
  frameRef,
  onDone,
}: {
  scroller: HTMLElement;
  frameRef: { current: number | null };
  onDone: () => void;
}) {
  const startTop = scroller.scrollTop;
  const initialTargetTop = bottomScrollTop(scroller);
  const distance = Math.abs(initialTargetTop - startTop);
  const duration = Math.min(420, Math.max(180, distance * 0.28));
  let startedAt: number | null = null;

  const step = (timestamp: number) => {
    startedAt ??= timestamp;
    const targetTop = bottomScrollTop(scroller);
    const elapsed = timestamp - startedAt;
    const progress = Math.min(1, Math.max(0, elapsed / duration));
    const eased = easeOutCubic(progress);
    scroller.scrollTop = startTop + (targetTop - startTop) * eased;

    if (progress < 1 && getBottomGap(scroller) > 1) {
      frameRef.current = window.requestAnimationFrame(step);
      return;
    }

    frameRef.current = null;
    scroller.scrollTop = bottomScrollTop(scroller);
    onDone();
  };

  frameRef.current = window.requestAnimationFrame(step);
}

function easeOutCubic(value: number): number {
  return 1 - Math.pow(1 - value, 3);
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
