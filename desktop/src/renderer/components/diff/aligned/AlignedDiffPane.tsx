import {
  forwardRef,
  useImperativeHandle,
  useRef,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
} from "react";

import type { KeydexDiffScrollChainingMode } from "../profiles";
import type { DiffPaneSide } from "./alignedDiffModel";
import {
  alignedVerticalWheelDelta,
  applyAlignedDiffPaneHorizontalWheel,
  applyAlignedDiffPaneVerticalWheel,
} from "./alignedPaneScroll";
import styles from "./AlignedDiffPane.module.css";

export interface AlignedDiffPaneHandle {
  readonly element: HTMLDivElement | null;
  readonly side: DiffPaneSide;
  scrollTo(options: ScrollToOptions): void;
  position(): { readonly top: number; readonly left: number };
}

export interface AlignedDiffPaneViewport {
  readonly epoch: number;
  readonly scrollTop: number;
  readonly height: number;
  readonly scrollHeight: number;
  readonly bottomScrollSpace?: number;
  readonly contentColumns?: number;
}

export interface AlignedDiffPaneProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  readonly side: DiffPaneSide;
  readonly label: string;
  readonly children?: ReactNode;
  readonly scrollChaining?: KeydexDiffScrollChainingMode;
  readonly viewport?: AlignedDiffPaneViewport;
}

export const AlignedDiffPane = forwardRef<AlignedDiffPaneHandle, AlignedDiffPaneProps>(
  function AlignedDiffPane({
    side,
    label,
    children,
    scrollChaining = "contain",
    viewport,
    className,
    onWheel,
    ...props
  }, forwardedRef) {
    const elementRef = useRef<HTMLDivElement | null>(null);
    const controlledViewport = viewport && Number.isFinite(viewport.scrollTop)
      ? viewport
      : null;
    const bottomScrollSpace = controlledViewport
      && typeof controlledViewport.bottomScrollSpace === "number"
      && Number.isFinite(controlledViewport.bottomScrollSpace)
      ? Math.max(0, controlledViewport.bottomScrollSpace)
      : 0;
    const contentColumns = controlledViewport
      && typeof controlledViewport.contentColumns === "number"
      && Number.isFinite(controlledViewport.contentColumns)
      ? Math.max(0, controlledViewport.contentColumns)
      : 0;
    const scrollCanvasStyle = controlledViewport ? {
      blockSize: `${Math.max(
        controlledViewport.height,
        controlledViewport.scrollHeight + bottomScrollSpace,
      )}px`,
      "--keydex-aligned-pane-content-width": `${contentColumns}ch`,
    } as CSSProperties : undefined;
    const visualViewportStyle = controlledViewport && controlledViewport.height > 0 ? {
      blockSize: `${controlledViewport.height}px`,
    } as CSSProperties : undefined;
    const contentStyle = controlledViewport ? {
      transform: `translate3d(0, ${-Math.max(0, controlledViewport.scrollTop)}px, 0)`,
    } as CSSProperties : undefined;
    useImperativeHandle(forwardedRef, () => ({
      get element() { return elementRef.current; },
      side,
      scrollTo(options) { elementRef.current?.scrollTo(options); },
      position() {
        return Object.freeze({
          top: elementRef.current?.scrollTop ?? 0,
          left: elementRef.current?.scrollLeft ?? 0,
        });
      },
    }), [side]);
    return (
      <div
        {...props}
        ref={elementRef}
        className={[styles.pane, className].filter(Boolean).join(" ")}
        data-keydex-aligned-pane={side}
        data-keydex-aligned-scroll-mode={controlledViewport ? "frame" : "native"}
        data-keydex-aligned-scroll-epoch={controlledViewport?.epoch}
        data-keydex-aligned-bottom-scroll-space={bottomScrollSpace}
        data-keydex-aligned-content-columns={contentColumns}
        data-scroll-chaining={scrollChaining}
        role="region"
        aria-label={label}
        tabIndex={0}
        onWheel={(event: ReactWheelEvent<HTMLDivElement>) => {
          onWheel?.(event);
          if (event.defaultPrevented) return;
          if (applyAlignedDiffPaneHorizontalWheel(event.currentTarget, event.nativeEvent)) {
            event.preventDefault();
            return;
          }
          if (side === "old") {
            const verticalDelta = alignedVerticalWheelDelta(event.nativeEvent, event.currentTarget.clientHeight);
            const moved = applyAlignedDiffPaneVerticalWheel(event.currentTarget, event.nativeEvent);
            if (moved || (verticalDelta !== 0 && scrollChaining === "contain")) {
              event.preventDefault();
            }
          }
        }}
      >
        {controlledViewport ? (
          <div className={styles.scrollCanvas} style={scrollCanvasStyle} data-keydex-aligned-scroll-canvas="">
            <div className={styles.visualViewport} style={visualViewportStyle}>
              <div
                className={styles.content}
                style={contentStyle}
                data-keydex-aligned-pane-content=""
                data-keydex-aligned-scroll-epoch={controlledViewport.epoch}
                role="grid"
                aria-label={`${label}代码`}
              >
                {children}
              </div>
            </div>
          </div>
        ) : (
          <div
            className={styles.content}
            data-keydex-aligned-pane-content=""
            role="grid"
            aria-label={`${label}代码`}
          >
            {children}
          </div>
        )}
      </div>
    );
  },
);
