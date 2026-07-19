import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

import type { RuntimeBridge, WorkspaceScope } from "@/runtime";
import type { MarkdownSnapshot } from "@/renderer/markdownRuntime/document/MarkdownSnapshot";
import {
  estimateMarkdownSnapshotHeights,
  estimateMarkdownSnapshotHeightsIncrementally,
  measuredMarkdownBlockOccupiedHeight,
} from "@/renderer/markdownRuntime/layout/heightEstimate";
import { MarkdownMeasurementScheduler } from "@/renderer/markdownRuntime/layout/MeasurementScheduler";
import type { MarkdownHeightUpdate } from "@/renderer/markdownRuntime/layout/HeightIndex";
import {
  MarkdownAnnotationOverlayController,
  type MarkdownAnnotationOverlayMarker,
  type MarkdownAnnotationOverlayState,
} from "@/renderer/markdownRuntime/annotations";
import { buildMarkdownFindIndex as buildRuntimeMarkdownFindIndex, type MarkdownFindIndex } from "@/renderer/markdownRuntime/find";
import { MarkdownSelectionController, type MarkdownProjectedSelection } from "@/renderer/markdownRuntime/interaction";
import {
  MarkdownPositionMapper,
  markdownSourceOffsetToLogical,
} from "@/renderer/markdownRuntime/mapping";
import type { AnnotationRenderState } from "@/renderer/features/annotations/navigation/types";
import type { MarkdownAnnotationBinding } from "@/renderer/features/annotations/adapters/MarkdownAnnotationAdapter";
import {
  DocumentWorkerAnnotationResolver,
  type AnnotationDocumentWorkerResolveInput,
} from "@/renderer/features/annotations/anchoring/DocumentWorkerAnnotationResolver";
import type { ResolvedAnnotationIndex } from "@/renderer/features/annotations/domain/resolutions";
import { smoothScrollElementTo } from "@/renderer/features/annotations/navigation/AnnotationNavigationEffects";
import { markdownRuntimeDiagnostics } from "@/renderer/markdownRuntime/diagnostics";
import { stableMarkdownIdentityHash } from "@/renderer/markdownRuntime/document/identity";
import {
  ImageResourceRuntime,
  MermaidResourceRuntime,
  type MarkdownImageResourceDiagnostics,
  type MarkdownMermaidRuntimeDiagnostics,
} from "@/renderer/markdownRuntime/resources";
import type { MarkdownRuntimeStoreSnapshot } from "@/renderer/markdownRuntime/MarkdownRuntimeStore";
import {
  FILE_MARKDOWN_RENDERER_PROFILE,
  type MarkdownRendererInteractionHandlers,
  type MarkdownRendererResourceLifecycle,
} from "@/renderer/markdownRuntime/renderers";
import {
  DocumentViewRuntime,
  MarkdownEnvironmentController,
  attachMarkdownRuntimeView,
  reconcileMarkdownRuntimeViewRevision,
  type MarkdownRuntimeViewAttachment,
  type MarkdownViewDescriptor,
  type MarkdownViewScrollAnchor,
  type MarkdownViewStateAttachment,
} from "@/renderer/markdownRuntime/view";
import type { MarkdownRuntimeAttachment } from "@/renderer/markdownRuntime/MarkdownRuntimeStore";
import { MARKDOWN_WORKER_PROTOCOL_VERSION } from "@/renderer/markdownRuntime/worker/protocol";

import {
  fileMarkdownRuntimeStore,
  fileMarkdownViewStateStore,
  recordFileMarkdownRuntimeEntrySnapshot,
  registerFileMarkdownRuntimeEntry,
} from "./fileMarkdownRuntime";
import { FilePreviewBottomScrollSpace } from "./FilePreviewBottomScrollSpace";
import type { SourceLineScrollAnchor } from "./splitViewScrollSync";

export interface FileMarkdownRuntimeHostHandle {
  revealSourceOffset(offset: number, options?: { align?: "start" | "center"; behavior?: ScrollBehavior }): boolean;
  revealSourceLine(line: number, options?: { align?: "start" | "center"; behavior?: ScrollBehavior }): boolean;
  revealSourceLines(
    lineStart: number,
    lineEnd: number,
    options?: { align?: "start" | "center"; behavior?: ScrollBehavior },
  ): boolean;
  revealBlock(blockId: string, options?: { align?: "start" | "center"; behavior?: ScrollBehavior }): boolean;
  getBlockElement(blockId: string): HTMLElement | null;
  currentSnapshot(): MarkdownSnapshot | null;
  viewportSourceOffset(): number | null;
  syncViewportToSourceOffset(offset: number): boolean;
  viewportSourceAnchor(): SourceLineScrollAnchor | null;
  syncViewportToSourceAnchor(anchor: SourceLineScrollAnchor): boolean;
  queryFind(
    query: string,
    options?: { caseSensitive?: boolean; wholeWord?: boolean; limit?: number; signal?: AbortSignal },
  ): Promise<MarkdownFindIndex>;
  resolveAnnotations(input: AnnotationDocumentWorkerResolveInput): Promise<ResolvedAnnotationIndex>;
  diagnostics(): FileMarkdownRuntimeHostDiagnostics | null;
  retry(): void;
}

export interface FileMarkdownRuntimeHostDiagnostics {
  readonly revision: string;
  readonly snapshotBlocks: number;
  readonly mountedBlocks: number;
  readonly domNodes: number;
  readonly store: MarkdownRuntimeStoreSnapshot;
  readonly image: MarkdownImageResourceDiagnostics;
  readonly mermaid: MarkdownMermaidRuntimeDiagnostics;
  readonly stages: {
    readonly setupMs: number;
    readonly loadMs: number;
    readonly publishMs: number;
    readonly featureInstallMs: number;
  };
}

export type FileMarkdownRuntimeSnapshotLoader = NonNullable<FileMarkdownRuntimeHostProps["snapshotLoader"]>;

export interface FileMarkdownRuntimeHostProps {
  readonly workspaceId: string;
  readonly path: string;
  readonly source: string;
  readonly revision: string;
  readonly scrollElement: HTMLElement;
  readonly runtime?: RuntimeBridge;
  readonly workspaceScope?: WorkspaceScope | null;
  readonly interactions?: MarkdownRendererInteractionHandlers;
  readonly viewDescriptor?: MarkdownViewDescriptor;
  readonly snapshotLoader?: (input: {
    source: string;
    revision: string;
    signal: AbortSignal;
  }) => Promise<MarkdownSnapshot>;
  readonly onSnapshot?: (snapshot: MarkdownSnapshot, source: string) => void;
  readonly onOutlineChange?: (outline: MarkdownSnapshot["outline"]) => void;
  readonly onError?: (error: Error | null) => void;
  readonly onRender?: () => void;
  readonly annotationRenderState?: AnnotationRenderState | null;
  readonly activeFindMatchId?: string | null;
  readonly findIndex?: MarkdownFindIndex | null;
  readonly annotationPanelOpen?: boolean;
  readonly bindAnnotation?: (binding: MarkdownAnnotationBinding | null) => () => void;
  readonly onAnnotationActivate?: (annotationId: string) => void;
  readonly onAnnotationHover?: (annotationId: string | null) => void;
  readonly onMountedBlocksChange?: () => void;
  readonly onSelectionChange?: (selection: MarkdownProjectedSelection | null) => void;
}

