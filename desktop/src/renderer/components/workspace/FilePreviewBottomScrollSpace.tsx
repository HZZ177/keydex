import { useLayoutEffect, useRef } from "react";

import styles from "./FilePreview.module.css";

const FILE_PREVIEW_BOTTOM_SCROLL_SPACE_FRACTION = 0.3;

export function filePreviewBottomScrollSpace(
  contentHeight: number,
  viewportHeight: number,
): number {
  if (!Number.isFinite(contentHeight) || !Number.isFinite(viewportHeight)) return 0;
  if (viewportHeight <= 0 || contentHeight <= viewportHeight + 1) return 0;
  return Math.round(viewportHeight * FILE_PREVIEW_BOTTOM_SCROLL_SPACE_FRACTION);
}

export function FilePreviewBottomScrollSpace({
  scrollElement,
}: {
  scrollElement: HTMLElement | null;
}) {
  const spacerRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const spacer = spacerRef.current;
    if (!spacer) return;
    if (!scrollElement) {
      spacer.style.height = "0px";
      spacer.dataset.filePreviewBottomScrollSpaceHeight = "0";
      return;
    }

    let frame: number | null = null;
    let currentSpace = Number.parseFloat(spacer.dataset.filePreviewBottomScrollSpaceHeight ?? "0") || 0;
    const update = () => {
      frame = null;
      const contentHeight = Math.max(0, scrollElement.scrollHeight - currentSpace);
      const nextSpace = filePreviewBottomScrollSpace(contentHeight, scrollElement.clientHeight);
      if (nextSpace === currentSpace) return;
      currentSpace = nextSpace;
      spacer.style.height = `${nextSpace}px`;
      spacer.dataset.filePreviewBottomScrollSpaceHeight = String(nextSpace);
    };
    const schedule = () => {
      if (frame !== null) return;
      frame = window.requestAnimationFrame(update);
    };

    update();
    const parent = spacer.parentElement;
    const content = spacer.previousElementSibling;
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    resizeObserver?.observe(scrollElement);
    if (parent) resizeObserver?.observe(parent);
    if (content) resizeObserver?.observe(content);

    return () => {
      resizeObserver?.disconnect();
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [scrollElement]);

  return (
    <div
      aria-hidden="true"
      className={styles.bottomScrollSpace}
      data-file-preview-bottom-scroll-space="true"
      data-file-preview-bottom-scroll-space-height="0"
      ref={spacerRef}
    />
  );
}
