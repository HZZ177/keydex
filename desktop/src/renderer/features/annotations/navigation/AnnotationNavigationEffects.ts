const NAVIGATION_SCROLL_DURATION_MS = 280;
const NAVIGATION_FLASH_ATTRIBUTE = "data-annotation-navigation-flash";

const animationEndHandlers = new WeakMap<HTMLElement, EventListener>();

export function smoothScrollElementTo(
  element: HTMLElement,
  targetTop: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(abortError());
  }
  const startTop = element.scrollTop;
  const distance = targetTop - startTop;
  if (Math.abs(distance) < 0.5) {
    setScrollTop(element, targetTop);
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    let frame = 0;
    let startedAt: number | null = null;
    const cleanup = () => {
      if (frame) {
        window.cancelAnimationFrame(frame);
      }
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(abortError());
    };
    const step = (timestamp: number) => {
      startedAt ??= timestamp;
      const progress = Math.min(1, (timestamp - startedAt) / NAVIGATION_SCROLL_DURATION_MS);
      const eased = 1 - Math.pow(1 - progress, 3);
      setScrollTop(element, startTop + distance * eased);
      if (progress < 1) {
        frame = window.requestAnimationFrame(step);
        return;
      }
      cleanup();
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    frame = window.requestAnimationFrame(step);
  });
}

export function restartAnnotationNavigationFlash(element: HTMLElement): void {
  const previousHandler = animationEndHandlers.get(element);
  if (previousHandler) {
    element.removeEventListener("animationend", previousHandler);
  }
  element.removeAttribute(NAVIGATION_FLASH_ATTRIBUTE);
  void element.offsetWidth;
  const handleAnimationEnd: EventListener = () => {
    element.removeAttribute(NAVIGATION_FLASH_ATTRIBUTE);
    animationEndHandlers.delete(element);
  };
  animationEndHandlers.set(element, handleAnimationEnd);
  element.addEventListener("animationend", handleAnimationEnd, { once: true });
  element.setAttribute(NAVIGATION_FLASH_ATTRIBUTE, "true");
}

function setScrollTop(element: HTMLElement, top: number): void {
  if (typeof element.scrollTo === "function") {
    element.scrollTo({ behavior: "auto", top });
    return;
  }
  element.scrollTop = top;
}

function abortError(): DOMException {
  return new DOMException("Annotation navigation scroll aborted", "AbortError");
}