export const FileMarkdownRuntimeHost = forwardRef<FileMarkdownRuntimeHostHandle, FileMarkdownRuntimeHostProps>(
  function FileMarkdownRuntimeHost(props, forwardedRef) {
    const hostRef = useRef<HTMLDivElement>(null);
    const stateRef = useRef<HostState | null>(null);
    const propsRef = useRef(props);
    propsRef.current = props;
    const lastGoodSnapshotRef = useRef<{ key: string; snapshot: MarkdownSnapshot } | null>(null);
    const lastRequestedLoadRef = useRef<string | null>(null);
    const [error, setError] = useState<Error | null>(null);
    const [retryToken, setRetryToken] = useState(0);

    useImperativeHandle(forwardedRef, () => ({
      revealSourceOffset: (offset, options) => revealOffset(stateRef.current, offset, options),
      revealSourceLine: (line, options) => {
        return revealSourceLines(stateRef.current, line, line, options);
      },
      revealSourceLines: (lineStart, lineEnd, options) =>
        revealSourceLines(stateRef.current, lineStart, lineEnd, options),
      revealBlock: (blockId, options) => revealBlock(stateRef.current, blockId, options),
      getBlockElement: (blockId) => stateRef.current?.view.getBlockElement(blockId) ?? null,
      currentSnapshot: () => stateRef.current?.snapshot ?? null,
      viewportSourceOffset: () => viewportSourceOffset(stateRef.current),
      syncViewportToSourceOffset: (offset) => syncViewportToSourceOffset(stateRef.current, offset),
      viewportSourceAnchor: () => viewportSourceAnchor(stateRef.current),
      syncViewportToSourceAnchor: (anchor) => syncViewportToSourceAnchor(stateRef.current, anchor),
      queryFind: (query, options) => queryRuntimeFind(stateRef.current, query, options),
      resolveAnnotations: (input) => resolveRuntimeAnnotations(stateRef.current, input),
      diagnostics: () => {
        const state = stateRef.current;
        if (!state?.snapshot) return null;
        return Object.freeze({
          revision: state.snapshot.revision,
          snapshotBlocks: state.snapshot.blocks.length,
          mountedBlocks: state.view.mountedBlockIds().length,
          domNodes: hostRef.current?.querySelectorAll("*").length ?? 0,
          store: fileMarkdownRuntimeStore().diagnostics(),
          image: state.imageRuntime.diagnostics(),
          mermaid: state.mermaidRuntime.diagnostics(),
          stages: Object.freeze({ ...state.stages }),
        });
      },
      retry: () => setRetryToken((value) => value + 1),
    }), []);

    useLayoutEffect(() => {
      syncRuntimeFeatureState(stateRef.current, props);
    });

    useEffect(() => {
      const host = hostRef.current;
      if (!host) return;
      const effectStartedAt = performance.now();
      let active = true;
      const controller = new AbortController();
      const documentKey = `${props.workspaceId}\u0000${props.path}`;
      let state!: HostState;
      let resourceReflowFrame: number | null = null;
      const scheduleResourceReflow = () => {
        if (!active || resourceReflowFrame !== null) return;
        resourceReflowFrame = window.requestAnimationFrame(() => {
          resourceReflowFrame = null;
          if (!active) return;
          safeMeasureAndAnchor(state);
          remeasureRuntimeOverlays(state);
        });
      };
      let attachment: MarkdownRuntimeAttachment | null = null;
      let visiblePrefixAttachment: MarkdownRuntimeAttachment | null = null;
      let runtimeViewAttachment: MarkdownRuntimeViewAttachment | null = null;
      let viewStateAttachment: MarkdownViewStateAttachment | null = null;
      const imageRuntime = new ImageResourceRuntime({
        sourcePathFor: () => propsRef.current.path,
        workspaceKeyFor: () => workspaceScopeKey(propsRef.current.workspaceScope) ?? propsRef.current.workspaceId,
        resourceRevisionFor: () => propsRef.current.revision,
        readWorkspaceImage: props.runtime && props.workspaceScope
          ? async (path, _context, signal) => {
              if (signal.aborted) throw signal.reason;
              const result = await props.runtime!.workspace.readMedia(props.workspaceScope!, path);
              if (signal.aborted) throw signal.reason;
              return {
                dataUrl: result.data_url,
                mediaType: result.media_type,
                bytes: result.size,
                revision: propsRef.current.revision,
              };
            }
          : undefined,
        onStateChange: (event) => recordResourceDiagnostic(
          documentKey,
          propsRef.current.revision,
          "image",
          event.resourceId,
          event.state,
          event.error,
        ),
        onDimensions: scheduleResourceReflow,
      });
      const mermaidRuntime = new MermaidResourceRuntime({
        onStateChange: (event) => recordResourceDiagnostic(
          documentKey,
          propsRef.current.revision,
          "mermaid",
          event.resourceId,
          event.state,
          event.error,
        ),
        onDimensions: scheduleResourceReflow,
      });
      const resources: MarkdownRendererResourceLifecycle = {
        mount(resource, element, context) {
          return imageRuntime.mount(resource, element, context) ?? mermaidRuntime.mount(resource, element, context);
        },
      };
      const view = new DocumentViewRuntime(host, {
        profile: FILE_MARKDOWN_RENDERER_PROFILE,
        interactions: props.interactions,
        resourceLifecycle: resources,
        onFoldChange: (foldedBlockIds, patch) => {
          if (!active) return;
          if (patch && Math.abs(props.scrollElement.scrollTop - patch.viewport.scrollTop) > 0.5) {
            props.scrollElement.scrollTop = patch.viewport.scrollTop;
          }
          state.viewState?.replaceFolds(foldedBlockIds);
          syncMeasurementTargets(state);
          syncRuntimeFeatureState(state, propsRef.current);
          remeasureRuntimeOverlays(state);
        },
      });
      const handleRetainedLinkFallback = (event: MouseEvent) => {
        if (event.defaultPrevented || !(event.target instanceof Element)) return;
        const anchor = event.target.closest<HTMLAnchorElement>("a[data-markdown-link-navigation='host']");
        if (!anchor || !host.contains(anchor)) return;
        const blockId = anchor.closest<HTMLElement>("[data-markdown-block-id]")?.dataset.markdownBlockId;
        const block = blockId ? stateRef.current?.snapshot?.blocks.find((candidate) => candidate.id === blockId) : null;
        const href = anchor.getAttribute("href") ?? "";
        if (block && href) propsRef.current.interactions?.onLinkActivate?.(event, { href, block });
      };
      const handleSourceRevealDismiss = (event: MouseEvent) => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("[data-markdown-source-reveal-active='true'][data-markdown-block-id]")) return;
        clearSourceReveal(stateRef.current);
      };
      host.addEventListener("click", handleRetainedLinkFallback);
      host.addEventListener("click", handleSourceRevealDismiss, true);
      const environment = new MarkdownEnvironmentController(host, {
        mermaidRuntime,
        onRemeasure: () => {
          safeMeasureAndAnchor(stateRef.current);
          remeasureRuntimeOverlays(stateRef.current);
        },
      });
      state = {
        view,
        environment,
        imageRuntime,
        mermaidRuntime,
        scrollElement: props.scrollElement,
        viewState: null,
        viewStateUnsubscribe: null,
        documentId: documentKey,
        revision: props.revision,
        loadSequence: 0,
        loadSnapshot: null,
        managesViewRevision: false,
        scheduleFeatureInstall: null,
        snapshot: null,
        renderCount: 0,
        attachment: null,
        annotationResolver: null,
        mapper: null,
        selection: null,
        annotationOverlay: null,
        findOverlay: null,
        sourceRevealOverlay: null,
        annotationBindingCleanup: null,
        mountedBlockSignature: "",
        findRequestSequence: 0,
        measurement: null,
        measuredElements: new Map(),
        featureProps: props,
        publishedAnnotationRenderState: null,
        publishedFindIndex: null,
        publishedActiveFindMatchId: null,
        publishedSourceReveal: null,
        sourceReveal: null,
        stages: { setupMs: 0, loadMs: 0, publishMs: 0, featureInstallMs: 0 },
      };
      if (typeof ResizeObserver !== "undefined") {
        state.measurement = new MarkdownMeasurementScheduler({
          revision: props.revision,
          epoch: 0,
          onMeasurements: (batch) => applyMeasuredHeightBatch(state, batch.updates, batch.revision),
          onError: (reason) => recordMeasurementFailure(state, reason),
        });
      }
      stateRef.current = state;
      let featureInstallTimer: number | null = null;
      const scheduleFeatureInstall = () => {
        if (featureInstallTimer !== null) window.clearTimeout(featureInstallTimer);
        // Visible-first: let the canonical viewport paint before building
        // selection/annotation/find indexes for the whole document.
        featureInstallTimer = window.setTimeout(() => {
          featureInstallTimer = null;
          if (!active || !state.snapshot) return;
          const featureStartedAt = performance.now();
          installRuntimeFeatures(state, propsRef.current);
          state.stages.featureInstallMs = Math.max(0, performance.now() - featureStartedAt);
          host.dataset.markdownRuntimeFeatures = "ready";
          safeMeasureAndAnchor(state);
        }, 50);
      };
      state.scheduleFeatureInstall = scheduleFeatureInstall;
      let viewportFrame: number | null = null;
      const updateViewport = () => {
        viewportFrame = null;
        if (!state.snapshot) return;
        const patch = view.updateViewport({
          scrollTop: props.scrollElement.scrollTop,
          viewportHeight: props.scrollElement.clientHeight,
          revision: state.snapshot.revision,
        });
        persistScrollAnchor(state, patch.viewport.visibleRange.start);
        recordRendererFailures(state, patch.render.failed);
        syncMeasurementTargets(state);
        syncRenderCount(host, state, props.onRender);
        syncRuntimeFeatureState(state, propsRef.current);
      };
      const scheduleViewportUpdate = () => {
        if (viewportFrame !== null) return;
        viewportFrame = requestAnimationFrame(updateViewport);
      };
      props.scrollElement.addEventListener("scroll", scheduleViewportUpdate, { passive: true });
      const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleViewportUpdate);
      resize?.observe(props.scrollElement);

      if (props.viewDescriptor) {
        if (props.snapshotLoader) {
          viewStateAttachment = fileMarkdownViewStateStore().attach(props.viewDescriptor);
        } else {
          runtimeViewAttachment = attachMarkdownRuntimeView({
            runtimeStore: fileMarkdownRuntimeStore(),
            viewStateStore: fileMarkdownViewStateStore(),
            identity: { surface: "file", workspaceId: props.workspaceId, path: props.path },
            view: props.viewDescriptor,
          });
          viewStateAttachment = runtimeViewAttachment.view;
        }
        state.viewState = viewStateAttachment;
        view.setFoldedBlockIds(viewStateAttachment.snapshot().foldedBlockIds);
        state.viewStateUnsubscribe = viewStateAttachment.subscribe((viewState) => {
          if (!active) return;
          const patch = view.setFoldedBlockIds(viewState.foldedBlockIds);
          if (patch && Math.abs(props.scrollElement.scrollTop - patch.viewport.scrollTop) > 0.5) {
            props.scrollElement.scrollTop = patch.viewport.scrollTop;
          }
          if (patch) {
            syncMeasurementTargets(state);
            syncRuntimeFeatureState(state, propsRef.current);
            remeasureRuntimeOverlays(state);
          }
        });
        host.dataset.markdownRuntimeViewId = props.viewDescriptor.viewId;
        host.dataset.markdownRuntimeEntryId = props.viewDescriptor.entryId;
        registerFileMarkdownRuntimeEntry(props.viewDescriptor, {
          surface: "file",
          workspaceId: props.workspaceId,
          path: props.path,
        });
      }
      if (!props.snapshotLoader && !runtimeViewAttachment) {
        attachment = fileMarkdownRuntimeStore().attach({
          surface: "file",
          workspaceId: props.workspaceId,
          path: props.path,
        }, `file-host:runtime:${stableMarkdownIdentityHash(`${props.workspaceId}:${props.path}:${nextFileRuntimeViewId++}`)}`);
      }
      state.attachment = runtimeViewAttachment?.document ?? attachment;
      state.managesViewRevision = Boolean(runtimeViewAttachment);
      state.loadSnapshot = props.snapshotLoader
        ? (input) => props.snapshotLoader!(input)
        : runtimeViewAttachment
          ? (input) => runtimeViewAttachment!.load(input)
          : (input) => attachment!.load(input);
      const retainedSnapshot = runtimeViewAttachment?.current()?.snapshot
        ?? attachment?.current()?.snapshot
        ?? (lastGoodSnapshotRef.current?.key === documentKey ? lastGoodSnapshotRef.current.snapshot : null);
      const immediateRetainedSnapshot = retainedSnapshot
        && retainedSnapshot.estimated_bytes < INCREMENTAL_SNAPSHOT_PREPARATION_BYTES
        ? retainedSnapshot
        : null;
      if (immediateRetainedSnapshot) {
        publishSnapshot(state, immediateRetainedSnapshot, "stale");
        scheduleFeatureInstall();
        syncRenderCount(host, state, props.onRender);
        host.dataset.markdownRuntimeStale = "true";
      } else {
        host.dataset.markdownRuntimeStatus = "loading";
      }
      const loadSequence = ++state.loadSequence;
      lastRequestedLoadRef.current = runtimeLoadKey(props.source, props.revision, retryToken);
      if (!immediateRetainedSnapshot && !props.snapshotLoader && props.source.length > FILE_VISIBLE_PREFIX_CHARACTERS) {
        const prefixSource = visibleMarkdownPrefix(props.source, FILE_VISIBLE_PREFIX_CHARACTERS);
        visiblePrefixAttachment = fileMarkdownRuntimeStore().attach({
          surface: "file",
          workspaceId: props.workspaceId,
          path: `${props.path}#visible-prefix`,
        }, `file-visible-prefix:${stableMarkdownIdentityHash(`${props.workspaceId}:${props.path}:${props.revision}`)}`);
        void visiblePrefixAttachment.load({
          revision: `${props.revision}:visible:${prefixSource.length}`,
          source: prefixSource,
          retention: "transient",
          signal: controller.signal,
        }).then((snapshot) => {
          if (!active || state.loadSequence !== loadSequence || state.snapshot) return;
          publishSnapshot(state, snapshot, "ready");
          host.dataset.markdownRuntimeCompleteness = "visible-prefix";
          syncRenderCount(host, state, props.onRender);
        }).catch((reason) => {
          if (!active || controller.signal.aborted) return;
          markdownRuntimeDiagnostics.record({
            stage: "parser",
            severity: "warning",
            code: "visible-prefix-failed",
            documentId: state.documentId,
            revision: props.revision,
            recovery: "none",
            detail: reason,
            blockId: null,
            resourceId: null,
          });
        });
      }
      const loadStartedAt = performance.now();
      state.stages.setupMs = Math.max(0, loadStartedAt - effectStartedAt);
      const load = state.loadSnapshot({
        source: props.source,
        revision: props.revision,
        signal: controller.signal,
      });
      void load.then(async (snapshot) => {
        if (!active || state.loadSequence !== loadSequence) return;
        state.stages.loadMs = Math.max(0, performance.now() - loadStartedAt);
        const preparedHeights = snapshot.estimated_bytes >= INCREMENTAL_SNAPSHOT_PREPARATION_BYTES
          ? await prepareSnapshotHeights(state, snapshot)
          : null;
        if (!active || state.loadSequence !== loadSequence) return;
        if (preparedHeights) await yieldMainThread();
        if (!active || state.loadSequence !== loadSequence) return;
        persistCurrentScrollAnchor(state);
        state.snapshot = snapshot;
        if (!state.managesViewRevision && viewStateAttachment) {
          reconcileMarkdownRuntimeViewRevision(viewStateAttachment, snapshot);
        }
        const publishStartedAt = performance.now();
        publishSnapshot(state, snapshot, "ready", preparedHeights ?? undefined);
        state.stages.publishMs = Math.max(0, performance.now() - publishStartedAt);
        restoreScrollAnchor(state, true);
        syncRenderCount(host, state, props.onRender);
        lastGoodSnapshotRef.current = { key: documentKey, snapshot };
        if (props.viewDescriptor) {
          recordFileMarkdownRuntimeEntrySnapshot(props.viewDescriptor, snapshot.estimated_bytes);
        }
        visiblePrefixAttachment?.detach();
        visiblePrefixAttachment = null;
        delete host.dataset.markdownRuntimeStale;
        host.dataset.markdownRuntimeCompleteness = "canonical";
        setError(null);
        props.onError?.(null);
        props.onSnapshot?.(snapshot, props.source);
        props.onOutlineChange?.(snapshot.outline);
        scheduleFeatureInstall();
      }).catch((reason) => {
        if (!active || controller.signal.aborted || state.loadSequence !== loadSequence) return;
        const next = reason instanceof Error ? reason : new Error(String(reason));
        host.dataset.markdownRuntimeStatus = state.snapshot ? "stale-error" : "error";
        if (state.snapshot) host.dataset.markdownRuntimeStale = "true";
        setError(next);
        props.onError?.(next);
        markdownRuntimeDiagnostics.record({
          stage: "host",
          severity: state.snapshot ? "error" : "fatal",
          code: state.snapshot ? "load-failed-retained" : "load-failed",
          documentId: state.documentId,
          revision: props.revision,
          recovery: state.snapshot ? "retain-snapshot" : "retry",
          detail: next,
          blockId: null,
          resourceId: null,
        });
      });

      return () => {
        active = false;
        controller.abort();
        props.scrollElement.removeEventListener("scroll", scheduleViewportUpdate);
        if (viewportFrame !== null) cancelAnimationFrame(viewportFrame);
        if (featureInstallTimer !== null) window.clearTimeout(featureInstallTimer);
        if (resourceReflowFrame !== null) window.cancelAnimationFrame(resourceReflowFrame);
        resize?.disconnect();
        attachment?.detach();
        visiblePrefixAttachment?.detach();
        runtimeViewAttachment?.detach();
        state.viewStateUnsubscribe?.();
        state.viewStateUnsubscribe = null;
        if (!runtimeViewAttachment) viewStateAttachment?.detach();
        environment.destroy();
        state.measurement?.dispose();
        state.measuredElements.clear();
        destroyRuntimeFeatures(state);
        delete host.dataset.markdownRuntimeFeatures;
        host.removeEventListener("click", handleRetainedLinkFallback);
        host.removeEventListener("click", handleSourceRevealDismiss, true);
        view.destroy();
        imageRuntime.destroy();
        mermaidRuntime.destroy();
        if (stateRef.current === state) stateRef.current = null;
      };
    }, [
      props.interactions,
      props.path,
      props.runtime,
      props.scrollElement,
      props.snapshotLoader,
      props.workspaceId,
      props.workspaceScope,
      props.viewDescriptor,
    ]);

    useEffect(() => {
      const loadKey = runtimeLoadKey(props.source, props.revision, retryToken);
      if (lastRequestedLoadRef.current === loadKey) return;
      const state = stateRef.current;
      const loadSnapshot = state?.loadSnapshot;
      if (!state || !loadSnapshot) return;
      lastRequestedLoadRef.current = loadKey;
      state.revision = props.revision;
      const loadSource = props.source;
      const loadSequence = ++state.loadSequence;
      const controller = new AbortController();
      let active = true;
      const loadStartedAt = performance.now();

      void loadSnapshot({
        source: loadSource,
        revision: props.revision,
        signal: controller.signal,
      }).then(async (snapshot) => {
        if (!active || state.loadSequence !== loadSequence) return;
        state.stages.loadMs = Math.max(0, performance.now() - loadStartedAt);
        const preparedHeights = snapshot.estimated_bytes >= INCREMENTAL_SNAPSHOT_PREPARATION_BYTES
          ? await prepareSnapshotHeights(state, snapshot)
          : null;
        if (!active || state.loadSequence !== loadSequence) return;
        if (preparedHeights) await yieldMainThread();
        if (!active || state.loadSequence !== loadSequence) return;
        persistCurrentScrollAnchor(state);
        if (!state.managesViewRevision && state.viewState) {
          reconcileMarkdownRuntimeViewRevision(state.viewState, snapshot);
        }
        destroyRuntimeFeatures(state);
        const publishStartedAt = performance.now();
        publishSnapshot(state, snapshot, "ready", preparedHeights ?? undefined);
        state.stages.publishMs = Math.max(0, performance.now() - publishStartedAt);
        restoreScrollAnchor(state);
        syncRenderCount(state.view.host, state, propsRef.current.onRender);
        lastGoodSnapshotRef.current = { key: state.documentId, snapshot };
        if (propsRef.current.viewDescriptor) {
          recordFileMarkdownRuntimeEntrySnapshot(
            propsRef.current.viewDescriptor,
            snapshot.estimated_bytes,
          );
        }
        delete state.view.host.dataset.markdownRuntimeStale;
        state.view.host.dataset.markdownRuntimeCompleteness = "canonical";
        setError(null);
        propsRef.current.onError?.(null);
        propsRef.current.onSnapshot?.(snapshot, loadSource);
        propsRef.current.onOutlineChange?.(snapshot.outline);
        state.scheduleFeatureInstall?.();
      }).catch((reason) => {
        if (!active || controller.signal.aborted || state.loadSequence !== loadSequence) return;
        const next = reason instanceof Error ? reason : new Error(String(reason));
        state.view.host.dataset.markdownRuntimeStatus = state.snapshot ? "stale-error" : "error";
        if (state.snapshot) state.view.host.dataset.markdownRuntimeStale = "true";
        setError(next);
        propsRef.current.onError?.(next);
        markdownRuntimeDiagnostics.record({
          stage: "host",
          severity: state.snapshot ? "error" : "fatal",
          code: state.snapshot ? "load-failed-retained" : "load-failed",
          documentId: state.documentId,
          revision: props.revision,
          recovery: state.snapshot ? "retain-snapshot" : "retry",
          detail: next,
          blockId: null,
          resourceId: null,
        });
      });

      return () => {
        active = false;
        controller.abort();
      };
    }, [props.path, props.revision, props.source, props.workspaceId, retryToken]);

    return (
      <div
        className="keydex-markdown"
        data-file-markdown-runtime-host="true"
        data-markdown-runtime-mode="runtime"
      >
        <div ref={hostRef} data-file-markdown-runtime-canvas="true" />
        {error ? (
          <div data-markdown-runtime-error="true" role="alert">
            <span>Markdown Runtime failed: {error.message}</span>
            <button type="button" data-markdown-runtime-retry="true" onClick={() => setRetryToken((value) => value + 1)}>
              Retry Runtime
            </button>
          </div>
        ) : null}
        <FilePreviewBottomScrollSpace scrollElement={props.scrollElement} />
      </div>
    );
  },
);

