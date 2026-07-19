import { type CSSProperties, type ReactNode, type Ref, useId } from "react";

import {
  AlignedDiffPane,
  type AlignedDiffPaneHandle,
} from "./AlignedDiffPane";
import type { KeydexDiffScrollChainingMode } from "../profiles";
import styles from "./KeydexAlignedSplitDiff.module.css";

export interface KeydexAlignedSplitDiffProps {
  readonly left: ReactNode;
  readonly right: ReactNode;
  readonly connector?: ReactNode;
  readonly connectorOverlay?: ReactNode;
  readonly connectorRef?: Ref<HTMLDivElement>;
  readonly connectorViewportHeight?: number;
  readonly leftGutter?: ReactNode;
  readonly rightGutter?: ReactNode;
  readonly leftGutterScrollTop?: number;
  readonly rightGutterScrollTop?: number;
  readonly lineNumberDigits?: number;
  readonly edgeWidth?: number;
  readonly leftPaneRef?: Ref<AlignedDiffPaneHandle>;
  readonly rightPaneRef?: Ref<AlignedDiffPaneHandle>;
  readonly leftLabel?: string;
  readonly rightLabel?: string;
  readonly minHeight?: number;
  readonly className?: string;
  readonly scrollChaining?: KeydexDiffScrollChainingMode;
  readonly syncScroll?: boolean;
  readonly activeChangeIndex?: number | null;
  readonly changeCount?: number;
  readonly cacheKey?: string;
  readonly leftMountedRows?: number;
  readonly rightMountedRows?: number;
  readonly virtualizationLevel?: "none" | "standard" | "aggressive";
}

export function KeydexAlignedSplitDiff({
  left,
  right,
  connector,
  connectorOverlay,
  connectorRef,
  connectorViewportHeight,
  leftGutter,
  rightGutter,
  leftGutterScrollTop = 0,
  rightGutterScrollTop = 0,
  lineNumberDigits = 3,
  edgeWidth = 1,
  leftPaneRef,
  rightPaneRef,
  leftLabel = "修改前",
  rightLabel = "修改后",
  minHeight = 240,
  className,
  scrollChaining = "contain",
  syncScroll = true,
  activeChangeIndex = null,
  changeCount = 0,
  cacheKey,
  leftMountedRows = 0,
  rightMountedRows = 0,
  virtualizationLevel = "none",
}: KeydexAlignedSplitDiffProps) {
  const descriptionId = useId();
  const style = {
    "--keydex-aligned-min-height": `${Math.max(0, minHeight)}px`,
    "--keydex-aligned-connector-viewport-height": connectorViewportHeight === undefined
      ? "100%"
      : `${Math.max(0, connectorViewportHeight)}px`,
    "--keydex-diff-line-number-digits": String(Math.max(1, lineNumberDigits)),
    "--keydex-diff-edge-width": `${finitePositive(edgeWidth, 1)}px`,
  } as CSSProperties;
  return (
    <div
      className={[styles.root, className].filter(Boolean).join(" ")}
      style={style}
      data-keydex-aligned-split=""
      data-keydex-aligned-cache-key={cacheKey}
      data-keydex-aligned-mounted-left={leftMountedRows}
      data-keydex-aligned-mounted-right={rightMountedRows}
      data-keydex-aligned-mounted-total={leftMountedRows + rightMountedRows}
      data-keydex-aligned-virtualization={virtualizationLevel}
      data-keydex-aligned-connector-viewport-height={connectorViewportHeight}
      role="group"
      aria-label="并排差异"
      aria-describedby={descriptionId}
    >
      <AlignedDiffPane className={styles.leftPane} ref={leftPaneRef} side="old" label={leftLabel} scrollChaining={scrollChaining}>{left}</AlignedDiffPane>
      {leftGutter ? (
        <div className={[styles.gutterViewport, styles.leftGutter].join(" ")} data-keydex-aligned-gutter="old" aria-hidden="true">
          <div className={styles.gutterCanvas} style={{ transform: `translate3d(0, ${-Math.max(0, leftGutterScrollTop)}px, 0)` }}>
            {leftGutter}
          </div>
        </div>
      ) : null}
      <div
        ref={connectorRef}
        className={styles.connector}
        data-keydex-aligned-connector=""
        data-keydex-aligned-viewport-sync="stable"
      >
        <div className={styles.connectorVisual} data-keydex-aligned-connector-visual="" aria-hidden="true">
          {connector}
        </div>
        {connectorOverlay ? (
          <div className={styles.connectorActions} data-keydex-aligned-connector-actions="">
            {connectorOverlay}
          </div>
        ) : null}
      </div>
      {rightGutter ? (
        <div className={[styles.gutterViewport, styles.rightGutter].join(" ")} data-keydex-aligned-gutter="new" aria-hidden="true">
          <div className={styles.gutterCanvas} style={{ transform: `translate3d(0, ${-Math.max(0, rightGutterScrollTop)}px, 0)` }}>
            {rightGutter}
          </div>
        </div>
      ) : null}
      <AlignedDiffPane className={styles.rightPane} ref={rightPaneRef} side="new" label={rightLabel} scrollChaining={scrollChaining}>{right}</AlignedDiffPane>
      <span id={descriptionId} className={styles.srOnly}>
        {syncScroll
          ? "左右代码窗格已同步滚动，可使用 Alt 加上方向键在差异之间导航。"
          : "左右代码窗格可独立滚动，可使用 Alt 加上方向键在差异之间导航。"}
      </span>
      <span className={styles.srOnly} aria-live="polite" aria-atomic="true">
        {activeChangeIndex !== null && changeCount > 0
          ? `当前是第 ${activeChangeIndex + 1} 个差异，共 ${changeCount} 个。`
          : changeCount > 0
            ? `共 ${changeCount} 个差异。`
            : "没有差异。"}
      </span>
    </div>
  );
}

function finitePositive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
