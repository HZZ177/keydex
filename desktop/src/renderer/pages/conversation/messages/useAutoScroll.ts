import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
  type UIEvent,
  type WheelEvent,
} from "react";

import { EXPANSION_SCROLL_LOCK_ATTR } from "./useExpansionScrollAnchor";

const PROGRAMMATIC_SCROLL_GUARD_MS = 150;
const AT_BOTTOM_THRESHOLD_PX = 100;
const FOLLOW_BOTTOM_THRESHOLD_PX = 4;

export interface UseAutoScrollOptions {
  deps: readonly unknown[];
  itemCount?: number;
  autoFollow?: boolean;
}

export interface UseAutoScrollResult {
  containerRef: RefObject<HTMLDivElement | null>;
  contentRef: RefObject<HTMLDivElement | null>;
  showScrollToBottom: boolean;
  userPinnedScroll: boolean;
  handleScroll: (event: UIEvent<HTMLDivElement>) => void;
  handleWheel: (event: WheelEvent<HTMLDivElement>) => void;
  handlePointerDown: () => void;
  cancelScrollAnimation: () => void;
  scrollToBottom: (behavior?: ScrollBehavior) => void;
}

export function useAutoScroll({ deps, itemCount = 0, autoFollow = true }: UseAutoScrollOptions): UseAutoScrollResult {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const [userPinnedScroll, setUserPinnedScroll] = useState(false);

  const scrollElementRef = useRef<HTMLElement | null>(null);
  const userPinnedRef = useRef(false);
  const userInputActiveRef = useRef(false);
  const scrollbarDragActiveRef = useRef(false);
  const lastScrollTopRef = useRef(0);
  const lastProgrammaticScrollAtRef = useRef(0);
  const initialScrollDoneRef = useRef(false);
  const frameRef = useRef<number | null>(null);
  const scrollAnimationFrameRef = useRef<number | null>(null);

  const markProgrammaticScroll = useCallback(() => {
    lastProgrammaticScrollAtRef.current = Date.now();
  }, []);

  const cancelScrollAnimation = useCallback(() => {
    if (scrollAnimationFrameRef.current !== null) {
      window.cancelAnimationFrame(scrollAnimationFrameRef.current);
      scrollAnimationFrameRef.current = null;
    }
  }, []);

  const resolveScrollElement = useCallback(() => {
    const container = containerRef.current;
    if (!container) {
      scrollElementRef.current = null;
      return null;
    }
    const scrollElement = findScrollParent(container) ?? container;
    scrollElementRef.current = scrollElement;
    return scrollElement;
  }, []);

  const getScrollElement = useCallback(() => scrollElementRef.current ?? resolveScrollElement(), [resolveScrollElement]);

  const updateBottomState = useCallback((scrollElement: HTMLElement) => {
    const bottomGap = getBottomGap(scrollElement);
    const atFollowBottom = bottomGap <= FOLLOW_BOTTOM_THRESHOLD_PX;

    if (atFollowBottom) {
      userPinnedRef.current = false;
      userInputActiveRef.current = false;
      scrollbarDragActiveRef.current = false;
    }

    setUserPinnedScroll(userPinnedRef.current);
    setShowScrollToBottom(bottomGap > AT_BOTTOM_THRESHOLD_PX);
    return atFollowBottom;
  }, []);

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      const scrollElement = getScrollElement();
      if (!scrollElement || itemCount <= 0) {
        return;
      }

      cancelScrollAnimation();
      markProgrammaticScroll();
      userPinnedRef.current = false;
      userInputActiveRef.current = false;
      scrollbarDragActiveRef.current = false;
      setUserPinnedScroll(false);
      setShowScrollToBottom(false);

      if (behavior === "smooth" && !prefersReducedMotion()) {
        animateScrollToBottom({
          scrollElement,
          frameRef: scrollAnimationFrameRef,
          markProgrammaticScroll,
          onFrame: (top) => {
            lastScrollTopRef.current = top;
          },
          onDone: () => {
            const top = bottomScrollTop(scrollElement);
            scrollElement.scrollTop = top;
            lastScrollTopRef.current = top;
            updateBottomState(scrollElement);
          },
        });
        return;
      }

      const top = bottomScrollTop(scrollElement);
      scrollElement.scrollTop = top;
      lastScrollTopRef.current = top;
      updateBottomState(scrollElement);
    },
    [cancelScrollAnimation, getScrollElement, itemCount, markProgrammaticScroll, updateBottomState],
  );

  const scheduleAutoFollow = useCallback(() => {
    if (!autoFollow) {
      return;
    }
    const scrollElement = getScrollElement();
    if (!scrollElement || userPinnedRef.current || scrollbarDragActiveRef.current || isExpansionScrollLocked(scrollElement)) {
      return;
    }
    if (scrollAnimationFrameRef.current !== null) {
      updateBottomState(scrollElement);
      return;
    }
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current);
    }

    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      const nextScrollElement = getScrollElement();
      if (
        !nextScrollElement ||
        userPinnedRef.current ||
        scrollbarDragActiveRef.current ||
        isExpansionScrollLocked(nextScrollElement)
      ) {
        return;
      }
      if (scrollAnimationFrameRef.current !== null) {
        updateBottomState(nextScrollElement);
        return;
      }
      if (getBottomGap(nextScrollElement) > FOLLOW_BOTTOM_THRESHOLD_PX) {
        scrollToBottom("auto");
      } else {
        updateBottomState(nextScrollElement);
      }
    });
  }, [autoFollow, getScrollElement, scrollToBottom, updateBottomState]);

  const handleTargetScroll = useCallback(
    (scrollElement: HTMLElement) => {
      scrollElementRef.current = scrollElement;
      const currentScrollTop = scrollElement.scrollTop;
      const delta = currentScrollTop - lastScrollTopRef.current;
      const bottomGap = getBottomGap(scrollElement);
      const atFollowBottom = bottomGap <= FOLLOW_BOTTOM_THRESHOLD_PX;
      const programmaticGuardElapsed =
        Date.now() - lastProgrammaticScrollAtRef.current >= PROGRAMMATIC_SCROLL_GUARD_MS;

      if (
        !atFollowBottom &&
        Math.abs(delta) > 2 &&
        userInputActiveRef.current &&
        programmaticGuardElapsed
      ) {
        userPinnedRef.current = true;
      }

      if (atFollowBottom) {
        userPinnedRef.current = false;
        userInputActiveRef.current = false;
      } else if (Math.abs(delta) > 2) {
        userInputActiveRef.current = false;
      }

      lastScrollTopRef.current = currentScrollTop;
      updateBottomState(scrollElement);
    },
    [updateBottomState],
  );

  const handleScroll = useCallback(
    (event: UIEvent<HTMLDivElement>) => {
      handleTargetScroll(event.currentTarget);
    },
    [handleTargetScroll],
  );

  const handleWheel = useCallback((event: WheelEvent<HTMLDivElement>) => {
    if (Math.abs(event.deltaY) > 0 || Math.abs(event.deltaX) > 0) {
      cancelScrollAnimation();
      userInputActiveRef.current = true;
    }
  }, [cancelScrollAnimation]);

  const handlePointerDown = useCallback(() => {
    cancelScrollAnimation();
    userInputActiveRef.current = true;
  }, [cancelScrollAnimation]);

  useLayoutEffect(() => {
    const scrollElement = getScrollElement();
    if (!scrollElement || initialScrollDoneRef.current || itemCount === 0) {
      return;
    }

    initialScrollDoneRef.current = true;
    if (!autoFollow) {
      updateBottomState(scrollElement);
      return;
    }

    scrollToBottom("auto");
    lastProgrammaticScrollAtRef.current = 0;
    lastScrollTopRef.current = scrollElement.scrollTop;
    window.requestAnimationFrame(() => {
      if (userPinnedRef.current) {
        return;
      }
      scrollToBottom("auto");
      lastProgrammaticScrollAtRef.current = 0;
      lastScrollTopRef.current = scrollElement.scrollTop;
    });
  }, [autoFollow, getScrollElement, itemCount, scrollToBottom, updateBottomState]);

  useLayoutEffect(() => {
    const scrollElement = getScrollElement();
    if (!scrollElement) {
      return;
    }
    scheduleAutoFollow();
    updateBottomState(scrollElement);
  }, [...deps, getScrollElement, scheduleAutoFollow, updateBottomState]);

  useEffect(() => {
    const scrollElement = resolveScrollElement();
    if (!scrollElement) {
      return;
    }

    const onScroll = () => handleTargetScroll(scrollElement);
    const onUserInput = (event: Event) => {
      cancelScrollAnimation();
      userInputActiveRef.current = true;
      if (isScrollbarPointerStart(event, scrollElement)) {
        scrollbarDragActiveRef.current = true;
      }
    };
    const clearScrollbarDrag = () => {
      scrollbarDragActiveRef.current = false;
    };
    scrollElement.addEventListener("scroll", onScroll, { passive: true });
    scrollElement.addEventListener("wheel", onUserInput, { passive: true });
    scrollElement.addEventListener("pointerdown", onUserInput);
    window.addEventListener("pointerup", clearScrollbarDrag);
    window.addEventListener("pointercancel", clearScrollbarDrag);
    window.addEventListener("blur", clearScrollbarDrag);
    updateBottomState(scrollElement);
    return () => {
      scrollElement.removeEventListener("scroll", onScroll);
      scrollElement.removeEventListener("wheel", onUserInput);
      scrollElement.removeEventListener("pointerdown", onUserInput);
      window.removeEventListener("pointerup", clearScrollbarDrag);
      window.removeEventListener("pointercancel", clearScrollbarDrag);
      window.removeEventListener("blur", clearScrollbarDrag);
    };
  }, [cancelScrollAnimation, handleTargetScroll, resolveScrollElement, updateBottomState]);

  useEffect(() => {
    const scrollElement = getScrollElement();
    const content = contentRef.current;
    if (!scrollElement || !content || typeof ResizeObserver === "undefined") {
      return;
    }

    const resizeObserver = new ResizeObserver(() => {
      scheduleAutoFollow();
      updateBottomState(scrollElement);
    });
    resizeObserver.observe(scrollElement);
    resizeObserver.observe(content);
    return () => resizeObserver.disconnect();
  }, [getScrollElement, scheduleAutoFollow, updateBottomState]);

  useEffect(() => {
    const scrollElement = getScrollElement();
    const content = contentRef.current;
    if (!scrollElement || !content || typeof MutationObserver === "undefined") {
      return;
    }

    const mutationObserver = new MutationObserver(() => {
      scheduleAutoFollow();
      updateBottomState(scrollElement);
    });
    mutationObserver.observe(content, { childList: true, characterData: true, subtree: true });
    return () => mutationObserver.disconnect();
  }, [getScrollElement, scheduleAutoFollow, updateBottomState]);

  useEffect(() => {
    return () => {
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
      }
      cancelScrollAnimation();
    };
  }, [cancelScrollAnimation]);

  return {
    containerRef,
    contentRef,
    showScrollToBottom,
    userPinnedScroll,
    handleScroll,
    handleWheel,
    handlePointerDown,
    cancelScrollAnimation,
    scrollToBottom,
  };
}