interface HostState {
  readonly view: DocumentViewRuntime;
  readonly environment: MarkdownEnvironmentController;
  readonly imageRuntime: ImageResourceRuntime;
  readonly mermaidRuntime: MermaidResourceRuntime;
  readonly scrollElement: HTMLElement;
  viewState: MarkdownViewStateAttachment | null;
  viewStateUnsubscribe: (() => void) | null;
  readonly documentId: string;
  revision: string;
  loadSequence: number;
  loadSnapshot: ((input: RuntimeLoadInput) => Promise<MarkdownSnapshot>) | null;
  managesViewRevision: boolean;
  scheduleFeatureInstall: (() => void) | null;
  snapshot: MarkdownSnapshot | null;
  renderCount: number;
  attachment: MarkdownRuntimeAttachment | null;
  annotationResolver: DocumentWorkerAnnotationResolver | null;
  mapper: MarkdownPositionMapper | null;
  selection: MarkdownSelectionController | null;
  annotationOverlay: MarkdownAnnotationOverlayController | null;
  findOverlay: MarkdownAnnotationOverlayController | null;
  sourceRevealOverlay: MarkdownAnnotationOverlayController | null;
  annotationBindingCleanup: (() => void) | null;
  mountedBlockSignature: string;
  findRequestSequence: number;
  measurement: MarkdownMeasurementScheduler | null;
  readonly measuredElements: Map<string, HTMLElement>;
  featureProps: FileMarkdownRuntimeHostProps;
  publishedAnnotationRenderState: AnnotationRenderState | null;
  publishedFindIndex: MarkdownFindIndex | null;
  publishedActiveFindMatchId: string | null;
  publishedSourceReveal: SourceRevealState | null;
  sourceReveal: SourceRevealState | null;
  readonly stages: { setupMs: number; loadMs: number; publishMs: number; featureInstallMs: number };
}

