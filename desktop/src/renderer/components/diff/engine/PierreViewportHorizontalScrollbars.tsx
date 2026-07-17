import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";

import styles from "./PierreViewportHorizontalScrollbars.module.css";

export interface PierreHorizontalPane {
  readonly target: HTMLElement;
  readonly left: number;
  readonly width: number;
  readonly proxyContentWidth: number;
}

interface PierreGutterGuide {
  readonly target: HTMLElement;
  readonly left: number;
}

export interface PierreViewportHorizontalScrollbarsProps {
  readonly viewportRef: RefObject<HTMLDivElement | null>;
  readonly sourceKey: string;
  readonly scrollbars?: boolean;
}

const HIDDEN_SCROLLBAR_STYLE = `
[data-code] {
  scrollbar-width: none !important;
}
[data-code]::-webkit-scrollbar {
  height: 0 !important;
}
`;

export function PierreViewportHorizontalScrollbars({
  viewportRef,
  sourceKey,
  scrollbars = true,
}: PierreViewportHorizontalScrollbarsProps) {
  const [panes, setPanes] = useState<readonly PierreHorizontalPane[]>([]);
  const [gutterGuides, setGutterGuides] = useState<readonly PierreGutterGuide[]>([]);
  const proxyRefs = useRef<Array<HTMLDivElement | null>>([]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    let disposed = false;
    let animationFrame: number | null = null;
    let discoveryTimer: number | null = null;
    const observedShadowRoots = new Map<ShadowRoot, MutationObserver>();
    const injectedStyles = new Map<ShadowRoot, HTMLStyleElement>();
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => scheduleMeasure());

    const scheduleMeasure = () => {
      if (disposed || animationFrame !== null) return;
      animationFrame = requestAnimationFrame(() => {
        animationFrame = null;
        measure();
      });
    };

    const observeShadowRoot = (shadowRoot: ShadowRoot) => {
      if (observedShadowRoots.has(shadowRoot)) return;
      const observer = new MutationObserver(scheduleMeasure);
      observer.observe(shadowRoot, { childList: true, subtree: true, attributes: true });
      observedShadowRoots.set(shadowRoot, observer);
    };

    const measure = () => {
      if (disposed) return;
      const shadowRoots = collectOpenShadowRoots(viewport);
      shadowRoots.forEach(observeShadowRoot);
      const viewportRect = viewport.getBoundingClientRect();
      const targets = shadowRoots
        .flatMap((shadowRoot) => Array.from(shadowRoot.querySelectorAll<HTMLElement>("[data-code]")))
        .sort((left, right) => left.getBoundingClientRect().left - right.getBoundingClientRect().left);
      if (targets.length > 0 && discoveryTimer !== null) {
        window.clearInterval(discoveryTimer);
        discoveryTimer = null;
      }
      resizeObserver?.disconnect();
      resizeObserver?.observe(viewport);
      const nextGuides = targets.flatMap((target) => {
        resizeObserver?.observe(target);
        const gutter = target.querySelector<HTMLElement>(":scope > [data-gutter]");
        if (!gutter) return [];
        resizeObserver?.observe(gutter);
        const gutterRect = gutter.getBoundingClientRect();
        if (gutterRect.width <= 0) return [];
        return [{
          target,
          left: Math.max(0, Math.min(viewportRect.width, gutterRect.right - viewportRect.left)),
        } satisfies PierreGutterGuide];
      });
      const next = scrollbars ? targets.flatMap((target) => {
        const rect = target.getBoundingClientRect();
        if (target.scrollWidth <= target.clientWidth + 1 || rect.width <= 0) return [];
        return [{
          target,
          left: Math.max(0, rect.left - viewportRect.left),
          width: Math.min(viewportRect.width, rect.width),
          proxyContentWidth: rect.width + target.scrollWidth - target.clientWidth,
        } satisfies PierreHorizontalPane];
      }) : [];
      const activeRoots = new Set(next.map((pane) => pane.target.getRootNode()).filter(
        (root): root is ShadowRoot => root instanceof ShadowRoot,
      ));
      for (const root of activeRoots) {
        if (injectedStyles.has(root)) continue;
        const style = document.createElement("style");
        style.dataset.keydexViewportScrollbar = "true";
        style.textContent = HIDDEN_SCROLLBAR_STYLE;
        root.append(style);
        injectedStyles.set(root, style);
      }
      for (const [root, style] of injectedStyles) {
        if (activeRoots.has(root)) continue;
        style.remove();
        injectedStyles.delete(root);
      }
      setPanes((current) => samePanes(current, next) ? current : next);
      setGutterGuides((current) => sameGutterGuides(current, nextGuides) ? current : nextGuides);
    };

    const lightDomObserver = new MutationObserver(scheduleMeasure);
    lightDomObserver.observe(viewport, { childList: true, subtree: true });
    resizeObserver?.observe(viewport);
    discoveryTimer = window.setInterval(scheduleMeasure, 100);
    measure();

    return () => {
      disposed = true;
      lightDomObserver.disconnect();
      resizeObserver?.disconnect();
      observedShadowRoots.forEach((observer) => observer.disconnect());
      injectedStyles.forEach((style) => style.remove());
      if (animationFrame !== null) cancelAnimationFrame(animationFrame);
      if (discoveryTimer !== null) window.clearInterval(discoveryTimer);
    };
  }, [scrollbars, sourceKey, viewportRef]);

  useEffect(() => {
    const cleanups = panes.map((pane, index) => {
      const syncProxy = () => {
        const proxy = proxyRefs.current[index];
        if (proxy && proxy.scrollLeft !== pane.target.scrollLeft) {
          proxy.scrollLeft = pane.target.scrollLeft;
        }
      };
      syncProxy();
      pane.target.addEventListener("scroll", syncProxy, { passive: true });
      return () => pane.target.removeEventListener("scroll", syncProxy);
    });
    return () => cleanups.forEach((cleanup) => cleanup());
  }, [panes]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || panes.length === 0) return;
    const onWheel = (event: WheelEvent) => {
      const viewportLeft = viewport.getBoundingClientRect().left;
      if (applyPierreViewportHorizontalWheel(panes, event, viewportLeft)) {
        event.preventDefault();
      }
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, [panes, viewportRef]);

  if (panes.length === 0 && gutterGuides.length === 0) return null;

  return (
    <>
      {gutterGuides.length > 0 ? (
        <div className={styles.gutterGuides} aria-hidden="true">
          {gutterGuides.map((guide, index) => (
            <span
              key={`${index}:${guide.left}`}
              className={styles.gutterGuide}
              style={{ "--gutter-guide-left": `${guide.left}px` } as CSSProperties}
            />
          ))}
        </div>
      ) : null}
      {panes.length > 0 ? (
        <div className={styles.overlay} data-keydex-diff-viewport-scrollbars="true">
          {panes.map((pane, index) => (
            <div
              key={`${index}:${pane.left}:${pane.width}`}
              ref={(node) => { proxyRefs.current[index] = node; }}
              className={styles.scroller}
              style={{
                "--scrollbar-left": `${pane.left}px`,
                "--scrollbar-width": `${pane.width}px`,
              } as CSSProperties}
              onScroll={(event) => {
                if (pane.target.scrollLeft !== event.currentTarget.scrollLeft) {
                  pane.target.scrollLeft = event.currentTarget.scrollLeft;
                }
              }}
            >
              <div className={styles.spacer} style={{ width: `${pane.proxyContentWidth}px` }} />
            </div>
          ))}
        </div>
      ) : null}
    </>
  );
}

