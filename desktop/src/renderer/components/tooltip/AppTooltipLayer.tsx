import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import styles from "./AppTooltipLayer.module.css";

type TooltipPlacement = "top" | "right" | "bottom" | "left";
type TooltipTargetMode = "explicit" | "native-interactive-title";

interface TooltipState {
  label: string;
  left: number;
  top: number;
  placement: TooltipPlacement;
  multiline: boolean;
}

interface NativeTitleSnapshot {
  element: HTMLElement;
  title: string;
}

export interface AppTooltipLayerProps {
  scopeSelector: string;
  ownerId?: string;
  defaultPlacement?: TooltipPlacement;
  delayMs?: number;
  targetMode?: TooltipTargetMode;
}

const EXPLICIT_TOOLTIP_TARGET_SELECTOR = [
  "[data-tooltip-label]",
  "[data-tooltip='true']",
].join(",");
const NATIVE_INTERACTIVE_TITLE_TARGET_SELECTOR = [
  "button[title]:not([data-tooltip-label]):not([data-tooltip='true'])",
  "[role='button'][title]:not([data-tooltip-label]):not([data-tooltip='true'])",
  "a[href][title]:not([data-tooltip-label]):not([data-tooltip='true'])",
  "[role='link'][title]:not([data-tooltip-label]):not([data-tooltip='true'])",
  "input[type='button'][title]:not([data-tooltip-label]):not([data-tooltip='true'])",
  "input[type='submit'][title]:not([data-tooltip-label]):not([data-tooltip='true'])",
  "input[type='reset'][title]:not([data-tooltip-label]):not([data-tooltip='true'])",
].join(",");

const DEFAULT_DELAY_MS = 420;
const VIEWPORT_MARGIN = 8;

export function AppTooltipLayer({
  scopeSelector,
  ownerId,
  defaultPlacement = "top",
  delayMs = DEFAULT_DELAY_MS,
  targetMode = "explicit",
}: AppTooltipLayerProps) {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const targetRef = useRef<HTMLElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const showTimerRef = useRef<number | null>(null);
  const nativeTitleRef = useRef<NativeTitleSnapshot | null>(null);

  const clearShowTimer = useCallback(() => {
    if (showTimerRef.current !== null) {
      window.clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
    }
  }, []);

  const restoreNativeTitle = useCallback(() => {
    const snapshot = nativeTitleRef.current;
    if (!snapshot) {
      return;
    }
    snapshot.element.setAttribute("title", snapshot.title);
    nativeTitleRef.current = null;
  }, []);

  const hideTooltip = useCallback(() => {
    clearShowTimer();
    restoreNativeTitle();
    targetRef.current = null;
    setTooltip(null);
  }, [clearShowTimer, restoreNativeTitle]);

  const showTooltip = useCallback(
    (target: HTMLElement) => {
      const label = tooltipLabel(target, targetMode);
      if (!label) {
        hideTooltip();
        return;
      }
      if (targetRef.current === target) {
        return;
      }
      clearShowTimer();
      restoreNativeTitle();
      const nativeTitle = target.getAttribute("title");
      if (nativeTitle) {
        nativeTitleRef.current = { element: target, title: nativeTitle };
        target.removeAttribute("title");
      }
      targetRef.current = target;
      showTimerRef.current = window.setTimeout(() => {
        if (targetRef.current !== target) {
          return;
        }
        setTooltip(
          positionTooltip(
            target,
            label,
            tooltipPlacement(target, defaultPlacement),
            target.dataset.tooltipMultiline === "true",
          ),
        );
        showTimerRef.current = null;
      }, delayMs);
    },
    [clearShowTimer, defaultPlacement, delayMs, hideTooltip, restoreNativeTitle, targetMode],
  );

  useEffect(() => {
    const targetSelector =
      targetMode === "native-interactive-title"
        ? NATIVE_INTERACTIVE_TITLE_TARGET_SELECTOR
        : EXPLICIT_TOOLTIP_TARGET_SELECTOR;

    const targetFromEvent = (eventTarget: EventTarget | null): HTMLElement | null => {
      if (!(eventTarget instanceof Element)) {
        return null;
      }
      const target = eventTarget.closest(targetSelector);
      if (!(target instanceof HTMLElement)) {
        return null;
      }
      if (!target.closest(scopeSelector) || target.dataset.tooltipDisabled === "true") {
        return null;
      }
      const ownedScope = target.closest<HTMLElement>("[data-app-tooltip-owner]");
      if (ownedScope && ownedScope.dataset.appTooltipOwner !== ownerId) {
        return null;
      }
      if (!ownedScope && ownerId) {
        return null;
      }
      return target;
    };

    const handlePointerOver = (event: PointerEvent) => {
      const target = targetFromEvent(event.target);
      if (!target) {
        return;
      }
      showTooltip(target);
    };
    const handlePointerOut = (event: PointerEvent) => {
      const activeTarget = targetRef.current;
      if (!activeTarget) {
        return;
      }
      const relatedTarget = event.relatedTarget;
      if (relatedTarget instanceof Node && activeTarget.contains(relatedTarget)) {
        return;
      }
      hideTooltip();
    };
    const handleFocusIn = (event: FocusEvent) => {
      const target = targetFromEvent(event.target);
      if (target) {
        showTooltip(target);
      }
    };
    const handleFocusOut = () => hideTooltip();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        hideTooltip();
      }
    };

    document.addEventListener("pointerover", handlePointerOver, true);
    document.addEventListener("pointerout", handlePointerOut, true);
    document.addEventListener("focusin", handleFocusIn, true);
    document.addEventListener("focusout", handleFocusOut, true);
    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("scroll", hideTooltip, true);
    window.addEventListener("resize", hideTooltip);
    return () => {
      document.removeEventListener("pointerover", handlePointerOver, true);
      document.removeEventListener("pointerout", handlePointerOut, true);
      document.removeEventListener("focusin", handleFocusIn, true);
      document.removeEventListener("focusout", handleFocusOut, true);
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("scroll", hideTooltip, true);
      window.removeEventListener("resize", hideTooltip);
      hideTooltip();
    };
  }, [hideTooltip, ownerId, scopeSelector, showTooltip, targetMode]);

  useLayoutEffect(() => {
    if (!tooltip) {
      return;
    }
    const element = tooltipRef.current;
    if (!element) {
      return;
    }
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return;
    }
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    const deltaLeft =
      rect.left < VIEWPORT_MARGIN
        ? VIEWPORT_MARGIN - rect.left
        : rect.right > viewportWidth - VIEWPORT_MARGIN
          ? viewportWidth - VIEWPORT_MARGIN - rect.right
          : 0;
    const deltaTop =
      rect.top < VIEWPORT_MARGIN
        ? VIEWPORT_MARGIN - rect.top
        : rect.bottom > viewportHeight - VIEWPORT_MARGIN
          ? viewportHeight - VIEWPORT_MARGIN - rect.bottom
          : 0;

    if (Math.abs(deltaLeft) <= 0.5 && Math.abs(deltaTop) <= 0.5) {
      return;
    }

    setTooltip((current) => {
      if (!current) {
        return current;
      }
      const left = Math.round(current.left + deltaLeft);
      const top = Math.round(current.top + deltaTop);
      if (left === current.left && top === current.top) {
        return current;
      }
      return { ...current, left, top };
    });
  }, [tooltip]);

  if (!tooltip) {
    return null;
  }

  return createPortal(
    <div
      ref={tooltipRef}
      className={styles.tooltip}
      role="tooltip"
      data-multiline={tooltip.multiline ? "true" : "false"}
      data-placement={tooltip.placement}
      style={{ left: tooltip.left, top: tooltip.top }}
    >
      {tooltip.label}
    </div>,
    document.body,
  );
}