interface RuntimeLoadInput {
  readonly source: string;
  readonly revision: string;
  readonly signal: AbortSignal;
}

function runtimeLoadKey(source: string, revision: string, retryToken: number): string {
  return `${retryToken}\u0000${revision}\u0000${stableMarkdownIdentityHash(source)}`;
}

interface SourceRevealState {
  readonly blockIds: readonly string[];
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly align: "start" | "center";
  readonly behavior: ScrollBehavior;
  refined: boolean;
}

function installRuntimeFeatures(state: HostState, props: FileMarkdownRuntimeHostProps): void {
  destroyRuntimeFeatures(state, false);
  state.featureProps = props;
  const snapshot = state.snapshot;
  if (!snapshot || props.source.length !== snapshot.source_characters) return;
  const mapper = new MarkdownPositionMapper(props.source, snapshot, {
    heightIndex: state.view.getHeightIndex(),
    mounted: state.view,
  });
  state.mapper = mapper;
  state.annotationOverlay = new MarkdownAnnotationOverlayController({
    snapshot,
    mapper,
    mounted: state.view,
    reveal: ({ blockId }) => {
      revealBlock(state, blockId, { align: "center", behavior: "smooth" });
    },
    onActivate: (annotationId) => state.featureProps.onAnnotationActivate?.(annotationId),
    onHover: (annotationId) => state.featureProps.onAnnotationHover?.(annotationId),
  });
  state.findOverlay = new MarkdownAnnotationOverlayController({
    snapshot,
    mapper,
    mounted: state.view,
    variant: "find",
  });
  state.sourceRevealOverlay = new MarkdownAnnotationOverlayController({
    snapshot,
    mapper,
    mounted: state.view,
    variant: "source-reveal",
  });
  state.selection = new MarkdownSelectionController({
    mapper,
    boundary: state.view.host,
    preserveFocusTarget: (target) => target !== null && (
      state.view.host.contains(target)
      || target.closest("[data-file-preview-selection-excluded='true']") !== null
    ),
    onChange: ({ selection }) => state.featureProps.onSelectionChange?.(selection),
  });
  state.selection.attach();
  syncSourceReveal(state);
  refineSourceReveal(state);
  if (props.bindAnnotation) {
    state.annotationBindingCleanup = props.bindAnnotation({
      blocks: EMPTY_ANNOTATION_BINDING_BLOCKS,
      blocksForSourceRange: (range) => annotationBlocksForSourceRange(snapshot, range.start, range.end),
      root: state.view.host,
      scrollElement: state.scrollElement,
      revealBlock: async (blockId, signal) => {
        if (signal.aborted) throw signal.reason;
        await revealAnnotationBlock(state, blockId, signal);
      },
    });
  }
  syncRuntimeFeatureState(state, props);
}

const EMPTY_ANNOTATION_BINDING_BLOCKS = Object.freeze([]);

function annotationBlocksForSourceRange(
  snapshot: MarkdownSnapshot,
  sourceStart: number,
  sourceEnd: number,
): readonly { readonly id: string; readonly sourceStart: number; readonly sourceEnd: number }[] {
  const blocks = snapshot.blocks;
  let low = 0;
  let high = blocks.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (blocks[middle]!.source_end <= sourceStart) low = middle + 1;
    else high = middle;
  }
  const overlapping = [];
  for (let index = low; index < blocks.length; index += 1) {
    const block = blocks[index]!;
    if (block.source_start >= sourceEnd) break;
    if (block.source_end > sourceStart) {
      overlapping.push(Object.freeze({
        id: block.id,
        sourceStart: block.source_start,
        sourceEnd: block.source_end,
      }));
    }
  }
  return Object.freeze(overlapping);
}

