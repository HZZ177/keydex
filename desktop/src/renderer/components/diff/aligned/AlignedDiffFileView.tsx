import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import type { KeydexDiffFile } from "../model";
import type {
  KeydexDiffProfileName,
  KeydexDiffScrollChainingMode,
} from "../profiles";
import { KeydexDiffErrorState, KeydexDiffLoadingState } from "../DiffBoundary";
import type { KeydexDiffTheme } from "../engine/pierreOptions";
import type { PierreWorkerPoolRuntime } from "../engine/pierreWorkerPoolLifecycle";
import {
  PierreAlignedPreparationError,
  pierreAlignedPreparationCache,
  type PierreAlignedWorkerManager,
} from "../engine/pierreAlignedWorkerPipeline";
import type { PierreAlignedPublicApi } from "../engine/pierreAlignedAdapter";
import { resolveKeydexAlignedVirtualizationPolicy } from "../virtualizationPolicy";
import { AlignedDiffPaneItemView } from "./AlignedDiffHunkChrome";
import { AlignedDiffRow, diffChangeRowBoundary } from "./AlignedDiffRow";
import { AlignedDiffGutterRows } from "./AlignedDiffGutterRows";
import {
  type AlignedDiffPaneHandle,
} from "./AlignedDiffPane";
import { DiffConnectorLane } from "./DiffConnectorLane";
import {
  DiffHunkActionLayer,
  resolveAdjacentDiffChangeId,
  resolveDiffChangeScrollTarget,
  type DiffChangeNavigationDirection,
} from "./DiffHunkActionLayer";
import {
  HunkScrollSyncController,
  type DiffScrollFrame,
} from "./HunkScrollSyncController";
import { KeydexAlignedSplitDiff } from "./KeydexAlignedSplitDiff";
import { buildKeydexAlignedDiffModel } from "./alignmentSegments";
import { resolveAlignedPaneVirtualWindow } from "./alignedPaneWindow";
import { alignedDiffBottomScrollSpace } from "./alignedPaneScroll";
import { computeVisibleDiffConnectorGeometry } from "./connectorGeometry";
import {
  buildScrollMappingMetrics,
  mapDiffPaneViewportOffset,
  type DiffSegmentPixelMapping,
} from "./hunkScrollMapping";
import { useVirtualDiffRows } from "./useVirtualDiffRows";
import type {
  DiffChangeKind,
  DiffPaneRow,
  DiffPaneSide,
  KeydexAlignedDiffModel,
} from "./alignedDiffModel";
import styles from "./AlignedDiffFileView.module.css";

export interface AlignedDiffFileViewHandle {
  navigateChange(direction: DiffChangeNavigationDirection): void;
  readonly changeCount: number;
}

export interface AlignedDiffFileViewProps {
  readonly file: KeydexDiffFile;
  readonly sourceVersion: string;
  readonly profile: KeydexDiffProfileName;
  readonly theme: KeydexDiffTheme;
  readonly wrap: boolean;
  readonly syncScroll: boolean;
  readonly scrollChaining: KeydexDiffScrollChainingMode;
  readonly runtime: PierreWorkerPoolRuntime;
  readonly workerCacheEpoch: number;
  readonly activeChangeId?: string | null;
  readonly onActiveChangeChange?: (changeId: string | null) => void;
  readonly onChangeCountChange?: (count: number) => void;
  readonly fallback?: ReactNode;
}

interface PreparedState {
  readonly key: string;
  readonly model: KeydexAlignedDiffModel | null;
  readonly error: unknown;
}

export const AlignedDiffFileView = forwardRef<
  AlignedDiffFileViewHandle,
  AlignedDiffFileViewProps
