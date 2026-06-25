import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { FollowOutput, VirtuosoHandle } from "react-virtuoso";

import { EXPANSION_SCROLL_LOCK_ATTR } from "./useExpansionScrollAnchor";

const AT_BOTTOM_THRESHOLD_PX = 100;
const FOLLOW_BOTTOM_THRESHOLD_PX = 4;
type VirtuosoScrollBehavior = "auto" | "smooth";

export interface UseVirtuosoAutoScrollResult {
  virtuosoRef: RefObject<VirtuosoHandle | null>;
  showScrollToBottom: boolean;
  followOutput: FollowOutput;
  setScrollerRef: (ref: HTMLElement | Window | null) => void;
  handleAtBottomStateChange: (atBottom: boolean) => void;
  handleTotalListHeightChanged: () => void;
  scrollToBottom: (behavior?: ScrollBehavior) => void;
}

export function useVirtuosoAutoScroll(itemCount: number): UseVirtuosoAutoScrollResult {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const atBottomRef = useRef(true);
  const userPinnedRef = useRef(false);
  const userInputActiveRef = useRef(false);
  const scrollAnimationFrameRef = useRef<number | null>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);

  const cancelScrollAnimation = useCallback(() => {
    if (scrollAnimationFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollAnimationFrameRef.current);
      scrollAnimationFrameRef.current = null;
    }
  }, []);

  const updateBottomState = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) {
      setShowScrollToBottom(false);
      return true;
    }

    const bottomGap = getBottomGap(scroller);
    const atBottom = bottomGap <= FOLLOW_BOTTOM_THRESHOLD_PX;
    atBottomRef.current = atBottom;

    if (atBottom) {
      userPinnedRef.current = false;
      userInputActiveRef.current = false;
    } else if (userInputActiveRef.current) {
      userPinnedRef.current = true;
    }

    setShowScrollToBottom(bottomGap > AT_BOTTOM_THRESHOLD_PX);
    return atBottom;
  }, []);

  const setScrollerRef = useCallback(
    (ref: HTMLElement | Window | null) => {
      const element = ref instanceof HTMLElement ? ref : null;
      scrollerRef.current = element;
      setScroller(element);
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
      atBottomRef.current = true;
      setShowScrollToBottom(false);

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
    if (atBottom) {
      userPinnedRef.current = false;
      userInputActiveRef.current = false;
    }
    setShowScrollToBottom(!atBottom);
  }, []);

  const handleTotalListHeightChanged = useCallback(() => {
    if (scrollerRef.current && isExpansionScrollLocked(scrollerRef.current)) {
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
  }, [scrollToBottom, updateBottomState]);

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
      updateBottomState();
    };
    const handleUserInput = () => {
      cancelScrollAnimation();
      userInputActiveRef.current = true;
    };

    scroller.addEventListener("scroll", handleScroll, { passive: true });
    scroller.addEventListener("wheel", handleUserInput, { passive: true });
    scroller.addEventListener("pointerdown", handleUserInput);
    return () => {
      scroller.removeEventListener("scroll", handleScroll);
      scroller.removeEventListener("wheel", handleUserInput);
      scroller.removeEventListener("pointerdown", handleUserInput);
    };
  }, [cancelScrollAnimation, scroller, updateBottomState]);

  useEffect(() => {
    if (itemCount === 0) {
      cancelScrollAnimation();
      setShowScrollToBottom(false);
      atBottomRef.current = true;
      userPinnedRef.current = false;
      userInputActiveRef.current = false;
      return;
    }

    if (!userPinnedRef.current && atBottomRef.current) {
      scrollToBottom("auto");
    }
  }, [cancelScrollAnimation, itemCount, scrollToBottom]);

  useEffect(() => {
    return () => cancelScrollAnimation();
  }, [cancelScrollAnimation]);

  return {
    virtuosoRef,
    showScrollToBottom,
    followOutput,
    setScrollerRef,
    handleAtBottomStateChange,
    handleTotalListHeightChanged,
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
