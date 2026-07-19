import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";

import type { KeydexDiffDocument } from "./model";
import {
  resolveKeydexDiffProfile,
  type KeydexDiffDensity,
  type KeydexDiffActions,
  type KeydexDiffLayout,
  type KeydexDiffProfileName,
} from "./profiles";
import type { KeydexDiffSelectionRange } from "./selectionBridge";
import { KeydexDiffSurface, KeydexDiffQuietState } from "./DiffSurface";
import { KeydexDiffLayoutBridge } from "./DiffLayoutBridge";
import { KeydexDiffFileHeader } from "./KeydexDiffFileHeader";
import { KeydexDiffFileNavigator } from "./KeydexDiffFileNavigator";
import {
  KeydexDiffProductToolbar,
  type KeydexDiffToolbarActionId,
} from "./KeydexDiffProductToolbar";
import { KeydexDiffErrorState, KeydexDiffLoadingState } from "./DiffBoundary";
import { KeydexDiffAccessibilityBridge } from "./DiffAccessibility";
import { PierrePatchDiff } from "./engine/PierrePatchDiff";
import { PierreCodeView } from "./engine/PierreCodeView";
import { PierreViewportHorizontalScrollbars } from "./engine/PierreViewportHorizontalScrollbars";
import {
  PierreWorkerPoolBoundary,
  usePierreWorkerPoolLease,
  usePierreWorkerPoolRuntime,
} from "./engine/PierreWorkerPoolHost";
import {
  AlignedDiffFileView,
  type AlignedDiffFileViewHandle,
} from "./aligned/AlignedDiffFileView";
import { resolveAlignedDiffCapability } from "./aligned/alignedDiffCapability";
import { resolveKeydexDiffScrollOwner } from "./diffScroll";
import { useKeydexDiffContextMenu } from "./DiffContextMenu";
import { useKeydexDiffTheme } from "./diffTheme";
import styles from "./KeydexDiffView.module.css";
import { diffDiagnosticPresentation } from "./diagnostics";
import {
  resolveKeydexDiffVirtualizationPolicy,
  type KeydexDiffRenderStrategy,
} from "./virtualizationPolicy";

export type KeydexDiffEngineKind = "empty" | KeydexDiffRenderStrategy;

export interface KeydexDiffViewState {
  readonly layout: KeydexDiffLayout;
  readonly wrap: boolean;
  readonly syncScroll?: boolean;
  readonly activeChangeId?: string | null;
  readonly activeFileId?: string | null;
  readonly selection?: KeydexDiffSelectionRange | null;
  readonly expandedFileIds?: readonly string[];
}

export interface KeydexDiffViewProps {
  readonly document: KeydexDiffDocument;
  readonly profile: KeydexDiffProfileName;
  readonly actions?: KeydexDiffActions;
  readonly state?: Partial<KeydexDiffViewState>;
  readonly scrollScopeKey?: string;
  readonly onSelectionChange?: (selection: KeydexDiffSelectionRange | null) => void;
  readonly onActiveFileChange?: (fileId: string) => void;
  readonly onLayoutChange?: (layout: KeydexDiffLayout) => void;
  readonly onWrapChange?: (wrap: boolean) => void;
  readonly onSyncScrollChange?: (syncScroll: boolean) => void;
  readonly onActiveChangeChange?: (changeId: string | null) => void;
  readonly selectionText?: string;
  readonly loadingAction?: KeydexDiffToolbarActionId | null;
  readonly onLoadingActionChange?: (action: KeydexDiffToolbarActionId | null) => void;
  readonly onExpandedFilesChange?: (fileIds: readonly string[]) => void;
  readonly showToolbar?: boolean;
  readonly showFileHeader?: boolean;
  readonly showFileNavigator?: boolean;
  readonly hiddenToolbarActions?: readonly KeydexDiffToolbarActionId[];
  readonly toolbarLeading?: ReactNode;
  readonly singleFileExpanded?: boolean;
  readonly singleFileDensity?: KeydexDiffDensity;
  readonly embedded?: boolean;
}