>(function AlignedDiffFileView({
  file,
  sourceVersion,
  profile,
  theme,
  wrap,
  syncScroll,
  scrollChaining,
  runtime,
  workerCacheEpoch,
  activeChangeId: controlledActiveChangeId,
  onActiveChangeChange,
  onChangeCountChange,
  fallback,
}, forwardedRef) {
  const preparationKey = `${file.cacheKey}:${sourceVersion}:${theme}:${workerCacheEpoch}`;
  const currentPreparationKey = useRef(preparationKey);
  currentPreparationKey.current = preparationKey;
  const [retryRevision, setRetryRevision] = useState(0);
  const [prepared, setPrepared] = useState<PreparedState>(() => ({
    key: preparationKey,
    model: null,
    error: null,
  }));

  useEffect(() => {
    const controller = new AbortController();
    setPrepared({ key: preparationKey, model: null, error: null });
    void pierreAlignedPreparationCache.prepare({
      file,
      sourceVersion,
      theme,
      api: runtime.module as PierreAlignedPublicApi,
      manager: runtime.manager as PierreAlignedWorkerManager,
      signal: controller.signal,
      isCurrent: () => currentPreparationKey.current === preparationKey,
    }).then((result) => {
      if (!controller.signal.aborted && currentPreparationKey.current === preparationKey) {
        setPrepared({ key: preparationKey, model: buildKeydexAlignedDiffModel(result), error: null });
      }
    }).catch((error: unknown) => {
      if (controller.signal.aborted || isCancelledPreparation(error)) return;
      setPrepared({ key: preparationKey, model: null, error });
    });
    return () => controller.abort();
  }, [file, preparationKey, retryRevision, runtime, sourceVersion, theme]);

  if (prepared.key !== preparationKey || (!prepared.model && !prepared.error)) {
    return <KeydexDiffLoadingState profile={profile} label="正在准备并排差异" />;
  }
  if (prepared.error || !prepared.model) {
    if (fallback) return <>{fallback}</>;
    return (
      <KeydexDiffErrorState
        phase={preparationFailurePhase(prepared.error)}
        profile={profile}
        fileId={file.id}
        rawSource={file.patch}
        onRetry={() => setRetryRevision((revision) => revision + 1)}
      />
    );
  }

  return (
    <PreparedAlignedDiff
      ref={forwardedRef}
      model={prepared.model}
      profile={profile}
      wrap={wrap}
      syncScroll={syncScroll}
      scrollChaining={scrollChaining}
      activeChangeId={controlledActiveChangeId}
      onActiveChangeChange={onActiveChangeChange}
      onChangeCountChange={onChangeCountChange}
    />
  );
});