function syncRuntimeFeatureState(
  state: HostState | null,
  props: FileMarkdownRuntimeHostProps,
): void {
  if (!state) return;
  state.featureProps = props;
  const snapshot = state.snapshot;
  if (!snapshot || !state.mapper || state.mapper.snapshot.revision !== snapshot.revision) return;
  const annotationRenderState = props.annotationRenderState ?? null;
  if (annotationRenderState !== state.publishedAnnotationRenderState) {
    state.annotationOverlay?.publish(annotationOverlayState(
      snapshot,
      annotationRenderState,
      (blockId) => state.view.getBlockIndex(blockId),
    ));
    state.publishedAnnotationRenderState = annotationRenderState;
  }
  const findIndex = props.findIndex?.revision === snapshot.revision ? props.findIndex : null;
  const activeFindMatchId = props.activeFindMatchId ?? null;
  if (findIndex !== state.publishedFindIndex || activeFindMatchId !== state.publishedActiveFindMatchId) {
    state.findOverlay?.publish(findOverlayState(snapshot, findIndex, activeFindMatchId));
    state.publishedFindIndex = findIndex;
    state.publishedActiveFindMatchId = activeFindMatchId;
  }
  const mounted = state.view.mountedBlockIds();
  state.annotationOverlay?.syncMountedBlocks(mounted);
  state.findOverlay?.syncMountedBlocks(mounted);
  state.sourceRevealOverlay?.syncMountedBlocks(mounted);
  const signature = mounted.join("\u0000");
  if (signature !== state.mountedBlockSignature) {
    state.mountedBlockSignature = signature;
    syncMeasurementTargets(state);
    props.onMountedBlocksChange?.();
  }
  syncSourceReveal(state);
}

function destroyRuntimeFeatures(state: HostState, notify = true): void {
  state.annotationBindingCleanup?.();
  state.annotationBindingCleanup = null;
  state.selection?.destroy();
  state.selection = null;
  // Overlays are installed in annotation -> Find -> source-reveal order.
  // Destroy them in reverse to preserve the shared block positioning invariant.
  state.sourceRevealOverlay?.destroy();
  state.sourceRevealOverlay = null;
  state.findOverlay?.destroy();
  state.findOverlay = null;
  state.annotationOverlay?.destroy();
  state.annotationOverlay = null;
  state.mapper = null;
  state.mountedBlockSignature = "";
  state.publishedAnnotationRenderState = null;
  state.publishedFindIndex = null;
  state.publishedActiveFindMatchId = null;
  state.publishedSourceReveal = null;
  if (notify) state.featureProps.onSelectionChange?.(null);
}

function annotationOverlayState(
  snapshot: MarkdownSnapshot,
  renderState: AnnotationRenderState | null | undefined,
  blockIndexForId?: (blockId: string) => number | null,
): MarkdownAnnotationOverlayState {
  const markers: MarkdownAnnotationOverlayMarker[] = [];
  for (const marker of renderState?.markers ?? []) {
    for (const range of marker.blockRanges) {
      const blockIndex = blockIndexForId?.(range.blockKey) ?? null;
      const block = blockIndex === null ? null : snapshot.blocks[blockIndex];
      if (!block) continue;
      markers.push(Object.freeze({
        annotationId: marker.annotationId,
        blockId: block.id,
        blockIndex: block.index,
        blockLocalStart: range.range.start,
        blockLocalEnd: range.range.end,
        logicalStart: block.logical_start + range.range.start,
        logicalEnd: block.logical_start + range.range.end,
      }));
    }
  }
  return Object.freeze({
    revision: snapshot.revision,
    annotationSetRevision: renderState?.revision ?? "empty",
    activeAnnotationId: renderState?.activeAnnotationId ?? null,
    hoveredAnnotationId: renderState?.hoveredAnnotationId ?? null,
    flashAnnotationId: renderState?.flashAnnotationId ?? null,
    markers: Object.freeze(markers),
  });
}

function findOverlayState(
  snapshot: MarkdownSnapshot,
  index: MarkdownFindIndex | null | undefined,
  activeFindMatchId: string | null,
): MarkdownAnnotationOverlayState {
  const current = index?.revision === snapshot.revision ? index : null;
  return Object.freeze({
    revision: snapshot.revision,
    annotationSetRevision: current
      ? `${current.revision}:${current.query}:${current.caseSensitive}:${current.wholeWord}:${current.matches.length}`
      : "empty",
    activeAnnotationId: activeFindMatchId,
    hoveredAnnotationId: null,
    flashAnnotationId: null,
    markers: Object.freeze((current?.matches ?? []).map((match) => Object.freeze({
      annotationId: match.id,
      blockId: match.blockId,
      blockIndex: match.blockIndex,
      blockLocalStart: match.blockLocalStart,
      blockLocalEnd: match.blockLocalEnd,
      logicalStart: match.logicalStart,
      logicalEnd: match.logicalEnd,
    }))),
  });
}

async function queryRuntimeFind(
  state: HostState | null,
  query: string,
  options: { caseSensitive?: boolean; wholeWord?: boolean; limit?: number; signal?: AbortSignal } = {},
): Promise<MarkdownFindIndex> {
  const snapshot = state?.snapshot;
  if (!state || !snapshot) throw new Error("Markdown Runtime is not ready");
  const caseSensitive = options.caseSensitive ?? false;
  const wholeWord = options.wholeWord ?? false;
  const limit = options.limit ?? 10_000;
  const normalized = query.trim();
  if (!state.attachment) {
    return buildRuntimeMarkdownFindIndex(snapshot, normalized, {
      caseSensitive,
      wholeWord,
      limit,
      shouldCancel: () => options.signal?.aborted ?? false,
    });
  }
  const response = await state.attachment.request({
    protocol_version: MARKDOWN_WORKER_PROTOCOL_VERSION,
    surface: snapshot.surface,
    document_id: snapshot.document_id,
    revision: snapshot.revision,
    request_id: `file-find-${++state.findRequestSequence}`,
    type: "query-find",
    payload: {
      query: normalized,
      case_sensitive: caseSensitive,
      whole_word: wholeWord,
      limit,
    },
  }, { signal: options.signal });
  if (response.type !== "find-result") {
    throw new Error(`Expected Markdown find-result, received ${response.type}`);
  }
  const matches = response.payload.matches.map((match) => Object.freeze({
    id: match.id,
    blockId: match.block_id,
    blockIndex: match.block_index,
    blockLocalStart: match.block_local_start,
    blockLocalEnd: match.block_local_end,
    logicalStart: match.logical_start,
    logicalEnd: match.logical_end,
    sourceStart: match.source_start,
    sourceEnd: match.source_end,
    matchText: match.match_text,
    snippet: match.snippet,
  }));
  return Object.freeze({
    revision: response.revision,
    query: response.payload.query,
    caseSensitive,
    wholeWord,
    limited: matches.length >= limit,
    matches: Object.freeze(matches),
  });
}

function resolveRuntimeAnnotations(
  state: HostState | null,
  input: AnnotationDocumentWorkerResolveInput,
): Promise<ResolvedAnnotationIndex> {
  const snapshot = state?.snapshot;
  const attachment = state?.attachment;
  if (!state || !snapshot || !attachment) {
    return Promise.reject(new Error("Markdown Document Worker is not attached"));
  }
  try {
    const resolver = state.annotationResolver
      ?? new DocumentWorkerAnnotationResolver(attachment, snapshot);
    resolver.updateSnapshot(snapshot);
    state.annotationResolver = resolver;
    return resolver.resolve(input);
  } catch (error) {
    return Promise.reject(error);
  }
}

function measureAndAnchor(state: HostState | null): void {
  if (!state?.snapshot) return;
  const updates = state.view.mountedBlockIds().flatMap((blockId) => {
    if (!state.view.isBlockContentMeasurable(blockId)) return [];
    const blockIndex = state.view.getBlockIndex(blockId);
    if (blockIndex === null) return [];
    const element = state.view.getBlockElement(blockId);
    const borderBoxHeight = element?.getBoundingClientRect().height ?? 0;
    if (element && borderBoxHeight > 0) {
      state.measurement?.synchronize(element, borderBoxHeight);
    }
    const height = borderBoxHeight > 0
      ? measuredMarkdownBlockOccupiedHeight(
          borderBoxHeight,
          blockIndex,
          state.snapshot!.blocks.length,
        )
      : 0;
    return height > 0 ? [{ index: blockIndex, height, kind: "measured" as const }] : [];
  });
  if (!updates.length) return;
  const patch = state.view.updateMeasuredHeights(updates, state.snapshot.revision);
  if (patch && Math.abs(state.scrollElement.scrollTop - patch.viewport.scrollTop) > 0.5) {
    state.scrollElement.scrollTop = patch.viewport.scrollTop;
  }
  if (patch) syncRuntimeFeatureState(state, state.featureProps);
}

