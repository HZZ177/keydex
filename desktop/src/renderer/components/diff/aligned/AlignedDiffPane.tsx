import {
  forwardRef,
  useImperativeHandle,
  useRef,
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

export interface AlignedDiffPaneProps extends Omit<HTMLAttributes<HTMLDivElement>, "children"> {
  readonly side: DiffPaneSide;
  readonly label: string;
  readonly children?: ReactNode;
  readonly scrollChaining?: KeydexDiffScrollChainingMode;
}

export const AlignedDiffPane = forwardRef<AlignedDiffPaneHandle, AlignedDiffPaneProps>(
  function AlignedDiffPane({
    side,
    label,
    children,
    scrollChaining = "contain",
    className,
    onWheel,
    ...props
  }, forwardedRef) {
    const elementRef = useRef<HTMLDivElement | null>(null);
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
        <div
          className={styles.content}
          data-keydex-aligned-pane-content=""
          role="grid"
          aria-label={`${label}代码`}
        >
          {children}
        </div>
      </div>
    );
  },
);