const PreparedAlignedDiff = forwardRef<AlignedDiffFileViewHandle, {
  readonly model: KeydexAlignedDiffModel;
  readonly profile: KeydexDiffProfileName;
  readonly wrap: boolean;
  readonly syncScroll: boolean;
  readonly scrollChaining: KeydexDiffScrollChainingMode;
  readonly activeChangeId?: string | null;
  readonly onActiveChangeChange?: (changeId: string | null) => void;
  readonly onChangeCountChange?: (count: number) => void;
}>(function PreparedAlignedDiff({
  model,
  profile,
  wrap,
  syncScroll,
  scrollChaining,
  activeChangeId: controlledActiveChangeId,
  onActiveChangeChange,
  onChangeCountChange,
}, forwardedRef) {
  const [leftPane, setLeftPane] = useState<AlignedDiffPaneHandle | null>(null);
  const [rightPane, setRightPane] = useState<AlignedDiffPaneHandle | null>(null);
  const [scrollFrame, setScrollFrame] = useState<DiffScrollFrame>(emptyDiffScrollFrame);
  const devicePixelRatio = useDiffDevicePixelRatio();
  const edgeWidth = diffPhysicalPixelWidth(devicePixelRatio);
  const [localActiveChangeId, setLocalActiveChangeId] = useState<string | null>(null);
  const activeChangeId = controlledActiveChangeId ?? localActiveChangeId;
  const leftPolicy = resolveKeydexAlignedVirtualizationPolicy(model.leftRows.length, profile, wrap);
  const rightPolicy = resolveKeydexAlignedVirtualizationPolicy(model.rightRows.length, profile, wrap);
  const leftContentColumns = useMemo(() => widestDiffLineColumns(model.leftRows), [model.leftRows]);
  const rightContentColumns = useMemo(() => widestDiffLineColumns(model.rightRows), [model.rightRows]);
  const leftVirtual = useVirtualDiffRows({
    rowCount: model.leftRows.length,
    estimatedHeight: leftPolicy.estimatedRowHeight,
    scrollElement: leftPane?.element ?? null,
    viewport: scrollFrame.left,
    enabled: leftPolicy.enabled,
    overscanPx: leftPolicy.overscanPx,
    maxMountedRows: leftPolicy.maxMountedRows,
  });
  const rightVirtual = useVirtualDiffRows({
    rowCount: model.rightRows.length,
    estimatedHeight: rightPolicy.estimatedRowHeight,
    scrollElement: rightPane?.element ?? null,
    viewport: scrollFrame.right,
    enabled: rightPolicy.enabled,
    overscanPx: rightPolicy.overscanPx,
    maxMountedRows: rightPolicy.maxMountedRows,
  });
  const metrics = useMemo(() => buildScrollMappingMetrics(
    model,
    leftVirtual.heightIndex,
    rightVirtual.heightIndex,
  ), [
    leftVirtual.heightIndex,
    leftVirtual.window.totalHeight,
    model,
    rightVirtual.heightIndex,
    rightVirtual.window.totalHeight,
  ]);
  const metricsRef = useRef(metrics);
  metricsRef.current = metrics;
  const controllerRef = useRef<HunkScrollSyncController | null>(null);
  useEffect(() => {
    const left = leftPane?.element;
    const right = rightPane?.element;
    if (!left || !right) return undefined;
    const controller = new HunkScrollSyncController({
      left,
      right,
      enabled: syncScroll,
      synchronizationMode: "animation_frame",
      mapOffset: (sourceSide, sourceOffset) => {
        const currentMetrics = metricsRef.current;
        const sourceViewportHeight = sourceSide === "old" ? left.clientHeight : right.clientHeight;
        const targetViewportHeight = sourceSide === "old" ? right.clientHeight : left.clientHeight;
        const sourceContentHeight = sourceSide === "old"
          ? currentMetrics.leftTotalHeight
          : currentMetrics.rightTotalHeight;
        const targetContentHeight = sourceSide === "old"
          ? currentMetrics.rightTotalHeight
          : currentMetrics.leftTotalHeight;
        return mapDiffPaneViewportOffset(
          model,
          currentMetrics,
          leftVirtual.heightIndex,
          rightVirtual.heightIndex,
          sourceSide,
          sourceOffset,
          sourceViewportHeight,
          targetViewportHeight,
          {
            sourceBottomScrollSpace: alignedDiffBottomScrollSpace(
              sourceContentHeight,
              sourceViewportHeight,
            ),
            targetBottomScrollSpace: alignedDiffBottomScrollSpace(
              targetContentHeight,
              targetViewportHeight,
            ),
          },
        );
      },
      onScrollFrame: (frame) => setScrollFrame((current) => (
        diffScrollFrameEqual(current, frame) ? current : frame
      )),
    });
    controllerRef.current = controller;
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => controller.refresh());
    observer?.observe(left);
    observer?.observe(right);
    controller.refresh();
    return () => {
      observer?.disconnect();
      controller.destroy();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [leftPane, leftVirtual.heightIndex, model, rightPane, rightVirtual.heightIndex]);

  const leftViewport = scrollFrame.left;
  const rightViewport = scrollFrame.right;
  const leftAlignedWindow = useMemo(() => resolveAlignedPaneVirtualWindow(
    metrics,
    leftVirtual.heightIndex,
    "old",
    leftViewport.scrollTop,
    leftViewport.height,
    leftPolicy.enabled,
    leftPolicy.overscanPx,
    leftPolicy.maxMountedRows,
  ), [leftPolicy, leftViewport, leftVirtual.heightIndex, metrics]);
  const rightAlignedWindow = useMemo(() => resolveAlignedPaneVirtualWindow(
    metrics,
    rightVirtual.heightIndex,
    "new",
    rightViewport.scrollTop,
    rightViewport.height,
    rightPolicy.enabled,
    rightPolicy.overscanPx,
    rightPolicy.maxMountedRows,
  ), [metrics, rightPolicy, rightViewport, rightVirtual.heightIndex]);
  // The horizontal scrollbar belongs to each code pane, not to the connector lane.
  // Use one unscaled coordinate space shared by both visible code viewports so the
  // connector does not stretch into the scrollbar strip and drift vertically.
  const connectorHeight = Math.max(0, Math.min(leftViewport.height, rightViewport.height));
  const geometry = useMemo(() => computeVisibleDiffConnectorGeometry(model, metrics, {
    leftScrollTop: leftViewport.scrollTop,
    rightScrollTop: rightViewport.scrollTop,
    leftViewportHeight: connectorHeight,
    rightViewportHeight: connectorHeight,
  }), [connectorHeight, leftViewport.scrollTop, metrics, model, rightViewport.scrollTop]);

  const setActiveChange = useCallback((changeId: string | null) => {
    setLocalActiveChangeId(changeId);
    onActiveChangeChange?.(changeId);
  }, [onActiveChangeChange]);

  const scrollToChange = useCallback((changeId: string) => {
    const leftElement = leftPane?.element;
    const rightElement = rightPane?.element;
    if (!leftElement || !rightElement) return;
    const currentMetrics = metricsRef.current;
    const leftTarget = resolveDiffChangeScrollTarget(
      model,
      currentMetrics,
      changeId,
      "old",
      leftElement.clientHeight,
    );
    const rightTarget = resolveDiffChangeScrollTarget(
      model,
      currentMetrics,
      changeId,
      "new",
      rightElement.clientHeight,
    );
    const change = model.changes.find(({ id }) => id === changeId);
    const navigationSide = change
      && change.left.startRow === change.left.endRow
      && change.right.startRow < change.right.endRow
      ? "new"
      : "old";
    const navigationTarget = navigationSide === "old" ? leftTarget : rightTarget;
    if (syncScroll && navigationTarget !== null && controllerRef.current) {
      controllerRef.current.scrollTo(navigationSide, navigationTarget);
      return;
    }
    if (leftTarget !== null) leftElement.scrollTop = leftTarget;
    if (rightTarget !== null) rightElement.scrollTop = rightTarget;
  }, [leftPane, model, rightPane, syncScroll]);

  const navigateChange = useCallback((direction: DiffChangeNavigationDirection) => {
    const next = resolveAdjacentDiffChangeId(
      model.changes.map(({ id }) => id),
      activeChangeId,
      direction,
      true,
    );
    if (!next) return;
    setActiveChange(next);
    scrollToChange(next);
  }, [activeChangeId, model.changes, scrollToChange, setActiveChange]);

  useImperativeHandle(forwardedRef, () => ({
    navigateChange,
    get changeCount() { return model.changes.length; },
  }), [model.changes.length, navigateChange]);

  useEffect(() => {
    onChangeCountChange?.(model.changes.length);
    return () => onChangeCountChange?.(0);
  }, [model.cacheKey, model.changes.length, onChangeCountChange]);

  useEffect(() => controllerRef.current?.setEnabled(syncScroll), [syncScroll]);

  const activeChangeIndex = activeChangeId
    ? model.changes.findIndex(({ id }) => id === activeChangeId)
    : -1;
  const lineNumberDigits = Math.max(
    2,
    String(Math.max(
      model.leftRows.at(-1)?.lineNumber ?? 0,
      model.rightRows.at(-1)?.lineNumber ?? 0,
    )).length,
  );
  const changeKindById = useMemo(
    () => new Map(model.changes.map(({ id, kind }) => [id, kind])),
    [model.changes],
  );
  return (
    <KeydexAlignedSplitDiff
      className={styles.root}
      leftPaneRef={setLeftPane}
      rightPaneRef={setRightPane}
      leftLabel="修改前"
      rightLabel="修改后"
      minHeight={0}
      scrollChaining={scrollChaining}
      syncScroll={syncScroll}
      activeChangeIndex={activeChangeIndex >= 0 ? activeChangeIndex : null}
      changeCount={model.changes.length}
      cacheKey={model.cacheKey}
      leftMountedRows={leftAlignedWindow.mountedRowCount}
      rightMountedRows={rightAlignedWindow.mountedRowCount}
      virtualizationLevel={leftPolicy.level === "aggressive" || rightPolicy.level === "aggressive"
        ? "aggressive"
        : leftPolicy.level === "standard" || rightPolicy.level === "standard"
          ? "standard"
          : "none"}
      connectorViewportHeight={connectorHeight}
      lineNumberDigits={lineNumberDigits}
      edgeWidth={edgeWidth}
      leftPaneViewport={{
        epoch: scrollFrame.epoch,
        scrollTop: leftViewport.scrollTop,
        height: leftViewport.height,
        scrollHeight: leftAlignedWindow.totalHeight,
        bottomScrollSpace: alignedDiffBottomScrollSpace(
          leftAlignedWindow.totalHeight,
          leftViewport.height,
        ),
        contentColumns: wrap ? 0 : leftContentColumns,
      }}
      rightPaneViewport={{
        epoch: scrollFrame.epoch,
        scrollTop: rightViewport.scrollTop,
        height: rightViewport.height,
        scrollHeight: rightAlignedWindow.totalHeight,
        bottomScrollSpace: alignedDiffBottomScrollSpace(
          rightAlignedWindow.totalHeight,
          rightViewport.height,
        ),
        contentColumns: wrap ? 0 : rightContentColumns,
      }}
      leftGutterScrollTop={leftViewport.scrollTop}
      rightGutterScrollTop={rightViewport.scrollTop}
      leftGutter={(
        <AlignedDiffGutterRows
          rows={model.leftRows}
          rowIndexes={leftAlignedWindow.rowIndexes}
          rowOffsets={metrics.leftRowOffsets}
          totalHeight={leftAlignedWindow.totalHeight}
          activeChangeId={activeChangeId}
          changeKindById={changeKindById}
        />
      )}
      rightGutter={(
        <AlignedDiffGutterRows
          rows={model.rightRows}
          rowIndexes={rightAlignedWindow.rowIndexes}
          rowOffsets={metrics.rightRowOffsets}
          totalHeight={rightAlignedWindow.totalHeight}
          activeChangeId={activeChangeId}
          changeKindById={changeKindById}
        />
      )}
      left={(
        <AlignedDiffVirtualRows
          rows={model.leftRows}
          rowIndexes={leftAlignedWindow.rowIndexes}
          rowOffsets={metrics.leftRowOffsets}
          segmentMappings={metrics.segments}
          side="old"
          totalHeight={leftAlignedWindow.totalHeight}
          contentColumns={leftContentColumns}
          wrap={wrap}
          activeChangeId={activeChangeId}
          lineNumberDigits={lineNumberDigits}
          observeRow={leftVirtual.observeRow}
          changeKindById={changeKindById}
        />
      )}
      right={(
        <AlignedDiffVirtualRows
          rows={model.rightRows}
          rowIndexes={rightAlignedWindow.rowIndexes}
          rowOffsets={metrics.rightRowOffsets}
          segmentMappings={metrics.segments}
          side="new"
          totalHeight={rightAlignedWindow.totalHeight}
          contentColumns={rightContentColumns}
          wrap={wrap}
          activeChangeId={activeChangeId}
          lineNumberDigits={lineNumberDigits}
          observeRow={rightVirtual.observeRow}
          changeKindById={changeKindById}
        />
      )}
      connector={(
        <DiffConnectorLane
          geometry={geometry}
          height={connectorHeight}
          edgeWidth={edgeWidth}
          activeChangeId={activeChangeId}
        />
      )}
      connectorOverlay={(
        <DiffHunkActionLayer
          changes={model.changes}
          geometry={geometry}
          activeChangeId={activeChangeId}
          loop
          onActiveChange={setActiveChange}
          onNavigate={scrollToChange}
        />
      )}
    />
  );
});

export function AlignedDiffVirtualRows({
  rows,
  rowIndexes,
  rowOffsets,
  segmentMappings,
  side,
  totalHeight,
  contentColumns,
  wrap,
  activeChangeId,
  lineNumberDigits,
  observeRow,
  changeKindById,
}: {
  readonly rows: readonly DiffPaneRow[];
  readonly rowIndexes: readonly number[];
  readonly rowOffsets: readonly number[] | undefined;
  readonly segmentMappings: readonly DiffSegmentPixelMapping[];
  readonly side: DiffPaneSide;
  readonly totalHeight: number;
  readonly contentColumns: number;
  readonly wrap: boolean;
  readonly activeChangeId: string | null;
  readonly lineNumberDigits: number;
  readonly observeRow: (rowIndex: number, element: HTMLElement | null) => void;
  readonly changeKindById: ReadonlyMap<string, DiffChangeKind>;
}) {
  const canvasStyle = {
    height: totalHeight,
    "--keydex-diff-canvas-content-width": `${contentColumns}ch`,
  } as CSSProperties;
  return (
    <div
      className={styles.alignedCanvas}
      style={canvasStyle}
      data-keydex-aligned-canvas=""
      data-wrap={wrap ? "true" : "false"}
      role="rowgroup"
    >
      {segmentMappings.map((mapping) => {
        if (mapping.segment.kind !== "collapsed_gap") return null;
        const range = side === "old" ? mapping.left : mapping.right;
        const lineRange = side === "old" ? mapping.segment.left : mapping.segment.right;
        const hiddenLineCount = lineRange.startLine !== null && lineRange.endLine !== null
          ? lineRange.endLine - lineRange.startLine + 1
          : 0;
        if (hiddenLineCount <= 0 || range.end <= range.start) return null;
        return (
          <div
            key={`${side}:${mapping.segment.id}:gap-overlay`}
            className={styles.collapsedGapRow}
            style={{ top: range.start, height: range.end - range.start }}
            data-keydex-aligned-gap-overlay={mapping.segment.id}
            data-side={side}
          >
            <AlignedDiffPaneItemView
              item={{
                type: "collapsed_gap",
                id: `${side}:${mapping.segment.id}:gap`,
                segmentId: mapping.segment.id,
                hiddenLineCount,
                canExpand: false,
              }}
              wrap={wrap}
            />
          </div>
        );
      })}
      {rowIndexes.map((rowIndex) => {
        const row = rows[rowIndex];
        const boundary = diffChangeRowBoundary(rows, rowIndex);
        return row ? (
          <AlignedDiffRow
            key={row.id}
            row={row}
            wrap={wrap}
            active={isAlignedDiffRowActive(row.changeId, activeChangeId)}
            changeKind={row.changeId ? changeKindById.get(row.changeId) ?? null : null}
            changeStart={boundary.start}
            changeEnd={boundary.end}
            lineNumberDigits={lineNumberDigits}
            rowIndex={rowIndex}
            offsetTop={rowOffsets?.[rowIndex] ?? rowIndex * row.estimatedHeight}
            observeRow={observeRow}
            gutterMode="external"
          />
        ) : null;
      })}
    </div>
  );
}

export function widestDiffLineColumns(rows: readonly Pick<DiffPaneRow, "text">[]): number {
  let widest = 0;
  for (const row of rows) widest = Math.max(widest, diffLineColumns(row.text));
  return widest;
}

function diffLineColumns(text: string, tabSize = 2): number {
  let columns = 0;
  for (const character of text) {
    if (character === "\t") {
      columns += tabSize - columns % tabSize;
      continue;
    }
    const codePoint = character.codePointAt(0) ?? 0;
    if (isZeroWidthCodePoint(codePoint)) continue;
    columns += isWideCodePoint(codePoint) ? 2 : 1;
  }
  return columns;
}

function isZeroWidthCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f)
    || (codePoint >= 0x1ab0 && codePoint <= 0x1aff)
    || (codePoint >= 0x1dc0 && codePoint <= 0x1dff)
    || (codePoint >= 0x20d0 && codePoint <= 0x20ff)
    || (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
    || (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
    || codePoint === 0x200d
  );
}