function safeMeasureAndAnchor(state: HostState | null): void {
  try {
    measureAndAnchor(state);
  } catch (error) {
    markdownRuntimeDiagnostics.record({
      stage: "measurement",
      severity: "error",
      code: "measurement-failed",
      documentId: state?.documentId ?? null,
      revision: state?.revision ?? null,
      recovery: "retain-snapshot",
      detail: error,
      blockId: null,
      resourceId: null,
    });
  }
}

function syncMeasurementTargets(state: HostState): void {
  const scheduler = state.measurement;
  const snapshot = state.snapshot;
  const heightIndex = state.view.getHeightIndex();
  if (!scheduler || !snapshot || !heightIndex) return;
  const mountedIds = new Set(state.view.mountedBlockIds());
  for (const [blockId, element] of state.measuredElements) {
    const current = state.view.getBlockElement(blockId);
    if (mountedIds.has(blockId) && current === element) continue;
    scheduler.unobserve(element);
    state.measuredElements.delete(blockId);
  }
  for (const blockId of mountedIds) {
    if (!state.view.isBlockContentMeasurable(blockId)) continue;
    const element = state.view.getBlockElement(blockId);
    const blockIndex = state.view.getBlockIndex(blockId);
    if (!element || blockIndex === null || state.measuredElements.get(blockId) === element) continue;
    scheduler.observe(element, {
      index: blockIndex,
      blockId,
      initialHeight: Math.max(0, state.view.baseHeightAt(blockIndex) - (blockIndex < snapshot.blocks.length - 1 ? 12 : 0)),
    });
    state.measuredElements.set(blockId, element);
  }
}

function applyMeasuredHeightBatch(
  state: HostState,
  updates: readonly MarkdownHeightUpdate[],
  revision: string,
): void {
  const snapshot = state.snapshot;
  if (!snapshot || snapshot.revision !== revision) return;
  const occupied = updates.map((update) => ({
    ...update,
    height: measuredMarkdownBlockOccupiedHeight(update.height, update.index, snapshot.blocks.length),
  }));
  const patch = state.view.updateMeasuredHeights(occupied, revision);
  if (!patch) return;
  if (Math.abs(state.scrollElement.scrollTop - patch.viewport.scrollTop) > 0.5) {
    state.scrollElement.scrollTop = patch.viewport.scrollTop;
  }
  syncMeasurementTargets(state);
  syncRuntimeFeatureState(state, state.featureProps);
  remeasureRuntimeOverlays(state);
}

function remeasureRuntimeOverlays(state: HostState | null): void {
  state?.annotationOverlay?.remeasureMountedBlocks();
  state?.findOverlay?.remeasureMountedBlocks();
  state?.sourceRevealOverlay?.remeasureMountedBlocks();
  state?.featureProps.onMountedBlocksChange?.();
}

function recordMeasurementFailure(state: HostState, error: unknown): void {
  markdownRuntimeDiagnostics.record({
    stage: "measurement",
    severity: "error",
    code: "measurement-observer-failed",
    documentId: state.documentId,
    revision: state.snapshot?.revision ?? state.revision,
    recovery: "retain-snapshot",
    detail: error,
    blockId: null,
    resourceId: null,
  });
}

function publishSnapshot(
  state: HostState,
  snapshot: MarkdownSnapshot,
  status: "stale" | "ready",
  preparedHeights?: Float64Array,
): void {
  state.snapshot = snapshot;
  state.measurement?.setContext({ revision: snapshot.revision, epoch: 0 });
  state.measuredElements.clear();
  const host = state.view.host;
  const width = Math.max(1, state.scrollElement.clientWidth || host.clientWidth || 800);
  const heights = preparedHeights ?? estimateMarkdownSnapshotHeights(snapshot, { viewportWidth: width });
  const patch = state.view.publish(snapshot, heights, {
    scrollTop: state.scrollElement.scrollTop,
    viewportHeight: state.scrollElement.clientHeight,
  }, { preserveRevisionGeometry: true });
  restoreScrollAnchor(state);
  syncMeasurementTargets(state);
  host.dataset.markdownRuntimeStatus = status;
  recordRendererFailures(state, patch.render.failed);
}

function prepareSnapshotHeights(state: HostState, snapshot: MarkdownSnapshot): Promise<Float64Array> {
  const host = state.view.host;
  const width = Math.max(1, state.scrollElement.clientWidth || host.clientWidth || 800);
  return estimateMarkdownSnapshotHeightsIncrementally(
    snapshot,
    { viewportWidth: width },
    yieldMainThread,
  );
}

function yieldMainThread(): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, 0));
}

function recordRendererFailures(state: HostState, failed: number): void {
  if (failed < 1) return;
  markdownRuntimeDiagnostics.record({
    stage: "renderer",
    severity: "error",
    code: "block-render-failed",
    documentId: state.documentId,
    revision: state.snapshot?.revision ?? state.revision,
    recovery: "isolate-block",
    detail: `${failed} block renderer(s) isolated`,
    blockId: null,
    resourceId: null,
  });
}

function recordResourceDiagnostic(
  documentId: string,
  revision: string,
  kind: "image" | "mermaid",
  resourceId: string,
  state: string,
  error: string | null,
): void {
  markdownRuntimeDiagnostics.record({
    stage: "resource",
    severity: state === "failed" ? "error" : "info",
    code: `${kind}-${state}`,
    documentId,
    revision,
    recovery: state === "failed" ? "isolate-block" : "none",
    detail: error,
    blockId: null,
    resourceId,
  });
}

function syncRenderCount(host: HTMLElement, state: HostState, onRender?: () => void): void {
  state.renderCount += 1;
  host.dataset.markdownRuntimeRenderCount = String(state.renderCount);
  onRender?.();
}

function persistScrollAnchor(state: HostState, visibleBlockIndex: number): void {
  const block = state.snapshot?.blocks[visibleBlockIndex];
  const index = state.view.getHeightIndex();
  if (!block || !index || !state.viewState) return;
  state.viewState.setScrollAnchor({
    blockId: block.id,
    sourceOffset: block.source_start,
    alignment: "start",
    offsetPx: state.scrollElement.scrollTop - index.offsetOf(block.index),
  });
}

function persistCurrentScrollAnchor(state: HostState): void {
  if (!state.snapshot || !state.viewState) return;
  const current = state.view.getHeightIndex()?.queryY(state.scrollElement.scrollTop);
  if (current) persistScrollAnchor(state, current.index);
}

function restoreScrollAnchor(state: HostState, resetToStartWhenMissing = false): void {
  const anchor = state.viewState?.snapshot().scrollAnchor;
  const index = state.view.getHeightIndex();
  const snapshot = state.snapshot;
  if (!index || !snapshot) return;
  if (!anchor) {
    if (resetToStartWhenMissing) {
      state.scrollElement.scrollTop = 0;
      state.view.updateViewport(
        { scrollTop: 0, viewportHeight: state.scrollElement.clientHeight },
        { origin: "automatic" },
      );
    }
    return;
  }
  const blockIndex = resolveFileMarkdownScrollAnchorBlockIndex(
    snapshot,
    anchor,
    (blockId) => state.view.getBlockIndex(blockId),
  );
  const block = blockIndex === null ? null : snapshot.blocks[blockIndex];
  if (!block) return;
  const scrollTop = Math.max(0, index.offsetOf(block.index) + anchor.offsetPx);
  state.scrollElement.scrollTop = scrollTop;
  state.view.updateViewport({ scrollTop, viewportHeight: state.scrollElement.clientHeight }, { origin: "automatic" });
}

function revealOffset(
  state: HostState | null,
  offset: number,
  options?: { align?: "start" | "center"; behavior?: ScrollBehavior },
): boolean {
  const blockIndex = state?.snapshot ? markdownBlockIndexAtSourceOffset(state.snapshot, offset) : null;
  const block = blockIndex === null ? null : state?.snapshot?.blocks[blockIndex];
  return block ? revealBlock(state, block.id, options) : false;
}

function viewportSourceOffset(state: HostState | null): number | null {
  const snapshot = state?.snapshot;
  const heightIndex = state?.view.getHeightIndex();
  if (!state || !snapshot || !heightIndex) return null;
  const position = heightIndex.queryY(state.scrollElement.scrollTop);
  const block = position ? snapshot.blocks[position.index] : null;
  if (!position || !block) return null;
  const progress = position.blockHeight > 0
    ? Math.max(0, Math.min(1, position.offsetWithinBlock / position.blockHeight))
    : 0;
  return Math.round(block.source_start + (block.source_end - block.source_start) * progress);
}