export function KeydexDiffView({
  document,
  profile,
  actions = {},
  state = {},
  scrollScopeKey = "default",
  onSelectionChange,
  onActiveFileChange,
  onLayoutChange,
  onWrapChange,
  onSyncScrollChange,
  onActiveChangeChange,
  selectionText,
  loadingAction,
  onLoadingActionChange,
  onExpandedFilesChange,
  showToolbar = true,
  showFileHeader = true,
  showFileNavigator = true,
  hiddenToolbarActions,
  toolbarLeading,
  singleFileExpanded = true,
  singleFileDensity,
  embedded = false,
}: KeydexDiffViewProps) {
  const theme = useKeydexDiffTheme();
  const worker = usePierreWorkerPoolLease();
  const workerRuntime = usePierreWorkerPoolRuntime();
  const resolvedProfile = useMemo(
    () => resolveKeydexDiffProfile(profile, actions),
    [actions, profile],
  );
  const layout = state.layout ?? resolvedProfile.profile.defaultLayout;
  const wrap = state.wrap ?? resolvedProfile.profile.defaultWrap;
  const syncScroll = resolvedProfile.profile.syncScroll
    && (state.syncScroll ?? resolvedProfile.profile.defaultSyncScroll);
  const [effectiveLayout, setEffectiveLayout] = useState<KeydexDiffLayout>(layout);
  const [alignedChangeCount, setAlignedChangeCount] = useState(0);
  const alignedViewRef = useRef<AlignedDiffFileViewHandle | null>(null);
  const navigateAlignedChange = useCallback((direction: "previous" | "next") => {
    alignedViewRef.current?.navigateChange(direction);
  }, []);
  const virtualizationPolicy = useMemo(
    () => resolveKeydexDiffVirtualizationPolicy(document, profile, wrap),
    [document, profile, wrap],
  );
  const engine = keydexDiffEngineKind(document, virtualizationPolicy.strategy);
  const scrollOwner = resolveKeydexDiffScrollOwner(profile) === "host" ? "host" : "viewer";
  const activeIndex = Math.max(
    0,
    document.files.findIndex((file) => file.id === state.activeFileId),
  );
  const activeFile = document.files[activeIndex] ?? document.files[0];
  const workerUnavailable = worker.status === "error" || Boolean(worker.workers?.workersFailed);
  const alignedCapability = useMemo(() => activeFile
    ? resolveAlignedDiffCapability(
        activeFile,
        resolvedProfile.profile,
        worker.status === "ready" && !workerUnavailable && Boolean(workerRuntime),
      )
    : null, [activeFile, resolvedProfile.profile, worker.status, workerUnavailable, workerRuntime]);
  const contextMenu = useKeydexDiffContextMenu({
    file: activeFile ?? null,
    actions,
    selectionText,
  });
  if (engine === "empty") {
    const diagnostic = document.diagnostics.find((entry) => entry.severity === "error");
    if (diagnostic) {
      const presentation = diffDiagnosticPresentation(diagnostic);
      return (
        <KeydexDiffErrorState
          phase={diagnostic.code === "worker_failure" ? "worker" : "parse"}
          profile={profile}
          documentId={document.id}
          rawSource=""
          presentation={{ ...presentation, code: diagnostic.code }}
        />
      );
    }
    return <KeydexDiffQuietState title="没有可显示的差异" detail="当前文档不包含文件变更。" />;
  }

  if (worker.status === "idle" || worker.status === "loading") {
    return <KeydexDiffLoadingState profile={profile} label="正在启动差异解析" />;
  }
  return (
    <PierreWorkerPoolBoundary>
      <KeydexDiffSurface
        className={styles.surface}
        profile={profile}
        embedded={embedded || profile === "compact"}
        scrollOwner={scrollOwner}
        data-keydex-diff-view="true"
        data-diff-engine={engine}
        data-wrap={wrap ? "true" : "false"}
        data-sync-scroll={syncScroll ? "true" : "false"}
        data-worker-status={worker.status}
        data-worker-total={worker.workers?.totalWorkers}
        data-worker-busy={worker.workers?.busyWorkers}
        data-worker-queued={worker.workers?.queuedTasks}
        data-worker-active={worker.workers?.activeTasks}
        data-worker-file-cache-size={worker.workers?.fileCacheSize}
        data-worker-diff-cache-size={worker.workers?.diffCacheSize}
        data-worker-cache-epoch={worker.cacheEpoch}
        data-aligned-capability={alignedCapability?.reason}
        data-app-context-menu={contextMenu.enabled ? "local" : undefined}
        onContextMenu={contextMenu.onContextMenu}
      >
      {activeFile && showToolbar ? (
        <KeydexDiffProductToolbar
          profile={profile}
          files={document.files}
          activeFile={activeFile}
          actions={actions}
          layout={effectiveLayout}
          wrap={wrap}
          syncScroll={syncScroll}
          changeCount={effectiveLayout === "split" ? alignedChangeCount : 0}
          selectionText={selectionText}
          selection={state.selection}
          loadingAction={loadingAction}
          onLoadingActionChange={onLoadingActionChange}
          onPreviousFile={onActiveFileChange && document.files.length > 1 ? () => {
            const index = (activeIndex - 1 + document.files.length) % document.files.length;
            onActiveFileChange(document.files[index]!.id);
          } : undefined}
          onNextFile={onActiveFileChange && document.files.length > 1 ? () => {
            const index = (activeIndex + 1) % document.files.length;
            onActiveFileChange(document.files[index]!.id);
          } : undefined}
          onLayoutChange={onLayoutChange}
          onWrapChange={onWrapChange}
          onSyncScrollChange={onSyncScrollChange}
          onPreviousChange={() => navigateAlignedChange("previous")}
          onNextChange={() => navigateAlignedChange("next")}
          hiddenActions={hiddenToolbarActions}
          leading={toolbarLeading}
        />
      ) : null}
      {showFileNavigator && document.files.length > 1 && resolvedProfile.profile.navigation === "files" && onActiveFileChange ? (
        <KeydexDiffFileNavigator
          files={document.files}
          activeFileId={activeFile?.id ?? null}
          expandedFileIds={state.expandedFileIds}
          defaultOpen={false}
          onActiveFileChange={onActiveFileChange}
          onExpandedFilesChange={onExpandedFilesChange}
        />
      ) : null}
      <div
        className={styles.viewport}
        data-single-file-expanded={engine === "single" ? String(singleFileExpanded) : undefined}
      >
        {engine === "single" && !singleFileExpanded ? null : (
          <KeydexDiffLayoutBridge
            profile={profile}
            preferredLayout={layout}
            wrap={wrap}
            embedded={embedded}
            onDecisionChange={(decision) => setEffectiveLayout((current) => (
              current === decision.effectiveLayout ? current : decision.effectiveLayout
            ))}
          >
            {(decision) => decision.effectiveLayout === "split"
              && resolvedProfile.profile.alignedSplit
              && alignedCapability?.renderer === "aligned"
              && activeFile ? (
              <div
                className={styles.singleFile}
                data-file-header={showFileHeader ? "true" : "false"}
                data-keydex-diff-renderer="aligned_split"
              >
                {showFileHeader ? <KeydexDiffFileHeader file={activeFile} /> : null}
                {workerRuntime ? (
                  <KeydexDiffAccessibilityBridge
                    profile={profile}
                    file={activeFile}
                    selection={state.selection}
                    onClearSelection={onSelectionChange ? () => onSelectionChange(null) : undefined}
                  >
                    <AlignedDiffFileView
                      ref={alignedViewRef}
                      file={activeFile}
                      sourceVersion={document.sourceVersion}
                      profile={profile}
                      theme={theme}
                      wrap={decision.wrap}
                      syncScroll={syncScroll}
                      scrollChaining={resolvedProfile.profile.scrollChaining}
                      runtime={workerRuntime}
                      workerCacheEpoch={worker.cacheEpoch}
                      activeChangeId={state.activeChangeId}
                      onActiveChangeChange={onActiveChangeChange}
                      onChangeCountChange={setAlignedChangeCount}
                      fallback={(
                        <SingleFileDiff
                          documentId={document.id}
                          file={activeFile}
                          profile={profile}
                          theme={theme}
                          layout="stacked"
                          wrap={decision.wrap}
                          selection={state.selection}
                          onSelectionChange={onSelectionChange}
                          showFileHeader={false}
                          density={singleFileDensity}
                          disableWorkerPool
                        />
                      )}
                    />
                  </KeydexDiffAccessibilityBridge>
                ) : <KeydexDiffLoadingState profile={profile} label="正在准备并排差异" />}
              </div>
            ) : engine === "single" ? (
              <SingleFileDiff
                documentId={document.id}
                file={document.files[0]!}
                profile={profile}
                theme={theme}
                layout={decision.effectiveLayout === "split" && alignedCapability?.renderer === "stacked"
                  ? "stacked"
                  : decision.effectiveLayout}
                wrap={decision.wrap}
                selection={state.selection}
                onSelectionChange={onSelectionChange}
                showFileHeader={showFileHeader}
                density={singleFileDensity}
                disableWorkerPool={workerUnavailable}
              />
            ) : document.files.length === 1 && activeFile ? (
              <div className={styles.singleFile} data-file-header={showFileHeader ? "true" : "false"}>
                {showFileHeader ? <KeydexDiffFileHeader file={activeFile} /> : null}
                <PierreCodeView
                  document={document}
                  profile={profile}
                  theme={theme}
                  layout={decision.effectiveLayout === "split" && alignedCapability?.renderer === "stacked"
                    ? "stacked"
                    : decision.effectiveLayout}
                  wrap={decision.wrap}
                  activeFileId={activeFile.id}
                  expandedFileIds={state.expandedFileIds}
                  scrollScopeKey={scrollScopeKey}
                  disableWorkerPool={workerUnavailable}
                  virtualizationPolicy={virtualizationPolicy}
                />
              </div>
            ) : (
              <PierreCodeView
                document={document}
                profile={profile}
                theme={theme}
                layout={decision.effectiveLayout === "split" && alignedCapability?.renderer === "stacked"
                  ? "stacked"
                  : decision.effectiveLayout}
                wrap={decision.wrap}
                activeFileId={activeFile?.id}
                expandedFileIds={state.expandedFileIds}
                scrollScopeKey={scrollScopeKey}
                disableWorkerPool={workerUnavailable}
                virtualizationPolicy={virtualizationPolicy}
              />
            )}
          </KeydexDiffLayoutBridge>
        )}
      </div>
      </KeydexDiffSurface>
    </PierreWorkerPoolBoundary>
  );
}