function isWideCodePoint(codePoint: number): boolean {
  return (
    codePoint >= 0x1100
    && (
      codePoint <= 0x115f
      || codePoint === 0x2329
      || codePoint === 0x232a
      || (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f)
      || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
      || (codePoint >= 0xf900 && codePoint <= 0xfaff)
      || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
      || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
      || (codePoint >= 0xff00 && codePoint <= 0xff60)
      || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
      || (codePoint >= 0x1f300 && codePoint <= 0x1faff)
      || (codePoint >= 0x20000 && codePoint <= 0x3fffd)
    )
  );
}

export function isAlignedDiffRowActive(
  rowChangeId: string | null,
  activeChangeId: string | null,
): boolean {
  return activeChangeId !== null && rowChangeId === activeChangeId;
}

export function diffPhysicalPixelWidth(devicePixelRatio: number): number {
  const safeRatio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
    ? devicePixelRatio
    : 1;
  return Math.round((1 / safeRatio) * 10_000) / 10_000;
}

function useDiffDevicePixelRatio(): number {
  const [devicePixelRatio, setDevicePixelRatio] = useState(readDevicePixelRatio);
  useEffect(() => {
    const update = () => {
      const next = readDevicePixelRatio();
      setDevicePixelRatio((current) => current === next ? current : next);
    };
    window.addEventListener("resize", update);
    window.visualViewport?.addEventListener("resize", update);
    return () => {
      window.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("resize", update);
    };
  }, []);
  return devicePixelRatio;
}