function syncViewportToSourceOffset(state: HostState | null, offset: number): boolean {
  const snapshot = state?.snapshot;
  const heightIndex = state?.view.getHeightIndex();
  if (!state || !snapshot || !heightIndex || !Number.isFinite(offset)) return false;
  const boundedOffset = Math.max(0, Math.min(Math.round(offset), snapshot.source_characters));
  const blockIndex = markdownBlockIndexAtSourceOffset(snapshot, boundedOffset)
    ?? markdownBlockIndexNearestSourceOffset(snapshot, boundedOffset);
  const block = blockIndex === null ? null : snapshot.blocks[blockIndex];
  if (!block) return false;
  const sourceSpan = Math.max(1, block.source_end - block.source_start);
  const progress = Math.max(0, Math.min(1, (boundedOffset - block.source_start) / sourceSpan));
  const unclampedTarget = heightIndex.offsetOf(block.index) + heightIndex.heightAt(block.index) * progress;
  const target = Math.max(0, Math.min(
    unclampedTarget,
    Math.max(0, heightIndex.totalHeight - state.scrollElement.clientHeight),
  ));
  state.scrollElement.scrollTo({ top: target, behavior: "auto" });
  state.view.updateViewport(
    { scrollTop: target, viewportHeight: state.scrollElement.clientHeight },
    { origin: "programmatic" },
  );
  persistScrollAnchor(state, block.index);
  return true;
}

function viewportSourceAnchor(state: HostState | null): SourceLineScrollAnchor | null {
  const snapshot = state?.snapshot;
  const heightIndex = state?.view.getHeightIndex();
  if (!state || !snapshot || !heightIndex) return null;
  const position = heightIndex.queryY(state.scrollElement.scrollTop);
  const block = position ? snapshot.blocks[position.index] : null;
  if (!position || !block) return null;
  const blockProgress = position.blockHeight > 0
    ? Math.max(0, Math.min(1, position.offsetWithinBlock / position.blockHeight))
    : 0;
  const lineSpan = Math.max(1, block.line_end - block.line_start);
  const localLinePosition = blockProgress * lineSpan;
  const localLine = Math.min(lineSpan - 1, Math.floor(localLinePosition));
  const lineProgress = localLinePosition >= lineSpan
    ? 1
    : Math.max(0, Math.min(1, localLinePosition - localLine));
  return Object.freeze({
    line: block.line_start + localLine + 1,
    lineProgress,
  });
}

function syncViewportToSourceAnchor(state: HostState | null, anchor: SourceLineScrollAnchor): boolean {
  const snapshot = state?.snapshot;
  const heightIndex = state?.view.getHeightIndex();
  if (!state || !snapshot || !heightIndex
    || !Number.isSafeInteger(anchor.line) || anchor.line < 1 || anchor.line > snapshot.line_count
    || !Number.isFinite(anchor.lineProgress)) {
    return false;
  }
  const zeroBasedLine = anchor.line - 1;
  const blockIndex = markdownBlockIndexAtSourceLine(snapshot, zeroBasedLine)
    ?? markdownBlockIndexNearestSourceLine(snapshot, zeroBasedLine);
  const block = blockIndex === null ? null : snapshot.blocks[blockIndex];
  if (!block) return false;
  const lineSpan = Math.max(1, block.line_end - block.line_start);
  const localLine = Math.max(0, Math.min(lineSpan - 1, zeroBasedLine - block.line_start));
  const blockProgress = (localLine + Math.max(0, Math.min(1, anchor.lineProgress))) / lineSpan;
  const targetForCurrentHeights = () => Math.max(0, Math.min(
    heightIndex.offsetOf(block.index) + heightIndex.heightAt(block.index) * blockProgress,
    Math.max(0, heightIndex.totalHeight - state.scrollElement.clientHeight),
  ));
  const coarseTarget = targetForCurrentHeights();
  state.scrollElement.scrollTo({ top: coarseTarget, behavior: "auto" });
  state.view.updateViewport(
    { scrollTop: coarseTarget, viewportHeight: state.scrollElement.clientHeight },
    { origin: "programmatic" },
  );
  measureSplitSyncBlock(state, block.index, block.id);
  const refinedTarget = targetForCurrentHeights();
  if (Math.abs(state.scrollElement.scrollTop - refinedTarget) > 0.5) {
    state.scrollElement.scrollTo({ top: refinedTarget, behavior: "auto" });
    state.view.updateViewport(
      { scrollTop: refinedTarget, viewportHeight: state.scrollElement.clientHeight },
      { origin: "programmatic" },
    );
  }
  persistScrollAnchor(state, block.index);
  return true;
}

function measureSplitSyncBlock(state: HostState, blockIndex: number, blockId: string): void {
  const heightIndex = state.view.getHeightIndex();
  const snapshot = state.snapshot;
  if (!heightIndex || !snapshot || heightIndex.kindAt(blockIndex) === "measured"
    || !state.view.isBlockContentMeasurable(blockId)) {
    return;
  }
  const element = state.view.getBlockElement(blockId);
  const borderBoxHeight = element?.getBoundingClientRect().height ?? 0;
  if (!element || borderBoxHeight <= 0) return;
  state.measurement?.synchronize(element, borderBoxHeight);
  const measuredHeight = measuredMarkdownBlockOccupiedHeight(
    borderBoxHeight,
    blockIndex,
    snapshot.blocks.length,
  );
  const patch = state.view.updateMeasuredHeights(
    [{ index: blockIndex, height: measuredHeight, kind: "measured" }],
    snapshot.revision,
  );
  if (patch && Math.abs(state.scrollElement.scrollTop - patch.viewport.scrollTop) > 0.5) {
    state.scrollElement.scrollTop = patch.viewport.scrollTop;
  }
  if (patch) {
    syncMeasurementTargets(state);
    syncRuntimeFeatureState(state, state.featureProps);
  }
}

function revealSourceLines(
  state: HostState | null,
  lineStart: number,
  lineEnd: number,
  options?: { align?: "start" | "center"; behavior?: ScrollBehavior },
): boolean {
  if (!state?.snapshot || !Number.isSafeInteger(lineStart) || !Number.isSafeInteger(lineEnd)
    || lineStart < 1 || lineEnd < lineStart || lineEnd > state.snapshot.line_count) {
    return false;
  }
  const blockIndex = markdownBlockIndexAtSourceLine(state.snapshot, lineStart - 1)
    ?? markdownBlockIndexNearestSourceLine(state.snapshot, lineStart - 1);
  const block = blockIndex === null ? null : state.snapshot.blocks[blockIndex];
  if (!block) return false;
  const matchingBlockIds = state.snapshot.blocks
    .filter((candidate) => candidate.line_start < lineEnd && candidate.line_end >= lineStart)
    .map((candidate) => candidate.id);
  state.sourceReveal = {
    blockIds: matchingBlockIds.length > 0 ? matchingBlockIds : [block.id],
    lineStart,
    lineEnd,
    align: options?.align ?? "start",
    behavior: options?.behavior ?? "smooth",
    refined: false,
  };
  if (!revealBlock(state, block.id, options)) {
    state.sourceReveal = null;
    syncSourceReveal(state);
    return false;
  }
  syncSourceReveal(state);
  refineSourceReveal(state);
  return true;
}

function revealBlock(
  state: HostState | null,
  blockId: string,
  options?: { align?: "start" | "center"; behavior?: ScrollBehavior },
): boolean {
  if (!state?.snapshot) return false;
  const blockIndex = state.view.getBlockIndex(blockId);
  const block = blockIndex === null ? null : state.snapshot.blocks[blockIndex];
  if (!block) return false;
  state.view.expandForBlock(blockId);
  const index = state.view.getHeightIndex();
  if (!index) return false;
  const scroll = state.scrollElement;
  const top = index.offsetOf(block.index);
  const target = options?.align === "center" ? Math.max(0, top - scroll.clientHeight / 2 + index.heightAt(block.index) / 2) : top;
  scroll.scrollTo({ top: target, behavior: state.environment.behavior(options?.behavior ?? "smooth") });
  state.view.updateViewport({ scrollTop: target, viewportHeight: scroll.clientHeight }, { origin: "programmatic" });
  persistScrollAnchor(state, block.index);
  syncRuntimeFeatureState(state, state.featureProps);
  return true;
}

async function revealAnnotationBlock(
  state: HostState,
  blockId: string,
  signal: AbortSignal,
): Promise<void> {
  const blockIndex = state.view.getBlockIndex(blockId);
  const block = blockIndex === null ? null : state.snapshot?.blocks[blockIndex];
  if (!block) {
    throw new Error(`Markdown block ${blockId} is unavailable`);
  }
  state.view.expandForBlock(blockId);
  const index = state.view.getHeightIndex();
  if (!index) {
    throw new Error(`Markdown block ${blockId} is unavailable`);
  }
  const scroll = state.scrollElement;
  const blockTop = index.offsetOf(block.index);
  const unclampedTarget = blockTop - scroll.clientHeight / 2 + index.heightAt(block.index) / 2;
  const target = Math.max(0, Math.min(
    unclampedTarget,
    Math.max(0, index.totalHeight - scroll.clientHeight),
  ));
  if (state.environment.behavior("smooth") === "auto") {
    scroll.scrollTo({ top: target, behavior: "auto" });
  } else {
    await smoothScrollElementTo(scroll, target, signal);
  }
  if (signal.aborted) {
    throw signal.reason;
  }
  state.view.updateViewport(
    { scrollTop: target, viewportHeight: scroll.clientHeight },
    { origin: "programmatic" },
  );
  persistScrollAnchor(state, block.index);
  syncRuntimeFeatureState(state, state.featureProps);
}

