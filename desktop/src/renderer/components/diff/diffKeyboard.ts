import {
  useEffect,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { CodeViewScrollBehavior } from "@pierre/diffs";

export const KEYDEX_DIFF_FOCUS_TARGET = "[data-keydex-diff-focus-target='true']";

export interface KeydexDiffKeyboardScopeOptions {
  readonly onClearSelection?: () => void;
}

export function handleKeydexDiffKeyDown(
  event: ReactKeyboardEvent<HTMLElement>,
  { onClearSelection }: KeydexDiffKeyboardScopeOptions = {},
): boolean {
  if (event.defaultPrevented || hasApplicationModifier(event) || isEditableTarget(event.target)) {
    return false;
  }
  if (event.key === "Escape" && onClearSelection) {
    event.preventDefault();
    event.stopPropagation();
    onClearSelection();
    return true;
  }
  const target = event.target instanceof Element
    ? event.target.closest<HTMLElement>(KEYDEX_DIFF_FOCUS_TARGET)
    : null;
  if (!target || !event.currentTarget.contains(target)) return false;

  if ((event.key === "Enter" || event.key === " ") && !isNativeInteractive(target)) {
    event.preventDefault();
    target.click();
    return true;
  }
  const targets = keydexDiffFocusTargets(event.currentTarget);
  const currentIndex = targets.indexOf(target);
  if (currentIndex < 0) return false;
  let nextIndex: number | null = null;
  if (event.key === "ArrowDown" || event.key === "ArrowRight") {
    nextIndex = Math.min(targets.length - 1, currentIndex + 1);
  }
  if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
    nextIndex = Math.max(0, currentIndex - 1);
  }
  if (event.key === "Home") nextIndex = 0;
  if (event.key === "End") nextIndex = targets.length - 1;
  if (nextIndex === null || nextIndex === currentIndex) return false;
  event.preventDefault();
  targets[nextIndex]?.focus({ preventScroll: true });
  return true;
}

export function keydexDiffFocusTargets(scope: HTMLElement): HTMLElement[] {
  return Array.from(scope.querySelectorAll<HTMLElement>(KEYDEX_DIFF_FOCUS_TARGET)).filter(
    (target) => !target.hidden
      && target.getAttribute("aria-disabled") !== "true"
      && !(target instanceof HTMLButtonElement && target.disabled),
  );
}

export function createKeydexDiffFocusReturn(
  target: HTMLElement | null = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null,
): () => boolean {
  return () => {
    if (!target?.isConnected) return false;
    target.focus({ preventScroll: true });
    return document.activeElement === target;
  };
}

export function keydexDiffScrollBehavior(
  requested: CodeViewScrollBehavior,
  reducedMotion: boolean,
): CodeViewScrollBehavior {
  return reducedMotion ? "instant" : requested;
}

export function useKeydexDiffReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => prefersReducedMotion());
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);
  return reduced;
}

export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function hasApplicationModifier(event: ReactKeyboardEvent<HTMLElement>): boolean {
  return event.altKey || event.ctrlKey || event.metaKey;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest("input, textarea, select, [contenteditable='true'], [role='textbox']"));
}

function isNativeInteractive(target: HTMLElement): boolean {
  return target.matches("button, a[href], input, select, textarea, summary");
}