function readDevicePixelRatio(): number {
  return typeof window !== "undefined" && Number.isFinite(window.devicePixelRatio) && window.devicePixelRatio > 0
    ? window.devicePixelRatio
    : 1;
}

function diffScrollFrameEqual(current: DiffScrollFrame, next: DiffScrollFrame): boolean {
  return current.left.scrollTop === next.left.scrollTop
    && current.left.height === next.left.height
    && current.right.scrollTop === next.right.scrollTop
    && current.right.height === next.right.height;
}

function emptyDiffScrollFrame(): DiffScrollFrame {
  const empty = Object.freeze({ scrollTop: 0, height: 0 });
  return Object.freeze({
    epoch: 0,
    sourceSide: "old",
    source: "scroll",
    left: empty,
    right: empty,
  });
}

function preparationFailurePhase(error: unknown): "parse" | "highlight" | "worker" {
  if (error instanceof PierreAlignedPreparationError) return error.code === "worker" ? "worker" : "parse";
  if (error && typeof error === "object" && "phase" in error) {
    return (error as { phase?: string }).phase === "highlight" ? "highlight" : "parse";
  }
  return "parse";
}

function isCancelledPreparation(error: unknown): boolean {
  return error instanceof PierreAlignedPreparationError
    && (error.code === "aborted" || error.code === "stale");
}