export function keydexDiffEngineKind(
  document: KeydexDiffDocument,
  strategy: KeydexDiffRenderStrategy,
): KeydexDiffEngineKind {
  if (document.files.length === 0) return "empty";
  return strategy;
}

function SingleFileDiff({
  documentId,
  file,
  profile,
  theme,
  layout,
  wrap,
  selection,
  onSelectionChange,
  showFileHeader,
  density,
  disableWorkerPool = false,
}: {
  readonly documentId: string;
  readonly file: KeydexDiffDocument["files"][number];
  readonly profile: KeydexDiffProfileName;
  readonly theme: "light" | "dark";
  readonly layout: KeydexDiffLayout;
  readonly wrap: boolean;
  readonly selection?: KeydexDiffSelectionRange | null;
  readonly onSelectionChange?: (selection: KeydexDiffSelectionRange | null) => void;
  readonly showFileHeader: boolean;
  readonly density?: KeydexDiffDensity;
  readonly disableWorkerPool?: boolean;
}) {
  const patchViewportRef = useRef<HTMLDivElement | null>(null);
  if (file.binary) {
    return <KeydexDiffQuietState title="二进制文件" detail="此文件不提供文本差异。" />;
  }
  if (file.truncated) {
    return (
      <KeydexDiffErrorState
        phase="parse"
        profile={profile}
        documentId={documentId}
        fileId={file.id}
        rawSource={file.patch}
      />
    );
  }
  return (
    <div className={styles.singleFile} data-file-header={showFileHeader ? "true" : "false"}>
      {showFileHeader ? <KeydexDiffFileHeader file={file} /> : null}
      <div className={styles.patchFrame}>
        <div
          ref={patchViewportRef}
          key={file.cacheKey}
          className={styles.patchViewport}
          data-keydex-diff-patch-viewport="true"
          data-diff-file-id={file.id}
        >
          <PierrePatchDiff
            file={file}
            profile={profile}
            theme={theme}
            layout={layout}
            wrap={wrap}
            selectedRange={selection}
            onSelectedRangeChange={onSelectionChange}
            disableWorkerPool={disableWorkerPool}
            density={density}
          />
        </div>
        <PierreViewportHorizontalScrollbars
          viewportRef={patchViewportRef}
          sourceKey={`${file.cacheKey}:${layout}:${wrap}`}
          scrollbars={!wrap}
        />
      </div>
    </div>
  );
}