function collectOpenShadowRoots(root: ParentNode): ShadowRoot[] {
  const result: ShadowRoot[] = [];
  const visit = (parent: ParentNode) => {
    const elements = parent instanceof Element
      ? [parent, ...Array.from(parent.querySelectorAll<HTMLElement>("*"))]
      : Array.from(parent.querySelectorAll<HTMLElement>("*"));
    for (const element of elements) {
      if (!element.shadowRoot || result.includes(element.shadowRoot)) continue;
      result.push(element.shadowRoot);
      visit(element.shadowRoot);
    }
  };
  visit(root);
  return result;
}

function samePanes(
  current: readonly PierreHorizontalPane[],
  next: readonly PierreHorizontalPane[],
): boolean {
  return current.length === next.length && current.every((pane, index) => {
    const candidate = next[index];
    return candidate?.target === pane.target
      && candidate.left === pane.left
      && candidate.width === pane.width
      && candidate.proxyContentWidth === pane.proxyContentWidth;
  });
}

function sameGutterGuides(
  current: readonly PierreGutterGuide[],
  next: readonly PierreGutterGuide[],
): boolean {
  return current.length === next.length && current.every((guide, index) => {
    const candidate = next[index];
    return candidate?.target === guide.target && candidate.left === guide.left;
  });
}

export function applyPierreViewportHorizontalWheel(
  panes: readonly PierreHorizontalPane[],
  event: Pick<WheelEvent, "clientX" | "deltaMode" | "deltaX" | "deltaY" | "shiftKey" | "composedPath">,
  viewportLeft = 0,
): boolean {
  if (panes.length === 0 || panes.some((pane) => event.composedPath().includes(pane.target))) {
    return false;
  }
  const delta = horizontalWheelDelta(event, panes[0]?.target.clientWidth ?? 0);
  if (delta === 0) return false;
  const pointerX = event.clientX - viewportLeft;
  const pane = panes.find((candidate) => (
    pointerX >= candidate.left && pointerX <= candidate.left + candidate.width
  )) ?? closestHorizontalPane(panes, pointerX);
  if (!pane) return false;
  const maximum = Math.max(0, pane.target.scrollWidth - pane.target.clientWidth);
  const next = Math.max(0, Math.min(maximum, pane.target.scrollLeft + delta));
  if (next === pane.target.scrollLeft) return false;
  pane.target.scrollLeft = next;
  pane.target.dispatchEvent(new Event("scroll"));
  return true;
}

function horizontalWheelDelta(
  event: Pick<WheelEvent, "deltaMode" | "deltaX" | "deltaY" | "shiftKey">,
  pageWidth: number,
): number {
  const raw = event.shiftKey
    ? event.deltaY || event.deltaX
    : Math.abs(event.deltaX) >= Math.abs(event.deltaY)
      ? event.deltaX
      : 0;
  if (raw === 0) return 0;
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return raw * 16;
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return raw * Math.max(1, pageWidth);
  return raw;
}

function closestHorizontalPane(
  panes: readonly PierreHorizontalPane[],
  pointerX: number,
): PierreHorizontalPane | null {
  return panes.reduce<PierreHorizontalPane | null>((closest, pane) => {
    if (!closest) return pane;
    const paneCenter = pane.left + pane.width / 2;
    const closestCenter = closest.left + closest.width / 2;
    return Math.abs(pointerX - paneCenter) < Math.abs(pointerX - closestCenter) ? pane : closest;
  }, null);
}