function tooltipLabel(target: HTMLElement, targetMode: TooltipTargetMode) {
  if (targetMode === "native-interactive-title") {
    return target.getAttribute("title")?.trim() || target.getAttribute("aria-label")?.trim() || "";
  }

  const explicitLabel = target.dataset.tooltipLabel?.trim();
  if (explicitLabel) {
    return explicitLabel;
  }

  const explicitTooltip = target.dataset.tooltip === "true";
  const visibleText = target.textContent?.trim();
  if (!explicitTooltip && visibleText) {
    return "";
  }

  return target.getAttribute("aria-label")?.trim() || target.getAttribute("title")?.trim() || "";
}

function tooltipPlacement(target: HTMLElement, fallback: TooltipPlacement): TooltipPlacement {
  const placement = target.dataset.tooltipPlacement;
  return placement === "top" || placement === "right" || placement === "bottom" || placement === "left"
    ? placement
    : fallback;
}

function positionTooltip(
  target: HTMLElement,
  label: string,
  placement: TooltipPlacement,
  multiline: boolean,
): TooltipState {
  const rect = target.getBoundingClientRect();
  const horizontalCenter = Math.round(rect.left + rect.width / 2);
  const verticalCenter = Math.round(rect.top + rect.height / 2);
  if (placement === "right") {
    return { label, left: Math.round(rect.right), top: verticalCenter, placement, multiline };
  }
  if (placement === "left") {
    return { label, left: Math.round(rect.left), top: verticalCenter, placement, multiline };
  }
  if (placement === "bottom") {
    return { label, left: horizontalCenter, top: Math.round(rect.bottom), placement, multiline };
  }
  return { label, left: horizontalCenter, top: Math.round(rect.top), placement, multiline };
}
