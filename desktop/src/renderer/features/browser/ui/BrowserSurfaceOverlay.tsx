import {
  useLayoutEffect,
  useRef,
  type ReactNode,
} from "react";

import type { BrowserSurfaceRef } from "../domain";
import { browserGeometryCoordinator } from "../runtime";

import styles from "./BrowserPanel.module.css";

const OCCLUSION_SELECTOR = "[data-browser-surface-occlusion='true']";

export function BrowserSurfaceOverlay({
  children,
  surface,
}: {
  readonly children: ReactNode;
  readonly surface: BrowserSurfaceRef | null;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || !surface) return;
    let frame: number | null = null;
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => schedule());

    const measure = () => {
      frame = null;
      const elements = Array.from(root.querySelectorAll<HTMLElement>(OCCLUSION_SELECTOR));
      resizeObserver?.disconnect();
      for (const element of elements) resizeObserver?.observe(element);
      browserGeometryCoordinator.setOcclusionElements(surface, elements);
    };
    const schedule = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(measure);
    };
    const mutationObserver = typeof MutationObserver === "undefined"
      ? null
      : new MutationObserver(schedule);
    mutationObserver?.observe(root, {
      attributes: true,
      attributeFilter: ["class", "data-open", "hidden", "style"],
      childList: true,
      subtree: true,
    });
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    schedule();

    return () => {
      mutationObserver?.disconnect();
      resizeObserver?.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      if (frame !== null) window.cancelAnimationFrame(frame);
      browserGeometryCoordinator.setOcclusionElements(surface, []);
    };
  }, [surface?.generation, surface?.panelId, surface?.surfaceId]);

  return (
    <div
      ref={rootRef}
      className={styles.surfaceOverlay}
      data-browser-surface-overlay="true"
    >
      {children}
    </div>
  );
}