function getBottomGap(container: HTMLElement): number {
  return Math.max(0, bottomScrollTop(container) - container.scrollTop);
}

function bottomScrollTop(container: HTMLElement): number {
  return Math.max(0, container.scrollHeight - container.clientHeight);
}

function findScrollParent(element: HTMLElement): HTMLElement | null {
  let parent = element.parentElement;
  while (parent) {
    const overflowY = window.getComputedStyle(parent).overflowY;
    if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") {
      return parent;
    }
    parent = parent.parentElement;
  }
  return null;
}

function isExpansionScrollLocked(element: HTMLElement): boolean {
  return element.hasAttribute(EXPANSION_SCROLL_LOCK_ATTR);
}

function isScrollbarPointerStart(event: Event, scrollElement: HTMLElement): boolean {
  if (event.type !== "pointerdown" && event.type !== "mousedown") {
    return false;
  }
  const pointer = event as MouseEvent;
  if (!Number.isFinite(pointer.clientX) || !Number.isFinite(pointer.clientY)) {
    return false;
  }
  const scrollbarInlineSize = Math.max(0, scrollElement.offsetWidth - scrollElement.clientWidth);
  if (scrollbarInlineSize <= 0) {
    return false;
  }
  const rect = scrollElement.getBoundingClientRect();
  const edgeSize = Math.max(12, Math.min(24, scrollbarInlineSize));
  return pointer.clientX >= rect.right - edgeSize && pointer.clientX <= rect.right;
}

function animateScrollToBottom({
  scrollElement,
  frameRef,
  markProgrammaticScroll,
  onFrame,
  onDone,
}: {
  scrollElement: HTMLElement;
  frameRef: { current: number | null };
  markProgrammaticScroll: () => void;
  onFrame: (top: number) => void;
  onDone: () => void;
}) {
  const startTop = scrollElement.scrollTop;
  const initialTargetTop = bottomScrollTop(scrollElement);
  const distance = Math.abs(initialTargetTop - startTop);
  const duration = Math.min(420, Math.max(180, distance * 0.28));
  let startedAt: number | null = null;

  const step = (timestamp: number) => {
    startedAt ??= timestamp;
    markProgrammaticScroll();
    const targetTop = bottomScrollTop(scrollElement);
    const elapsed = timestamp - startedAt;
    const progress = Math.min(1, Math.max(0, elapsed / duration));
    const eased = easeOutCubic(progress);
    const nextTop = startTop + (targetTop - startTop) * eased;

    scrollElement.scrollTop = nextTop;
    onFrame(nextTop);

    if (progress < 1 && getBottomGap(scrollElement) > 1) {
      frameRef.current = window.requestAnimationFrame(step);
      return;
    }

    frameRef.current = null;
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