function refineSourceReveal(state: HostState): void {
  const reveal = state.sourceReveal;
  const position = reveal && !reveal.refined ? state.mapper?.sourceLine(reveal.lineStart) : null;
  if (!reveal || !position?.dom) return;
  const scroll = state.scrollElement;
  const viewportRect = scroll.getBoundingClientRect();
  const targetDocumentTop = scroll.scrollTop + position.dom.rect.top - viewportRect.top;
  const targetHeight = Math.max(1, position.dom.rect.height);
  const heightIndex = state.view.getHeightIndex();
  if (!heightIndex) return;
  const unclamped = reveal.align === "center"
    ? targetDocumentTop - scroll.clientHeight / 2 + targetHeight / 2
    : targetDocumentTop;
  const target = Math.max(0, Math.min(unclamped, Math.max(0, heightIndex.totalHeight - scroll.clientHeight)));
  reveal.refined = true;
  scroll.scrollTo({ top: target, behavior: state.environment.behavior(reveal.behavior) });
  state.view.updateViewport({ scrollTop: target, viewportHeight: scroll.clientHeight }, { origin: "programmatic" });
  const blockIndex = position.blockIndex;
  if (blockIndex !== null) persistScrollAnchor(state, blockIndex);
  syncRuntimeFeatureState(state, state.featureProps);
}

function syncSourceReveal(state: HostState): void {
  state.view.host.querySelectorAll<HTMLElement>("[data-markdown-source-reveal-active='true']").forEach((element) => {
    delete element.dataset.markdownSourceRevealActive;
    delete element.dataset.markdownSourceRevealLineStart;
    delete element.dataset.markdownSourceRevealLineEnd;
  });
  const reveal = state.sourceReveal;
  if (reveal) {
    const blockIds = new Set(reveal.blockIds);
    for (const blockId of blockIds) {
      const block = state.view.getBlockElement(blockId);
      if (!block) continue;
      block.dataset.markdownSourceRevealActive = "true";
      block.dataset.markdownSourceRevealLineStart = String(reveal.lineStart);
      block.dataset.markdownSourceRevealLineEnd = String(reveal.lineEnd);
    }
  }
  if (state.sourceRevealOverlay && state.sourceReveal !== state.publishedSourceReveal) {
    state.sourceRevealOverlay.publish(sourceRevealOverlayState(state));
    state.publishedSourceReveal = state.sourceReveal;
  }
  state.sourceRevealOverlay?.syncMountedBlocks(state.view.mountedBlockIds());
}

function sourceRevealOverlayState(state: HostState): MarkdownAnnotationOverlayState {
  const snapshot = state.snapshot;
  const reveal = state.sourceReveal;
  if (!snapshot || !reveal) {
    return Object.freeze({
      revision: snapshot?.revision ?? state.revision,
      annotationSetRevision: "empty",
      activeAnnotationId: null,
      hoveredAnnotationId: null,
      flashAnnotationId: null,
      markers: Object.freeze([]),
    });
  }
  const range = sourceOffsetsForLineRange(state.featureProps.source, reveal.lineStart, reveal.lineEnd);
  const annotationId = `source-reveal:${reveal.lineStart}:${reveal.lineEnd}`;
  const markers = range ? snapshot.blocks.flatMap((block) => {
    const sourceStart = Math.max(block.source_start, range.start);
    const sourceEnd = Math.min(block.source_end, range.end);
    if (sourceEnd <= sourceStart) return [];
    const logicalStart = markdownSourceOffsetToLogical(block, sourceStart);
    const logicalEnd = markdownSourceOffsetToLogical(block, sourceEnd);
    if (logicalEnd <= logicalStart) return [];
    return [Object.freeze({
      annotationId,
      blockId: block.id,
      blockIndex: block.index,
      blockLocalStart: logicalStart - block.logical_start,
      blockLocalEnd: logicalEnd - block.logical_start,
      logicalStart,
      logicalEnd,
    })];
  }) : [];
  return Object.freeze({
    revision: snapshot.revision,
    annotationSetRevision: `${snapshot.revision}:${annotationId}`,
    activeAnnotationId: annotationId,
    hoveredAnnotationId: null,
    flashAnnotationId: null,
    markers: Object.freeze(markers),
  });
}

function sourceOffsetsForLineRange(
  source: string,
  lineStart: number,
  lineEnd: number,
): { start: number; end: number } | null {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source.charCodeAt(index) === 10) starts.push(index + 1);
  }
  const start = starts[lineStart - 1];
  const nextLineStart = starts[lineEnd];
  if (start === undefined) return null;
  const endWithNewline = nextLineStart ?? source.length;
  const end = endWithNewline > start && source.charCodeAt(endWithNewline - 1) === 10
    ? endWithNewline - 1
    : endWithNewline;
  return { start, end };
}

function clearSourceReveal(state: HostState | null): void {
  if (!state?.sourceReveal) return;
  state.sourceReveal = null;
  syncSourceReveal(state);
}

function markdownBlockIndexAtSourceOffset(snapshot: MarkdownSnapshot, offset: number): number | null {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > snapshot.source_characters) return null;
  let low = 0;
  let high = snapshot.blocks.length - 1;
  let candidate = -1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    if (snapshot.blocks[middle]!.source_start <= offset) {
      candidate = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (candidate < 0) return null;
  const block = snapshot.blocks[candidate]!;
  return offset <= block.source_end ? candidate : null;
}

function markdownBlockIndexNearestSourceOffset(snapshot: MarkdownSnapshot, offset: number): number | null {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > snapshot.source_characters
    || snapshot.blocks.length === 0) {
    return null;
  }
  const nextIndex = snapshot.blocks.findIndex((block) => block.source_start >= offset);
  if (nextIndex === 0) return 0;
  if (nextIndex < 0) return snapshot.blocks.length - 1;
  const previous = snapshot.blocks[nextIndex - 1]!;
  const next = snapshot.blocks[nextIndex]!;
  return offset - previous.source_end <= next.source_start - offset ? previous.index : next.index;
}

export function resolveFileMarkdownScrollAnchorBlockIndex(
  snapshot: MarkdownSnapshot,
  anchor: Pick<MarkdownViewScrollAnchor, "blockId" | "sourceOffset">,
  blockIndexForId: (blockId: string) => number | null,
): number | null {
  const blockIdIndex = anchor.blockId ? blockIndexForId(anchor.blockId) : null;
  return blockIdIndex ?? markdownBlockIndexAtSourceOffset(snapshot, anchor.sourceOffset);
}

function markdownBlockIndexAtSourceLine(snapshot: MarkdownSnapshot, zeroBasedLine: number): number | null {
  if (!Number.isSafeInteger(zeroBasedLine) || zeroBasedLine < 0 || zeroBasedLine >= snapshot.line_count) return null;
  let low = 0;
  let high = snapshot.blocks.length - 1;
  let candidate = -1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    if (snapshot.blocks[middle]!.line_start <= zeroBasedLine) {
      candidate = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (candidate < 0) return null;
  const block = snapshot.blocks[candidate]!;
  return zeroBasedLine < block.line_end ? candidate : null;
}

function markdownBlockIndexNearestSourceLine(snapshot: MarkdownSnapshot, zeroBasedLine: number): number | null {
  if (!Number.isSafeInteger(zeroBasedLine) || zeroBasedLine < 0 || zeroBasedLine >= snapshot.line_count
    || snapshot.blocks.length === 0) {
    return null;
  }
  const next = snapshot.blocks.find((block) => block.line_start >= zeroBasedLine);
  if (next) return next.index;
  return snapshot.blocks.at(-1)?.index ?? null;
}

function workspaceScopeKey(scope?: WorkspaceScope | null): string | null {
  if (!scope) return null;
  return "sessionId" in scope && scope.sessionId ? `session:${scope.sessionId}` : `workspace:${scope.workspaceId}`;
}

let nextFileRuntimeViewId = 1;

const FILE_VISIBLE_PREFIX_CHARACTERS = 128 * 1024;
const INCREMENTAL_SNAPSHOT_PREPARATION_BYTES = 8 * 1024 * 1024;

function visibleMarkdownPrefix(source: string, maximumCharacters: number): string {
  let end = Math.min(source.length, maximumCharacters);
  if (end < source.length && /[\uD800-\uDBFF]/u.test(source[end - 1] ?? "")) end -= 1;
  const lineEnd = source.lastIndexOf("\n", end);
  return source.slice(0, lineEnd > 0 ? lineEnd + 1 : end);
}
